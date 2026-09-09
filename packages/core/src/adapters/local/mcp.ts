/**
 * Tool servers, for the provider whose loop is ours.
 * ============================================================================
 *
 * The other three providers wrap something that already speaks MCP: the Claude
 * SDK, Codex's app-server and OpenCode's ACP peer each connect to a tool server
 * themselves, and Artemis hands them a config. An inference server does not
 * speak MCP at all — it speaks one turn of chat completions — so for the local
 * providers the client is ours, the same way the loop is.
 *
 * What that buys is the point of the file: `artemisBrowser` is an
 * {@link McpServerConfig} built per run by the composition root, and a local run
 * can now be handed the *same object* the Claude adapter is handed. One factory,
 * one decision table, one set of tool names — see `apps/desktop/main/index.ts`.
 *
 * ## Four transports, one shape
 *
 * | `type`   | Reached by                                   |
 * | -------- | -------------------------------------------- |
 * | `sdk`    | an in-memory pipe to a server in this process |
 * | `stdio`  | a child process's stdin/stdout                |
 * | `http`   | streamable HTTP                               |
 * | `sse`    | HTTP + server-sent events (the older spelling) |
 *
 * `sdk` is the interesting one and the reason this file exists rather than a
 * pair of `fetch` calls. Artemis's own tool servers hold *handlers*, not a
 * socket — `createSdkMcpServer` builds a server whose tools run in the process
 * that made it — so the only way to reach one is a linked in-memory transport
 * pair. Nothing is spawned and nothing listens, exactly as on the Claude path.
 *
 * ## What a server is trusted with, and what it is not
 *
 * A tool server is configured by the *user* and spawned by *Artemis*. The model
 * never writes a command line here and never sees the server's environment, so
 * a stdio server is started with the run's own environment rather than the
 * scrubbed one `shell` gets: the scrub in `sandboxEnv` exists because the model
 * composes that command, and a server the user named in settings is not that.
 * The distinction is the whole reason a GitHub or Forgejo server can hold a
 * token at all.
 *
 * What a server is *not* trusted with is silence. Every failure here — a server
 * that will not start, a tool that throws, a call that times out — is reported
 * as text the model and the user can both read. A tool server that quietly
 * vanished would leave a model insisting it had no way to do something it was
 * told it could.
 *
 * ## Names are the contract
 *
 * `mcp__<server>__<tool>`, the spelling every other surface in Artemis already
 * uses: the transcript classifies a tool call by that prefix
 * (`packages/transcript/src/tools.ts`), permission rules and skills address
 * `mcp__artemisBrowser__browser_open`, and a user who wrote one of those under
 * Claude must not have to write it again under a local model.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { ToolServerConfig } from '@rx-artemis/protocol';
import { enabledToolServers } from '@rx-artemis/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { ToolResult, ToolSpec } from './tools.js';

/** How long a server has to answer `initialize` before it is given up on. */
const CONNECT_TIMEOUT_MS = 15_000;

/** How long one `tools/call` may take, when the server names no limit itself. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * Most text one tool result may return.
 *
 * The same bound the built-in tools use and for the same reason: a local
 * model's context is small, and a server that answers a repository search with
 * a megabyte of JSON would spend the whole of it in one call.
 */
const MAX_OUTPUT = 30_000;

/** The prefix every tool from a server carries. See the module header. */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * What went wrong with one server, in words for a person.
 *
 * A list rather than a throw: one unreachable server must not cost a run the
 * other three, and the user needs to be told which one it was.
 */
export interface ToolServerProblem {
  /** The name the config gave it. */
  readonly server: string;
  readonly detail: string;
}

/** Servers this run reached, the tools they offer, and how to call them. */
export interface ConnectedToolServers {
  /** Every tool, already namespaced and ready to offer the model. */
  readonly tools: readonly ToolSpec[];
  /** Servers that could not be reached, or whose tools could not be listed. */
  readonly problems: readonly ToolServerProblem[];
  /**
   * Run one tool call.
   *
   * Never throws, for the reason `executeTool` never throws: the model is the
   * one that has to recover, and a rejection would end the turn where "that
   * server is not answering" is something it can read and work around.
   */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  /** Shut every connection down. Safe to call twice. */
  close(): Promise<void>;
}

