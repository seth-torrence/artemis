/**
 * Profiles: a label, a config directory, and optionally a colour.
 *
 * A profile is how Artemis switches accounts, and it holds exactly two things
 * the user chose that decide *what a run does*: what to call it, and which
 * directory the provider's CLI keeps its state in. Everything else — which
 * account, which plan, which credential — is a property of that directory,
 * established by the user running the provider's own login against it.
 *
 * The colour is the one addition that decides nothing at all, and that is why
 * it is allowed to exist: see {@link Profile.color}.
 *
 * ## The three fields that decide something smaller
 *
 * {@link Profile.planId}, {@link Profile.autoSelect} and
 * {@link Profile.disabled} sit between those two categories, and the boundary
 * they respect is worth stating once: none of them can change what a run *does*
 * — which account is billed, which history is reachable, what the CLI is
 * handed. They decide which profile is *offered*, and how loudly. Getting one
 * wrong misranks a menu or hides a row; it never bills the wrong account, which
 * is the failure this file is otherwise organised around.
 *
 * ## Why there is no credential here
 *
 * There used to be one. A profile carried a `secretRef` into encrypted OS
 * storage, an `authMode` deciding which environment variable the secret was
 * emitted as, and a `backend` deciding where it was sent. That design had a
 * defect it could not be rid of: `ANTHROPIC_API_KEY` silently outranks a
 * subscription login, so a profile that said "bill my plan" could bill metered
 * API usage instead, and no amount of care in the editor could fix it while
 * Artemis was the thing holding the credential.
 *
 * So Artemis stopped holding one. `claude auth login` run with
 * `CLAUDE_CONFIG_DIR` pointed at a profile's directory writes a credential that
 * belongs to that directory alone — verified: two directories, two accounts,
 * same machine. Artemis sets the variable and reads a boolean back. There is no
 * token to paste, store, encrypt, mask, redact or leak, and the billing trap is
 * gone because Artemis emits neither variable and strips both.
 *
 * What survives from the old design is its one good rule, inverted: secrets
 * never travel over IPC *because there are none*.
 *
 * ## Why the config directory is a full path
 *
 * It used to be a bare name resolved under Artemis's user-data directory, which
 * made a profile record incapable of pointing anywhere dangerous. It is now an
 * absolute path the user picks, because the most useful thing a new user can do
 * is point a profile at the `~/.claude` they are already signed in to, and a
 * bare name cannot express that.
 *
 * The safety that the bare name bought is not discarded, only moved. It lived
 * in one place — "delete this profile's directory" — and that is where it now
 * lives explicitly: see `ProfilesDeleteResponse.configDirDeleted`, which is
 * false, rather than destructive, for any directory Artemis did not create.
 */

import type { ProfileId } from './ids.js';
import { PLAN_CAPACITIES } from './planCapacity.js';
import type { ProviderId } from './provider.js';
import type { ToolServerConfig } from './toolServer.js';

/**
 * A stored profile. **Main process only.**
 *
 * Unlike its predecessor this holds nothing secret, so the main-process-only
 * rule is now about `publicEnv` — an env bundle the renderer has no use for —
 * rather than about a credential handle. {@link ProfileMetadata} is still what
 * crosses IPC.
 */
export interface Profile {
  readonly id: ProfileId;
  /** User-chosen display name, e.g. "Work". */
  readonly label: string;
  readonly providerId: ProviderId;

  /**
   * Absolute path to the provider config directory this profile runs against.
   *
   * This is the whole isolation mechanism. The provider keys both its
   * credential *and* its session history on this directory, so one profile, one
   * directory, one account, one history — and pointing two profiles at the same
   * directory makes them the same account, which is a thing a user may
   * legitimately want.
   *
   * Which *variable* carries it is the adapter's business: `CLAUDE_CONFIG_DIR`
   * for Claude, something else for the next provider.
   *
   * Validate with {@link configDirProblem} before writing. A profile record is
   * JSON on disk and a user can edit it, so the check happens on every use
   * rather than only on the way in.
   */
  readonly configDir: string;

