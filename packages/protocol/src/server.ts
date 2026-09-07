/**
 * The Artemis server: what it is, and what it says on the wire.
 * ============================================================================
 *
 * Artemis holds something no other program on the machine can get at: a set of
 * *accounts* — profiles — each entered through its own config directory, each
 * with its own plan, its own catalogue and its own capabilities. Everything in
 * this app has been built to use them from inside a window. This file is the
 * beginning of the other half: a local HTTP server that lets **other programs**
 * use them too, the way LM Studio's server lets any OpenAI client reach a model
 * that is really a file on the disk.
 *
 * That makes Artemis a *router*. A profile plus a model is a route, other
 * programs address it by name, and Artemis decides which account actually runs
 * the turn.
 *
 * ---------------------------------------------------------------------------
 * TWO SURFACES, AND WHY BOTH
 * ---------------------------------------------------------------------------
 *
 * `/v1/*` is OpenAI's shape, because that is the only shape the ecosystem
 * already speaks: an editor extension, a script, an SDK and a `curl` all know
 * `GET /v1/models` and none of them know anything about Artemis. It is the
 * front door, and it is deliberately dumb — an id, an object type, an owner.
 *
 * `/api/{@link SERVER_API_VERSION}/*` is Artemis's own, because OpenAI's schema
 * has nowhere to put the facts that make this app worth routing through. A
 * model here is not just an id: it belongs to an *account*, it accepts a set of
 * *thinking levels* the provider named, and it may or may not accept fast mode
 * or ultracode. A caller that flattens all of that into `"gpt-4"` cannot ask
 * for high effort, and a caller that never sees `fastMode: false` will believe
 * a toggle took effect when the run ignored it — which is the same hazard
 * `ProviderModelOption.supportsFastMode` exists to prevent inside the app,
 * arriving now at a consumer we do not control.
 *
 * So: the compatible surface for reach, the native surface for truth. Neither
 * is a subset of the other, and a client is expected to use both — discover on
 * `/v1/models`, then ask `/api/v0/models` what the row it picked can actually
 * do.
 *
 * ---------------------------------------------------------------------------
 * A ROUTE IS `profile/model`, AND WHY IT IS NOT JUST A MODEL ID
 * ---------------------------------------------------------------------------
 *
 * `opus` is not addressable on its own here and never will be. Two profiles can
 * both offer it, on different plans, with different limits and different
 * entitlements — that is the entire reason profiles exist — so a bare model id
 * names two different things and Artemis would have to guess which account to
 * bill. The account is therefore *in the address*: `work-max/opus`.
 *
 * The left half is a slug derived from the profile's label rather than its
 * {@link ProfileId}, because the id is a random string and this is a name a
 * person types into a config file. Ids still work — see
 * {@link parseModelRoute} — so a caller that wants stability against a rename
 * can use one.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * A loopback port is not a private one. Every process on the machine can reach
 * it, and so can any web page you happen to have open, through a request the
 * browser is happy to send cross-origin. What is behind this port is the user's
 * *accounts* — the catalogue today, their spend tomorrow — so the server
 * refuses anything that does not present the bearer token Artemis generated,
 * with the single exception of {@link SERVER_HEALTH_PATH}, which answers
 * "yes, something is listening" and nothing else.
 */

import type { AuthStatusInfo } from './ipc.js';
import type { PlanUsage } from './usage.js';
import type { AgentEvent } from './events.js';
import type { ProfileId } from './ids.js';
import type { Capabilities, ProviderId, ProviderKind } from './provider.js';

/* -------------------------------------------------------------------------- */
/* Addresses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The version segment of the native API path.
 *
 * `v0` and not `v1`, and the zero is a promise rather than modesty: this shape
 * will change while the completions half is being built, and a client should
 * see that in the URL it typed rather than discover it when a field moves.
 */
export const SERVER_API_VERSION = 'v0';

/**
 * The interface the server binds.
 *
 * Not configurable, and that is the security posture rather than an oversight.
 * Binding `0.0.0.0` would put a user's accounts on whatever network they are
 * joined to — a café, a conference, an office VLAN — and the blast radius of a
 * mistake there is somebody else's turns billed to them. If this ever becomes a
 * setting it should arrive with its own warning surface, not as a text field.
 */
export const SERVER_HOST = '127.0.0.1';

/**
 * The default port.
 *
 * Chosen to sit clear of the neighbours this server will most often be run
 * beside — LM Studio on 1234, Ollama on 11434, llama.cpp on 8080 — because the
 * first thing a user does with a router is point it at the things it routes to.
 */
export const DEFAULT_SERVER_PORT = 6472;

/** Lowest port a user may choose. Below 1024 needs root on Unix; we do not ask. */
export const MIN_SERVER_PORT = 1024;

/** Highest port there is. */
export const MAX_SERVER_PORT = 65_535;

/**
 * The one path that answers without a token.
 *
 * It reports that a server is up and what version of Artemis it belongs to —
 * enough for a client to wait for the port and no more. It names no profile, no
 * model and no account, so an unauthenticated caller learns exactly what a
 * successful TCP connection already told them.
 */
export const SERVER_HEALTH_PATH = '/health';

