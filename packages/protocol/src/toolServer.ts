/**
 * Tool servers a profile carries.
 * ============================================================================
 *
 * Artemis has had exactly one tool server since the browser dock shipped, and it
 * is one the *app* builds: `artemisBrowser`, injected per run through
 * `agentToolServers`. What it has never had is a way for a **user** to name one.
 * The gap was recorded rather than hidden — `docs/research/OPENROUTER-GAP-ANALYSIS.md`
 * calls it out — and this is that field: a list of servers on the profile, in the
 * same place its address and its key already live.
 *
 * ## Why on the profile, and not in a file the CLI reads
 *
 * Because these providers have no CLI. A Claude profile is a config directory,
 * and a tool server named in `~/.claude/settings.json` would be found by the
 * binary Artemis spawns. A local profile is an *address* — `llama-server` holds
 * no configuration of its own and would not read a file if there were one — so
 * a server a local run should reach has to be recorded by Artemis. The profile
 * is where every other fact of that shape already is: `baseUrl` is the address,
 * `apiKey` is the key for it, and this is what else that endpoint's runs can do.
 *
 * ## Secrets are referenced, never written
 *
 * `${NAME}` in any string is expanded from the run's environment at connect
 * time — see `expandEnvRefs` in `core/adapters/local/mcp.ts`. Nothing here ever
 * holds a token: `profiles.json` is a file with nothing secret in it and stays
 * one, which is the same rule {@link Profile.publicEnv} keeps. A user with a
 * GitHub token exports it (or has their key manager export it) and writes
 * `"Authorization": "Bearer ${GITHUB_TOKEN}"`.
 *
 * That is also why {@link toolServerProblem} refuses a header or an environment
 * entry whose value *looks* like a credential rather than a reference: the
 * failure this prevents is a user pasting a live token into a settings box and
 * it being written to disk in the clear, which nothing downstream could undo.
 */

import { baseUrlProblem } from './profile.js';

/** How Artemis reaches one tool server. */
export type ToolServerTransport =
  /** A child process speaking MCP over stdin and stdout. */
  | 'stdio'
  /** Streamable HTTP. What most hosted servers speak. */
  | 'http'
  /** HTTP plus server-sent events — the older spelling, still in the wild. */
  | 'sse';

/** One tool server, as a profile records it. */
export interface ToolServerConfig {
  /**
   * The name this server's tools are addressed under:
   * `mcp__<name>__<tool>`.
   *
   * Part of the contract rather than a label. A permission rule or a prompt
   * that names `mcp__github__search_issues` keeps working only while the name
   * does, so renaming a server renames its tools.
   */
  readonly name: string;
  readonly transport: ToolServerTransport;
  /** Absent means yes. Stored only when `false`, as {@link Profile.autoSelect} is. */
  readonly enabled?: boolean;

  /** `stdio`: the executable to run. `${NAME}` is expanded from the environment. */
  readonly command?: string;
  /** `stdio`: its arguments, each expanded the same way. */
  readonly args?: readonly string[];
  /**
   * `stdio`: variables added to the child's environment, on top of the run's.
   *
   * Values may reference the environment — `"GITHUB_TOKEN": "${GH_PAT}"` — and
   * for a secret they must; see the module header.
   */
  readonly env?: Readonly<Record<string, string>>;

  /** `http` and `sse`: the endpoint. */
  readonly url?: string;
  /** `http` and `sse`: headers sent with every request, `${NAME}` expanded. */
  readonly headers?: Readonly<Record<string, string>>;

  /** Per-call ceiling in milliseconds. Omit for Artemis's own. */
  readonly timeoutMs?: number;
}

/** The most servers one profile may carry. A bound, not a target. */
export const MAX_TOOL_SERVERS = 20;

/** The shape of a server name: what survives `mcp__<name>__<tool>` unchanged. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * A value that is a credential rather than a reference to one.
 *
 * Deliberately crude, and deliberately erring towards refusal. The cost of a
 * false positive is a user writing `${MY_TOKEN}` instead of pasting a token,
 * which is what they should be doing anyway; the cost of a false negative is a
 * live credential in `profiles.json`.
 */
