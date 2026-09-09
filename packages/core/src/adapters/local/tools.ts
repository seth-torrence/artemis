/**
 * The tools a local model may call.
 * ============================================================================
 *
 * Small on purpose. Every tool here is one Artemis must implement, document,
 * gate and defend, and a coding agent that can read, search, write and run a
 * command can do the work — where a larger surface mostly adds ways to be wrong.
 *
 * ## Two kinds, and they are defended differently
 *
 * **File tools** are performed by Artemis. It resolves the path, does the I/O,
 * and can therefore refuse — {@link confine} is a complete defence for these,
 * because nothing reaches the filesystem except through it.
 *
 * **The shell** is not performed by Artemis; a string is handed to `/bin/sh`
 * and the paths inside it are never seen. `confine` is useless there and
 * Seatbelt does the work instead. The distinction is why {@link ToolSpec}
 * carries `needsOsSandbox` rather than treating every tool the same.
 *
 * **`http_fetch`** is performed by Artemis too, but the thing it reaches is not
 * a path, so `confine` has nothing to say about it and Seatbelt is not what
 * bounds it either. Its defences are its own — a redirect cap, a byte ceiling,
 * a clock, and an address rule keyed to the permission mode (see
 * `httpFetch.ts`). `needsOsSandbox` stays false because there is no command
 * line to wrap, and that is a fact about the tool rather than a concession.
 *
 * A **tool server** belongs to none of the three columns: it performs its own
 * work in its own process (see `mcp.ts`). Artemis is a client there — it can
 * decline to call, and that is the whole of its power — so those tools carry
 * `needsOsSandbox: false` because there is nothing here to wrap, and `server`
 * because the approval prompt should say whose tool it is. They are not in
 * {@link ALL_TOOLS}: the list below is what Artemis implements, and what a run
 * is offered is that list plus whatever its servers turned out to hold.
 *
 * ## Windows still refuses the shell, and nothing here routes around it
 *
 * `commandSandbox.ts` has no Windows backend, so `shell` refuses rather than
 * running unconfined. Neither addition above is a way past that: `http_fetch`
 * runs nothing, and a tool server executes only what a *user* named in their
 * profile settings — never a command line the model composed.
 *
 * ## Risk is declared, not inferred
 *
 * Each tool says whether it changes anything. That drives approval: reading is
 * not worth interrupting someone for, and writing is. Deriving it from the name
 * would be a guess in the one place a guess is expensive.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { HTTP_FETCH, httpFetch } from './httpFetch.js';
import { confineToRoots, SandboxViolation } from './sandbox.js';
import type { SandboxRoot } from './sandbox.js';

export { HTTP_FETCH } from './httpFetch.js';

const run = promisify(execFile);

/** What a tool does to the machine, which decides whether it needs approval. */
export type ToolRisk =
  /** Changes nothing. Safe to run without interrupting anyone. */
  | 'read'
  /** Changes files inside the workspace. */
  | 'write'
  /** Arbitrary execution. Confined by the OS, never by us. */
  | 'execute';

/** One tool: what the model is told, and what actually happens. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, sent verbatim to the model. */
  readonly parameters: Record<string, unknown>;
  readonly risk: ToolRisk;
  /**
   * True when `confine` cannot defend this tool and the operating system must.
   * Only the shell — see the module header for why a tool server is not this.
   */
  readonly needsOsSandbox: boolean;
  /**
   * The tool server that performs this tool, when Artemis does not.
   *
   * Absent on everything in {@link ALL_TOOLS}. Present, and load-bearing, on
   * everything `mcp.ts` discovered: it names the server in the approval prompt,
   * routes the call in {@link executeTool}, and keeps `acceptEdits` from
   * standing in for an answer the user has not given. "Stop asking me about
   * edits" is a statement about this working directory, and a tool server's
   * work is somewhere else — a repository, a vault, a live browser — where the
   * user's next click cannot undo it.
   */
  readonly server?: string;
}