  /**
   * Non-sensitive environment variables merged into the agent's environment,
   * e.g. `ANTHROPIC_MODEL`.
   *
   * Validate with {@link isSecretEnvKey} *and*
   * {@link isCredentialRoutingEnvKey} before writing: anything that looks like
   * a credential does not belong in a plain file, and anything that decides
   * where a credential is *sent* belongs to Artemis rather than to the profile.
   */
  readonly publicEnv: Readonly<Record<string, string>>;

  /**
   * Where this profile's server is, for providers that are an endpoint rather
   * than an account — LM Studio, Ollama, llama.cpp's `llama-server`.
   *
   * A first-class field rather than a `publicEnv` entry, which is what it was.
   * The adapter's own note called that the honest short-term answer and said a
   * profile whose identity *is* an endpoint deserves its own field once the
   * shape had been used enough to know what it should look like. It has: an
   * env bundle the renderer is not allowed to read (see {@link ProfileMetadata})
   * made the setting write-only, so the address could be typed and never seen,
   * corrected or confirmed — and the availability probe read the flavour's
   * default instead, so a profile on any other port reported that nothing was
   * answering while its model list loaded fine.
   *
   * Absolute `http:` or `https:` origin, no trailing slash, validated by
   * {@link baseUrlProblem}. Absent means the flavour's default — which is what
   * an unconfigured local profile has always meant.
   *
   * Not a credential-routing hazard in the sense {@link isCredentialRoutingEnvKey}
   * guards against: these providers hold no account, Artemis sends them no
   * vendor token, and the only thing that travels here is whatever key the user
   * set for this endpoint themselves.
   */
  readonly baseUrl?: string;

  /**
   * Tool servers this profile's runs may reach, or absent for none.
   *
   * Beside {@link baseUrl} because it is the same kind of fact: what this
   * endpoint's runs can do, recorded by Artemis because the endpoint records
   * nothing. See `toolServer.ts` for the shape, why secrets are referenced
   * rather than written, and which providers read it.
   *
   * Validate with {@link toolServersProblem} before writing, on the same
   * reasoning as `configDir` — a profile record is JSON on disk and a user can
   * edit it, so the check happens on the way in and again on the way out.
   */
  readonly toolServers?: readonly ToolServerConfig[];

  /**
   * A colour the user picked for this profile, as `#rrggbb`, or absent.
   *
   * Purely a display hint, and deliberately so: it is the only field on a
   * profile that changes nothing about what a run does. Which account is
   * billed for the next prompt is the single most consequential thing a
   * profile decides and the least visible — it is a word in a status bar and a
   * word at the end of a sidebar row, both of which read as ordinary text
   * among other ordinary text. A colour is pre-attentive, so "am I about to
   * spend the work account?" is answered by a glance rather than by reading.
   *
   * Optional, and staying optional. A profile with no colour renders exactly
   * as it did before this field existed — no palette is assigned by default,
   * because a colour Artemis chose says nothing the label does not already say,
   * and it would make the profiles that *do* carry a deliberate colour
   * indistinguishable from the ones that never got one.
   *
   * Normalise with {@link normalizeProfileColor} before writing. A profile
   * record is JSON on disk and a user can edit it, so — as with `configDir` —
   * the check happens on the way in and again on the way out.
   */
  readonly color?: string;

  /**
   * Which plan this account is on, as a {@link PlanCapacity} id, or absent.
   *
   * The one fact about an account that Artemis has to be *told*. Providers
   * report a plan family rather than a tier — Claude answers `max` for both Max
   * 5x and Max 20x, Codex answers `pro` for both of its Pro tiers — and the
   * members of a family differ by four times, which is more than enough to
   * invert "which account has the most room left". Nothing else in the payload
   * separates them, so without this the comparison has to fall back to
   * percentages and say so.
   *
   * Absent is the ordinary state, not a gap to be filled in by guessing: the
   * family's smallest tier is assumed, which can only understate an account.
   * See {@link resolvePlanWeight}.
   *
   * A display-and-ranking hint only. Like {@link color} it changes nothing
   * about what a run does — it cannot grant capacity the account does not have,
   * and getting it wrong misranks a menu rather than misbilling anyone.
   */
  readonly planId?: string;

