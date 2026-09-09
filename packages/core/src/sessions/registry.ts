/**
 * The live-run registry.
 *
 * One process-wide, in-memory index of every run that is currently alive,
 * keyed by {@link RunId}. It owns three jobs:
 *
 *  1. **Start runs through an adapter** and keep the resulting {@link Run}
 *     handle, so the transport object never escapes into the main process.
 *  2. **Fan events out to subscribers.** A run has exactly one producer (the
 *     adapter's `events` iterable) and any number of consumers (the IPC push
 *     channel, tests, logging). Consumers come and go; the run does not care.
 *  3. **Guarantee termination.** Every run ends with exactly one `run.end`,
 *     even when the adapter forgets, throws, or hangs. The UI must never be
 *     left with a spinner it cannot clear.
 *
 * Nothing here is Electron-aware. The main process wires
 * {@link RunRegistry.subscribe} to `webContents.send(IPC_PUSH.agentEvent, …)`
 * and the IPC handlers to the methods below.
 *
 * ### Termination guarantee, precisely
 *
 * The registry emits a synthesised `run.end` when the adapter's stream:
 *
 * - completes without having emitted one  → `disposed` / `interrupted` /
 *   `completed`, depending on what was asked of it;
 * - throws                                → `error`, carrying the normalized
 *   {@link AgentError};
 * - fails to complete within
 *   {@link RunRegistryOptions.disposeTimeoutMs} of a `dispose()` → `disposed`.
 *
 * Synthesised events continue the run's `seq` numbering from the highest seq
 * seen, so a consumer sorting by `seq` still sees the end last.
 *
 * The one exception is the prompt each turn is recorded with, which reuses the
 * current seq rather than taking a new one and is never emitted — it exists so
 * a reloaded window can replay the message it asked for. See `#recordPrompt`.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AgentError,
  AgentErrorCode,
  AgentEvent,
  Attachment,
  Capabilities,
  MessageId,
  PermissionDecision,
  PermissionRequestId,
  ProfileId,
  ProviderId,
  RunEndEvent,
  RunEndReason,
  RunHandle,
  RunId,
  RunInput,
  SessionId,
  ToolServerConfig,
  Unsubscribe,
} from '@rx-artemis/protocol';
import { isFileAttachment, isImageAttachment } from '@rx-artemis/protocol';

import type {
  ConfigSource,
  ContinuationContext,
  EnvBundle,
  LocalPlugin,
  ProviderAdapter,
  ResolvedRunInput,
  Run,
} from '../adapters/types.js';
import { normalizeAgentError } from '../profiles/errors.js';
import { checkWorkingDirectory } from '../workspace/workdir.js';
import type { WorkingDirectoryCheck } from '../workspace/workdir.js';
import { RunError } from './errors.js';

/**
 * What a prompt is filed under: the run that carried it, and its place in that
 * run's send order.
 *
 * One function because three places have to agree on the spelling and cannot
 * see each other. The registry retains prompts under it, the adapter is handed
 * it so a delivered message can be named again, and a window claims it
 * optimistically the moment the user hits Enter — see
 * `TranscriptModel.pushUserMessage`. The scheme is the contract, not an
 * implementation detail of any one of them.
 */
export function promptMessageId(runId: RunId, ordinal: number): MessageId {
  return `${runId}:prompt:${String(ordinal)}`;
}

/**
 * How the registry finds the adapter for a provider.
 *
 * A plain function rather than the adapter registry's own type, so the two
 * modules stay decoupled and a caller can supply a one-off lookup in a test:
 * `resolveAdapter: () => fakeAdapter`.
 */
export type AdapterResolver = (
  providerId: ProviderId,
) => ProviderAdapter | undefined | Promise<ProviderAdapter | undefined>;

/**
 * The parts of a {@link ResolvedRunInput} that only the host process can
 * supply — everything a renderer must not be allowed to choose.
 */
