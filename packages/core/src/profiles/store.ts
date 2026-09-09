/**
 * Profile persistence.
 *
 * Profiles live in a single JSON document under Artemis's user-data directory:
 *
 * ```
 * <userDataDir>/profiles.json          the records
 * <userDataDir>/profiles/<name>/       config dirs Artemis suggested
 * ```
 *
 * The document contains labels and config-directory paths. It contains no
 * credential and no handle to one — there is no secret store behind this file
 * any more, because the provider's own CLI owns the credential and keeps it
 * inside the config directory. This file is readable plaintext by design and
 * there is nothing in it worth stealing.
 *
 * The second path above is only where Artemis's *suggestions* land. A profile's
 * `configDir` is an absolute path the user chose and may point anywhere —
 * commonly at the `~/.claude` they are already signed in to. Nothing here
 * assumes otherwise, and {@link ProfileStore.delete} is careful about it.
 *
 * `@rx-artemis/core` must not import `electron`, so the store takes its user-data
 * directory as a constructor argument rather than reaching for
 * `app.getPath('userData')`.
 *
 * Every mutation is serialised through an internal lock and committed with a
 * write-to-temp-then-rename, so an interrupted write cannot truncate the file.
 */

import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  baseUrlProblem,
  toolServersProblem,
  isCredentialRoutingEnvKey,
  isLocalProviderId,
  isProviderId,
  isSecretEnvKey,
  normalizeBaseUrl,
  normalizeProfileColor,
  normalizeProfilePlanId,
} from '@rx-artemis/protocol';
import type {
  Profile,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderId,
  ToolServerConfig,
} from '@rx-artemis/protocol';

import { ProfileError } from './errors.js';
import type { ProfileSecrets } from './secrets.js';
import {
  assertConfigDir,
  isArtemisOwnedConfigDir,
  profileConfigDir,
  profilesRoot,
  suggestConfigDir,
  toMetadata,
} from './env.js';

/** File name of the profile document inside the user-data directory. */
export const PROFILE_STORE_FILE = 'profiles.json';

/** Schema version written into the document. */
export const PROFILE_STORE_VERSION = 2;

/**
 * The previous schema, still readable.
 *
 * Version 1 stored `configDirName` — a bare directory name resolved under
 * `<userDataDir>/profiles` — plus `secretRef`, `backend` and `authMode`. It is
 * migrated on read rather than rejected: the directories those names point at
 * hold real logins and real transcripts, and a user whose profiles vanished
 * because Artemis changed its own file format would have no way to tell that
 * their accounts were still there.
 */
const PROFILE_STORE_VERSION_LEGACY = 1;

/** Valid POSIX environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shape of the on-disk document. */
interface PersistedDocument {
  readonly version: number;
  readonly profiles: readonly Profile[];
}

/** Construction options for {@link ProfileStore}. */
export interface ProfileStoreOptions {
  /** Artemis's user-data directory. Injected — core cannot ask Electron for it. */
  readonly userDataDir: string;
  /**
   * Variable names Artemis sets itself, across every registered provider —
   * normally the union of `managedEnvKeys(adapter.credentials)`.
   *
   * Used to reject `publicEnv` entries that would override Artemis's own
   * isolation choices. It is a *denylist*, so the union is the
   * right shape: over-rejecting a name one provider manages costs a user
   * nothing, while under-rejecting one silently breaks account isolation.
   *
   * Defaults to empty, which keeps this class provider-agnostic — the store
   * has no way to reach an adapter, and hard-coding one provider's variables
   * here is what made the whole profile model Claude-shaped.
   */
  readonly managedEnvKeys?: readonly string[];
  /** Override the document's file name. Tests only. */
  readonly fileName?: string;
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number;
  /** Id generator, injectable for deterministic tests. */
  readonly newId?: () => ProfileId;
  /**
   * Where per-endpoint keys are kept. Injected for the reason everything
   * Electron-shaped is: encryption is `safeStorage` and core cannot import it.
   *
   * Absent means a build that stores no keys at all. That is a real state —
   * a test, a headless run — and it must degrade honestly rather than
   * pretending: a draft carrying a key is refused rather than saved without
   * one, because a profile that reports a key it does not have sends every
   * request unauthenticated and blames the server.
   */
  readonly secrets?: ProfileSecrets;
}

