/**
 * The provider-adapter seam.
 *
 * This is the single most important design element in `@rx-artemis/core`. Artemis
 * drives *agentic coding CLIs*, and the three we plan to support have three
 * completely unrelated transports:
 *
 * | Provider   | Transport                                             |
 * | ---------- | ----------------------------------------------------- |
 * | `claude`   | in-process Node library (`@anthropic-ai/claude-agent-sdk`) |
 * | `codex`    | a subprocess speaking JSONL over stdio                |
 * | `opencode` | a local HTTP server                                   |
 *
 * So the seam must not be Claude-shaped. Two rules keep it honest:
 *
 *  1. **Everything a provider produces is normalized before it crosses the
 *     seam.** An adapter's only output is the nine-variant
 *     {@link import('@rx-artemis/protocol').AgentEvent} union. Nothing
 *     provider-specific — no SDK message, no JSONL line, no HTTP body — is
 *     visible above this file.
 *  2. **Everything a provider *cannot* do is declared up front.** Adapters
 *     publish a static {@link Capabilities} descriptor and the UI degrades
 *     against it. Every optional method on {@link ProviderAdapter} and every
 *     conditional behaviour on {@link Run} is paired with a capability flag,
 *     and each is documented below with what an adapter that cannot support it
 *     must do instead.
 *
 * Note what is *not* here. `ProviderAdapter` and `Run` describe live objects —
 * async iterables, deferred permission prompts, disposal semantics — which is
 * exactly why they live in core rather than in `@rx-artemis/protocol`: they never
 * cross the Electron IPC boundary. Protocol supplies every type they are built
 * from; this file assembles those into an interface an adapter implements.
 *
 * ## Secrets
 *
 * {@link ResolvedRunInput.env} is the *only* channel through which a credential
 * reaches a provider, and it is populated in the Electron main process from a
 * `Profile`. Core never reads a secret store, and an adapter must never write
 * an env value into an event, an error message or a log line. See
 * {@link scrubSecrets}.
 */

import type {
  AgentError,
  AgentErrorCode,
  AgentEvent,
  Attachment,
  Capabilities,
  MessageId,
  PermissionDecision,
  PermissionRequestId,
  PlanUsage,
  ProfileId,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderId,
  ProviderModelOption,
  RunId,
  RunInput,
  RunStatus,
  SessionDelegatedWork,
  SessionId,
  SessionSummary,
  ToolServerConfig,
} from '@rx-artemis/protocol';

import type { XdgRootSpec } from '../profiles/xdgFarm.js';
export type { XdgRootSpec };

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An environment-variable bundle.
 *
 * `undefined` values mean "explicitly unset", which matters when composing a
 * child environment on top of an inherited one — see
 * {@link import('./env.js').composeProviderEnv}.
 */
export type EnvBundle = Readonly<Record<string, string | undefined>>;

/**
 * Which on-disk configuration layers a run is allowed to inherit.
 *
 * Named after the Claude Agent SDK's `SettingSource`, but the concept is
 * general: every provider we plan to support reads *some* ambient config from
 * the user's home directory, and a distributed desktop app must not silently
 * pick it up.
 *
 * - `user`    — the user's global config (`~/.claude/settings.json`).
 * - `project` — the checked-in project config (`.claude/settings.json`). Also
 *               what enables `CLAUDE.md` loading for the Claude provider.
 * - `local`   — the machine-local project overrides (`.claude/settings.local.json`).
 *
 * **The default is the empty list.** Artemis ships as a third-party app; running
 * with the user's personal agent configuration silently merged in would make
 * behaviour unreproducible and could pull in hooks, MCP servers and permission
 * rules the user never intended to grant to *this* app. Opting in is an
 * explicit, per-run decision made above core.
 *
 * An adapter whose provider has no such concept ignores this field.
 */
export type ConfigSource = 'user' | 'project' | 'local';

/** Inherit nothing. The default value of {@link ResolvedRunInput.settingSources}. */
export const NO_CONFIG_SOURCES: readonly ConfigSource[] = [];

/**
 * A plugin directory to load for a run.
 *
 * The narrow channel that lets *one* kind of user content — skills — reach a
 * session without {@link ConfigSource} opening the rest. A provider that reads
 * skills only from the layers `settingSources` gates will never see a skill the
 * user installed, because the empty default is the right answer for hooks, MCP
 * servers and permission rules and the wrong one for a document the user wrote
 * on purpose. Plugins are discovered independently of that gate, so they are
 * how the two are told apart.
 *
 * The safety property is *structural*, and it belongs to the directory rather
 * than to this type: a plugin may contribute skills, commands, agents and
 * hooks, so a plugin pointed at a directory that contains only `skills/`
 * cannot contribute anything else. Whoever builds the directory owns that
 * guarantee — see `skillBridge.ts` in the desktop app, which is why it
 * assembles a directory of its own instead of pointing here at a config dir
 * that also holds `commands/`.
 *
 * `path` must be absolute. A relative path would resolve against the provider
 * subprocess's `cwd`, which is the *run's* working directory — so the same
 * value would mean a different directory in every repository.
 *
 * An adapter whose provider has no plugin concept ignores this field.
 */
export interface LocalPlugin {
  readonly path: string;
}

/* -------------------------------------------------------------------------- */
/* Run input                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A {@link RunInput} with everything the main process had to resolve on its
 * behalf already resolved.
 *
 * The renderer sends a `RunInput` carrying a {@link ProfileId}. It never sends
 * credentials, paths or environment variables — it does not have them. The main
 * process turns the profile into {@link env} and hands *this* to the adapter.
 * The extra fields are all things a renderer must not be able to choose.
 */
export interface ResolvedRunInput extends RunInput {
  /**
   * Required at the seam. Core mints the id before calling `createRun` so the
   * adapter can stamp it on every event, including events emitted before
   * `createRun` returns.
   */
  readonly runId: RunId;

  /**
   * The provider's environment, resolved from the run's profile: the API key
   * or backend flag, the isolated config directory, and the profile's
   * `publicEnv`.
   *
   * Whether this *replaces* or *extends* the host environment is decided by
   * {@link inheritHostEnv}. Adapters must treat every value here as a secret:
   * never log it, never echo it into an {@link AgentError}, never put it in an
   * event.
   */
  readonly env: EnvBundle;

  /**
   * Spread the host process environment underneath {@link env}, so the provider
   * inherits `PATH`, `HOME`, `TMPDIR` and friends. Defaults to `true`, because
   * a provider that cannot find `git` or a shell is useless.
   *
   * Inheriting the host environment does **not** mean inheriting the host's
   * credentials: adapters scrub provider-credential variables out of the
   * inherited base so a profile can never be contaminated by whatever the
   * user happens to have exported. See {@link import('./env.js').composeProviderEnv}.
   */
  readonly inheritHostEnv?: boolean;

  /**
   * On-disk configuration layers this run may inherit. **Defaults to `[]`.**
   * See {@link ConfigSource} for why.
   */
  readonly settingSources?: readonly ConfigSource[];

  /**
   * Plugin directories to load for this run — in practice, the user's skills.
   * See {@link LocalPlugin}.
   *
   * Resolved rather than requested: these are absolute paths, and a renderer
   * that could name one could point a run at any directory on the disk and have
   * its `hooks/` executed.
   */
  readonly plugins?: readonly LocalPlugin[];

  /**
   * Tool servers this run may reach, as the profile recorded them.
   *
   * Resolved rather than requested, like {@link plugins} and for a sharper
   * version of the same reason: an entry can name an executable, so a renderer
   * that could send one could start any binary on the machine under the
   * agent's environment. What the renderer names is a profile; what the host
   * returns is what that profile holds.
   *
   * Read today by the local adapter, which owns its own MCP client
   * (`local/mcp.ts`). The other providers connect their own tool servers
   * through the runtime they wrap and ignore this.
   */
  readonly toolServers?: readonly ToolServerConfig[];