/** `http://127.0.0.1:6472`, with no trailing slash. */
export function serverUrl(host: string, port: number): string {
  // IPv6 literals have to be bracketed or the port reads as another group.
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/** The separator between the account half of a route and the model half. */
const ROUTE_SEPARATOR = '/';

/**
 * Turn a profile's label into the left half of a route.
 *
 * Lowercase, ASCII, hyphen-separated — the shape a person can type from memory
 * and a shell will not mangle. Everything else collapses to a hyphen, because
 * the alternative is percent-encoding in a URL a human is expected to write.
 *
 * Returns an empty string for a label with nothing usable in it (an emoji, a
 * name in a script this crude transliteration cannot carry). That is a real
 * case and callers must handle it: {@link assignProfileSlugs} falls back to the
 * profile's id, which is always addressable.
 */
export function profileSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * One slug per profile, all of them distinct.
 *
 * Uniqueness is the whole job. Two profiles labelled "Work" and "work " both
 * slug to `work`, and a route that resolves to either of two accounts is a
 * route that bills the wrong one — so a collision is broken by appending `-2`,
 * `-3`, and so on.
 *
 * Order decides who keeps the bare slug, so the caller's order must be stable:
 * pass profiles in a fixed order (the store's own) and a given set of profiles
 * always produces the same map. A set that changes — a profile added, renamed
 * or deleted — *can* move a suffix, which is the honest cost of deriving names
 * from labels and the reason {@link parseModelRoute} also accepts ids.
 */
export function assignProfileSlugs(
  profiles: readonly { readonly id: ProfileId; readonly label: string }[],
): ReadonlyMap<ProfileId, string> {
  const taken = new Set<string>();
  const slugs = new Map<ProfileId, string>();

  for (const profile of profiles) {
    // An unslugabble label falls back to the id rather than to a generic name:
    // `profile-2` would be a lie the moment its neighbour is deleted.
    const base = profileSlug(profile.label) || profileSlug(profile.id) || 'profile';
    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) slug = `${base}-${suffix++}`;
    taken.add(slug);
    slugs.set(profile.id, slug);
  }

  return slugs;
}

/** `work-max` + `opus` → `work-max/opus`. */
export function modelRoute(profileSlugOrId: string, modelId: string): string {
  return `${profileSlugOrId}${ROUTE_SEPARATOR}${modelId}`;
}

/**
 * Split a route back into the account half and the model half.
 *
 * Splits on the **first** separator only, because a model id may legitimately
 * contain one — `library/llama3:8b` is an Ollama model, not a profile called
 * `library`. The account half never does: a slug is `[a-z0-9-]+` by
 * construction and a {@link ProfileId} has no slash in it either.
 *
 * Returns `undefined` for anything without both halves, including a bare model
 * id. That refusal is deliberate: see the file comment on why a model alone is
 * not an address.
 */
export function parseModelRoute(
  route: string,
): { readonly profile: string; readonly model: string } | undefined {
  const trimmed = route.trim();
  const cut = trimmed.indexOf(ROUTE_SEPARATOR);
  if (cut <= 0) return undefined;
  const profile = trimmed.slice(0, cut);
  const model = trimmed.slice(cut + 1);
  if (profile.length === 0 || model.length === 0) return undefined;
  return { profile, model };
}

/* -------------------------------------------------------------------------- */
/* The catalogue, as other programs see it                                    */
/* -------------------------------------------------------------------------- */

/**
 * One thinking level, on the wire.
 *
 * A copy of {@link ProviderEffortOption} rather than a re-export, because the
 * two are contracts with different audiences: that one is Artemis's internal
 * vocabulary and may be reshaped whenever the picker needs it to be, this one
 * is published to programs we do not ship and cannot recompile. They are
 * identical today and are allowed to stop being.
 */
export interface ServerThinkingLevel {
  /** What a caller sends. Opaque; compare it, do not parse it. */
  readonly id: string;
  /** Human-readable, e.g. "High". */
  readonly label: string;
  /** One line on what this level trades away. */
  readonly note: string;
}

/**
 * One routable model: an account, a model, and what the pair accepts.
 *
 * The three booleans are the reason this surface exists at all. Each says
 * whether a *setting* reaches the model or is silently dropped, and each is
 * false unless the adapter said otherwise — the same "absent means no" rule
 * {@link ProviderModelOption.supportsFastMode} states, made explicit here
 * because a JSON consumer cannot tell an absent field from a false one without
 * being told.
 */
export interface ServerModel {
  /** What goes in `model`: `work-max/opus`. Unique across the whole server. */
  readonly route: string;
  /** The provider's own id for the model, e.g. `opus`. Not unique on its own. */
  readonly id: string;
  /** Short name for dense chrome, e.g. "Opus 5". */
  readonly label: string;
  /** The provider's full name, when it publishes one. */
  readonly displayName?: string;
  /**
   * The concrete wire id an alias resolves to, e.g. `opus` → `claude-opus-5`.
   *
   * Published because a caller logging what it ran should be able to record the
   * model rather than the alias — the alias is a moving target by design.
   */
  readonly resolvedModel?: string;
  /** One line on what this model is for. */
  readonly note: string;

  /** The account this route runs as. */
  readonly profileId: ProfileId;
  /** The account's slug — the left half of {@link route}. */
  readonly profileSlug: string;
  /** The account's human name. */
  readonly profileLabel: string;
  readonly providerId: ProviderId;

  /**
   * Thinking levels valid on *this* model, least to most.
   *
   * Already narrowed by the model's own constraint: a provider offers five
   * levels and a given model may accept three of them, and it is the
   * intersection that is true here. Empty means the model takes no thinking
   * setting at all, which a caller must treat as "do not send one" rather than
   * as "send the default".
   */
  readonly thinkingLevels: readonly ServerThinkingLevel[];
  /**
   * The model decides its own depth, so a level is a hint rather than an
   * instruction. Informational: it explains why setting one may change nothing.
   */
  readonly adaptiveThinking: boolean;
  /** The model accepts fast mode. */
  readonly fastMode: boolean;
  /** The model accepts ultracode. */
  readonly ultracode: boolean;
  /** Where this sits in its provider's lineup, `0` being smallest. Absent means unknown. */
  readonly tier?: number;
}

/**
 * One account, with everything routable through it.
 */
export interface ServerProfile {
  readonly id: ProfileId;
  /** The left half of every route below. */
  readonly slug: string;
  readonly label: string;
  readonly provider: {
    readonly id: ProviderId;
    readonly label: string;
    /** `hosted` — an account — or `local` — an endpoint on this machine. */
    readonly kind: ProviderKind;
  };
  /**
   * The provider is usable in this build and on this machine.
   *
   * An unavailable account is still listed, with its reason, for the same
   * reason the profile screen greys one out rather than hiding it: a client
   * that cannot see the row cannot tell the user what to fix.
   */
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** The user hid this account from Artemis's own picker. */
  readonly disabled: boolean;
  /**
   * The account itself confirmed this catalogue, as opposed to it being the
   * adapter's built-in list.
   *
   * Published rather than smoothed over: a client showing a model that the
   * account may not actually have should be able to say so, exactly as the
   * settings screen does.
   */
  readonly live: boolean;
  /**
   * Whether this account's directory actually holds a credential.
   *
   * Not derivable from {@link live}, which is what the surfaces used to guess
   * from, and the guess was wrong in the direction that matters. `live` says
   * "the account confirmed this catalogue", and for a provider whose model
   * list needs no credential to enumerate — codex — a signed-out account
   * confirms a full list and reads as signed in. Every row then offers "Sign
   * in again" and the one account that could not run anything looked like all
   * the others.
   *
   * `loggedIn: false` is a successful read of a signed-out directory;
   * {@link AuthStatusInfo.error} is a failure to read at all. The two are kept
   * apart here for the reason they are kept apart everywhere else — a broken
   * CLI reported as "signed out" sends someone to a login that cannot work.
   *
   * Absent when this build did not ask. A server that cannot probe says
   * nothing rather than claiming everything is fine.
   */
  readonly auth?: AuthStatusInfo;
  /** What the provider behind this account can do. See {@link Capabilities}. */
  readonly capabilities: Capabilities;
  /**
   * The endpoint address this account talks to, for the ones that have one.
   *
   * Published so the administrative card can show what it would be editing —
   * an address is configuration, not a credential. The key it may pair with
   * never appears on any read.
   */
  readonly baseUrl?: string;
  readonly models: readonly ServerModel[];
}

/** The body of `GET /api/v0/profiles`. */
export interface ServerProfilesBody {
  readonly object: 'artemis.profiles';
  readonly profiles: readonly ServerProfile[];
}

/** The body of `GET /api/v0/models` — every route on the server, flattened. */
export interface ServerModelsBody {
  readonly object: 'artemis.models';
  readonly models: readonly ServerModel[];
}

/* -------------------------------------------------------------------------- */
/* Adding an account to a server, from somewhere else                         */
/* -------------------------------------------------------------------------- */

/**
 * Signing an account into a server you are not sitting in front of.
 * ============================================================================
 *
 * A headless Artemis serves profiles, and a profile is only worth serving once
 * an account has been signed into its config directory. On a desktop that is
 * one command in the user's own terminal. In a container it is a shell nobody
 * has — `docker exec` into a replica an orchestrator may replace, or a web
 * terminal that, served over plain HTTP, cannot even paste. The account that
 * makes the server useful is the one thing the deployment cannot install.
 *
 * These four routes are the way in, and the shape of them follows from one
 * fact about how OAuth CLIs behave with no browser to open: they print a
 * verification URL and then *read a code back on stdin*. Two values, one in
 * each direction, and both are things a person handles. So the server holds
 * the subprocess and the person holds the browser, wherever they are:
 *
 * ```
 *   POST   /api/v0/profiles                    create the account record
 *   POST   /api/v0/profiles/{id}/signin        start the CLI, watch its output
 *   GET    /api/v0/profiles/{id}/signin        what state is it in?
 *   POST   /api/v0/profiles/{id}/signin/code   the code the user pasted
 *   DELETE /api/v0/profiles/{id}/signin        give up, kill the subprocess
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT ON THIS WIRE
 * ---------------------------------------------------------------------------
 *
 * Two strings, and that is the whole of it: a URL the provider's CLI printed,
 * and a code the user typed. No token is parsed, forwarded, echoed or stored —
 * the CLI writes its own credential into its own config directory, exactly as
 * it does when a person runs it in a terminal, and nothing here ever reads that
 * directory except to ask the CLI whether it is now signed in.
 *
 * The code is never logged and never appears in an error. It is a
 * single-use secret in flight, and an error message that quoted it back would
 * put it in whatever collects errors on both ends.
 *
 * ---------------------------------------------------------------------------
 * WHY THE URL IS RENDERED AS TEXT AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * {@link ServerSignInStatus.verificationUrl} arrives from a subprocess on a
 * remote machine, and a client is about to put it in front of a user and invite
 * them to sign in at it. That is a phishing surface by construction. A client
 * should render it verbatim — no markdown, no HTML, no shortening, no
 * "helpfully" following a redirect — so that what the user judges is the
 * address they will actually visit.
 */

/**
 * Where one sign-in has got to.
 *
 * Four live states and four terminal ones, and the live ones are separate
 * because they ask different things of the person watching:
 *
 *  - **`starting`** — the CLI has been spawned and has said nothing yet. There
 *    is nothing for the user to do but wait a second.
 *  - **`awaiting_browser`** — a verification URL is known. The user's move: open
 *    it, wherever they are.
 *  - **`awaiting_code`** — the CLI has asked for the code on stdin. The user's
 *    move: paste what the provider gave them.
 *  - **`completing`** — a code has been written to the subprocess and it has not
 *    exited yet. Nothing to do; do not send another.
 *
 * `awaiting_browser` and `awaiting_code` are told apart by reading the CLI's
 * output, which is a heuristic and is documented as one — a server that never
 * recognises the prompt still accepts the code, because refusing a correct code
 * over an unrecognised prompt string would strand the flow with no way out.
 *
 * **`completing` can go back to `awaiting_code`,** and that is the one edge in
 * this machine that is not one-way. A CLI that does not like the code it was
 * given says so and asks again rather than exiting — a code copied without its
 * last character is the ordinary case — so a rejection returns the flow to
 * `awaiting_code` with {@link ServerSignInStatus.codeError} set. Only the
 * subprocess *exiting* settles anything, and what settles it is the config
 * directory, never the exit code.
 *
 * The four terminal states are distinct because each has a different next step:
 * `done` is finished, `failed` can be retried and says why, `cancelled` is the
 * user's own doing, and `expired` means the server killed a subprocess nobody
 * had come back to — a browser tab left open over lunch.
 */
export type ServerSignInState =
  | 'starting'
  | 'awaiting_browser'
  | 'awaiting_code'
  | 'completing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** Every state, for a client that wants to check one it was handed. */
export const SERVER_SIGN_IN_STATES: readonly ServerSignInState[] = [
  'starting',
  'awaiting_browser',
  'awaiting_code',
  'completing',
  'done',
  'failed',
  'cancelled',
  'expired',
];

/**
 * Is this sign-in over?
 *
 * The predicate a poller stops on and the server refuses a second start
 * against. One definition, because "which states are finished" written twice is
 * a client that keeps polling a flow the server has already forgotten.
 */
export function isSignInSettled(state: ServerSignInState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled' || state === 'expired';
}

/**
 * What the account says about itself once it is in.
 *
 * A copy of the fields the provider's status probe reports, not a credential
 * and not a handle to one. Present so a client can show *which* account landed
 * — two of them look identical otherwise, and signing the wrong one in is the
 * mistake this surface makes easiest.
 */
export interface ServerSignInAccount {
  /** `claude.ai` for a subscription, `console` for API billing. */
  readonly authMethod?: string;
  readonly email?: string;
  readonly orgName?: string;
  readonly subscriptionType?: string;
}

/**
 * One sign-in, as `GET /api/v0/profiles/{id}/signin` reports it.
 *
 * Every route on this surface answers with this same shape — start, poll,
 * submit and cancel alike — so a client has one thing to render and can never
 * hold two disagreeing pictures of the same flow.
 */
export interface ServerSignInStatus {
  readonly object: 'artemis.signin';
  readonly profileId: ProfileId;
  readonly state: ServerSignInState;
  /**
   * The address the user must open, exactly as the CLI printed it.
   *
   * Absent until the CLI has printed one. See the section comment on why a
   * client renders this as plain text.
   */
  readonly verificationUrl?: string;
  /**
   * A short code the provider showed, when it shows one.
   *
   * Not the code the *user* sends back — that one travels in the other
   * direction and is never reported here. This is the "check that the browser
   * shows this" confirmation some device flows print, and it is absent for the
   * providers that do not.
   */
  readonly userCode?: string;
  /**
   * The CLI would not take the last code, and is asking for another.
   *
   * Distinct from {@link error}, and the distinction is the whole point: this
   * is a *retry*, not a failure. A mistyped or half-copied code is the most
   * common thing that goes wrong in this flow, the CLI stays alive and asks
   * again, and a client that rendered the rejection as a terminal error would
   * tear down a sign-in that is still perfectly good. Set alongside
   * `state: 'awaiting_code'`, and cleared the moment another code is sent.
   *
   * The provider's own sentence, scrubbed and capped — it is the only source
   * that knows *why* the code was refused (wrong, truncated, expired).
   */
  readonly codeError?: string;
  /** Why it failed. Set only in `failed`, and never quotes the submitted code. */
  readonly error?: string;
  /** Set once `state` is `done`. */
  readonly account?: ServerSignInAccount;
  /**
   * The loopback port the provider's login serves its OAuth on, while the
   * flow is live.
   *
   * Present only for providers whose login runs a local web server (Codex's
   * `localhost:1455`). The serving Artemis proxies that port under
   * `…/signin/oauth/`, and a client that can should listen on the same local
   * port and forward — the URL the CLI printed then works verbatim on the
   * machine where the person is.
   */
  readonly loopbackPort?: number;
  /** Epoch ms the subprocess was spawned. */
  readonly startedAt: number;
  /**
   * Epoch ms at which an unfinished sign-in is killed and reported `expired`.
   *
   * Published rather than kept private because the client is the thing with a
   * person in front of it: a countdown, or at least a sentence, beats a flow
   * that silently stops working while somebody is still reading their email.
   */
  readonly expiresAt: number;
}

/** The body of `POST /api/v0/profiles` — the account that was just created. */
export interface ServerProfileCreatedBody {
  readonly object: 'artemis.profile';
  readonly id: ProfileId;
  readonly label: string;
  readonly providerId: ProviderId;
  /**
   * Where the provider's CLI will write this account's credential, on the
   * *serving* machine.
   *
   * Reported because it is the one fact a person needs in order to finish the
   * job by hand if this surface cannot: it is the value of `CLAUDE_CONFIG_DIR`
   * in the command they would run inside the container.
   */
  readonly configDir: string;
}

/** The body of `POST /api/v0/profiles/{id}/signin/code`. */
export interface ServerSignInCodeRequest {
  /** What the provider's page gave the user. Written to the CLI's stdin, once. */
  readonly code: string;
}

/** The body of `POST /api/v0/profiles`. */
export interface ServerCreateProfileRequest {
  readonly label: string;
  /** Defaults to `claude`, the only provider whose login this surface drives today. */
  readonly provider?: ProviderId;
}

/**
 * One stored server conversation, as `GET /api/v0/sessions` reports it.
 *
 * Only conversations *this connection's pin created* appear — the server's
 * session surface is scoped to the token that asks, and the serving user's
 * own desktop history is structurally invisible to it. See the ledger in
 * `@rx-artemis/core` for the rule.
 *
 * Ids here are the provider's own session ids — the same value a completions
 * call carries in `artemis.sessionId` to continue the conversation — so a
 * client can go from this list straight to a resume with no mapping step.
 */
export interface ServerSessionSummary {
  readonly id: string;
  /** Best available label, resolved the way the desktop sidebar's is. */
  readonly title: string;
  /** The opening message, when the store kept one. */
  readonly firstPrompt?: string;
  /** Epoch ms of the last activity the store recorded. */
  readonly updatedAt: number;
  /** The serving profile's slug — the same value model routes carry. */
  readonly profileSlug: string;
  /**
   * The account's stable id, and the provider it belongs to.
   *
   * Carried beside the slug rather than instead of it, because the two answer
   * different questions: the slug is an *address* a person types, and these are
   * what a client keys on. A remote sidebar has to group rows by account and
   * resume them under the right one, and a slug can come to mean a different
   * account after a rename — the same hazard {@link ServerAllowance} exists to
   * avoid. Both are already inside this connection's own catalogue, so naming
   * them here discloses nothing it could not already read.
   *
   * **Optional on the wire**, because a client may be talking to a server older
   * than this field. A newer client against an older server must degrade to
   * "which account this was is unknown" — which the sidebar can render — rather
   * than either dropping every row or casting `undefined` into a branded id and
   * carrying the lie forward. Any server that fills these fills both.
   */
  readonly profileId?: string;
  readonly providerId?: string;
  /**
   * The provider's own tag on this conversation, when it has one.
   *
   * What archiving is built on: `POST …/sessions/{id}/tag` writes it and this
   * is how it is read back. Without it the write lands in the store and no
   * client can ever see that it did — a session archives and reappears
   * unarchived on the next listing, which is exactly the bug this closes.
   * Passed through untouched, like every other reader of the field: Artemis
   * writes {@link ARCHIVED_TAG} and a tag set from the provider's own CLI is
   * not Artemis's to reinterpret.
   */
  readonly tag?: string;
  /** Where the conversation ran, on the serving machine. */
  readonly cwd: string;
  /**
   * Who started it: a program borrowing the account, or the user's own remote
   * bridge. Absent means `program` — see the core ledger's `origin`.
   */
  readonly origin?: 'program' | 'bridge';
}

/** Body of `GET /api/v0/sessions`. */
export interface ServerSessionsBody {
  readonly object: 'artemis.sessions';
  readonly sessions: readonly ServerSessionSummary[];
}

/**
 * Body of `GET /api/v0/sessions/{id}/messages`.
 *
 * `events` are the same provider-agnostic `AgentEvent`s a live run emits —
 * one rendering path on the client, not two. They are stamped with a
 * server-side replay run id; a consumer re-stamps them into whatever
 * transcript it is building.
 */
export interface ServerSessionMessagesBody {
  readonly object: 'artemis.session.messages';
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
}

/**
 * Body of `GET /api/v0/usage`.
 *
 * One row per account this connection can see whose provider reports plan
 * capacity. Served from a short cache on purpose: the reading costs a CLI
 * control call per account, and a gauge is allowed to be a minute old.
 */
export interface ServerUsageBody {
  readonly object: 'artemis.usage';
  readonly accounts: readonly {
    readonly profileId: ProfileId;
    readonly label: string;
    readonly usage: PlanUsage;
  }[];
}

/**
 * Body of `POST /api/v0/sessions/{id}/rename`.
 *
 * Carries the title as *stored* — trimmed and length-capped by the serving
 * side — because the client shows the caller what the store now says, and
 * that answer has to come from whoever did the storing.
 */
export interface ServerSessionRenamedBody {
  readonly object: 'artemis.session.renamed';
  readonly title: string;
}

/**
 * Body of `DELETE /api/v0/sessions/{id}`.
 *
 * `deleted` is false when there was nothing left to remove — "already gone
 * is not an error", the same rule the adapter surface states.
 */
export interface ServerSessionDeletedBody {
  readonly object: 'artemis.session.deleted';
  readonly deleted: boolean;
}

/** Body of `POST /api/v0/sessions/{id}/tag`. False when nothing was there to tag. */
export interface ServerSessionTaggedBody {
  readonly object: 'artemis.session.tagged';
  readonly tagged: boolean;
}

/** One row of `GET /v1/models`, in OpenAI's shape. */
export interface OpenAiModel {
  /** The route. What a caller puts in `model`. */
  readonly id: string;
  readonly object: 'model';
  /** Seconds since the epoch. Artemis reports when the server started. */
  readonly created: number;
  /** The account's slug, which is the closest thing here to an owner. */
  readonly owned_by: string;
}

/** The body of `GET /v1/models`. */
export interface OpenAiModelList {
  readonly object: 'list';
  readonly data: readonly OpenAiModel[];
}

/**
 * An error, in the shape OpenAI clients already unwrap.
 *
 * Used on both surfaces rather than only on `/v1`, because a client that has
 * learned one error shape from this server should not meet a second one by
 * changing path.
 */
export interface ServerErrorBody {
  readonly error: {
    readonly message: string;
    /** `invalid_request_error`, `authentication_error`, `server_error`. */
    readonly type: string;
    /** Machine-readable, e.g. `model_not_found`. */
    readonly code?: string;
  };
}

/** The body of `GET /health`. Deliberately says nothing about accounts. */
export interface ServerHealthBody {
  readonly object: 'artemis.health';
  readonly status: 'ok';
  /** Artemis's own version, so a client can branch on the API it will get. */
  readonly version: string;
  /** The native API version this build serves, i.e. {@link SERVER_API_VERSION}. */
  readonly api: string;
}

/* -------------------------------------------------------------------------- */
/* Connections: who is calling, and where their turns run                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a connection's turns run.
 *
 * Three kinds, and the middle one is the reason this is a union rather than an
 * optional path. "No directory" is not one state, it is two, and they are as
 * different from each other as either is from a real folder:
 *
 * - **`directory`** — a folder the user picked. The agent reads and writes
 *   there, and that grant was made deliberately in the Server tab.
 *
 * - **`ephemeral`** — a scratch directory Artemis creates and deletes. The
 *   agent still *works*: it has somewhere to write a file, run a build, unpack
 *   something. Nothing it does survives, and none of it lands in the user's
 *   projects. This is the right default for a program that only wants to talk
 *   to a model — a summariser, a classifier, a chat UI — and it is what the
 *   ChatGPT and Claude APIs implicitly give you, where no working directory
 *   exists at all.
 *
 * - **`none`** — cannot run turns; the catalogue and nothing else. A minimal
 *   grant for a program that only needs to know which models exist: a picker, a
 *   dashboard, a script choosing a route. Handing that program write access to
 *   a directory in order to let it ask a question would be absurd.
 *
 * ## What `ephemeral` does and does not promise
 *
 * It promises the agent starts somewhere disposable and that Artemis removes it
 * afterwards. It does **not** promise the agent cannot reach the rest of the
 * disk — an agent with a shell can always `cd` elsewhere, and confinement is a
 * separate mechanism (`ProviderDescriptor.sandbox`, and the provider's own
 * permission modes). Saying "ephemeral means it cannot touch my files" would be
 * the kind of half-true safety claim this codebase refuses to make elsewhere,
 * so it is not made here either: the honest sentence is *nothing it writes in
 * its working directory is kept*.
 */
export type ServerWorkspace =
  | {
      readonly kind: 'directory';
      /** Absolute path. The agent reads and writes here. */
      readonly path: string;
    }
  | {
      readonly kind: 'ephemeral';
      /**
       * Keep one scratch directory per conversation rather than per turn.
       *
       * On by default, and the default matters: a turn that writes a file and a
       * follow-up turn that reads it are one conversation, and a fresh
       * directory between them would make the agent's own work vanish
       * mid-thought. Off means every turn starts empty.
       */
      readonly perSession?: boolean;
    }
  | { readonly kind: 'none' };

/** The workspace a new connection gets unless the user says otherwise. */
export const DEFAULT_WORKSPACE: ServerWorkspace = { kind: 'ephemeral', perSession: true };

/**
 * Fill in a workspace's defaults, so every stored one has the same shape.
 *
 * `perSession` is documented as "on unless set to false", and that default was
 * originally applied in three places — the IPC validator, the config reader and
 * the create path — which is three chances to disagree. One of them did: a
 * connection created in memory kept `perSession: undefined` while an identical
 * one loaded from disk had `true`, so the same grant compared unequal to itself
 * across a restart. This is the single definition all three now call.
 */
export function normalizeWorkspace(workspace: ServerWorkspace): ServerWorkspace {
  return workspace.kind === 'ephemeral'
    ? { kind: 'ephemeral', perSession: workspace.perSession !== false }
    : workspace;
}

/** Can a turn run at all in this workspace? */
export function workspaceCanRunTurns(workspace: ServerWorkspace): boolean {
  return workspace.kind !== 'none';
}

/**
 * One line naming a workspace, for a settings row or a client's own UI.
 *
 * `summarise`, not `describe`, because `@rx-artemis/core` already exports a
 * `describeWorkspace` that answers a different question about a different thing
 * — what a *folder on disk* is called, repository or plain directory. Two
 * exported functions of one name, in two packages a consumer routinely imports
 * together, is a collision waiting for whoever writes that import.
 */
export function summariseWorkspace(workspace: ServerWorkspace): string {
  switch (workspace.kind) {
    case 'directory':
      return workspace.path;
    case 'ephemeral':
      return 'Scratch space, deleted afterwards';
    case 'none':
      return 'Catalogue only — cannot run turns';
  }
}

/**
 * One program's access to this Artemis: a token, a workspace, and
 * optionally a restricted set of accounts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DIRECTORY BELONGS TO THE TOKEN
 * ---------------------------------------------------------------------------
 *
 * An Artemis turn is agentic — it reads files, edits them, runs commands — so
 * every turn needs a working directory, and something has to choose it. The
 * obvious place is the request, and that is the wrong place for two reasons.
 *
 * The first is whose decision it is. A path in the request means the *calling
 * program* decides which of the user's repositories an agent may edit, and the
 * user finds out afterwards. Binding it to the connection puts the decision in
 * the Server tab, where a person picks a folder with a native directory picker
 * before any program has run — the same shape as granting an app access to a
 * folder, which is a decision people already understand.
 *
 * The second is what a leaked token is worth. With a path in the request, one
 * token is authority over every directory on the machine. With the path on the
 * connection, a token is authority over *one folder*, and revoking it is
 * deleting one row rather than rotating the credential every other program is
 * also using.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LEAKED TOKEN IS WORTH, RESTATED FOR REMOTE CLIENTS
 * ---------------------------------------------------------------------------
 *
 * The paragraph above was written when a token could do exactly one thing: run
 * a turn in one folder and read the answer. A token can now also approve the
 * permission prompts those turns raise, steer a run mid-flight, and reattach to
 * a run whose original client has gone — see {@link ArtemisRemoteOptions} for
 * the completions surface, and the bridge's own routes for the other. Three
 * things bound that, and they are the reason the widening is not a widening of
 * *authority*:
 *
 *  1. **The folder is still the ceiling.** Approving a prompt approves a tool
 *     call the agent already proposed, inside the directory this connection is
 *     pinned to. There is no decision reachable from the wire that moves a run
 *     outside it, and on the completions surface none that changes the run's
 *     permission *mode* — approving a call one at a time is the whole of what a
 *     provider-style caller may do, and `bypassPermissions` is refused at the
 *     parser regardless of what else the request says.
 *  2. **Runs are owned, not addressable.** Every run started through this port
 *     belongs to the connection that started it; another token asking about it
 *     gets the same 404 as one asking about a run that never existed. A leaked
 *     token cannot enumerate, watch, or answer the prompts of anything but its
 *     own conversations.
 *  3. **Neither behaviour is on by default.** A request that does not ask for
 *     them keeps today's answers: a permission prompt is denied where nobody
 *     is present, and a disconnect ends the run.
 *
 * So the honest summary is unchanged in kind and larger in degree: a leaked
 * token is an agent running in one folder, and it is now an agent someone else
 * can also answer questions for. Revocation is still one deleted row, and it is
 * still the whole remedy.
 *
 * ---------------------------------------------------------------------------
 * A CONNECTION WITHOUT A DIRECTORY IS STILL USEFUL
 * ---------------------------------------------------------------------------
 *
 * {@link cwd} is optional, and absent means "can read the catalogue, cannot run
 * a turn". That is a real state rather than a half-configured one: a program
 * that only wants to know which models exist — a dashboard, a picker, a script
 * choosing a route — needs no directory at all, and should not be handed write
 * access to one in order to ask.
 */
export interface ServerConnection {
  /** Stable id, for revoking and for naming one in the UI. */
  readonly id: string;
  /** What the user called it: "Kronos", "scratch scripts". */
  readonly label: string;
  /**
   * Where this connection's turns run. See {@link ServerWorkspace}.
   *
   * **Chosen when the token is created and never changed after.** A connection
   * is re-scoped by issuing a new one and deleting this, which is a rule rather
   * than an inconvenience: a token whose authority can widen after it has been
   * handed to a program is a token nobody can reason about. Only the label is
   * editable, because a label grants nothing.
   */
  readonly workspace: ServerWorkspace;
  /**
   * Restrict this connection to specific accounts and models.
   *
   * Absent or empty means everything this Artemis has. Present means the
   * catalogue this connection sees is filtered to the allowance and anything
   * outside it is not merely refused but *invisible* — which is how a token for
   * a side project is stopped from spending the account with the real plan on
   * it, and from even discovering that account exists.
   *
   * See {@link ServerAllowance} for why this stores ids rather than routes.
   */
  readonly allow?: readonly ServerAllowance[];
  /**
   * This connection may add accounts to the server and sign them in.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS A SEPARATE GRANT AND NOT A CONSEQUENCE OF HOLDING A TOKEN
   * ---------------------------------------------------------------------------
   *
   * Every other authority a token carries is bounded by the folder it is pinned
   * to and the accounts it is allowed to see. This one is bounded by neither.
   * Signing an account into a server *creates* something the server did not
   * have — a credential in a config directory on the serving machine, which
   * every future run may spend — and the connection that created it is not the
   * connection that pays for it. That is an administrative act, and
   * administrative acts do not come free with a bearer token pasted into an
   * editor extension.
   *
   * So it is opt-in, absent by default, and granted one connection at a time:
   * the operator who deploys the server decides which single token belongs to
   * the person who administers it. A leaked editor token still cannot add an
   * account, and a server whose operator never granted this has the surface
   * switched off entirely — see {@link ServerConnectionInfo.manageProfiles}.
   *
   * What the grant does **not** widen is what Artemis itself touches. The
   * sign-in it authorises drives the *provider's* own CLI, which writes its own
   * credential into its own directory. The only things that cross this wire are
   * a verification URL the provider printed and a code the user typed into
   * their own browser. There is no path here by which Artemis reads, stores or
   * forwards a credential — see `signIn.ts` in `@rx-artemis/core`.
   */
  readonly manageProfiles?: boolean;
  /** The bearer token this connection authenticates with. */
  readonly token: string;
  /** Epoch ms. */
  readonly createdAt: number;
  /**
   * Epoch ms of the last request that presented this token, or absent if none
   * ever has.
   *
   * The one piece of per-connection traffic worth keeping, because it answers
   * the question that decides whether a token can be deleted: is anything still
   * using this? Deliberately not a request log — see {@link ServerTraffic}.
   */
  readonly lastUsedAt?: number;
  /**
   * Epoch ms after which this token stops working. Absent means it never does.
   *
   * ---------------------------------------------------------------------------
   * WHY EXPIRY IS A FIELD AND NOT A POLICY
   * ---------------------------------------------------------------------------
   *
   * A connection's authority is otherwise fixed for its whole life — the
   * workspace pin and the allowance cannot widen after the token is handed out,
   * which is what makes a token something a person can reason about. Time is the
   * one axis where the opposite is true: a token that *only* ever narrows, on a
   * schedule chosen when it was issued, is strictly safer than one that does
   * not, and the phase that made this worth adding is remote control. A bridge
   * token is carried to another machine by hand — typed into a Settings field on
   * a laptop, a borrowed desk, a machine at a client's office — and the thing
   * most likely to happen to it is not theft but *being forgotten*.
   *
   * Absent is the default and stays the default, because the alternative fails
   * in the worse direction: a token that silently stops working is
   * indistinguishable, from the client's side, from a server that went down, and
   * imposing that on every program-borrowing-an-account connection would be a
   * expiry nobody asked for. So it is chosen at creation, beside the workspace
   * and the allowance, and it is refused with a sentence that says *expired*
   * rather than a bare 401 — see the server's `resolveConnection`.
   *
   * Like the rest of a grant, it cannot be extended. A connection outliving its
   * usefulness is replaced, not renewed.
   */
  readonly expiresAt?: number;
}

/** Has this connection's expiry passed? Absent expiry never has. */
export function connectionHasExpired(connection: ServerConnection, now: number): boolean {
  return connection.expiresAt !== undefined && now >= connection.expiresAt;
}

/**
 * One account a connection may use, and which of its models.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IDS AND NOT ROUTES
 * ---------------------------------------------------------------------------
 *
 * The obvious shape for an allowlist is the same string a client sends:
 * `["work-max/opus"]`. It is also unsafe, and the reason is {@link profileSlug}.
 *
 * A route's left half is a *slug derived from a label*, and slugs are assigned
 * across the whole set — see {@link assignProfileSlugs}, where a collision is
 * broken by a numeric suffix. Rename an account, delete one, or add one that
 * collides, and `work-max` can come to mean a different account than it did
 * when the grant was written. A permission that silently re-points at another
 * account is the worst kind of permission bug: nothing errors, and the wrong
 * plan gets spent.
 *
 * So authorisation keys on {@link ProfileId}, which is stable for the life of
 * the account, and on the provider's own model id, which is stable for the life
 * of the model. Slugs stay what they always were — an *address*, for humans to
 * type — and are resolved to ids before anything is decided.
 */
export interface ServerAllowance {
  readonly profileId: ProfileId;
  /**
   * Model ids within that account, e.g. `opus`, `haiku`.
   *
   * Absent or empty means every model the account offers — including ones it
   * gains later. That is deliberate: a provider shipping a new model should not
   * silently widen a grant that named specific models, and should be available
   * to a grant that named none.
   */
  readonly modelIds?: readonly string[];
}

/**
 * A connection as a *client* sees itself — `GET /api/v0/connection`.
 *
 * The token is absent, and that is not an oversight: the caller already has it,
 * so echoing it back adds nothing and puts a credential in every response body,
 * every log and every proxy along the way.
 */
export interface ServerConnectionInfo {
  readonly id: string;
  readonly label: string;
  /** Where this connection's turns run. See {@link ServerWorkspace}. */
  readonly workspace: ServerWorkspace;
  /** What this connection may use. Absent means everything. */
  readonly allow?: readonly ServerAllowance[];
  /** False when the connection has no directory and so cannot run a turn. */
  readonly canRunTurns: boolean;
  /**
   * This connection may add accounts to the server and sign them in.
   *
   * Always present, and a boolean rather than an optional flag — unlike
   * {@link allow}, which is a *filter* whose absence means "unfiltered". This
   * is a capability line, in the same class as {@link canRunTurns}: a client
   * reads it to decide whether to draw a whole surface, and "the field was
   * missing" and "the answer is no" must not be two things it has to tell
   * apart. An older server that has never heard of the grant sends neither, and
   * a client reading `=== true` lands on the safe answer either way.
   */
  readonly manageProfiles: boolean;
  /**
   * Epoch ms this token stops working, when it has one. Absent means never.
   *
   * Told to the client rather than merely enforced, because the difference
   * between a remote window that says "this connection expires on Friday" and
   * one that simply stops working on Friday is the difference between a warning
   * and an outage. It leaks nothing: the holder of the token is the only one who
   * ever sees it, and they are entitled to know how long they have.
   */
  readonly expiresAt?: number;
}

/** Strip a connection down to what its own client may see. */
export function describeConnection(connection: ServerConnection): ServerConnectionInfo {
  return {
    id: connection.id,
    label: connection.label,
    workspace: connection.workspace,
    ...(connection.allow === undefined || connection.allow.length === 0
      ? {}
      : { allow: connection.allow }),
    canRunTurns: workspaceCanRunTurns(connection.workspace),
    manageProfiles: connection.manageProfiles === true,
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt }),
  };
}

