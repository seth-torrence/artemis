/**
 * Providers and their capability descriptors.
 *
 * The whole point of this file is that Artemis's UI must never assume every
 * provider can do everything. Three planned providers have three completely
 * different transports:
 *
 *  - `claude`   — in-process Node library (`@anthropic-ai/claude-agent-sdk`)
 *  - `codex`    — subprocess speaking JSONL over stdio
 *  - `opencode` — a local HTTP server
 *
 * so the seam cannot be Claude-shaped. Every adapter publishes a
 * {@link Capabilities} descriptor up front, and the UI *degrades* against it:
 * hide the fork button when `forkSession` is false, fall back to
 * whole-message rendering when `partialMessages` is false, and so on.
 */

import type { PermissionMode } from './permissions.js';

/**
 * The set of agent backends Artemis can drive.
 *
 * Only `claude` is implemented today; the other two are declared here so the
 * seam is designed against three transports rather than retrofitted to them.
 */
export type ProviderId =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'lmstudio'
  | 'ollama'
  | 'llamacpp'
  | 'artemis';

/** Every {@link ProviderId}, in display order. */
export const PROVIDER_IDS = [
  'claude',
  'codex',
  'opencode',
  'lmstudio',
  'ollama',
  'llamacpp',
  'artemis',
] as const satisfies readonly ProviderId[];

/** Runtime type guard for {@link ProviderId}. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * What a provider can actually do.
 *
 * Adapters return this from `ProviderAdapter.capabilities`. It is a *static*
 * descriptor: it must not change over the lifetime of an adapter instance, so
 * the renderer can cache it and render a stable UI.
 *
 * The first six fields are the contract every provider must answer. The
 * remaining fields are additive and exist because the UI provably needs them
 * to degrade correctly; adapters must still fill them in explicitly.
 */
export interface Capabilities {
  /**
   * The provider can pause mid-run and ask the user to approve a tool call,
   * emitting `permission.request` and waiting for `respondToPermission()`.
   *
   * When false the UI must not render an approval surface at all — the
   * provider decides on its own and the run never blocks.
   */
  readonly interactivePermissions: boolean;

  /**
   * The provider streams token-level deltas (`text.delta` / `thinking.delta`)
   * as the model produces them.
   *
   * When false the adapter emits only `text.complete`, and the UI should show
   * a working indicator instead of a typewriter.
   */
  readonly partialMessages: boolean;

  /**
   * `Run.send()` may be called while the run is still working, queueing the
   * text into the in-flight turn.
   *
   * When false the composer must be disabled until `run.end` arrives.
   */
  readonly midRunSteering: boolean;

  /**
   * A past session can be branched into a new one, leaving the original
   * transcript intact.
   */
  readonly forkSession: boolean;

  /**
   * `ProviderAdapter.listSessions()` is implemented. When false the adapter's
   * `listSessions` property is absent and the history pane is hidden for this
   * provider.
   */
  readonly listSessions: boolean;

  /**
   * The provider can delegate to nested subagents, so tool events may carry
   * `agentId` / `parentToolCallId` and the UI should render nesting.
   */
  readonly subagents: boolean;

  /**
   * A subagent's own conversation can be read back — the adapter's
   * `getSubagentMessages`.
   *
   * Separate from {@link subagents}, because delegating and being *legible*
   * are different powers. A provider can spawn agents whose work is only ever
   * summarised back into the parent transcript, which is exactly what makes
   * delegated work hard to follow: the parent sees the final report and none
   * of the reasoning, the tool calls or the failures behind it. This flag says
   * the work itself is on disk somewhere addressable, so a delegated row can
   * be opened into a readable conversation rather than only stopped.
   */
  readonly subagentTranscripts: boolean;

  /**
   * A stored session can be given a user-chosen title, which the provider
   * persists alongside the transcript — the adapter's `setSessionTitle`.
   *
   * Separate from {@link listSessions} because reading history and writing to
   * it are different powers: an adapter that can enumerate transcripts it did
   * not write has no obligation to be able to edit them.
   *
   * Note that `setSessionTitle` is *also* reached without consulting this flag,
   * by the automatic naming of a session from its first message. That is not an
   * inconsistency: a flag exists so the UI can degrade before calling, and
   * automatic naming has nothing to degrade — it renders no control and simply
   * does not happen. This flag is for the rename *menu item*, which does.
   */
  readonly renameSession: boolean;