  /**
   * Cancels the run from the outside — app shutdown, window close, a global
   * "stop everything". Aborting is equivalent to calling {@link Run.dispose}:
   * the adapter still emits `run.end` before the stream completes.
   */
  readonly abortSignal?: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** Result of {@link Run.send}. Mirrors protocol's `RunsSendResponse`. */
export interface SendResult {
  /**
   * True when the text was steered into the turn that is already in flight.
   * False when the provider could only queue it for a later turn — the case
   * for providers without {@link Capabilities.midRunSteering}.
   */
  readonly deliveredImmediately: boolean;
}

/** Result of {@link Run.interrupt}. Mirrors protocol's `RunsInterruptResponse`. */
export interface InterruptResult {
  /**
   * Messages the provider has accepted but not yet executed, and which will
   * still run unless separately cancelled. Empty for providers that stop
   * cleanly.
   *
   * Named in the *caller's* id space — the `messageId` handed to {@link Run.send}
   * — so a consumer can match an entry against the row it drew. An adapter whose
   * provider answers in ids of its own translates them and drops the ones it
   * cannot place: the surviving set is the useful half, and an untranslatable id
   * names a message this caller never sent (the Claude CLI enqueues its own for
   * cron triggers and auto-resume continuations).
   *
   * Empty does **not** prove nothing survived. The Claude CLI only lists
   * messages that carried an id, so a message sent before this argument existed
   * — or by another client — survives unlisted. Treat a non-empty list as fact
   * and an empty one as no news.
   */
  readonly stillQueued: readonly string[];
}

/**
 * One live run: a prompt, the normalized event stream it produces, and the
 * control surface available while it is alive.
 *
 * ## Lifetime
 *
 * A run is **one turn cycle**. It starts with a prompt and ends when the
 * provider finishes that cycle, or when it is interrupted, disposed or fails.
 * Exactly one `run.end` is emitted, it is always last, and the {@link RunId} is
 * retired after it: calling {@link send}, {@link interrupt} or
 * {@link respondToPermission} on an ended run is an error.
 *
 * A *conversation* is not a run. To continue one, start a new run with
 * `resumeSessionId` set to the {@link SessionId} the previous run reported. That
 * is why `run.end` carries `sessionId`.
 */
export interface Run {
  readonly runId: RunId;
  readonly providerId: ProviderId;

  /**
   * The capabilities of the adapter that created this run, copied onto the run
   * so a caller holding only a `Run` can degrade correctly, and so a run keeps
   * its capability set even if the user switches providers underneath it.
   */
  readonly capabilities: Capabilities;

  /** Live lifecycle state, for building a `RunHandle` on demand. */
  readonly status: RunStatus;

  /** The provider session this run is writing to. Set once `session.started` arrives. */
  readonly sessionId: SessionId | undefined;

  /**
   * The normalized event stream.
   *
   * Contract, in addition to the ordering rules documented on `AgentEvent`:
   *
   *  - **Consumable exactly once.** Calling `[Symbol.asyncIterator]()` a second
   *    time throws. Multiplexing to several consumers is the caller's job (the
   *    main process fans out to renderer windows); doing it here would mean
   *    guessing at buffering policy for consumers we cannot see.
   *  - **Lossless.** Events are buffered without bound. A consumer slower than
   *    the provider falls behind but never misses an event, and the provider is
   *    never blocked on the consumer.
   *  - **Terminating.** The iterable completes immediately after `run.end`, and
   *    `run.end` is emitted for *every* exit path: success, provider error,
   *    interrupt, dispose, and abort-signal cancellation. It never rejects —
   *    failures arrive as `run.end` with `reason: 'error'`, because an
   *    exception cannot be rendered in a transcript.
   *  - **Abandonable.** Breaking out of a `for await` closes the iterator and
   *    discards the buffer. It does *not* dispose the run; call {@link dispose}.
   */
  readonly events: AsyncIterable<AgentEvent>;

  /**
   * Send more text into the live run.
   *
   * With {@link Capabilities.midRunSteering}, this steers the turn already in
   * flight. Without it, an adapter has two honest options: queue the text and
   * return `deliveredImmediately: false`, or reject with an
   * `invalid_request` {@link AdapterError}. It must not silently drop the text.
   *
   * `attachments` follows the same contract as {@link RunInput.attachments}.
   * The registry refuses them for an adapter that does not declare
   * {@link Capabilities.imageInput}, so an implementation only has to handle
   * them if it advertises them.
   *
   * `messageId` is the identity the caller will file this message under, handed
   * down so a queued message can be named again later. An adapter that can tell
   * when the provider finally read a queued message emits `message.delivered`
   * carrying this id; one that cannot ignores the argument. Nothing about
   * delivery depends on the adapter minting an id of its own — the caller's is
   * the only one both ends can speak.
   */
  send(
    text: string,
    attachments?: readonly Attachment[],
    messageId?: MessageId,
  ): Promise<SendResult>;

  /**
   * Ask the provider to stop what it is doing.
   *
   * The run does not end synchronously: the adapter still emits `tool.end`
   * (`status: 'cancelled'`) for every open tool call and then `run.end`
   * (`reason: 'interrupted'`). Calling this on an already-ended run resolves
   * with an empty {@link InterruptResult} rather than throwing, because
   * "stop" is idempotent by nature.
   *
   * A provider with no interrupt channel should fall back to disposing the
   * transport and report `reason: 'interrupted'` all the same.
   */
  interrupt(): Promise<InterruptResult>;

  /**
   * Answer an outstanding `permission.request`.
   *
   * Only meaningful with {@link Capabilities.interactivePermissions}. Adapters
   * that advertise `false` never emit `permission.request`, so this method is
   * unreachable for them and must reject with `invalid_request`.
   *
   * Adapters that advertise `true` are **blocked** until this is called. There
   * is no deadline and no default answer: an unanswered request parks the run
   * forever. Two obligations follow, and the Claude adapter honours both:
   *
   *  - {@link dispose} must resolve every outstanding request (as a denial) so
   *    the provider is never left waiting on a promise nobody will settle.
   *  - Answering an id that is unknown or already answered must reject with
   *    `invalid_request`, never silently succeed — a double answer usually
   *    means the UI has lost track of which prompt it is showing.
   */
  respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;

  /**
   * Stop one delegated task, leaving everything else alone.
   *
   * Optional, and gated on {@link Capabilities.subagents}: a provider with no
   * concept of delegated work has nothing to stop, and the registry refuses the
   * call rather than an adapter having to implement a throw.
   *
   * **Not gated on the run being active**, which is the whole point of it. The
   * tasks worth stopping are the ones that outlived the turn that launched them,
   * so by the time a person decides twelve minutes is enough, the run they are
   * looking at has usually ended. This addresses the *process's* work through one
   * of its turns, exactly as {@link interrupt} does.
   *
   * Stopping is a request, not an assertion: the task ends when the provider says
   * it has, which arrives as an ordinary settled row. Resolving here means the
   * ask was delivered. An unknown or already-finished task id is not an error —
   * "stop" is idempotent by nature, and a user clicking the button on a row that
   * settled while they were reaching for it has done nothing wrong.
   */
  stopTask?(taskId: string): Promise<void>;

  /**
   * Tear the run down and release everything it holds: subprocesses, sockets,
   * file handles, the input pump, and any promise the provider is parked on.
   *
   * **Must be idempotent.** Concurrent and repeated calls share one teardown
   * and resolve together. **Must not reject** on a provider that is already
   * dead. If `run.end` has not been emitted yet, dispose emits it with
   * `reason: 'disposed'` before completing the stream.
   */
  dispose(): Promise<void>;