function looksLikeALiteralSecret(key: string, value: string): boolean {
  if (value.includes('${')) return false;
  if (/^(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|xox[abposr]|hvs|hvb)[-_]/i.test(value)) return true;
  const sensitive = /(key|token|secret|password|passwd|credential|authorization|auth)/i.test(key);
  // A long opaque string under a sensitive name. Short values are left alone:
  // `Authorization: Basic` and `X-Api-Key: dev` are not what this is for.
  return sensitive && value.trim().length >= 16;
}

/**
 * What is wrong with one server entry, in words for a person, or `null`.
 *
 * Returned rather than thrown so the settings form can put the sentence beside
 * the field. The main process validates again on the way in — a profile record
 * is JSON on disk and a user can edit it — which is the same
 * belt-and-braces `configDirProblem` keeps.
 */
export function toolServerProblem(server: ToolServerConfig): string | null {
  if (!NAME_PATTERN.test(server.name)) {
    return 'A server name must start with a letter or digit and use only letters, digits, underscores and hyphens (up to 32 characters).';
  }

  if (server.transport === 'stdio') {
    if (server.command === undefined || server.command.trim() === '') {
      return `"${server.name}" is a stdio server, so it needs a command to run.`;
    }
    if (server.url !== undefined && server.url !== '') {
      return `"${server.name}" is a stdio server and cannot also have a url.`;
    }
  } else {
    if (server.url === undefined || server.url.trim() === '') {
      return `"${server.name}" is an ${server.transport} server, so it needs a url.`;
    }
    // The same parser the endpoint field uses, and for the same reason it is
    // written by hand: this package names neither the DOM's `URL` nor Node's.
    // See {@link baseUrlProblem}.
    const problem = baseUrlProblem(server.url);
    if (problem !== null) return `The address for "${server.name}" is not usable. ${problem}`;
    if (server.command !== undefined && server.command !== '') {
      return `"${server.name}" is an ${server.transport} server and cannot also have a command.`;
    }
  }

  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (looksLikeALiteralSecret(key, value)) {
      return `The "${key}" header on "${server.name}" looks like a credential. Export it and write \${NAME} instead — a profile file is not a place to keep secrets.`;
    }
  }
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (looksLikeALiteralSecret(key, value)) {
      return `The "${key}" variable on "${server.name}" looks like a credential. Export it and write \${NAME} instead — a profile file is not a place to keep secrets.`;
    }
  }

  if (server.timeoutMs !== undefined && (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0)) {
    return `The timeout on "${server.name}" must be a positive number of milliseconds.`;
  }

  return null;
}

/**
 * What is wrong with a whole list, or `null`.
 *
 * Duplicate names are the one thing a per-entry check cannot see, and they are
 * the failure with the worst symptom: two servers resolving to one
 * `mcp__<name>__` prefix means one silently shadows the other's tools.
 */
export function toolServersProblem(servers: readonly ToolServerConfig[]): string | null {
  if (servers.length > MAX_TOOL_SERVERS) {
    return `A profile may carry at most ${String(MAX_TOOL_SERVERS)} tool servers.`;
  }
  const seen = new Set<string>();
  for (const server of servers) {
    const problem = toolServerProblem(server);
    if (problem !== null) return problem;
    const key = server.name.toLowerCase();
    if (seen.has(key)) return `Two tool servers are called "${server.name}". Names must be unique.`;
    seen.add(key);
  }
  return null;
}

/**
 * The entries a run should actually connect to.
 *
 * `enabled: false` is kept in the file rather than deleted, so switching a
 * server off for an afternoon does not cost the user the config they typed.
 */
export function enabledToolServers(
  servers: readonly ToolServerConfig[] | undefined,
): readonly ToolServerConfig[] {
  return (servers ?? []).filter((server) => server.enabled !== false);
}
