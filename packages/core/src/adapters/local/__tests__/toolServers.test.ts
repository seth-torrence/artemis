/**
 * The hand-off: a tool server the host built, reaching a local model's loop.
 * ============================================================================
 *
 * `agentToolServers` is one factory shared by two adapters now. What these pin
 * is that a local run really does get what a Claude run gets — the same server
 * object, under the same `mcp__<server>__<tool>` names — and that the permission
 * rules around it are the ones the file claims: `plan` withholds a tool that did
 * not declare itself read-only, and `acceptEdits` does not answer for a user
 * about work that happens somewhere other than this directory.
 *
 * Driven against a real HTTP server standing in for `llama-server`, because the
 * request that carries the tools is the thing worth checking: the model is told
 * what it may call in the `tools` array, and a server that never received one
 * would produce a run that silently had no tools at all.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, PermissionRequestId, ToolServerConfig } from '@rx-artemis/protocol';

import { BASE_URL_ENV, createLocalAdapter, LLAMA_CPP } from '../adapter.js';
import type { ResolvedRunInput, Run } from '../../types.js';

const httpServers: HttpServer[] = [];

afterEach(() => {
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* A stand-in for the browser server the composition root builds               */
/* -------------------------------------------------------------------------- */

const browserCalls: { tool: string; args: unknown }[] = [];

function browserServer(): McpServerConfig {
  const server = new Server({ name: 'artemis-browser', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'browser_read',
        description: 'Read the page in the dock.',
        inputSchema: { type: 'object' as const, properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'browser_navigate',
        description: 'Point the dock browser at an address.',
        inputSchema: { type: 'object' as const, properties: { url: { type: 'string' } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    browserCalls.push({ tool: request.params.name, args: request.params.arguments });
    return { content: [{ type: 'text' as const, text: 'the page says hello' }] };
  });
  return { type: 'sdk', name: 'artemis-browser', instance: server as never };
}

/* -------------------------------------------------------------------------- */
/* A stand-in for llama-server                                                */
/* -------------------------------------------------------------------------- */

/** One streamed completion, as an SSE body. */
function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

const toolCallChunk = (name: string, args: unknown) => ({
  choices: [
    {
      delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls',
    },
  ],
});

const textChunk = (text: string) => ({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });

interface Inference {
  readonly origin: string;
  /** The `tools` array of every completion request, in order. */
  readonly offered: string[][];
}

/** A server that answers `/v1/chat/completions` with a scripted turn. */
async function serveInference(turns: readonly (readonly unknown[])[]): Promise<Inference> {
  const offered: string[][] = [];
  let turn = 0;
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if ((request.url ?? '').includes('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'qwen', object: 'model' }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: { function: { name: string } }[];
      };
      offered.push((body.tools ?? []).map((tool) => tool.function.name));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sse(turns[turn++] ?? [textChunk('done')]));
    });
  });
  httpServers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, offered };
}

/* -------------------------------------------------------------------------- */
/* Driving a run                                                              */
/* -------------------------------------------------------------------------- */

function runInput(origin: string, extra: Partial<ResolvedRunInput> = {}): ResolvedRunInput {
  return {
    runId: 'run-tools-1',
    providerId: 'llamacpp',
    profileId: 'p1',
    cwd: process.cwd(),
    prompt: 'what does the page say?',
    // No profile directory, so nothing is written to a session store. This is
    // about the tools, not the transcript.
    env: { [BASE_URL_ENV]: origin },
    ...extra,
  } as ResolvedRunInput;
}

/**
 * Collect a run's events to `run.end`, answering every permission prompt.
 *
 * `answer` decides; `undefined` means the run is expected not to ask, and a
 * prompt that arrives anyway is denied so the test finishes rather than hangs.
 */