  /**
   * The caller is finished with this run, which is *not* the same as asking for
   * the provider to be torn down.
   *
   * The registry calls this — not {@link dispose} — when a run ends of its own
   * accord, and that distinction is the whole reason it exists. For an adapter
   * where a run owns its transport the two are one act, which is why this is
   * optional: leave it out and the registry disposes, exactly as it always did.
   *
   * It matters where a run is one *turn* of something longer-lived. The Claude
   * adapter keeps a process across turns when it still holds background work,
   * subagents or a registered schedule, and disposing a finished turn would take
   * that process down with it — which is the defect the retention rule exists to
   * fix, arriving one layer up. There, releasing a turn is a no-op: the process
   * decided its own fate when the turn ended, and the only thing left to say is
   * that nobody is reading this turn's stream any more.
   *
   * Same obligations as {@link dispose}: idempotent, and it must not reject.
   * What it must *not* do is end work the user can still see the point of.
   */
  release?(): Promise<void>;
}

/**
 * What a caller needs in order to register a run it did not ask for.
 *
 * A provider can open a turn of its own — answering when background work
 * settles, or asking for a tool on behalf of a subagent whose own turn ended
 * long ago. The adapter is the only thing that can build the {@link Run} for
 * one, and it cannot register it: run ids and the event fan-out belong to the
 * host. So it reports the run, with the four facts the host has no other way to
 * know about a turn it never started.
 *
 * Every one of them is fixed when the process is spawned, which is what makes
 * this a snapshot rather than a lookup: a continuation is by definition inside
 * the conversation that process is already serving.
 */
export interface ContinuationContext {
  readonly providerId: ProviderId;
  readonly profileId: ProfileId;
  readonly cwd: string;
  /** The conversation the turn is being written into, once the provider has said. */
  readonly sessionId: SessionId | undefined;
}

/* -------------------------------------------------------------------------- */
/* Session listing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A request for a page of historical sessions.
 *
 * Session storage is per-profile *and* per-cwd. For Claude that falls out of
 * the design for free: each profile gets its own `CLAUDE_CONFIG_DIR`, and
 * transcripts live at `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<id>.jsonl`.
 * Other providers must reproduce the same scoping, deriving it from
 * {@link env} rather than from ambient state.
 */
export interface SessionListQuery {
  /** Whose history to read. Stamped onto every returned {@link SessionSummary}. */
  readonly profileId: ProfileId;
  /** Absolute path whose sessions to list. */
  readonly cwd: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  /** Page size. Omit for the provider's default. */
  readonly limit?: number;
  /** Page offset. Defaults to 0. */
  readonly offset?: number;
}

/**
 * What a plan-usage read needs.
 *
 * Deliberately the same shape as the session queries: a profile identity plus
 * its resolved environment. The environment is what selects the account, so a
 * plan reading is per-profile by construction rather than by convention.
 */
export interface PlanUsageQuery {
  /** Whose plan to report on. */
  readonly profileId: ProfileId;
  /** The profile's resolved environment — this is what selects the account. */
  readonly env: EnvBundle;
  /**
   * Where to run the probe. Any readable directory works; the provider may
   * refuse to start in one that does not exist, so callers should pass
   * somewhere known-good rather than the user's possibly-unset workspace.
   */
  readonly cwd: string;
}

/**
 * What a live model-catalogue read needs.
 *
 * The same shape as {@link PlanUsageQuery} minus the profile id, and for the
 * same reason it has an environment at all: the catalogue is a property of the
 * *account*, so the credential is what selects the answer. The profile id is
 * absent because nothing is stamped with it — unlike a session summary or a
 * usage reading, a model list is not attributed back to whoever asked.
 *
 * {@link inheritHostEnv} is here rather than assumed because the adapter's own
 * host-environment merge is what scrubs credential variables out of the
 * launching shell. Passing the run's setting through means the query reaches
 * the same account the next run will, instead of a differently-configured one.
 */
/**
 * What a provider may be told when its availability is probed.
 *
 * A subset of {@link ModelListQuery}, and deliberately every field optional:
 * the probe runs in places where no profile has been picked yet, and a shape
 * that demanded an environment would push every caller into inventing one.
 */
export interface AvailabilityQuery {
  /** The profile's resolved environment, when a profile is in hand. */
  readonly env?: EnvBundle;
}

export interface ModelListQuery {
  /** The profile's resolved environment — this is what selects the account. */
  readonly env: EnvBundle;
  /**
   * Where to run the query. Providers resolve configuration relative to a
   * working directory, so this can change the answer; it must exist, so
   * callers pass somewhere known-good rather than an unset workspace.
   */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
}

/**
 * Everything an enumeration of slash commands depends on.
 *
 * Shaped like {@link ModelListQuery} and one field wider, and the extra field is
 * the point: the commands a session offers are partly the provider's own and
 * partly whatever the plugins contribute, so a query that omitted
 * {@link plugins} would confidently report a list missing exactly the commands
 * the user installed — the ones they are most likely to be reaching for. The
 * caller passes what a run in the same place would be given.
 */
export interface CommandListQuery {
  /** The profile's resolved environment — this is what selects the account. */
  readonly env: EnvBundle;
  /**
   * Where to run the query. Providers discover commands relative to a working
   * directory, so this changes the answer; it must exist, so callers pass
   * somewhere known-good rather than an unset workspace.
   */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
  /** The plugins a run started here would load. See {@link LocalPlugin}. */
  readonly plugins?: readonly LocalPlugin[];
}

/**
 * A model catalogue, plus whether the provider actually confirmed it.
 *
 * The flag is not decoration. {@link ProviderAdapter.listModels} is required to
 * resolve rather than reject, so a machine with no CLI, no credential or no
 * network produces a perfectly well-formed result that happens to be a guess.
 * Without `live`, the UI has no way to distinguish that from a lineup the
 * account really reported, and would present a hard-coded list as fact.
 */
export interface ModelCatalogue {
  /** In display order, first = default. Never empty. */
  readonly models: readonly ProviderModelOption[];
  /**
   * True only when this came back from the provider itself. False for every
   * fallback path, including ones that failed for benign reasons.
   */
  readonly live: boolean;
}

/* -------------------------------------------------------------------------- */
/* Session titles                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What naming a session from its opening message needs.
 *
 * The {@link model} is chosen by the caller rather than left to the provider's
 * default, and that is the whole point of the feature: this is a throwaway
 * sentence, so it runs on the smallest model the account has
 * (`lowestTierModel`) instead of the one the user picked for real work.
 */
export interface SessionTitleQuery {
  /** The user's opening message. Adapters may truncate it before sending. */
  readonly prompt: string;
  /** Model id to name with, as the provider spells it. Never omitted. */
  readonly model: string;
  /**
   * The profile's resolved environment. Credential-bearing, unlike the read
   * paths above: this one contacts the model.
   */
  readonly env: EnvBundle;
  /** Somewhere real to run. See {@link ModelListQuery.cwd}. */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
  /** Abandon the naming call — app shutdown, or the run it belongs to ending. */
  readonly abortSignal?: AbortSignal;
}

/**
 * What writing a title onto a stored session needs.
 *
 * Separate from {@link SessionTitleQuery} because the two halves are separate
 * capabilities: a provider may be able to run a cheap completion and have
 * nowhere to put the answer, or the reverse. The environment here is the
 * *store* environment — writing a title touches the session file and nothing
 * that needs a credential.
 */
export interface SessionTitleUpdate {
  readonly sessionId: SessionId;
  /** Already cleaned and length-capped by the caller. */
  readonly title: string;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
}

/** What reading one session's stored messages needs. */
export interface SessionMessagesQuery {
  readonly profileId: ProfileId;
  readonly sessionId: SessionId;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  /** The run id to stamp replayed events with, so they join one transcript. */
  readonly runId: RunId;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * What destroying one stored session needs.
 *
 * The same locating fields a write already uses — see {@link SessionTitleUpdate},
 * which a user-driven rename goes through too. The environment selects the
 * store and the cwd narrows the search within it, because a destructive write
 * has to find the transcript by exactly the route a read does; anything else
 * and a delete could land in a different profile's copy of the same id.
 */
export interface SessionTagQuery {
  readonly sessionId: SessionId;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  /** The tag to write, or `null` to clear whatever is there. */
  readonly tag: string | null;
}

export interface SessionDeleteQuery {
  readonly sessionId: SessionId;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
}

/**
 * What reading one subagent's stored messages needs.
 *
 * {@link SessionMessagesQuery} plus the one field that changes which file is
 * read. The `agentId` is the provider's **task id** unchanged — the same string
 * a `background.tasks` row carries — which is what lets a delegated row be
 * opened without anything having to correlate two identifier spaces.
 */
export interface SubagentMessagesQuery {
  readonly profileId: ProfileId;
  /** The *parent* session — the conversation that delegated this work. */
  readonly sessionId: SessionId;
  /** The subagent's id, which is the task id. */
  readonly agentId: string;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
  /** The run id to stamp replayed events with, so they join one transcript. */
  readonly runId: RunId;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A subagent's stored conversation, replayed as events.
 *
 * {@link SessionTranscript} plus the count of stored messages behind it, so a
 * caller following a running agent can ask for "everything after what I have"
 * without counting in the wrong units. See
 * `SessionsSubagentMessagesResponse.consumed`.
 */
export interface SubagentTranscript extends SessionTranscript {
  readonly consumed: number;
}

/**
 * What counting one session's stored messages needs.
 *
 * The same locating fields a read takes, minus everything to do with
 * presentation: no `runId`, because nothing is being replayed, and no paging,
 * because the answer is the total. See {@link ProviderAdapter.countSessionMessages}.
 */
export interface SessionMessageCountQuery {
  readonly sessionId: SessionId;
  /** The directory the session ran in. Narrows the search; omit to search all. */
  readonly cwd?: string;
  /** The profile's resolved environment — this is what locates the store. */
  readonly env: EnvBundle;
}

/**
 * A stored session, replayed as events.
 *
 * Deliberately `AgentEvent[]` rather than a separate "historical message"
 * shape: history and live output then share one rendering path, so a replayed
 * tool call collapses and diffs exactly like a live one.
 */
export interface SessionTranscript {
  readonly events: readonly AgentEvent[];
  readonly hasMore: boolean;
}

/** One page of history. Mirrors protocol's `SessionsListResponse`. */
export interface SessionListPage {
  readonly sessions: readonly SessionSummary[];
  /** True when more results exist past `offset + sessions.length`. */
  readonly hasMore: boolean;
}

/**
 * One profile's slice of an aggregated listing: whose history, and where it is.
 *
 * The same two fields {@link SessionListQuery} carries, minus the cwd — because
 * enumerating *every* project is the point.
 */
export interface SessionListScope {
  /** Whose history to read. Stamped onto every {@link SessionSummary} it yields. */
  readonly profileId: ProfileId;
  /**
   * The profile's resolved environment — this is what locates the store.
   *
   * Populate it with `resolveStoreEnv`, not `resolveEnv`: listing is a read and
   * has no business decrypting a credential, and a profile with no key stored
   * must still show its history.
   */
  readonly env: EnvBundle;
}

/**
 * A request for every session across a set of profiles.
 *
 * Deliberately unpaginated. Sessions are partitioned by (profile × project),
 * and an ordering across the whole set only exists once every partition has
 * been read — so slicing has to happen after the merge, in the caller that owns
 * the merge. Paginating per profile here would silently drop the oldest
 * sessions of one profile in favour of the newest of another.
 */
export interface AllSessionsQuery {
  /** Every profile to walk. An empty list is legal and yields nothing. */
  readonly profiles: readonly SessionListScope[];
}

/**
 * Every session an adapter could find, newest first.
 *
 * ## Partial success is the contract
 *
 * A profile whose store is missing, unreadable or empty contributes nothing and
 * is named in {@link unreadableProfiles}; it does **not** fail the query. One
 * profile with a deleted config directory must not blank the entire history
 * sidebar, which is what a single rejected promise would do.
 */
export interface AggregatedSessionList {
  readonly sessions: readonly SessionSummary[];
  /**
   * Profiles whose store could not be read at all. Their sessions are simply
   * absent from {@link sessions}. Useful for a log line or a "1 profile's
   * history could not be read" note; never a reason to show an error page.
   */
  readonly unreadableProfiles: readonly ProfileId[];
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a provider can actually be used on this machine right now.
 *
 * Distinct from capabilities: capabilities are static facts about a provider's
 * design, availability is a fact about this installation. A missing binary, an
 * unsupported platform and a provider that is registered but not yet
 * implemented are all availability problems.
 */
export interface AdapterAvailability {
  readonly available: boolean;
  /**
   * Short, user-facing, actionable. Required when `available` is false; the UI
   * shows the provider greyed out with this text rather than hiding it, so the
   * user learns what to fix. Must never contain a secret or a full credential
   * path.
   */
  readonly unavailableReason?: string;
}

/* -------------------------------------------------------------------------- */
/* ProviderAdapter                                                            */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How the user signs a profile in, in the provider's own vocabulary.
 *
 * Artemis does not perform the login. It composes a command, shows it to the
 * user, and polls the status probe until the answer changes — so every string
 * here ends up either in a terminal the user pastes into or in a subprocess
 * Artemis spawns to read a boolean back.
 *
 * Naming the argv here rather than in the sign-in module is the same seam
 * {@link Capabilities} draws: `['auth', 'login']` is Claude's spelling, and a
 * second provider will spell it differently or not have one at all.
 */
export interface ProviderSignInSpec {
  /**
   * The executable, resolved on `PATH`. Also what the generated command names,
   * so it has to be the thing a user can actually type.
   */
  readonly executable: string;
  /** Arguments for the interactive login **the user runs themselves**. */
  readonly loginArgs: readonly string[];
  /**
   * Arguments for a status probe. Must be cheap and free of side effects: this
   * is polled while the user is signing in, and called again whenever the UI
   * needs to know.
   */
  readonly statusArgs: readonly string[];
  /** Arguments that clear the credential from a config directory. */
  readonly logoutArgs: readonly string[];
  /**
   * One or two sentences telling the user what the command will do. Published
   * to the renderer as `ProviderDescriptor.signInHowTo` and shown next to it.
   */
  readonly howTo: string;

