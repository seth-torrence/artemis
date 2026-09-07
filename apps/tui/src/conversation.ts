/**
 * One conversation, driven from a terminal.
 *
 * The controller between the keyboard and the `RunRegistry`. It owns the
 * transcript model, the settings a run starts with, and the one rule that
 * shapes everything else here:
 *
 * **A run is one turn.** `run.end` closes it and retires the id. The next
 * message is a *fresh* `start()` carrying `resumeSessionId`, so the provider
 * continues the same session under a new run. `send()` is different: it steers
 * the turn already in flight, and only providers with `midRunSteering` have
 * it. So there are exactly two ways a message leaves the composer —
 *
 *  - a run is live and the provider steers → `driver.send(runId, text)`
 *  - otherwise                              → `driver.start({ …, resumeSessionId })`
 *
 * — and everything the status bar says about "queued" or "wait for this turn"
 * falls out of which path was taken.
 *
 * The transcript is `@rx-artemis/transcript`'s model, the same one the desktop
 * renderer draws from, fed the same `AgentEvent`s. The optimistic user row is
 * pushed before the round-trip under the identity the registry will file the
 * prompt as — `${runId}:prompt:${n}` — which is what lets a later replay merge
 * onto it rather than draw it twice; `pushUserMessage`'s own comment says why.
 *
 * Nothing here touches Ink or `process`. The driver is an interface the
 * registry satisfies structurally, so the tests hand in a fake and the
 * behaviour above is checked without spawning anything.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  Attachment,
  BackgroundTask,
  Capabilities,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRequestId,
  PlanUsage,
  ProfileId,
  ProviderId,
  RunHandle,
  RunId,
  RunInput,
  SessionId,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES, applyPlanLimit } from '@rx-artemis/protocol';
import { TranscriptModel, frameScheduler, type Scheduler } from '@rx-artemis/transcript';

/** The slice of `RunRegistry` a conversation needs. Satisfied structurally. */
export interface RunDriver {
  start(input: RunInput): Promise<RunHandle>;
  send(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<{ readonly deliveredImmediately: boolean }>;
  interrupt(runId: RunId): Promise<unknown>;
  respondToPermission(
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;
  dispose(runId: RunId): Promise<unknown>;
  stopTask(runId: RunId, taskId: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  get(runId: RunId): RunHandle | undefined;
  isActive(runId: RunId): boolean;
}

export interface ConversationSettings {
  readonly profileId: ProfileId;
  readonly providerId: ProviderId;
  /** For the status bar; the id is what runs. */
  readonly profileLabel: string;
  readonly providerLabel: string;
  readonly cwd: string;
  /** Provider's own model id, or absent for the provider default. */
  readonly model?: string;
  readonly modelLabel?: string;
  readonly effort?: string;
  readonly fastMode?: boolean;
  readonly ultracode?: boolean;
  readonly permissionMode: PermissionMode;
}

export type ConversationStatus = 'idle' | 'starting' | 'running' | 'awaiting_permission';

export interface ConversationState {
  readonly settings: ConversationSettings;
  readonly status: ConversationStatus;
  readonly capabilities: Capabilities;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
  readonly usage?: UsageSnapshot;
  /** Open permission requests, oldest first. The card draws the first. */
  readonly pendingPermissions: readonly PermissionRequest[];
  /** Steers accepted by the provider but not yet delivered to the model. */
  readonly queued: number;
  /**
   * Background work, as the provider last reported it — a replacement list,
   * and one that outlives the turn: what is still running after `run.end` is
   * exactly what a person wants to know.
   */
  readonly tasks: readonly BackgroundTask[];
  /** The account's plan windows: fetched on request, kept current by `plan.limit` events mid-run. */
  readonly planUsage: PlanUsage | null;
  /**
   * The provider's own slash commands — built-in, bridged from the user's
   * directories, and from plugins — as the session last announced them. A
   * replacement list; known only once a session has started.
   */
  readonly slashCommands: readonly string[];
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ConversationOptions {
  readonly driver: RunDriver;
  readonly settings: ConversationSettings;
  /** What the provider can do, before any run has told us. */
  readonly capabilitiesFor: (providerId: ProviderId) => Capabilities | undefined;
  readonly scheduler?: Scheduler;
  readonly newRunId?: () => RunId;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class Conversation {
  readonly transcript: TranscriptModel;

  readonly #driver: RunDriver;
  readonly #capabilitiesFor: (providerId: ProviderId) => Capabilities | undefined;
  readonly #newRunId: () => RunId;
  readonly #listeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: AgentEvent) => void>();
  readonly #unsubscribe: () => void;

  #settings: ConversationSettings;
  #capabilities: Capabilities;
  #status: ConversationStatus = 'idle';
  #runId: RunId | undefined;
  #sessionId: SessionId | undefined;
  #usage: UsageSnapshot | undefined;
  #pending: PermissionRequest[] = [];
  #queued = 0;
  #tasks: readonly BackgroundTask[] = [];
  #planUsage: PlanUsage | null = null;
  #slashCommands: readonly string[] = [];
  /** A run has reported its own commands, which outrank every seed. */
  #slashCommandsFromRun = false;
  /** The run that most recently ended; background work it started is stopped through it. */
  #lastRunId: RunId | undefined;
  #snapshot: ConversationState;

  constructor(options: ConversationOptions) {
    this.#driver = options.driver;
    this.#settings = options.settings;
    this.#capabilitiesFor = options.capabilitiesFor;
    this.#capabilities = options.capabilitiesFor(options.settings.providerId) ?? NO_CAPABILITIES;
    this.#newRunId = options.newRunId ?? (() => randomUUID() as RunId);
    this.transcript = new TranscriptModel(options.scheduler ?? frameScheduler);
    this.#snapshot = this.#buildSnapshot();
    this.#unsubscribe = this.#driver.subscribe((event) => this.#onEvent(event));
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Immutable and reference-stable between changes — `useSyncExternalStore` wants exactly this. */
  getState = (): ConversationState => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every event of *this* conversation's runs, after the transcript has seen it. */
  subscribeEvents = (listener: (event: AgentEvent) => void): (() => void) => {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  };

  get isLive(): boolean {
    return this.#runId !== undefined && this.#driver.isActive(this.#runId);
  }

  /* ---------------------------------------------------------------------- */
  /* Settings                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Change what the next turn runs with.
   *
   * A run belongs to the account it started on for its whole life, so the
   * account and provider cannot change while one is live. Changing them at all
   * ends the conversation: sessions live in the profile's own config directory
   * and a different account cannot resume this one. The caller is expected to
   * have asked first; this just makes the consequence real.
   */
  updateSettings(patch: Partial<ConversationSettings>): Outcome {
    const changesAccount =
      (patch.profileId !== undefined && patch.profileId !== this.#settings.profileId) ||
      (patch.providerId !== undefined && patch.providerId !== this.#settings.providerId);
    if (changesAccount && this.isLive) {
      return { ok: false, reason: 'A conversation belongs to the account it started on. Wait for this turn to finish.' };
    }
    this.#settings = { ...this.#settings, ...patch };
    if (changesAccount) {
      this.#sessionId = undefined;
      this.#usage = undefined;
      this.#capabilities = this.#capabilitiesFor(this.#settings.providerId) ?? NO_CAPABILITIES;
      this.transcript.reset();
    }
    this.#notify();
    return { ok: true };
  }

  /** Forget the session and clear the screen. Refused while a run is live. */
  reset(): Outcome {
    if (this.isLive) return { ok: false, reason: 'Wait for this turn to finish, or press Esc to interrupt it.' };
    this.#sessionId = undefined;
    this.#usage = undefined;
    this.#runId = undefined;
    this.#pending = [];
    this.#queued = 0;
    this.#status = 'idle';
    this.transcript.reset();
    this.#notify();
    return { ok: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Talking                                                                 */
  /* ---------------------------------------------------------------------- */

  async send(text: string, attachments: readonly Attachment[] = []): Promise<Outcome> {
    const prompt = text.trim();
    if (prompt.length === 0 && attachments.length === 0) return { ok: false, reason: 'Nothing to send.' };

    // Refused, not stripped: an image dropped on the way to the model turns
    // "what is wrong with this screenshot?" into a question about nothing,
    // and the answer comes back confident. The registry enforces the same.
    if (attachments.some((a) => a.kind === 'image') && !this.#capabilities.imageInput) {
      return { ok: false, reason: `${this.#settings.providerLabel} cannot take images.` };
    }
    if (attachments.some((a) => a.kind === 'file') && !this.#capabilities.fileInput) {
      return { ok: false, reason: `${this.#settings.providerLabel} cannot take file attachments.` };
    }

    const live = this.#runId;
    if (live !== undefined && this.#driver.isActive(live)) {
      if (!this.#capabilities.midRunSteering) {
        return {
          ok: false,
          reason: `${this.#settings.providerLabel} cannot take a message mid-turn. Wait for it to finish, or press Esc.`,
        };
      }
      return this.#steer(live, prompt, attachments);
    }
    return this.#startTurn(prompt, attachments);
  }

  /**
   * Replace the screen with a stored conversation and continue it.
   *
   * The events come from the provider's own store, already flagged `replay`,
   * and go through the same reducer live ones do — history and live output
   * share one rendering path by design. Refused while a run is live, because
   * the session id is about to be the one the next turn resumes.
   */
  loadHistory(sessionId: SessionId, events: readonly AgentEvent[]): Outcome {
    if (this.isLive) return { ok: false, reason: 'Wait for this turn to finish before switching conversations.' };
    this.transcript.reset();
    for (const event of events) this.transcript.apply(event);
    this.transcript.flush();
    this.#sessionId = sessionId;
    this.#usage = undefined;
    this.#runId = undefined;
    this.#pending = [];
    this.#queued = 0;
    this.#status = 'idle';
    this.#notify();
    return { ok: true };
  }

  /**
   * Seed the provider's command list before any run has reported one.
   *
   * Ignored once a run *has* spoken, and only then: what a live session says
   * it has is the truth. Anything else — a list remembered from the last
   * launch, then the fresh one that replaces it a second later — is a
   * standing-in answer that a better standing-in answer may overwrite. See
   * `TuiHost.listCommands` for why the seed exists at all.
   */
  seedSlashCommands(commands: readonly string[]): void {
    if (this.#slashCommandsFromRun || commands.length === 0) return;
    this.#slashCommands = commands;
    this.#notify();
  }

  /** A fetched snapshot replaces whatever `plan.limit` events had folded. */
  setPlanUsage(usage: PlanUsage | null): void {
    this.#planUsage = usage;
    this.#notify();
  }

  /** Stop a background task, of this run or the one that just ended. */
  async stopTask(taskId: string): Promise<Outcome> {
    const runId = this.#runId ?? this.#lastRunId;
    if (runId === undefined) return { ok: false, reason: 'Nothing is running.' };
    try {
      await this.#driver.stopTask(runId, taskId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }

  async interrupt(): Promise<void> {
    const runId = this.#runId;
    if (runId === undefined || !this.#driver.isActive(runId)) return;
    try {
      await this.#driver.interrupt(runId);
    } catch (error) {
      this.transcript.note('warn', `Could not interrupt: ${describe(error)}`);
    }
  }

  /**
   * Answer a permission prompt.
   *
   * One rule lives here rather than in the card: an *allow* that carries a
   * `setMode` update — which is what approving a plan does — changes the mode
   * the next turn starts in. Without this the next prompt would still run in
   * `plan` and the agent would refuse to edit anything, which reads as a
   * broken app rather than a mode. The desktop's `leavePlanMode` does the same.
   *
   * A request that is no longer open — withdrawn, or answered from elsewhere —
   * makes the driver throw; that means "drop the card", not "show an error".
   */
  async respondToPermission(requestId: PermissionRequestId, decision: PermissionDecision): Promise<void> {
    const runId = this.#runId;
    if (runId === undefined) return;
    if (decision.behavior === 'allow') {
      const setMode = decision.updatedPermissions?.find((update) => update.type === 'setMode');
      if (setMode !== undefined && setMode.type === 'setMode') {
        this.#settings = { ...this.#settings, permissionMode: setMode.mode };
      }
    }
    try {
      await this.#driver.respondToPermission(runId, requestId, decision);
    } catch {
      // Not open any more. The `permission.resolved` that explains why has
      // either arrived or never will; either way the card goes.
    } finally {
      this.#pending = this.#pending.filter((request) => request.id !== requestId);
      if (this.#status === 'awaiting_permission' && this.#pending.length === 0) this.#status = 'running';
      this.#notify();
    }
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
    this.#eventListeners.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* The two paths                                                           */
  /* ---------------------------------------------------------------------- */

  async #startTurn(prompt: string, attachments: readonly Attachment[] = [], carriedRow?: string): Promise<Outcome> {
    const runId = this.#newRunId();
    const messageId = `${runId}:prompt:1`;
    let rowId: string;
    if (carriedRow === undefined) {
      rowId = this.transcript.pushUserMessage(prompt, attachments.length > 0 ? attachments : undefined, messageId);
    } else {
      rowId = carriedRow;
      this.transcript.claimUserMessage(rowId, messageId);
    }

    this.#runId = runId;
    this.#status = 'starting';
    this.#pending = [];
    this.#queued = 0;
    this.#notify();

    const settings = this.#settings;
    const input: RunInput = {
      runId,
      providerId: settings.providerId,
      profileId: settings.profileId,
      cwd: settings.cwd,
      prompt,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      ...(settings.fastMode === true ? { fastMode: true } : {}),
      ...(settings.ultracode === true ? { ultracode: true } : {}),
      ...(this.#sessionId === undefined ? {} : { resumeSessionId: this.#sessionId }),
      // Sent only when the provider really has the mode: an adapter rejects an
      // unknown one rather than downgrading it, and a stored preference must
      // not become an error on a provider with fewer modes.
      ...(this.#capabilities.permissionModes.includes(settings.permissionMode)
        ? { permissionMode: settings.permissionMode }
        : {}),
    };

    try {
      const handle = await this.#driver.start(input);
      this.#capabilities = handle.capabilities;
      this.transcript.confirmUserMessage(rowId);
      if (this.#status === 'starting') this.#status = 'running';
      this.#notify();
      return { ok: true };
    } catch (error) {
      const reason = describe(error);
      this.transcript.note('error', reason);
      if (this.#runId === runId) {
        this.#runId = undefined;
        this.#status = 'idle';
      }
      this.#notify();
      return { ok: false, reason };
    }
  }

  async #steer(runId: RunId, prompt: string, attachments: readonly Attachment[] = []): Promise<Outcome> {
    const handle = this.#driver.get(runId);
    const n = (handle?.promptCount ?? 1) + 1;
    const rowId = this.transcript.pushUserMessage(prompt, attachments.length > 0 ? attachments : undefined, `${runId}:prompt:${n}`);
    try {
      const outcome =
        attachments.length > 0
          ? await this.#driver.send(runId, prompt, attachments)
          : await this.#driver.send(runId, prompt);
      this.transcript.confirmUserMessage(rowId);
      if (!outcome.deliveredImmediately) this.#queued += 1;
      this.#notify();
      return { ok: true };
    } catch (error) {
      // The steer raced the end of its run. The prompt is not lost: it opens
      // the next turn instead, and the row it already drew moves with it.
      if (!this.#driver.isActive(runId)) return this.#startTurn(prompt, attachments, rowId);
      const reason = describe(error);
      this.transcript.note('error', reason);
      this.#notify();
      return { ok: false, reason };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  #onEvent(event: AgentEvent): void {
    if (event.runId !== this.#runId) return;
    this.transcript.apply(event);

    switch (event.type) {
      case 'session.started':
        this.#sessionId = event.sessionId;
        if (this.#status === 'starting') this.#status = 'running';
        // What the provider actually started in, which may differ from what
        // was asked for. The bar shows the truth.
        if (event.permissionMode !== undefined) {
          this.#settings = { ...this.#settings, permissionMode: event.permissionMode };
        }
        if (event.slashCommands !== undefined) {
          this.#slashCommands = event.slashCommands;
          this.#slashCommandsFromRun = true;
        }
        break;
      case 'session.commands':
        this.#slashCommands = event.slashCommands;
        this.#slashCommandsFromRun = true;
        break;
      case 'permission.request':
        this.#pending = [...this.#pending, event.request];
        this.#status = 'awaiting_permission';
        break;
      case 'permission.resolved':
        this.#pending = this.#pending.filter((request) => request.id !== event.requestId);
        if (this.#status === 'awaiting_permission' && this.#pending.length === 0) this.#status = 'running';
        break;
      case 'message.delivered':
        this.#queued = Math.max(0, this.#queued - 1);
        break;
      case 'usage':
        this.#foldUsage(event.usage);
        break;
      case 'background.tasks':
        this.#tasks = event.tasks;
        break;
      case 'plan.limit': {
        // `null` means "nothing to fold onto" — a reading with no window — and
        // is not a reason to forget what was known.
        const folded = applyPlanLimit(this.#planUsage, event.limit, event.ts);
        if (folded !== null) this.#planUsage = folded;
        break;
      }
      case 'run.end': {
        if (event.sessionId !== undefined) this.#sessionId = event.sessionId;
        if (event.usage !== undefined) this.#foldUsage(event.usage);
        const ended = this.#runId;
        this.#lastRunId = ended;
        this.#runId = undefined;
        this.#status = 'idle';
        this.#pending = [];
        this.#queued = 0;
        // Released now rather than left for the registry's retention: a run
        // belongs to the one conversation that started it, and nothing else
        // in this process will ever re-attach to it.
        if (ended !== undefined) void this.#driver.dispose(ended).catch(() => undefined);
        break;
      }
      default:
        break;
    }

    this.#notify();
    for (const listener of this.#eventListeners) listener(event);
  }

  /** `delta` adds to the running total; `cumulative` and `final` replace it. */
  #foldUsage(usage: UsageSnapshot): void {
    const current = this.#usage;
    if (usage.scope !== 'delta' || current === undefined) {
      this.#usage = usage;
      return;
    }
    const add = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    this.#usage = {
      ...current,
      ...usage,
      scope: 'cumulative',
      tokens: {
        inputTokens: current.tokens.inputTokens + usage.tokens.inputTokens,
        outputTokens: current.tokens.outputTokens + usage.tokens.outputTokens,
        ...(add(current.tokens.cacheReadInputTokens, usage.tokens.cacheReadInputTokens) === undefined
          ? {}
          : { cacheReadInputTokens: add(current.tokens.cacheReadInputTokens, usage.tokens.cacheReadInputTokens) as number }),
        ...(add(current.tokens.cacheCreationInputTokens, usage.tokens.cacheCreationInputTokens) === undefined
          ? {}
          : { cacheCreationInputTokens: add(current.tokens.cacheCreationInputTokens, usage.tokens.cacheCreationInputTokens) as number }),
      },
      ...(add(current.costUsd, usage.costUsd) === undefined ? {} : { costUsd: add(current.costUsd, usage.costUsd) as number }),
    };
  }

  #buildSnapshot(): ConversationState {
    return {
      settings: this.#settings,
      status: this.#status,
      capabilities: this.#capabilities,
      ...(this.#runId === undefined ? {} : { runId: this.#runId }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      pendingPermissions: this.#pending,
      queued: this.#queued,
      tasks: this.#tasks,
      planUsage: this.#planUsage,
      slashCommands: this.#slashCommands,
    };
  }

  #notify(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }
}