export interface RunResolution {
  /**
   * The provider environment for this run: the credential or backend flag, the
   * isolated config directory, and the profile's `publicEnv`. Built by
   * `resolveEnv(profile, secrets, …)` in the main process.
   */
  readonly env: EnvBundle;
  /** Spread the host environment underneath {@link env}. Adapter default applies when omitted. */
  readonly inheritHostEnv?: boolean;
  /** On-disk configuration layers this run may inherit. */
  readonly settingSources?: readonly ConfigSource[];
  /**
   * Plugin directories this run loads — the channel the user's skills arrive
   * on. Absolute paths, so they are resolved here and never sent by a renderer.
   */
  readonly plugins?: readonly LocalPlugin[];
  /**
   * Tool servers this run may reach, read from the profile.
   *
   * Resolved here for the same reason `plugins` is: an entry can name a command
   * to spawn, and a renderer that could send one could have any binary on the
   * machine started under the agent's environment. What crosses the IPC
   * boundary is the profile id; what comes back is what that profile recorded.
   */
  readonly toolServers?: readonly ToolServerConfig[];
  /** Cancels the run from the outside — window close, app shutdown. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Turns a renderer's {@link RunInput} into the credentials and paths an
 * adapter needs.
 *
 * Injected rather than imported so the registry never touches the profile
 * store or the secret store directly: `sessions` stays a pure orchestration
 * layer, and the one place credentials are read stays in the main process
 * wiring. The `runId` is already minted when this is called, so a resolver can
 * key per-run state on it.
 */
export type RunResolver = (
  input: RunInput & { readonly runId: RunId },
) => RunResolution | Promise<RunResolution>;

/**
 * How the registry decides whether a run's `cwd` is usable.
 *
 * A seam rather than a direct import so a test can start a run in `/repo`
 * without creating one, and so a future host with a virtual filesystem can
 * answer the question its own way. Defaults to
 * {@link import('../workspace/workdir.js').checkWorkingDirectory}, which is the
 * real `stat`.
 */
export type WorkingDirectoryChecker = (
  cwd: string,
) => WorkingDirectoryCheck | Promise<WorkingDirectoryCheck>;

/**
 * A handle as the outside world reads it: the stored snapshot, stamped with
 * how far the stream has got.
 *
 * Stamped at read time rather than kept on the stored handle, because the
 * stored handle is replaced only on *transitions* — start, session id, end —
 * while `maxSeq` moves on every event. Rebuilding the handle per event to
 * carry one number would turn the hottest path in the registry into an
 * allocator; reading the number when somebody asks costs one property. What
 * the number buys is written on {@link RunHandle.lastSeq}: a window can tell
 * a quiet stream from a lost one without fetching the stream.
 */
function snapshot(entry: RunEntry): RunHandle {
  const stamped = entry.maxSeq < 0 ? entry.handle : { ...entry.handle, lastSeq: entry.maxSeq };
  // Same read-time stamping as `lastSeq`, for the same reason: the count moves
  // per send while the stored handle is replaced only on transitions. See
  // `RunHandle.promptCount` on what an adopting window does with it.
  return entry.prompts > 0 ? { ...stamped, promptCount: entry.prompts } : stamped;
}

/** Receives every event of the runs it is subscribed to. */
export type RunEventListener = (event: AgentEvent) => void;

/**
 * Where a swallowed error came from.
 *
 * `start` is for the work around starting a run that the run does not depend
 * on — measuring the session's history, so far. A failure there is reported and
 * dropped; anything the run *does* depend on throws instead.
 */
export type RunErrorPhase = 'start' | 'events' | 'listener' | 'dispose';

/** Reports failures the registry handled rather than propagated. */
export type RunErrorReporter = (
  error: unknown,
  context: { readonly runId: RunId; readonly phase: RunErrorPhase },
) => void;

/**
 * The identifiers every lifecycle notification carries.
 *
 * Ids and names only, by contract: these events exist to be written into the
 * session-lifecycle log, whose whole redaction rule is that nothing
 * content-bearing — no prompt text, no message content, no tokens — is ever on
 * one. `cwd` is the pane's project directory, which is what locates the
 * incident; the sessionId is present from the moment the run knows it.
 */
export interface RunLifecycleBase {
  readonly runId: RunId;
  readonly profileId: ProfileId;
  readonly providerId: ProviderId;
  readonly cwd: string;
  readonly sessionId?: SessionId;
}

/**
 * One run-lifecycle transition, as {@link RunRegistryOptions.onLifecycle}
 * hears it.
 *
 * Four transitions plus one promotion, together the run's whole biography:
 *
 * - `run.requested` — {@link RunRegistry.start} was asked. Logged before the
 *   credential resolution and the adapter's own construction, which is the
 *   one stretch of a run's life the log used to be blind to: everything in it
 *   ran before `run.started` was stamped, so a stall there — a key manager
 *   round trip, a keychain that will not answer, a plugin scan on a slow disk
 *   — left a user watching "starting the provider" over a log that says the
 *   run started instantly. The gap between this line and `run.started` is
 *   that stretch, measured.
 * - `run.started` — {@link RunRegistry.start} accepted it. Carries
 *   `resumeSessionId` when the run continues a stored conversation, so a
 *   continuation is distinguishable from a fresh session before any session id
 *   is known — and `resolveMs`, the requested-to-started stretch as one
 *   number, so a slow start is attributable without timestamp arithmetic.
 * - `run.session` — the provider announced which session the run writes into.
 *   Logged separately because a fresh run has no session id at start, and a
 *   crash between start and end would otherwise leave no way to connect the
 *   run to the session file it died writing.
 * - `run.adopted` — the provider opened a turn nobody asked for and
 *   {@link RunRegistry.adopt} took it on.
 * - `run.ended` — the run's one `run.end` was ingested. `synthesized` says
 *   whether the adapter produced it or the registry had to invent it, which is
 *   precisely the distinction the phantom-done forensics lacked.
 * - `run.released` — the registry let go of the run: `mode: 'released'` left
 *   the adapter's process alive on purpose, `mode: 'disposed'` tore it down.
 */
export type RunLifecycleEvent =
  | (RunLifecycleBase & { readonly kind: 'run.requested'; readonly resumeSessionId?: SessionId })
  | (RunLifecycleBase & {
      readonly kind: 'run.started';
      readonly resumeSessionId?: SessionId;
      readonly resolveMs?: number;
    })
  | (RunLifecycleBase & { readonly kind: 'run.session'; readonly sessionId: SessionId })
  | (RunLifecycleBase & { readonly kind: 'run.adopted' })
  | (RunLifecycleBase & {
      readonly kind: 'run.ended';
      readonly reason: RunEndReason;
      readonly synthesized: boolean;
    })
  | (RunLifecycleBase & { readonly kind: 'run.released'; readonly mode: 'released' | 'disposed' });

/** Hears every {@link RunLifecycleEvent}. */
export type RunLifecycleListener = (event: RunLifecycleEvent) => void;

/** Construction options for {@link RunRegistry}. */
export interface RunRegistryOptions {
  /** Provider → adapter lookup. */
  readonly resolveAdapter: AdapterResolver;
  /**
   * Profile → environment resolution, called once per run just before
   * `createRun`. This is the seam through which credentials reach an adapter;
   * they are never held by the registry itself.
   */
  readonly resolveRun: RunResolver;
  /**
   * Whether a run's `cwd` is a real, readable directory.
   *
   * Defaults to the filesystem check in `@rx-artemis/core/workspace`. Runs are
   * rejected before {@link RunResolver} is called, so a bad directory costs
   * neither a credential decryption nor a subprocess — and, more importantly,
   * never reaches `spawn`, where a bad cwd surfaces as an `ENOENT` that
   * provider SDKs misattribute to their own binary.
   */
  readonly checkWorkingDirectory?: WorkingDirectoryChecker;
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number;
  /** Run-id generator, injectable for deterministic tests. */
  readonly newRunId?: () => RunId;
  /**
   * How many events to retain per run for {@link RunRegistry.eventsSince}, so
   * a renderer that reloaded mid-run can catch up. `0` disables retention.
   * Defaults to 1000.
   */
  readonly historyLimit?: number;
  /**
   * How many finished runs to keep around for late replay and idempotent
   * `dispose`. Defaults to 32.
   */
  readonly endedRetention?: number;
  /**
   * How long `dispose()` waits for the adapter's stream to finish before
   * synthesising `run.end` itself. Defaults to 5000 ms. `0` disables the
   * timeout and waits indefinitely — do not do that on a shutdown path.
   */
  readonly disposeTimeoutMs?: number;
  /**
   * Called for errors the registry deliberately swallows: a subscriber that
   * threw, an adapter whose stream failed, a `dispose()` that rejected.
   *
   * Defaults to doing nothing. The host process should pass a logger —
   * without one, a throwing subscriber fails silently.
   */
  readonly onError?: RunErrorReporter;
  /**
   * Hears every lifecycle transition — started, session known, adopted, ended,
   * released — carrying ids only. The host wires this to the session-lifecycle
   * log; see {@link RunLifecycleEvent} for the exact vocabulary.
   *
   * Observation, not participation: a listener that throws is reported through
   * {@link onError} and cannot affect the run.
   */
  readonly onLifecycle?: RunLifecycleListener;
}

/**
 * Result of {@link RunRegistry.send}. Shaped for `RunsSendResponse`.
 *
 * Named distinctly from the adapter seam's `SendResult`, which is the same
 * answer without the run id.
 */
export interface RunSendOutcome {
  readonly runId: RunId;
  /**
   * False when the provider queued the text for the next turn rather than
   * steering the current one — the case for adapters without
   * `capabilities.midRunSteering`.
   */
  readonly deliveredImmediately: boolean;
}

/** Result of {@link RunRegistry.interrupt}. Shaped for `RunsInterruptResponse`. */
export interface RunInterruptOutcome {
  readonly runId: RunId;
  /** Ids of messages that were queued and will still run unless cancelled. */
  readonly stillQueued: readonly string[];
}

/** Result of {@link RunRegistry.dispose}. Shaped for `RunsDisposeResponse`. */
export interface RunDisposeOutcome {
  readonly runId: RunId;
}

/** Everything the registry tracks for one live run. */
interface RunEntry {
  handle: RunHandle;
  readonly run: Run;
  /** Permission requests raised but not yet answered. */
  readonly pending: Set<PermissionRequestId>;
  /** Bounded replay buffer. */
  readonly history: AgentEvent[];
  /** Subscribers scoped to this run. */
  readonly listeners: Set<RunEventListener>;
  /** How many prompts have been recorded into `history`, for message ids. */
  prompts: number;
  maxSeq: number;
  ended: boolean;
  finalized: boolean;
  disposed: boolean;
  /**
   * The run ended and was let go of without a teardown — see {@link Run.release}.
   *
   * Tracked apart from `disposed` because it is a weaker statement: the adapter
   * may still be holding a process for this conversation, and shutdown has to be
   * able to take that down.
   */
  released: boolean;
  disposeRequested: boolean;
  interruptRequested: boolean;
  /**
   * The `run.end` being ingested was invented by {@link #synthesizeEnd} rather
   * than produced by the adapter. Carried on the entry because by the time the
   * event reaches {@link #ingest} the two paths are one, and the lifecycle log
   * exists to tell them apart — a synthesized end is the registry papering over
   * exactly the upstream loss the log is meant to catch.
   */
  syntheticEnd: boolean;
  pump: Promise<void>;
}

const DEFAULT_HISTORY_LIMIT = 1000;
const DEFAULT_ENDED_RETENTION = 32;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
/**
 * How many finalized run *ids* to remember after their entries are evicted.
 *
 * Generous where {@link DEFAULT_ENDED_RETENTION} is tight, because the costs
 * are three orders of magnitude apart: an ended entry holds its event history,
 * a retired id is a string. The bound exists only so a process that runs for
 * months cannot grow without limit, and it is sized so that falling off the
 * end takes longer than any window plausibly sits stale.
 */
const RETIRED_ID_RETENTION = 10_000;

/**
 * In-memory index of active runs.
 *
 * Create one per application. Call {@link disposeAll} on shutdown.
 */
export class RunRegistry {
  readonly #resolveAdapter: AdapterResolver;
  readonly #resolveRun: RunResolver;
  readonly #checkWorkingDirectory: WorkingDirectoryChecker;
  readonly #now: () => number;
  readonly #newRunId: () => RunId;
  readonly #historyLimit: number;
  readonly #endedRetention: number;
  readonly #disposeTimeoutMs: number;
  readonly #onError: RunErrorReporter | undefined;
  readonly #onLifecycle: RunLifecycleListener | undefined;

