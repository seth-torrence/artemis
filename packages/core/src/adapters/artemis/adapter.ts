/**
 * The Artemis-server adapter — one Artemis driving another.
 * ============================================================================
 *
 * `packages/core/src/server` is the half of this that *serves*: it runs a full
 * agent turn under one of the user's profiles and streams it out as an
 * OpenAI-shaped completion. This is the other half — the provider row that
 * lets *this* Artemis be the client, pointed at that server on another machine
 * over whatever tunnel reaches its loopback.
 *
 * ## What is different about this provider
 *
 * The other endpoint providers (`local/adapter.ts`) wrap inference servers, so
 * the agent loop is Artemis's own: it offers tools, executes them here, and
 * asks permission here. The Artemis server is the opposite — **the remote end
 * already ran the whole agent turn**. Reusing the local adapter (or pointing a
 * llamacpp profile at this server) would put a second harness around a
 * finished one: tools offered twice, a `cwd` that names a directory on the
 * wrong machine, permission prompts for work that already happened. So this
 * adapter is a renderer of someone else's run: one streamed request per turn,
 * no loop, no tools, no sandbox.
 *
 * Three consequences, each carried on the capability descriptor rather than
 * discovered by a user:
 *
 *  - **Turns run in the connection's workspace, on the server's machine.**
 *    The remote pins its working directory per connection token when the
 *    token is created; the `cwd` chosen here does not travel (there is
 *    deliberately no `cwd` on the wire — see `protocol/src/server.ts`).
 *  - **Permission prompts come back to this machine.** A person is present
 *    here even though the tool call runs over there, so a run opts into remote
 *    permissions and the server puts each prompt on the wire instead of denying
 *    it. The run's *mode* is still the serving user's — no mode picker — but the
 *    approval itself is answered here, on a native run route.
 *  - **The conversation lives on the server.** It stores real sessions, so
 *    `resumeSession` is honestly true: the `artemis.sessionId` a turn reports
 *    is passed back to continue it — the one capability the raw local
 *    endpoints cannot offer.
 *
 * ## A stream that dies is picked back up
 *
 * One request per turn, but not one *socket* per turn. A laptop sleeps, a
 * tunnel drops, the server restarts under a deploy — and the run, kept alive
 * by `artemis.remote.detach`, goes on without anyone watching. Until this
 * adapter could reattach, that was an error card and a conversation the user
 * could only read back as history. Now every chunk carries the server's
 * cursor (`artemis.seq`), the server sends a heartbeat comment through the
 * quiet stretches, and when the stream ends without its sentinel — or goes
 * silent past the watchdog on a server that has proven it heartbeats — the
 * run reconnects with backoff to `GET /api/v0/runs/{id}/stream?after=N` and
 * carries on from the last chunk it rendered. See {@link ArtemisRun}.
 *
 * ## The profile is an endpoint, and the key is a connection token
 *
 * Same entry model as the local providers: `baseUrl` for the address, and the
 * encrypted per-profile key for the credential — here the *connection token*
 * the serving Artemis minted, sent as the same `Authorization: Bearer` the
 * local servers read.
 */

import type {
  AgentError,
  AgentEvent,
  ArtemisActivity,
  ArtemisPermissionNotice,
  Capabilities,
  MessageId,
  PermissionDecision,
  PermissionRequest,
  PermissionRequestId,
  ProviderEffortOption,
  ProviderId,
  RunEndReason,
  RunId,
  RunsSendResponse,
  RunStatus,
  ServerSessionDeletedBody,
  ServerSessionMessagesBody,
  ServerSessionsBody,
  ServerSessionTaggedBody,
  SessionId,
  SessionSummary,
  ToolCallId,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import {
  defaultBaseUrlFor,
  LOCAL_API_KEY_ENV,
  LOCAL_BASE_URL_ENV,
  NO_CAPABILITIES,
  SERVER_API_VERSION,
} from '@rx-artemis/protocol';

import { AsyncQueue } from '../stream.js';
import { AdapterError, adapterError } from '../types.js';
import type {
  AggregatedSessionList,
  AllSessionsQuery,
  InterruptResult,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionListPage,
  SessionListQuery,
  SessionDeleteQuery,
  SessionMessagesQuery,
  SessionTagQuery,
  SessionTitleUpdate,
  SessionTranscript,
} from '../types.js';
import { splitEvents } from '../local/stream.js';
import { parseServerModels } from './catalogue.js';
import { guardRemoteDecision } from './permissions.js';
import { readServerLine, type ServerStreamDelta } from './stream.js';

export const ARTEMIS_PROVIDER_ID: ProviderId = 'artemis';

/** The server's own API, versioned the way `server/http.ts` builds it. */
const API_PREFIX = `/api/${SERVER_API_VERSION}`;

/**
 * What driving a remote Artemis can honestly claim.
 *
 * Read the `false` rows against the module header: most are not "not yet" but
 * "not here" — the work happens on the server's machine, under the server's
 * own settings, and claiming a control this side cannot honour would be worse
 * than omitting it.
 */
export const ARTEMIS_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  // The server streams text fragments as the remote agent produces them.
  partialMessages: true,
  // Final chunks carry token counts when the remote provider reported them.
  usageReporting: true,
  // The server stores real sessions; `artemis.sessionId` continues one. The
  // raw local endpoints cannot say this — their server remembers nothing.
  resumeSession: true,
  // The server lists the sessions this connection's scope created — see its
  // ledger — and replays their stored messages. This is what makes the same
  // conversations reachable from every machine holding the token.
  listSessions: true,
  // The server's session surface takes writes now, one route each: a title
  // stored exactly as a local rename stores one, the provider's own tag (which
  // is what archiving is built on), and a real deletion. All three are scoped
  // by the server's ledger to the sessions this connection can already see.
  renameSession: true,
  deleteSession: true,
  tagSession: true,
  // A run that opts into remote permissions parks on a prompt instead of denying
  // it: the request rides an empty-delta chunk in the `artemis` namespace, and
  // the answer goes back on `POST /api/v0/runs/{id}/permission`. A person is
  // present *here* — at this machine — even though the tool call runs on the
  // server's, which is the whole difference from an unattended `curl`.
  interactivePermissions: true,
  // A message can be steered into the turn already in flight —
  // `POST /api/v0/runs/{id}/messages` — so the composer stays live mid-run.
  midRunSteering: true,
  // The server reports every served account's plan gauges on
  // `GET /api/v0/usage`, fanned out by the desktop's poller into one push per
  // account. The flag is what lets the status-bar meter mount at all; the
  // readings themselves arrive keyed by served account, not by this profile,
  // and the renderer joins them through the active model's `accountId`.
  planUsageReporting: true,
  // The person answering the prompts picks how they are asked. Carried on the
  // wire as a request; the server drops modes the serving provider lacks, and
  // an older server drops the field entirely — both degrade to the serving
  // user's setting. The trust argument is on the wire type: a client that can
  // approve every remote prompt already holds everything a mode grants.
  permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
  // Still false, for the reason the module header gives: the remote agent's
  // instructions are the serving user's settings, and the completions route
  // deliberately takes no system prompt from an HTTP caller (see
  // `RunSource.startRun`). A `systemPrompt` sent here would be silently dropped,
  // which is the one failure this flag exists to prevent.
  systemPromptAppend: false,
};

