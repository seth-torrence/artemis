/**
 * Runs that outlive the request that started them.
 * ============================================================================
 *
 * `completions.ts` runs a turn for as long as somebody is pulling from it. This
 * module is what a run belongs to when nobody is — the bookkeeping that makes
 * three otherwise-impossible things safe:
 *
 *  1. **Ownership.** A run started through this port belongs to the connection
 *     that started it, for as long as it is worth addressing. Every route under
 *     `/api/v0/runs` asks here first.
 *  2. **A deadline on detachment.** A run whose client asked to keep it stays
 *     alive after the socket closes. Something has to be willing to end it
 *     anyway, or a laptop that never comes back pins a provider process for the
 *     life of the process serving it.
 *  3. **A deadline on a parked prompt.** A permission request that a remote
 *     client is expected to answer blocks the provider until it is answered.
 *     Nobody answering is a normal outcome — a phone in a pocket — and it has
 *     to resolve to the same standing denial an unattended turn gets, rather
 *     than to a wedge.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUBSCRIBES TO THE EVENT STREAM
 * ---------------------------------------------------------------------------
 *
 * The obvious wiring is for the turn to report its own parked prompts and clear
 * them when they settle. It cannot: the case both deadlines exist for is the
 * one where the turn's generator is *gone*. A prompt raised while a client was
 * attached routinely outlives the attachment, and the resolution that clears it
 * arrives — from another client's answer, from the provider withdrawing it —
 * long after the stream that carried the question died.
 *
 * So this holds its own subscription, filtered to the runs it has claimed. One
 * listener for the process, and it is the only thing in the server that is
 * still watching when everything else has hung up.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEADLINES ARE DELIBERATELY AN ORDER OF MAGNITUDE APART
 * ---------------------------------------------------------------------------
 *
 * A detached run is *working*. Six hours is chosen to be longer than any
 * plausible round trip a person makes to a run they meant to come back to — a
 * night's sleep, a flight, a working day away from the desk — because ending
 * one early destroys work the user is returning for, and the cost of holding it
 * is one provider process. The clock is "how long since anyone came back for
 * it", not "how long since the socket closed": every ownership-checked touch of
 * a run restarts it, so a client that is polling its run is never reaped out
 * from under itself, and one that has genuinely gone stops paying in.
 * `ARTEMIS_DETACHED_RUN_TTL_MS` moves it.
 *
 * A parked run is *blocked*, and everything downstream of the question is
 * waiting on a person who may never look. Fifteen minutes is chosen to be
 * longer than someone takes to read a notification and shorter than they take
 * to notice a run has silently stopped making progress; past it the model is
 * told nobody is there and gets to route around the door, which is a far better
 * outcome than a turn that produced nothing for an afternoon.
 * `ARTEMIS_PERMISSION_PARK_MS` moves it.
 *
 * **The park deadline only runs while a client is attached**, and that is the
 * subtlest rule in the file. It exists to stop a run stalling silently in front
 * of somebody who is not going to answer. A *detached* run has nobody in front
 * of it by definition, and the open question is very often the exact thing its
 * client left and is coming back for — a laptop that slept on an approval and
 * wakes to grant it. Denying on their behalf while they were away would be the
 * server making the one decision it was told not to make. So a detached run's
 * prompt waits, and the run's own deadline is what bounds it: nobody comes
 * back, the whole run goes.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT `guard.ts`, AND THE TWO NEVER SEE THE SAME RUN
 * ---------------------------------------------------------------------------
 *
 * The server has two lifetime policies for two kinds of client, and keeping
 * them apart is a correctness property rather than a tidiness one.
 *
 *  - **This directory governs completions-started runs.** A run minted by
 *    `POST /v1/chat/completions` is claimed here, and only here. Its client is
 *    a provider adapter: it holds a run id, addresses the run over
 *    `/api/v0/runs/{id}/…`, and its deadline is six hours of nobody coming
 *    back.
 *  - **`guard.ts` governs bridge-started runs.** A run minted by
 *    `POST /api/v0/runs` belongs to a *window*, which is watching the shared
 *    event stream, so departure is measured by that stream going quiet — a
 *    sixty-second grace, connection-wide, not per run.
 *
 * Neither registry is told about the other's runs, and that is enforced at the
 * only two places a run is created: `handleChatCompletions` claims into this
 * directory and never calls `guard.trackRun`, and the bridge's start route
 * calls `guard.trackRun` and never reaches this module. A run in both would be
 * governed by whichever deadline fired first — a bridge run reaped at six
 * hours it was still being watched through, or worse, a completions run
 * interrupted sixty seconds after a *different* client's event stream dropped.
 */

