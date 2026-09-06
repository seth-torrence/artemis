/**
 * Running a turn for an HTTP caller.
 * ============================================================================
 *
 * `POST /v1/chat/completions` is the endpoint that actually does something. A
 * client sends a conversation, Artemis starts an agent run under one of the
 * user's accounts, and the reply comes back in the shape every OpenAI client
 * already understands — either whole, or streamed.
 *
 * This module is that translation and nothing else. It does not own the port
 * (see `http.ts`), it does not know what a profile is (see the {@link RunSource}
 * seam), and it does not choose the directory (see `workspaces.ts`).
 *
 * ---------------------------------------------------------------------------
 * A TURN IS NOT A COMPLETION, AND THREE THINGS FOLLOW
 * ---------------------------------------------------------------------------
 *
 * **1. Nobody is watching, so nobody can answer a permission prompt.** An
 * agentic run can stop and ask. In the app a person answers; over HTTP there is
 * usually no person, and a request that parked on a prompt would hang until the
 * client timed out with no explanation. So every permission request is **denied
 * automatically**, with a message the model can act on, and the denial is
 * reported on the response. Denying is the only safe default: the alternative
 * is a program the user has not looked at approving file writes on their behalf.
 *
 * **2. The agent's tools are its own.** A run reads files and executes commands
 * internally; those are reported as {@link ArtemisActivity}, never as OpenAI
 * `tool_calls`, because a `tool_calls` reply is a request *to the client* and no
 * client can execute Claude Code's `Bash`. See `openai.ts` in protocol.
 *
 * **3. The client can vanish.** A browser tab closes, a script is `^C`'d. The
 * run keeps going — it is a real process doing real work on the user's disk —
 * unless someone stops it, so a disconnect interrupts it. Anything else spends
 * the user's plan on output nobody will ever read.
 *
 * ---------------------------------------------------------------------------
 * …UNLESS THE CALLER SAYS IT IS A PERSON
 * ---------------------------------------------------------------------------
 *
 * Points 1 and 3 are both statements about *the client*, and both are wrong for
 * exactly one kind of client: a remote Artemis with a human in front of it. So
 * each is an opt-in the caller declares on the request, and neither is ever
 * inferred — see `ArtemisRemoteOptions` in protocol for why a socket cannot
 * tell a phone from a CI job.
 *
 *  - `artemis.remote.permissions` emits the request to the client instead of
 *    denying it, and lets the run park. Answering happens out of band, on
 *    `POST /api/v0/runs/{runId}/permission`, because the answer routinely
 *    arrives on a different connection from the one that asked — the stream
 *    this turn is writing to may already be dead.
 *  - `artemis.remote.detach` makes a disconnect leave the run alone. This
 *    module's part is small and precise: it stops interrupting on teardown and
 *    reports the detach to whoever is keeping the deadline. It does *not* take
 *    ownership of the run's eventual death, because a generator nobody is
 *    pulling from cannot enforce a timeout — see `runs.ts`.
 *
 * A request that sets neither is served byte for byte as it was before either
 * existed, which is the property the whole design is arranged around.
 *
 * None of this is the *remote bridge* (`remote.ts`), which serves a window
 * rather than a provider adapter, makes both promises unconditionally, and
 * keeps its own run registry with its own grace period. The two surfaces share
 * an engine and share no bookkeeping.
 */

import type {
  AgentEvent,
  ArtemisActivity,
  ArtemisChatExtensions,
  ArtemisPermissionNotice,
  Attachment,
  OpenAiChatChunk,
  OpenAiChatMessage,
  OpenAiChatRequest,
  OpenAiChatResponse,
  OpenAiFinishReason,
  OpenAiUsage,
  PermissionDecision,
  RunEndReason,
  RunHandle,
  RunId,
  RunInput,
  ServerModel,
  SessionDelegatedWork,
} from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The standing answer to a prompt nobody is present for.
 *
 * Exported because it is given in two places that must not drift: here, the
 * instant a request arrives on a turn that did not ask for prompts, and in
 * `runs.ts`, when a turn that *did* ask has waited past its deadline. Both are
 * the same sentence to the model — "there is no one here" — and a model that
 * learned to route around one wording and met another would have to learn
 * twice.
 *
 * Written for the model rather than for a log: it names the constraint and
 * offers two ways forward, so the agent treats it as a closed door rather than
 * as a fault it should retry.
 */
