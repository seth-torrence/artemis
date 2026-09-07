/**
 * What the terminal opens as, remembered between launches.
 *
 * Choosing an account, a model and a permission mode is work, and doing it
 * again at every launch is the same work twice. So the last of each is
 * written down when it changes and read back at startup, and a flag on the
 * command line still wins: `--profile`, `--model` and `--mode` are what
 * someone says when they mean *this* launch, not from now on.
 *
 * Deliberately not in `cache.ts`, though the file looks much the same. That
 * one holds answers Artemis can go and ask for again — a model list, a plan
 * reading — and says losing it costs a slow launch; losing this costs the
 * user their settings, which is not the same promise. It therefore lives in
 * the platform's state directory rather than its cache directory, where a
 * cleaner sweeping caches will not take it.
 *
 * The model is remembered per account. A model id belongs to the provider
 * that named it, and restoring Claude's model onto a Codex account would
 * either be refused by the adapter or, worse, quietly accepted — so what is
 * stored is a small map keyed by profile, and an account that has never been
 * chosen for simply opens on its provider's default.
 *
 * One JSON file, rewritten whole, atomically, and unreadable-means-empty: a
 * launch is never something a preferences file gets to fail.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface PreferencesDirInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

/**
 * Where the terminal UI keeps what it remembers — or `ARTEMIS_TUI_STATE_DIR`,
 * resolved to an absolute path, when it is set.
 *
 *  - Windows: `%APPDATA%\Artemis\tui`.
 *  - macOS:   `~/Library/Application Support/Artemis/tui`.
 *  - else:    `$XDG_STATE_HOME/artemis/tui`, or `~/.local/state/artemis/tui`.
 */
export function tuiStateDir(inputs: PreferencesDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? homedir();

  const declared = env['ARTEMIS_TUI_STATE_DIR'];
  if (declared !== undefined && declared.length > 0) return resolve(declared);

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base = appData !== undefined && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming');
    return join(base, 'Artemis', 'tui');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Artemis', 'tui');
  const xdg = env['XDG_STATE_HOME'];
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.local', 'state'), 'artemis', 'tui');
}

/** What one account was last set to. */
export interface ModelChoice {
  readonly model?: string;
  readonly modelLabel?: string;
  readonly effort?: string;
  readonly fastMode?: boolean;
  readonly ultracode?: boolean;
}

export interface Preferences {
  /** The account the last conversation ran as. */
  readonly profileId?: string;
  /** Permission mode, which is a habit rather than a property of an account. */
  readonly permissionMode?: string;
  /** Model and its effort and speed, per account. See the file header. */
  readonly models?: Readonly<Record<string, ModelChoice>>;
}

const FILE_VERSION = 1;
const FILE_NAME = 'preferences.json';

interface FileShape {
  readonly version: number;
  readonly preferences: Preferences;
}

export class PreferencesStore {
  readonly #dir: string;
  readonly #path: string;
  #value: Preferences = {};
  /** Writes are chained so two quick changes cannot race each other's rename. */
  #writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, FILE_NAME);
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<FileShape> | null;
      if (parsed !== null && parsed.version === FILE_VERSION && typeof parsed.preferences === 'object' && parsed.preferences !== null) {
        this.#value = parsed.preferences;
      }
    } catch {
      // Missing or unreadable: nothing remembered, which is a fine way to open.
    }
  }

  get(): Preferences {
    return this.#value;
  }

  /** What this account was last set to, or nothing if it has never been chosen for. */
  modelFor(profileId: string): ModelChoice | undefined {
    return this.#value.models?.[profileId];
  }

  /** Remember `patch`; the file catches up in the background. */
  save(patch: Preferences): void {
    this.#value = { ...this.#value, ...patch, models: { ...this.#value.models, ...patch.models } };
    const snapshot: FileShape = { version: FILE_VERSION, preferences: this.#value };
    this.#writing = this.#writing.then(() => this.#write(snapshot)).catch(() => undefined);
  }

  /** Remember one account's model, leaving every other account's alone. */
  saveModelFor(profileId: string, choice: ModelChoice): void {
    this.save({ models: { [profileId]: choice } });
  }

  /** Resolves once every `save` so far is on disk (or has given up). */
  flush(): Promise<void> {
    return this.#writing;
  }

  async #write(snapshot: FileShape): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(temp, this.#path);
  }
}
