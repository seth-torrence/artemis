/**
 * What a served conversation is still doing, kept where the engine can ask.
 * ============================================================================
 *
 * The engine asks every adapter three things on a poll — which conversations
 * hold work, which are working now, and what they have delegated — and draws
 * the sidebar's marker and the delegated rows from the answers. The Claude
 * adapter answers from the ledger on its process. This adapter has no process:
 * the work is on the server, and until this existed it answered nothing, so a
 * served conversation read as finished the moment its turn ended while a
 * subagent ran on for twenty minutes on the other machine — and a window that
 * slept or reloaded had no rows to come back to.
 *
 * Two sources, because each has a hole the other fills:
 *
 *  - **The stream.** A run relays `background.tasks` as it happens (see
 *    `artemis.tasks` on the wire). Current while the turn is open, and the only
 *    source that is current *between* polls. Remembered here per session so
 *    the rows outlive the turn.
 *  - **The server's own ledger**, `GET /api/v0/runs/live-work`, which answers
 *    for turns this window never saw: a reload, a laptop that slept, a run
 *    another client started. Polled, because the engine's questions are
 *    synchronous and answered from memory; the poll refreshes the memory.
 *
 * The three answers are unions over every server this adapter has been pointed
 * at. A server is known from the moment a profile uses it — a listing, a run —
 * and forgotten never, which is bounded by the number of profiles a person has.
 *
 * Failure leaves the last answer standing, in the direction the engine's own
 * `refreshLiveWork` chooses for the same reason: this set only ever widens what
 * counts as working, so a stale entry costs a marker shown a little longer,
 * while an emptied one on a dropped poll would put a live workflow's column
 * back in reach of being thrown away.
 */

import type { BackgroundTask, SessionDelegatedWork, SessionId } from '@rx-artemis/protocol';
import { REMOTE_LIVE_WORK_PATH, isTaskLive } from '@rx-artemis/protocol';

/** A server as this adapter reaches it. */
export interface ServedConnection {
  readonly root: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The three sets one server last answered with. */
interface ServerAnswer {
  readonly holding: ReadonlySet<string>;
  readonly working: ReadonlySet<string>;
  readonly delegated: ReadonlyMap<string, SessionDelegatedWork>;
}

const EMPTY: ServerAnswer = { holding: new Set(), working: new Set(), delegated: new Map() };

/** How old a server's answer may be before a question re-asks it. */
export const LIVE_WORK_REFRESH_MS = 4_000;
/** How long a poll waits before the last answer stands. */
const LIVE_WORK_TIMEOUT_MS = 5_000;

export interface ServedWorkOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly refreshMs?: number;
}

export class ServedWork {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #refreshMs: number;
  /** Keyed by root, so two profiles on one server share one poll. */
  readonly #servers = new Map<
    string,
    { headers: Readonly<Record<string, string>>; answer: ServerAnswer; askedAt: number; inFlight: Promise<void> | undefined }
  >();
  /** The rows a stream last relayed, per session. See the module note. */
  readonly #streamed = new Map<string, readonly BackgroundTask[]>();

  constructor(options: ServedWorkOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#refreshMs = options.refreshMs ?? LIVE_WORK_REFRESH_MS;
  }

  /** Know a server. Idempotent; the token is refreshed on every call. */
  watch(connection: ServedConnection): void {
    const known = this.#servers.get(connection.root);
    if (known !== undefined) {
      known.headers = connection.headers;
      return;
    }
    this.#servers.set(connection.root, {
      headers: connection.headers,
      answer: EMPTY,
      askedAt: Number.NEGATIVE_INFINITY,
      inFlight: undefined,
    });
  }

  /**
   * A run relayed its delegated rows. The whole set, replacing the last — the
   * event's own contract — and remembered until the server says otherwise.
   */
  noteTasks(sessionId: string | undefined, tasks: readonly BackgroundTask[]): void {
    if (sessionId === undefined) return;
    this.#streamed.set(sessionId, tasks);
  }

  /** Conversations still holding work, across every known server. */
  holding(): readonly SessionId[] {
    this.#refresh();
    const out = new Set<string>();
    for (const [sessionId, tasks] of this.#streamed) {
      if (tasks.some(isTaskLive)) out.add(sessionId);
    }
    for (const server of this.#servers.values()) {
      for (const id of server.answer.holding) out.add(id);
    }
    return [...out] as SessionId[];
  }

  /** Conversations with something running right now. */
  working(): readonly SessionId[] {
    this.#refresh();
    const out = new Set<string>();
    for (const [sessionId, tasks] of this.#streamed) {
      if (tasks.some(isTaskLive)) out.add(sessionId);
    }
    for (const server of this.#servers.values()) {
      for (const id of server.answer.working) out.add(id);
    }
    return [...out] as SessionId[];
  }

  /**
   * The delegated rows, per conversation. The server's ledger wins over the
   * stream's memory for a session it names — it is the fresher of the two
   * once the turn has ended — and the stream's stands for the rest.
   */
  delegated(): readonly SessionDelegatedWork[] {
    this.#refresh();
    const out = new Map<string, SessionDelegatedWork>();
    for (const [sessionId, tasks] of this.#streamed) {
      if (tasks.length > 0) out.set(sessionId, { sessionId: sessionId as SessionId, tasks });
    }
    for (const server of this.#servers.values()) {
      for (const [sessionId, entry] of server.answer.delegated) out.set(sessionId, entry);
    }
    return [...out.values()];
  }

  /** Re-ask every server whose answer is older than the refresh window. */
  #refresh(): void {
    const now = this.#now();
    for (const [root, server] of this.#servers) {
      if (server.inFlight !== undefined || now - server.askedAt < this.#refreshMs) continue;
      server.askedAt = now;
      server.inFlight = this.#ask(root, server.headers)
        .then((answer) => {
          if (answer !== undefined) server.answer = answer;
        })
        .finally(() => {
          server.inFlight = undefined;
        });
    }
  }

  async #ask(root: string, headers: Readonly<Record<string, string>>): Promise<ServerAnswer | undefined> {
    try {
      const response = await this.#fetch(`${root}${REMOTE_LIVE_WORK_PATH}`, {
        headers,
        signal: AbortSignal.timeout(LIVE_WORK_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Partial<{
        sessionIds: unknown;
        working: unknown;
        delegated: unknown;
      }>;
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
      const delegated = new Map<string, SessionDelegatedWork>();
      if (Array.isArray(body.delegated)) {
        for (const entry of body.delegated as unknown[]) {
          if (typeof entry !== 'object' || entry === null) continue;
          const { sessionId, tasks } = entry as { sessionId?: unknown; tasks?: unknown };
          if (typeof sessionId !== 'string' || !Array.isArray(tasks)) continue;
          delegated.set(sessionId, { sessionId: sessionId as SessionId, tasks: tasks as BackgroundTask[] });
        }
      }
      return {
        holding: new Set(strings(body.sessionIds)),
        working: new Set(strings(body.working)),
        delegated,
      };
    } catch {
      // The last answer stands; see the module note.
      return undefined;
    }
  }
}