/**
 * The thinking levels a run may ask for, as one static descriptor list.
 *
 * The honest source of truth is per route — a server fronts Claude, Codex or a
 * local endpoint, and each names its own scale — so the levels valid on a given
 * model arrive live on {@link ProviderModelOption.effortLevels}, mapped from the
 * server's `thinkingLevels`. What a *descriptor* needs is a label and a note for
 * each id the picker might show, and those cannot be fetched before a profile is
 * even chosen. This is the union the providers a server routes to actually use;
 * a route that accepts none of them narrows the picker to nothing through its
 * own empty `effortLevels`, and a level a route does not list is shown disabled
 * rather than sent.
 */
const ARTEMIS_EFFORT_LEVELS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Least reasoning, fastest reply.' },
  { id: 'medium', label: 'Medium', note: 'A middle setting.' },
  { id: 'high', label: 'High', note: 'More reasoning before answering.' },
  { id: 'xhigh', label: 'Extra high', note: 'Deeper still, where the model offers it.' },
  { id: 'max', label: 'Max', note: 'The most the model will spend.' },
];

/** No account to sign in to — the credential is the server's connection token. */
function artemisCredentials(): ProviderCredentialSpec {
  return {
    // Nothing is spawned, so nothing reads this — but the field is required
    // and an inert, clearly-named variable is more honest than borrowing one.
    configDirVar: 'ARTEMIS_LOCAL_PROFILE_DIR',
    // History lives on the server, behind the same token runs use — a history
    // read here is an authenticated request, not a file read, so the engine
    // hands it the credential-bearing environment. See the spec's own doc.
    sessionStore: 'remote',
    // Both are set by Artemis from the profile, so both must be scrubbed from
    // whatever the user's shell happens to export — the same reasoning as the
    // local adapter, whose variables these are.
    credentialEnvKeys: [LOCAL_BASE_URL_ENV, LOCAL_API_KEY_ENV],
    signIn: {
      executable: 'true',
      loginArgs: [],
      statusArgs: [],
      logoutArgs: [],
      howTo:
        'Nothing to sign in to here. Point this profile at a running Artemis server and paste one of its connection tokens as the API key.',
      // There is no account to probe: the credential is a connection token, and
      // whether it works is what the availability probe already establishes. So
      // the status is a constant, not a throwaway `true` spawned on every one of
      // the profile screen's two-second polls. See `staticStatus`.
      staticStatus: { loggedIn: true },
    },
  };
}

/** The endpoint this profile talks to. */
function baseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const declared = env[LOCAL_BASE_URL_ENV];
  const chosen =
    declared !== undefined && declared.trim() !== ''
      ? declared.trim()
      : defaultBaseUrlFor(ARTEMIS_PROVIDER_ID);
  return chosen.replace(/\/+$/, '');
}

/**
 * Headers for a request to that endpoint. `Bearer`, because that is what the
 * server's `resolveConnection` reads; no header at all when there is no token,
 * for the same proxy reasons as the local adapter.
 */
function authHeaders(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const key = env[LOCAL_API_KEY_ENV];
  return key !== undefined && key.trim() !== '' ? { authorization: `Bearer ${key.trim()}` } : {};
}

/*
 * The same two derivations, for `admin.ts`.
 *
 * Exported rather than re-derived there, because both are small enough to look
 * like nothing and are not: the trailing-slash strip is the difference between
 * `/api/v0/…` and `//api/v0/…`, which is a 404 that reads as a missing route,
 * and the header name is what the server's `resolveConnection` reads.
 */
export { baseUrl as artemisEndpoint, authHeaders as artemisAuthHeaders };

/** Token counts in the shape the seam expects. */
function toUsage(usage: { promptTokens: number; completionTokens: number }): UsageSnapshot {
  return {
    scope: 'final',
    tokens: { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens },
  };
}

/** The seven end reasons cross the wire as strings; read one back safely. */
const END_REASONS: readonly RunEndReason[] = [
  'completed',
  'interrupted',
  'disposed',
  'max_turns',
  'budget_exceeded',
  'permission_denied',
  'error',
];

function asEndReason(value: string | undefined): RunEndReason | undefined {
  return (END_REASONS as readonly string[]).includes(value ?? '')
    ? (value as RunEndReason)
    : undefined;
}

/** Tuning for the reconnect loop. Tests shorten these; the registry takes the defaults. */
export interface ArtemisReconnectOptions {
  /**
   * How long a stream may be silent before it is presumed dead, once the
   * server has shown that it sends heartbeats. Three of the server's
   * fifteen-second beats by default: one lost beat is a hiccup, three is a
   * link that has gone.
   */
  readonly watchdogMs?: number;
  /** Waits between reconnect attempts, the last one repeated for as long as it takes. */
  readonly backoffMs?: readonly number[];
}