import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequestId,
  PermissionRuleUpdate,
  RunId,
} from '@rx-artemis/protocol';

import { UNATTENDED_PERMISSION_MESSAGE, type RunSource } from './completions.js';

/** Six hours. See the file comment on why it is this long. */
export const DEFAULT_DETACHED_RUN_TTL_MS = 6 * 60 * 60 * 1000;

/** Fifteen minutes. See the file comment on why it is this short. */
export const DEFAULT_PERMISSION_PARK_MS = 15 * 60 * 1000;

/**
 * How often the deadlines are checked.
 *
 * A sweep rather than a timer per run, because the timers would be per
 * *request* — a busy server would hold thousands of them to enforce two
 * durations measured in hours and minutes. Half a minute of slack on a
 * fifteen-minute deadline is not a slack anyone can perceive.
 */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * How many runs are remembered at once.
 *
 * A bound rather than a policy: ended records are dropped by the sweep long
 * before this matters, and this only exists so that a server which somehow
 * stops sweeping cannot grow without limit. Live records are never evicted —
 * forgetting a live run would orphan it past every deadline this module owns.
 */
const MAX_TRACKED_RUNS = 1_000;

/** What the server remembers about one run it started. */
interface RunRecord {
  /** The only connection that may address this run. */
  readonly connectionId: string;
  /**
   * The route the run was started on, as `POST /v1/chat/completions` named it.
   *
   * Kept so a resumed stream can stamp its chunks with the same `model` the
   * original stream did — the engine knows the run's provider and model id,
   * but the route is the completions surface's own vocabulary and lives
   * nowhere else. Absent for a claim that did not say.
   */
  readonly route: string | undefined;
  /**
   * The caller asked to be shown permission prompts.
   *
   * The one thing the claim has to say, because it changes what the *feed*
   * means: a prompt on this run is a question somebody may answer, and one on
   * any other run was answered by the turn before this ever saw it. Whether the
   * caller asked to detach is deliberately not recorded — the turn decides
   * that, and this learns it from {@link RunDirectory.noteDetached}, so there is
   * exactly one owner of the decision.
   */
  readonly permissions: boolean;
  /** Epoch ms the client walked away, or absent while one is attached. */
  detachedAt: number | undefined;
  /** Set once the run has ended, by its own accord or by this module's hand. */
  ended: boolean;
  endedAt: number | undefined;
  /** Open permission requests, by the moment each was raised. */
  readonly parked: Map<PermissionRequestId, number>;
}

export interface RunDirectoryOptions {
  /** The engine: the event feed, and the three calls the deadlines make. */
  readonly runs: RunSource;
  /** Override `ARTEMIS_DETACHED_RUN_TTL_MS`. Tests pass this; nothing else needs to. */
  readonly detachedRunTtlMs?: number;
  /** Override `ARTEMIS_PERMISSION_PARK_MS`. */
  readonly permissionParkMs?: number;
  /** Clock, injectable so a test can be six hours old without waiting. */
  readonly now?: () => number;
  /**
   * Run the sweep on a timer. Off for a test, which calls {@link RunDirectory.sweep}
   * itself and would otherwise be racing an interval it did not ask for.
   */
  readonly sweepIntervalMs?: number;
  /** Where a failed reap goes. Without one, a provider that will not die is silent. */
  readonly onError?: (error: unknown) => void;
}

