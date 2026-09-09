/**
 * Turning a profile into an environment.
 *
 * Two things happen here and nowhere else:
 *
 *  1. The provider's config-directory variable is pointed at the profile's own
 *     directory. Providers that key their state on it — Claude stores both its
 *     credential and its transcripts under `$CLAUDE_CONFIG_DIR` — get an
 *     isolated account *and* isolated history from that one variable.
 *  2. Every variable that could authenticate the provider some *other* way is
 *     removed, so the account a run uses is the one the profile names rather
 *     than whatever the user happens to have exported.
 *
 * Step 2 is the whole security story now, and it is worth being precise about
 * why it survived the deletion of everything around it. This module used to
 * decrypt a stored credential and write it into the one variable the profile's
 * backend and auth mode expected. It no longer holds a credential at all — the
 * provider's own login owns that, scoped to the config directory. But the
 * *stripping* still matters, and matters more: `ANTHROPIC_API_KEY` outranks the
 * config directory's login, so an ambient key would silently beat the account
 * the user signed this profile into and bill them for it. Artemis emits none of
 * these variables and removes all of them.
 *
 * ## Which variable names?
 *
 * The provider's, and this module does not know them. It takes a
 * {@link ProviderCredentialSpec} — declared by the adapter, reached through the
 * registry — and reads the config-directory variable and the strip list out of
 * it. That indirection is what keeps a second provider from being handed
 * Anthropic's vocabulary.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  configDirProblem,
  isCredentialRoutingEnvKey,
  isSecretEnvKey,
  LOCAL_API_KEY_ENV,
  LOCAL_BASE_URL_ENV,
} from '@rx-artemis/protocol';
import type { Profile, ProfileMetadata } from '@rx-artemis/protocol';

import { managedEnvKeys } from '../adapters/types.js';
import type { ProviderCredentialSpec } from '../adapters/types.js';
import { ProfileError } from './errors.js';
import { buildXdgFarm } from './xdgFarm.js';

/** Directory under the user-data dir that holds config dirs Artemis creates. */
export const PROFILES_DIR_NAME = 'profiles';

/**
 * Variables Artemis sets itself for this provider, as a set.
 *
 * Managed variables are stripped from the inherited environment and rejected in
 * `publicEnv`, so a profile's account is decided by the profile and by nothing
 * else. In particular this is what stops an `ANTHROPIC_API_KEY` sitting in the
 * user's shell from silently overriding the profile they selected — a bug that
 * would look like "account switching does not work".
 */
function managedEnvKeySet(spec: ProviderCredentialSpec): ReadonlySet<string> {
  return new Set(managedEnvKeys(spec));
}

/**
 * The provider's own variable namespaces, derived from its credential spec.
 *
 * `ANTHROPIC_` and `CLAUDE_` for Claude; `OPENAI_` and `CODEX_` for Codex —
 * read off the spec's variable names, never hard-coded, so this module still
 * knows no provider's vocabulary.
 *
 * Why the whole namespace and not just {@link managedEnvKeys}: the adapter
 * scrubs *more* than the spec lists when it merges the host environment — the
 * Claude adapter's scrub list also covers `ANTHROPIC_BASE_URL`,
 * `ANTHROPIC_MODEL` and the `CLAUDE_CODE_USE_*` backend switches — and the
 * resolved bundle is layered on top of that merge and wins. A `baseEnv` filter
 * narrower than the adapter's scrub would carry exactly those variables back
 * in through the bundle and silently re-route or re-bill the run. The scrub
 * list itself is not reachable from the spec, so the namespaces stand in for
 * it: every variable either adapter scrubs lives inside one, and a variable in
 * a provider's namespace that the adapter does *not* scrub is re-inherited
 * from the host environment anyway, so dropping it here costs nothing.
 */
function providerEnvPrefixes(spec: ProviderCredentialSpec): readonly string[] {
  const prefixes = new Set<string>();
  for (const key of managedEnvKeys(spec)) {
    const cut = key.indexOf('_');
    // A key with no underscore has no namespace to speak of; the exact-match
    // managed check already covers it.
    if (cut > 0) prefixes.add(key.slice(0, cut + 1));
  }
  return [...prefixes];
}