  /**
   * A stored session can be destroyed — the transcript removed from disk, not
   * hidden.
   *
   * The UI treats this as irreversible and confirms before calling it, so an
   * adapter must not turn this on for a soft delete: something that claims to
   * delete and does not is worse than an absent menu item.
   */
  readonly deleteSession: boolean;

  /**
   * A stored session can carry a tag the provider keeps beside it.
   *
   * This is what archiving is built on, and the reason it is a *provider*
   * operation rather than a list of ids Artemis keeps. An archive held here
   * would be a fact about one installation: invisible to another build, absent
   * on another machine, and gone the moment the window's storage was reset —
   * all three of which happened. A tag lives with the session, so it is simply
   * true of the session wherever it is read from.
   *
   * `false` is an honest answer for a provider whose store has no such concept
   * — Codex threads and the local servers have none — and the Archive control
   * degrades and says so, exactly as it does for rename and delete.
   */
  readonly tagSession: boolean;

  /**
   * Permission modes this provider accepts in {@link RunInput.permissionMode}
   * and (if `midRunSteering`) mid-run. Empty means the concept does not apply.
   *
   * The mode picker must be built from this list, never from the full
   * {@link PermissionMode} union — providers support different subsets.
   */
  readonly permissionModes: readonly PermissionMode[];

  /**
   * A previous session can be continued in place (as opposed to forked).
   * Distinct from {@link forkSession}: a provider may support one, both or
   * neither.
   */
  readonly resumeSession: boolean;

  /**
   * A resumed session can be truncated to an earlier user message —
   * `RunInput.rewindToMessageId` is honoured rather than ignored. What the UI
   * gates the rewind and fork-from-here controls under a user turn on.
   */
  readonly rewind: boolean;

  /**
   * The provider reports token usage, so `usage` events carry meaningful
   * numbers and the UI can show a usage readout.
   */
  readonly usageReporting: boolean;

  /**
   * The provider reports monetary cost. Implies {@link usageReporting} in
   * practice, but is separate because API-key billing and gateway billing
   * differ in whether a price is knowable client-side.
   */
  readonly costReporting: boolean;

  /**
   * The provider reports **both halves** of the context readout: how many
   * tokens the conversation is occupying, and how large the window they occupy
   * is — `UsageSnapshot.contextTokens` and `UsageSnapshot.contextWindow`.
   *
   * Separate from {@link usageReporting} because the two answer different
   * questions and a provider can do the first without the second. Token counts
   * are what a turn *spent*; a context reading is how full the conversation
   * has become, and it needs a denominator nothing can guess — a table of
   * model specs held here would go stale silently and print a confidently
   * wrong "of 128k" under a server started with `-c 32768`.
   *
   * The flag exists so the status line can offer a gauge to a provider that
   * has no plan behind it at all. {@link planUsageReporting} answers "is there
   * a subscription to be near the end of"; this answers "is there a
   * conversation to be near the end of", and a local server has the second
   * without the first.
   */
  readonly contextReporting: boolean;

  /**
   * The provider can report consumption against a *plan's* limits, as opposed
   * to the per-run counts {@link usageReporting} covers.
   *
   * This says the provider has the capability at all. Whether a given profile
   * actually has plan limits is a separate, runtime question — API-key,
   * Bedrock and Vertex billing is metered rather than capped, so the same
   * adapter answers differently per profile. That answer arrives as
   * `PlanUsage.available`, and the UI needs both: this flag decides whether to
   * offer the control, `available` decides what the control says.
   */
  readonly planUsageReporting: boolean;

  /**
   * A prompt can carry images — {@link import('./run.js').RunInput.attachments}
   * and the `attachments` argument to `Run.send()`.
   *
   * This is about the *transport*, not the model: it says the adapter has
   * somewhere to put an image on the wire. Whether the model behind the
   * selected profile can actually see one is a separate question no adapter can
   * answer up front, and the two fail differently — an adapter without a
   * transport drops the image silently, whereas a text-only model sent an image
   * says so in its reply.
   */
  readonly imageInput: boolean;