/** Options for {@link ProfileStore.delete}. */
export interface DeleteProfileOptions {
  /**
   * Also remove the profile's config directory, discarding its session history.
   * Defaults to false: deleting an account should not silently destroy
   * transcripts.
   *
   * A *request*, not an instruction — see {@link ProfileStore.delete}, which
   * honours it only for a directory Artemis created.
   */
  readonly deleteConfigDir?: boolean;
}

/** Result of {@link ProfileStore.delete}. */
export interface DeleteProfileResult {
  readonly id: ProfileId;
  /** True when a config directory existed, was Artemis's, and was removed. */
  readonly configDirDeleted: boolean;
}

/**
 * CRUD over {@link Profile} records.
 *
 * Main-process only. Hand the renderer {@link ProfileMetadata} from
 * {@link listMetadata} or {@link describe} — never a {@link Profile}.
 */
export class ProfileStore {
  readonly #userDataDir: string;
  readonly #file: string;
  readonly #managedEnvKeys: readonly string[];
  readonly #now: () => number;
  readonly #newId: () => ProfileId;
  readonly #secrets: ProfileSecrets | undefined;

  /** Parsed document, or null when it has not been read yet. */
  #cache: readonly Profile[] | null = null;
  /** Serialises mutations so two concurrent writes cannot lose one another. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ProfileStoreOptions) {
    if (!options.userDataDir || !path.isAbsolute(options.userDataDir)) {
      throw new ProfileError(
        'invalid_request',
        `userDataDir must be an absolute path, got ${JSON.stringify(options.userDataDir)}`,
      );
    }
    this.#userDataDir = path.resolve(options.userDataDir);
    this.#file = path.join(this.#userDataDir, options.fileName ?? PROFILE_STORE_FILE);
    this.#managedEnvKeys = options.managedEnvKeys ?? [];
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#secrets = options.secrets;
  }

  /** Artemis's user-data directory, as given. */
  get userDataDir(): string {
    return this.#userDataDir;
  }

  /** Absolute path of the profile document. */
  get filePath(): string {
    return this.#file;
  }