  /**
   * Read {@link statusArgs}' output into an {@link AuthStatus}.
   *
   * Omit for a CLI that prints the JSON object `parseAuthStatus` expects —
   * `loggedIn`, `authMethod`, `email`, `orgName`, `subscriptionType` — which is
   * what Claude does.
   *
   * This hook exists because that turned out to be Claude's convention rather
   * than a universal one: `codex login status` prints a sentence
   * (`Logged in using ChatGPT`) and has no `--json` flag at all. Without a per-
   * provider parser the shared polling path reports a perfectly signed-in
   * profile as signed out, and the user is told to run a login they have
   * already run.
   *
   * **Must not throw**, for the same reason `checkAuthStatus` does not: every
   * caller is UI that has to render something. Report trouble as
   * `{ loggedIn: false, error }`.
   */
  readonly parseStatus?: (result: ProbeResult) => AuthStatus;

  /**
   * The localhost port the login's own OAuth server listens on, when the CLI
   * runs one.
   *
   * Claude's flow prints a provider URL and takes a pasted code back — it
   * works from any machine. Codex's flow starts a web server on the machine
   * running the CLI and prints `http://localhost:1455/…`, which is only
   * meaningful *there*. Declaring the port is what lets a serving Artemis
   * proxy it and a client forward it, so the printed address works on the
   * machine where the person actually is. Omit for flows that need none.
   */
  readonly loopbackPort?: number;