/**
 * The server's record of the runs it started.
 *
 * One per server. {@link close} releases the subscription and the timer; a
 * directory that is not closed keeps a listener on the engine for the life of
 * the process.
 */
export interface RunDirectory {
  /**
   * Record a run as this connection's, the moment it has an id.
   *
   * Called for *every* run the completions route starts, not only the ones that
   * opted into something: ownership is what the run routes authorise against,
   * and a plain turn's caller is still entitled to interrupt the run it just
   * started. Idempotent — a second claim for the same id keeps the first, so a
   * run cannot be re-pointed at another connection by a race.
   */
  claim(input: {
    readonly runId: RunId;
    readonly connectionId: string;
    readonly permissions: boolean;
    /** See {@link RunRecord.route}. */
    readonly route?: string;
  }): void;

  /** May this connection address this run at all? The only authorisation there is. */
  owns(connectionId: string, runId: RunId): boolean;

  /**
   * Every run id this connection has started and this directory still
   * remembers, newest first.
   *
   * Ids rather than descriptions, because a description would be this module's
   * guess at a run's state and the engine holds the real one. What a listing
   * route wants is the intersection: these ids, described by the engine.
   */
  ownedBy(connectionId: string): readonly RunId[];

  /** The client walked away and the run was kept. Starts the run's own deadline. */
  noteDetached(runId: RunId): void;

  /**
   * A client attached to the run's stream again.
   *
   * The inverse of {@link noteDetached}, and the thing that makes a resumed
   * stream a real attachment rather than a touch: the detached-run deadline
   * stops, because the run is no longer abandoned, and the park deadline on
   * its open prompts starts, because somebody is now in front of them again —
   * the same somebody who would have been asked had the socket held. No-op for
   * a run that has ended.
   */
  noteAttached(runId: RunId): void;

  /** The route a claimed run was started on, when the claim said. */
  routeOf(runId: RunId): string | undefined;

  /**
   * Somebody just addressed this run through an authorised route.
   *
   * Which is the evidence the run's deadline is actually about: it is not
   * "detached six hours ago", it is "abandoned for six hours". A client polling
   * its detached run for events has plainly not abandoned it, and reaping one
   * out from under a reader would be the feature failing in the exact scenario
   * it was built for. No-op for a run nobody has detached.
   */
  noteSeen(runId: RunId): void;

  /**
   * A permission request was answered through a route.
   *
   * Belt and braces on top of the `permission.resolved` event, which is what
   * normally clears the park: an adapter that settles a request without
   * announcing it would otherwise leave a deadline running against a decision
   * that has already been made, and the sweep would try to deny it a quarter of
   * an hour later.
   */
  noteAnswered(runId: RunId, requestId: PermissionRequestId): void;

  /** Enforce both deadlines once. Called by the timer, and directly by tests. */
  sweep(): Promise<void>;

  /** Stop watching. Does not touch the runs themselves. */
  close(): void;
}

/**
 * Read a duration from the environment.
 *
 * At call time rather than at module load, so that a container's environment is
 * read by the process that was actually given it, and so a test can set one.
 * Anything that is not a positive finite number falls back — a typo in a
 * deployment's environment must not silently mean "never reap".
 */