  /** Absolute path of `<userDataDir>/profiles`, where suggestions land. */
  get profilesRoot(): string {
    return profilesRoot(this.#userDataDir);
  }

  /** Absolute path of one profile's config directory, re-validated. */
  configDirFor(profile: Profile | string): string {
    return profileConfigDir(profile);
  }

  /**
   * A config-directory path to offer for a profile that does not exist yet.
   *
   * Answers the `profiles:suggest-dir` IPC call. Nothing is created and nothing
   * is reserved; the user may replace it with any directory they like.
   */
  async suggestConfigDir(label: string): Promise<string> {
    return suggestConfigDir(this.#userDataDir, label, await this.#read());
  }

  /** Drop the in-memory cache so the next read hits disk. */
  reload(): void {
    this.#cache = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  /** Every stored profile, optionally narrowed to one provider. */
  async list(providerId?: ProviderId): Promise<readonly Profile[]> {
    const profiles = await this.#read();
    return providerId === undefined ? profiles : profiles.filter((p) => p.providerId === providerId);
  }

  /** One profile by id, or `undefined`. */
  async get(id: ProfileId): Promise<Profile | undefined> {
    return (await this.#read()).find((p) => p.id === id);
  }

  /**
   * One profile by id.
   *
   * @throws {ProfileError} `invalid_request` when there is no such profile.
   */
  async require(id: ProfileId): Promise<Profile> {
    const profile = await this.get(id);
    if (!profile) throw new ProfileError('invalid_request', `No profile with id "${id}"`);
    return profile;
  }

  /** Renderer-safe projection of one profile. */
  async describe(profile: Profile | ProfileId): Promise<ProfileMetadata> {
    const resolved = typeof profile === 'string' ? await this.require(profile) : profile;
    return toMetadata(resolved, await this.#hasKey(resolved.id));
  }

  /** Renderer-safe projections of every profile. What `profiles:list` returns. */
  async listMetadata(providerId?: ProviderId): Promise<readonly ProfileMetadata[]> {
    const profiles = await this.list(providerId);
    // Asked per profile rather than once for all of them: `has` does not
    // decrypt, so this is a map lookup or a stat, and a bulk API would exist
    // only to save what it does not cost.
    return Promise.all(profiles.map(async (p) => toMetadata(p, await this.#hasKey(p.id))));
  }

  /** Whether a key is stored, tolerating a store that cannot answer. */
  async #hasKey(id: ProfileId): Promise<boolean> {
    if (this.#secrets === undefined) return false;
    try {
      return await this.#secrets.has(id);
    } catch {
      // A store that cannot be read reports no key, which is the honest answer
      // for the editor: "set one". The run path fails loudly instead — there,
      // silence would mean an unauthenticated request.
      return false;
    }
  }

  /** The key for a profile's endpoint, or null. **Main process only.** */
  async readApiKey(id: ProfileId): Promise<string | null> {
    return (await this.#secrets?.read(id)) ?? null;
  }

  /**
   * Apply a draft's or patch's `apiKey` to the secret store.
   *
   * Three inputs, three meanings, and they are not interchangeable:
   * `undefined` leaves the stored key alone — which is what lets the editor
   * save a profile without making the user retype a secret it is not allowed
   * to show them — the empty string clears it, and anything else replaces it.
   *
   * Failures throw. A key the user believes is saved and is not turns every
   * later request into a 401 the server gets blamed for.
   */
  async #storeKey(id: ProfileId, apiKey: string | undefined): Promise<void> {
    if (apiKey === undefined) return;
    const secrets = this.#secrets;
    if (secrets === undefined) {
      if (apiKey === '') return;
      throw new ProfileError(
        'unknown',
        'This build cannot store an API key: no secure storage is available.',
      );
    }
    if (apiKey === '') await secrets.clear(id);
    else await secrets.write(id, apiKey);
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Create a profile.
   *
   * The profile is created signed *out*. That is the ordinary first state, not
   * an error: signing in happens afterwards, in the user's own terminal,
   * against the directory this record names. `authStatus` is what reports it.
   *
   * Two profiles may legitimately share a `configDir` — that makes them the
   * same account, which is a reasonable thing to want on purpose — so no
   * uniqueness check is imposed here. `suggestConfigDir` avoids the collision
   * for anyone who did not intend one.
   */
  async create(draft: ProfileDraft): Promise<Profile> {
    return this.#withLock(async () => {
      const label = requireLabel(draft.label);
      if (!isProviderId(draft.providerId)) {
        throw new ProfileError(
          'invalid_request',
          `Unknown providerId ${JSON.stringify(draft.providerId)}`,
        );
      }
      const configDir = assertConfigDir(draft.configDir);
      const publicEnv = sanitizePublicEnv(draft.publicEnv ?? {}, this.#managedEnvKeys);

      const existing = await this.#read();
      const timestamp = this.#now();
      const profile: Profile = {
        id: this.#newId(),
        label,
        providerId: draft.providerId,
        configDir,
        publicEnv,
        // An unusable colour is dropped rather than rejected. It decides
        // nothing, so refusing to create the profile over one would fail the
        // request for the one field that does not matter.
        color: normalizeProfileColor(draft.color) ?? undefined,
        // Same rule as the colour, for the same reason: a pin that names no
        // known plan decides nothing except how a menu sorts, so it is dropped
        // rather than made a reason to refuse creating the account.
        planId: normalizeProfilePlanId(draft.planId, draft.providerId) ?? undefined,
        // Refused rather than dropped, unlike the colour and the plan: an
        // address that does not parse is the difference between reaching the
        // server and not, so saving the profile without it would hand back a
        // profile that cannot work and no reason why.
        baseUrl: isLocalProviderId(draft.providerId) ? assertBaseUrl(draft.baseUrl) : undefined,
        // Refused rather than dropped, on the same reasoning as the address: a
        // server entry that does not parse is a tool the model will be told it
        // has and cannot use, and finding that out mid-turn is worse than
        // finding it out at the save button.
        toolServers: assertToolServers(draft.toolServers),
        // Only the opt-out is written. Both fields default to the ordinary
        // state when absent, so storing the default would fill every record
        // with a line that says nothing — and would make a profile written by
        // this build look different from one written by the last.
        autoSelect: draft.autoSelect === false ? false : undefined,
        disabled: draft.disabled === true ? true : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await this.#write([...existing, profile]);
      // After the record, deliberately: a key written first and then a failed
      // `#write` would leave a secret filed under an id no profile has.
      await this.#storeKey(profile.id, keyFor(profile.providerId, draft.apiKey));
      return profile;
    });
  }

  /**
   * Update a profile.
   *
   * Repointing `configDir` changes which account and which history the profile
   * has. The directory it previously named is left entirely alone — it may be
   * another profile's, or the user's own `~/.claude`.
   */
  async update(id: ProfileId, patch: ProfilePatch): Promise<Profile> {
    return this.#withLock(async () => {
      const profiles = [...(await this.#read())];
      const index = profiles.findIndex((p) => p.id === id);
      const current = index < 0 ? undefined : profiles[index];
      if (!current) throw new ProfileError('invalid_request', `No profile with id "${id}"`);

      const next: Profile = {
        ...current,
        label: patch.label === undefined ? current.label : requireLabel(patch.label),
        configDir:
          patch.configDir === undefined ? current.configDir : assertConfigDir(patch.configDir),
        publicEnv:
          patch.publicEnv === undefined
            ? current.publicEnv
            : sanitizePublicEnv(patch.publicEnv, this.#managedEnvKeys),
        // Omitted leaves the colour alone; anything that does not normalise —
        // the empty string being the one a caller sends on purpose — removes
        // it. See `ProfilePatch.color`.
        // Omitted leaves the address alone; the empty string goes back to the
        // provider's default. Same convention as the colour below, and the
        // same reason: a patch needs one way to say "back to absent".
        baseUrl:
          patch.baseUrl === undefined || !isLocalProviderId(current.providerId)
            ? current.baseUrl
            : assertBaseUrl(patch.baseUrl),
        // Omitted leaves the list alone; an empty array keeps none. Replaced
        // wholesale because that is what the editor does — see
        // `ProfilePatch.toolServers`.
        toolServers:
          patch.toolServers === undefined
            ? current.toolServers
            : assertToolServers(patch.toolServers),
        color:
          patch.color === undefined
            ? current.color
            : (normalizeProfileColor(patch.color) ?? undefined),
        // Omitted leaves the pin alone; the empty string unpins. Re-checked
        // against the profile's *provider* rather than accepted as given: a
        // patch that repoints `configDir` can move an account between
        // providers, and a Codex plan left pinned on a Claude account would
        // read as set in the editor while ranking nothing.
        planId:
          patch.planId === undefined
            ? (normalizeProfilePlanId(current.planId, current.providerId) ?? undefined)
            : (normalizeProfilePlanId(patch.planId, current.providerId) ?? undefined),
        // Omitted leaves the flag alone. There is no third value to spell —
        // unlike the colour and the plan, "back to the default" *is* one of the
        // two booleans — so the only work here is collapsing the default to
        // absent, which is what keeps one state from having two spellings on
        // disk. See `ProfilePatch.autoSelect`.
        autoSelect:
          (patch.autoSelect === undefined ? current.autoSelect : patch.autoSelect) === false
            ? false
            : undefined,
        disabled:
          (patch.disabled === undefined ? current.disabled : patch.disabled) === true
            ? true
            : undefined,
        updatedAt: this.#now(),
      };

      profiles[index] = next;
      await this.#write(profiles);
      await this.#storeKey(next.id, keyFor(next.providerId, patch.apiKey));
      return next;
    });
  }

  /**
   * Delete a profile.
   *
   * The config directory — and therefore the credential and the session
   * history — survives unless `deleteConfigDir` is set **and** the directory is
   * one Artemis created.
   *
   * That second condition is not a formality. `configDir` is an absolute path
   * the user chose, and the most useful thing they can put there is the
   * `~/.claude` their own CLI already uses. Honouring a recursive delete
   * against it because a switch in a profile dialog was left on would destroy
   * the user's real Claude installation, every project transcript in it, and
   * the login for whatever other profiles point at the same place. So Artemis
   * deletes only what Artemis made, and {@link DeleteProfileResult.configDirDeleted}
   * reports honestly when it declined.
   */
  async delete(id: ProfileId, options: DeleteProfileOptions = {}): Promise<DeleteProfileResult> {
    return this.#withLock(async () => {
      const profiles = [...(await this.#read())];
      const index = profiles.findIndex((p) => p.id === id);
      const profile = index < 0 ? undefined : profiles[index];
      if (!profile) throw new ProfileError('invalid_request', `No profile with id "${id}"`);

      // Resolve and check the directory *before* mutating anything, so a record
      // with a malformed `configDir` fails the whole call rather than half of
      // it. This is an `rm -r` against a path from a user-editable JSON file,
      // so it is re-validated here rather than trusted.
      let configDir: string | undefined;
      if (options.deleteConfigDir === true) {
        const resolved = this.configDirFor(profile);
        if (isArtemisOwnedConfigDir(this.#userDataDir, resolved)) configDir = resolved;
      }

      profiles.splice(index, 1);
      await this.#write(profiles);
      // The key goes with the profile. Left behind it would be a secret filed
      // under an id nothing can reach, and a later profile minted with the
      // same id — a restored backup, a hand-edited file — would silently
      // inherit it.
      await this.#secrets?.clear(id).catch(() => undefined);

      let configDirDeleted = false;
      if (configDir !== undefined) {
        configDirDeleted = await pathExists(configDir);
        await rm(configDir, { recursive: true, force: true });
      }

      return { id, configDirDeleted };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  /** Run `fn` after every previously queued mutation, successful or not. */
  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #read(): Promise<readonly Profile[]> {
    if (this.#cache) return this.#cache;

    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        this.#cache = [];
        return this.#cache;
      }
      throw new ProfileError('unknown', `Could not read ${this.#file}: ${describe(error)}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ProfileError(
        'unknown',
        `${this.#file} is not valid JSON. Move it aside to start over: ${describe(error)}`,
        { cause: error },
      );
    }

    this.#cache = parseDocument(parsed, this.#file, this.#userDataDir);
    return this.#cache;
  }

  async #write(profiles: readonly Profile[]): Promise<void> {
    const document: PersistedDocument = { version: PROFILE_STORE_VERSION, profiles };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const tmp = `${this.#file}.${randomUUID().slice(0, 8)}.tmp`;

    await mkdir(this.#userDataDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmp, this.#file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw new ProfileError('unknown', `Could not write ${this.#file}: ${describe(error)}`, {
        cause: error,
      });
    }
    this.#cache = profiles;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Trim and require a non-empty label. */
export function requireLabel(label: string): string {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) throw new ProfileError('invalid_request', 'A profile needs a non-empty label');
  if (trimmed.length > 120) {
    throw new ProfileError('invalid_request', 'Profile labels are limited to 120 characters');
  }
  return trimmed;
}

/**
 * Validate the non-sensitive environment bundle.
 *
 * Rejects three classes of name, in order of how obvious they are:
 *
 *  1. **Anything that looks like a credential.** `publicEnv` is written to a
 *     plaintext file, so this has to be a hard error rather than a warning.
 *  2. **Anything that decides where a credential is sent.** `ANTHROPIC_BASE_URL`
 *     holds no secret and passes the name heuristic, but it points the provider
 *     at a host of the writer's choosing — and the provider CLI will send the
 *     credential from its config directory there. Accepting one would let
 *     anything that can write a profile redirect a real token off-box. See
 *     {@link isCredentialRoutingEnvKey}.
 *  3. **Anything Artemis manages itself** — the config-directory variable, and
 *     every credential variable that would outrank it.
 */
export function sanitizePublicEnv(
  env: Readonly<Record<string, string>>,
  managedEnvKeys: readonly string[] = [],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) {
      throw new ProfileError(
        'invalid_request',
        `${JSON.stringify(key)} is not a valid environment variable name`,
      );
    }
    if (isSecretEnvKey(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} looks like a credential. Sign the profile in instead — publicEnv is written to disk in plaintext, and a credential set here would override the login anyway.`,
      );
    }
    if (isCredentialRoutingEnvKey(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} controls where the profile's credential is sent, which Artemis decides rather than the profile. It cannot be set in publicEnv.`,
      );
    }
    if (managedEnvKeys.includes(key)) {
      throw new ProfileError(
        'invalid_request',
        `${key} is set by Artemis from the profile's config directory and cannot be overridden in publicEnv`,
      );
    }
    if (typeof value !== 'string') {
      throw new ProfileError('invalid_request', `publicEnv.${key} must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function parseDocument(value: unknown, file: string, userDataDir: string): readonly Profile[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileError('unknown', `${file} is not a Artemis profile document`);
  }
  const document = value as { version?: unknown; profiles?: unknown };

  const legacy = document.version === PROFILE_STORE_VERSION_LEGACY;
  if (document.version !== PROFILE_STORE_VERSION && !legacy) {
    throw new ProfileError(
      'unknown',
      `${file} has schema version ${String(document.version)}; this build understands version ${PROFILE_STORE_VERSION}`,
    );
  }
  if (!Array.isArray(document.profiles)) {
    throw new ProfileError('unknown', `${file} has no profiles array`);
  }

  return document.profiles.map((entry, index) => parseProfile(entry, file, index, userDataDir, legacy));
}

function parseProfile(
  value: unknown,
  file: string,
  index: number,
  userDataDir: string,
  legacy: boolean,
): Profile {
  if (typeof value !== 'object' || value === null) {
    throw new ProfileError('unknown', `${file}: profile #${index} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const at = `${file}: profile #${index}`;

  const id = requireString(raw['id'], `${at} is missing an id`);
  const label = requireString(raw['label'], `${at} is missing a label`);
  const providerId = raw['providerId'];
  if (!isProviderId(providerId)) {
    throw new ProfileError('unknown', `${at} has an unknown providerId`);
  }

  /*
    A version-1 record names its directory rather than locating it, so the
    migration is a join against the same root version 1 resolved against. The
    result points at the directory that already exists, which is the whole
    object of the exercise: the user's login and transcripts are in it.

    `secretRef`, `backend` and `authMode` are dropped on the floor. Any secret
    behind that ref stays in the OS credential store, orphaned — deleting it
    from here would mean reaching for a `SecretStore` this class no longer has,
    to destroy a credential the user may still want in their own tooling.
  */
  const configDir = legacy
    ? path.join(
        profilesRoot(userDataDir),
        requireString(raw['configDirName'], `${at} is missing a configDirName`),
      )
    : requireString(raw['configDir'], `${at} is missing a configDir`);

  const publicEnvRaw = raw['publicEnv'];
  const publicEnv: Record<string, string> = {};
  if (publicEnvRaw !== undefined) {
    if (typeof publicEnvRaw !== 'object' || publicEnvRaw === null || Array.isArray(publicEnvRaw)) {
      throw new ProfileError('unknown', `${at} has a malformed publicEnv`);
    }
    for (const [key, entry] of Object.entries(publicEnvRaw as Record<string, unknown>)) {
      if (typeof entry !== 'string') {
        throw new ProfileError('unknown', `${at} has a non-string publicEnv.${key}`);
      }
      publicEnv[key] = entry;
    }
  }

  const createdAt: unknown = raw['createdAt'];
  const updatedAt: unknown = raw['updatedAt'];

  const profile: Profile = {
    id,
    label,
    providerId,
    configDir,
    publicEnv,
    // Re-normalised on the way out, not trusted from disk: this file is
    // hand-editable, the value ends up in a `style` attribute, and a record
    // written by an older build predates the field entirely. A colour that
    // does not parse simply is not one.
    /*
     * Re-validated on the way out like the colour, and migrated on the way
     * past: before this field existed the address lived in `publicEnv` as
     * `ARTEMIS_LOCAL_BASE_URL`, which is where every profile written by an
     * older build still keeps it. Adopting it here means those profiles keep
     * working — and keep working *better*, since the value is now visible in
     * the editor and honoured by the availability probe.
     */
    baseUrl: readBaseUrl(raw),
    // Re-validated on the way out like the address, and for the sharper
    // reason: this list is where a hand-edited file could name a command to
    // spawn, so a malformed entry is dropped here rather than carried to the
    // place that would run it.
    toolServers: readToolServers(raw['toolServers']),
    color: normalizeProfileColor(raw['color']) ?? undefined,
    // Re-checked on the way out for the same reasons as the colour, plus one
    // of its own: the plan table changes as providers rename tiers, so a pin
    // written by an older build can name a plan this one no longer knows. An
    // unknown pin becomes no pin, which falls back to the reported family.
    planId: normalizeProfilePlanId(raw['planId'], providerId) ?? undefined,
    // Read as a strict equality rather than for truthiness, which is the whole
    // of the parsing this pair needs: a hand-edited `"disabled": "yes"` is not
    // a disabled profile, and quietly hiding an account because someone typed a
    // string where a boolean goes is the one failure mode worth ruling out.
    // Anything that is not the opt-out is the default, including absence, which
    // is what every record written before these fields existed says.
    autoSelect: raw['autoSelect'] === false ? false : undefined,
    disabled: raw['disabled'] === true ? true : undefined,
    createdAt: typeof createdAt === 'number' ? createdAt : undefined,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : undefined,
  };
  return profile;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProfileError('unknown', message);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* -------------------------------------------------------------------------- */

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * The key to apply, or `undefined` to leave the store alone.
 *
 * A hosted profile never stores one. The renderer does not offer the field and
 * the IPC boundary already drops it, so reaching here with a key means a
 * caller inside the process got it wrong — and the answer is the same either
 * way: a secret nothing will ever send is a secret not worth keeping.
 */
function keyFor(providerId: ProviderId, apiKey: string | undefined): string | undefined {
  return isLocalProviderId(providerId) ? apiKey : undefined;
}

/**
 * The address to store, or `undefined` for the provider's default.
 *
 * Refuses rather than drops, which is the opposite of how the colour and the
 * plan are treated and deliberately so: those decide how a menu looks, and
 * this decides whether the profile can reach its server at all. `BASE_URL_ENV`
 * is the variable the value is eventually emitted as; see `local/adapter.ts`.
 */
function assertBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '') return undefined;
  const problem = baseUrlProblem(value);
  if (problem !== null) throw new ProfileError('invalid_request', problem);
  return normalizeBaseUrl(value);
}

/**
 * The tool servers to store, or `undefined` for none.
 *
 * Refuses rather than drops, exactly as {@link assertBaseUrl} does. The check
 * lives in the protocol so the settings form can run the same one before the
 * request is made and put the sentence beside the field.
 */
function assertToolServers(
  value: readonly ToolServerConfig[] | undefined,
): readonly ToolServerConfig[] | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) return undefined;
  const problem = toolServersProblem(value);
  if (problem !== null) throw new ProfileError('invalid_request', problem);
  return value.map(normalizeToolServer);
}

/**
 * One entry, with only the fields the protocol names.
 *
 * Rebuilt rather than passed through, which is the rule every reader in this
 * file follows: a record can be hand-edited, and an unreviewed field riding
 * into the object that eventually spawns a process is exactly the shape of
 * problem worth designing out.
 */
function normalizeToolServer(server: ToolServerConfig): ToolServerConfig {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.enabled === false ? { enabled: false } : {}),
    ...(server.command === undefined || server.command === '' ? {} : { command: server.command }),
    ...(server.args === undefined || server.args.length === 0 ? {} : { args: [...server.args] }),
    ...(server.env === undefined || Object.keys(server.env).length === 0
      ? {}
      : { env: { ...server.env } }),
    ...(server.url === undefined || server.url === '' ? {} : { url: server.url }),
    ...(server.headers === undefined || Object.keys(server.headers).length === 0
      ? {}
      : { headers: { ...server.headers } }),
    ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
  };
}

/**
 * A stored list, as far as it can be believed.
 *
 * Anything malformed becomes no list at all rather than a partial one: half a
 * tool-server config is a run whose tools depend on which half survived, and a
 * profile that reports none is a state the user can see and fix.
 */
function readToolServers(raw: unknown): readonly ToolServerConfig[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const servers: ToolServerConfig[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    const transport = record['transport'];
    if (typeof name !== 'string') return undefined;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') return undefined;
    servers.push(
      normalizeToolServer({
        name,
        transport,
        ...(record['enabled'] === false ? { enabled: false } : {}),
        ...(typeof record['command'] === 'string' ? { command: record['command'] } : {}),
        ...(Array.isArray(record['args'])
          ? { args: (record['args'] as unknown[]).filter((a): a is string => typeof a === 'string') }
          : {}),
        ...(isStringMap(record['env']) ? { env: record['env'] } : {}),
        ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
        ...(isStringMap(record['headers']) ? { headers: record['headers'] } : {}),
        ...(typeof record['timeoutMs'] === 'number' ? { timeoutMs: record['timeoutMs'] } : {}),
      }),
    );
  }
  return toolServersProblem(servers) === null ? servers : undefined;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

/** Where a stored profile's address lives now, and where it used to. */
function readBaseUrl(raw: Record<string, unknown>): string | undefined {
  const declared = raw['baseUrl'];
  if (typeof declared === 'string' && baseUrlProblem(declared) === null) {
    return normalizeBaseUrl(declared);
  }
  const env = raw['publicEnv'];
  const legacy =
    typeof env === 'object' && env !== null
      ? (env as Record<string, unknown>)['ARTEMIS_LOCAL_BASE_URL']
      : undefined;
  if (typeof legacy === 'string' && baseUrlProblem(legacy) === null) {
    return normalizeBaseUrl(legacy);
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