  /**
   * The answer for a provider that has *no* sign-in to probe.
   *
   * The Artemis-server and local-endpoint profiles authenticate with a token or
   * an address, not an account, so there is no CLI to run and nothing to read
   * back — their status is a constant. Naming it here says so, and
   * `checkAuthStatus` returns it without spawning anything.
   *
   * The alternative these providers used before — an `executable: 'true'` and a
   * `parseStatus` that ignored its output — reached the same answer by spawning
   * a throwaway process on every poll, which the profile screen runs every two
   * seconds. A constant is both honest and free. When set, {@link parseStatus}
   * and the status probe are not consulted.
   *
   * It is also what tells `server/signin.ts` there is no login to drive, so a
   * request to sign such an account in is refused with a sentence rather than
   * by spawning something that does nothing.
   */
  readonly staticStatus?: AuthStatus;
}

/** What a status probe produced. Handed to {@link ProviderSignInSpec.parseStatus}. */
export interface ProbeResult {
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process was killed or never started. */
  readonly exitCode: number | null;
}

/**
 * What a CLI reports about a config directory's authentication.
 *
 * Lives here rather than in `signIn.ts` because it is part of the seam's
 * vocabulary: {@link ProviderSignInSpec.parseStatus} is an adapter's to
 * implement, so the type it returns has to be visible wherever a
 * {@link ProviderCredentialSpec} is written.
 */
export interface AuthStatus {
  readonly loggedIn: boolean;
  /** How the profile is authenticated, in the provider's own words. */
  readonly authMethod?: string;
  /** Present when signed in. Shown so a user can tell two accounts apart. */
  readonly email?: string;
  readonly orgName?: string;
  /** Plan tier, when the provider reports one. Absent on metered billing. */
  readonly subscriptionType?: string;
  /** Set when the status could not be read at all, rather than read as "signed out". */
  readonly error?: string;
}

/**
 * How a provider's environment is scoped to a profile.
 *
 * Once, this described how a *credential* became an environment: which variable
 * to write an API key into, which flag selected a hosting backend, which of
 * several modes was being billed. Artemis held the credential, and the spec
 * existed to get it into the right variable for the right provider.
 *
 * Artemis holds no credential now, so what is left is the one variable that
 * matters and the list of variables that must not be allowed to interfere. The
 * seam is unchanged and still load-bearing: nothing outside an adapter names
 * `CLAUDE_CONFIG_DIR`, so a second provider is still a one-line registration
 * rather than an edit to the environment resolver.
 */
export interface ProviderCredentialSpec {
  /**
   * Variable pointing the provider at this profile's config/state directory.
   * For Claude that is `CLAUDE_CONFIG_DIR`, which buys an isolated credential
   * *and* isolated session history in one move.
   */
  readonly configDirVar: string;

  /**
   * Where this provider's session history physically lives.
   *
   * `'local'` — the default, and every filesystem-backed provider — means
   * history reads get a *store* environment: the config directory and
   * nothing else, because reading files must not decrypt a credential.
   *
   * `'remote'` means the history is on the other end of a network call and
   * the credential *is* the read path — an Artemis server's session list is
   * unreachable without the connection token. History reads for these
   * providers get the same credential-bearing environment a run gets. The
   * local rule's spirit survives: nothing is decrypted to read a *file*;
   * it is decrypted to authenticate a request.
   */
  readonly sessionStore?: 'local' | 'remote';

  /**
   * Credential variables Artemis strips from the inherited environment and
   * refuses in `publicEnv` — **and never sets**.
   *
   * Every one of these is a way to authenticate the provider without going
   * through the profile's config directory, and each of them *outranks* that
   * directory when present. An `ANTHROPIC_API_KEY` exported in the user's shell
   * beats the subscription the user just signed this profile into, and bills
   * metered usage instead. Since Artemis emits none of them, the entire list is
   * strip-only: there is no "selected" variable to spare.
   *
   * This is what makes "Artemis cannot be authenticated by accident" structural
   * rather than merely unimplemented.
   */
  readonly credentialEnvKeys: readonly string[];

  /**
   * Generic XDG roots this provider resolves from, which must be stood in for
   * rather than simply overridden.
   *
   * Absent for a provider that names its own directory variable, which is the
   * happy case: pointing `CLAUDE_CONFIG_DIR` at a profile affects Claude and
   * nothing else on the machine.
   *
   * OpenCode is why this exists. It has no variable of its own — verified
   * against `opencode debug paths`, its data, config, state and cache come
   * purely from `XDG_*`, and `OPENCODE_CONFIG_DIR` moves none of them. So
   * isolating a profile means overriding a variable belonging to the whole
   * desktop, on a process that exists to spawn other programs: every tool the
   * agent runs would inherit it and look for *its* state inside Artemis's
   * profile directory.
   *
   * Each entry is built into a stand-in directory — the provider's own entry
   * real, every other entry a symlink back to where it actually lives — so one
   * variable answers differently for the provider than for everything else.
   * See `buildXdgFarm`.
   */
  readonly xdgRoots?: readonly XdgRootSpec[];

  /** How the user authenticates a profile against {@link configDirVar}. */
  readonly signIn: ProviderSignInSpec;
}

/**
 * Every variable a provider's credential spec owns.
 *
 * The config-directory variable plus every credential variable. Callers use it
 * both to scrub the inherited environment and to reject `publicEnv` entries
 * that would override Artemis's own choices.
 *
 * Note that Artemis writes only the directory variables — the config directory
 * and any {@link ProviderCredentialSpec.xdgRoots} — and strips every
 * credential variable unconditionally. There is no case in which a credential
 * variable is stripped and then written back.
 */
export function managedEnvKeys(spec: ProviderCredentialSpec): readonly string[] {
  return [
    spec.configDirVar,
    ...(spec.xdgRoots ?? []).map((root) => root.variable),
    ...spec.credentialEnvKeys,
  ];
}

/**
 * The command a user runs to sign a profile in, as argv.
 *
 * Returned as an array rather than a string so the caller decides how to render
 * it — a shell needs quoting the user's clipboard should carry, a subprocess
 * needs none and must never be handed a quoted path.
 */
export function signInArgv(spec: ProviderCredentialSpec): readonly string[] {
  return [spec.signIn.executable, ...spec.signIn.loginArgs];
}

/**
 * A provider Artemis can drive.
 *
 * Adapters are **stateless singletons with respect to runs**: one adapter
 * instance serves every run for its provider, and all per-run state lives on
 * the {@link Run} it returns. That is what makes the registry a plain map.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;

  /** Human-readable name for menus, e.g. `"Claude"`. */
  readonly label: string;

  /**
   * How this provider's credential reaches it. **Static**, like
   * {@link capabilities}. `resolveEnv` reads this instead of hard-coding one
   * vendor's variable names, which is what keeps registering a provider a
   * one-line change.
   */
  readonly credentials: ProviderCredentialSpec;

  /**
   * What this provider can do. **Static** — it must be the same object for the
   * lifetime of the adapter, because the renderer caches it and builds a stable
   * UI from it. Build it by spreading `NO_CAPABILITIES` and switching on what
   * you support, so a capability added to the protocol later defaults to "off"
   * instead of breaking your build.
   */
  readonly capabilities: Capabilities;

  /**
   * Models this provider can be pointed at, in display order, first = default.
   * **Static**, like {@link capabilities}.
   *
   * Republished verbatim as `ProviderDescriptor.models` so the model picker is
   * built from the selected provider rather than a literal in the renderer —
   * the same rule that already governs backends, auth modes and permission
   * modes. Omit (or leave empty) for a provider with no model choice.
   */
  readonly models?: readonly ProviderModelOption[];

  /**
   * Reasoning-effort levels this provider accepts, least to most. **Static.**
   *
   * Republished as `ProviderDescriptor.effortLevels`. Omit for a provider where
   * the concept does not exist; the picker then renders disabled with that as
   * its reason rather than disappearing.
   */
  readonly effortLevels?: readonly ProviderEffortOption[];

