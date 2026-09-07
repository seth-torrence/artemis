/**
 * Where Artemis keeps its own data, answered without Electron.
 *
 * The desktop app stores profiles, their config directories and the session
 * ledger under `app.getPath('userData')`, which for the release build is
 * `<appData>/Artemis` — see `artemisDataDir()` in `apps/desktop/main/index.ts`
 * and the rule in `appNames.ts` that governs the name. The terminal UI has no
 * Electron to ask, so this reproduces the same answer from the same inputs:
 * Chromium's `appData` convention on each platform, plus the app name.
 *
 * Getting this *identical* is the feature, not a nicety. A profile signed in
 * from the desktop works in the terminal the same minute only because both
 * processes point the provider's config-directory variable at the same
 * `<dataDir>/profiles/<name>`; a path that differed by one segment would be a
 * second, empty Artemis with no accounts in it.
 *
 * `ARTEMIS_DATA_DIR` overrides the lot, as it does for `apps/server`, so a
 * test — or a person who keeps two installations — can point the TUI
 * elsewhere.
 *
 * Inputs are parameters rather than globals so the three platform branches can
 * be exercised from one test run on one machine.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Must match `APP_NAME` in `apps/desktop/main/appNames.ts`. */
export const APP_NAME = 'Artemis';

export interface DataDirInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

/**
 * Chromium's `appData` directory for a platform — the parent that
 * `app.getPath('userData')` appends the app name to.
 *
 *  - Windows: `%APPDATA%`, falling back to the conventional roaming path.
 *  - macOS:   `~/Library/Application Support`.
 *  - else:    `$XDG_CONFIG_HOME`, or `~/.config` when it is unset or empty.
 */
export function appDataDir(inputs: DataDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? homedir();

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return appData !== undefined && appData.length > 0
      ? appData
      : join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support');
  }
  const xdg = env['XDG_CONFIG_HOME'];
  return xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.config');
}

/**
 * The directory holding `profiles.json`, `profiles/`, `sessionOwners.json`
 * and the rest of what the desktop app owns — or `ARTEMIS_DATA_DIR`, resolved
 * to an absolute path, when it is set.
 */
export function artemisDataDir(inputs: DataDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const declared = env['ARTEMIS_DATA_DIR'];
  if (declared !== undefined && declared.length > 0) return resolve(declared);
  return join(appDataDir(inputs), APP_NAME);
}