/**
 * May this connection use this account at all?
 *
 * Absent or empty is "everything" rather than "nothing": a connection the user
 * never narrowed is unrestricted, and reading an empty allowance as a total
 * lockout would turn every such token into a dead one.
 */
export function connectionAllowsProfile(
  connection: ServerConnection,
  profileId: ProfileId,
): boolean {
  const allow = connection.allow;
  if (allow === undefined || allow.length === 0) return true;
  return allow.some((entry) => entry.profileId === profileId);
}

/**
 * May this connection use this model, on this account?
 *
 * The finer half of {@link connectionAllowsProfile}, and the two are separate
 * because the catalogue is filtered at two levels: an account the connection
 * cannot touch disappears entirely, while an account it can touch keeps only
 * the models it may run.
 */
export function connectionAllowsModel(
  connection: ServerConnection,
  profileId: ProfileId,
  modelId: string,
): boolean {
  const allow = connection.allow;
  if (allow === undefined || allow.length === 0) return true;

  const entry = allow.find((candidate) => candidate.profileId === profileId);
  if (entry === undefined) return false;
  // No model list means the whole account — including models it gains later.
  if (entry.modelIds === undefined || entry.modelIds.length === 0) return true;
  return entry.modelIds.includes(modelId);
}

/**
 * Narrow a catalogue to what a connection may see.
 *
 * One function rather than a filter written at each call site, because "hidden,
 * not merely refused" is a property the whole surface has to keep: a client that
 * can enumerate a route it cannot run will offer it to its user, who will get an
 * error nobody can explain. Accounts with nothing left after filtering are
 * dropped entirely rather than shown empty.
 */