function envDuration(name: string, fallback: number): number {
  const declared = process.env[name];
  if (declared === undefined || declared.trim().length === 0) return fallback;
  const parsed = Number(declared);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRunDirectory(options: RunDirectoryOptions): RunDirectory {
  const now = options.now ?? (() => Date.now());
  const ttlMs =
    options.detachedRunTtlMs ??
    envDuration('ARTEMIS_DETACHED_RUN_TTL_MS', DEFAULT_DETACHED_RUN_TTL_MS);
  const parkMs =
    options.permissionParkMs ??
    envDuration('ARTEMIS_PERMISSION_PARK_MS', DEFAULT_PERMISSION_PARK_MS);

  const records = new Map<RunId, RunRecord>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const listener = (event: AgentEvent): void => {
    const record = records.get(event.runId);
    if (record === undefined) return;
    switch (event.type) {
      case 'permission.request':
        // Only tracked for a run that asked to be shown prompts. On any other
        // run the turn itself denies the request the moment it arrives, so a
        // deadline here would be a second answer to a settled question.
        if (record.permissions) record.parked.set(event.requestId, now());
        break;
      case 'permission.resolved':
        record.parked.delete(event.requestId);
        break;
      case 'run.end':
        record.ended = true;
        record.endedAt = now();
        // Everything still open was withdrawn with the run. Nothing to deny.
        record.parked.clear();
        break;
      default:
        break;
    }
  };

  /**
   * Attach the feed on first use, not at construction.
   *
   * A directory is built when the *server* is, and the server is routinely
   * built before the engine behind it exists — the desktop binds its port from
   * a host whose engine is resolved lazily, and subscribing eagerly turned that
   * into a crash on `start()`. Deferring costs nothing that could be missed:
   * the listener only ever acts on runs this directory has claimed, and the
   * first claim is the first moment there is one.
   */
  const watch = (): void => {
    unsubscribe ??= options.runs.subscribe(listener);
  };

  /** Drop the oldest records that are safely droppable. See {@link MAX_TRACKED_RUNS}. */
  const evict = (): void => {
    if (records.size <= MAX_TRACKED_RUNS) return;
    for (const [runId, record] of records) {
      if (records.size <= MAX_TRACKED_RUNS) break;
      if (record.ended) records.delete(runId);
    }
  };

  const directory: RunDirectory = {
    claim: (input) => {
      watch();
      if (records.has(input.runId)) return;
      records.set(input.runId, {
        connectionId: input.connectionId,
        route: input.route,
        permissions: input.permissions,
        detachedAt: undefined,
        ended: false,
        endedAt: undefined,
        parked: new Map(),
      });
      evict();
    },

    owns: (connectionId, runId) => records.get(runId)?.connectionId === connectionId,

    ownedBy: (connectionId) => {
      const owned: RunId[] = [];
      for (const [runId, record] of records) {
        if (record.connectionId === connectionId) owned.push(runId);
      }
      return owned.reverse();
    },

    noteDetached: (runId) => {
      const record = records.get(runId);
      // Taken at face value rather than checked against what the caller asked
      // for. Reaching here at all means the turn has already decided not to
      // interrupt, so refusing the handover would not undo that decision — it
      // would leave the run with no client, no owner and no deadline, which is
      // the one outcome worse than adopting a run that did not ask.
      if (record !== undefined && !record.ended) record.detachedAt = now();
    },

    noteSeen: (runId) => {
      const record = records.get(runId);
      if (record !== undefined && record.detachedAt !== undefined) record.detachedAt = now();
    },

    noteAttached: (runId) => {
      const record = records.get(runId);
      if (record === undefined || record.ended) return;
      record.detachedAt = undefined;
      /*
       * The prompts that waited for this client are counted from now, not from
       * when they were raised: a question asked an hour ago into an empty room
       * has not been ignored for an hour by the person who just walked in.
       */
      const at = now();
      for (const requestId of [...record.parked.keys()]) record.parked.set(requestId, at);
    },

    routeOf: (runId) => records.get(runId)?.route,

    noteAnswered: (runId, requestId) => {
      records.get(runId)?.parked.delete(requestId);
    },

    sweep: async () => {
      const at = now();
      for (const [runId, record] of [...records]) {
        if (record.ended) {
          // Kept for a while after the end so a client that was away can still
          // collect the last events; dropped once nothing could plausibly be
          // coming back for it.
          if (record.endedAt !== undefined && at - record.endedAt >= ttlMs) {
            records.delete(runId);
          }
          continue;
        }

        // Suspended for a detached run: the question is what its client went
        // away holding, and the run's own deadline is what bounds it. See the
        // file comment.
        for (const [requestId, raisedAt] of record.detachedAt === undefined
          ? [...record.parked]
          : []) {
          if (at - raisedAt < parkMs) continue;
          record.parked.delete(requestId);
          try {
            await options.runs.respondToPermission(runId, requestId, {
              behavior: 'deny',
              message: UNATTENDED_PERMISSION_MESSAGE,
            });
          } catch (error) {
            // Routinely "no such open request": the provider withdrew it, or a
            // client answered between the sweep reading the map and this call.
            // Reported rather than thrown — one lapsed prompt must not stop the
            // sweep reaching the runs behind it.
            options.onError?.(error);
          }
        }

        if (record.detachedAt === undefined || at - record.detachedAt < ttlMs) continue;
        // Marked before the awaits, so a slow teardown cannot be started twice
        // by the next sweep.
        record.ended = true;
        record.endedAt = at;
        record.parked.clear();
        try {
          await options.runs.interrupt(runId);
          await options.runs.disposeRun(runId);
        } catch (error) {
          options.onError?.(error);
        }
      }
    },

    close: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clearInterval(timer);
    },
  };

  const interval = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  if (interval > 0) {
    timer = setInterval(() => {
      void directory.sweep().catch((error: unknown) => options.onError?.(error));
    }, interval);
    // Unrefed: the deadlines are a safety net over work the process is doing
    // anyway, never a reason for the process to stay up. A server whose last
    // socket has closed should exit, not linger for six hours to reap a run
    // that will die with it.
    timer.unref();
  }

  return directory;
}