/**
 * Validate a {@link Profile.configDir} and return it normalized.
 *
 * A profile record is JSON on disk and a user can edit it, so this runs on
 * every use rather than only on the way in. The rules themselves live in
 * protocol's {@link configDirProblem} so that the editor can apply exactly the
 * same ones while the user is still typing, instead of discovering the refusal
 * on submit.
 *
 * @throws {ProfileError} when the path cannot be used as a config directory.
 */
export function assertConfigDir(value: string): string {
  const problem = configDirProblem(value);
  if (problem !== null) {
    throw new ProfileError('invalid_request', `"${value}" cannot be used as a config directory: ${problem}`);
  }
  return path.resolve(value.trim());
}

/**
 * Absolute path of a profile's config directory.
 *
 * @throws {ProfileError} when the stored path is malformed.
 */
export function profileConfigDir(profile: Profile | string): string {
  return assertConfigDir(typeof profile === 'string' ? profile : profile.configDir);
}

/** Absolute path of the directory holding config dirs Artemis creates itself. */
export function profilesRoot(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), PROFILES_DIR_NAME);
}

/**
 * Is this config directory one Artemis created, rather than one the user
 * pointed at?
 *
 * The single question that decides whether "delete this profile's directory"
 * is a cleanup or a catastrophe. A profile may legitimately name the user's own
 * `~/.claude`, another profile's directory, or a folder full of unrelated
 * things; recursively deleting any of those on the strength of a checkbox in a
 * profile dialog is not a risk worth taking for the convenience it buys.
 *
 * Compared on resolved paths with a trailing separator, so `/a/profiles-other`
 * is not read as being inside `/a/profiles`.
 */
export function isArtemisOwnedConfigDir(userDataDir: string, configDir: string): boolean {
  const root = profilesRoot(userDataDir);
  const resolved = path.resolve(configDir);
  if (resolved === root) return false;
  return resolved.startsWith(root + path.sep);
}

/** Turn a label into something that reads well as a directory name. */
function slugify(label: string): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug.length > 0 ? slug : 'profile';
}

/**
 * Propose a config directory for a profile that does not exist yet.
 *
 * A *suggestion*: nothing is created and nothing is reserved. The user is free
 * to replace it — pointing at an existing `~/.claude` is the main reason the
 * field accepts a full path at all — so this only has to be a good default and
 * not a decision.
 *
 * Named after the label so the path is recognisable in a terminal later, and
 * de-duplicated against directories other profiles already use, because two
 * profiles sharing a directory share an account and that should be something a
 * user chooses rather than something a slug collision does to them.
 */
export function suggestConfigDir(
  userDataDir: string,
  label: string,
  existing: readonly Profile[] = [],
): string {
  const root = profilesRoot(userDataDir);
  const taken = new Set(existing.map((profile) => path.resolve(profile.configDir)));
  const base = slugify(label);

  let candidate = path.join(root, base);
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = path.join(root, `${base}-${n}`);
  }
  return candidate;
}

/**
 * Project a {@link Profile} down to the shape that crosses IPC.
 *
 * Drops `publicEnv` and nothing else. There is no longer a credential to mask
 * or withhold, which is why this is a plain field selection rather than the
 * careful redaction it used to be.
 */
export function toMetadata(profile: Profile, hasApiKey = false): ProfileMetadata {
  return {
    id: profile.id,
    label: profile.label,
    providerId: profile.providerId,
    configDir: profile.configDir,
    /*
     * Carried, and the key is not — which is the whole shape of this feature.
     * The address is something the user typed and must be able to read back:
     * it lived in `publicEnv` before, which the renderer may not see, so the
     * setting could be written and never confirmed. A boolean is all the
     * editor needs about the key, and all it is allowed.
     */
    baseUrl: profile.baseUrl,
    // Carried whole, for the same reason the address is: the editor cannot
    // offer to change a list it is not allowed to read. There is nothing
    // secret in it — a value that looked like a credential was refused on the
    // way in. See `ProfileMetadata.toolServers`.
    toolServers: profile.toolServers,
    hasApiKey: hasApiKey ? true : undefined,
    color: profile.color,
    planId: profile.planId,
    // Both carried: the renderer owns every surface these decide — the picker
    // that hides a disabled account, and the Recommended row that skips one
    // outside the pool.
    autoSelect: profile.autoSelect,
    disabled: profile.disabled,
  };
}