  /**
   * Ask the installed provider what models it *actually* offers, right now.
   *
   * The live counterpart to the static {@link models} list, and the reason the
   * two are separate properties rather than one: {@link models} is a constant
   * the registry can republish in a descriptor without touching a subprocess,
   * while this contacts the provider with a real credential and can take
   * seconds. A UI that needs a list immediately reads the descriptor; a UI that
   * wants the truth calls this and swaps.
   *
   * Present **iff** the provider can enumerate its own catalogue. A provider
   * that cannot omits the property entirely — it does not implement it as a
   * stub returning {@link models}, because the caller reports *which* list the
   * user is looking at (`ProvidersModelsResponse.live`) and a stub would make
   * the built-in list claim to be confirmed by the account. With the method
   * absent, the static list stands and is labelled as such.
   *
   * Deliberately not paired with a {@link Capabilities} flag, unlike
   * {@link listSessions}. A capability flag exists so the UI can degrade
   * *before* calling — hide a history pane, disable a picker. There is nothing
   * to degrade here: the model picker renders from the descriptor either way,
   * and the only difference this makes is whether a background refresh
   * improves it. `typeof adapter.listModels === 'function'` is the whole test,
   * and it is made in exactly one place.
   *
   * Two obligations:
   *
   *  1. **Must not consume model tokens.** This runs on a boot path and may run
   *     again whenever a profile changes. Implementations use a control channel
   *     or a metadata call, never a turn.
   *  2. **Must resolve rather than reject.** No binary, no credential, no
   *     network — all of those are ordinary states of a desktop machine, and a
   *     model picker that renders empty is worse than one that renders slightly
   *     stale. Return the provider's own fallback list instead of throwing; the
   *     caller cannot tell a rejection apart from a crash and has no better
   *     list to substitute than the one you already have.
   *
   * ### Say which list you returned
   *
   * Obligation 2 has a consequence: because failure resolves, the caller cannot
   * otherwise tell a catalogue the account confirmed from one the adapter
   * guessed. So the return is a {@link ModelCatalogue} carrying an explicit
   * `live` flag rather than a bare array.
   *
   * An earlier draft signalled this with *reference identity* — fall back by
   * returning the very same array instance as {@link models}, and let the
   * caller compare. It worked, and it was one line shorter. It was also a trap:
   * `return [...FALLBACK]` is an utterly reasonable edit that would have
   * silently relabelled the built-in list as account-confirmed, with no test
   * failing and no way to notice from the UI. A flag whose correctness depends
   * on nobody ever copying an array is not a flag, it is a landmine. This is
   * the mechanism by which the settings screen tells the user "this is the
   * built-in list, Artemis could not reach the CLI" — it has to be robust, or it
   * is worse than absent.
   */
  listModels?(query: ModelListQuery): Promise<ModelCatalogue>;

  /**
   * The slash commands a session started here would offer.
   *
   * Exists so the composer's menu can open before the first message. The list
   * otherwise arrives only on `session.started`, which means it arrives only
   * after a run — and a slash command is a thing people reach for at the *start*
   * of a conversation, so the one moment the menu was reliably shut was the one
   * moment it was most wanted.
   *
   * Present **iff** the provider can enumerate its commands, on the same rule as
   * {@link listModels}: a provider that cannot omits the property rather than
   * stubbing it. There is no fallback list to stub *with* — unlike models, an
   * unenumerable provider has nothing static to offer — so an absent method and
   * an empty array mean the same thing to the caller (no menu), which is exactly
   * what happened before this existed.
   *
   * The same two obligations {@link listModels} carries, for the same reasons:
   *
   *  1. **Must not consume model tokens.** This runs when a column settles on an
   *     account, which is often, and on a directory change. Implementations use
   *     a control channel, never a turn.
   *  2. **Must resolve rather than reject.** A missing binary or credential is
   *     an ordinary state of a desktop machine, and the honest answer is an
   *     empty list — a menu that does not open, which is where this started.
   *
   * Names are returned exactly as the provider spells them, matching
   * `SessionStartedEvent.slashCommands`, so a consumer cannot tell which of the
   * two told it and does not have to care.
   */
  listCommands?(query: CommandListQuery): Promise<readonly string[]>;

  /**
   * Start a run.
   *
   * Rejects with an {@link AdapterError} for anything it cannot honour, and it
   * must be strict about this rather than degrading:
   *
   *  - a `permissionMode` outside {@link Capabilities.permissionModes} →
   *    `invalid_request`. Silently downgrading a permission mode is how you end
   *    up more permissive than the user asked for.
   *  - `resumeSessionId` without {@link Capabilities.resumeSession}, or
   *    `forkSession` without {@link Capabilities.forkSession} →
   *    `invalid_request`.
   *  - a relative `cwd` → `invalid_request`.
   *  - no provider binary / unsupported platform → `provider_not_found`.
   *
   * Resolving does **not** mean the provider has started. Events, including
   * `session.started`, may already be flowing before this promise settles —
   * subscribe to {@link Run.events} before awaiting anything else.
   */
  createRun(input: ResolvedRunInput): Promise<Run>;

  /**
   * Conversations this adapter is still holding background work for.
   *
   * Optional, and the honest default for a provider that has no notion of work
   * outliving a turn is to omit it: an empty array from an adapter that *could*
   * answer means "nothing is running", and one from an adapter that cannot
   * would be a claim it has no business making. Absent reads as "no opinion",
   * and the caller falls back to what it can see for itself.
   *
   * ## Why a caller cannot work this out
   *
   * `background.tasks` is a run event, so it stops arriving when the run ends —
   * and a backgrounded subagent, a workflow or a registered schedule routinely
   * outlives by minutes the turn that launched it. That leaves a window's
   * delegated rows frozen at the last moment a turn was open, which is precisely
   * the interval in which the interesting thing happens. Anything decided from
   * those rows in that interval is a guess: the sidebar's working marker, and —
   * far more expensively — whether a column may be thrown away.
   *
   * **Synchronous on purpose.** The answer is in memory, it is asked on a poll,
   * and a promise here would put a round trip in front of a fact the adapter
   * already holds. It must not spawn anything or touch the filesystem.
   */
  sessionsHoldingWork?(): readonly SessionId[];

  /**
   * The conversations with something *actually running* right now — an open
   * turn, a live background task, or a task settling into its follow-up turn.
   *
   * Deliberately narrower than {@link sessionsHoldingWork}, and the difference
   * is a registered schedule. Retention has to keep a scheduled conversation's
   * process alive indefinitely — nothing tells the adapter when a wakeup will
   * fire — but "kept alive for a timer" is not "working", and a sidebar that
   * drew the working marker from the retention set showed a spinner forever on
   * every conversation that had ever registered one. Retention answers "may
   * this be thrown away"; this answers "is it doing something right now".
   *
   * Same contract otherwise: synchronous, in-memory, poll-friendly, and a set
   * of conversations *known* to be working rather than a complement.
   */
  sessionsWorking?(): readonly SessionId[];

  /**
   * The delegated rows this adapter holds, per conversation.
   *
   * {@link sessionsHoldingWork} answers "keep this conversation alive"; this
   * answers "and here is what it has delegated". They are deliberately separate
   * calls returning deliberately different sets — a process kept open by a
   * registered schedule holds work and has no rows, and one whose tasks have all
   * settled has rows worth reading and holds nothing — so folding them together
   * would force each caller to re-derive the half it did not want.
   *
   * ## Why a caller cannot work this out
   *
   * Same reason as above, one step further. A window builds its rows from
   * `background.tasks`, which is run-scoped, is not emitted once the turn has
   * ended, and is retained only on the stream of the run that emitted it. A
   * window that reloads has no rows and no run to replay them from: the work it
   * is looking for was delegated by a turn that is over, and the live run is a
   * continuation whose retained events never mentioned it. The ledger on the
   * process is the only surviving copy, and this is the only way to ask for it.
   *
   * Optional, and absent reads as "no opinion" exactly as above. **Synchronous
   * on purpose**, for the same reason and under the same rules: it is polled, the
   * answer is already in memory, and it must not spawn anything or touch disk.
   */
  delegatedWork?(): readonly SessionDelegatedWork[];

  /**
   * List historical sessions.
   *
   * Present **iff** {@link Capabilities.listSessions} is true. A provider that
   * cannot enumerate history omits this property entirely rather than
   * implementing it as a stub that returns `[]` — the empty array is
   * indistinguishable from "no sessions yet", and the UI hides the history pane
   * on the capability flag, not on the result.
   */
  listSessions?(query: SessionListQuery): Promise<SessionListPage>;