/* -------------------------------------------------------------------------- */
/* Reading a decision off the wire                                            */
/* -------------------------------------------------------------------------- */

/** A decision that may be delivered, or the reason it may not. */
export type DecisionReview =
  | { readonly decision: PermissionDecision }
  | { readonly code: string; readonly error: string };

/**
 * The rule this parser exists for: **a remote decision shapes one run and
 * nothing beyond it.**
 *
 * A `PermissionDecision` is richer than "yes" or "no". It can carry rule
 * updates, and those can be written to the serving user's own settings files
 * and can change the run's permission *mode*. Every one of those is legitimate
 * coming from the desktop app, where the person answering is the person whose
 * settings they are. None of them is legitimate coming from a bearer token,
 * whose entire authority is one directory — see `ServerConnection` in protocol.
 *
 * So three things are refused, and the refusal is unconditional rather than a
 * default anything can relax:
 *
 *  - **`setMode`, always.** `bypassPermissions` is approve-everything, for the
 *    rest of the run and possibly for the user's whole machine; it is the one
 *    decision that would turn a leaked token from "an agent in one folder"
 *    into "an agent with no brakes in one folder". The other modes are refused
 *    with it rather than enumerated against it, because a mode switch is a
 *    change to *how the run asks*, and a client answering a question has been
 *    given no authority over that.
 *  - **Directory grants.** `addDirectories` is the connection's working
 *    directory being widened by the thing the working directory constrains.
 *  - **Durable scopes.** `local`, `project` and `user` write to files that
 *    outlive the run and belong to the person running the server. A remote
 *    "always allow" is honoured for the session and no further, which is the
 *    strongest form of it that is still only about this conversation.
 *
 * Everything else is read structurally and passed through: a wrong-typed field
 * is a caller bug worth a 400, not something to coerce into a decision the
 * caller did not make.
 */