export const UNATTENDED_PERMISSION_MESSAGE =
  'This turn is running through the Artemis HTTP server, where no one is present to approve tool use. Continue without this action, or explain what you would need.';

/** What one turn needs from the engine. */
export interface RunSource {
  /**
   * Start a run and resolve once it is registered.
   *
   * The shape is deliberately narrower than `RunInput`: this module may not
   * choose a system prompt or a set of tools, because those are the user's
   * settings and an HTTP caller is not the user. The permission mode joined
   * the shape once remote permission answering existed: a caller trusted to
   * approve every prompt was already trusted with everything a mode grants,
   * and refusing the mode only made the approvals more tedious. A host
   * honours it insofar as the serving provider supports it, and drops it
   * otherwise.
   */
  startRun(input: {
    readonly providerId: string;
    readonly profileId: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly effort?: string;
    readonly fastMode?: boolean;
    readonly ultracode?: boolean;
    readonly resumeSessionId?: string;
    readonly permissionMode?: string;
  }): Promise<RunHandle>;

  /** Every event from every run. Filtered by `runId` here. */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  /** Stop a run that is still going. Called when the client disconnects. */
  interrupt(runId: RunId): Promise<void>;

  /**
   * Answer a permission request.
   *
   * The parameter is the full {@link PermissionDecision}, and the widening is
   * phase 2 of ADR 0004: a *person on another machine* answers prompts
   * through the remote routes, and remote permission answering is the heart
   * of controlling what a machine is working on. The completions surface is
   * unchanged in behaviour — `runTurn` still sends `deny`, always, because on
   * that surface nobody is watching (see the file comment) — the type simply
   * stopped pretending the seam could carry nothing else.
   */
  respondToPermission(
    runId: RunId,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;

  /** Release the run's resources once its reply has been written. */
  disposeRun(runId: RunId): Promise<void>;

  /* ------------------------------------------------------------------------
   * The remote bridge's observation and control surface (ADR 0004).
   *
   * Optional as a set: a host that provides none of them serves completions
   * exactly as before and the remote routes answer 501, which is what a
   * catalogue-only or pre-remote build honestly is. They are on this seam
   * rather than a second one because they are the same narrowing discipline
   * over the same engine — the server may ask exactly these questions, and a
   * route cannot reach anything the host did not choose to expose here.
   * ---------------------------------------------------------------------- */

  /** Live runs, as `runs:list` reports them to a window. */
  listRuns?(query: { readonly cwd?: string }): Promise<readonly RunHandle[]>;

  /** One run's handle — live or recently finished — for the visibility gate. */
  getRun?(runId: RunId): Promise<RunHandle | undefined>;

  /**
   * A run's retained events, exactly as `runs:events` replays them, with the
   * same `truncated` honesty flag.
   */
  runEvents?(query: { readonly runId: RunId; readonly afterSeq?: number }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly truncated: boolean;
  }>;

  /**
   * Conversations still holding background work, as `runs:live-work` answers.
   * Absent when the host keeps no such ledger; the route reports empty sets,
   * which the response contract already defines as "nothing known", never
   * "nothing running".
   */
  liveWork?(): Promise<{
    readonly sessionIds: readonly string[];
    readonly working: readonly string[];
    readonly delegated: readonly SessionDelegatedWork[];
  }>;

  /**
   * Start a run with the *user's own settings* — the whole {@link RunInput}.
   *
   * Deliberately a second entry point beside the narrow {@link startRun},
   * because the two callers are different principals. A completions caller is
   * a program borrowing an account and may not choose a permission mode or a
   * tool set; the holder of a remote-bridge token is the user on another
   * machine, and refusing them their own settings would make the remote
   * window a lesser Artemis. The routes still enforce the token's scope —
   * profile allowance, model allowance, the workspace pin — before this is
   * called.
   */
  startUserRun?(input: RunInput): Promise<RunHandle>;

  /** Send another message into a live run, as `runs:send` does. */
  send?(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<{ readonly deliveredImmediately: boolean }>;

  /** Interrupt, with the `stillQueued` detail a window renders. */
  interruptRun?(runId: RunId): Promise<{ readonly stillQueued?: readonly string[] }>;

  /** Stop one delegated task, leaving the run alone. */
  stopTask?(runId: RunId, taskId: string): Promise<void>;
}

/** Everything one turn needs, resolved by the caller before this is entered. */
export interface TurnRequest {
  readonly model: ServerModel;
  readonly cwd: string;
  readonly request: OpenAiChatRequest;
  readonly extensions: ArtemisChatExtensions;
  /** Parameters accepted but not applied, echoed back so a caller can see them. */
  readonly ignored: readonly string[];
  /** Aborts when the client hangs up. */
  readonly signal?: { readonly aborted: boolean; addEventListener?: unknown };
  /**
   * Told when a client walked away from a run it asked to keep.
   *
   * The one thing this module cannot do for itself. Detaching is a *transfer*:
   * from here, where the run's lifetime is bounded by a generator somebody is
   * pulling from, to something that outlives the request and can still enforce
   * a deadline. Handing over is the whole of the handover — nothing is called
   * back, and the run is no longer this turn's to end.
   *
   * Only ever called when the caller set `artemis.remote.detach`, and only for
   * a run that was still going. A turn that finished normally is disposed here
   * as it always was.
   */
  readonly onDetach?: (runId: RunId) => void;
}

/* -------------------------------------------------------------------------- */
/* Reading the request                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Flatten OpenAI's `messages` into the one prompt a turn takes.
 *
 * The rule, and it is a real semantic choice rather than a simplification:
 * **the trailing user message is the turn.** Everything before it is either
 * already in the session (when the caller passed a `sessionId`) or is context
 * the caller is re-sending because OpenAI's API is stateless and theirs has to
 * be too.
 *
 * So earlier `user` and `assistant` messages are folded into a transcript
 * *prefix* only when there is no session to resume — otherwise the agent would
 * be handed its own history a second time and would answer as though the
 * conversation had happened twice.
 *
 * `system` and `developer` messages always survive, at the front: they are
 * instructions rather than history, and a caller that sets one on every request
 * means it every time.
 */
export function promptFromMessages(
  messages: readonly OpenAiChatMessage[],
  options: { readonly resuming: boolean },
): string {
  const systems: string[] = [];
  const history: string[] = [];
  let trailing = '';

  messages.forEach((message, index) => {
    const text = flattenContent(message.content);
    if (text.length === 0) return;

    if (message.role === 'system' || message.role === 'developer') {
      systems.push(text);
      return;
    }

    const isLast = index === messages.length - 1;
    if (isLast && message.role === 'user') {
      trailing = text;
      return;
    }

    // A `tool` message is a result the *client* produced for a tool call the
    // agent never made — Artemis's agents run their own. Carried as context
    // rather than dropped, because a caller that sent one meant something by it.
    history.push(`${message.role}: ${text}`);
  });

  const parts: string[] = [];
  if (systems.length > 0) parts.push(systems.join('\n\n'));
  if (!options.resuming && history.length > 0) {
    parts.push(`Earlier in this conversation:\n${history.join('\n')}`);
  }
  // The turn itself last, so it is the freshest thing the model reads. When a
  // caller sent only non-user messages this is empty and the history stands in.
  if (trailing.length > 0) parts.push(trailing);
  else if (options.resuming && history.length > 0) parts.push(history.join('\n'));

  return parts.join('\n\n').trim();
}

/** OpenAI allows a string or an array of parts; both have to be read. */
function flattenContent(content: OpenAiChatMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part.type === 'text'
        ? part.text
        : // An image the transport cannot carry yet. Named rather than dropped
          // silently, so the model knows something was meant to be here.
          '[image omitted: the Artemis server does not forward images yet]',
    )
    .join('\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** What a finished turn produced. */
export interface TurnResult {
  readonly text: string;
  /**
   * The agent's reasoning, joined, when the provider reported any.
   *
   * Kept apart from {@link text} for the reason the file comment on
   * `openai.ts` gives: a caller reading the answer must never be handed the
   * model's working-out as though it were the reply. Absent, not empty, when
   * there was none — a field that is present says the model reasoned.
   */
  readonly thinking?: string;
  readonly finishReason: OpenAiFinishReason;
  readonly endReason: RunEndReason;
  readonly sessionId?: string;
  readonly usage?: OpenAiUsage;
  readonly activity: readonly ArtemisActivity[];
  /** Set when the run failed; the caller turns this into a 502. */
  readonly error?: string;
}

/** One streamed piece of a turn. */
export type TurnEvent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      /**
       * A fragment of the agent's reasoning, as it thinks.
       *
       * Its own kind rather than a flag on `text`, because the two must never
       * be confused downstream: `text` becomes `content`, which is the answer,
       * and this becomes `reasoning_content`, which is not. Only the agent's
       * own — a subagent's reasoning is that subagent's business, reported to
       * the caller as the activity that spawned it.
       */
      readonly kind: 'thinking';
      readonly text: string;
    }
  | { readonly kind: 'activity'; readonly activity: ArtemisActivity }
  | {
      /**
       * The run this turn became, announced as soon as it has an id.
       *
       * First of everything, and unconditional — a caller that never uses the
       * run surface pays one field on one chunk, and a caller that does has no
       * other way to learn the address. `/v1/chat/completions` is the only
       * route that mints a run for a completions caller, and until this existed
       * the id it minted was knowable to nobody: such a client could watch a
       * run it had started only by staying attached to it, which is precisely
       * the thing that fails.
       *
       * Announced before the session id on purpose. The two arrive together for
       * a fresh conversation, and of the pair this is the one that is useful
       * immediately — interrupting, steering and approving all address the run,
       * while the session id only matters once the turn is over.
       */
      readonly kind: 'run';
      readonly runId: RunId;
    }
  | {
      /**
       * A permission prompt the run is parked on, or the news that it is not.
       *
       * Only for a turn that set `artemis.remote.permissions`; every other turn
       * is denied on the spot and there is nothing to report. Both states are
       * emitted, and the second is not a nicety: the request may be answered by
       * a *different* client from the one watching this stream, or by the park
       * deadline, and a watcher that only ever saw the question would hold an
       * open card over a decision that was made minutes ago.
       */
      readonly kind: 'permission';
      readonly notice: ArtemisPermissionNotice;
    }
  | {
      /**
       * The session this turn is writing to, announced as soon as it is known
       * rather than only on `done`.
       *
       * Exists for the client that wants to resume a conversation the moment it
       * can — an Artemis driving another Artemis emits its own
       * `session.started` from this — and for the caller whose stream dies
       * mid-turn, who would otherwise learn the id never. Emitted at most once
       * per id: a resumed turn's caller already holds it, so nothing is
       * announced unless the provider reports a different one.
       */
      readonly kind: 'session';
      readonly sessionId: string;
    }
  | { readonly kind: 'done'; readonly result: TurnResult };

/**
 * Start a run and yield its progress until it ends.
 *
 * An async generator rather than a callback so both surfaces read the same way:
 * the streaming handler forwards each event as it arrives, the non-streaming one
 * drains to the `done`. There is exactly one implementation of the run lifecycle,
 * which is what keeps the two from diverging on when a turn is over.
 */
export async function* runTurn(
  source: RunSource,
  turn: TurnRequest,
): AsyncGenerator<TurnEvent> {
  const resuming = turn.extensions.sessionId !== undefined;
  const prompt = promptFromMessages(turn.request.messages, { resuming });
  /*
   * Read once, and read as `=== true`, so that a caller who sent `remote: {}`,
   * or nothing at all, is on the old path by construction rather than by the
   * absence of a branch somebody might later add.
   *
   * Detaching additionally requires somewhere to hand the run *to*. Skipping
   * the interrupt without a handover would not be a weaker promise, it would be
   * a leak: a run with no client, no owner and no deadline, held by the
   * provider until the process dies. A build with nowhere to put it therefore
   * ignores the request and ends the run as it always did, which is the honest
   * degradation — the caller loses a feature rather than the server losing
   * track of a subprocess.
   */
  const detachable = turn.extensions.remote?.detach === true && turn.onDetach !== undefined;
  const remotePermissions = turn.extensions.remote?.permissions === true;

  /*
   * A queue, because events arrive by callback and are consumed by `for await`.
   *
   * The subscription is attached *before* `startRun` resolves — a fast provider
   * can emit `session.started` and text before the promise settles, and a
   * listener attached afterwards would miss the opening of the turn.
   */
  const pending: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let runId: RunId | null = null;

  const unsubscribe = source.subscribe((event) => {
    // `runId` is null only in the window before `startRun` resolves; events for
    // *other* runs are filtered here, which is why one global subscription is
    // enough for any number of concurrent turns.
    if (runId !== null && event.runId !== runId) return;
    pending.push(event);
    notify?.();
  });

  const activity: ArtemisActivity[] = [];
  let text = '';
  let thinking = '';
  /** The reasoning block being relayed, so a new one is set off from the last. */
  let thinkingBlock: string | undefined;
  /*
   * Seeded from the request when resuming, and that is a fix rather than a
   * convenience.
   *
   * A *new* session announces itself with `session.started`, so the id is
   * observed. A *resumed* one does not — the session already started, on an
   * earlier turn — and providers do not always repeat it on `run.end` either.
   * The response therefore came back with no `sessionId` from the second turn
   * onward, so a client following the documented pattern (send back what you
   * were given) lost the thread after exactly one exchange. Caught by holding a
   * real two-turn conversation with a Codex account.
   *
   * Echoing the id we were handed is honest: this turn did run in that session,
   * which is precisely what the field means. Anything the run reports later
   * overwrites it.
   */
  let sessionId: string | undefined = turn.extensions.sessionId;
  /*
   * The id the caller has already been told, so a fresh session is announced
   * exactly once and a resumed one — whose caller sent the id in — not at all.
   * See the `session` member of {@link TurnEvent}.
   */
  let announced: string | undefined = turn.extensions.sessionId;
  let usage: OpenAiUsage | undefined;
  let deniedPermission = false;

  try {
    let handle: RunHandle;
    try {
      handle = await source.startRun({
        providerId: turn.model.providerId,
        profileId: String(turn.model.profileId),
        cwd: turn.cwd,
        prompt,
        model: turn.model.id,
        ...(turn.extensions.thinking === undefined ? {} : { effort: turn.extensions.thinking }),
        ...(turn.extensions.fastMode === undefined ? {} : { fastMode: turn.extensions.fastMode }),
        ...(turn.extensions.ultracode === undefined
          ? {}
          : { ultracode: turn.extensions.ultracode }),
        ...(turn.extensions.sessionId === undefined
          ? {}
          : { resumeSessionId: turn.extensions.sessionId }),
        ...(turn.extensions.permissionMode === undefined
          ? {}
          : { permissionMode: turn.extensions.permissionMode }),
      });
    } catch (error) {
      yield {
        kind: 'done',
        result: {
          text: '',
          finishReason: 'stop',
          endReason: 'error',
          activity: [],
          error: error instanceof Error ? error.message : 'The run could not be started.',
        },
      };
      return;
    }

    runId = handle.runId;
    yield { kind: 'run', runId };
    if (handle.sessionId !== undefined) sessionId = String(handle.sessionId);
    if (sessionId !== undefined && sessionId !== announced) {
      announced = sessionId;
      yield { kind: 'session', sessionId };
    }

    // Events that arrived while `startRun` was in flight were queued with no
    // filter; drop any that turned out to belong to another run.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]?.runId !== runId) pending.splice(index, 1);
    }

    while (!ended) {
      if (pending.length === 0) {
        // Waiting for the next event, or for a client that has gone away.
        if (turn.signal?.aborted === true) {
          /*
           * A detachable run stops being this turn's business the moment its
           * client goes: returning hands it to `finally`, which detaches rather
           * than interrupts. Draining on would be worse than pointless — it
           * holds the request handler open writing into a dead socket for as
           * long as the agent keeps working, which for the case this feature
           * exists for is hours.
           */
          if (detachable) return;
          await source.interrupt(runId).catch(() => undefined);
          // Keep draining: the run answers the interrupt with a `run.end`, and
          // leaving without it would strand the subscription.
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 250);
        });
        notify = null;
        continue;
      }

      const event = pending.shift();
      if (event === undefined) continue;

      switch (event.type) {
        case 'session.started':
          sessionId = String(event.sessionId);
          if (sessionId !== announced) {
            announced = sessionId;
            yield { kind: 'session', sessionId };
          }
          break;

        case 'text.delta':
          /*
           * The agent's own words only.
           *
           * A subagent's text arrives on the same feed, marked with the id of
           * the call that spawned it, and it is not the answer: it is a report
           * to the agent, which reads it and then says what it has to say. The
           * caller sees the call itself in the activity report. Relaying the
           * words as well handed a caller every subagent's findings inline
           * *and then* the agent's account of them — the same answer twice, in
           * two voices.
           */
          if (event.agentId !== undefined) break;
          text += event.text;
          yield { kind: 'text', text: event.text };
          break;

        case 'text.complete':
          /*
           * Only when nothing streamed.
           *
           * Providers that stream emit deltas *and* a completing block with the
           * whole text; appending both would double every reply. `partialMessages`
           * says which a provider does, but the honest check is whether anything
           * actually arrived — an adapter that claims streaming and sends none
           * would otherwise produce an empty answer.
           *
           * Never a replayed block: a resumed conversation reads its history
           * back through the same event, and a previous turn's answer is not
           * this turn's. Same rule for a subagent's block as for its deltas.
           */
          if (event.agentId !== undefined || event.replay === true) break;
          if (event.role === 'assistant' && text.length === 0) {
            text += event.text;
            yield { kind: 'text', text: event.text };
          }
          break;

        case 'thinking.delta': {
          /*
           * Forwarded on its own channel, never into `text`.
           *
           * A redacted block has nothing to show — the provider kept the
           * reasoning and sent a signature — and an empty fragment is not a
           * delivery, so neither crosses the wire. The subagent rule is the
           * one `text.delta` gives.
           *
           * The wire has no blocks, only fragments, so the boundary between
           * two reasoning blocks — one either side of a tool call, typically —
           * travels as a paragraph break. Without it the last word of one and
           * the first of the next arrive glued together, on the stream and in
           * the whole reply alike.
           */
          if (event.agentId !== undefined || event.redacted === true || event.text === '') break;
          const block = `${event.messageId}:${String(event.blockIndex)}`;
          const fragment =
            thinkingBlock === undefined || thinkingBlock === block ? event.text : `\n\n${event.text}`;
          thinkingBlock = block;
          thinking += fragment;
          yield { kind: 'thinking', text: fragment };
          break;
        }

        case 'tool.start': {
          const entry: ArtemisActivity = {
            tool: event.name.toLowerCase(),
            at: Date.now(),
            ...(summariseToolInput(event.input) === undefined
              ? {}
              : { summary: summariseToolInput(event.input) }),
          };
          activity.push(entry);
          yield { kind: 'activity', activity: entry };
          break;
        }

        case 'permission.request':
          /*
           * Denied on the spot, unless the caller said there is somebody there.
           *
           * The default is the old one and the message is written for the
           * *model*: it explains the constraint so the agent can choose another
           * route, rather than reading as a fault.
           *
           * The opted-in path answers nothing here, and that is the design
           * rather than an omission. The decision arrives on a different
           * request — often on a different socket, minutes later, after this
           * stream has died — so parking is simply *not replying*: the adapter
           * is already blocked, and `runs.ts` holds the deadline that stops it
           * being blocked forever. All this branch owes the client is the
           * question.
           */
          if (remotePermissions) {
            yield { kind: 'permission', notice: { status: 'requested', request: event.request } };
            break;
          }
          deniedPermission = true;
          await source
            .respondToPermission(runId, String(event.requestId), {
              behavior: 'deny',
              message: UNATTENDED_PERMISSION_MESSAGE,
            })
            .catch(() => undefined);
          break;

        case 'permission.resolved':
          // Only for the client that was told about the request in the first
          // place. A turn on the standing denial saw no question, so news that
          // the question is closed would be an event about nothing.
          if (remotePermissions) {
            yield {
              kind: 'permission',
              notice: {
                status: 'resolved',
                requestId: event.requestId,
                outcome: event.outcome,
                ...(event.note === undefined ? {} : { note: event.note }),
              },
            };
          }
          break;

        case 'usage':
          usage = toOpenAiUsage(event.usage.tokens);
          break;

        case 'run.end': {
          ended = true;
          if (event.sessionId !== undefined) sessionId = String(event.sessionId);
          if (event.usage !== undefined) usage = toOpenAiUsage(event.usage.tokens);
          // The provider's own summary, when it wrote one and nothing streamed.
          if (text.length === 0 && event.result !== undefined) text = event.result;

          yield {
            kind: 'done',
            result: {
              text,
              ...(thinking.length === 0 ? {} : { thinking }),
              finishReason: finishReasonFor(event.reason),
              endReason: event.reason,
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(usage === undefined ? {} : { usage }),
              activity,
              ...(event.reason === 'error'
                ? { error: event.error?.message ?? 'The run failed.' }
                : {}),
              ...(deniedPermission && event.reason === 'permission_denied'
                ? { error: 'The agent needed permission that no one was present to give.' }
                : {}),
            },
          };
          break;
        }

        default:
          // `tool.end`, `background.tasks`, and the rest. Not silently dropped
          // by accident — none of them has a place in an OpenAI reply. (Thinking
          // has its own case above, and its own field on the wire, precisely
          // so it is never concatenated into `content`, where a caller would
          // read a model's private reasoning as its answer.)
          break;
      }
    }
  } finally {
    unsubscribe();

    /*
     * Interrupt on *any* teardown, not just an observed abort.
     *
     * The in-loop `signal.aborted` check only runs while something is pulling
     * from this generator. When a client disconnects, the thing pulling — the
     * SSE writer — stops, and the generator is left suspended at a `yield`
     * with the run still going: the loop never gets another turn, so it never
     * notices, and the provider keeps spending the user's plan on output that
     * will never be read.
     *
     * `finally` runs whichever way the generator ends, including `.return()`
     * from a consumer that walked away, so this is the one place the guarantee
     * can actually be made. `ended` is what keeps a completed turn from being
     * pointlessly interrupted on its way out.
     *
     * Found by the abort test, which passed the in-loop check and still saw the
     * run left running.
     *
     * The exception is a run whose caller asked to keep it. There the same
     * teardown means the opposite thing — the client is gone and the work is
     * meant to survive — so the run is handed on instead of ended, and nothing
     * here disposes it: disposing would release the provider process the whole
     * feature exists to keep. A turn that *finished* is disposed either way,
     * because there is no work left to survive.
     */
    if (runId !== null) {
      if (!ended && detachable) {
        turn.onDetach?.(runId);
      } else {
        if (!ended) await source.interrupt(runId).catch(() => undefined);
        await source.disposeRun(runId).catch(() => undefined);
      }
    }
  }
}