  /**
   * A prompt can carry arbitrary files — the adapter stages them somewhere the
   * agent can reach and tells it they are there.
   *
   * Separate from {@link imageInput} because they are not the same mechanism.
   * `imageInput` is about a *wire format*: somewhere on the request to put
   * pixels. This is about an adapter doing work — writing files, granting the
   * agent access to where it wrote them, and naming them in the prompt — and an
   * adapter that has not done that work drops files silently, which is exactly
   * what the flag exists to prevent.
   */
  readonly fileInput: boolean;

  /**
   * The adapter honours {@link import('./run.js').RunInput.systemPrompt} with
   * `kind: 'append'` — standing instructions reach the model on top of the
   * provider's own preset.
   *
   * A flag rather than an assumption because the failure without one is the
   * quietest kind there is. `systemPrompt` is an optional field, and an adapter
   * that never reads it accepts a run carrying one and starts it normally: no
   * error, no warning, and a prompt library that the settings pane says is on
   * while the model has never been told a word of it. That is the same hazard
   * `fastMode` and `effort` are gated on at the point of send — a setting
   * "accepted and ignored" is worse than one refused — applied to the one
   * setting whose whole purpose is to change how the agent behaves.
   *
   * The UI's obligation is to say so rather than to hide it: a profile whose
   * provider lacks this stays visible in the scope list, disabled, with the
   * reason attached.
   */
  readonly systemPromptAppend: boolean;
}

/**
 * A capability descriptor with everything switched off.
 *
 * Adapters should spread this and then turn on what they support, so that a
 * capability added to {@link Capabilities} later defaults to "unsupported"
 * rather than breaking every adapter's build.
 */
export const NO_CAPABILITIES: Capabilities = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: false,
  subagents: false,
  subagentTranscripts: false,
  renameSession: false,
  deleteSession: false,
  tagSession: false,
  permissionModes: [],
  resumeSession: false,
  rewind: false,
  usageReporting: false,
  costReporting: false,
  contextReporting: false,
  planUsageReporting: false,
  systemPromptAppend: false,
  imageInput: false,
  fileInput: false,
};

/**
 * One model a provider can be pointed at, as the renderer sees it.
 *
 * Built to the same rule as {@link Capabilities.permissionModes}, and for the
 * same reason: model identifiers are a provider's vocabulary, not a universal
 * one. `claude-sonnet-5` means nothing to Codex. Nothing in this package names
 * a model; the adapter declares its own list and the model picker is built from
 * {@link ProviderDescriptor.models}.
 *
 * An empty or absent list means "this provider does not offer a model choice",
 * and the picker renders disabled with that as its reason rather than
 * disappearing.
 */
export interface ProviderModelOption {
  /** Sent as `RunInput.model`. Opaque to everything above the adapter. */
  readonly id: string;
  /**
   * Short name for dense chrome — a status-line segment, a menu row, e.g.
   * "Sonnet 5". Kept distinct from {@link displayName} because the bar this
   * appears on is 20px tall and "Claude Sonnet 5 (latest)" does not fit in it.
   */
  readonly label: string;
  /**
   * The provider's own full name for the model, e.g. "Claude Sonnet 5".
   *
   * Absent when the provider does not publish one, in which case {@link label}
   * is all there is and the UI must fall back to it rather than rendering a
   * blank. Shown wherever there is room to be unambiguous: the settings
   * catalogue, the model picker's expanded rows.
   */
  readonly displayName?: string;
  /**
   * The canonical wire id this option resolves to, e.g. `sonnet` →
   * `claude-sonnet-5`.
   *
   * Artemis offers *aliases* rather than dated snapshots on purpose (see the
   * Claude adapter's model list), which means the id it sends does not identify
   * the model that actually ran. This carries the resolution so the UI can
   * match a persisted explicit id back to the alias row that covers it, and so
   * a run can report the concrete model without a second lookup.
   */
  readonly resolvedModel?: string;
  /** One line on what this model is for, shown under the picker. */
  readonly note: string;
  /**
   * Effort levels valid on *this* model, as ids from
   * {@link ProviderDescriptor.effortLevels}. Omit for "every level the provider
   * offers"; an empty array means this model takes no effort setting at all.
   *
   * A real constraint rather than decoration: providers ship models that do not
   * accept a reasoning-effort parameter, and offering one for them would send a
   * setting the run silently ignores.
   */
  readonly effortLevels?: readonly string[];
  /**
   * This model accepts {@link RunInput.fastMode}.
   *
   * Absent means unknown, which the UI must treat as *not supported* rather
   * than as permission: offering a toggle that the provider ignores is worse
   * than not offering it, because the user believes it took effect.
   */
  readonly supportsFastMode?: boolean;
  /**
   * This model accepts {@link RunInput.ultracode}.
   *
   * Separate from {@link supportsFastMode} and not derivable from it. The two
   * pull in opposite directions — one buys latency, the other spends it — and a
   * provider may offer either, both or neither on a given model.
   */
  readonly supportsUltracode?: boolean;
  /**
   * The model decides its own thinking depth, so an explicit effort level is a
   * hint rather than an instruction. Purely informational: the UI uses it to
   * explain why the effort picker may not visibly change anything.
   */
  readonly adaptiveThinking?: boolean;

