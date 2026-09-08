/**
 * The served adapter's half of "is this conversation still working?"
 *
 * The engine asks every adapter three synchronous questions on a poll and
 * draws the sidebar's marker and the delegated rows from the answers. This
 * adapter used to answer nothing — the work is on the server — so a served
 * conversation read as finished the moment its turn ended while a subagent
 * ran on. Now it answers from two sources: the rows its own streams relayed,
 * and each known server's `/api/v0/runs/live-work`, polled behind the
 * questions. These pin both, and the chunk reader that feeds the first.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTask } from '@rx-artemis/protocol';

import { createArtemisAdapter } from '../artemis/adapter.js';
import { ServedWork } from '../artemis/liveWork.js';
import { readServerChunk } from '../artemis/stream.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

const TASK: BackgroundTask = {
  id: 't1',
  kind: 'local_subagent',
  description: 'Audit the scripts',
  status: 'running',
  startedAt: 1_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readServerChunk', () => {
  it('reads the delegated rows and a delivery off the namespace', () => {
    const delta = readServerChunk({
      choices: [{ delta: {} }],
      artemis: { tasks: [TASK, { nope: true }, 'text'], delivered: 'srv:prompt:2', seq: 7 },
    });
    expect(delta?.artemis?.tasks).toEqual([TASK]);
    expect(delta?.artemis?.delivered).toBe('srv:prompt:2');
    expect(delta?.artemis?.seq).toBe(7);
  });
});

describe('ServedWork', () => {
  it('answers from the rows a stream relayed, until the work settles', () => {
    const work = new ServedWork({ fetch: vi.fn() as unknown as typeof fetch });
    work.noteTasks('sess-1', [TASK]);
    expect(work.holding()).toEqual(['sess-1']);
    expect(work.working()).toEqual(['sess-1']);
    expect(work.delegated()).toEqual([{ sessionId: 'sess-1', tasks: [TASK] }]);

    work.noteTasks('sess-1', [{ ...TASK, status: 'completed', endedAt: 2_000 }]);
    expect(work.holding()).toEqual([]);
    // Settled rows are still worth reading — the delegated list shows them.
    expect(work.delegated()[0]?.tasks[0]).toMatchObject({ status: 'completed' });
  });

  it('polls a known server behind the question, and unions its answer in', async () => {
    let now = 10_000;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse({
        object: 'artemis.live-work',
        sessionIds: ['sess-server'],
        working: ['sess-server'],
        delegated: [{ sessionId: 'sess-server', tasks: [TASK] }],
      });
    });
    const work = new ServedWork({ fetch: fetchMock as unknown as typeof fetch, now: () => now });
    work.watch({ root: 'http://server.tail:6472', headers: { authorization: 'Bearer tok-123' } });

    // The first question starts the poll and answers from what is known now.
    expect(work.holding()).toEqual([]);
    expect(calls).toEqual(['http://server.tail:6472/api/v0/runs/live-work']);
    await vi.waitFor(() => expect(work.holding()).toEqual(['sess-server']));
    expect(work.working()).toEqual(['sess-server']);
    expect(work.delegated()).toEqual([{ sessionId: 'sess-server', tasks: [TASK] }]);

    // Asked again inside the window: no second poll.
    now += 1_000;
    work.holding();
    expect(calls).toHaveLength(1);
    // Past it: one more.
    now += 5_000;
    work.holding();
    expect(calls).toHaveLength(2);
  });

  it('keeps the last answer when a poll fails', async () => {
    let fail = false;
    const fetchMock = vi.fn(async () =>
      fail
        ? jsonResponse({ error: {} }, 503)
        : jsonResponse({ object: 'artemis.live-work', sessionIds: ['s1'], working: [], delegated: [] }),
    );
    let now = 0;
    const work = new ServedWork({ fetch: fetchMock as unknown as typeof fetch, now: () => now });
    work.watch({ root: 'http://a', headers: {} });
    work.holding();
    await vi.waitFor(() => expect(work.holding()).toEqual(['s1']));

    fail = true;
    now += 10_000;
    work.holding();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Still the server's last word: a dropped poll must not read as "finished".
    expect(work.holding()).toEqual(['s1']);
  });
});

describe('the adapter', () => {
  it('answers the engine from the ledger, and learns a server from a listing', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        if (String(url).endsWith('/api/v0/sessions')) {
          return jsonResponse({ object: 'artemis.sessions', sessions: [] });
        }
        return jsonResponse({
          object: 'artemis.live-work',
          sessionIds: ['sess-9'],
          working: ['sess-9'],
          delegated: [],
        });
      }),
    );

    const adapter = createArtemisAdapter();
    await adapter.listSessions!({ profileId: 'p' as never, cwd: '/x', env: ENV });

    expect(adapter.sessionsHoldingWork?.()).toEqual([]);
    await vi.waitFor(() => expect(adapter.sessionsHoldingWork?.()).toEqual(['sess-9']));
    expect(adapter.sessionsWorking?.()).toEqual(['sess-9']);
    expect(calls).toContain('http://server.tail:6472/api/v0/runs/live-work');
  });
});