/** Options for {@link resolveEnv}. */
export interface ResolveEnvOptions {
  /**
   * The key for this profile's endpoint, when it has one — read from the
   * secret store by the caller, because core cannot decrypt it itself.
   *
   * Travels the same path as every other environment value on purpose: this
   * module is documented as the one place a profile becomes an environment,
   * and a second channel for the one secret Artemis holds would be exactly the
   * kind of side door the old credential design was deleted for.
   */
  readonly apiKey?: string;
  /**
   * The provider's environment vocabulary — normally
   * `providers.require(input.providerId).credentials`.
   *
   * Required, and deliberately not defaulted to Claude's: a default here would
   * silently hand the next provider an Anthropic-shaped environment, which is
   * the defect this parameter exists to make impossible.
   */
  readonly credentials: ProviderCredentialSpec;
  /**
   * Environment to start from. Safe to hand `process.env`, because everything
   * provider-flavoured is dropped from it: the variables the provider manages
   * ({@link managedEnvKeys}) *and* everything else in the provider's own
   * namespaces (`ANTHROPIC_*`/`CLAUDE_*` for Claude, `OPENAI_*`/`CODEX_*` for
   * Codex). `PATH`, `HOME` and the rest pass through untouched.
   *
   * The namespace-wide drop is load-bearing, not tidiness: the resolved bundle
   * is layered *over* the adapter's own scrubbed host-environment merge and
   * wins, so a shell's `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_USE_BEDROCK`
   * carried in here would re-route or re-bill the run past every scrub the
   * adapter performs. A provider variable the user genuinely wants belongs in
   * the profile's `publicEnv`, where it is a choice rather than an accident.
   *
   * Defaults to `{}`: an empty bundle, which is the conservative choice for a
   * library. The host process decides how much of its own environment the
   * agent inherits — the adapter merges the host environment in itself, so
   * omitting this loses nothing on the normal path.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Create the profile's config directory if it does not exist. Defaults to
   * true — the provider will not create it itself, and a missing directory
   * means a silently non-isolated session store.
   */
  readonly ensureConfigDir?: boolean;

}

/** Options for {@link resolveStoreEnv}. */
export interface ResolveStoreEnvOptions {
  /** The provider's vocabulary, for its config-directory variable. */
  readonly credentials: ProviderCredentialSpec;
  /**
   * The host environment, for a provider whose isolation stands in for a
   * generic XDG root — it says where the *real* root is. Omitted means "use the
   * defaults under `HOME`", which is correct on a machine exporting none.
   */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Create the profile's config directory if it does not exist. Defaults to
   * **false** — the opposite of {@link resolveEnv}, because this is the read
   * path and reading history should not create anything.
   */
  readonly ensureConfigDir?: boolean;
}

/**
 * Locate a profile's provider state, without building a full run environment.
 *
 * {@link resolveEnv} answers "what does a *run* need?". Listing session history
 * is a narrower question: it needs the profile's config directory and nothing
 * else — that directory is what locates `projects/<encoded-cwd>/*.jsonl`.
 *
 * A profile that has never been signed in still has history to show if its
 * directory holds any, so this deliberately asks nothing about login state.
 *
 * @throws {ProfileError} `invalid_request` for a malformed `configDir`.
 */
export async function resolveStoreEnv(
  profile: Profile,
  options: ResolveStoreEnvOptions,
): Promise<Record<string, string>> {
  const configDir = profileConfigDir(profile);
  if (options.ensureConfigDir === true) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }
  return {
    [options.credentials.configDirVar]: configDir,
    ...(await buildXdgFarm(options.credentials.xdgRoots ?? [], configDir, options.hostEnv ?? {})),
  };
}