  /** Runs that have not emitted `run.end` yet. */
  readonly #runs = new Map<RunId, RunEntry>();
  /** Recently finished runs, kept for late replay and idempotent dispose. */
  readonly #ended = new Map<RunId, RunEntry>();
  /**
   * Every run id this registry ever finalized, long after its entry is gone.
   *
   * `#ended` keeps whole entries — event buffers included — so it is small by
   * necessity, and an entry falling off its end used to take the *fact that
   * the run existed* with it. That mattered because "already ended" and "never
   * existed" are different refusals with opposite recoveries — see
   * {@link #requireActive} — and a renderer that missed a `run.end` (a machine
   * asleep, a dropped event) would come back hours later, steer the run it
   * still believed live, and be told `run_unknown`: the one refusal its
   * recovery path rightly refuses to forgive. The user's message went nowhere.
   *
   * Ids are a few dozen bytes, so remembering them costs nothing worth
   * counting: this holds the last {@link RETIRED_ID_RETENTION} of them,
   * insertion-ordered, evicted oldest-first. A stale send now gets
   * `run_ended` — the race it actually is — for as long as any plausible
   * window sits stale.
   */
  readonly #retired = new Set<RunId>();
  /** Run ids reserved by an in-flight `start()`, to close the race window. */
  readonly #starting = new Set<RunId>();
  /** Subscribers to every run. */
  readonly #listeners = new Set<RunEventListener>();

  #closed = false;

  constructor(options: RunRegistryOptions) {
    this.#resolveAdapter = options.resolveAdapter;
    this.#resolveRun = options.resolveRun;
    this.#checkWorkingDirectory = options.checkWorkingDirectory ?? checkWorkingDirectory;
    this.#now = options.now ?? (() => Date.now());
    this.#newRunId = options.newRunId ?? (() => randomUUID());
    this.#historyLimit = Math.max(0, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.#endedRetention = Math.max(0, options.endedRetention ?? DEFAULT_ENDED_RETENTION);
    this.#disposeTimeoutMs = Math.max(0, options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS);
    this.#onError = options.onError;
    this.#onLifecycle = options.onLifecycle;
  }