/** Everything a tool needs to do its job. */
export interface ToolContext {
  /**
   * The run's working directory, already resolved. Writable, the base a
   * relative path is resolved against, and the directory `search` runs in.
   */
  readonly root: string;
  /**
   * Directories beyond {@link root} this run was granted — a team memory bank
   * kept in `~/Documents`, say. Read-only: the file-reading tools may reach
   * into them, a write still has to land in {@link root}, and the shell is not
   * widened to them at all. Absent on the ordinary run, which is what keeps the
   * single-root behaviour of every tool below byte-for-byte unchanged.
   */
  readonly additionalRoots?: readonly SandboxRoot[];
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /**
   * Run a shell command, already confined by the caller's chosen policy.
   * Injected rather than called directly so the sandbox decision stays at the
   * call site, where the approval policy can see it.
   */
  readonly shell: (command: string, signal: AbortSignal) => Promise<ToolResult>;
  /**
   * Whether this run may reach a private address with {@link HTTP_FETCH}.
   *
   * Decided by the permission mode rather than by a setting, and the reasoning
   * is in `httpFetch.ts`: it turns on whether a person is seeing each address
   * before it is fetched. Absent reads as `false`, which is the safe direction
   * for a caller that has not thought about it.
   */
  readonly allowPrivateNetwork?: boolean;
  /**
   * Call a tool one of this run's tool servers performs.
   *
   * Injected for the same reason {@link shell} is: the connections belong to
   * the run, and a module that opened them itself would open a set per tool
   * call. Absent on a run with no servers configured, which is what keeps the
   * "no tool called that exists" answer below the truth rather than a guess.
   */
  readonly callServerTool?: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
}

/** What a tool hands back to the model. */
export interface ToolResult {
  /** Text the model sees. Truncated by the caller if it must be. */
  readonly output: string;
  /** True when the tool could not do what was asked. */
  readonly failed?: boolean;
}

/**
 * How much tool output the model is given.
 *
 * A local model's context is small and a `grep` across a monorepo is not, so
 * something must give. Truncating with a stated count is better than either
 * extreme: silently sending everything blows the context and silently sending
 * nothing looks like an empty result.
 */
const MAX_OUTPUT = 30_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n\n[truncated — ${text.length - MAX_OUTPUT} more characters]`;
}

/** Read a string argument, or say plainly which one was missing. */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`The "${key}" argument is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * Every directory a file tool may reach, working directory first.
 *
 * The working directory is the one writable root; the additional directories
 * follow, read-only, in the order they were granted. Built here rather than
 * stored on the context so the writable/read-only shape lives in exactly one
 * place — the sandbox's vocabulary — and an empty `additionalRoots` yields the
 * single-root array the confinement started life with.
 */
function rootsOf(ctx: ToolContext): readonly SandboxRoot[] {
  return [{ path: ctx.root, writable: true }, ...(ctx.additionalRoots ?? [])];
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                  */
/* -------------------------------------------------------------------------- */

export const READ_FILE: ToolSpec = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file inside the working directory. Returns the whole file with 1-based line numbers.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory.' },
    },
    required: ['path'],
  },
  risk: 'read',
  needsOsSandbox: false,
};

export const WRITE_FILE: ToolSpec = {
  name: 'write_file',
  description:
    'Write a UTF-8 text file inside the working directory, creating parent directories as needed. Replaces the whole file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory.' },
      content: { type: 'string', description: 'The complete new contents.' },
    },
    required: ['path', 'content'],
  },
  risk: 'write',
  needsOsSandbox: false,
};

export const LIST_FILES: ToolSpec = {
  name: 'list_files',
  description: 'List the entries of a directory inside the working directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory, relative to the working directory. Defaults to ".".' },
    },
  },
  risk: 'read',
  needsOsSandbox: false,
};

export const SEARCH: ToolSpec = {
  name: 'search',
  description:
    'Search file contents under the working directory for a fixed string. Returns matching lines with their file and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Literal text to find. Not a regular expression.' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  needsOsSandbox: false,
};

export const SHELL: ToolSpec = {
  name: 'shell',
  description:
    'Run a shell command in the working directory. Confined by the operating system: it cannot write outside the workspace and has no network access.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
    },
    required: ['command'],
  },
  risk: 'execute',
  // The one tool `confine` cannot defend. See the module header.
  needsOsSandbox: true,
};

export const ALL_TOOLS: readonly ToolSpec[] = [
  READ_FILE,
  WRITE_FILE,
  LIST_FILES,
  SEARCH,
  HTTP_FETCH,
  SHELL,
];

/** The tools available under a sandbox that forbids writing. */
export function toolsForRisk(allowWrite: boolean, allowExecute: boolean): readonly ToolSpec[] {
  return ALL_TOOLS.filter(
    (tool) =>
      tool.risk === 'read' ||
      (tool.risk === 'write' && allowWrite) ||
      (tool.risk === 'execute' && allowExecute),
  );
}