/**
 * Build the environment a run executes with.
 *
 * Precedence, lowest to highest:
 *
 *  1. `baseEnv`, minus every managed key and everything else in the provider's
 *     own namespaces — see {@link ResolveEnvOptions.baseEnv} for why the whole
 *     namespace goes and not just the managed list.
 *  2. `profile.publicEnv`, minus every managed key, anything that looks like a
 *     credential, and anything that decides where a credential is sent. A
 *     hand-edited profile file cannot smuggle a token in through the "extra env
 *     vars" box, nor point the CLI's own credential at another host.
 *  3. The provider's config-directory variable.
 *
 * Step 3 is the only variable Artemis sets, and it comes from
 * `options.credentials`. For Claude that resolves to `CLAUDE_CONFIG_DIR`, but
 * nothing in this function knows that.
 *
 * ## Which account, and therefore which bill
 *
 * The config directory decides, because the credential lives inside it. What
 * this function contributes is the guarantee that *nothing else* gets a vote:
 * every credential variable the provider would accept is removed, unset, on
 * every run. With `ANTHROPIC_API_KEY` inherited from the user's shell, a
 * profile signed into a Max plan would bill metered API usage instead — the
 * variable wins over the directory — so its absence is enforced here rather
 * than assumed from the fact that Artemis never writes it.
 *
 * @throws {ProfileError} `invalid_request` for a malformed `configDir`.
 */
export async function resolveEnv(
  profile: Profile,
  options: ResolveEnvOptions,
): Promise<Record<string, string>> {
  const credentials = options.credentials;
  const managed = managedEnvKeySet(credentials);
  const prefixes = providerEnvPrefixes(credentials);

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(options.baseEnv ?? {})) {
    if (value === undefined) continue;
    if (managed.has(key)) continue;
    // The provider's whole namespace, not just the managed keys: this bundle
    // outranks the adapter's own host-env scrub, so a `baseEnv` built from
    // `process.env` would otherwise carry the shell's endpoint, model and
    // backend overrides straight past it. See `providerEnvPrefixes`.
    if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(profile.publicEnv ?? {})) {
    // Defence in depth: the profile store rejects these on write, but a
    // profile file is JSON on disk and can be edited by hand. The routing
    // check matters most — the provider CLI sends a real credential to
    // whatever endpoint it is aimed at, and a `publicEnv` that survived to
    // this point could otherwise aim it.
    if (managed.has(key) || isSecretEnvKey(key) || isCredentialRoutingEnvKey(key)) continue;
    env[key] = value;
  }

  const configDir = profileConfigDir(profile);
  if (options.ensureConfigDir !== false) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }
  env[credentials.configDirVar] = configDir;
  // Providers with no directory variable of their own. Written after the scrub
  // loops above and named in `managedEnvKeys`, so an inherited value is removed
  // before the profile's own is set — the same scrub-then-set order the config
  // directory gets. The *value* is a stand-in root rather than the profile
  // itself; see `buildXdgFarm` for why overriding these outright would break
  // every other tool the agent runs.
  Object.assign(
    env,
    await buildXdgFarm(credentials.xdgRoots ?? [], configDir, options.baseEnv ?? {}),
  );

  /*
   * The endpoint and its key, for the providers that are an endpoint rather
   * than an account. Written last, after both scrub loops, for the reason the
   * config directory is: both names are in the provider's managed list, so an
   * ambient `ARTEMIS_LOCAL_BASE_URL` in the user's shell — or one that
   * survived in `publicEnv` from an older build — is removed first and the
   * profile's own value is what remains. A profile with no address set emits
   * neither variable and the adapter falls back to the flavour's default.
   */
  if (profile.baseUrl !== undefined && profile.baseUrl !== '') {
    env[LOCAL_BASE_URL_ENV] = profile.baseUrl;
  }
  if (options.apiKey !== undefined && options.apiKey !== '') {
    env[LOCAL_API_KEY_ENV] = options.apiKey;
  }

  return env;
}