  /* ---------------------------------------------------------------------- */
  /* Subscriptions                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Subscribe to every run's events.
   *
   * This is the main process's whole live feed: one listener that forwards to
   * `IPC_PUSH.agentEvent`. A listener that throws is reported through
   * {@link RunRegistryOptions.onError} and otherwise ignored — a renderer that
   * went away mid-run must not take the agent down with it.
   */
  subscribe(listener: RunEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Subscribe to one run's events.
   *
   * Unsubscribing is safe at any time, including from inside the listener and
   * after the run has ended.
   */
  subscribeToRun(runId: RunId, listener: RunEventListener): Unsubscribe {
    const entry = this.#find(runId);
    if (!entry) throw new RunError('invalid_request', `Unknown run "${runId}"`);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /**
   * Events retained for a run with `seq` greater than `afterSeq`.
   *
   * For a renderer that reloaded and needs to catch up. Returns an empty array
   * for an unknown or long-finished run; the buffer is bounded by
   * {@link RunRegistryOptions.historyLimit}, so a very long run may have
   * dropped its earliest events.
   *
   * Includes the prompts the run was asked, which the adapter's own stream does
   * not carry — see `#recordPrompt`. They sit in the buffer where they were
   * sent, so insertion order is the order to apply them in; their `seq` repeats
   * the neighbouring event's rather than taking a slot of its own.
   */
  eventsSince(runId: RunId, afterSeq = -1): readonly AgentEvent[] {
    const entry = this.#find(runId);
    if (!entry) return [];
    return entry.history.filter((event) => event.seq > afterSeq);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Live runs, optionally narrowed to one working directory. */
  list(cwd?: string): readonly RunHandle[] {
    const handles = [...this.#runs.values()].map((entry) => snapshot(entry));
    return cwd === undefined ? handles : handles.filter((handle) => handle.cwd === cwd);
  }

  /** One run's handle — live or recently finished — or `undefined`. */
  get(runId: RunId): RunHandle | undefined {
    const entry = this.#find(runId);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** True when the run is live (it has not emitted `run.end`). */
  isActive(runId: RunId): boolean {
    return this.#runs.has(runId);
  }

  /** Number of live runs. */
  get activeCount(): number {
    return this.#runs.size;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Start a run.
   *
   * Resolves once the adapter has accepted the run and returned a
   * {@link Run}; events may already be flowing by then, so subscribe first.
   *
   * The returned {@link RunHandle} is a snapshot. Handles are immutable and
   * replaced as the run progresses — call {@link get} for the current one.
   *
   * @throws {RunError} `cancelled` when the registry is shutting down.
   * @throws {RunError} `provider_not_found` when no adapter is registered.
   * @throws {RunError} `invalid_request` for a duplicate run id, a request the
   *         adapter's capabilities do not cover, or a `cwd` that is relative,
   *         missing, not a directory, or unreadable.
   */
  async start(input: RunInput): Promise<RunHandle> {
    if (this.#closed) {
      throw new RunError('cancelled', 'The engine is shutting down and cannot start new runs');
    }

    const adapter = await this.#adapterFor(input.providerId);
    assertRunnable(input, adapter);
    // Before `resolveRun`, so a typo in a folder name costs neither a
    // credential decryption nor a subprocess — and so the failure is a sentence
    // about a directory rather than an ENOENT the provider blames on itself.
    //
    // Skipped for a remote session store, where the cwd names a directory on
    // the *serving* machine: nothing here will spawn in it, the wire never
    // carries it, and demanding it exist locally refuses every served session
    // — a Windows client resuming one pinned to `/work/app` would stat
    // `C:\work\app` and fail on a directory it was never going to use.
    if (adapter.credentials.sessionStore !== 'remote') {
      await this.#assertWorkingDirectory(input.cwd);
    }

    const runId = input.runId ?? this.#newRunId();
    if (this.#runs.has(runId) || this.#starting.has(runId)) {
      throw new RunError('invalid_request', `Run "${runId}" is already active`);
    }
    // A retired id is just as taken, exactly as `adopt` treats it: `#ended`
    // still answers `eventsSince` and `dispose` for that id, so a new run
    // wearing it would replay a finished transcript ahead of its own events
    // and hand its teardown to the old entry. Ids are minted fresh; reuse is
    // a caller bug worth failing loudly — and `#retired` keeps the refusal
    // standing after the entry itself has been evicted.
    if (this.#ended.has(runId) || this.#retired.has(runId)) {
      throw new RunError('invalid_request', `Run "${runId}" has already ended; run ids are not reusable`);
    }

    // Reserve before awaiting, so two concurrent starts with the same
    // caller-supplied id cannot both get through.
    this.#starting.add(runId);
    // Before the first await, so the stretch between here and `run.started` —
    // credential resolution, the seam count, the adapter's own construction —
    // is on the record even when something in it hangs and `run.started`
    // never lands. See the lifecycle union's comment for why this line exists.
    this.#noteLifecycle({
      kind: 'run.requested',
      runId,
      profileId: input.profileId,
      providerId: input.providerId,
      cwd: input.cwd,
      ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
    });
    const requestedAt = this.#now();
    let run: Run;
    // See `RunHandle.historyOffset`. A new session has nothing before it, so
    // the seam is 0 and no read is needed.
    let historyOffset: number | undefined = input.resumeSessionId === undefined ? 0 : undefined;
    try {
      // Credentials are resolved here and handed straight to the adapter. The
      // registry does not keep the bundle: after this line the only thing that
      // holds it is the provider transport.
      const resolution = await this.#resolveRun({ ...input, runId });

      /*
       * The seam, taken before the provider is spawned.
       *
       * Placement is the whole point and is not free to move: one line later
       * the CLI has written the user's message into the session file, and the
       * count is a message too large. There is no way to correct it afterwards,
       * because nothing distinguishes the run's own first message from the last
       * of the previous turn.
       *
       * It reuses the run's own environment rather than resolving a read-only
       * one. That looks like a credential on a read, and is not: the bundle was
       * decrypted on the line above for the run itself, and only its config
       * directory is used here — asking for a second bundle would mean a second
       * decryption for the same run.
       *
       * A failure is swallowed. The count buys a nicer transcript after a
       * reload; a run must never fail to start because history could not be
       * measured.
       */
      if (input.resumeSessionId !== undefined && adapter.countSessionMessages !== undefined) {
        try {
          historyOffset = await adapter.countSessionMessages({
            sessionId: input.resumeSessionId,
            cwd: input.cwd,
            env: resolution.env,
          });
        } catch (error) {
          this.#report(error, runId, 'start');
        }
      }

      const resolved: ResolvedRunInput = { ...input, ...resolution, runId };
      run = await adapter.createRun(resolved);
    } catch (error) {
      throw asRunError(error, 'transport', `Could not start a ${input.providerId} run`);
    } finally {
      this.#starting.delete(runId);
    }

    const handle: RunHandle = {
      runId,
      providerId: input.providerId,
      profileId: input.profileId,
      cwd: input.cwd,
      status: 'starting',
      capabilities: adapter.capabilities,
      startedAt: this.#now(),
      metadata: input.metadata,
      ...(historyOffset === undefined ? {} : { historyOffset }),
    };

    this.#register(handle, run, input.prompt);
    this.#noteLifecycle({
      kind: 'run.started',
      runId,
      profileId: input.profileId,
      providerId: input.providerId,
      cwd: input.cwd,
      resolveMs: this.#now() - requestedAt,
      // The one content-free fact that separates a continuation from a fresh
      // session before any session id is announced.
      ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
    });
    return handle;
  }

  /**
   * Take on a run this registry did not start.
   *
   * The provider can open a turn nobody asked for: it answers when background
   * work settles, and a subagent that outlived its own turn can park on a
   * permission prompt. The adapter builds the {@link Run} for those — it is the
   * only thing that can — and hands it up here, because ids, the replay buffer
   * and the event fan-out belong to the registry. From this line on the run is
   * indistinguishable from one {@link start} produced: same entry, same pump,
   * same guarantee of exactly one `run.end`.
   *
   * Synchronous, unlike `start`, and it has to be: it is called from inside the
   * adapter's own event pump, and every fact it would otherwise have to look up
   * — capabilities, the conversation, whose account and which directory — is
   * already fixed on the run or the process that opened it.
   *
   * No `historyOffset`. The seam it measures is "how much of the session file
   * predates this run", and there is no honest answer here: by the time a turn
   * announces itself the provider has already written part of it. Absent means
   * "this cannot be counted", which is a case the renderer already handles by
   * showing no earlier history rather than a duplicated turn — and the pane this
   * lands in is normally the one that has the conversation on screen already.
   *
   * @throws {RunError} `cancelled` when the registry is shutting down.
   * @throws {RunError} `invalid_request` when the run id is already known.
   */
  adopt(run: Run, context: ContinuationContext): RunHandle {
    if (this.#closed) {
      throw new RunError('cancelled', 'The engine is shutting down and cannot adopt runs');
    }
    const runId = run.runId;
    if (
      this.#runs.has(runId) ||
      this.#starting.has(runId) ||
      this.#ended.has(runId) ||
      this.#retired.has(runId)
    ) {
      throw new RunError('invalid_request', `Run "${runId}" is already known`);
    }

    const handle: RunHandle = {
      runId,
      providerId: context.providerId,
      profileId: context.profileId,
      cwd: context.cwd,
      // Already under way — the turn exists because the provider started it.
      // `starting` would describe a run waiting on a spawn that already happened.
      status: 'running',
      capabilities: run.capabilities,
      startedAt: this.#now(),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    };

    this.#register(handle, run);
    this.#noteLifecycle({
      kind: 'run.adopted',
      runId,
      profileId: context.profileId,
      providerId: context.providerId,
      cwd: context.cwd,
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    });
    return handle;
  }

  /**
   * Index a run and start draining it. The one place a {@link RunEntry} is built.
   *
   * `prompt` is the message the run was started with, and is recorded into the
   * replay buffer before the pump so it lands ahead of the provider's first
   * event — the question has to come before the answer. Omitted by {@link adopt},
   * where nobody typed anything.
   */
  #register(handle: RunHandle, run: Run, prompt?: string): RunEntry {
    const entry: RunEntry = {
      handle,
      run,
      pending: new Set(),
      history: [],
      listeners: new Set(),
      prompts: 0,
      maxSeq: -1,
      ended: false,
      finalized: false,
      disposed: false,
      released: false,
      disposeRequested: false,
      interruptRequested: false,
      syntheticEnd: false,
      pump: Promise.resolve(),
    };
    this.#runs.set(handle.runId, entry);
    if (prompt !== undefined) this.#recordPrompt(entry, prompt);
    // The pump handles its own failures; the `catch` is belt-and-braces so an
    // unexpected one can never surface as an unhandled rejection.
    entry.pump = this.#pump(entry).catch(() => undefined);
    return entry;
  }

