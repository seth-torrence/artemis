/**
 * Running a turn over HTTP.
 *
 * The run source is a fake, and it has to be: a real one spawns a provider CLI
 * against a real account and bills it. What the fake reproduces faithfully is
 * the *shape* of a run — a handle first, then an event stream, then exactly one
 * `run.end` — because every property worth testing here is about how this code
 * reacts to that sequence, including the awkward orderings.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, RunHandle, ServerModel } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { promptFromMessages, resumeTurn, runTurn, type RunSource } from '../completions.js';

const MODEL: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'prof-a' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [{ id: 'high', label: 'High', note: '.' }],
  adaptiveThinking: false,
  fastMode: true,
  ultracode: true,
};

/** A run source that replays a scripted event sequence. */
function fakeRuns(
  script: readonly Partial<AgentEvent>[],
  overrides: Partial<RunSource> = {},
): RunSource & {
  readonly started: { input: unknown }[];
  readonly denied: string[];
  readonly interrupted: string[];
  readonly disposed: string[];
} {
  const listeners = new Set<(event: AgentEvent) => void>();
  const started: { input: unknown }[] = [];
  const denied: string[] = [];
  const interrupted: string[] = [];
  const disposed: string[] = [];

  const source: RunSource = {
    startRun: async (input) => {
      started.push({ input });
      const handle = {
        runId: 'run-1',
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'working',
        capabilities: NO_CAPABILITIES,
      } as unknown as RunHandle;

      // Emitted after the handle resolves, on a later tick — which is what a
      // real adapter does, and what the queue in `runTurn` has to survive.
      queueMicrotask(() => {
        for (const partial of script) {
          const event = { runId: 'run-1', seq: 0, ...partial } as AgentEvent;
          for (const listener of listeners) listener(event);
        }
      });
      return handle;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (runId) => ({ runId, deliveredImmediately: true }),
    eventsSince: async () => ({ events: [], truncated: false }),
    listRuns: async () => [],
    interrupt: async (runId) => {
      interrupted.push(String(runId));
    },
    respondToPermission: async (_runId, requestId) => {
      denied.push(requestId);
    },
    disposeRun: async (runId) => {
      disposed.push(String(runId));
    },
    ...overrides,
  };

  return Object.assign(source, { started, denied, interrupted, disposed });
}

const turn = (overrides: Record<string, unknown> = {}) =>
  ({
    model: MODEL,
    cwd: '/w',
    request: { model: 'work-max/opus', messages: [{ role: 'user', content: 'hi' }] },
    extensions: {},
    ignored: [],
    ...overrides,
  }) as Parameters<typeof runTurn>[1];

async function drain(source: RunSource, input = turn()) {
  const events = [];
  for await (const event of runTurn(source, input)) events.push(event);
  return events;
}

describe('a turn', () => {
  it('streams text, then ends with a result', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'Hel' },
      { type: 'text.delta', text: 'lo' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const events = await drain(source);
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual(
      ['Hel', 'lo'],
    );
    const done = events.at(-1) as { kind: 'done'; result: { text: string } };
    expect(done.kind).toBe('done');
    expect(done.result.text).toBe('Hello');
  });

  it('does not double the reply when a provider sends deltas and a complete block', async () => {
    // The bug this prevents: providers that stream emit both, and appending
    // each would return every answer twice.
    const source = fakeRuns([
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.complete', role: 'assistant', text: 'Hello' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Hello');
  });

  it('uses a complete block when nothing streamed', async () => {
    // A provider with `partialMessages: false` sends only this.
    const source = fakeRuns([
      { type: 'text.complete', role: 'assistant', text: 'Whole answer' },
      { type: 'run.end', reason: 'completed' },
    ]);

    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Whole answer');
  });

  it('falls back to the provider’s own summary when it sent no text at all', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed', result: 'Summary.' }]);
    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('Summary.');
  });

  it('never puts thinking into the answer, and carries it on its own channel', async () => {
    // A caller reading `content` must not receive the model's private
    // reasoning as though it were the reply — and a caller that wants to
    // watch the model think has to be able to, or a served turn shows an
    // answer with nothing behind it.
    const source = fakeRuns([
      { type: 'thinking.delta', text: 'Let me ' },
      { type: 'thinking.delta', text: 'consider…' },
      { type: 'text.delta', text: 'Done.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source);
    expect(events.filter((e) => e.kind === 'thinking').map((e) => (e as { text: string }).text)).toEqual(
      ['Let me ', 'consider…'],
    );
    const done = events.at(-1) as { result: { text: string; thinking?: string } };
    expect(done.result.text).toBe('Done.');
    expect(done.result.thinking).toBe('Let me consider…');
  });

  it('sets one reasoning block off from the next with a paragraph break', async () => {
    // Two blocks either side of a tool call. The wire carries fragments, not
    // blocks, so the boundary has to be spelled out or the two arrive glued.
    const source = fakeRuns([
      { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'First, look.' },
      { type: 'tool.start', name: 'Read', toolCallId: 't1', input: { file_path: '/w/a.ts' } },
      { type: 'thinking.delta', messageId: 'm2', blockIndex: 0, text: 'Now the ' },
      { type: 'thinking.delta', messageId: 'm2', blockIndex: 0, text: 'other file.' },
      { type: 'text.delta', text: 'Done.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source);
    expect(events.filter((e) => e.kind === 'thinking').map((e) => (e as { text: string }).text)).toEqual(
      ['First, look.', '\n\nNow the ', 'other file.'],
    );
    const done = events.at(-1) as { result: { thinking?: string } };
    expect(done.result.thinking).toBe('First, look.\n\nNow the other file.');
  });

  it('forwards no thinking the provider withheld, and none it never had', async () => {
    // A redacted block is a signature with no plaintext, and an empty delta is
    // not a delivery: neither has anything a client could draw, and a
    // `reasoning_content` of "" would still open a fold that never fills.
    const source = fakeRuns([
      { type: 'thinking.delta', text: '', redacted: true },
      { type: 'thinking.delta', text: '' },
      { type: 'text.delta', text: 'Done.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source);
    expect(events.some((e) => e.kind === 'thinking')).toBe(false);
    const done = events.at(-1) as { result: { thinking?: string } };
    expect(done.result.thinking).toBeUndefined();
  });

  it('leaves a subagent’s words out of the answer', async () => {
    // A subagent reports to the agent, not to the caller. Relaying its text
    // handed the caller the findings inline *and then* the agent's account of
    // them — the same answer twice, in two voices. The call that spawned it is
    // still reported, as activity.
    const source = fakeRuns([
      { type: 'tool.start', name: 'Task', toolCallId: 't1', input: { prompt: 'look around' } },
      { type: 'thinking.delta', text: 'sub-thought', agentId: 't1' },
      { type: 'text.delta', text: 'I found three files. ', agentId: 't1' },
      { type: 'text.complete', role: 'assistant', text: 'I found three files. ', agentId: 't1' },
      { type: 'text.delta', text: 'There are three files.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source);
    expect(events.some((e) => e.kind === 'thinking')).toBe(false);
    const done = events.at(-1) as {
      result: { text: string; activity: readonly { tool: string }[] };
    };
    expect(done.result.text).toBe('There are three files.');
    expect(done.result.activity.map((entry) => entry.tool)).toEqual(['task']);
  });

  it('does not read replayed history back as this turn’s answer', async () => {
    // A resumed conversation replays its stored blocks through the same
    // event, marked. A previous turn's reply is not this one's.
    const source = fakeRuns([
      { type: 'text.complete', role: 'assistant', text: 'Last time I said this.', replay: true },
      { type: 'text.complete', role: 'assistant', text: 'And now this.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as { result: { text: string } };
    expect(done.result.text).toBe('And now this.');
  });

  it('reports what the agent did, without reporting what it found', async () => {
    const source = fakeRuns([
      {
        type: 'tool.start',
        name: 'Read',
        toolCallId: 't1',
        input: { file_path: '/w/src/index.ts' },
      },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as {
      result: { activity: readonly { tool: string; summary?: string }[] };
    };
    expect(done.result.activity[0]).toMatchObject({
      tool: 'read',
      summary: '/w/src/index.ts',
    });
  });

  it('carries the session id, so a caller can continue the conversation', async () => {
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-9' },
      { type: 'run.end', reason: 'completed', sessionId: 'sess-9' },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as { result: { sessionId?: string } };
    expect(done.result.sessionId).toBe('sess-9');
  });

  it('hands a requested permission mode to the run, and omits an absent one', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }] as Partial<AgentEvent>[]);
    await drain(source, turn({ extensions: { permissionMode: 'acceptEdits' } }));
    expect(source.started[0]?.input).toMatchObject({ permissionMode: 'acceptEdits' });

    const plain = fakeRuns([{ type: 'run.end', reason: 'completed' }] as Partial<AgentEvent>[]);
    await drain(plain);
    expect(plain.started[0]?.input).not.toHaveProperty('permissionMode');
  });

  it('announces a fresh session the moment it exists, not only on done', async () => {
    // A client whose stream dies mid-turn would otherwise learn the id never —
    // and the Artemis-driving-Artemis adapter builds its `session.started`
    // from this announcement.
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-9' },
      { type: 'text.delta', text: 'Hi' },
      { type: 'run.end', reason: 'completed', sessionId: 'sess-9' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toEqual(['run', 'session', 'text', 'done']);
    expect(events[1]).toMatchObject({ kind: 'session', sessionId: 'sess-9' });
  });

  it('does not re-announce a session its caller already named', async () => {
    // A resumed turn's caller sent the id in; telling them again is noise.
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-9' },
      { type: 'run.end', reason: 'completed', sessionId: 'sess-9' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source, turn({ extensions: { sessionId: 'sess-9' } }));
    expect(events.map((event) => event.kind)).toEqual(['run', 'done']);
  });

  it('announces the new id when a resumed run lands in a different session', async () => {
    // Providers may branch on resume; the caller must learn where the
    // conversation actually went.
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-fork' },
      { type: 'run.end', reason: 'completed', sessionId: 'sess-fork' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source, turn({ extensions: { sessionId: 'sess-9' } }));
    expect(events[1]).toMatchObject({ kind: 'session', sessionId: 'sess-fork' });
  });

  it('maps usage into OpenAI’s three numbers', async () => {
    const source = fakeRuns([
      {
        type: 'run.end',
        reason: 'completed',
        usage: { scope: 'final', tokens: { inputTokens: 100, outputTokens: 40 } },
      },
    ] as Partial<AgentEvent>[]);

    const done = (await drain(source)).at(-1) as { result: { usage?: Record<string, number> } };
    expect(done.result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
    });
  });

  it('always disposes the run, so a reply never leaks a process', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    await drain(source);
    expect(source.disposed).toEqual(['run-1']);
  });

  it('reports a failure to start rather than hanging', async () => {
    const source = fakeRuns([], {
      startRun: async () => {
        throw new Error('no such profile');
      },
    });

    const done = (await drain(source)).at(-1) as { result: { error?: string } };
    expect(done.result.error).toBe('no such profile');
  });
});

describe('permission requests, with nobody to answer them', () => {
  it('denies automatically instead of parking forever', async () => {
    // Over HTTP there is usually no human. A request that waited would hang
    // until the client timed out, with no explanation on either side.
    const source = fakeRuns([
      { type: 'permission.request', requestId: 'perm-1', request: {} },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    await drain(source);
    expect(source.denied).toEqual(['perm-1']);
  });

  it('explains the denial as a constraint the model can work around', async () => {
    let message = '';
    const source = fakeRuns(
      [
        { type: 'permission.request', requestId: 'perm-1', request: {} },
        { type: 'run.end', reason: 'permission_denied' },
      ] as Partial<AgentEvent>[],
      {
        respondToPermission: async (_runId, _requestId, decision) => {
          message = decision.behavior === 'deny' ? (decision.message ?? '') : '';
        },
      },
    );

    const done = (await drain(source)).at(-1) as { result: { error?: string } };
    expect(message).toMatch(/no one is present to approve/i);
    expect(done.result.error).toMatch(/permission/i);
  });

  it('says nothing about permissions to a caller that did not ask to hear', async () => {
    // The whole backward-compatibility claim, checked on the wire rather than
    // asserted: a request with no `remote` block sees the same events it
    // always did, denial included and unannounced.
    const source = fakeRuns([
      { type: 'permission.request', requestId: 'perm-1', request: {} },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'denied' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const kinds = (await drain(source)).map((event) => event.kind);
    expect(kinds).toEqual(['run', 'done']);
  });
});

describe('permission requests, with somebody who can answer them', () => {
  const REMOTE = { remote: { permissions: true } };

  it('puts the request on the wire instead of denying it', async () => {
    const source = fakeRuns([
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { id: 'perm-1', toolName: 'Bash', input: { command: 'ls' } },
      },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source, turn({ extensions: REMOTE }));
    // Nothing was answered here: the decision arrives on its own request,
    // routinely after this stream is gone.
    expect(source.denied).toEqual([]);
    expect(events.find((event) => event.kind === 'permission')).toMatchObject({
      kind: 'permission',
      notice: {
        status: 'requested',
        request: { id: 'perm-1', toolName: 'Bash', input: { command: 'ls' } },
      },
    });
  });

  it('reports the settlement too, so a card raised elsewhere can be cleared', async () => {
    // The answer can come from another client, or from the park deadline. A
    // watcher that only ever saw the question would hold an open prompt over a
    // decision that was made minutes ago.
    const source = fakeRuns([
      { type: 'permission.request', requestId: 'perm-1', request: { id: 'perm-1' } },
      {
        type: 'permission.resolved',
        requestId: 'perm-1',
        outcome: 'allowed',
        note: 'approved from the phone',
      },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source, turn({ extensions: REMOTE }));
    expect(events.filter((event) => event.kind === 'permission').at(-1)).toMatchObject({
      kind: 'permission',
      notice: {
        status: 'resolved',
        requestId: 'perm-1',
        outcome: 'allowed',
        note: 'approved from the phone',
      },
    });
  });

  it('carries an allow, with everything an allow can say', async () => {
    // The seam takes the whole decision union now. It used to take denials
    // only, and every caller that had an approval to deliver had to cast past
    // the type to do it.
    const answered: unknown[] = [];
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }], {
      respondToPermission: async (_runId, requestId, decision) => {
        answered.push({ requestId, decision });
      },
    });

    await source.respondToPermission('run-1', 'perm-1', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      scope: 'session',
    });

    expect(answered).toEqual([
      {
        requestId: 'perm-1',
        decision: { behavior: 'allow', updatedInput: { command: 'ls -la' }, scope: 'session' },
      },
    ]);
  });
});

describe('a client that goes away', () => {
  it('interrupts the run rather than paying for output nobody reads', async () => {
    const aborted = { aborted: true };
    // A run that never ends on its own: only the interrupt path can finish it.
    const source = fakeRuns([{ type: 'text.delta', text: 'working…' }]);

    const events = runTurn(source, turn({ signal: aborted }));
    expect((await events.next()).value).toMatchObject({ kind: 'run' });
    expect((await events.next()).value).toMatchObject({ kind: 'text' });

    // Let the loop notice the abort, then close the generator as the socket
    // layer does when the response ends.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await events.return(undefined as never);

    expect(source.interrupted).toEqual(['run-1']);
    expect(source.disposed).toEqual(['run-1']);
  });

  it('leaves a detachable run alone, and hands it on instead', async () => {
    // The other half of the same teardown, and the headline of the feature: a
    // laptop that sleeps mid-run must not take the agent down with it. The run
    // is neither interrupted nor disposed — disposing would release the
    // provider process the whole thing exists to keep.
    const aborted = { aborted: true };
    const detached: string[] = [];
    const source = fakeRuns([{ type: 'text.delta', text: 'working…' }]);

    const events = runTurn(
      source,
      turn({
        signal: aborted,
        extensions: { remote: { detach: true } },
        onDetach: (runId: string) => detached.push(runId),
      }),
    );
    expect((await events.next()).value).toMatchObject({ kind: 'run', runId: 'run-1' });
    expect((await events.next()).value).toMatchObject({ kind: 'text' });

    await new Promise((resolve) => setTimeout(resolve, 300));
    await events.return(undefined as never);

    expect(source.interrupted).toEqual([]);
    expect(source.disposed).toEqual([]);
    expect(detached).toEqual(['run-1']);
  });

  it('still disposes a detachable run that finished on its own', async () => {
    // Detaching says what a *silence* means. A turn that ended has no work left
    // to survive, so it is released exactly as it always was.
    const detached: string[] = [];
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);

    await drain(
      source,
      turn({
        extensions: { remote: { detach: true } },
        onDetach: (runId: string) => detached.push(runId),
      }),
    );

    expect(source.disposed).toEqual(['run-1']);
    expect(detached).toEqual([]);
  });

  it('stops pulling the moment a detachable client is gone', async () => {
    // Draining on would hold the request handler open, writing into a dead
    // socket, for as long as the agent keeps working — which for the case this
    // exists for is hours.
    const aborted = { aborted: false };
    const source = fakeRuns([{ type: 'text.delta', text: 'working…' }]);

    const events = runTurn(
      source,
      turn({
        signal: aborted,
        extensions: { remote: { detach: true } },
        onDetach: () => undefined,
      }),
    );
    await events.next();
    await events.next();

    aborted.aborted = true;
    // No `run.end` is ever scripted: only the abort path can end this loop.
    expect(await events.next()).toEqual({ done: true, value: undefined });
    expect(source.interrupted).toEqual([]);
  });

  it('ignores the request when there is nowhere to hand the run to', async () => {
    // Skipping the interrupt with no owner and no deadline would not be a
    // weaker promise, it would be a leak: a provider process nothing can reach
    // and nothing will ever stop. A build with nowhere to put the run ends it
    // exactly as it always did.
    const aborted = { aborted: true };
    const source = fakeRuns([{ type: 'text.delta', text: 'working…' }]);

    const events = runTurn(source, turn({ signal: aborted, extensions: { remote: { detach: true } } }));
    await events.next();
    await events.next();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await events.return(undefined as never);

    expect(source.interrupted).toEqual(['run-1']);
    expect(source.disposed).toEqual(['run-1']);
  });
});

describe('what gets sent to the provider', () => {
  it('passes the thinking level, fast mode and ultracode through', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    await drain(
      source,
      turn({ extensions: { thinking: 'high', fastMode: true, ultracode: false } }),
    );

    expect(source.started[0]?.input).toMatchObject({
      model: 'opus',
      effort: 'high',
      fastMode: true,
      ultracode: false,
      cwd: '/w',
    });
  });

  it('resumes a session when one was named', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    await drain(source, turn({ extensions: { sessionId: 'sess-3' } }));
    expect(source.started[0]?.input).toMatchObject({ resumeSessionId: 'sess-3' });
  });
});

describe('promptFromMessages', () => {
  it('treats the trailing user message as the turn', () => {
    expect(
      promptFromMessages(
        [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
        { resuming: false },
      ),
    ).toContain('second');
  });

  it('does not replay history into a session that already holds it', () => {
    // The double-counting this prevents: a stateless client re-sends the whole
    // array every call, and a resumed session already has it.
    const prompt = promptFromMessages(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      { resuming: true },
    );
    expect(prompt).toBe('second');
  });

  it('carries history when there is no session to resume', () => {
    const prompt = promptFromMessages(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      { resuming: false },
    );
    expect(prompt).toContain('first');
    expect(prompt).toContain('reply');
  });

  it('keeps system messages every time, because they are instructions not history', () => {
    for (const resuming of [true, false]) {
      expect(
        promptFromMessages(
          [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
          ],
          { resuming },
        ),
      ).toContain('Be terse.');
    }
  });

  it('reads content given as parts, and names an image it cannot forward', () => {
    const prompt = promptFromMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
      { resuming: false },
    );
    expect(prompt).toContain('what is this');
    // Named rather than dropped: the model should know something was meant to
    // be there.
    expect(prompt).toContain('image omitted');
  });
});

/* -------------------------------------------------------------------------- */
/* Over a real socket                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A run source that remembers what it emitted, so a resume can replay it.
 *
 * `runEvents` is the engine's retained tail; `emit` publishes live. The two
 * paths a resume has to reconcile are exactly these — what was kept and what
 * arrives — so the fake keeps them separate rather than scripting one list.
 */
function retainingRuns(retained: readonly Partial<AgentEvent>[] = []) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const events: AgentEvent[] = retained.map(
    (partial) => ({ runId: 'run-1', ts: 0, ...partial }) as AgentEvent,
  );
  const denied: string[] = [];
  const interrupted: string[] = [];
  const disposed: string[] = [];
  const source: RunSource = {
    startRun: async () => {
      throw new Error('not started here');
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interrupt: async (runId) => {
      interrupted.push(String(runId));
    },
    respondToPermission: async (_runId, requestId) => {
      denied.push(requestId);
    },
    disposeRun: async (runId) => {
      disposed.push(String(runId));
    },
    runEvents: async (query) => {
      const after = query.afterSeq ?? -1;
      const kept = events.filter((event) => event.runId === query.runId && event.seq > after);
      const first = kept[0];
      return { events: kept, truncated: first !== undefined && first.seq > after + 1 };
    },
  };
  const emit = (partial: Partial<AgentEvent>): void => {
    const event = { runId: 'run-1', ts: 0, ...partial } as AgentEvent;
    events.push(event);
    for (const listener of listeners) listener(event);
  };
  return Object.assign(source, { emit, denied, interrupted, disposed });
}

describe('a turn, numbered', () => {
  it('stamps every piece with the event it came from, and the announcement with nothing', async () => {
    // The cursor a client resumes from. Pieces from the event stream carry
    // their event's seq; the run announcement comes from nowhere in it.
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-9', seq: 0 },
      { type: 'thinking.delta', text: 'hm', seq: 1 },
      { type: 'text.delta', text: 'Hi', seq: 2 },
      { type: 'run.end', reason: 'completed', seq: 3 },
    ] as Partial<AgentEvent>[]);

    const events = await drain(source);
    expect(events.map((event) => [event.kind, event.seq])).toEqual([
      ['run', undefined],
      ['session', 0],
      ['thinking', 1],
      ['text', 2],
      ['done', 3],
    ]);
  });
});

describe('picking a run back up', () => {
  const drainResume = async (
    source: RunSource,
    request: Parameters<typeof resumeTurn>[1],
    onEach?: (kind: string) => void,
  ) => {
    const events = [];
    for await (const event of resumeTurn(source, request)) {
      events.push(event);
      onEach?.(event.kind);
    }
    return events;
  };

  it('replays what the client missed, then follows the run live, without repeating anything', async () => {
    const source = retainingRuns([
      { type: 'session.started', sessionId: 'sess-9', seq: 0 },
      { type: 'text.delta', text: 'one ', seq: 1 },
      { type: 'text.delta', text: 'two ', seq: 2 },
    ]);

    const events = await drainResume(source, { runId: 'run-1' as never, afterSeq: 1 }, (kind) => {
      // The moment the replay is consumed the run is still going: two more
      // events arrive live, one of them a repeat of the last retained event
      // — a race the subscribe-before-replay ordering makes routine.
      if (kind === 'text') {
        queueMicrotask(() => {
          source.emit({ type: 'text.delta', text: 'two ', seq: 2 });
          source.emit({ type: 'text.delta', text: 'three', seq: 3 });
          source.emit({ type: 'run.end', reason: 'completed', seq: 4 });
        });
      }
    });

    expect(events.map((event) => [event.kind, event.seq])).toEqual([
      ['run', undefined],
      ['text', 2],
      ['text', 3],
      ['done', 4],
    ]);
    const done = events.at(-1) as { result: { text: string; sessionId?: string } };
    // The reply is rebuilt from the whole tail, not only the part replayed:
    // what the client already had is counted, what it never saw is too.
    expect(done.result.text).toBe('one two three');
    expect(done.result.sessionId).toBe('sess-9');
    expect(source.interrupted).toEqual([]);
    expect(source.disposed).toEqual([]);
  });

  it('ends at once when the run already ended while nobody was attached', async () => {
    const source = retainingRuns([
      { type: 'text.delta', text: 'all of it', seq: 0 },
      { type: 'run.end', reason: 'completed', seq: 1 },
    ]);
    const events = await drainResume(source, { runId: 'run-1' as never, afterSeq: 0 });
    expect(events.map((event) => event.kind)).toEqual(['run', 'done']);
  });

  it('replays from the beginning for a client that had rendered nothing', async () => {
    const source = retainingRuns([
      { type: 'text.delta', text: 'a', seq: 0 },
      { type: 'run.end', reason: 'completed', seq: 1 },
    ]);
    const events = await drainResume(source, { runId: 'run-1' as never });
    expect(events.map((event) => [event.kind, event.seq])).toEqual([
      ['run', undefined],
      ['text', 0],
      ['done', 1],
    ]);
  });

  it('says so first when the retained tail no longer reaches the cursor', async () => {
    // The engine keeps a bounded tail. A cursor older than its head is a hole
    // the client has to be told about, or it splices two halves of an answer
    // together as though nothing were missing.
    const source = retainingRuns([
      { type: 'text.delta', text: 'late', seq: 7 },
      { type: 'run.end', reason: 'completed', seq: 8 },
    ]);
    const events = await drainResume(source, { runId: 'run-1' as never, afterSeq: 2 });
    expect(events.map((event) => event.kind)).toEqual(['run', 'gap', 'text', 'done']);
    expect(events[1]).toMatchObject({ kind: 'gap', afterSeq: 2, firstSeq: 7 });
  });

  it('never denies a prompt: a question asked into an empty room is what the client came back for', async () => {
    const source = retainingRuns([
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { id: 'perm-1', toolName: 'Bash', input: { command: 'ls' } },
        seq: 0,
      },
      { type: 'run.end', reason: 'completed', seq: 1 },
    ]);
    const events = await drainResume(source, { runId: 'run-1' as never });
    expect(events[1]).toMatchObject({
      kind: 'permission',
      notice: { status: 'requested', request: { id: 'perm-1' } },
      seq: 0,
    });
    expect(source.denied).toEqual([]);
  });

  it('hands the run back when the client goes again, and never ends it', async () => {
    const source = retainingRuns([{ type: 'text.delta', text: 'so far', seq: 0 }]);
    const signal = { aborted: false };
    const detached: string[] = [];

    const stream = resumeTurn(source, {
      runId: 'run-1' as never,
      afterSeq: 0,
      signal,
      onDetach: (runId) => detached.push(String(runId)),
    });
    expect((await stream.next()).value).toMatchObject({ kind: 'run' });
    // Nothing more is retained and nothing arrives; the client hangs up.
    const pending = stream.next();
    signal.aborted = true;
    expect((await pending).done).toBe(true);

    expect(detached).toEqual(['run-1']);
    expect(source.interrupted).toEqual([]);
    expect(source.disposed).toEqual([]);
  });
});

describe('POST /v1/chat/completions', () => {
  const TOKEN = 'completions-token-0123456789abcdef';
  const CONNECTION = {
    id: 'conn-1',
    label: 'Test',
    workspace: { kind: 'ephemeral' as const, perSession: true },
    token: TOKEN,
    createdAt: 0,
  };
  const CATALOGUE = {
    read: async () => [
      {
        id: 'prof-a' as ServerModel['profileId'],
        slug: 'work-max',
        label: 'Work Max',
        provider: { id: 'claude' as const, label: 'Claude', kind: 'hosted' as const },
        available: true,
        disabled: false,
        live: true,
        capabilities: NO_CAPABILITIES,
        models: [MODEL],
      },
    ],
    invalidate: () => undefined,
  };

  async function serve(
    source: RunSource,
    extra: {
      onError?: (error: unknown) => void;
      remoteStream?: { heartbeatMs?: number };
    } = {},
  ) {
    const { createArtemisServer } = await import('../http.js');
    const { createWorkspaceResolver } = await import('../workspaces.js');
    const server = createArtemisServer({
      port: 0,
      connections: () => [CONNECTION],
      version: '1.1.1',
      catalogue: CATALOGUE,
      runs: source,
      workspaces: createWorkspaceResolver(),
      ...extra,
    });
    const port = await server.listen();
    return { server, url: `http://127.0.0.1:${port}/v1/chat/completions` };
  }

  const post = (url: string, body: unknown, token = TOKEN) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers in the shape an OpenAI client parses', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'Hello there' },
      {
        type: 'run.end',
        reason: 'completed',
        sessionId: 'sess-1',
        usage: { scope: 'final', tokens: { inputTokens: 10, outputTokens: 3 } },
      },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, never>;
      expect(body).toMatchObject({
        object: 'chat.completion',
        model: 'work-max/opus',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello there' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        artemis: { sessionId: 'sess-1', endReason: 'completed' },
      });
    } finally {
      await server.close();
    }
  });

  it('puts the reason on the final chunk when a streamed run fails', async () => {
    /*
     * The failure this whole field exists for. A stream cannot answer 502, so
     * before it the reason had nowhere to go: the caller got `endReason:
     * "error"` on an empty delta and nothing else, while the non-streaming
     * path returned the very same sentence as a 502 body. Every remote failure
     * therefore reached a desktop as an unexplained one — including the plain
     * case of an account on the server that was never signed in.
     */
    const source = fakeRuns([
      {
        type: 'run.end',
        reason: 'error',
        error: { code: 'unknown', message: 'unexpected status 401 Unauthorized' },
      },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const chunks = (await response.text())
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));

      const final = JSON.parse(chunks.at(-2) as string);
      expect(final.artemis.endReason).toBe('error');
      expect(final.artemis.error).toBe('unexpected status 401 Unauthorized');
    } finally {
      await server.close();
    }
  });

  it('says a failed run out loud on the serving machine', async () => {
    // The other half: the reason travelled *away* from the server and was kept
    // nowhere on it, so whoever ran the server could not find out that one of
    // the accounts it serves had stopped working.
    const seen: string[] = [];
    const source = fakeRuns([
      {
        type: 'run.end',
        reason: 'error',
        error: { code: 'unknown', message: 'unexpected status 401 Unauthorized' },
      },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source, {
      onError: (error) => seen.push(error instanceof Error ? error.message : String(error)),
    });
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      await response.text();

      // Names the route, so a server with five accounts says which one broke.
      expect(seen).toEqual(['run on work-max/opus failed: unexpected status 401 Unauthorized']);
    } finally {
      await server.close();
    }
  });

  it('streams as Server-Sent Events, ending with the sentinel', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'one ' },
      { type: 'text.delta', text: 'two' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const text = await response.text();
      const chunks = text
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));

      // The order OpenAI clients depend on: role first, then content, then a
      // finish_reason, then [DONE].
      expect(JSON.parse(chunks[0]!).choices[0].delta).toEqual({ role: 'assistant' });
      const content = chunks
        .slice(1, -2)
        .map((chunk) => JSON.parse(chunk).choices[0].delta.content ?? '')
        .join('');
      expect(content).toBe('one two');
      expect(JSON.parse(chunks.at(-2)!).choices[0].finish_reason).toBe('stop');
      expect(chunks.at(-1)).toBe('[DONE]');
    } finally {
      await server.close();
    }
  });

  it('streams reasoning on its own field, never in content', async () => {
    // The field the reasoning-capable OpenAI-shaped servers use. An OpenAI
    // client appends nothing from it; an Artemis client draws a thinking row.
    const source = fakeRuns([
      { type: 'thinking.delta', text: 'Weighing ' },
      { type: 'thinking.delta', text: 'it up.' },
      { type: 'text.delta', text: 'Yes.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const deltas = (await response.text())
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .filter((chunk) => chunk !== '[DONE]')
        .map((chunk) => JSON.parse(chunk).choices[0].delta as Record<string, string>);

      const reasoning = deltas.map((delta) => delta['reasoning_content'] ?? '').join('');
      const content = deltas.map((delta) => delta['content'] ?? '').join('');
      expect(reasoning).toBe('Weighing it up.');
      expect(content).toBe('Yes.');
      // Never both on one chunk, and never the reasoning inside the answer.
      expect(deltas.some((delta) => 'reasoning_content' in delta && 'content' in delta)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('puts the reasoning beside the whole answer, when the caller did not stream', async () => {
    const source = fakeRuns([
      { type: 'thinking.delta', text: 'Weighing it up.' },
      { type: 'text.delta', text: 'Yes.' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const body = (await response.json()) as {
        choices: { message: { content: string; reasoning_content?: string } }[];
      };
      expect(body.choices[0]?.message).toEqual({
        role: 'assistant',
        content: 'Yes.',
        reasoning_content: 'Weighing it up.',
      });
    } finally {
      await server.close();
    }
  });

  it('numbers every chunk that came from an event', async () => {
    const source = fakeRuns([
      { type: 'text.delta', text: 'one', seq: 0 },
      { type: 'text.delta', text: 'two', seq: 1 },
      { type: 'run.end', reason: 'completed', seq: 2 },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const chunks = (await response.text())
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .filter((chunk) => chunk !== '[DONE]')
        .map((chunk) => JSON.parse(chunk));

      // Role, run announcement, two text chunks, the final chunk.
      expect(chunks.map((chunk) => chunk.artemis?.seq)).toEqual([undefined, undefined, 0, 1, 2]);
    } finally {
      await server.close();
    }
  });

  it('keeps a quiet stream alive with a heartbeat comment', async () => {
    // An agent inside a long tool call sends nothing for minutes. Without a
    // heartbeat a client cannot tell that from a dead socket, and an idle
    // timeout somewhere on the path can make it one.
    const listeners = new Set<(event: AgentEvent) => void>();
    const source: RunSource = {
      ...fakeRuns([]),
      startRun: async (input) => {
        setTimeout(() => {
          for (const listener of listeners) {
            listener({ runId: 'run-1', seq: 0, ts: 0, type: 'run.end', reason: 'completed' } as AgentEvent);
          }
        }, 120);
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
    };

    const { server, url } = await serve(source, { remoteStream: { heartbeatMs: 20 } });
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const text = await response.text();
      expect(text.split(':hb\n\n').length).toBeGreaterThan(2);
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('picks the stream back up on GET /api/v0/runs/{id}/stream, after the cursor the client names', async () => {
    const source = retainingRuns();
    source.startRun = async (input) => {
      queueMicrotask(() => {
        source.emit({ type: 'session.started', sessionId: 'sess-9', seq: 0 });
        source.emit({ type: 'text.delta', text: 'one ', seq: 1 });
        source.emit({ type: 'text.delta', text: 'two', seq: 2 });
        source.emit({ type: 'run.end', reason: 'completed', seq: 3 });
      });
      return {
        runId: 'run-1',
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'working',
        capabilities: NO_CAPABILITIES,
      } as unknown as RunHandle;
    };

    const { server, url } = await serve(source);
    const base = url.replace('/v1/chat/completions', '');
    try {
      // The original stream claims the run for this connection.
      const first = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        artemis: { remote: { detach: true, permissions: true } },
      });
      await first.text();

      const resumed = await fetch(`${base}/api/v0/runs/run-1/stream?after=1`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(resumed.status).toBe(200);
      expect(resumed.headers.get('content-type')).toContain('text/event-stream');
      const raw = await resumed.text();
      const chunks = raw
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));
      expect(chunks.at(-1)).toBe('[DONE]');
      const parsed = chunks.slice(0, -1).map((chunk) => JSON.parse(chunk));
      // The run id first, then only what came after the cursor — and no role
      // chunk, because the client is appending to a message it already has.
      expect(parsed.map((chunk) => [chunk.artemis?.runId, chunk.artemis?.seq, chunk.choices[0].delta.content])).toEqual([
        ['run-1', undefined, undefined],
        [undefined, 2, 'two'],
        [undefined, 3, undefined],
      ]);
      expect(parsed.at(-1)).toMatchObject({
        choices: [{ finish_reason: 'stop' }],
        artemis: { endReason: 'completed', sessionId: 'sess-9', seq: 3 },
      });
      // Stamped with the route the run was started on.
      expect(parsed[0].model).toBe('work-max/opus');

      // A cursor that is not a number is refused, not guessed at.
      const bad = await fetch(`${base}/api/v0/runs/run-1/stream?after=soon`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(bad.status).toBe(400);

      // A run this connection did not start is not there, in the same words
      // as one that never existed.
      const stranger = await fetch(`${base}/api/v0/runs/run-999/stream`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(stranger.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('announces a fresh session on an early chunk, before the text', async () => {
    // The chunk an OpenAI client ignores (empty delta, extra namespace) and an
    // Artemis client builds its `session.started` from. Without it, a caller
    // whose stream died mid-turn learned the id never.
    const source = fakeRuns([
      { type: 'session.started', sessionId: 'sess-early' },
      { type: 'text.delta', text: 'hi' },
      { type: 'run.end', reason: 'completed', sessionId: 'sess-early' },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });

      const chunks = (await response.text())
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .filter((chunk) => chunk !== '[DONE]')
        .map((chunk) => JSON.parse(chunk) as Record<string, any>);

      const sessionAt = chunks.findIndex((chunk) => chunk.artemis?.sessionId === 'sess-early');
      const textAt = chunks.findIndex((chunk) => chunk.choices?.[0]?.delta?.content !== undefined);

      expect(sessionAt).toBeGreaterThan(-1);
      expect(sessionAt).toBeLessThan(textAt);
      // Harmless to a strict OpenAI client: a well-formed chunk, empty delta,
      // no finish reason.
      expect(chunks[sessionAt]!.choices[0].delta).toEqual({});
      expect(chunks[sessionAt]!.choices[0].finish_reason).toBeNull();
      // And the final chunk still repeats it, which is what pre-existing
      // clients read.
      expect(chunks.at(-1)!.artemis.sessionId).toBe('sess-early');
    } finally {
      await server.close();
    }
  });

  it('announces the run id before anything else, on every stream', async () => {
    // The only place a run id is ever published, and every route under
    // /api/v0/runs takes one. A client that means to reattach after the stream
    // breaks has to be holding it before it does — so it goes first, and it
    // goes to callers that asked for nothing in particular.
    const source = fakeRuns([
      { type: 'text.delta', text: 'hi' },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[]);

    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const chunks = (await response.text())
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .filter((chunk) => chunk !== '[DONE]')
        .map((chunk) => JSON.parse(chunk) as Record<string, any>);

      const runAt = chunks.findIndex((chunk) => chunk.artemis?.runId === 'run-1');
      const textAt = chunks.findIndex(
        (chunk) => chunk.choices?.[0]?.delta?.content !== undefined,
      );
      expect(runAt).toBeGreaterThan(-1);
      expect(runAt).toBeLessThan(textAt);
      // Harmless to a strict OpenAI client, on the same terms as the session
      // chunk: well-formed, empty delta, no finish reason.
      expect(chunks[runAt]!.choices[0].delta).toEqual({});
      expect(chunks[runAt]!.choices[0].finish_reason).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('puts a permission prompt on the stream only for a caller that asked', async () => {
    const script = [
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { id: 'perm-1', toolName: 'Bash', input: { command: 'rm -rf build' } },
      },
      { type: 'run.end', reason: 'completed' },
    ] as Partial<AgentEvent>[];

    const chunksOf = async (body: Record<string, unknown>) => {
      const source = fakeRuns(script);
      const { server, url } = await serve(source);
      try {
        const response = await post(url, { ...body, stream: true });
        return {
          denied: source.denied,
          chunks: (await response.text())
            .split('\n\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .filter((chunk) => chunk !== '[DONE]')
            .map((chunk) => JSON.parse(chunk) as Record<string, any>),
        };
      } finally {
        await server.close();
      }
    };

    const plain = await chunksOf({
      model: 'work-max/opus',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(plain.chunks.some((chunk) => chunk.artemis?.permission !== undefined)).toBe(false);
    expect(plain.denied).toEqual(['perm-1']);

    const remote = await chunksOf({
      model: 'work-max/opus',
      messages: [{ role: 'user', content: 'hi' }],
      artemis: { remote: { permissions: true } },
    });
    // Nothing was denied on its behalf: the decision arrives on its own
    // request, and the run parks until it does.
    expect(remote.denied).toEqual([]);
    expect(
      remote.chunks.find((chunk) => chunk.artemis?.permission !== undefined)!.artemis.permission,
    ).toEqual({
      status: 'requested',
      request: { id: 'perm-1', toolName: 'Bash', input: { command: 'rm -rf build' } },
    });
  });

  it('rejects a parameter it would otherwise have to ignore', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toMatch(/temperature/);
      // And nothing was started: every refusal happens before the user's plan
      // is spent.
      expect(source.started).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('proceeds when the caller opts into leniency', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed', result: 'ok' }]);
    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        artemis: { ignoreUnsupported: true },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { artemis: { ignored: readonly string[] } };
      // Accepted, not applied, and *said so* — which is the whole bargain.
      expect(body.artemis.ignored).toContain('temperature');
    } finally {
      await server.close();
    }
  });

  it('refuses a route this connection may not use, as though it did not exist', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { createArtemisServer } = await import('../http.js');
    const { createWorkspaceResolver } = await import('../workspaces.js');
    const server = createArtemisServer({
      port: 0,
      connections: () => [
        { ...CONNECTION, allow: [{ profileId: 'someone-else' as ServerModel['profileId'] }] },
      ],
      version: '1.1.1',
      catalogue: CATALOGUE,
      runs: source,
      workspaces: createWorkspaceResolver(),
    });
    const port = await server.listen();

    try {
      const response = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(404);
      expect(source.started).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('refuses a catalogue-only connection with a reason, not a crash', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { createArtemisServer } = await import('../http.js');
    const { createWorkspaceResolver } = await import('../workspaces.js');
    const server = createArtemisServer({
      port: 0,
      connections: () => [{ ...CONNECTION, workspace: { kind: 'none' as const } }],
      version: '1.1.1',
      catalogue: CATALOGUE,
      runs: source,
      workspaces: createWorkspaceResolver(),
    });
    const port = await server.listen();

    try {
      const response = await post(`http://127.0.0.1:${port}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).toMatch(/catalogue-only/i);
    } finally {
      await server.close();
    }
  });

  it('rejects a body that is not a conversation', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { server, url } = await serve(source);
    try {
      expect((await post(url, { model: 'work-max/opus' })).status).toBe(400);
      expect((await post(url, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('still needs a token', async () => {
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const { server, url } = await serve(source);
    try {
      const response = await post(url, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'hi' }],
      }, 'wrong');
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe('a resumed conversation', () => {
  it('reports the session it ran in, even when the provider does not repeat it', async () => {
    /*
     * A new session announces itself with `session.started`; a resumed one does
     * not, and providers do not always repeat the id on `run.end`. Without this,
     * the second turn's response carried no `sessionId` and a client following
     * the documented pattern lost the thread after one exchange.
     */
    const source = fakeRuns([{ type: 'run.end', reason: 'completed' }]);
    const done = (await drain(source, turn({ extensions: { sessionId: 'sess-existing' } }))).at(
      -1,
    ) as { result: { sessionId?: string } };

    expect(done.result.sessionId).toBe('sess-existing');
  });

  it('prefers an id the run reports over the one it was given', async () => {
    // A provider that forks rather than resumes answers in a different session,
    // and the caller must be told which one to continue.
    const source = fakeRuns([
      { type: 'run.end', reason: 'completed', sessionId: 'sess-forked' },
    ] as Partial<AgentEvent>[]);
    const done = (await drain(source, turn({ extensions: { sessionId: 'sess-existing' } }))).at(
      -1,
    ) as { result: { sessionId?: string } };

    expect(done.result.sessionId).toBe('sess-forked');
  });
});