/** The tool array in the shape a chat-completions request wants. */
export function toWireTools(tools: readonly ToolSpec[]): readonly Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run one tool call.
 *
 * Never throws. A tool that fails returns its failure *as output*, because the
 * model is the one that has to recover: a thrown error ends the run, while
 * "that path is outside the working directory" is something the model can read
 * and correct. This is the single most important behaviour in the file — an
 * agent whose every mistake is fatal cannot work.
 */
export async function executeTool(
  name: string,
  argumentsJson: string,
  context: ToolContext,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    args = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Small models emit malformed JSON often enough that this is a normal path,
    // not an exceptional one. Telling the model is how it gets fixed.
    return { output: `Could not parse the arguments as JSON: ${argumentsJson}`, failed: true };
  }

  try {
    switch (name) {
      case READ_FILE.name:
        return await doRead(args, context);
      case WRITE_FILE.name:
        return await doWrite(args, context);
      case LIST_FILES.name:
        return await doList(args, context);
      case SEARCH.name:
        return await doSearch(args, context);
      case HTTP_FETCH.name:
        return await httpFetch(args, {
          signal: context.signal,
          allowPrivateNetwork: context.allowPrivateNetwork === true,
        });
      case SHELL.name:
        return await context.shell(requireString(args, 'command'), context.signal);
      default:
        // Not a tool Artemis implements. It may still be one a server does —
        // and the server is the only thing that can say so, which is why the
        // fallback is a call rather than a lookup here.
        if (context.callServerTool !== undefined) {
          return await context.callServerTool(name, args, context.signal);
        }
        return { output: `No tool called "${name}" exists.`, failed: true };
    }
  } catch (error) {
    if (error instanceof SandboxViolation) return { output: error.message, failed: true };
    return { output: error instanceof Error ? error.message : String(error), failed: true };
  }
}

async function doRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const at = await confineToRoots(requireString(args, 'path'), rootsOf(ctx), 'read');
  const text = await readFile(at.real, 'utf8');
  // Numbered because the model's next move is usually to describe an edit by
  // line, and unnumbered text makes that a guess.
  const numbered = text
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
    .join('\n');
  return { output: truncate(numbered) };
}

async function doWrite(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // A write must land in a writable root, so a path resolving into a read-only
  // additional directory is refused here rather than silently written.
  const at = await confineToRoots(requireString(args, 'path'), rootsOf(ctx), 'write');
  const content = args['content'];
  if (typeof content !== 'string') {
    return { output: 'The "content" argument is required and must be a string.', failed: true };
  }
  await mkdir(path.dirname(at.real), { recursive: true });
  await writeFile(at.real, content, 'utf8');
  return { output: `Wrote ${content.length} characters to ${at.relative}.` };
}

async function doList(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const requested = typeof args['path'] === 'string' && args['path'].trim() !== '' ? args['path'] : '.';
  const at = await confineToRoots(requested, rootsOf(ctx), 'read');
  const entries = await readdir(at.real, { withFileTypes: true });
  if (entries.length === 0) return { output: `${at.relative} is empty.` };
  const listing = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
    .join('\n');
  return { output: truncate(listing) };
}

/**
 * Search with `grep`, which is on every machine this runs on.
 *
 * Fixed-string rather than regular-expression search: a small model writing a
 * regex is a common source of both no matches and catastrophic ones, and `-F`
 * removes the whole class. Exit status 1 means "no matches", which is an answer
 * rather than a failure — reporting it as one would have the model retry a
 * search that worked.
 */
async function doSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = requireString(args, 'pattern');
  // The working directory as `.`, then any additional directories by absolute
  // path. `grep -r` reads and does not follow a symlink out while recursing, so
  // this widens `search` to exactly the roots the run was granted and no
  // further. With no additional directories the argv is what it always was.
  const targets = ['.', ...(ctx.additionalRoots ?? []).map((root) => root.path)];
  try {
    const { stdout } = await run(
      'grep',
      ['-rnI', '-F', '--exclude-dir=.git', '--exclude-dir=node_modules', '--', pattern, ...targets],
      { cwd: ctx.root, signal: ctx.signal, maxBuffer: MAX_OUTPUT * 4 },
    );
    return { output: truncate(stdout.trim() === '' ? `No matches for "${pattern}".` : stdout) };
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 1) return { output: `No matches for "${pattern}".` };
    throw error;
  }
}