const DEFAULT_WATCHDOG_MS = 45_000;
const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** How long a reconnect waits for the server's headers before trying again. */
const RECONNECT_HANDSHAKE_MS = 15_000;

/** The one stream's worth of state that has to outlive a socket. */
interface StreamState {
  /** Everything the turn says lands on this one message; blocks number within it. */
  readonly messageId: MessageId;
  activity: readonly ArtemisActivity[];
  endReason: string | undefined;
  remoteError: string | undefined;
  /** Relay a reasoning fragment into the block in progress, or open one. */
  thinking(text: string): void;
  /** Relay an answer fragment the same way. */
  text(text: string): void;
  /** Close the block in progress, finalising an answer block with its `text.complete`. */
  close(): void;
}

/**
 * One turn against a remote Artemis.
 *
 * Opens one streamed completion and renders it: deltas as they arrive, then
 * the final chunk's activity report as settled tool rows, then `run.end`.
 *
 * ## The session id is never guessed
 *
 * `session.started` is emitted with a *real* id or not at all. On a resumed
 * turn the id is known up front and the event is first, as the contract asks.
 * On a fresh turn the server announces the id on an early chunk (older servers
 * only on the final one), and the event is emitted the moment it arrives —
 * which against an older server means after the first text deltas. That bends
 * the ordering contract, deliberately: the alternative is the local adapter's
 * placeholder id, and with `resumeSession: true` a placeholder that leaked
 * into `run.end` on a failed stream would be promoted to the pane's resume
 * target — a session the server has never heard of, poisoning every following
 * turn. A late `session.started` renders fine; a fabricated session id does
 * not.
 *
 * ## One message, several blocks, and every block names its index
 *
 * The wire is one flat stream of fragments — answer text on `content`,
 * reasoning on `reasoning_content` — with no block structure of its own. This
 * run rebuilds one: each stretch of reasoning and each stretch of answer is a
 * block of the single message the turn produces, numbered in the order they
 * arrived, so a transcript draws them in that order — the thinking that came
 * *after* the first sentence lands after it rather than being glued onto the
 * fold above.
 *
 * Every `text.complete` carries the `blockIndex` its deltas carried, and that
 * is a fix rather than tidiness. The transcript keys blocks by (message,
 * index) and settles every streaming block the moment a tool row lands. The
 * closing completion used to be sent *after* the activity report and without
 * an index, so by the time it arrived the block its deltas had built was
 * already settled, the index-less lookup could not find it, a fresh block was
 * opened, and the reader saw the whole answer twice — once streamed, once
 * whole. Now the completion names its block and lands before the report, so
 * it finalises the block it belongs to, which is what a completion is for.
 */
class ArtemisRun implements Run {
  readonly runId: RunId;
  readonly providerId: ProviderId = ARTEMIS_PROVIDER_ID;
  readonly capabilities = ARTEMIS_CAPABILITIES;

  #status: RunStatus = 'running';
  #seq = 0;
  #sessionId: SessionId | undefined;
  #sessionAnnounced = false;
  #usage: UsageSnapshot | undefined;
  /**
   * The server's run id, learned off the stream the way the session id is and
   * kept for the native `/api/v0/runs/{id}` routes. Distinct from {@link runId},
   * which is this adapter's local id; the two never share a value.
   */
  #remoteRunId: RunId | undefined;
  /** Open permission prompts, to move {@link status} in and out of `awaiting_permission`. */
  #openPermissions = 0;
  readonly #queue = new AsyncQueue<AgentEvent>();
  /** The run's own stop: `interrupt` and `dispose`. Never a reconnect's. */
  readonly #abort = new AbortController();
  readonly #input: ResolvedRunInput;
  readonly #reconnect: Required<ArtemisReconnectOptions>;
  /**
   * The last cursor rendered, handed back as `after` when the stream is picked
   * up again. `-1` until the first numbered chunk: a stream that dies before
   * one is resumed from the beginning, which is right, because nothing of it
   * has been drawn.
   */
  #lastSeq = -1;
  /**
   * Whether this server has sent a heartbeat comment yet. The watchdog arms
   * only once it has: an older server sends none, and its silence during a
   * long tool call is not evidence of anything.
   */
  #heartbeats = false;
  #notices = 0;

  constructor(input: ResolvedRunInput, reconnect: Required<ArtemisReconnectOptions>) {
    this.runId = input.runId;
    this.#input = input;
    this.#reconnect = reconnect;
    void this.#drive();
  }

  get status(): RunStatus {
    return this.#status;
  }

  get sessionId(): SessionId | undefined {
    return this.#sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#queue;
  }