export function visibleToConnection(
  connection: ServerConnection,
  profiles: readonly ServerProfile[],
): readonly ServerProfile[] {
  const allow = connection.allow;
  if (allow === undefined || allow.length === 0) return profiles;

  const narrowed: ServerProfile[] = [];
  for (const profile of profiles) {
    if (!connectionAllowsProfile(connection, profile.id)) continue;
    const models = profile.models.filter((model) =>
      connectionAllowsModel(connection, profile.id, model.id),
    );
    if (models.length === 0) continue;
    narrowed.push({ ...profile, models });
  }
  return narrowed;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle, as the settings tab sees it                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where the server is.
 *
 * `starting` and `stopping` are real states rather than optimism: binding a
 * port is asynchronous and can fail, and a socket with a client attached does
 * not close instantly. A UI that only had on and off would show "on" for a
 * server that was about to report `EADDRINUSE`.
 */
export type ServerPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** Why the server is not running. */
export interface ServerFault {
  /**
   * `port_in_use` and `permission_denied` are called out because they are the
   * two the user can actually fix, and each has a different fix — change the
   * number, or choose one above 1024.
   */
  readonly code: 'port_in_use' | 'permission_denied' | 'unknown';
  readonly message: string;
}

/**
 * What the server has been asked to do, so the tab can show traffic.
 *
 * Counters rather than a log. A log of requests would be the most interesting
 * thing on the pane and also a record of which accounts a program is reading,
 * pushed into every open window and retained for as long as the app runs; the
 * counters answer the only question the pane actually has — "is anything
 * talking to this?" — and retain nothing that says what was asked.
 */
export interface ServerTraffic {
  /** Requests answered, successfully or not. */
  readonly total: number;
  /** Requests refused for a missing or wrong token. A non-zero count is worth noticing. */
  readonly rejected: number;
  /** Epoch ms of the most recent request, or absent if there has been none. */
  readonly lastAt?: number;
}

/**
 * The whole of the server's state, as one value.
 *
 * One shape for the pull channel and the push channel, so a window that
 * reloaded and a window that was listening cannot end up rendering different
 * things. The same discipline `UpdateState` keeps.
 */
export interface ServerState {
  readonly phase: ServerPhase;
  /** Always {@link SERVER_HOST} today. Carried so the tab does not hard-code it. */
  readonly host: string;
  /** The port the user asked for. `0` means "any free port". */
  readonly port: number;
  /** The port actually bound. Absent unless running — and it differs from {@link port} when that was `0`. */
  readonly boundPort?: number;
  /** `http://127.0.0.1:6472`. Absent unless running. */
  readonly url?: string;
  /** Start the server when Artemis launches. */
  readonly autoStart: boolean;
  /**
   * Every connection, each with its own token and working directory.
   *
   * These are the one credential in the app that travels *to* the renderer on
   * purpose. They are not account secrets: Artemis generated them, each
   * authenticates nothing except this port, and deleting one costs a click. The
   * tab has to show them because the user's next step is pasting one into
   * another program's configuration.
   *
   * A server with no connections is reachable by nobody, which is the correct
   * behaviour rather than an edge case: there is no ambient credential, so
   * "running" and "usable" are separate states and the pane says so.
   */
  readonly connections: readonly ServerConnection[];
  /** Epoch ms the current listen began. Absent unless running. */
  readonly startedAt?: number;
  readonly traffic: ServerTraffic;
  /** Why it stopped or would not start. Absent when there is nothing wrong. */
  readonly lastError?: ServerFault;
}

/* -------------------------------------------------------------------------- */
/* Running a turn: how Artemis's knobs ride on an OpenAI-shaped request        */
/* -------------------------------------------------------------------------- */

/**
 * The extra body field an OpenAI-shaped request carries to reach Artemis's own
 * settings.
 *
 * ## Why a namespace instead of top-level fields
 *
 * `POST /v1/chat/completions` is OpenAI's schema, and Artemis has three
 * settings that schema has no place for: which thinking level to use, and
 * whether to engage fast mode or ultracode. Three ways to carry them were
 * possible and only one is safe:
 *
 *  1. **Top-level `fast_mode`, `ultracode`.** They would sit beside OpenAI's
 *     own fields, in a namespace OpenAI owns and extends. The day OpenAI ships
 *     a field of the same name with different semantics, every stored request
 *     in the world silently changes meaning.
 *  2. **Reuse `reasoning_effort`.** Tempting, and half-right — the *concept*
 *     matches. The values do not: OpenAI's is a fixed enum, while an Artemis
 *     level is a provider's own vocabulary and can be `xhigh`, `max`, or
 *     something a provider ships next year. Squeezing one into the other means
 *     either lying about the value or losing levels.
 *  3. **One namespaced object**, which is this. It cannot collide, it carries
 *     provider vocabulary unflattened, and a client that does not know about it
 *     omits it and gets defaults.
 *
 * `reasoning_effort` is still *accepted* as an alias for {@link thinking} — see
 * `readChatExtensions` — because an off-the-shelf client that already sets it
 * meant exactly what this field means, and refusing that would be pedantry.
 *
 * ## Asking is not getting
 *
 * Every field here is a request. A provider may decline fast mode (no
 * entitlement, a cooldown), and a model that does not advertise a setting
 * ignores it. That is why {@link ServerModel} publishes what each route
 * accepts: a caller is expected to check *before* sending, because a setting
 * that is accepted and dropped is worse than one refused.
 */
export interface ArtemisChatExtensions {
  /**
   * A thinking level from the target model's {@link ServerModel.thinkingLevels}.
   *
   * Not validated against a fixed list here — the valid set is a property of the
   * model, published per route. Sending one the model does not accept is an
   * error rather than a silent drop; see {@link CHAT_EXTENSIONS_FIELD}.
   */
  readonly thinking?: string;
  /** Trade reasoning depth for latency. Only on routes with `fastMode: true`. */
  readonly fastMode?: boolean;
  /** Spend materially more compute. Only on routes with `ultracode: true`. */
  readonly ultracode?: boolean;
  /**
   * Continue an earlier conversation. Absent starts a new one.
   *
   * The only piece of turn state a caller supplies, and it exists because
   * OpenAI's `messages` array cannot carry it — see the `openai` module on why
   * a request is a turn rather than a transcript.
   */
  readonly sessionId?: string;
  /**
   * What this caller is: a script that will wait for the reply, or a person at
   * the other end of a network. See {@link ArtemisRemoteOptions}.
   */
  readonly remote?: ArtemisRemoteOptions;
  /**
   * The permission mode the run should open in.
   *
   * A request, like everything else here: the serving side honours it only
   * insofar as the account's own provider supports the mode, and drops it
   * otherwise — the old behaviour, where a run opens in the serving user's
   * setting. Carrying it grants a caller nothing it did not have: a client
   * that answers remote permission prompts can already approve every one,
   * so even the widest mode is a convenience, not a capability.
   */
  readonly permissionMode?: string;
  /**
   * Standing instructions to append to the run's system prompt.
   *
   * Composed on the *client* — the machine that has the prompt library and
   * knows this machine's memory banks — and carried here so a served run reads
   * the same conventions a local one would. It is appended on top of the
   * serving provider's own preset, never a replacement: a caller cannot displace
   * the coding-agent instructions the provider relies on to use its tools.
   *
   * A request, like everything else here. An older server drops the field, so a
   * newer client degrades to a run with no standing instructions rather than
   * failing — exactly what a server that never had them does today. Carrying it
   * grants the caller nothing new: it is the caller's own text, applied to the
   * caller's own run, and bounded in size where the request is validated.
   *
   * Honoured only where the serving account's provider can append to its
   * preset — `ServerProfile.capabilities.systemPromptAppend`, which the
   * catalogue publishes per account. Elsewhere (Codex, OpenCode) it is dropped
   * and named in `artemis.ignored` as `artemis.systemPrompt`, because an
   * instruction the model never read is worse silent than absent: the client
   * would believe it was heard.
   *
   * Not the place for text about the *client's* machine. The memory-bank
   * prompt names this machine's banks and this machine's paths, and a served
   * run executes on the server, which describes its own banks itself; the
   * desktop keeps that built-in off this field and sends only the user's own
   * prompts.
   */
  readonly systemPrompt?: string;
}

/**
 * The two promises the server will only make to a caller that asks for them.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH ARE OPT-IN AND NEITHER IS A DEFAULT
 * ---------------------------------------------------------------------------
 *
 * Every other field in {@link ArtemisChatExtensions} is a *setting for the
 * run*. These two are statements about **the client**, and they change what
 * happens when the client stops being there — which is the one thing a server
 * cannot infer. A shell script piping `curl` into `jq` and a phone on a train
 * present identically at the socket, and the right answer for each is the
 * opposite of the right answer for the other:
 *
 *  - The script's socket closing means the user pressed `^C`. Killing the run
 *    is correct; leaving an agent editing their repository with nobody reading
 *    the output is not.
 *  - The phone's socket closing means a tunnel went down or a laptop lid shut.
 *    Killing the run throws away work the user is coming back for.
 *
 * The same fork governs permission prompts. A script cannot answer one, so the
 * server's standing answer — deny, with a sentence the model can route around —
 * is the only safe one. A remote *client* can answer one, but only if the
 * request is put in front of it and the run is left parked long enough for a
 * human to look, which is a promise worth nothing to the script and everything
 * to the person.
 *
 * So the caller declares which it is, and a caller that declares nothing gets
 * the behaviour every existing client already depends on. Neither field is
 * ever inferred from the request's shape: a streaming request from a browser is
 * indistinguishable from a streaming request from CI.
 *
 * These govern the *completions* surface only. The remote bridge
 * (`remote.ts`) is a different contract with a different client — a window,
 * not a provider adapter — and it makes both promises unconditionally because
 * there is no version of that client which is a script.
 */
export interface ArtemisRemoteOptions {
  /**
   * Survive the client going away.
   *
   * With this set, a disconnect **detaches** the run instead of interrupting
   * it: the agent keeps working, its events keep accumulating in the run's
   * replay buffer, and the client reattaches with
   * `GET /api/v0/runs/{runId}/events?afterSeq=…` when it comes back. An
   * explicit `POST /api/v0/runs/{runId}/interrupt` still stops it — detaching
   * changes what a *silence* means, never what a decision means.
   *
   * A detached run does not live forever: the server reaps one that nobody has
   * come back for, so a client that never returns cannot pin a provider process
   * indefinitely. See `ARTEMIS_DETACHED_RUN_TTL_MS` on the server.
   */
  readonly detach?: boolean;
  /**
   * Put permission requests on the wire instead of denying them.
   *
   * With this set, a `permission.request` is emitted to the client — on the
   * stream, in the Artemis namespace — and the run parks exactly as it would
   * in the desktop app, until the client answers with
   * `POST /api/v0/runs/{runId}/permission`. Unanswered requests are denied
   * after a deadline rather than parking forever, because the provider process
   * is blocked for as long as one is open.
   *
   * Setting this on a client that cannot render a prompt is worse than leaving
   * it off: the run stalls for the whole deadline where it would have been told
   * "no" immediately and carried on.
   */
  readonly permissions?: boolean;
}

/*
 * NOTE: there is deliberately no `cwd` here.
 *
 * There was, briefly, and it was wrong: it let the *calling program* choose
 * which of the user's directories an agent could edit, and the user found out
 * afterwards. The working directory is a property of the connection, chosen by
 * a person when the token is created — see {@link ServerWorkspace}. A field here
 * would be a way around that decision, which is the whole thing the connection
 * model exists to prevent.
 */

/**
 * The body field {@link ArtemisChatExtensions} travels in: `artemis`.
 *
 * Named once, here, so the server's parser and every client agree. OpenAI
 * clients pass unknown body fields through — the JS SDK and the Python SDK both
 * do — which is what makes a namespaced extension work with off-the-shelf
 * tooling rather than requiring a custom HTTP layer.
 */
export const CHAT_EXTENSIONS_FIELD = 'artemis';

/**
 * Pull Artemis's settings out of an OpenAI-shaped request body.
 *
 * Lives in protocol rather than in the server because the SDK builds what this
 * reads, and a parser that disagreed with its writer by one key name would fail
 * in the quietest possible way: a request that looks accepted, runs, and ignores
 * every setting on it.
 *
 * Unknown keys inside the namespace are dropped rather than rejected, so a
 * newer client talking to an older server degrades instead of failing. The
 * *values* are type-checked, because a `thinking: 5` is a caller bug worth
 * surfacing rather than coercing.
 */
export function readChatExtensions(body: unknown): ArtemisChatExtensions {
  if (typeof body !== 'object' || body === null) return {};
  const record = body as Record<string, unknown>;

  const namespaced = record[CHAT_EXTENSIONS_FIELD];
  const extensions =
    typeof namespaced === 'object' && namespaced !== null
      ? (namespaced as Record<string, unknown>)
      : {};

  // The alias, and only as a fallback: a caller that set both meant the
  // namespaced one, which is the field that can express every level.
  const aliased = record['reasoning_effort'];
  const thinking =
    typeof extensions['thinking'] === 'string'
      ? (extensions['thinking'] as string)
      : typeof aliased === 'string'
        ? aliased
        : undefined;

  return {
    ...(thinking === undefined ? {} : { thinking }),
    ...(typeof extensions['fastMode'] === 'boolean'
      ? { fastMode: extensions['fastMode'] as boolean }
      : {}),
    ...(typeof extensions['ultracode'] === 'boolean'
      ? { ultracode: extensions['ultracode'] as boolean }
      : {}),
    ...(typeof extensions['sessionId'] === 'string'
      ? { sessionId: extensions['sessionId'] as string }
      : {}),
    ...(typeof extensions['permissionMode'] === 'string'
      ? { permissionMode: extensions['permissionMode'] as string }
      : {}),
    ...(typeof extensions['systemPrompt'] === 'string' && extensions['systemPrompt'].length > 0
      ? { systemPrompt: extensions['systemPrompt'] as string }
      : {}),
    ...readRemoteOptions(extensions['remote']),
  };
}

/**
 * The remote block, present only when it says something.
 *
 * Absent rather than `{}` when nothing in it parsed, and that distinction is
 * load-bearing rather than tidy: everything downstream reads
 * `remote?.detach === true`, and a request that carried `remote: "yes"` or
 * `remote: { detach: 1 }` must arrive as a caller who asked for nothing — the
 * old behaviour, exactly — rather than as one who asked for something the
 * server then half-honoured. Same rule as every other field here: unknown keys
 * drop, wrong types drop, and a client that meant it sends a boolean.
 */
function readRemoteOptions(value: unknown): { remote?: ArtemisRemoteOptions } {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const remote: ArtemisRemoteOptions = {
    ...(typeof record['detach'] === 'boolean' ? { detach: record['detach'] } : {}),
    ...(typeof record['permissions'] === 'boolean'
      ? { permissions: record['permissions'] }
      : {}),
  };
  return Object.keys(remote).length === 0 ? {} : { remote };
}

/** A port a user may actually bind. See {@link MIN_SERVER_PORT}. */
export function isValidServerPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    // `0` is not a port but is a valid request: let the OS choose one.
    (port === 0 || (port >= MIN_SERVER_PORT && port <= MAX_SERVER_PORT))
  );
}
