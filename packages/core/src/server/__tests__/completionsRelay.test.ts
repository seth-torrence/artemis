/**
 * What a served turn relays about work the OpenAI reply has no field for.
 *
 * A served conversation is routinely still working after its turn has ended —
 * a subagent, a workflow — and the completion stream used to say nothing
 * about it: `background.tasks` had no place in an OpenAI reply and was
 * dropped, so a client saw the conversation finish while the work ran on. It
 * rides the `artemis` namespace now, as the whole live set, and so does the
 * provider reading a message that was steered into the run.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, BackgroundTask, RunHandle, ServerModel } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { runTurn, type RunSource } from '../completions.js';

const MODEL: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'prof-a' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [],
  adaptiveThinking: false,
  fastMode: false,
  ultracode: false,
};

function fakeRuns(script: readonly Partial<AgentEvent>[]): RunSource {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    startRun: async (input) => {
      queueMicrotask(() => {
        script.forEach((partial, index) => {
          const event = { runId: 'run-1', seq: index, ...partial } as AgentEvent;
          for (const listener of listeners) listener(event);
        });
      });
      return {
        runId: 'run-1',
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'working',
        capabilities: NO_CAPABILITIES,
      } as unknown as RunHandle;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (runId) => ({ runId, deliveredImmediately: true }),
    eventsSince: async () => ({ events: [], truncated: false }),
    listRuns: async () => [],
    interrupt: async () => {},
    respondToPermission: async () => {},
    disposeRun: async () => {},
  } as unknown as RunSource;
}

const TASK: BackgroundTask = {
  id: 't1',
  kind: 'local_subagent',
  description: 'Audit the scripts',
  status: 'running',
  startedAt: 1_000,
};

async function drain(source: RunSource) {
  const events = [];
  for await (const event of runTurn(source, {
    model: MODEL,
    cwd: '/w',
    request: { model: 'work-max/opus', messages: [{ role: 'user', content: 'hi' }] },
    extensions: {},
    ignored: [],
  } as Parameters<typeof runTurn>[1])) {
    events.push(event);
  }
  return events;
}

describe('a served turn relays', () => {
  it('the delegated rows, whole, each time they change', async () => {
    const source = fakeRuns([
      { type: 'background.tasks', tasks: [TASK] },
      { type: 'text.delta', text: 'launched' },
      { type: 'background.tasks', tasks: [{ ...TASK, status: 'completed', endedAt: 2_000 }] },
      { type: 'run.end', reason: 'completed' },
    ]);

    const events = await drain(source);
    const tasks = events.filter((e) => e.kind === 'tasks') as { tasks: readonly BackgroundTask[]; seq?: number }[];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.tasks).toEqual([TASK]);
    expect(tasks[1]?.tasks[0]).toMatchObject({ id: 't1', status: 'completed' });
    // Cursors, so a client that reattaches asks for what it missed.
    expect(tasks[0]?.seq).toBe(0);
    expect(tasks[1]?.seq).toBe(2);
    // The answer itself is untouched by them.
    const done = events.at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('launched');
  });

  it('the reading of a steered message, by the id the server filed it under', async () => {
    const source = fakeRuns([
      { type: 'message.delivered', messageId: 'run-1:prompt:2' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const events = await drain(source);
    expect(events.filter((e) => e.kind === 'delivered')).toEqual([
      { kind: 'delivered', messageId: 'run-1:prompt:2', seq: 0 },
    ]);
  });
});