/** What {@link connectToolServers} needs from the run. */
export interface ConnectOptions {
  /**
   * The run's environment, for a stdio server's child process and for
   * expanding `${NAME}` in a config.
   *
   * The run's own bundle, deliberately — not the scrubbed one the shell gets.
   * See the module header.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Working directory for a stdio server's child process. */
  readonly cwd: string;
  /** Cancels a connection attempt when the run is stopped while it is opening. */
  readonly signal?: AbortSignal;
  /** Overridable for tests, which should not wait fifteen seconds to fail. */
  readonly connectTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A function name every one of these servers will accept.
 *
 * OpenAI's schema — which llama.cpp, LM Studio and Ollama all copy — allows
 * `[A-Za-z0-9_-]` and at most 64 characters. Server and tool names are not so
 * constrained, so a dot or a space in either would produce a tools array the
 * server rejects with a 400 that names nothing useful. Substituted rather than
 * refused: a user who called a server `open bao` should get working tools, not
 * a validation error about a character they cannot see the problem with.
 */
function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** `mcp__<server>__<tool>`, within the length every server enforces. */
export function qualifiedToolName(server: string, tool: string): string {
  const name = `${MCP_TOOL_PREFIX}${sanitize(server)}__${sanitize(tool)}`;
  return name.length <= 64 ? name : name.slice(0, 64);
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Substitute `${NAME}` from the environment.
 *
 * The one place a secret enters a tool server's configuration, and it enters by
 * *reference*: a config file holds `Bearer ${GITHUB_TOKEN}` and the token comes
 * from the environment the run was resolved with. A config that named the token
 * itself would be a token in a JSON file the renderer can read back, which is
 * the arrangement `Profile.publicEnv` already refuses.
 *
 * An unset name is left as it was written rather than replaced with the empty
 * string. `Bearer ${GITHUB_TOKEN}` reaching a server unexpanded produces a 401
 * naming the header; `Bearer ` produces a 401 naming nothing, and the user
 * spends the evening on the wrong problem.
 */
export function expandEnvRefs(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const value = env[name];
    return value === undefined || value === '' ? whole : value;
  });
}

/** Every value of a header/env map, with its `${NAME}` references expanded. */
function expandMap(
  map: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
  if (map === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[key] = expandEnvRefs(value, env);
  return out;
}

/**
 * A profile's tool servers, in the shape the host's own arrive in.
 *
 * One vocabulary downstream. {@link ToolServerConfig} is what a user writes and
 * what `profiles.json` keeps — JSON, renderer-safe, validated in the protocol;
 * {@link McpServerConfig} is what the composition root builds and what the
 * Claude adapter is handed. Translating at the door means everything past it
 * connects, lists and calls without asking where a server came from, which is
 * the only reason `artemisBrowser` and a user's GitHub server can be the same
 * kind of thing to the loop.
 *
 * The host's servers win a name collision, and it is not a close call:
 * `mcp__artemisBrowser__browser_open` is addressed by permission rules and
 * skills, so a profile entry that could take the name could take the rules with
 * it. The shadowed entry is reported rather than dropped in silence.
 */
export function mergeToolServers(
  hostServers: Readonly<Record<string, McpServerConfig>> | undefined,
  profileServers: readonly ToolServerConfig[] | undefined,
): { servers: Record<string, McpServerConfig>; problems: readonly ToolServerProblem[] } {
  const servers: Record<string, McpServerConfig> = { ...(hostServers ?? {}) };
  const problems: ToolServerProblem[] = [];

  for (const server of enabledToolServers(profileServers)) {
    if (Object.prototype.hasOwnProperty.call(servers, server.name)) {
      problems.push({
        server: server.name,
        detail: 'Artemis already provides a tool server under that name, so this profile entry was skipped.',
      });
      continue;
    }
    servers[server.name] = toMcpConfig(server);
  }

  return { servers, problems };
}

/** One profile entry as an {@link McpServerConfig}. */
function toMcpConfig(server: ToolServerConfig): McpServerConfig {
  const timeout = server.timeoutMs === undefined ? {} : { timeout: server.timeoutMs };
  if (server.transport === 'stdio') {
    return {
      type: 'stdio',
      command: server.command ?? '',
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      ...timeout,
    };
  }
  return {
    type: server.transport,
    url: server.url ?? '',
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    ...timeout,
  };
}

/* -------------------------------------------------------------------------- */
/* Transports                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The transport for one configured server.
 *
 * `sdk` is handled by the caller rather than here: it needs both ends of a
 * linked pair and one of them has to be given to the server instance, which is
 * a two-sided act this function's single return value cannot express.
 */
function transportFor(config: Exclude<McpServerConfig, { type: 'sdk' }>, options: ConnectOptions): Transport {
  const env = options.env;

  if (config.type === 'http') {
    const headers = expandMap(config.headers, env);
    return new StreamableHTTPClientTransport(new URL(expandEnvRefs(config.url, env)), {
      ...(headers === undefined ? {} : { requestInit: { headers } }),
    });
  }

  if (config.type === 'sse') {
    const headers = expandMap(config.headers, env);
    return new SSEClientTransport(new URL(expandEnvRefs(config.url, env)), {
      ...(headers === undefined ? {} : { requestInit: { headers } }),
    });
  }

  /*
   * A stdio server gets the run's environment, plus whatever the config adds.
   *
   * `getDefaultEnvironment()` underneath because the SDK's transport replaces
   * the child's environment wholesale when `env` is given, and a server that
   * cannot see `PATH` cannot find the interpreter it was written in. The run's
   * bundle then, so a server can read the token the user exported; then the
   * server's own entries, which are the most specific thing anyone wrote.
   */
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) inherited[key] = value;
  }
  const declared = expandMap(config.env, env) ?? {};
  return new StdioClientTransport({
    command: expandEnvRefs(config.command, env),
    args: (config.args ?? []).map((arg) => expandEnvRefs(arg, env)),
    env: { ...getDefaultEnvironment(), ...inherited, ...declared },
    cwd: options.cwd,
    // Inherited so a server's own diagnostics reach the same log the rest of
    // the app writes to, rather than a pipe nobody drains — a full pipe is a
    // server that stops answering for no reason it ever states.
    stderr: 'inherit',
  });
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** One content block of an MCP result, as far as this file cares. */
interface ResultBlock {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
  readonly data?: string;
  readonly resource?: { readonly uri?: string; readonly text?: string };
}