  /**
   * Whether Artemis may choose this account on the user's behalf. Absent means
   * yes.
   *
   * There are two ways a profile gets used: someone picks it, or Artemis picks
   * it — the Recommended row in the profile menu, and the account a fresh
   * session starts on. The second is the whole point of the plan poll, and it is
   * also the one an account can be a bad candidate for while remaining a
   * perfectly good account to work in: a client's, a colleague's, one whose
   * quota is being saved for a nightly job. Nothing in a usage reading can know
   * that, because it is a fact about the user's arrangements rather than about
   * the plan.
   *
   * So it is asked rather than inferred, and it removes the profile from the
   * *pool* without removing it from the *menu*. That distinction is the reason
   * this is a separate field from {@link disabled} rather than a second point on
   * one scale: "never pick this for me" and "pretend this is not here" are
   * different requests, and the first is much the commoner one.
   *
   * Stored only when `false`, which is why absent means yes: an opt-out is the
   * exception, and a `profiles.json` where every record carries
   * `"autoSelect": true` says nothing except that the field exists.
   */
  readonly autoSelect?: boolean;

  /**
   * Whether this account is hidden from the profile picker outright. Absent
   * means no.
   *
   * The blunt one, for an account that is not in use: an old employer, a trial
   * that ended, a second machine's login. It is the alternative to deleting the
   * profile, and it exists because deleting is the wrong tool for "not right
   * now" — a profile record is also a config directory, a login and a session
   * history, and the delete dialog spends most of its words explaining exactly
   * that.
   *
   * What it does **not** do is unbind anything. A past session still names this
   * profile and still resumes into it, because a transcript only resolves
   * against the directory it was written in ({@link Profile.configDir}) — a
   * disabled profile that refused to resume its own history would be a way of
   * losing work, not a way of tidying a menu. It is a rule about what can be
   * newly *chosen*.
   *
   * Implies {@link autoSelect} being off: something that cannot be picked by
   * hand is certainly not going to be picked for you. Callers should ask
   * {@link isProfileAutoSelectable} rather than reading the two fields, so that
   * implication lives in one place.
   */
  readonly disabled?: boolean;

  /** Creation time, ms since epoch. */
  readonly createdAt?: number;
  /** Last modification time, ms since epoch. */
  readonly updatedAt?: number;
}

/**
 * The renderer-safe projection of a {@link Profile}.
 *
 * Omits only `publicEnv`, which is a main-process concern.
 *
 * `configDir` **is** carried across, reversing the old rule that a filesystem
 * location had no business in the renderer. That rule protected a secret this
 * shape no longer has, and the directory is now the one fact the sign-in screen
 * cannot work without: it is what the user chose, what the login command has to
 * name, and what "is this profile signed in yet?" is asked about.
 */
export interface ProfileMetadata {
  readonly id: ProfileId;
  readonly label: string;
  readonly providerId: ProviderId;
  /** Absolute path. See {@link Profile.configDir}. */
  readonly configDir: string;
  /** `#rrggbb`, or absent. See {@link Profile.color}. */
  readonly color?: string;
  /** Pinned plan id, or absent. See {@link Profile.planId}. */
  readonly planId?: string;
  /**
   * False to keep this account out of the automatic pool. Absent means yes.
   * See {@link Profile.autoSelect}.
   *
   * Carried across because the renderer is where both consumers live: the
   * Recommended row is rendered here and the new-session hop is decided here.
   */
  readonly autoSelect?: boolean;
  /**
   * True to hide this account from the picker. Absent means no. See
   * {@link Profile.disabled}.
   */
  readonly disabled?: boolean;
  /** The server this profile talks to, or absent for the default. See {@link Profile.baseUrl}. */
  readonly baseUrl?: string;
  /**
   * The tool servers configured for this profile. See {@link Profile.toolServers}.
   *
   * Carried across whole, unlike `publicEnv` beside it, because there is
   * nothing here the renderer may not see: a config that held a secret would
   * have been refused on the way in ({@link toolServersProblem}), so what
   * survives is names, addresses and `${NAME}` references. The settings form
   * cannot edit a list it is not allowed to read back.
   */
  readonly toolServers?: readonly ToolServerConfig[];
  /**
   * Whether a key is stored for this endpoint — never the key.
   *
   * A boolean is the whole of what the renderer may know, and the field is
   * named for the question rather than the value on purpose: `apiKey` is one
   * of the key names the outbound leak scanner refuses outright, and it should
   * keep refusing it. The editor needs to render "a key is set, replace or
   * clear it" and nothing more, which this answers.
   */
  readonly hasApiKey?: boolean;
}