  /**
   * List historical sessions across **every project**, for a set of profiles.
   *
   * Present only alongside {@link listSessions} — it answers the same question
   * without the cwd, so a provider that cannot enumerate history at all omits
   * both. Sessions are partitioned by (profile × project), and this walks the
   * whole partition space: it is what lets a sidebar show all past work grouped
   * by project and labelled by profile.
   *
   * Two obligations, both learned the hard way:
   *
   *  1. **`cwd` comes from the session data, never from the storage layout.**
   *     Claude's project directories are named by replacing every
   *     non-alphanumeric character in the path with `-`, which is lossy and
   *     ambiguous for any path containing a real hyphen. Decoding that name
   *     would confidently produce the wrong directory; the session record
   *     itself is authoritative. A session with no recoverable cwd is dropped
   *     rather than guessed at — it cannot be grouped, and it cannot be resumed
   *     into a directory nobody knows.
   *  2. **One bad profile must not fail the query.** See
   *     {@link AggregatedSessionList}.
   */
  listAllSessions?(query: AllSessionsQuery): Promise<AggregatedSessionList>;

  /**
   * Read one session's stored messages, replayed as events.
   *
   * Present alongside {@link listSessions}: a provider that can enumerate
   * history should be able to open it. Without this, selecting a session
   * resumes it against an empty transcript — the agent holds the whole
   * conversation in context while the user sees none of it.
   *
   * Returns the same {@link AgentEvent}s a live run emits, so the transcript
   * needs no second code path. Events are stamped with `query.runId` so
   * replayed history and anything sent next land in one continuous view.
   */
  getSessionMessages?(query: SessionMessagesQuery): Promise<SessionTranscript>;

  /**
   * Read one subagent's own conversation, replayed as events.
   *
   * Present **iff** {@link Capabilities.subagentTranscripts} is set, and the
   * reason both exist is that the parent session is not a record of this work.
   * A delegating turn stores the subagent's *final report* and nothing else —
   * not the reasoning, not the tool calls, not the failures — so the only place
   * the work exists is the subagent's own transcript beside its parent's.
   *
   * Keyed by the task id, which the provider also uses as the agent id. That is
   * not a coincidence worth hiding behind a mapping table: it is what makes a
   * row in a delegated-work list directly openable.
   *
   * @throws if the transcript cannot be read. A subagent that has not written
   *         anything yet is **not** an error — it answers with no events, which
   *         is how a just-started agent renders as empty rather than as broken.
   */
  getSubagentMessages?(query: SubagentMessagesQuery): Promise<SubagentTranscript>;

  /**
   * How many messages a session holds right now.
   *
   * Called once, by {@link import('../sessions/registry.js').RunRegistry}, in
   * the moment between resolving a run and spawning it — the only moment at
   * which the answer is the boundary between the conversation so far and what
   * this run is about to add. A count taken any later has the run's own output
   * in it.
   *
   * Present alongside {@link getSessionMessages}, and for its benefit: the
   * count is what lets a caller ask for "everything before this run" as
   * `limit`. A provider that cannot count leaves it off, and callers fall back
   * to showing the run alone rather than showing a conversation twice.
   *
   * @throws if the session cannot be read. Callers treat that as "no seam is
   *         known" — it must not fail the run it was called for.
   */
  countSessionMessages?(query: SessionMessageCountQuery): Promise<number>;

  /**
   * Name a session from its opening message, using the model the caller names.
   *
   * Present **iff** the provider can run a completion that is not a turn of the
   * user's conversation. Paired with {@link setSessionTitle}: naming a session
   * takes both, and `SessionNamer` skips a provider missing either.
   *
   * Deliberately not paired with a {@link Capabilities} flag, on the same
   * reasoning as {@link listModels}: a flag exists so the UI can degrade
   * *before* calling, and there is nothing here to degrade. Nothing is
   * rendered, nothing is offered, and a provider that cannot do it simply has
   * sessions named the way they were named before — by the provider's own
   * summary, or by the first prompt.
   *
   * Four obligations:
   *
   *  1. **It is not a run.** No tools, no filesystem settings, no permission
   *     prompts, and — where the provider can express it — no transcript
   *     written to the session store. A naming call that leaves a session
   *     behind would put a phantom row in the very list it exists to label.
   *  2. **Bounded.** One turn, a short output, and a timeout. This is spending
   *     the user's account on chrome; it must be small and it must end.
   *  3. **Resolve rather than reject.** No credential, no network, a model the
   *     account cannot use — all ordinary states, and none of them worth an
   *     error path in the caller. Return `null`, which reads as "no name",
   *     and the session keeps the title it would have had anyway.
   *  4. **Return a title or nothing.** Adapters clean their own output with
   *     `cleanSessionTitle`; a caller must never have to strip quotes,
   *     preambles or a stray code fence off a value from this method.
   */
  suggestSessionTitle?(query: SessionTitleQuery): Promise<string | null>;

  /**
   * Store a title against a past session, as if the user had renamed it.
   *
   * Present **iff** the provider's own session store has a title field Artemis
   * can write. That is what makes this the right place to keep a generated
   * name: it is the same field a rename writes, so the name survives, appears
   * in the provider's own tooling, and is read back by
   * {@link listSessions} without a second store to merge in.
   *
   * The consequence is deliberate and worth naming: `SessionSummary.titleIsCustom`
   * becomes true for a title Artemis generated rather than one the user typed.
   * The flag means "this session has a name of its own, not a summary the
   * provider derived", which is exactly what a generated name is — and it is
   * why naming happens **once, on a session's first turn**, where there is no
   * user-set title to overwrite.
   *
   * Unlike {@link suggestSessionTitle} this one may reject: it is a write, the
   * caller has already paid for the title, and "the store refused" is worth a
   * log line rather than silence.
   */
  setSessionTitle?(update: SessionTitleUpdate): Promise<void>;

  /**
   * Destroy a stored session's transcript. Irreversible.
   *
   * Present **iff** {@link Capabilities.deleteSession} is true, and it must be
   * a real deletion: the UI confirms this in front of the user on the promise
   * that the data is gone afterwards, so an adapter that hides rather than
   * removes must leave the capability off.
   *
   * Resolves `true` when this call removed something and `false` when there
   * was nothing left to remove. "Already gone" is not an error — the caller
   * asked for the session to not exist, and it does not.
   */
  deleteSession?(query: SessionDeleteQuery): Promise<boolean>;

  /**
   * Write the provider's own tag onto a stored session, or clear it.
   *
   * Present **iff** {@link Capabilities.tagSession} is true. This is what
   * archiving is built on, and the reason it is here rather than in the
   * renderer: a tag written into the provider's store is true of the session
   * everywhere it is read — another window, another build, another machine
   * against the same config directory. A list of ids kept by the app is true of
   * one installation and silently false everywhere else, which is precisely how
   * an archive goes missing.
   *
   * The value is passed through rather than interpreted. Artemis writes
   * {@link ARCHIVED_TAG} and reads anything else untouched, because the field
   * belongs to the provider and a session tagged from the CLI is not Artemis's
   * to rewrite.
   *
   * Resolves `true` when a session was found and written, `false` when there
   * was nothing there to tag — the same "already gone is not an error" rule
   * {@link deleteSession} follows.
   */
  tagSession?(query: SessionTagQuery): Promise<boolean>;

  /**
   * How this adapter confines the shell commands it runs, on this machine.
   *
   * Optional, and absent for every adapter that does not run commands itself.
   * Claude and Codex spawn their own CLI, which owns permission handling; only
   * the local providers build a shell tool and therefore have to confine it.
   * An adapter that does not implement this publishes no `sandbox` on its
   * descriptor, and the renderer shows nothing rather than inventing a label
   * for a confinement Artemis is not providing.
   *
   * Must be cheap and must not throw: it is called while building the provider
   * list, which the profile screen waits on.
   */
  describeSandbox?(): Promise<{
    readonly backend?: string;
    readonly confinement: 'workspace' | 'none';
    readonly verification: 'verified' | 'unverified';
    readonly detail: string;
  }>;