async function drain(
  run: Run,
  answer: 'allow' | 'deny' | undefined = 'allow',
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === 'permission.request') {
      const id = (event as { requestId: PermissionRequestId }).requestId;
      void run.respondToPermission(id, { behavior: answer === 'allow' ? 'allow' : 'deny' } as never);
    }
  }
  return events;
}

const names = (events: readonly AgentEvent[], type: string): unknown[] =>
  events.filter((event) => event.type === type);

describe('a host-built tool server on a local run', () => {
  it('offers its tools to the model under mcp__<server>__<tool>', async () => {
    const inference = await serveInference([[textChunk('nothing to do')]]);
    const adapter = createLocalAdapter(LLAMA_CPP, { agentToolServers: () => ({ artemisBrowser: browserServer() }) });

    const run = await adapter.createRun(runInput(inference.origin));
    const events = await drain(run);

    // The session announces them, so the run info dialog is telling the truth.
    const started = events.find((event) => event.type === 'session.started') as { tools: string[] };
    expect(started.tools).toEqual([
      'read_file',
      'write_file',
      'list_files',
      'search',
      'http_fetch',
      'shell',
      'mcp__artemisBrowser__browser_read',
      'mcp__artemisBrowser__browser_navigate',
    ]);
    // And the model is actually told about them, which is the fact that
    // matters: a tools array that never reached the wire is a run with no
    // tools, however the dialog reads.
    expect(inference.offered[0]).toContain('mcp__artemisBrowser__browser_read');
  });

  it('calls the server and feeds its answer back for the next completion', async () => {
    browserCalls.length = 0;
    const inference = await serveInference([
      [toolCallChunk('mcp__artemisBrowser__browser_read', {})],
      [textChunk('The page says hello.')],
    ]);
    const adapter = createLocalAdapter(LLAMA_CPP, { agentToolServers: () => ({ artemisBrowser: browserServer() }) });

    const run = await adapter.createRun(runInput(inference.origin));
    const events = await drain(run);

    expect(browserCalls).toEqual([{ tool: 'browser_read', args: {} }]);
    expect(names(events, 'tool.end')).toEqual([
      expect.objectContaining({
        name: 'mcp__artemisBrowser__browser_read',
        status: 'ok',
        resultText: 'the page says hello',
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('surfaces a refusal as a result the model can read, not an error', async () => {
    const inference = await serveInference([
      [toolCallChunk('mcp__artemisBrowser__browser_navigate', { url: 'https://example.com' })],
      [textChunk('Understood.')],
    ]);
    const adapter = createLocalAdapter(LLAMA_CPP, { agentToolServers: () => ({ artemisBrowser: browserServer() }) });

    const run = await adapter.createRun(runInput(inference.origin));
    const events = await drain(run, 'deny');

    expect(names(events, 'tool.end')).toEqual([
      expect.objectContaining({ status: 'error', resultText: 'The user declined to run this tool.' }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('says out loud when a configured server could not be reached', async () => {
    const inference = await serveInference([[textChunk('ok')]]);
    const adapter = createLocalAdapter(LLAMA_CPP, {
      agentToolServers: () => ({ broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' } }),
    });

    const run = await adapter.createRun(runInput(inference.origin));
    const events = await drain(run);

    // A tool server that vanished quietly would leave the model insisting it
    // had no way to do something it was told it could.
    const notice = events.find(
      (event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic === true,
    ) as { text: string } | undefined;
    expect(notice?.text).toContain('broken');
    // And the run still finishes, with the tools it does have.
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });
});

describe('permission modes over a tool server', () => {
  it('plan mode withholds every tool that did not declare itself read-only', async () => {
    const inference = await serveInference([[textChunk('here is the plan')]]);
    const adapter = createLocalAdapter(LLAMA_CPP, { agentToolServers: () => ({ artemisBrowser: browserServer() }) });

    const run = await adapter.createRun(runInput(inference.origin, { permissionMode: 'plan' }));
    await drain(run);

    // Withheld rather than refused later: a model never told about a tool does
    // not spend a turn trying it.
    expect(inference.offered[0]).toContain('mcp__artemisBrowser__browser_read');
    expect(inference.offered[0]).not.toContain('mcp__artemisBrowser__browser_navigate');
    expect(inference.offered[0]).not.toContain('write_file');
  });

  it('acceptEdits still asks about a tool server, because the work is elsewhere', async () => {
    const inference = await serveInference([
      [toolCallChunk('mcp__artemisBrowser__browser_navigate', { url: 'https://example.com' })],
      [textChunk('done')],
    ]);
    const adapter = createLocalAdapter(LLAMA_CPP, { agentToolServers: () => ({ artemisBrowser: browserServer() }) });

    const run = await adapter.createRun(runInput(inference.origin, { permissionMode: 'acceptEdits' }));
    const events = await drain(run);

    // "Stop asking me about edits" is a statement about this working
    // directory. A live page is not in it.
    expect(names(events, 'permission.request')).toHaveLength(1);
  });

  it('bypassPermissions does not ask, for a server tool either', async () => {
    browserCalls.length = 0;
    const inference = await serveInference([
      [toolCallChunk('mcp__artemisBrowser__browser_navigate', { url: 'https://example.com' })],
      [textChunk('done')],
    ]);
    const adapter = createLocalAdapter(LLAMA_CPP, { agentToolServers: () => ({ artemisBrowser: browserServer() }) });

    const run = await adapter.createRun(runInput(inference.origin, { permissionMode: 'bypassPermissions' }));
    const events = await drain(run, undefined);

    expect(names(events, 'permission.request')).toHaveLength(0);
    expect(browserCalls).toHaveLength(1);
  });
});

describe('a run with no servers', () => {
  it('is byte-for-byte the run it always was', async () => {
    const inference = await serveInference([[textChunk('ok')]]);
    const adapter = createLocalAdapter(LLAMA_CPP);

    const run = await adapter.createRun(runInput(inference.origin));
    const events = await drain(run);

    const started = events.find((event) => event.type === 'session.started') as { tools: string[] };
    expect(started.tools).toEqual([
      'read_file',
      'write_file',
      'list_files',
      'search',
      'http_fetch',
      'shell',
    ]);
    expect(inference.offered[0]).toEqual([
      'read_file',
      'write_file',
      'list_files',
      'search',
      'http_fetch',
      'shell',
    ]);
  });
});

describe('a server the profile configured', () => {
  /** A plain JSON-RPC-over-POST MCP endpoint, as a user's own server would be. */
  async function serveMcpOverHttp(): Promise<{ url: string; authorization: () => string | undefined }> {
    let seen: string | undefined;
    const server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen = request.headers.authorization;
        const raw = Buffer.concat(chunks).toString('utf8');
        // The client opens a stream with GET and closes the session with
        // DELETE. Neither carries a body, and neither is needed here.
        if (request.method !== 'POST' || raw === '') {
          response.writeHead(405).end();
          return;
        }
        const message = JSON.parse(raw) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = {};
        if (message.method === 'initialize') {
          result = {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'forgejo', version: '1' },
          };
        } else if (message.method === 'tools/list') {
          result = {
            tools: [
              {
                name: 'list_repos',
                description: 'List repositories.',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          };
        } else if (message.method === 'tools/call') {
          result = { content: [{ type: 'text', text: 'artemis, cortex' }] };
        }
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    httpServers.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${String(port)}/mcp`, authorization: () => seen };
  }

  const forgejo = (url: string): ToolServerConfig => ({
    name: 'forgejo',
    transport: 'http',
    url,
    headers: { authorization: 'Bearer ${FORGEJO_TOKEN}' },
  });

  it('reaches it, expanding ${NAME} from the run’s environment', async () => {
    const mcp = await serveMcpOverHttp();
    const inference = await serveInference([
      [toolCallChunk('mcp__forgejo__list_repos', {})],
      [textChunk('You have two repositories.')],
    ]);
    const adapter = createLocalAdapter(LLAMA_CPP);

    const run = await adapter.createRun(
      runInput(inference.origin, {
        toolServers: [forgejo(mcp.url)],
        // Set on the run's bundle, which is where a profile's environment
        // arrives. The token never appears in the profile file.
        env: { [BASE_URL_ENV]: inference.origin, FORGEJO_TOKEN: 'tok_live' },
      }),
    );
    const events = await drain(run);

    expect(mcp.authorization()).toBe('Bearer tok_live');
    expect(names(events, 'tool.end')).toEqual([
      expect.objectContaining({ name: 'mcp__forgejo__list_repos', status: 'ok' }),
    ]);
  });

  it('joins the host’s servers rather than replacing them', async () => {
    const mcp = await serveMcpOverHttp();
    const inference = await serveInference([[textChunk('ok')]]);
    const adapter = createLocalAdapter(LLAMA_CPP, {
      agentToolServers: () => ({ artemisBrowser: browserServer() }),
    });

    const run = await adapter.createRun(
      runInput(inference.origin, { toolServers: [forgejo(mcp.url)] }),
    );
    await drain(run);

    expect(inference.offered[0]).toContain('mcp__artemisBrowser__browser_read');
    expect(inference.offered[0]).toContain('mcp__forgejo__list_repos');
  });
});

describe('http_fetch, as the run wires it', () => {
  /** A page on loopback — which is, for this tool’s purposes, a private address. */
  async function servePage(): Promise<string> {
    const server = createServer((_request: IncomingMessage, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('the lamp is on');
    });
    httpServers.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}/states`;
  }

  it('reaches a machine on the LAN in the default mode, where a person approves it', async () => {
    // The whole reason private addresses are allowed at all: the endpoints this
    // user wants are a Home Assistant and a handful of tailnet services.
    const page = await servePage();
    const inference = await serveInference([
      [toolCallChunk('http_fetch', { url: page })],
      [textChunk('The lamp is on.')],
    ]);

    const run = await createLocalAdapter(LLAMA_CPP).createRun(runInput(inference.origin));
    const events = await drain(run);

    expect(names(events, 'permission.request')).toHaveLength(1);
    expect(names(events, 'tool.end')).toEqual([
      expect.objectContaining({ name: 'http_fetch', status: 'ok' }),
    ]);
  });

  it('refuses the same address in acceptEdits, where nobody is watching', async () => {
    /*
     * `acceptEdits` says "stop asking about edits to this directory". It was
     * never a decision about the network, so an unattended turn under it stays
     * off the LAN — the same reasoning that keeps the mode from auto-allowing
     * a tool server.
     */
    const page = await servePage();
    const inference = await serveInference([
      [toolCallChunk('http_fetch', { url: page })],
      [textChunk('I could not reach it.')],
    ]);

    const run = await createLocalAdapter(LLAMA_CPP).createRun(
      runInput(inference.origin, { permissionMode: 'acceptEdits' }),
    );
    const events = await drain(run, undefined);

    // Not asked about — that is what the mode buys — and refused all the same.
    expect(names(events, 'permission.request')).toHaveLength(0);
    expect(names(events, 'tool.end')).toEqual([
      expect.objectContaining({ name: 'http_fetch', status: 'error' }),
    ]);
    const ended = events.find((event) => event.type === 'tool.end') as { resultText: string };
    expect(ended.resultText).toContain('Refused');
  });

  it('is not offered at all in plan mode', async () => {
    const inference = await serveInference([[textChunk('here is the plan')]]);
    const run = await createLocalAdapter(LLAMA_CPP).createRun(
      runInput(inference.origin, { permissionMode: 'plan' }),
    );
    await drain(run);

    expect(inference.offered[0]).not.toContain('http_fetch');
    expect(inference.offered[0]).toContain('read_file');
  });
});