/** Fields the renderer supplies when creating a profile. */
export interface ProfileDraft {
  readonly label: string;
  readonly providerId: ProviderId;
  /**
   * Optional swatch colour. Any form {@link normalizeProfileColor} accepts;
   * it is stored normalised. Omit for no colour.
   */
  readonly color?: string;
  /**
   * Absolute path to the config directory. Required — a profile with no
   * directory has no account and no history, and guessing one on the user's
   * behalf is what the old bare-name scheme did.
   *
   * The main process offers a suggestion (`profiles:suggestDir`) so the field
   * arrives prefilled rather than empty.
   */
  readonly configDir: string;
  readonly publicEnv?: Readonly<Record<string, string>>;
  /** The server to talk to. Omit for the provider's default. See {@link Profile.baseUrl}. */
  readonly baseUrl?: string;
  /** Tool servers to create the profile with. See {@link Profile.toolServers}. */
  readonly toolServers?: readonly ToolServerConfig[];
  /**
   * A key for that endpoint, when it wants one — `llama-server --api-key`, a
   * reverse proxy, a tunnel that authenticates.
   *
   * Inbound only, and the asymmetry is deliberate: this travels renderer →
   * main once, when the user types it, and never comes back. What comes back
   * is {@link ProfileMetadata.hasApiKey}. Stored encrypted and apart from
   * `profiles.json`, which stays a file with nothing secret in it.
   */
  readonly apiKey?: string;
  /** Pinned plan id. Omit to let the provider's reported family stand. */
  readonly planId?: string;
  /**
   * `false` to create the profile already out of the automatic pool. Omit for
   * the ordinary state. See {@link Profile.autoSelect}.
   */
  readonly autoSelect?: boolean;
  /**
   * `true` to create the profile already hidden. Omit for the ordinary state.
   *
   * Carried even though the create form does not ask — creating a profile is
   * the moment before signing in to it, which is the worst moment to be asked
   * whether it should be hidden. The field exists because the *shape* should not
   * depend on which form is on screen, and a caller that genuinely means it (a
   * restore, an import, a test) should not have to create the profile and then
   * immediately patch it.
   */
  readonly disabled?: boolean;
}