  /**
   * Probe whether this provider is usable on this machine.
   *
   * Must be cheap and must not throw — report trouble as
   * `{ available: false, unavailableReason }`. Omit the method entirely if the
   * provider is always available once registered; the registry then treats it
   * as available.
   *
   * The query is optional and often absent: `providers:list` asks before any
   * profile is chosen, and most providers answer the same way regardless —
   * a binary is on `PATH` or it is not. It matters for the providers that
   * *are* an endpoint, where "is this usable" is a question about the address
   * a profile names rather than about the machine.
   */
  checkAvailability?(query?: AvailabilityQuery): Promise<AdapterAvailability>;

  /**
   * How much of a plan's capacity this profile has consumed.
   *
   * Present **iff** {@link Capabilities.planUsageReporting} is true — with one
   * named exception: the artemis adapter declares the capability and does NOT
   * implement this, because a server profile's readings are per *served
   * account*, a fan-out this single-reading signature cannot carry. Its
   * callers (the plan-usage poller and `IPC.usagePlanRefresh`) branch on the
   * provider id and use `readRemotePlanUsage` instead; a caller that reaches
   * this method for artemis gets the capability-off answer below, which is
   * the safe wrong answer rather than a crash. Distinct
   * from the per-run counts on `usage` events: this describes the *account*.
   *
   * Three obligations:
   *
   *  1. **Must not consume model tokens.** Reading a gauge that costs money to
   *     read is a gauge nobody will open. Implementations should use a control
   *     channel, not a turn.
   *  2. **Must not throw for a profile that simply has no plan.** API-key,
   *     Bedrock and Vertex billing is metered rather than capped, so "no plan
   *     limits here" is a correct answer, not a failure: return
   *     `{ available: false, unavailableReason }`. Reserve rejection for a
   *     genuine fault, such as an unusable credential.
   *  3. **Must tolerate the provider withdrawing the underlying API.** The
   *     surface this is built on may be experimental; if it disappears, report
   *     it unavailable rather than breaking every caller.
   */
  fetchPlanUsage?(input: PlanUsageQuery): Promise<PlanUsage>;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The set of providers this Artemis build can drive. See `./registry.ts` for the
 * implementation and for the one-line registration point.
 */
export interface ProviderRegistry {
  /** Register an adapter. Throws on a duplicate id unless `replace` is set. */
  register(adapter: ProviderAdapter, options?: { readonly replace?: boolean }): void;
  /** Remove an adapter. Returns whether one was actually removed. */
  unregister(id: ProviderId): boolean;
  has(id: ProviderId): boolean;
  get(id: ProviderId): ProviderAdapter | undefined;
  /** Like {@link get}, but throws a `provider_not_found` {@link AdapterError}. */
  require(id: ProviderId): ProviderAdapter;
  /** Registered adapters, in `PROVIDER_IDS` display order. */
  list(): readonly ProviderAdapter[];
  /**
   * Renderer-safe descriptors for the `providers:list` IPC call.
   *
   * By default this includes providers that are *not* registered, marked
   * unavailable with a reason, so the UI can show "Codex — not yet supported"
   * instead of pretending the concept does not exist.
   */
  describe(options?: {
    /** Re-probe availability instead of returning the cached answer. */
    readonly refresh?: boolean;
    /** Include known-but-unregistered providers. Defaults to true. */
    readonly includeUnregistered?: boolean;
    /**
     * An environment to probe a provider with, when one is worth having.
     *
     * Exists for the providers that *are* an endpoint: "is llama.cpp usable"
     * is a question about the address a profile names, and probing the
     * flavour's default instead reports that nothing is answering on 8080 to
     * a user whose server is on 9090 and working.
     *
     * A callback rather than a map because resolving an environment touches
     * the filesystem and the secret store, and every provider but these three
     * answers the same without one. The registry stays profile-agnostic: it
     * knows how to ask, not which profile to ask about.
     */
    readonly envFor?: (id: ProviderId) => Promise<EnvBundle | undefined>;
  }): Promise<readonly ProviderDescriptor[]>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The error type the seam throws.
 *
 * A JavaScript `Error` does not survive structured clone with its type intact,
 * so everything that leaves the main process is reported as protocol's
 * {@link AgentError}. `AdapterError` is the throwable carrier for one: the IPC
 * layer catches it and puts {@link AdapterError.agentError} straight into an
 * `IpcFail`.
 */
export class AdapterError extends Error {
  /** The normalized, already-scrubbed error to report. */
  readonly agentError: AgentError;

  constructor(agentError: AgentError, options?: { cause?: unknown }) {
    super(agentError.message, options);
    this.name = 'AdapterError';
    this.agentError = agentError;
  }
}

/** True for an {@link AdapterError}, including across module realms. */
export function isAdapterError(value: unknown): value is AdapterError {
  return (
    value instanceof AdapterError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'AdapterError' &&
      typeof (value as { agentError?: unknown }).agentError === 'object')
  );
}

/** Convenience constructor for {@link AdapterError}. */
export function adapterError(
  code: AgentErrorCode,
  message: string,
  extra?: Omit<AgentError, 'code' | 'message'> & { readonly cause?: unknown },
): AdapterError {
  const { cause, ...rest } = extra ?? {};
  return new AdapterError(
    { code, message: scrubSecrets(message), ...rest },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Patterns that look like a credential in free text.
 *
 * A heuristic, not a proof. Adapters are supposed to keep secrets out of error
 * messages in the first place; this is the backstop for the case where a
 * provider echoes its own configuration into a failure string.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret)["'\s]*[:=]["'\s]*[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Redact anything credential-shaped from text that is about to be shown or logged. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const head = match.slice(0, Math.min(6, match.length));
      return `${head}…[redacted]`;
    });
  }
  return out;
}

/**
 * Normalize anything thrown into an {@link AgentError}.
 *
 * Used on every path where a provider's failure has to become something the UI
 * can render: adapter internals, the IPC dispatcher, and the run pump's
 * `catch`. Classification is best-effort — the taxonomy is deliberately small,
 * and detail belongs in `message`, not in a new code.
 */
export function toAgentError(error: unknown, fallbackCode: AgentErrorCode = 'unknown'): AgentError {
  if (isAdapterError(error)) return error.agentError;

  if (error instanceof Error) {
    const name = error.name;
    const message = scrubSecrets(error.message || name || 'Unknown error');

    if (name === 'AbortError' || /\baborted\b/i.test(message)) {
      return { code: 'cancelled', message, retryable: false };
    }

    const status = readHttpStatus(error);
    const code = classify(message, status) ?? fallbackCode;
    return {
      code,
      message,
      httpStatus: status,
      retryable: code === 'rate_limit' || code === 'network' || code === 'provider_unavailable',
    };
  }

  if (typeof error === 'string') {
    const message = scrubSecrets(error);
    return { code: classify(message, undefined) ?? fallbackCode, message };
  }

  return { code: fallbackCode, message: 'Unknown error' };
}

function readHttpStatus(error: Error): number | undefined {
  const candidate =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' ? candidate : undefined;
}

function classify(message: string, status: number | undefined): AgentErrorCode | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'billing';
  if (status !== undefined && status >= 500) return 'provider_unavailable';
  if (status === 400 || status === 422) return 'invalid_request';

  if (/\b(ENOENT|command not found|is not recognized)\b/i.test(message)) return 'provider_not_found';
  if (/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network)\b/i.test(message)) {
    return 'network';
  }
  if (/\b(EPIPE|closed unexpectedly|exited with code|stdio)\b/i.test(message)) return 'transport';
  if (/\brate limit|too many requests\b/i.test(message)) return 'rate_limit';
  if (/\b(unauthorized|invalid api key|authentication)\b/i.test(message)) return 'auth';
  if (/\b(credit balance|billing|payment)\b/i.test(message)) return 'billing';
  if (/\bmodel .*(not found|unavailable)|unknown model\b/i.test(message)) return 'model_unavailable';
  return undefined;
}
