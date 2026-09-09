/**
 * The tool-server client.
 *
 * Driven against real MCP servers rather than a stubbed transport, because the
 * thing under test is a conversation — `initialize`, `tools/list`, `tools/call`
 * — and a stub would be asserting that this file's idea of the protocol matches
 * this file's idea of the protocol. Two of the three transports are exercised
 * for real: the in-process pair that `artemisBrowser` arrives on, and a
 * streamable-HTTP server on a loopback port.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ToolServerConfig } from '@rx-artemis/protocol';

import {
  connectToolServers,
  expandEnvRefs,
  mergeToolServers,
  qualifiedToolName,
  resultText,
} from '../mcp.js';

/** One tool a test server offers, and what it answers. */
interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly readOnly?: boolean;
  readonly answer: (args: Record<string, unknown>) => {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
  };
}

/** Every call a test server received, so a test can assert what went out. */
const calls: { server: string; tool: string; args: unknown }[] = [];

/**
 * A real MCP server over the low-level `Server` class.
 *
 * Low-level rather than `McpServer` because the config field is typed as the
 * latter and a test that had to author zod schemas would be testing zod. The
 * client cannot tell the difference: what it sees is the protocol.
 */
function fakeServer(label: string, tools: readonly FakeTool[]): Server {
  const server = new Server({ name: label, version: '1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: { type: 'object' as const, properties: { q: { type: 'string' } } },
      ...(tool.readOnly === undefined ? {} : { annotations: { readOnlyHint: tool.readOnly } }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const found = tools.find((tool) => tool.name === request.params.name);
    calls.push({ server: label, tool: request.params.name, args: request.params.arguments });
    if (found === undefined) throw new Error(`no tool ${request.params.name}`);
    return found.answer((request.params.arguments ?? {}) as Record<string, unknown>);
  });

  return server;
}

/** The shape `agentToolServers` hands over for an in-process server. */
function inProcess(label: string, tools: readonly FakeTool[]): McpServerConfig {
  return { type: 'sdk', name: label, instance: fakeServer(label, tools) as never };
}

const said = (text: string) => () => ({ content: [{ type: 'text' as const, text }] });

const OPTIONS = { env: {}, cwd: process.cwd(), connectTimeoutMs: 4_000 };

const httpServers: HttpServer[] = [];

afterEach(() => {
  calls.length = 0;
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/**
 * A streamable-HTTP MCP endpoint on a loopback port.
 *
 * Written out by hand rather than built from the SDK's server transport, and
 * that is the stronger test: what a user points a profile at is somebody else's
 * server, so the thing worth pinning is that this client works against a plain
 * JSON-RPC-over-POST endpoint — an `id` gets a response, a notification gets
 * 202 — rather than against the matching half of one library.
 */
async function serveOverHttp(
  label: string,
  tools: readonly FakeTool[],
): Promise<{ url: string; headers: Record<string, string | undefined>[] }> {
  const headers: Record<string, string | undefined>[] = [];
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      headers.push({ authorization: request.headers.authorization });
      const raw = Buffer.concat(chunks).toString('utf8');
      // The client opens a stream with GET and closes the session with DELETE.
      // Neither carries a body, and neither is needed here.
      if (request.method !== 'POST' || raw === '') {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(raw) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: unknown; protocolVersion?: string };
      };
      // A notification has no id and wants no answer.
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }

      let result: unknown = {};
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: label, version: '1' },
        };
      } else if (message.method === 'tools/list') {
        result = {
          tools: tools.map((tool) => ({
            name: tool.name,
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
            ...(tool.readOnly === undefined ? {} : { annotations: { readOnlyHint: tool.readOnly } }),
          })),
        };
      } else if (message.method === 'tools/call') {
        const found = tools.find((tool) => tool.name === message.params?.name);
        calls.push({ server: label, tool: message.params?.name ?? '', args: message.params?.arguments });
        result = found?.answer({}) ?? { content: [{ type: 'text', text: 'no such tool' }], isError: true };
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  httpServers.push(http);
  await new Promise<void>((ready) => http.listen(0, '127.0.0.1', ready));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/mcp`, headers };
}

describe('discovery', () => {
  it('namespaces every tool as mcp__<server>__<tool>', async () => {
    const servers = await connectToolServers(
      { artemisBrowser: inProcess('artemis-browser', [{ name: 'browser_read', answer: said('a page') }]) },
      OPTIONS,
    );

    expect(servers.tools.map((tool) => tool.name)).toEqual(['mcp__artemisBrowser__browser_read']);
    expect(servers.problems).toEqual([]);
    await servers.close();
  });

  it('believes readOnlyHint and assumes a change without it', async () => {
    const servers = await connectToolServers(
      {
        gh: inProcess('gh', [
          { name: 'search', readOnly: true, answer: said('found') },
          { name: 'create_issue', answer: said('made') },
          // A hint that says "no" is not a hint that is missing, and both mean
          // the same thing here: treat it as a change.
          { name: 'merge', readOnly: false, answer: said('merged') },
        ]),
      },
      OPTIONS,
    );

    const risk = Object.fromEntries(servers.tools.map((tool) => [tool.name, tool.risk]));
    expect(risk).toEqual({
      mcp__gh__search: 'read',
      mcp__gh__create_issue: 'write',
      mcp__gh__merge: 'write',
    });
    // Never the shell's answer: there is no command line here to confine.
    expect(servers.tools.every((tool) => !tool.needsOsSandbox)).toBe(true);
    // And every one of them names the server that performs it, which is what
    // keeps `acceptEdits` from answering for the user. See `ToolSpec.server`.
    expect(servers.tools.every((tool) => tool.server === 'gh')).toBe(true);
    await servers.close();
  });

  it('carries the tool’s own JSON Schema through untouched', async () => {
    const servers = await connectToolServers({ gh: inProcess('gh', [{ name: 'search', answer: said('x') }]) }, OPTIONS);
    expect(servers.tools[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    await servers.close();
  });
});

describe('calling', () => {
  it('sends the arguments and returns the server’s text', async () => {
    const servers = await connectToolServers(
      { gh: inProcess('gh', [{ name: 'search', answer: (args) => ({ content: [{ type: 'text', text: `got ${String(args['q'])}` }] }) }]) },
      OPTIONS,
    );

    const result = await servers.call('mcp__gh__search', { q: 'artemis' }, new AbortController().signal);

    expect(result).toEqual({ output: 'got artemis' });
    // The *server's* name for the tool goes out, not the namespaced one.
    expect(calls).toEqual([{ server: 'gh', tool: 'search', args: { q: 'artemis' } }]);
    await servers.close();
  });

  it('passes a server’s own isError through as a failed result, not a throw', async () => {
    const servers = await connectToolServers(
      {
        gh: inProcess('gh', [
          { name: 'search', answer: () => ({ content: [{ type: 'text', text: 'rate limited' }], isError: true }) },
        ]),
      },
      OPTIONS,
    );

    // A failure the model can read and work around — the same rule the file
    // tools follow. Rejecting here would end the turn.
    await expect(
      servers.call('mcp__gh__search', {}, new AbortController().signal),
    ).resolves.toEqual({ output: 'rate limited', failed: true });
    await servers.close();
  });

  it('answers honestly for a tool no server offers', async () => {
    const servers = await connectToolServers({ gh: inProcess('gh', [{ name: 'search', answer: said('x') }]) }, OPTIONS);
    await expect(
      servers.call('mcp__gh__nothing', {}, new AbortController().signal),
    ).resolves.toEqual({ output: 'No tool called "mcp__gh__nothing" exists.', failed: true });
    await servers.close();
  });

  it('reports a server that threw, naming it', async () => {
    const servers = await connectToolServers(
      {
        gh: inProcess('gh', [
          {
            name: 'search',
            answer: () => {
              throw new Error('the index is rebuilding');
            },
          },
        ]),
      },
      OPTIONS,
    );

    const result = await servers.call('mcp__gh__search', {}, new AbortController().signal);
    expect(result.failed).toBe(true);
    expect(result.output).toContain('gh');
    expect(result.output).toContain('the index is rebuilding');
    await servers.close();
  });
});

describe('streamable HTTP', () => {
  it('discovers and calls a tool over a real HTTP endpoint', async () => {
    const { url } = await serveOverHttp('forgejo', [
      { name: 'list_repos', readOnly: true, answer: said('artemis, cortex') },
    ]);

    const servers = await connectToolServers({ forgejo: { type: 'http', url } }, OPTIONS);

    expect(servers.problems).toEqual([]);
    expect(servers.tools.map((tool) => tool.name)).toEqual(['mcp__forgejo__list_repos']);
    await expect(
      servers.call('mcp__forgejo__list_repos', {}, new AbortController().signal),
    ).resolves.toEqual({ output: 'artemis, cortex' });
    await servers.close();
  });

  it('sends a header whose ${NAME} came from the run’s environment', async () => {
    // The whole of the secrets story: the config holds a reference, the run's
    // environment holds the value, and this is where the two meet the wire.
    const { url, headers } = await serveOverHttp('forgejo', [{ name: 'ping', answer: said('pong') }]);

    const servers = await connectToolServers(
      { forgejo: { type: 'http', url, headers: { authorization: 'Bearer ${FORGEJO_TOKEN}' } } },
      { ...OPTIONS, env: { FORGEJO_TOKEN: 'tok_live' } },
    );

    expect(servers.problems).toEqual([]);
    expect(headers.every((seen) => seen.authorization === 'Bearer tok_live')).toBe(true);
    expect(headers.length).toBeGreaterThan(0);
    await servers.close();
  });
});

describe('a server that will not start', () => {
  it('is a problem, not an exception, and the others still work', async () => {
    const servers = await connectToolServers(
      {
        // Nothing is listening on this port, and nothing will be.
        broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        gh: inProcess('gh', [{ name: 'search', answer: said('found') }]),
      },
      { ...OPTIONS, connectTimeoutMs: 1_500 },
    );

    expect(servers.problems.map((problem) => problem.server)).toEqual(['broken']);
    expect(servers.problems[0]?.detail).not.toBe('');
    // The whole point of not throwing: one bad line in a config file must not
    // cost the user the servers that do work.
    expect(servers.tools.map((tool) => tool.name)).toEqual(['mcp__gh__search']);
    await servers.close();
  });

  it('reports a stdio server whose command does not exist', async () => {
    const servers = await connectToolServers(
      { ghost: { type: 'stdio', command: 'artemis-no-such-binary-8f3a', args: [] } },
      { ...OPTIONS, connectTimeoutMs: 2_000 },
    );

    expect(servers.tools).toEqual([]);
    expect(servers.problems.map((problem) => problem.server)).toEqual(['ghost']);
    await servers.close();
  });
});

describe('two servers offering the same name', () => {
  it('keeps the first and says the second was skipped', async () => {
    // Sanitizing makes these collide: `a.b` and `a b` are different servers
    // and one function name.
    const servers = await connectToolServers(
      {
        'a.b': inProcess('a.b', [{ name: 'go', answer: said('first') }]),
        'a b': inProcess('a b', [{ name: 'go', answer: said('second') }]),
      },
      OPTIONS,
    );

    expect(servers.tools).toHaveLength(1);
    expect(servers.problems).toHaveLength(1);
    await expect(
      servers.call('mcp__a_b__go', {}, new AbortController().signal),
    ).resolves.toEqual({ output: 'first' });
    await servers.close();
  });
});

describe('names', () => {
  it('substitutes anything a chat-completions server would reject', () => {
    expect(qualifiedToolName('open bao', 'read.secret')).toBe('mcp__open_bao__read_secret');
  });

  it('stays inside the 64-character limit every one of these servers enforces', () => {
    const name = qualifiedToolName('a'.repeat(40), 'b'.repeat(40));
    expect(name.length).toBe(64);
  });
});

describe('${NAME} in a config', () => {
  it('takes the value from the run’s environment', () => {
    expect(expandEnvRefs('Bearer ${GITHUB_TOKEN}', { GITHUB_TOKEN: 'ghp_x' })).toBe('Bearer ghp_x');
  });

  it('leaves an unset name alone rather than sending an empty credential', () => {
    // `Bearer ` produces a 401 that names nothing. The unexpanded text names
    // the variable the user forgot to export.
    expect(expandEnvRefs('Bearer ${GITHUB_TOKEN}', {})).toBe('Bearer ${GITHUB_TOKEN}');
  });

  it('leaves everything that is not a reference alone', () => {
    expect(expandEnvRefs('$HOME and ${} and {NAME}', { HOME: '/h' })).toBe('$HOME and ${} and {NAME}');
  });
});

describe('results the model cannot be shown', () => {
  it('describes a non-text block instead of dropping it', () => {
    const text = resultText({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    // A model told the tool returned nothing would conclude the page was blank.
    expect(text).toContain('image/png');
  });

  it('renders structured output when there is no text at all', () => {
    expect(resultText({ content: [], structuredContent: { ok: true } })).toBe('{"ok":true}');
  });

  it('says so plainly for a genuinely empty result', () => {
    expect(resultText({ content: [] })).toBe('The tool returned no output.');
  });
});

describe('merging the host’s servers with the profile’s', () => {
  const profileServer = (over: Partial<ToolServerConfig> = {}): ToolServerConfig => ({
    name: 'github',
    transport: 'http',
    url: 'https://api.github.com/mcp',
    ...over,
  });

  it('translates a profile entry into the shape the host’s arrive in', () => {
    const { servers, problems } = mergeToolServers(undefined, [
      profileServer({ headers: { Authorization: 'Bearer ${T}' }, timeoutMs: 5_000 }),
    ]);

    expect(problems).toEqual([]);
    expect(servers['github']).toEqual({
      type: 'http',
      url: 'https://api.github.com/mcp',
      headers: { Authorization: 'Bearer ${T}' },
      timeout: 5_000,
    });
  });

  it('translates a stdio entry with its arguments and environment', () => {
    const { servers } = mergeToolServers(undefined, [
      { name: 'cortex', transport: 'stdio', command: 'cerebro-mcp', args: ['--bank', 'cortex'] },
    ]);
    expect(servers['cortex']).toEqual({
      type: 'stdio',
      command: 'cerebro-mcp',
      args: ['--bank', 'cortex'],
    });
  });

  it('keeps a switched-off entry out of the run', () => {
    const { servers } = mergeToolServers(undefined, [profileServer({ enabled: false })]);
    expect(Object.keys(servers)).toEqual([]);
  });

  it('lets the host’s server keep its name, and says the profile entry was skipped', () => {
    // `mcp__artemisBrowser__browser_open` is addressed by permission rules and
    // skills. A profile entry that could take the name could take the rules.
    const host = { artemisBrowser: inProcess('artemis-browser', [{ name: 'browser_read', answer: said('x') }]) };
    const { servers, problems } = mergeToolServers(host, [profileServer({ name: 'artemisBrowser' })]);

    expect(servers['artemisBrowser']).toBe(host.artemisBrowser);
    expect(problems).toEqual([
      { server: 'artemisBrowser', detail: expect.stringContaining('already provides') },
    ]);
  });

  it('carries both through when the names do not collide', () => {
    const host = { artemisBrowser: inProcess('artemis-browser', [{ name: 'browser_read', answer: said('x') }]) };
    const { servers } = mergeToolServers(host, [profileServer()]);
    expect(Object.keys(servers).sort()).toEqual(['artemisBrowser', 'github']);
  });
});