/**
 * An MCP result as text the model can read.
 *
 * Text blocks are joined; everything else is *described* rather than dropped.
 * A model told "the tool returned nothing" when it was actually handed a PNG
 * will conclude the page was blank and act on it; a model told there was an
 * image it cannot see asks for something else.
 */
export function resultText(result: {
  readonly content?: readonly unknown[];
  readonly structuredContent?: unknown;
}): string {
  const blocks = (result.content ?? []) as readonly ResultBlock[];
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'resource' && typeof block.resource?.text === 'string') {
      const uri = block.resource.uri ?? 'an embedded resource';
      parts.push(`[${uri}]\n${block.resource.text}`);
      continue;
    }
    const kind = block.mimeType ?? block.type;
    const size = typeof block.data === 'string' ? ` — ${String(block.data.length)} base64 characters` : '';
    parts.push(`[${kind}${size}. This tool returned data the model cannot be shown here.]`);
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    // Some servers answer with structured output and no text at all. Rendering
    // it is better than reporting an empty result for a call that worked.
    parts.push(JSON.stringify(result.structuredContent));
  }

  const joined = parts.join('\n').trim();
  if (joined === '') return 'The tool returned no output.';
  return joined.length <= MAX_OUTPUT
    ? joined
    : `${joined.slice(0, MAX_OUTPUT)}\n\n[truncated — ${String(joined.length - MAX_OUTPUT)} more characters]`;
}

/* -------------------------------------------------------------------------- */
/* Connecting                                                                 */
/* -------------------------------------------------------------------------- */

/** One reachable server and the client that holds it open. */
interface Connection {
  readonly server: string;
  readonly client: Client;
  /** The tool's own name, which is what `tools/call` must be given. */
  readonly toolNames: ReadonlyMap<string, string>;
  readonly timeout: number;
}

/**
 * Connect every configured server and list what it offers.
 *
 * Concurrent, because a run must not wait for four servers in series before its
 * first completion — and bounded, because a server that never answers
 * `initialize` would otherwise park the turn before it began.
 *
 * Always resolves. A server that fails is a {@link ToolServerProblem} and the
 * others still work: the alternative is one bad line in a config file costing
 * the user their browser tools.
 */