/** Fields the renderer may change on an existing profile. */
export interface ProfilePatch {
  readonly label?: string;
  /**
   * Repoint the profile at a different directory. Omit to leave it alone.
   *
   * Changing this changes which account and which history the profile has. The
   * old directory is left on disk untouched — it may be another profile's, or
   * the user's own `~/.claude`.
   */
  readonly configDir?: string;
  readonly publicEnv?: Readonly<Record<string, string>>;
  /**
   * Repoint the profile at a different server, or **the empty string** to go
   * back to the provider's default — the same convention `color` and `planId`
   * use, and for the same reason: a patch needs a way to say "back to absent"
   * that is not a second field.
   */
  readonly baseUrl?: string;
  /**
   * Replace the whole list of tool servers, or **the empty array** to keep
   * none.
   *
   * Wholesale rather than per entry, and that is the honest shape for what the
   * editor does: the form holds the list, the user edits it, and the save is
   * "this is the list now". A per-entry patch vocabulary would be a second way
   * to express the same thing and a second thing to keep in step with the
   * form. Omitted leaves the stored list alone.
   */
  readonly toolServers?: readonly ToolServerConfig[];
  /**
   * Set, replace, or remove the endpoint's key. The **empty string clears it**.
   *
   * Omitted leaves the stored key alone, which is what lets the editor save
   * every other field without the user retyping a secret it is not allowed to
   * show them.
   */
  readonly apiKey?: string;
  /**
   * Set, change, or remove the swatch colour.
   *
   * Omitted leaves it alone, as with every other field here. The **empty
   * string removes it** — a patch has no way to say "back to absent" otherwise,
   * and inventing a `clearColor: true` companion flag for one optional field
   * would be a second way to express the same thing, which is how two fields
   * end up disagreeing.
   */
  readonly color?: string;
  /**
   * Pin, change, or unpin the plan. The empty string unpins, exactly as it
   * clears {@link color} and for the same reason.
   */
  readonly planId?: string;
  /**
   * Take this account out of the automatic pool, or put it back.
   *
   * Omitted leaves it alone, as everywhere else here — and unlike {@link color}
   * and {@link planId} there is no clearing vocabulary to invent, because the
   * field is a boolean with a default rather than a value with an absent state.
   * `true` is how "back to normal" is spelled; the store writes nothing for it.
   */
  readonly autoSelect?: boolean;
  /** Hide this account from the picker, or show it again. */
  readonly disabled?: boolean;
}

/**
 * The variable a local profile's address is emitted as.
 *
 * Named here rather than in the adapter because two layers have to agree on
 * it: `resolveEnv` writes it and `local/adapter.ts` reads it, and a constant
 * owned by one of them would make the other import an implementation to learn
 * a name. Both are also in the local provider's managed-key list, which is
 * what stops an ambient value in the user's shell from redirecting a run.
 */
export const LOCAL_BASE_URL_ENV = 'ARTEMIS_LOCAL_BASE_URL';

/**
 * The variable a local endpoint's key is emitted as.
 *
 * Set only from the encrypted store, never from `publicEnv` — the name
 * matches {@link isSecretEnvKey}, so a profile file that tried to carry it
 * would have it stripped on the way through, which is the intended outcome
 * rather than an obstacle.
 */
export const LOCAL_API_KEY_ENV = 'ARTEMIS_LOCAL_API_KEY';

/**
 * Why this string is unusable as a server address, or `null` if it is fine.
 *
 * A message rather than a boolean, for the reason {@link configDirProblem}
 * gives: the editor renders it under the field and the IPC boundary returns it
 * as an error, and neither should invent wording for a rule defined here.
 *
 * The rules are few, and each one is something that cannot work rather than a
 * preference about how someone runs their server:
 *
 *  - **Parseable, with a scheme.** A bare `127.0.0.1:8080` is the likeliest
 *    thing to be typed and is refused by name rather than silently prefixed:
 *    guessing `http:` for something the user meant to be `https:` would send
 *    their key in clear.
 *  - **`http:` or `https:` only.** Nothing else reaches `fetch`.
 *  - **A host.** `http:///v1` parses and names no machine.
 *  - **No credentials in the URL.** `http://user:pass@host` would put a secret
 *    into a field that is displayed, logged, and stored in plain JSON — the
 *    one place this design is careful to keep secrets out of.
 *
 * Not checked: whether anything is listening. That is the availability probe's
 * job, and refusing to save the address of a server that happens to be off
 * would be the same mistake as refusing a config directory that does not exist
 * yet.
 */
