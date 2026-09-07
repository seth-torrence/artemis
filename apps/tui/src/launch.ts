/**
 * Everything that has to be true before the first frame.
 *
 * Shared by the interactive app and `--print`: find the data directory, make
 * sure the working directory is one an agent can work in, compose the host,
 * pick the account the conversation opens on, and turn all of that into the
 * settings a `Conversation` starts with.
 *
 * The launch path reads *three files* — `profiles.json`, the cache of last
 * readings and what was last chosen — and spawns nothing. Listing models and probing sign-in state each
 * cost a subprocess per account, so they wait until a picker asks; a person
 * who typed `artemis` should be looking at a prompt, not a progress bar.
 *
 * Failures here are sentences, not stacks. There is no window to log into and
 * the person is right there; what they need is the thing to do next.
 */

import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { isPermissionMode, type PermissionMode, type ProviderDescriptor, type ProviderId } from '@rx-artemis/protocol';

import { ReadingCache, tuiCacheDir } from './cache.js';
import { PreferencesStore, tuiStateDir } from './preferences.js';
import type { ConversationSettings } from './conversation.js';
import { createTuiHost, type TuiHost } from './host.js';

export interface LaunchOptions {
  readonly dataDir: string;
  readonly cwd: string;
  /** A profile label or id to open on. Defaults to the first usable one. */
  readonly profile?: string;
  readonly model?: string;
  readonly mode?: string;
  /** A stored session id to open on, or `'latest'` for the newest one in this directory. */
  readonly resume?: string;
  /** Where the last slow readings are kept. Defaults to the platform's cache directory. */
  readonly cacheDir?: string;
  /** Where the remembered account, model and mode are kept. Defaults to the platform's state directory. */
  readonly stateDir?: string;
}

export interface Launched {
  readonly host: TuiHost;
  readonly settings: ConversationSettings;
  /** The last plan reading, model list and catalogue, from the previous launch. */
  readonly cache: ReadingCache;
  /** The account, model and mode this opened as, to be kept current as they change. */
  readonly preferences: PreferencesStore;
  /** What the status bar calls the working directory. */
  readonly workspace: string;
  readonly descriptors: ReadonlyMap<ProviderId, ProviderDescriptor>;
  /** Carried through for the app to act on once it is drawing. */
  readonly resume?: string;
}

export type LaunchResult = { readonly ok: true; readonly launched: Launched } | { readonly ok: false; readonly error: string };

export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const cwd = resolve(options.cwd);
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) return { ok: false, error: `${cwd} is not a directory.` };
  } catch {
    return { ok: false, error: `${cwd} does not exist or cannot be read.` };
  }

  const host = createTuiHost(options.dataDir, { cwd });

  let profiles;
  try {
    profiles = await host.profiles.listMetadata();
  } catch (error) {
    await host.dispose();
    return {
      ok: false,
      error: `Could not read profiles from ${options.dataDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (profiles.length === 0) {
    await host.dispose();
    return {
      ok: false,
      error:
        `No accounts are set up in ${options.dataDir}.\n` +
        'Add one in the Artemis desktop app first, or point ARTEMIS_DATA_DIR at an installation that has some.',
    };
  }

  const preferences = new PreferencesStore(options.stateDir ?? tuiStateDir());
  const remembered = preferences.get();

  const wanted = options.profile?.trim().toLowerCase();
  let chosen =
    wanted === undefined || wanted.length === 0
      ? undefined
      : profiles.find((profile) => profile.label.trim().toLowerCase() === wanted || profile.id === options.profile);

  /*
   * No account named: the one it was last left as, then the one that last
   * worked *here*, then the one that last worked anywhere, then the first
   * that is not hidden.
   *
   * What was last chosen comes first because it was chosen — someone who
   * switched account meant it, and being asked to switch again at every
   * launch is the complaint this order answers. The rest is the fallback for
   * a first launch, and it is the desktop's own rule: "first in the file" is
   * the one answer nobody means, and it is what made the terminal open on the
   * wrong account and show none of the conversations a person expected.
   */
  if (chosen === undefined && (wanted === undefined || wanted.length === 0)) {
    const usable = profiles.filter((profile) => profile.disabled !== true);
    chosen = usable.find((profile) => profile.id === remembered.profileId);
    if (chosen === undefined) {
      const recent = await host.listSessionsAcross(usable.map((profile) => ({ id: profile.id, providerId: profile.providerId })));
      const here = recent.find((session) => session.cwd === cwd) ?? recent[0];
      chosen = usable.find((profile) => profile.id === here?.profileId) ?? usable[0] ?? profiles[0];
    }
  }

  if (chosen === undefined) {
    await host.dispose();
    return {
      ok: false,
      error:
        `No account called "${String(options.profile)}". Accounts here: ` +
        profiles.map((profile) => profile.label).join(', '),
    };
  }

  const described = await host.providers.describe({ includeUnregistered: false });
  const descriptors = new Map<ProviderId, ProviderDescriptor>(described.map((descriptor) => [descriptor.id, descriptor]));
  const descriptor = descriptors.get(chosen.providerId);

  /*
   * The mode is remembered, but only as far as the provider will take it: an
   * account switched to one that has fewer modes must not open on a mode its
   * adapter would reject, and `default` is the one every provider has.
   */
  let permissionMode: PermissionMode = 'default';
  const modes = descriptor?.capabilities.permissionModes ?? [];
  if (isPermissionMode(remembered.permissionMode) && modes.includes(remembered.permissionMode)) {
    permissionMode = remembered.permissionMode;
  }
  if (options.mode !== undefined) {
    if (!isPermissionMode(options.mode)) {
      await host.dispose();
      return { ok: false, error: `"${options.mode}" is not a permission mode.` };
    }
    permissionMode = options.mode;
  }

  /*
   * The model is per account — see `preferences.ts` — and a flag outranks it,
   * *whole*: effort, fast mode and ultracode were chosen for the remembered
   * model and belong to it, so naming a different one on the command line
   * starts that one plain rather than wearing the other's settings.
   */
  const model = options.model === undefined ? (preferences.modelFor(chosen.id) ?? {}) : { model: options.model, modelLabel: options.model };
  const settings: ConversationSettings = {
    profileId: chosen.id,
    providerId: chosen.providerId,
    profileLabel: chosen.label,
    providerLabel: descriptor?.label ?? chosen.providerId,
    cwd,
    permissionMode,
    ...(model.model === undefined ? {} : { model: model.model, modelLabel: model.modelLabel ?? model.model }),
    ...(model.effort === undefined ? {} : { effort: model.effort }),
    ...(model.fastMode === true ? { fastMode: true } : {}),
    ...(model.ultracode === true ? { ultracode: true } : {}),
  };

  return {
    ok: true,
    launched: {
      host,
      settings,
      cache: new ReadingCache(options.cacheDir ?? tuiCacheDir()),
      preferences,
      workspace: basename(cwd) || cwd,
      descriptors,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    },
  };
}