export async function connectToolServers(
  servers: Readonly<Record<string, McpServerConfig>>,
  options: ConnectOptions,
): Promise<ConnectedToolServers> {
  const timeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const problems: ToolServerProblem[] = [];
  const connections: Connection[] = [];
  const tools: ToolSpec[] = [];
  /** Qualified names already taken, so two servers cannot shadow each other. */
  const claimed = new Set<string>();

  const opened: {
    readonly name: string;
    readonly connection?: OpenedServer;
    readonly failure?: string;
  }[] = await Promise.all(
    Object.entries(servers).map(async (entry) => {
      const [name, config] = entry;
      try {
        return { name, connection: await open(name, config, options, timeout) };
      } catch (error) {
        return { name, failure: messageOf(error) };
      }
    }),
  );

  for (const result of opened) {
    const server = result.connection;
    if (server === undefined) {
      problems.push({ server: result.name, detail: result.failure ?? 'Could not be reached.' });
      continue;
    }
    connections.push(server);
    for (const [qualified, spec] of server.specs) {
      if (claimed.has(qualified)) {
        problems.push({
          server: result.name,
          detail: `Two servers offer a tool that resolves to "${qualified}". The later one was skipped.`,
        });
        continue;
      }
      claimed.add(qualified);
      tools.push(spec);
    }
  }

  const byName = new Map<string, Connection>();
  for (const connection of connections) {
    for (const qualified of connection.toolNames.keys()) {
      if (!byName.has(qualified)) byName.set(qualified, connection);
    }
  }

  let closed = false;
  return {
    tools,
    problems,
    async call(name, args, signal): Promise<ToolResult> {
      const connection = byName.get(name);
      const toolName = connection?.toolNames.get(name);
      if (connection === undefined || toolName === undefined) {
        return { output: `No tool called "${name}" exists.`, failed: true };
      }
      try {
        const result = await connection.client.callTool({ name: toolName, arguments: args }, undefined, {
          signal,
          timeout: connection.timeout,
        });
        const output = resultText(result as { content?: readonly unknown[] });
        // `isError` is the server saying "I ran, and the answer is no" — a
        // result, not a fault. Passed through as one so the model can read it
        // and try something else, which is the same rule the file tools follow.
        return result.isError === true ? { output, failed: true } : { output };
      } catch (error) {
        return { output: `The "${connection.server}" tool server failed: ${messageOf(error)}`, failed: true };
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.all(
        connections.map(async (connection) => {
          try {
            await connection.client.close();
          } catch {
            // Closing is best-effort by nature: the run is over, and a
            // transport that has already died has nothing left to shut.
          }
        }),
      );
    },
  };
}

/** A connected server, with its tools already translated. */
interface OpenedServer extends Connection {
  readonly specs: ReadonlyMap<string, ToolSpec>;
}

async function open(
  name: string,
  config: McpServerConfig,
  options: ConnectOptions,
  connectTimeout: number,
): Promise<OpenedServer> {
  const client = new Client(
    { name: 'artemis-local', version: '1' },
    // No capabilities declared: this client reads tools and calls them. It does
    // not sample, does not elicit and does not offer roots, and saying so is
    // what stops a server from waiting on an answer that will never come.
    { capabilities: {} },
  );

  if (config.type === 'sdk') {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverSide);
    await client.connect(clientSide, { timeout: connectTimeout });
  } else {
    await client.connect(transportFor(config, options), { timeout: connectTimeout });
  }

  const listed = await client.listTools(undefined, {
    timeout: connectTimeout,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const toolNames = new Map<string, string>();
  const specs = new Map<string, ToolSpec>();
  for (const tool of listed.tools) {
    const qualified = qualifiedToolName(name, tool.name);
    // A server offering two tools whose sanitized names collide keeps the
    // first. Reported by the caller only across servers; within one server the
    // shadowed name is the server author's problem, not the user's.
    if (toolNames.has(qualified)) continue;
    toolNames.set(qualified, tool.name);
    specs.set(qualified, {
      name: qualified,
      description: describe(name, tool),
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
      /*
       * Read-only is believed; everything else is treated as a change.
       *
       * `readOnlyHint` is the one thing MCP lets a tool say about its own
       * risk, and a tool that does not say it is assumed to change something.
       * That is the safe direction: a read misfiled as a write costs one
       * permission prompt, and a write misfiled as a read costs whatever the
       * tool did.
       */
      risk: tool.annotations?.readOnlyHint === true ? 'read' : 'write',
      // Never. This is a JSON-RPC call to a server, not a string handed to
      // `/bin/sh` — `commandSandbox.ts` has nothing to wrap and nothing to
      // refuse. See the note on `ToolSpec.needsOsSandbox`.
      needsOsSandbox: false,
      server: name,
    });
  }

  return {
    server: name,
    client,
    toolNames,
    specs,
    timeout: config.timeout ?? CALL_TIMEOUT_MS,
  };
}

/** What the model is told about one tool, with its server named. */
function describe(server: string, tool: { readonly name: string; readonly description?: string }): string {
  const own = tool.description?.trim();
  // The server's name in the sentence, because the tool name alone is a wall of
  // underscores and a model choosing between `mcp__github__search` and
  // `mcp__forgejo__search` should be able to read which is which.
  return own === undefined || own === '' ? `The "${tool.name}" tool on the ${server} server.` : own;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