export function baseUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'An address is required.';
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'An address is required.';

  /*
   * Parsed by hand rather than with `URL`, which this package cannot name: the
   * protocol's types are consumed by main, renderer and the SDK, so its
   * `tsconfig` includes neither the DOM nor Node's globals and an emitted
   * `.d.ts` that mentioned either would break a consumer that has the other.
   */
  const parts = /^(https?):\/\/(.*)$/i.exec(trimmed);
  if (parts === null) {
    // A wrong scheme is named rather than folded into "no scheme": `ws://` and
    // a bare `127.0.0.1:8080` are different mistakes with different fixes.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1];
    return scheme === undefined
      ? 'Give the full address, including http:// or https://.'
      : `“${scheme}” is not an address this can reach. Use http:// or https://.`;
  }

  const authority = (parts[2] ?? '').split(/[/?#]/)[0] ?? '';
  if (authority === '') return 'The address names no host.';
  if (authority.includes('@')) {
    return 'Put the key in the API key field rather than in the address.';
  }

  // `[::1]:8080` keeps its brackets: the colons inside them are the address,
  // not a port separator, which is the whole reason the brackets are there.
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(authority);
  const host = bracketed === null ? (authority.split(':')[0] ?? '') : (bracketed[1] ?? '');
  const port = bracketed === null ? authority.split(':')[1] : bracketed[2];
  if (host === '') return 'The address names no host.';
  if (port !== undefined && !/^\d+$/.test(port)) {
    return `“${port}” is not a port number.`;
  }
  return null;
}

/**
 * The address as it is stored: trimmed, with any trailing slash removed.
 *
 * One spelling on disk, so `http://host:8080` and `http://host:8080/` are the
 * same profile rather than two that differ by a character nobody can see. The
 * adapter appends `/v1/...`, and a doubled slash is the sort of thing a strict
 * proxy answers 404 to.
 */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Why this string is unusable as a config directory, or `null` if it is fine.
 *
 * Returns a message rather than a boolean because every caller has to explain
 * the refusal to someone: the editor renders it under the field, the IPC
 * boundary returns it as an error. A bare `false` would make each of them
 * invent their own wording for a rule defined here.
 *
 * The rules are deliberately few. This is a path the user typed or picked in a
 * native dialog, and Artemis's job is to reject what cannot possibly work, not
 * to have opinions about where someone keeps their files:
 *
 *  - **Absolute**, because it is resolved by a child process whose working
 *    directory is not the user's.
 *  - **No `..` segments**, because a stored record is re-read later and a path
 *    that walks upward is a path that means something different depending on
 *    what has been renamed since.
 *  - **Not a filesystem root**, which is never what anyone meant and is the one
 *    value that would make a recursive delete catastrophic.
 *
 * Note what is *not* checked: existence. The directory is created on first use,
 * and demanding it exist would stop a user naming a fresh one.
 */
export function configDirProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'A config directory is required.';

  const trimmed = value.trim();
  if (trimmed.length === 0) return 'A config directory is required.';

  // Both separators are checked regardless of host platform: a profiles file
  // written on Windows can be read on macOS, and vice versa.
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes('..')) {
    return 'The path cannot contain “..”. Give the directory’s full location.';
  }

  const isPosixAbsolute = trimmed.startsWith('/');
  // `C:\…` or `\\server\share`.
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
  if (!isPosixAbsolute && !isWindowsAbsolute) {
    // `~` is not expanded anywhere in Artemis — a child process receives it
    // literally and creates a directory called `~`, which is a mess to explain
    // afterwards. Rejecting it up front is kinder than accepting it.
    return trimmed.startsWith('~')
      ? 'Artemis cannot expand “~”. Give the full path, starting with “/”.'
      : 'The path must be absolute — it has to start with “/”.';
  }

  // Everything remaining is a separator, i.e. the path names a root.
  if (segments.filter((segment) => segment.length > 0).length === (isWindowsAbsolute ? 1 : 0)) {
    return 'That is the root of the filesystem. Choose a directory inside it.';
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

/** `#abc`, `#aabbcc`, or either without the `#`. Nothing else. */
const HEX_COLOR = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Canonicalise a user-supplied colour to `#rrggbb`, or `null` if it is not one.
 *
 * Returns the value rather than a boolean because every caller needs the
 * normalised form: the store writes it, the IPC boundary forwards it, and the
 * UI feeds it to an `<input type="color">`, which accepts **only** full
 * lowercase `#rrggbb` and silently shows black for anything else. Normalising
 * once here is what stops `#ABC` from round-tripping into a black swatch.
 *
 * Hex specifically, and not the whole of CSS. The value is chosen with an RGB
 * picker and rendered as a small square, so nothing needs `hsl()`, `color()`,
 * or a named colour — and accepting arbitrary CSS colour syntax would put a
 * user-controlled string into a `style` attribute, which is a place where
 * "whatever CSS accepts" is not a good rule. A blank string is not an error: it
 * is how "no colour" is spelled, so callers check for `null` and store nothing.
 */
export function normalizeProfileColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !HEX_COLOR.test(trimmed)) return null;

  const hex = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();
  // `#abc` and `#aabbcc` name the same colour; store the long form so string
  // comparison and the colour input agree.
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : hex;
  return `#${full}`;
}