  #emit(event: Omit<AgentEvent, 'runId' | 'seq' | 'ts'>): void {
    this.#queue.push({
      ...event,
      runId: this.runId,
      seq: this.#seq++,
      ts: Date.now(),
    } as AgentEvent);
  }

  /** Emit `session.started` once, only ever with an id the server owns. */
  #noteSession(sessionId: string): void {
    this.#sessionId = sessionId as SessionId;
    if (this.#sessionAnnounced) return;
    this.#sessionAnnounced = true;
    this.#emit({
      type: 'session.started',
      sessionId: this.#sessionId,
      providerId: ARTEMIS_PROVIDER_ID,
      cwd: this.#input.cwd,
      ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
      ...(this.#input.resumeSessionId === undefined
        ? {}
        : { resumedFrom: this.#input.resumeSessionId }),
    } as never);
  }

  /**
   * Draw or clear a permission card from a notice on the stream.
   *
   * The request is re-emitted verbatim but for its `runId`, which is re-stamped
   * to *this* run so every event in the transcript agrees on one id. The
   * server's `request.id` is left untouched and becomes the answer key:
   * `respondToPermission` posts it straight back, because that is what the
   * server matches on. Both states are emitted — a `resolved` may arrive from
   * another client's answer or the park deadline, and a card left open over a
   * decision already made is the one thing this event exists to prevent.
   */
  #notePermission(notice: ArtemisPermissionNotice): void {
    if (notice.status === 'requested') {
      this.#openPermissions += 1;
      this.#status = 'awaiting_permission';
      const request: PermissionRequest = { ...notice.request, runId: this.runId };
      this.#emit({ type: 'permission.request', requestId: request.id, request } as never);
      return;
    }
    this.#openPermissions = Math.max(0, this.#openPermissions - 1);
    if (this.#openPermissions === 0 && this.#status === 'awaiting_permission') {
      this.#status = 'running';
    }
    this.#emit({
      type: 'permission.resolved',
      requestId: notice.requestId as PermissionRequestId,
      outcome: asResolvedOutcome(notice.outcome),
      ...(notice.note === undefined ? {} : { note: notice.note }),
    } as never);
  }

  async #drive(): Promise<void> {
    try {
      // A resumed turn knows its session before the first byte arrives.
      if (this.#input.resumeSessionId !== undefined) {
        this.#noteSession(this.#input.resumeSessionId);
      }

      const root = baseUrl(this.#input.env);
      const extensions = {
        ...(this.#input.resumeSessionId === undefined
          ? {}
          : { sessionId: this.#input.resumeSessionId }),
        // The wire already carries thinking as `artemis.thinking`; the picker's
        // choice is `input.effort`, validated against the route's own levels
        // before it ever reaches here. A route that takes none has an empty
        // effort list, so nothing is sent.
        ...(this.#input.effort === undefined ? {} : { thinking: this.#input.effort }),
        ...(this.#input.fastMode === undefined ? {} : { fastMode: this.#input.fastMode }),
        ...(this.#input.ultracode === undefined ? {} : { ultracode: this.#input.ultracode }),
        // Opt into the two behaviours a remote client needs and a script does
        // not: a disconnect detaches the run rather than killing it, and a
        // permission prompt comes back here to be answered instead of being
        // denied on the spot. Both are ignored by a server too old to know them
        // — which is the graceful degradation, an old server keeping today's
        // read-only behaviour.
        remote: { detach: true, permissions: true },
        // A request, dropped by the server when the serving provider lacks
        // the mode — and by an older server that has never heard the field.
        // Either way the run opens in the serving user's setting, which is
        // yesterday's behaviour exactly.
        ...(this.#input.permissionMode === undefined
          ? {}
          : { permissionMode: this.#input.permissionMode }),
      };
      const stream = this.#streamState();
      let attempt = new AbortController();
      const response = await fetch(`${root}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(this.#input.env) },
        signal: AbortSignal.any([this.#abort.signal, attempt.signal]),
        body: JSON.stringify({
          model: this.#input.model,
          messages: [{ role: 'user', content: this.#input.prompt }],
          stream: true,
          stream_options: { include_usage: true },
          ...(Object.keys(extensions).length === 0 ? {} : { artemis: extensions }),
        }),
      });

      if (!response.ok || response.body === null) {
        throw await refusalError(response, root);
      }

      let outcome = await this.#consume(response.body, stream, attempt);

      /*
       * The stream died and the run did not.
       *
       * `detach` kept the run alive on the server the moment the socket went;
       * what happens next is this loop, and it is the whole difference between
       * a laptop that slept through a turn waking to an error card and one
       * that wakes to the rest of the answer. Each pass says the link is gone,
       * reconnects with backoff from the last cursor rendered, and consumes
       * the resumed stream exactly as it consumed the first. It ends the way
       * the first stream would have: on the sentinel, on a refusal the server
       * wrote into the stream, or on the user's own stop.
       */
      while (outcome === 'broken') {
        if (this.#abort.signal.aborted) throw adapterError('cancelled', 'The run was stopped.');
        if (this.#remoteRunId === undefined) {
          throw adapterError(
            'provider_unavailable',
            'Could not reach the Artemis server: the stream ended before the server announced the run, so there was nothing to pick back up.',
          );
        }
        stream.close();
        this.#notice(
          'The connection to the Artemis server dropped. The run is still going there; this pane will pick it up again when the link is back.',
        );
        const resumed = await this.#resume(root);
        attempt = resumed.attempt;
        this.#notice('Reconnected to the Artemis server. Catching up.');
        outcome = await this.#consume(resumed.body, stream, attempt);
      }

      // The answer is whole before the report of how it was reached: the last
      // block closes here, with the `text.complete` that finalises it.
      stream.close();

      /*
       * The activity report, rendered as settled tool rows. It arrives whole
       * on the final chunk, so these rows land after the text — a summary of
       * what the remote agent did, not a live feed of it doing so. Each entry
       * is already summarised to a target, never contents.
       */
      stream.activity.forEach((entry, index) => {
        const toolCallId = `${this.runId}-act-${index}` as ToolCallId;
        this.#emit({
          type: 'tool.start',
          toolCallId,
          name: entry.tool,
          input: {},
          ...(entry.summary === undefined ? {} : { title: entry.summary }),
        } as never);
        this.#emit({
          type: 'tool.end',
          toolCallId,
          name: entry.tool,
          status: entry.ok === false ? 'error' : 'ok',
          ...(entry.summary === undefined ? {} : { resultText: entry.summary }),
        } as never);
      });

      const reason = asEndReason(stream.endReason) ?? 'completed';
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason,
        ...(reason === 'error'
          ? {
              error: {
                code: 'unknown',
                message:
                  stream.remoteError ??
                  'The remote run failed, and this server did not say why. Servers before 2.4.7 send no reason; its own logs will have one.',
              } satisfies AgentError,
            }
          : {}),
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      } as never);
    } catch (error) {
      const aborted = this.#abort.signal.aborted;
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: aborted ? 'interrupted' : 'error',
        ...(aborted ? {} : { error: toError(error) }),
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      } as never);
    } finally {
      this.#queue.close();
    }
  }

  /**
   * The block bookkeeping for one turn. See the class comment: a change of
   * kind — reasoning to answer, answer to reasoning — closes the block and
   * opens the next, and a closing answer block is finalised with a
   * `text.complete` that names it. Held outside the socket loop because a
   * reconnect continues the same message, not a new one.
   */
  #streamState(): StreamState {
    const messageId = `${this.runId}-0` as MessageId;
    let blockIndex = 0;
    let blockKind: 'text' | 'thinking' | undefined;
    let blockText = '';
    const close = (): void => {
      if (blockKind === 'text' && blockText !== '') {
        this.#emit({
          type: 'text.complete',
          messageId,
          role: 'assistant',
          blockIndex,
          text: blockText,
        } as never);
      }
      if (blockKind !== undefined) blockIndex += 1;
      blockKind = undefined;
      blockText = '';
    };
    const open = (kind: 'text' | 'thinking'): void => {
      if (blockKind === kind) return;
      close();
      blockKind = kind;
    };
    return {
      messageId,
      activity: [],
      endReason: undefined,
      remoteError: undefined,
      thinking: (text) => {
        open('thinking');
        this.#emit({ type: 'thinking.delta', messageId, blockIndex, text } as never);
      },
      text: (text) => {
        open('text');
        blockText += text;
        this.#emit({ type: 'text.delta', messageId, blockIndex, text } as never);
      },
      close,
    };
  }

  /**
   * Read one stream to its end.
   *
   * `done` is the sentinel: the turn is over. `broken` is everything else the
   * link can do — the body ending without it, a socket reset, the watchdog's
   * abort — and it means the run is still going somewhere that can no longer
   * be heard. The two things that are *not* a break are thrown: a refusal
   * the server wrote into the stream, which is final, and the user's own
   * stop, which the caller reports as an interruption.
   */
  async #consume(
    body: ReadableStream<Uint8Array>,
    stream: StreamState,
    attempt: AbortController,
  ): Promise<'done' | 'broken'> {
    const decoder = new TextDecoder();
    let buffer = '';
    const watchdog = this.#watchdog(attempt);
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        // A comment line is the server's heartbeat. Seeing one is what arms
        // the watchdog for the rest of this run; any byte at all resets it.
        if (!this.#heartbeats && /(^|\n):/.test(text)) this.#heartbeats = true;
        watchdog.touch();
        buffer += text;
        const { lines, rest } = splitEvents(buffer);
        buffer = rest;

        for (const line of lines) {
          const delta = readServerLine(line);
          if (delta === null) continue;
          if (delta === 'done') return 'done';
          if (delta.error !== undefined) throw adapterError('provider_unavailable', delta.error);
          this.#apply(delta, stream);
        }
      }
      // The body ended without the sentinel: the server went away mid-turn.
      return 'broken';
    } catch (error) {
      if (error instanceof AdapterError || this.#abort.signal.aborted) throw error;
      return 'broken';
    } finally {
      watchdog.stop();
    }
  }

  /** Fold one chunk's delta into the run. */
  #apply(delta: ServerStreamDelta, stream: StreamState): void {
    const extensions = delta.artemis;
    if (extensions?.sessionId !== undefined) this.#noteSession(extensions.sessionId);
    // Learned like the session id: the server announces it once and early,
    // and every native run route addresses it from here on.
    if (extensions?.runId !== undefined) this.#remoteRunId = extensions.runId as RunId;
    if (extensions?.permission !== undefined) this.#notePermission(extensions.permission);
    // The final chunk's report replaces, not appends — it is the whole list,
    // arriving once.
    if (extensions?.activity !== undefined) stream.activity = extensions.activity;
    if (extensions?.endReason !== undefined) stream.endReason = extensions.endReason;
    if (extensions?.error !== undefined) stream.remoteError = extensions.error;
    if (extensions?.gap !== undefined) {
      stream.close();
      this.#notice(
        'Some of what the run did while this pane was disconnected is no longer on the server and could not be replayed.',
      );
    }
    if (delta.usage !== undefined) this.#usage = toUsage(delta.usage);
    if (delta.thinking !== undefined) stream.thinking(delta.thinking);
    if (delta.text !== undefined) stream.text(delta.text);
    // Last, so a chunk that failed to apply is not remembered as rendered.
    if (extensions?.seq !== undefined) this.#lastSeq = extensions.seq;
  }

  /**
   * Presume a silent stream dead.
   *
   * Armed only once this server has sent a heartbeat, and re-armed by every
   * byte that arrives. Firing aborts the attempt's own controller — never the
   * run's — so the consume loop sees a break and the reconnect loop takes
   * over. Unref'd: a watchdog is a safety net over a stream the process is
   * reading anyway, never a reason for the process to stay up.
   */
  #watchdog(attempt: AbortController): { touch(): void; stop(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const touch = (): void => {
      stop();
      if (!this.#heartbeats) return;
      timer = setTimeout(() => attempt.abort(), this.#reconnect.watchdogMs);
      timer.unref();
    };
    return { touch, stop };
  }

  /**
   * Reconnect to the run's stream, however long it takes.
   *
   * Backoff between tries, a bounded wait for the headers of each, and three
   * answers that end the trying: the run is over (`[DONE]` arrives on the
   * stream this returns), the server no longer has it, or the token no longer
   * works. Anything else — unreachable, a 5xx, a handshake that never came —
   * is the link still down, and the next try waits a little longer. The user's
   * own stop ends it too, from any wait.
   */
  async #resume(root: string): Promise<{ body: ReadableStream<Uint8Array>; attempt: AbortController }> {
    const { backoffMs } = this.#reconnect;
    for (let tries = 0; ; tries += 1) {
      await this.#pause(backoffMs[Math.min(tries, backoffMs.length - 1)] ?? 1_000);
      if (this.#abort.signal.aborted) throw adapterError('cancelled', 'The run was stopped.');

      const attempt = new AbortController();
      const after = this.#lastSeq >= 0 ? `?after=${String(this.#lastSeq)}` : '';
      const url = `${root}${API_PREFIX}/runs/${encodeURIComponent(String(this.#remoteRunId))}/stream${after}`;
      // A handshake that never completes is a link that is still down. The
      // timer covers the headers only: the body it guards is the whole point.
      const handshake = setTimeout(() => attempt.abort(), RECONNECT_HANDSHAKE_MS);
      handshake.unref();
      let response: Response;
      try {
        response = await fetch(url, {
          headers: authHeaders(this.#input.env),
          signal: AbortSignal.any([this.#abort.signal, attempt.signal]),
        });
      } catch (error) {
        if (this.#abort.signal.aborted) throw error;
        continue;
      } finally {
        clearTimeout(handshake);
      }

      if (response.ok && response.body !== null) return { body: response.body, attempt };
      if (response.status === 404) {
        throw adapterError(
          'provider_unavailable',
          'The Artemis server no longer has this run: it was reaped after nobody came back for it, the server restarted, or it predates resumable streams. The conversation itself is still there — send another message to continue it.',
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw adapterError(
          'auth',
          `The Artemis server refused the request (${String(response.status)}). Check this profile's connection token.`,
        );
      }
      // Anything else is the server having a bad moment. Try again.
    }
  }

  /** Sleep, unless the run is stopped first. */
  #pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const signal = this.#abort.signal;
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * A line in the transcript from this adapter rather than from the model.
   *
   * The same shape a provider's own refusal notice takes — synthetic assistant
   * text on a message of its own — so the reader can tell "the link dropped"
   * from something the agent said.
   */
  #notice(text: string): void {
    this.#notices += 1;
    this.#emit({
      type: 'text.complete',
      messageId: `${this.runId}-notice-${String(this.#notices)}` as MessageId,
      role: 'assistant',
      text,
      synthetic: true,
    } as never);
  }

  /** POST to a native run route with this profile's token and a short timeout. */
  async #post(url: string, body: unknown): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.#input.env) },
      body: JSON.stringify(body),
      // Its own timeout, not the stream's abort: interrupt aborts the stream on
      // purpose, and a message or an answer must still reach a run whose stream
      // is being torn down in the same breath.
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** The address of a native route on this run, or the reason there is none yet. */
  #runRoute(action: 'messages' | 'interrupt' | 'permission'): string {
    const runId = this.#remoteRunId;
    if (runId === undefined) {
      throw adapterError(
        'invalid_request',
        'The Artemis server has not announced this run yet. Wait for it to start before steering, stopping or answering it.',
      );
    }
    return `${baseUrl(this.#input.env)}${API_PREFIX}/runs/${encodeURIComponent(runId)}/${action}`;
  }

  async send(text: string): Promise<SendResult> {
    const response = await this.#post(this.#runRoute('messages'), { text });
    if (!response.ok) throw await runRouteError(response, 'steer this run');
    const reply = (await response.json()) as Partial<RunsSendResponse>;
    // Reported, not inferred: a server that filed the text for the next turn
    // says so, and a caller told its correction landed when it did not would
    // misread the next minute of the agent's work.
    return { deliveredImmediately: reply.deliveredImmediately === true };
  }

  async interrupt(): Promise<InterruptResult> {
    // With `detach` set, a vanished socket no longer means "stop" — it means
    // "keep going". So the interrupt has to say so out loud, on the route the
    // server keeps for exactly this. The abort that follows is what ends the
    // *local* stream; a server too old for the run routes never announced an id,
    // so it is stopped by that abort alone, as it always was.
    if (this.#remoteRunId !== undefined) {
      await this.#post(this.#runRoute('interrupt'), {}).catch(() => undefined);
    }
    this.#abort.abort();
    return { stillQueued: [] };
  }

  async respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    // Refuse client-side exactly what the server would refuse with a 400, so the
    // UI never offers an option the wire cannot carry: no mode switch (and so no
    // bypassPermissions), no directory grant, no durable scope. See
    // `guardRemoteDecision`, which mirrors the server's `reviewPermissionDecision`.
    guardRemoteDecision(decision);
    const response = await this.#post(this.#runRoute('permission'), { requestId, decision });
    if (!response.ok) throw await runRouteError(response, 'answer this prompt');
  }

  dispose(): Promise<void> {
    // Aborting the stream is a *disconnect*, which on a detachable run is a
    // detach rather than a stop — the run keeps working on the server for a
    // while, reachable again by its id. Stopping for good is `interrupt`.
    this.#abort.abort();
    this.#queue.close();
    return Promise.resolve();
  }
}

/** The three outcomes a resolution carries; read one back safely. */
const RESOLVED_OUTCOMES = ['allowed', 'denied', 'withdrawn'] as const;

/**
 * Coerce a wire outcome into the event's own union. An unknown value reads as
 * `withdrawn` — "the choice was taken away" — which is the safe rendering of a
 * resolution this build does not recognise: never a decision the user did not
 * make.
 */
function asResolvedOutcome(value: string): (typeof RESOLVED_OUTCOMES)[number] {
  return (RESOLVED_OUTCOMES as readonly string[]).includes(value)
    ? (value as (typeof RESOLVED_OUTCOMES)[number])
    : 'withdrawn';
}

/**
 * Read a failure off a native run route.
 *
 * A 404 is the ownership check refusing an id that is not this connection's, or
 * a run the server has already reaped — `invalid_request`, because the run the
 * caller named is not there to act on. A 401/403 is the token; everything else
 * is the server itself.
 */
async function runRouteError(
  response: { readonly status: number; json(): Promise<unknown> },
  action: string,
): Promise<AdapterError> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    detail = typeof body.error?.message === 'string' ? body.error.message : undefined;
  } catch {
    /* a failure with no JSON body still gets a message below */
  }
  if (response.status === 401 || response.status === 403) {
    return adapterError(
      'auth',
      `The Artemis server refused the request (${response.status}). Check this profile's connection token.`,
    );
  }
  if (response.status === 404) {
    return adapterError(
      'invalid_request',
      detail ?? 'The server has no such run for this connection — it may have ended or been reaped.',
    );
  }
  return adapterError(
    'provider_unavailable',
    detail ?? `The Artemis server answered ${response.status} trying to ${action}.`,
  );
}

/**
 * `runRouteError`'s sibling for the session-mutation routes.
 *
 * Separate because the 404 story differs: on a run route it means the run
 * ended, here it means the ledger does not grant this token the session — or
 * the server predates the mutation routes entirely, which answers with the
 * same status and deserves a sentence pointing at the upgrade.
 */
async function sessionMutationError(
  response: { readonly status: number; json(): Promise<unknown> },
  action: string,
): Promise<AdapterError> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    detail = typeof body.error?.message === 'string' ? body.error.message : undefined;
  } catch {
    /* a failure with no JSON body still gets a message below */
  }
  if (response.status === 401 || response.status === 403) {
    return adapterError(
      'auth',
      `The Artemis server refused the request (${response.status}). Check this profile's connection token.`,
    );
  }
  if (response.status === 404) {
    return adapterError(
      'invalid_request',
      detail ??
        'The server has no such conversation for this connection — or it predates session management; update the server.',
    );
  }
  if (response.status === 501) {
    return adapterError('invalid_request', detail ?? `The serving account cannot ${action}.`);
  }
  return adapterError(
    'provider_unavailable',
    detail ?? `The Artemis server answered ${String(response.status)} trying to ${action}.`,
  );
}

/** Read a refusal body — `ServerErrorBody` when the server wrote one. */
async function refusalError(
  response: { readonly status: number; json(): Promise<unknown> },
  root: string,
): Promise<AdapterError> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    detail = typeof body.error?.message === 'string' ? body.error.message : undefined;
  } catch {
    /* a refusal with no JSON body still gets the status-line message below */
  }

  if (response.status === 401 || response.status === 403) {
    return adapterError(
      'auth',
      `The Artemis server at ${root} refused the request (${response.status}). Check this profile's API key — it should be one of that server's connection tokens.`,
    );
  }
  if (response.status === 404) {
    return adapterError(
      'model_unavailable',
      detail ?? 'The server does not offer that model route. Refresh the model list and pick again.',
    );
  }
  return adapterError(
    'provider_unavailable',
    detail ?? `The Artemis server at ${root} answered ${response.status}.`,
  );
}

/** Normalise a thrown value into the error a `run.end` carries. */
function toError(error: unknown): AgentError {
  if (error instanceof AdapterError) return error.agentError;
  if (error instanceof Error && error.name === 'AbortError') {
    return adapterError('cancelled', 'The run was stopped.').agentError;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return adapterError('provider_unavailable', `Could not reach the Artemis server. ${detail}`)
    .agentError;
}

/** Build the adapter. */
/**
 * `GET /api/v0/sessions`, mapped to the shape the sidebar renders.
 *
 * Every row is stamped with the asking profile — on this machine the identity
 * is "the Artemis-server profile", whatever account served it over there —
 * and with the *server's* working directory, which is the only directory the
 * conversation has.
 */
async function fetchServerSessions(
  env: Readonly<Record<string, string | undefined>>,
  profileId: SessionListQuery['profileId'],
): Promise<SessionSummary[]> {
  const root = baseUrl(env);
  const response = await fetch(`${root}${API_PREFIX}/sessions`, {
    headers: authHeaders(env),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw adapterError(
      'provider_unavailable',
      `The Artemis server answered ${String(response.status)} listing sessions.`,
    );
  }
  const body = (await response.json()) as Partial<ServerSessionsBody>;
  if (!Array.isArray(body.sessions)) return [];
  const rows: SessionSummary[] = [];
  for (const row of body.sessions) {
    if (typeof row !== 'object' || row === null) continue;
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    rows.push({
      id: row.id as SessionId,
      providerId: ARTEMIS_PROVIDER_ID,
      profileId,
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : row.id,
      ...(typeof row.firstPrompt === 'string' ? { firstPrompt: row.firstPrompt } : {}),
      // Carried through so `isArchived` can answer for a served conversation
      // the same way it answers for a local one.
      ...(typeof row.tag === 'string' ? { tag: row.tag } : {}),
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    });
  }
  return rows;
}

export function createArtemisAdapter(
  options: { readonly reconnect?: ArtemisReconnectOptions } = {},
): ProviderAdapter {
  const reconnect: Required<ArtemisReconnectOptions> = {
    watchdogMs: options.reconnect?.watchdogMs ?? DEFAULT_WATCHDOG_MS,
    backoffMs: options.reconnect?.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
  return {
    id: ARTEMIS_PROVIDER_ID,
    label: 'Artemis Server',
    credentials: artemisCredentials(),
    capabilities: ARTEMIS_CAPABILITIES,
    // Labelled levels for the thinking picker. Which of them a given route
    // accepts is a live fact, mapped from the server's `thinkingLevels` onto
    // each `ProviderModelOption.effortLevels`; this is only the vocabulary the
    // picker draws them with. See `ARTEMIS_EFFORT_LEVELS`.
    effortLevels: ARTEMIS_EFFORT_LEVELS,

    /*
     * Probes `/api/v0/connection` rather than the model list: it is the
     * cheapest authenticated read, and its answer *is* the two things a
     * profile can have wrong — the address, and the token. Honours the
     * profile's address for the reason the local adapter documents.
     */
    async checkAvailability(query) {
      const root = baseUrl(query?.env ?? {});
      try {
        const response = await fetch(`${root}${API_PREFIX}/connection`, {
          headers: authHeaders(query?.env ?? {}),
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return { available: true as const };
        // 401/403 is the server working correctly and refusing *us* — a
        // different problem from a server that is not there, and the one a
        // profile with no token pasted hits first.
        const reason =
          response.status === 401 || response.status === 403
            ? `The Artemis server at ${root} refused the request (${response.status}). Paste one of its connection tokens into this profile's API key field.`
            : `The Artemis server at ${root} answered ${response.status}.`;
        return { available: false as const, unavailableReason: reason };
      } catch {
        return {
          available: false as const,
          unavailableReason: `Nothing is answering at ${root}. Is the Artemis server running, and is its address reachable from this machine?`,
        };
      }
    },

    /**
     * Ask the server what routes this connection may run. Never rejects: an
     * unreachable server is an ordinary state, and the picker saying "nothing
     * confirmed" is the honest answer.
     */
    async listModels(query) {
      const root = baseUrl(query.env ?? {});
      try {
        const response = await fetch(`${root}${API_PREFIX}/models`, {
          headers: authHeaders(query.env ?? {}),
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const models = parseServerModels(await response.json());
          if (models.length > 0) return { models, live: true };
        }
      } catch {
        /* fall through to the not-confirmed answer */
      }
      return { models: [], live: false };
    },

    /**
     * The sessions this connection's scope created, as the server tells it.
     *
     * `cwd` is deliberately not sent: the server scopes the answer by the
     * *token*, whose workspace was fixed when it was minted, and a local
     * directory means nothing on another machine. What comes back carries the
     * serving machine's own paths, and those are what the rows show — a
     * conversation's home is where it ran.
     *
     * Rejects on an unreachable or refusing server, exactly as the contract
     * asks: an error names the problem where an empty page would silently
     * claim there is no history.
     */
    async listSessions(query: SessionListQuery): Promise<SessionListPage> {
      const sessions = await fetchServerSessions(query.env, query.profileId);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? sessions.length;
      return {
        sessions: sessions.slice(offset, offset + limit),
        hasMore: offset + limit < sessions.length,
      };
    },

    /**
     * The same list, for the every-project sidebar. One server, one scope —
     * so "every project" is the connection's whole visible history, and each
     * profile in the query is one server to ask. A server that cannot be
     * reached contributes nothing and is named, per the aggregation contract.
     */
    async listAllSessions(query: AllSessionsQuery): Promise<AggregatedSessionList> {
      const collected: SessionSummary[] = [];
      const unreadable: string[] = [];
      for (const scope of query.profiles) {
        try {
          collected.push(...(await fetchServerSessions(scope.env, scope.profileId)));
        } catch {
          unreadable.push(String(scope.profileId));
        }
      }
      collected.sort((a, b) => b.updatedAt - a.updatedAt);
      return { sessions: collected, unreadableProfiles: unreadable };
    },

    /**
     * One stored conversation, replayed as events.
     *
     * The server already speaks `AgentEvent` — its replay is the engine's own
     * — so the only translation is the run id: events are re-stamped with the
     * caller's, which is what lands them in the transcript that asked.
     */
    async getSessionMessages(query: SessionMessagesQuery): Promise<SessionTranscript> {
      const root = baseUrl(query.env);
      const response = await fetch(
        `${root}${API_PREFIX}/sessions/${encodeURIComponent(String(query.sessionId))}/messages`,
        { headers: authHeaders(query.env), signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) {
        throw adapterError(
          response.status === 404 ? 'invalid_request' : 'provider_unavailable',
          response.status === 404
            ? 'The server has no such conversation for this connection.'
            : `The Artemis server answered ${String(response.status)} reading the conversation.`,
        );
      }
      const body = (await response.json()) as Partial<ServerSessionMessagesBody>;
      const events = Array.isArray(body.events) ? body.events : [];
      return {
        events: events.map((event) => ({ ...event, runId: query.runId })),
        hasMore: body.hasMore === true,
      };
    },

    /**
     * The three session writes, each one route on the server.
     *
     * `cwd` is deliberately not sent: the conversation lives on the server's
     * machine and the server locates it through its own ledger entry, exactly
     * as the messages read does. A directory from *this* machine names
     * nothing over there.
     *
     * A 404 is the ledger's scope rule speaking — "not yours" and "not
     * there" are indistinguishable on purpose — but it is also what an older
     * server answers for a route it has never heard of, so the message names
     * both readings.
     */
    async setSessionTitle(update: SessionTitleUpdate): Promise<void> {
      const root = baseUrl(update.env);
      const response = await fetch(
        `${root}${API_PREFIX}/sessions/${encodeURIComponent(String(update.sessionId))}/rename`,
        {
          method: 'POST',
          headers: { ...authHeaders(update.env), 'content-type': 'application/json' },
          body: JSON.stringify({ title: update.title }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw await sessionMutationError(response, 'rename this conversation');
    },

    async deleteSession(query: SessionDeleteQuery): Promise<boolean> {
      const root = baseUrl(query.env);
      const response = await fetch(
        `${root}${API_PREFIX}/sessions/${encodeURIComponent(String(query.sessionId))}`,
        {
          method: 'DELETE',
          headers: authHeaders(query.env),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw await sessionMutationError(response, 'delete this conversation');
      const body = (await response.json()) as Partial<ServerSessionDeletedBody>;
      return body.deleted === true;
    },

    async tagSession(query: SessionTagQuery): Promise<boolean> {
      const root = baseUrl(query.env);
      const response = await fetch(
        `${root}${API_PREFIX}/sessions/${encodeURIComponent(String(query.sessionId))}/tag`,
        {
          method: 'POST',
          headers: { ...authHeaders(query.env), 'content-type': 'application/json' },
          body: JSON.stringify({ tag: query.tag }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw await sessionMutationError(response, 'tag this conversation');
      const body = (await response.json()) as Partial<ServerSessionTaggedBody>;
      return body.tagged === true;
    },

    createRun(input: ResolvedRunInput): Promise<Run> {
      // Strict about what the wire cannot carry — the same rule every adapter
      // follows, and doubly important where the run happens on another
      // machine: silently dropping a setting here means it is silently
      // different over there.
      if (input.forkSession === true || input.rewindToMessageId !== undefined) {
        return Promise.reject(
          adapterError('invalid_request', 'The Artemis server cannot fork or rewind a session yet.'),
        );
      }
      if (input.model === undefined || input.model.trim() === '') {
        return Promise.reject(
          adapterError(
            'invalid_request',
            'An Artemis-server run names a route from its catalogue (profile/model). Pick a model first.',
          ),
        );
      }
      return Promise.resolve(new ArtemisRun(input, reconnect));
    },
  } as ProviderAdapter;
}