export function reviewPermissionDecision(value: unknown): DecisionReview {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { code: 'invalid_decision', error: '`decision` must be an object.' };
  }
  const record = value as Record<string, unknown>;
  const behavior = record['behavior'];
  if (behavior !== 'allow' && behavior !== 'deny') {
    return { code: 'invalid_decision', error: '`decision.behavior` must be "allow" or "deny".' };
  }

  const updates = reviewRuleUpdates(record['updatedPermissions']);
  if ('error' in updates) return updates;

  const scope = record['scope'];
  if (scope !== undefined && scope !== 'once' && scope !== 'session') {
    return {
      code: 'permission_escalation',
      error:
        'A decision sent over HTTP may use `scope` "once" or "session". Durable scopes write to the serving machine\'s own settings and are not reachable with a connection token.',
    };
  }

  if (behavior === 'deny') {
    const message = record['message'];
    if (message !== undefined && typeof message !== 'string') {
      return { code: 'invalid_decision', error: '`decision.message` must be a string.' };
    }
    const interrupt = record['interrupt'];
    if (interrupt !== undefined && typeof interrupt !== 'boolean') {
      return { code: 'invalid_decision', error: '`decision.interrupt` must be a boolean.' };
    }
    return {
      decision: {
        behavior: 'deny',
        ...(typeof message === 'string' ? { message } : {}),
        ...(typeof interrupt === 'boolean' ? { interrupt } : {}),
        ...(updates.updatedPermissions === undefined
          ? {}
          : { updatedPermissions: updates.updatedPermissions }),
      },
    };
  }

  const updatedInput = record['updatedInput'];
  if (
    updatedInput !== undefined &&
    (typeof updatedInput !== 'object' || updatedInput === null || Array.isArray(updatedInput))
  ) {
    return { code: 'invalid_decision', error: '`decision.updatedInput` must be an object.' };
  }

  const answers = record['answers'];
  if (answers !== undefined && !Array.isArray(answers)) {
    return { code: 'invalid_decision', error: '`decision.answers` must be an array.' };
  }

  return {
    decision: {
      behavior: 'allow',
      ...(updatedInput === undefined ? {} : { updatedInput: updatedInput as never }),
      ...(answers === undefined ? {} : { answers: answers as never }),
      ...(updates.updatedPermissions === undefined
        ? {}
        : { updatedPermissions: updates.updatedPermissions }),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

/** A refusal, in the shape {@link DecisionReview} carries one. */
type Refusal = { readonly code: string; readonly error: string };

/** The rule updates a decision may carry, or the reason it may not carry them. */
function reviewRuleUpdates(
  value: unknown,
): { readonly updatedPermissions?: readonly PermissionRuleUpdate[] } | Refusal {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    return { code: 'invalid_decision', error: '`decision.updatedPermissions` must be an array.' };
  }

  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return {
        code: 'invalid_decision',
        error: 'Each `decision.updatedPermissions` entry must be an object.',
      };
    }
    const update = entry as Record<string, unknown>;
    const type = update['type'];
    if (type === 'setMode') {
      return {
        code: 'permission_escalation',
        error:
          'A decision sent over HTTP may not change the run\'s permission mode. Approve or refuse the call in front of you; `bypassPermissions` in particular is not reachable with a connection token.',
      };
    }
    if (type === 'addDirectories' || type === 'removeDirectories') {
      return {
        code: 'permission_escalation',
        error:
          'A decision sent over HTTP may not change which directories the run may touch. Where a connection\'s turns run is chosen when its token is created.',
      };
    }
    if (type !== 'addRules' && type !== 'replaceRules' && type !== 'removeRules') {
      return {
        code: 'invalid_decision',
        error: 'Each `decision.updatedPermissions` entry needs a known `type`.',
      };
    }
    const scope = update['scope'];
    if (scope !== 'once' && scope !== 'session') {
      return {
        code: 'permission_escalation',
        error:
          'A rule update sent over HTTP may use `scope` "once" or "session". Durable scopes write to the serving machine\'s own settings and are not reachable with a connection token.',
      };
    }
    if (!Array.isArray(update['rules'])) {
      return { code: 'invalid_decision', error: 'A rule update needs a `rules` array.' };
    }
  }

  return { updatedPermissions: value as readonly PermissionRuleUpdate[] };
}