/**
 * Why this string is unusable as a profile colour, or `null` if it is fine.
 *
 * The companion to {@link normalizeProfileColor} for the one caller that has to
 * explain the refusal — the profile form, under the field. An empty value is
 * accepted here too: a profile with no colour is the default state, not a
 * mistake.
 */
export function profileColorProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'A colour must be a hex value such as #7c8cff.';
  if (value.trim().length === 0) return null;
  return normalizeProfileColor(value) === null
    ? 'That is not a hex colour. Use #rgb or #rrggbb — for example #7c8cff.'
    : null;
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Canonicalise a pinned plan id, or `null` if it does not name a known plan.
 *
 * The same shape as {@link normalizeProfileColor}, and for the same reasons: a
 * profiles file is hand-editable, the value arrives over IPC, and every layer
 * needs the identical rule rather than its own approximation.
 *
 * Validated against {@link PLAN_CAPACITIES} rather than accepted as free text,
 * because an id that matches nothing is not a harmless label — it is a pin that
 * silently never applies, leaving a user who has told Artemis their plan
 * looking at a ranking that ignored them.
 *
 * A blank value is not an error: it is how "no pin" is spelled, so callers
 * check for `null` and store nothing.
 */
export function normalizeProfilePlanId(value: unknown, providerId?: ProviderId): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const plan = PLAN_CAPACITIES.find((candidate) => candidate.id === trimmed);
  if (!plan) return null;
  /*
    A pin belonging to a different provider is dropped rather than kept. It can
    only arrive by repointing a profile at another provider's config directory,
    and a Codex plan weighed on Claude's ladder is worse than no pin at all —
    `resolvePlanWeight` would refuse it anyway, so storing it would leave a
    field in the editor that reads as set and behaves as unset.
  */
  if (providerId !== undefined && plan.providerId !== providerId) return null;
  return plan.id;
}

/**
 * Why this string is unusable as a plan pin, or `null` if it is fine.
 *
 * The companion to {@link normalizeProfilePlanId} for the profile form, in the
 * shape {@link profileColorProblem} established. An empty value is accepted:
 * unpinned is the default state.
 */
export function profilePlanIdProblem(value: unknown, providerId?: ProviderId): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'A plan must be one of the listed options.';
  if (value.trim().length === 0) return null;
  return normalizeProfilePlanId(value, providerId) === null
    ? 'That is not a plan Artemis knows about for this provider.'
    : null;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a profile the availability rules read.
 *
 * A structural parameter rather than `Profile | ProfileMetadata`, because both
 * shapes carry these two fields and both sides of the IPC boundary ask the
 * question. Taking the shape actually needed is what stops the main process
 * importing a renderer type, or either of them re-deriving the defaults.
 *
 * There is no normaliser beside these, unlike the colour and the plan above.
 * Those exist because `#ABC` and `claude:max-20x` are values that have to be
 * *parsed*, and a hand-edited file can hold a near-miss worth repairing. A
 * boolean has no near-miss: anything that is not the opt-out is the default, so
 * the check is a strict equality at each boundary and the knowledge worth
 * centralising is which value that is — which is what these two answer.
 */