  /**
   * The serving-side account this option runs as, when the catalogue was read
   * from another Artemis (the `artemis` adapter). A server flattens every
   * account × model into one list of routes, so two accounts offering the same
   * model produce two options whose {@link label}s are identical — these three
   * fields are what lets the UI group, filter and name them by account instead
   * of guessing from the route's slug prefix or the {@link note}'s wording.
   *
   * `accountId` is the serving Artemis's own profile id — the same id its
   * usage report keys gauges by, which is what makes an exact join possible.
   * `accountSlug` is the route prefix (`work-max` in `work-max/opus`).
   * `accountLabel` is the display name the server uses for the account.
   *
   * All absent for local providers, and individually absent when an older
   * server omits the field — consumers must fall back rather than assume.
   */
  readonly accountId?: string;
  /** See {@link accountId}. */
  readonly accountSlug?: string;
  /** See {@link accountId}. */
  readonly accountLabel?: string;
  /**
   * The provider the serving-side account belongs to — `claude`, `codex`, a
   * local runtime.
   *
   * A server flattens accounts from several providers into one list of routes,
   * and without this the fact is unrecoverable: the route prefix is an account
   * slug, and the model id (`opus`, `gpt-5.2`) is a naming convention rather
   * than a guarantee. So the picker could group *local* accounts by provider,
   * the way it always has, and could only show a server's as one flat list.
   *
   * The server has always sent it — `ServerModel.providerId` is required — and
   * this is the field that carries it the rest of the way.
   */
  readonly accountProviderId?: ProviderId;

  /**
   * Where this model sits in its provider's own lineup, `0` being the smallest
   * and cheapest tier that provider ships.
   *
   * Not a price and not a benchmark — an *ordinal within one catalogue*, which
   * is the most this file can honestly carry. Nothing here knows what a token
   * costs, and comparing a tier across providers would be meaningless.
   *
   * It exists because one caller has a question that display order cannot
   * answer: {@link lowestTierModel}, which picks the model Artemis spends on
   * background work such as naming a session. Display order is the *provider's*
   * order — the live Claude catalogue leads with its flagship, the built-in
   * fallback list does too — so "the last row" is a coincidence rather than a
   * fact, and a coincidence is not something to bill someone's account against.
   *
   * **Optional, and absent means "unknown" rather than "cheapest".** A row an
   * adapter cannot place is one nobody should be spending on by default, and
   * every selector here treats it that way. Adapters derive it from their own
   * vocabulary: the Claude adapter reads the family out of the wire id, because
   * `haiku` and `opus` mean something *there* and nowhere above it.
   */
  readonly tier?: number;
}

/**
 * Strip the parts of a model id that decorate it without naming a model.
 *
 * Two suffixes, both *lexical conventions* rather than names:
 *
 *  - A bracketed variant — `opus[1m]`, `claude-opus-5[1m]`. It qualifies a
 *    model; it does not name a different one.
 *  - A dated snapshot — `claude-haiku-4-5-20251001`. That is the release, not
 *    the model.
 *
 * Nothing here knows what any provider calls its models, which is the rule this
 * file is built on. It removes decoration and compares what is left.
 */
function bareModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * Every string that identifies this model, normalised.
 *
 * ## Why an id needs normalising at all
 *
 * A model is identified by its {@link ProviderModelOption.id}, and that id is
 * **not stable across catalogues**. The same model is `fable` in the Claude
 * adapter's built-in list and `claude-fable-5[1m]` in the live one the CLI
 * publishes, because the two lists are written by different authors for
 * different purposes: one is a conservative alias this app ships, the other is
 * the provider's own vocabulary. So anything persisted against one list — a
 * pinned shortlist, a selected model — silently stops matching when the other
 * arrives, and a model the user chose vanishes from their picker without a word.
 *
 * {@link resolvedModel} exists precisely to bridge that, and this is the bridge:
 * both lists resolve Fable to `claude-fable-5`, so the two rows share a key even
 * though their ids do not.
 *
 * Two rows that differ only by variant or release date come back with the same
 * key on purpose. Every caller asking this question — "is the model the user
 * picked still in this list?" — means the model rather than the build.
 */
export function modelIdentity(option: ProviderModelOption): readonly string[] {
  const keys: string[] = [];
  for (const candidate of [option.id, option.resolvedModel]) {
    if (candidate === undefined) continue;
    const key = bareModelId(candidate);
    if (key.length > 0 && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Do two catalogue entries name the same model?
 *
 * Used to carry a persisted choice across a catalogue swap — see
 * {@link modelIdentity} for why ids alone cannot answer it. Both sides must be
 * real options: a bare id string carries no `resolvedModel`, and without one
 * there is nothing to match `fable` against `claude-fable-5[1m]` with.
 */
export function isSameModel(a: ProviderModelOption, b: ProviderModelOption): boolean {
  const keys = modelIdentity(b);
  return modelIdentity(a).some((key) => keys.includes(key));
}

/**
 * The smallest model in a catalogue, or `undefined` if it does not say.
 *
 * "Smallest" is {@link ProviderModelOption.tier}, and the undefined case is the
 * important half of this function. A catalogue where no row declares a tier —
 * a provider that has not adopted the field, a live listing full of models this
 * build has never heard of — produces *no answer*, not a guess. The alternative
 * is picking the first or last row and hoping, which spends the user's account
 * on a frontier model to save four words of typing.
 *
 * Ties go to display order, which is the provider's own preference among models
 * it considers equivalent.
 */
export function lowestTierModel(
  models: readonly ProviderModelOption[] | undefined,
): ProviderModelOption | undefined {
  let best: ProviderModelOption | undefined;
  for (const model of models ?? []) {
    if (model.tier === undefined) continue;
    // Strictly less than, so the earliest row wins a tie.
    if (best === undefined || model.tier < (best.tier ?? Number.POSITIVE_INFINITY)) best = model;
  }
  return best;
}

/**
 * One reasoning-effort level, as the renderer sees it.
 *
 * "How hard should the model think before answering" is a knob several
 * providers expose under different names and with different scales, so the
 * levels are declared by the adapter rather than enumerated here. Ordered
 * least-to-most effort by the adapter, so the picker can render them as a
 * scale.
 */
export interface ProviderEffortOption {
  /** Sent as `RunInput.effort`. See `ProviderEffort`. */
  readonly id: string;
  /** Human-readable name for the picker, e.g. "High". */
  readonly label: string;
  /** One line on what this level trades away, shown next to it. */
  readonly note: string;
}

/**
 * A provider as the renderer sees it: identity, capabilities, and whether it
 * can actually be used right now.
 *
 * Returned by the `providers:list` IPC call. Carries no secrets and no paths.
 */
/**
 * Which half of the picker a provider belongs to.
 *
 * `hosted` providers reach a service over the network and are entered through
 * an account: the profile names a credential directory, and what the account is
 * entitled to decides what runs. `local` providers reach a server on this
 * machine and are entered through an *endpoint*: there is no account, no
 * billing and no plan, and the models on offer are whichever files happen to be
 * on the disk.
 *
 * Kept as a property of the provider rather than a list in the renderer so that
 * adding one does not mean editing a UI file to say where it goes — the same
 * reason `PROVIDER_LABELS` exists.
 */
export type ProviderKind = 'hosted' | 'local';

/**
 * Where each local server listens when nobody has said otherwise.
 *
 * Here rather than in the adapter that connects, because three places need the
 * same numbers and only one of them can import core: the adapter falls back to
 * it, the profile editor shows it as the placeholder under an empty address
 * field, and the editor's help text names it. A default the user is *told* is
 * a default they can confirm their server matches.
 *
 * Each is the port that server ships with — LM Studio's 1234, Ollama's 11434,
 * `llama-server`'s 8080 — and loopback rather than `localhost`, which can
 * resolve to an IPv6 address the server did not bind.
 *
 * `artemis` is another Artemis's own server, so its entry is
 * `DEFAULT_SERVER_PORT` from `server.ts` — written out literally because this
 * module must not import that one (`server.ts` already imports this file). A
 * profile usually names a non-default address anyway: the remote Artemis binds
 * loopback only, so reaching one on another machine means a forwarded address,
 * not this fallback.
 */
export const DEFAULT_LOCAL_BASE_URLS: Readonly<Record<string, string>> = {
  lmstudio: 'http://127.0.0.1:1234',
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
  artemis: 'http://127.0.0.1:6472',
};

/** The address a local provider uses when a profile names none. */
export function defaultBaseUrlFor(providerId: ProviderId): string {
  return DEFAULT_LOCAL_BASE_URLS[providerId] ?? '';
}

/**
 * Whether this provider is a server the user runs rather than an account they
 * sign in to.
 *
 * Derived from the table above rather than declared twice: a local provider is
 * exactly one that has a default address to fall back to. Used to decide which
 * profiles get an address and a key at all — offering either for a hosted
 * account would be storing a secret nothing will ever send.
 */
export function isLocalProviderId(providerId: ProviderId): boolean {
  return providerId in DEFAULT_LOCAL_BASE_URLS;
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  /**
   * Which half of the picker this belongs to. See {@link ProviderKind}.
   *
   * Absent means `hosted`, so a descriptor written before this existed still
   * lands where it always did.
   */
  readonly kind?: ProviderKind;
  /** Human-readable name for menus, e.g. "Claude". */
  readonly label: string;
  readonly capabilities: Capabilities;
  /**
   * How the user signs a profile in, in one or two sentences.
   *
   * The provider's login is the user's to run — Artemis sets the config
   * directory and reads the result back — so this is the only instruction they
   * get, and it is the adapter's to write because the command is its own. Shown
   * beside the generated command on the profile screen.
   *
   * Absent for a provider that needs no sign-in, or one not registered in this
   * build.
   */
  readonly signInHowTo?: string;

  /**
   * How this provider's shell commands are confined on *this* machine.
   *
   * Present only for the local providers, and that is the point rather than an
   * omission. LM Studio, Ollama and llama.cpp are raw model endpoints with no
   * agent harness of their own, so Artemis builds the shell tool and has to
   * confine it — Seatbelt on macOS, bubblewrap on Linux, and a refusal where
   * nothing can. Claude and Codex bring their own CLI, which does its own
   * permission handling; the permission-mode control is the honest answer for
   * them, and a chip reading `seatbelt` beside a Claude profile would be
   * claiming a confinement Artemis is not providing.
   *
   * `unverified` is carried through rather than flattened away. A backend that
   * has never been exercised on a real machine of that platform is a claim we
   * have not tested, and the capability bar's rule is that we do not state what
   * we cannot back.
   */
  readonly sandbox?: {
    /** `Seatbelt`, `bubblewrap`, or absent when nothing can confine. */
    readonly backend?: string;
    /** `workspace` — writes limited, network denied — or `none`. */
    readonly confinement: 'workspace' | 'none';
    readonly verification: 'verified' | 'unverified';
    /** The sentence `describeConfinement` writes, for a tooltip. */
    readonly detail: string;
  };
  /**
   * Models this provider offers, in display order. The first entry is the
   * default — what a run gets when {@link RunInput.model} is omitted.
   *
   * Optional so a descriptor assembled before this axis existed still satisfies
   * the contract. Absent or empty both mean "no model choice", and the picker
   * says so rather than vanishing.
   */
  readonly models?: readonly ProviderModelOption[];
  /**
   * Reasoning-effort levels this provider offers, least to most. Absent or
   * empty mean the concept does not apply and the picker renders disabled with
   * that as its reason — the same treatment
   * {@link Capabilities.permissionModes} gets when it is empty.
   */
  readonly effortLevels?: readonly ProviderEffortOption[];
  /**
   * False when the provider is registered but unusable — no binary on PATH, no
   * profile configured, unsupported platform. The UI should show it greyed out
   * with {@link unavailableReason} rather than hiding it, so the user learns
   * what to fix.
   */
  readonly available: boolean;
  /** Short user-facing explanation, present only when `available` is false. */
  readonly unavailableReason?: string;
}