/**
 * OpenAI's four finish reasons, from Artemis's seven end reasons.
 *
 * Everything that is not "ran out of room" reports `stop`, and the true reason
 * travels on `artemis.endReason`. A client switches on `finish_reason`, so a
 * value outside OpenAI's set is an unhandled branch in code we do not own —
 * whereas an extra field it does not read costs it nothing.
 */
export function finishReasonFor(reason: RunEndReason): OpenAiFinishReason {
  return reason === 'max_turns' || reason === 'budget_exceeded' ? 'length' : 'stop';
}

/** Artemis counts more kinds of token than OpenAI reports; these are the three it has. */
function toOpenAiUsage(tokens: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): OpenAiUsage {
  return {
    prompt_tokens: tokens.inputTokens,
    completion_tokens: tokens.outputTokens,
    total_tokens: tokens.inputTokens + tokens.outputTokens,
  };
}

/**
 * One line naming what a tool acted on — never what it found.
 *
 * A path, a command, a pattern. Deliberately not the tool's *result*: that is
 * file contents, and a caller reading activity wants to know the agent read
 * `src/index.ts`, not to receive it.
 */
function summariseToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 200);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Shaping the reply                                                          */
/* -------------------------------------------------------------------------- */

/** Build the whole-response body an OpenAI client expects. */
export function chatResponse(input: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly result: TurnResult;
  readonly ignored: readonly string[];
  readonly resolvedModel?: string;
}): OpenAiChatResponse {
  const { result } = input;
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text,
          ...(result.thinking === undefined ? {} : { reasoning_content: result.thinking }),
        },
        finish_reason: result.finishReason,
      },
    ],
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    artemis: {
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      ...(input.resolvedModel === undefined ? {} : { resolvedModel: input.resolvedModel }),
      ...(input.ignored.length === 0 ? {} : { ignored: input.ignored }),
      ...(result.activity.length === 0 ? {} : { activity: result.activity }),
      endReason: result.endReason,
      // Only reached when the turn produced text *and* failed — a failure with
      // nothing to show for it never gets here, because the handler turns that
      // into a 502 whose body is this same string. Carrying it here is what
      // makes the two paths agree: a caller should not have to know whether the
      // reason arrives as a status code or as a field.
      ...(result.error === undefined ? {} : { error: result.error }),
    },
  };
}

/** One streamed chunk, in OpenAI's shape. */
export function chatChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly delta: {
    readonly role?: 'assistant';
    readonly content?: string;
    readonly reasoning_content?: string;
  };
  readonly finishReason?: OpenAiFinishReason;
  readonly usage?: OpenAiUsage;
  readonly artemis?: OpenAiChatChunk['artemis'];
}): OpenAiChatChunk {
  return {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.artemis === undefined ? {} : { artemis: input.artemis }),
  };
}