export interface ProfileAvailability {
  readonly autoSelect?: boolean;
  readonly disabled?: boolean;
}

/**
 * Whether this account may be picked at all.
 *
 * The one rule the profile picker filters on. Note what it is *not* asked
 * about: a run that is already bound to a profile, or a past session being
 * resumed into one. Disabling hides an account from the list of things that can
 * be chosen next; it does not retire the account, which is why
 * {@link Profile.disabled} says at length that history still resolves.
 */
export function isProfileEnabled(profile: ProfileAvailability): boolean {
  return profile.disabled !== true;
}

/**
 * Whether Artemis may choose this account without being asked.
 *
 * Both flags, in one place, because `disabled` implies the opt-out and a caller
 * that checked only `autoSelect` would recommend an account it had just hidden
 * from the menu it was recommending into. Everything that picks a profile *for*
 * the user — the Recommended row, the account a fresh session starts on, the
 * fallback when the selected one disappears — asks this rather than reading the
 * fields.
 */
export function isProfileAutoSelectable(profile: ProfileAvailability): boolean {
  return isProfileEnabled(profile) && profile.autoSelect !== false;
}

/**
 * Environment variable names that must never be stored in
 * {@link Profile.publicEnv}.
 *
 * A heuristic, not a proof — but it catches the realistic mistakes (someone
 * pasting `ANTHROPIC_AUTH_TOKEN` into the "extra env vars" box) before they
 * reach a file that is not encrypted.
 */
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** True when `name` looks like it would hold a credential. */
export function isSecretEnvKey(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name);
}

/**
 * Variables that decide **where a credential is sent**, rather than what it is.
 *
 * {@link isSecretEnvKey} asks "does this hold a secret?". That is the wrong
 * question for a variable like `ANTHROPIC_BASE_URL`: it holds no secret, passes
 * the name heuristic cleanly, and yet points the provider — and therefore the
 * credential the CLI just logged in with — at a host of the caller's choosing.
 *
 * Artemis no longer stores a credential, which removes one exfiltration route
 * and not this one: the CLI still sends a real token to whatever endpoint it is
 * aimed at, and a renderer able to write one of these into `publicEnv` would
 * aim it.
 *
 * Four families, all of which redirect or expose traffic that carries a token:
 *
 *  - **endpoint overrides** — send the request somewhere else outright.
 *  - **proxies** — route it through a host that can observe or alter it.
 *  - **TLS trust** — make interception by such a host undetectable.
 *  - **runtime injection** — `NODE_OPTIONS` can `--require` arbitrary code into
 *    the provider process, which holds the credential in memory.
 *
 * A profile legitimately needs none of these: model selection goes in
 * `publicEnv`, but *routing* is Artemis's to decide. Enforced at the IPC boundary
 * and again in the profile store, so a hand-edited `profiles.json` is covered
 * too.
 *
 * Matching is case-insensitive. POSIX environments are case-sensitive, but
 * `http_proxy` and `HTTP_PROXY` are both honoured in the wild, so a
 * case-sensitive list would be trivially bypassed.
 */
const CREDENTIAL_ROUTING_ENV_KEYS: readonly string[] = [
  // endpoint overrides
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK',
  'OPENAI_BASE_URL',
  // proxies (NO_PROXY is here because it can *disable* a trusted proxy)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'PROXY',
  // TLS trust
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // runtime injection into the process holding the credential
  'NODE_OPTIONS',
];

const CREDENTIAL_ROUTING_ENV_KEY_SET: ReadonlySet<string> = new Set(CREDENTIAL_ROUTING_ENV_KEYS);

/**
 * True when `name` decides where a credential is sent or who can read it.
 *
 * Companion to {@link isSecretEnvKey}: that one rejects names that would *hold*
 * a secret, this one rejects names that would *redirect* it.
 */
export function isCredentialRoutingEnvKey(name: string): boolean {
  return CREDENTIAL_ROUTING_ENV_KEY_SET.has(name.toUpperCase());
}