  /**
   * Put a prompt into the run's replay buffer, without emitting it.
   *
   * The user's own message is the one part of a turn the event stream does not
   * carry. Providers echo it back, and the Claude mapper deliberately drops the
   * echo because the renderer drew the message optimistically the moment it was
   * typed (see `isHumanTurn`). That is right for as long as the window lives,
   * and it is exactly what a reload takes away: `runs.events` was then a
   * complete record of the turn apart from the sentence that started it, so ⌘R
   * mid-run redrew the agent's work under no question at all. On a session that
   * had only just started, the whole conversation came back headless.
   *
   * Retained, not emitted. Every live listener already has the optimistic row,
   * and `confirmUserMessage` has by then taken it out of the queue that
   * reconciles echoes — a second copy would render the prompt twice rather than
   * merge with it. This is only ever read back by a window that lost the first.
   *
   * `seq` is the run's current position rather than a fresh number, which is
   * the one subtlety worth stating: the numbering belongs to the adapter and is
   * contracted to be dense from 0, so consuming a slot here would either open a
   * gap the transcript reports as dropped events, or push `run.end` past a seq
   * the adapter still means to use. Order comes from the buffer itself —
   * {@link eventsSince} returns it in insertion order — so the duplicate value
   * costs nothing.
   *
   * Attachments are not recorded. The event union carries text, and a replay is
   * not the place to push base64 back across IPC; `mapUserMessage` makes the
   * same trade for a replayed image.
   */
  #recordPrompt(entry: RunEntry, text: string): void {
    if (text.length === 0) return;
    entry.prompts += 1;
    this.#retain(entry, {
      type: 'text.complete',
      runId: entry.handle.runId,
      seq: Math.max(entry.maxSeq, 0),
      ts: this.#now(),
      messageId: promptMessageId(entry.handle.runId, entry.prompts),
      role: 'user',
      text,
      replay: true,
    });
  }

  /**
   * The id the *next* prompt on this run will be filed under.
   *
   * Read before the send rather than after it, because the adapter has to be
   * told the name while it still has the message in its hands — it is what a
   * `message.delivered` will be reported under once the provider reads it, and
   * the only id both ends can speak. Deliberately does not advance the counter:
   * `#recordPrompt` still does that, and still only after the adapter has
   * accepted the text, so a refused message neither claims a number nor sits in
   * the replay buffer as though it had been asked.
   *
   * The prediction is safe because nothing else numbers prompts on this entry
   * and `send` is not re-entered between the two calls — the same reasoning a
   * window uses to claim the id optimistically the moment the user hits Enter.
   */
  #nextPromptId(entry: RunEntry): MessageId {
    return promptMessageId(entry.handle.runId, entry.prompts + 1);
  }

  /**
   * Send another message into a live run.
   *
   * Whether this steers the current turn or queues for the next one is the
   * adapter's business; the answer is reported in
   * {@link SendResult.deliveredImmediately}, derived from the adapter's
   * `midRunSteering` capability.
   */
  async send(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<RunSendOutcome> {
    const entry = this.#requireActive(runId);
    // The same refusal `assertRunnable` makes for a starting run, so an
    // attachment cannot reach an adapter that cannot take one by the mid-run
    // route.
    const unsupported = unsupportedAttachment(attachments, entry.handle.capabilities);
    if (unsupported !== undefined) {
      throw new RunError(
        'invalid_request',
        `Provider "${entry.handle.providerId}" cannot accept ${unsupported} in a prompt`,
      );
    }
    /*
     * Handed down so the adapter can say later that this exact message was
     * read. A steer is queued far more often than it is taken immediately, and
     * until an adapter could name the one it had just consumed, the only thing
     * that ever cleared a "queued" indicator was the end of the run.
     *
     * Empty text is not numbered — `#recordPrompt` skips it — so nothing is
     * claimed for a message that will never be retained.
     */
    const messageId = text.length === 0 ? undefined : this.#nextPromptId(entry);
    const result = await entry.run.send(text, attachments, messageId);
    // After the adapter took it, so a message that was refused does not sit in
    // the replay as though it had been asked. See `#recordPrompt`: without this
    // a reload loses every mid-run steer the same way it lost the opening
    // prompt, and those are the ones with no session file to fall back on.
    this.#recordPrompt(entry, text);
    // Trust the adapter's own answer; fall back to its advertised capability
    // only if it returned nothing.
    const deliveredImmediately =
      typeof result?.deliveredImmediately === 'boolean'
        ? result.deliveredImmediately
        : entry.handle.capabilities.midRunSteering;
    return { runId, deliveredImmediately };
  }

  /**
   * Ask a live run to stop what it is doing.
   *
   * Interrupting does not end the run by itself — the adapter decides, and the
   * run ends when `run.end` arrives.
   */
  async interrupt(runId: RunId): Promise<RunInterruptOutcome> {
    // "Stop" is idempotent by nature. A run that ended between the user
    // pressing the button and the IPC call landing is a race, not a mistake —
    // reporting an error for it would put a toast on screen for nothing.
    // An id that never existed still throws: that is a real bug.
    if (!this.#runs.has(runId) && this.#ended.has(runId)) {
      return { runId, stillQueued: [] };
    }

    const entry = this.#requireActive(runId);
    entry.interruptRequested = true;
    const result = await entry.run.interrupt();
    return { runId, stillQueued: readStillQueued(result) };
  }

  /**
   * Stop one delegated task, leaving the run and its other tasks alone.
   *
   * Resolved against live *and* finished runs, which is not the leniency it
   * looks like: a task worth stopping has by definition outlived the turn that
   * launched it, so the run the user is looking at has usually ended. Refusing
   * on that basis would refuse every stop that matters.
   *
   * @throws {RunError} `invalid_request` for an unknown run, or a provider with
   *         no concept of delegated work to stop.
   */
  async stopTask(runId: RunId, taskId: string): Promise<void> {
    const entry = this.#find(runId);
    if (!entry) throw new RunError('invalid_request', `Unknown run "${runId}"`);
    if (entry.run.stopTask === undefined) {
      throw new RunError(
        'invalid_request',
        `Provider "${entry.handle.providerId}" cannot stop delegated tasks`,
      );
    }
    await entry.run.stopTask(taskId);
  }

  /**
   * Answer an outstanding permission request.
   *
   * @throws {RunError} `invalid_request` when the run has no such open
   *         request — a stale click from a reloaded renderer, or a
   *         double-answer.
   */
  async respondToPermission(
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    const entry = this.#requireActive(runId);
    if (!entry.handle.capabilities.interactivePermissions) {
      throw new RunError(
        'invalid_request',
        `Provider "${entry.handle.providerId}" does not use interactive permissions`,
      );
    }
    if (!entry.pending.has(requestId)) {
      throw new RunError(
        'invalid_request',
        `Run "${runId}" has no open permission request "${requestId}"`,
      );
    }

    // Clear first so a duplicate answer cannot reach the adapter twice; put it
    // back if the adapter rejects, so the user can retry.
    entry.pending.delete(requestId);
    try {
      await entry.run.respondToPermission(requestId, decision);
    } catch (error) {
      const failure = asRunError(error, 'transport', 'Could not deliver the permission decision');
      // Restoring the id is only right when the request is still open on the
      // adapter's side. `invalid_request` means the opposite — the adapter has
      // no such request, because the provider withdrew it (the turn moved on,
      // the tool became moot) and settled it itself. Putting it back would
      // leave the registry advertising a prompt that can never be answered:
      // every retry takes this same path and fails identically, and the UI
      // keeps a modal open over a decision that has already been made.
      if (failure.code !== 'invalid_request') entry.pending.add(requestId);
      throw failure;
    }

    if (entry.pending.size === 0 && entry.handle.status === 'awaiting_permission') {
      entry.handle = { ...entry.handle, status: 'running' };
    }
  }

  /**
   * Tear a run down and release its resources.
   *
   * Idempotent: disposing an unknown or already-finished run resolves without
   * error, so a renderer that lost track of a run cannot wedge itself.
   *
   * Resolves once the run has actually ended. If the adapter's stream has not
   * completed within {@link RunRegistryOptions.disposeTimeoutMs}, the registry
   * synthesises `run.end` and stops waiting rather than blocking shutdown.
   */
  async dispose(runId: RunId): Promise<RunDisposeOutcome> {
    const entry = this.#runs.get(runId);
    if (!entry) return { runId };

    entry.disposeRequested = true;
    await this.#disposeRun(entry);

    const settled = await settleWithin(entry.pump, this.#disposeTimeoutMs);
    if (!settled) {
      if (!entry.ended) this.#synthesizeEnd(entry, 'disposed');
      await this.#finalize(entry);
    }
    return { runId };
  }

  /**
   * Dispose every live run and stop accepting new ones.
   *
   * Call this from the Electron `before-quit` handler. Never rejects: a run
   * that fails to tear down is reported through
   * {@link RunRegistryOptions.onError} and skipped.
   */
  async disposeAll(): Promise<void> {
    this.#closed = true;
    const ids = [...this.#runs.keys()];
    await Promise.all(
      ids.map(async (runId) => {
        try {
          await this.dispose(runId);
        } catch (error) {
          this.#report(error, runId, 'dispose');
        }
      }),
    );

    /*
     * And the runs that already finished, which is not the tidiness it looks
     * like. A released run may have left a provider process alive on purpose —
     * background work, a subagent, a registered `/loop` — and that process
     * belongs to a conversation in an app that is now going away. Nothing else
     * will ever ask it to stop: `dispose(runId)` returns early for a run that is
     * no longer live, and the retained tail is the only remaining handle on it.
     *
     * Idempotent for everything else: an entry that was disposed rather than
     * released skips straight back out of `#disposeRun`.
     */
    await Promise.all(
      [...this.#ended.values()].map(async (entry) => {
        try {
          await this.#disposeRun(entry);
        } catch (error) {
          this.#report(error, entry.handle.runId, 'dispose');
        }
      }),
    );

    this.#listeners.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  async #adapterFor(providerId: ProviderId): Promise<ProviderAdapter> {
    let adapter: ProviderAdapter | undefined;
    try {
      adapter = await this.#resolveAdapter(providerId);
    } catch (error) {
      throw asRunError(error, 'provider_not_found', `Could not resolve provider "${providerId}"`);
    }
    if (!adapter) {
      throw new RunError('provider_not_found', `No adapter is registered for "${providerId}"`);
    }
    return adapter;
  }

  /**
   * Refuse a run whose working directory cannot be used.
   *
   * The check itself never throws, but the injected one might, and a checker
   * that blew up must not read as "the directory is fine" — the whole point of
   * this gate is that a bad cwd is never handed to `spawn`.
   */
  async #assertWorkingDirectory(cwd: string): Promise<void> {
    let check: WorkingDirectoryCheck;
    try {
      check = await this.#checkWorkingDirectory(cwd);
    } catch (error) {
      throw asRunError(
        error,
        'invalid_request',
        `Could not check the working directory ${JSON.stringify(cwd)}`,
      );
    }
    if (check.ok) return;
    throw new RunError('invalid_request', check.message, {
      details: { cwd: check.path, problem: check.problem },
    });
  }

  #find(runId: RunId): RunEntry | undefined {
    return this.#runs.get(runId) ?? this.#ended.get(runId);
  }

  /**
   * The run, or a refusal that says which of the two refusals it is.
   *
   * `details.reason` is the load-bearing part. "Already ended" and "never
   * existed" arrive at the renderer as the same `invalid_request` code, and they
   * call for opposite responses: an ended run is a *race* — the caller acted on
   * a view of the world that was true when they clicked — while an unknown id is
   * a bug. A caller that wants to recover from the first has to be able to tell
   * them apart, and matching on the message text would make the sentence itself
   * an API. See `interrupt`, which already forgives the same race silently.
   */
  #requireActive(runId: RunId): RunEntry {
    const entry = this.#runs.get(runId);
    if (!entry) {
      // `#retired` outlives `#ended` on purpose: the entry's eviction must not
      // turn a stale-but-real id into "never existed", because the caller's
      // recovery paths fork on exactly that distinction.
      const retired = this.#ended.has(runId) || this.#retired.has(runId);
      throw new RunError(
        'invalid_request',
        retired ? `Run "${runId}" has already ended` : `Unknown run "${runId}"`,
        { details: { reason: retired ? 'run_ended' : 'run_unknown', runId } },
      );
    }
    return entry;
  }

  /** Drain the adapter's stream until it ends, then guarantee a `run.end`. */
  async #pump(entry: RunEntry): Promise<void> {
    const { runId } = entry.handle;
    try {
      for await (const event of entry.run.events) {
        this.#ingest(entry, event);
        // Nothing follows `run.end`; break so the iterator gets its cleanup.
        if (entry.ended) break;
      }
      if (!entry.ended) {
        this.#synthesizeEnd(
          entry,
          entry.disposeRequested ? 'disposed' : entry.interruptRequested ? 'interrupted' : 'completed',
        );
      }
    } catch (error) {
      this.#report(error, runId, 'events');
      if (!entry.ended) {
        this.#synthesizeEnd(entry, 'error', normalizeAgentError(error, 'transport'));
      }
    } finally {
      await this.#finalize(entry);
    }
  }

  /** Apply one event to the run's state, retain it, then fan it out. */
  #ingest(entry: RunEntry, incoming: AgentEvent): void {
    if (entry.ended) {
      this.#report(
        new RunError(
          'invalid_request',
          `Adapter emitted "${incoming.type}" after run.end; dropping it`,
        ),
        entry.handle.runId,
        'events',
      );
      return;
    }

    // The renderer multiplexes on runId. An adapter that stamped the wrong one
    // would silently route events to the wrong transcript, so correct it here.
    const event: AgentEvent =
      incoming.runId === entry.handle.runId
        ? incoming
        : { ...incoming, runId: entry.handle.runId };

    if (event.seq > entry.maxSeq) entry.maxSeq = event.seq;
    const priorSessionId = entry.handle.sessionId;
    this.#applyToHandle(entry, event);
    this.#retain(entry, event);
    this.#emit(entry, event);

    // After the fan-out, so the log records what the app was told, in the
    // order it was told it. Both notes read `entry.handle` post-apply: that is
    // where the session id lands, whichever event carried it.
    if (event.type === 'session.started' && entry.handle.sessionId !== priorSessionId) {
      const sessionId = entry.handle.sessionId;
      if (sessionId !== undefined) {
        this.#noteLifecycle({ ...this.#lifecycleIdsOf(entry), kind: 'run.session', sessionId });
      }
    }
    if (event.type === 'run.end') {
      this.#noteLifecycle({
        ...this.#lifecycleIdsOf(entry),
        kind: 'run.ended',
        reason: event.reason,
        synthesized: entry.syntheticEnd,
      });
    }
  }

  #applyToHandle(entry: RunEntry, event: AgentEvent): void {
    const handle = entry.handle;
    switch (event.type) {
      case 'session.started':
        entry.handle = {
          ...handle,
          status: entry.pending.size > 0 ? 'awaiting_permission' : 'running',
          sessionId: event.sessionId,
        };
        break;
      case 'permission.request':
        entry.pending.add(event.requestId);
        entry.handle = { ...handle, status: 'awaiting_permission' };
        break;
      case 'permission.resolved': {
        // The same bookkeeping {@link respondToPermission} does on its way out,
        // now also reached when *nobody called it* — the provider withdrew the
        // request, or the run was torn down with it still open. Those paths used
        // to leave the id here forever, so the registry went on advertising a
        // prompt no answer could ever land on: every attempt took the adapter's
        // "no such request" branch and failed identically.
        entry.pending.delete(event.requestId);
        if (entry.pending.size === 0 && handle.status === 'awaiting_permission') {
          entry.handle = { ...handle, status: 'running' };
        }
        break;
      }
      case 'run.end':
        entry.ended = true;
        entry.pending.clear();
        entry.handle = {
          ...handle,
          status: 'ended',
          sessionId: event.sessionId ?? handle.sessionId,
        };
        break;
      default:
        if (handle.status === 'starting') entry.handle = { ...handle, status: 'running' };
        break;
    }
  }

  #retain(entry: RunEntry, event: AgentEvent): void {
    if (this.#historyLimit === 0) return;
    entry.history.push(event);
    const overflow = entry.history.length - this.#historyLimit;
    if (overflow > 0) entry.history.splice(0, overflow);
  }

  #emit(entry: RunEntry, event: AgentEvent): void {
    // Copy both sets: a listener may unsubscribe itself, or another listener,
    // from inside the callback.
    for (const listener of [...entry.listeners, ...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#report(error, entry.handle.runId, 'listener');
      }
    }
  }

  /** Emit a `run.end` the adapter did not produce. */
  #synthesizeEnd(entry: RunEntry, reason: RunEndReason, error?: AgentError): void {
    entry.syntheticEnd = true;
    const event: RunEndEvent = {
      type: 'run.end',
      runId: entry.handle.runId,
      seq: entry.maxSeq + 1,
      ts: this.#now(),
      reason,
      error,
      sessionId: entry.handle.sessionId,
    };
    this.#ingest(entry, event);
  }

  /** Release the adapter's resources exactly once. */
  async #disposeRun(entry: RunEntry): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    try {
      await entry.run.dispose();
    } catch (error) {
      this.#report(error, entry.handle.runId, 'dispose');
    }
  }

  /**
   * Let go of a run that ended on its own, exactly once.
   *
   * Not the same act as {@link #disposeRun}, and the difference is the whole
   * point: a run that finished has already released everything it *owns*, and
   * for an adapter where a run is one turn of a longer-lived process, tearing
   * that process down here would kill work the turn deliberately left running.
   * An adapter with no {@link Run.release} keeps the old behaviour, because for
   * it the two really are one act.
   *
   * Recorded as disposed either way, so nothing reaches the adapter twice — and
   * so a `dispose()` that arrives while this is in flight does not race it.
   */
  async #releaseRun(entry: RunEntry): Promise<void> {
    if (entry.disposed || entry.released) return;
    if (entry.run.release === undefined) {
      await this.#disposeRun(entry);
      return;
    }
    entry.released = true;
    try {
      await entry.run.release();
    } catch (error) {
      this.#report(error, entry.handle.runId, 'dispose');
    }
  }

  /** Retire a finished run: let go of it, drop it from the live index. */
  async #finalize(entry: RunEntry): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;

    // Released rather than disposed unless something asked for a teardown. A run
    // reaching its own end is the ordinary case and must not overrule an
    // adapter's decision to keep a process; `dispose()` has already set
    // `entry.disposed` by the time it gets here, so an explicit teardown still
    // wins.
    if (entry.disposeRequested) await this.#disposeRun(entry);
    else await this.#releaseRun(entry);

    // After the release/dispose settled, so `mode` reports what actually
    // happened: `released` when the adapter kept its process on purpose,
    // `disposed` when it was torn down — including the adapters for which the
    // two are one act.
    this.#noteLifecycle({
      ...this.#lifecycleIdsOf(entry),
      kind: 'run.released',
      mode: entry.released ? 'released' : 'disposed',
    });

    const { runId } = entry.handle;
    this.#runs.delete(runId);
    entry.listeners.clear();

    // Remembered even when entry retention is disabled: the id is the part
    // whose loss misclassifies a later caller, and it costs nothing to keep.
    this.#retired.add(runId);
    while (this.#retired.size > RETIRED_ID_RETENTION) {
      const oldest = this.#retired.values().next();
      if (oldest.done === true) break;
      this.#retired.delete(oldest.value);
    }

    if (this.#endedRetention === 0) return;
    this.#ended.set(runId, entry);
    while (this.#ended.size > this.#endedRetention) {
      const oldest = this.#ended.keys().next();
      if (oldest.done === true) break;
      this.#ended.delete(oldest.value);
    }
  }

  #report(error: unknown, runId: RunId, phase: RunErrorPhase): void {
    if (!this.#onError) return;
    try {
      this.#onError(error, { runId, phase });
    } catch {
      // A reporter that throws is not worth a second exception.
    }
  }

  /** The identifiers a lifecycle note carries, read off the current handle. */
  #lifecycleIdsOf(entry: RunEntry): RunLifecycleBase {
    const { runId, profileId, providerId, cwd, sessionId } = entry.handle;
    return { runId, profileId, providerId, cwd, ...(sessionId === undefined ? {} : { sessionId }) };
  }

  /**
   * Tell the lifecycle listener, without letting it participate.
   *
   * The same containment {@link #emit} gives event subscribers: instrumentation
   * that throws is reported and dropped, because a log line is never worth the
   * run it describes.
   */
  #noteLifecycle(event: RunLifecycleEvent): void {
    if (!this.#onLifecycle) return;
    try {
      this.#onLifecycle(event);
    } catch (error) {
      this.#report(error, event.runId, 'listener');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reject a request the adapter cannot honour, before it reaches the provider.
 *
 * Capabilities are the single source of truth: a mode or a flag the adapter
 * did not advertise is an error rather than a silent downgrade, because
 * silently downgrading a permission mode is how you end up more permissive
 * than the user asked for.
 */
function assertRunnable(input: RunInput, adapter: ProviderAdapter): void {
  // Absoluteness is the one cwd rule that can be decided without touching the
  // disk, so it stays here alongside the other synchronous checks. Existence,
  // directory-ness and readability are answered by `#assertWorkingDirectory`
  // immediately afterwards, and produce their own specific messages.
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
    throw new RunError(
      'invalid_request',
      `The working directory must be a full path, got ${JSON.stringify(input.cwd)}. Enter an absolute path such as /Users/you/projects/app.`,
    );
  }
  if (typeof input.profileId !== 'string' || input.profileId.length === 0) {
    throw new RunError('invalid_request', 'A run needs a profileId to resolve credentials from');
  }

  const caps = adapter.capabilities;
  if (input.permissionMode !== undefined && !caps.permissionModes.includes(input.permissionMode)) {
    throw new RunError(
      'invalid_request',
      `Provider "${adapter.id}" does not support permission mode "${input.permissionMode}"`,
    );
  }
  if (input.resumeSessionId !== undefined && !caps.resumeSession) {
    throw new RunError('invalid_request', `Provider "${adapter.id}" cannot resume sessions`);
  }
  if (input.forkSession === true && input.resumeSessionId !== undefined && !caps.forkSession) {
    throw new RunError('invalid_request', `Provider "${adapter.id}" cannot fork sessions`);
  }
  if (input.rewindToMessageId !== undefined && input.resumeSessionId !== undefined && !caps.rewind) {
    throw new RunError('invalid_request', `Provider "${adapter.id}" cannot rewind sessions`);
  }
  // Refused rather than dropped, like every other unsupported setting here.
  // The composer will not let a user attach to a provider that cannot take
  // one, so the way to arrive here is to attach under one provider and switch
  // to another before sending — at which point silently sending the text alone
  // would put a question about a screenshot in front of a model that never
  // received it, and the answer would be confident and wrong.
  const unsupported = unsupportedAttachment(input.attachments, caps);
  if (unsupported !== undefined) {
    throw new RunError(
      'invalid_request',
      `Provider "${adapter.id}" cannot accept ${unsupported} in a prompt`,
    );
  }
}

/**
 * Name the kind of attachment a capability set cannot carry, if any.
 *
 * Per kind rather than as one flag, because the two travel by different
 * mechanisms and an adapter can plausibly have one and not the other — images
 * need a place on the wire, files need the adapter to stage them and say where.
 */
function unsupportedAttachment(
  attachments: readonly Attachment[] | undefined,
  caps: Capabilities,
): 'images' | 'files' | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  if (!caps.imageInput && attachments.some(isImageAttachment)) return 'images';
  if (!caps.fileInput && attachments.some(isFileAttachment)) return 'files';
  return undefined;
}

/** Wrap a caught value as a {@link RunError} without losing its code. */
function asRunError(error: unknown, fallback: AgentErrorCode, context: string): RunError {
  if (error instanceof RunError) return error;
  const normalized = normalizeAgentError(error, fallback);
  return new RunError(normalized.code, `${context}: ${normalized.message}`, { cause: error });
}

/**
 * Pull `stillQueued` out of whatever an adapter's `interrupt()` resolved with.
 *
 * The seam declares `InterruptResult`, but tolerate an adapter that resolves
 * with nothing, or that passed the SDK's snake_case `still_queued` straight
 * through: an empty list is a safe answer, an exception here is not.
 */
function readStillQueued(result: unknown): readonly string[] {
  if (typeof result !== 'object' || result === null) return [];
  const candidate = result as { stillQueued?: unknown; still_queued?: unknown };
  const raw = candidate.stillQueued ?? candidate.still_queued;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

/**
 * Wait for `promise`, giving up after `ms`.
 *
 * @returns true when the promise settled in time, false when it timed out.
 */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = promise.then(
    () => true,
    () => true,
  );
  if (ms <= 0) return settled;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    // Never hold the process open just to wait for a run to tear down.
    timer.unref?.();
  });

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
