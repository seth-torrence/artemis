/**
 * The last answer to every slow question, kept between launches.
 *
 * Plan usage, an account's model list, its slash commands and the account
 * catalogue each cost a subprocess — the provider's CLI, asked over its control channel — and take
 * a second or more apiece, more on a slower machine. Nothing about them moves
 * fast: a model list changes when a provider ships a model, the catalogue when
 * an account is added, and the plan windows with use, which is minutes. Yet
 * every launch paid all of it again — the line under the composer empty for
 * seconds, `/model` and `/profile` opening on a progress line — because a
 * terminal session is short, starts often, and remembered nothing.
 *
 * So the last reading of each is kept here and shown first, and the fresh one
 * replaces it when it arrives: the desktop's own stale-while-revalidate, with
 * the memory on disk. Its own directory, never the desktop's data directory,
 * which the terminal only ever reads (see `dataDir.ts`). The platform's cache
 * convention — `$XDG_CACHE_HOME`, `~/Library/Caches`, `%LOCALAPPDATA%` — so a
 * cleaner that empties caches may empty this one; losing it costs one slow
 * launch and nothing else.
 *
 * One JSON file, read once at launch and rewritten whole on every change.
 * Whole rather than per key because it is a few kilobytes and what matters is
 * the atomic rename: a crash mid-write leaves the old file, not half of a new
 * one. A file that cannot be read — missing, corrupt, another version — is an
 * empty cache, never an error a launch has to explain; a file that cannot be
 * written is the same thing next time.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface CacheDirInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

/**
 * Where the terminal UI keeps its own cache — or `ARTEMIS_TUI_CACHE_DIR`,
 * resolved to an absolute path, when it is set.
 *
 *  - Windows: `%LOCALAPPDATA%\Artemis\tui`, falling back to the conventional path.
 *  - macOS:   `~/Library/Caches/Artemis/tui`.
 *  - else:    `$XDG_CACHE_HOME/artemis/tui`, or `~/.cache/artemis/tui`.
 */
export function tuiCacheDir(inputs: CacheDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? homedir();

  const declared = env['ARTEMIS_TUI_CACHE_DIR'];
  if (declared !== undefined && declared.length > 0) return resolve(declared);

  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    const base = local !== undefined && local.length > 0 ? local : join(home, 'AppData', 'Local');
    return join(base, 'Artemis', 'tui');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'Artemis', 'tui');
  const xdg = env['XDG_CACHE_HOME'];
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.cache'), 'artemis', 'tui');
}

/** One remembered answer and when it was read. */
export interface Reading<T> {
  readonly at: number;
  readonly value: T;
}

/** The cache's keys, in one place so no two callers spell one differently. */
export const usageKey = (profileId: string): string => `usage:${profileId}`;
export const modelsKey = (profileId: string): string => `models:${profileId}`;
export const CATALOGUE_KEY = 'catalogue';
/**
 * Keyed by directory as well as account: the provider discovers commands
 * relative to a working directory, so two projects on one account are two
 * questions with two answers.
 */
export const commandsKey = (profileId: string, cwd: string): string => `commands:${profileId}:${cwd}`;

const FILE_VERSION = 1;
const FILE_NAME = 'readings.json';

interface FileShape {
  readonly version: number;
  readonly entries: Readonly<Record<string, Reading<unknown>>>;
}

export class ReadingCache {
  readonly #path: string;
  readonly #dir: string;
  readonly #entries = new Map<string, Reading<unknown>>();
  /** Writes are chained so two quick `set`s cannot race each other's rename. */
  #writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, FILE_NAME);
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<FileShape> | null;
      if (parsed !== null && parsed.version === FILE_VERSION && typeof parsed.entries === 'object' && parsed.entries !== null) {
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (typeof entry?.at === 'number' && 'value' in entry) this.#entries.set(key, entry);
        }
      }
    } catch {
      // Missing or unreadable: an empty cache.
    }
  }

  /** The last reading under `key`, however old. The caller decides what "too old" is. */
  get<T>(key: string): Reading<T> | undefined {
    return this.#entries.get(key) as Reading<T> | undefined;
  }

  /** Remember `value`; the file catches up in the background. */
  set<T>(key: string, value: T, at = Date.now()): void {
    this.#entries.set(key, { at, value });
    const snapshot: FileShape = { version: FILE_VERSION, entries: Object.fromEntries(this.#entries) };
    this.#writing = this.#writing.then(() => this.#write(snapshot)).catch(() => undefined);
  }

  /** Resolves once every `set` so far is on disk (or has given up). */
  flush(): Promise<void> {
    return this.#writing;
  }

  async #write(snapshot: FileShape): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot), 'utf8');
    await rename(temp, this.#path);
  }
}
