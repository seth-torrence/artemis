import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ToolEndStatus } from '@rx-artemis/protocol';
import { SUGGESTED_TASK_TOOL } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  isGroupId,
  isSuggestedTaskCall,
  frameScheduler,
  syncScheduler,
  type AssistantItem,
  type ToolItem,
} from './transcript.js';

const RUN = 'run_1';

/** Envelope filler, so the tests read as event bodies rather than plumbing. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: RUN, seq: index, ts: 1000 + index })) as AgentEvent[];
}

function build(): TranscriptModel {
  return new TranscriptModel(syncScheduler);
}

describe('TranscriptModel', () => {
  it('coalesces deltas into one block and leaves the list identity alone', () => {
    const model = build();
    const onList = vi.fn();
    model.subscribeList(onList);

    const [start, ...deltas] = stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Hel' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'lo ' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'world' },
    );
    model.apply(start as AgentEvent);

    const listAfterFirst = model.getListSnapshot();
    const listCalls = onList.mock.calls.length;
    const id = listAfterFirst[0] as string;

    const onItem = vi.fn();
    model.subscribeItem(id, onItem);
    for (const event of deltas) model.apply(event);

    // Two more deltas touched the item twice and the list not at all.
    expect(onItem).toHaveBeenCalledTimes(2);
    expect(onList.mock.calls.length).toBe(listCalls);
    expect(model.getListSnapshot()).toBe(listAfterFirst);

    const item = model.getItem(id) as AssistantItem;
    expect(item.text).toBe('Hello world');
    expect(item.streaming).toBe(true);
  });

  it('treats text.complete as authoritative and stops the stream', () => {
    const model = build();
    for (const event of stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'partial' },
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 0, text: 'partial answer' },
    )) {
      model.apply(event);
    }
    const ids = model.getListSnapshot();
    expect(ids).toHaveLength(1);
    const item = model.getItem(ids[0] as string) as AssistantItem;
    expect(item.text).toBe('partial answer');
    expect(item.streaming).toBe(false);
  });

  it('finalises a streamed block by index after a tool row has settled it', () => {
    /*
     * The served-turn shape: the answer streams, the activity report lands as
     * tool rows (each of which settles every streaming block), and only then
     * does the whole-block completion arrive. Keyed by its index it finds the
     * block its deltas built. Sent without one — as the Artemis-server adapter
     * once did — it could not, opened a second block, and the reader saw the
     * answer twice.
     */
    const model = build();
    for (const event of stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Hel' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'lo.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'read', input: {} },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok' },
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 0, text: 'Hello.' },
    )) {
      model.apply(event);
    }
    model.flush();

    const answers = model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .filter((item): item is AssistantItem => item?.kind === 'assistant');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ id: 'a:m1:0', text: 'Hello.', streaming: false });
  });

  it('merges tool.start and tool.end into a single item', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md', durationMs: 12 },
    )) {
      model.apply(event);
    }
    const ids = model.getListSnapshot();
    expect(ids).toHaveLength(1);
    const item = model.getItem(ids[0] as string) as ToolItem;
    expect(item.name).toBe('Bash');
    expect(item.status).toBe('ok');
    expect(item.resultText).toBe('README.md');
    expect(item.input).toEqual({ command: 'ls' });
  });

  it('never leaves a spinner running when a run ends mid-call', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'sleep 100' } },
      { type: 'run.end', reason: 'interrupted' },
    )) {
      model.apply(event);
    }
    const tool = model.getItem('t:c1') as ToolItem;
    expect(tool.status).toBe('cancelled');
  });

  it('reconciles the optimistic user message instead of duplicating it', () => {
    const model = build();
    model.pushUserMessage('run the tests');
    model.apply(
      stream({ type: 'text.complete', messageId: 'u1', role: 'user', text: 'run the tests' })[0] as AgentEvent,
    );
    const ids = model.getListSnapshot();
    expect(ids).toHaveLength(1);
    const item = model.getItem(ids[0] as string);
    expect(item).toMatchObject({ kind: 'user', text: 'run the tests', pending: false });
  });

  it('surfaces a gap in the event sequence', () => {
    const model = build();
    model.apply({ type: 'text.delta', runId: RUN, seq: 0, ts: 1, messageId: 'm', blockIndex: 0, text: 'a' });
    model.apply({ type: 'text.delta', runId: RUN, seq: 4, ts: 2, messageId: 'm', blockIndex: 0, text: 'b' });
    const notices = model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .filter((item) => item?.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'warn' });
  });
});

/**
 * Replaying a run that had prompts in it.
 *
 * ⌘R reloads the renderer without touching the main process, so the transcript
 * is rebuilt by replaying the run's retained events into an empty model. Before
 * `permission.resolved` existed, the history held only the *asking* — so every
 * prompt the user had already answered came back pending, and the user was
 * asked to approve a plan they had approved a minute earlier.
 */
describe('TranscriptModel permission replay', () => {
  const REQUEST = {
    id: 'perm-1',
    runId: RUN,
    toolName: 'Bash',
    input: { command: 'ls' },
    requestedAt: 1,
  };

  function replay(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): TranscriptModel {
    const model = build();
    for (const event of stream(...drafts)) model.apply(event);
    return model;
  }

  function card(model: TranscriptModel) {
    return model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .find((item) => item?.kind === 'permission');
  }

  it('settles a replayed prompt instead of asking again', () => {
    const model = replay(
      { type: 'permission.request', requestId: 'perm-1', request: REQUEST },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'allowed' },
    );
    expect(card(model)).toMatchObject({ state: 'allowed' });
  });

  it('keeps a prompt that was still open when the window went away', () => {
    const model = replay({ type: 'permission.request', requestId: 'perm-1', request: REQUEST });
    // The run really is still parked on this one, so it has to come back as a
    // live card — the whole point of re-attaching is that the user can answer it.
    expect(card(model)).toMatchObject({ state: 'pending' });
  });

  it('records a denial with the reason that was given', () => {
    const model = replay(
      { type: 'permission.request', requestId: 'perm-1', request: REQUEST },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'denied', note: 'not that one' },
    );
    expect(card(model)).toMatchObject({ state: 'denied', note: 'not that one' });
  });

  /**
   * A question is answered, not "allowed" — and a replayed record has to show
   * which options were picked, or the transcript loses what the conversation
   * actually decided.
   */
  it('replays an answered question as answered, with the answers', () => {
    const question = {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'one' },
            { label: 'Luxon', description: 'two' },
          ],
        },
      ],
    };
    const model = replay(
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { ...REQUEST, toolName: 'AskUserQuestion', question },
      },
      {
        type: 'permission.resolved',
        requestId: 'perm-1',
        outcome: 'allowed',
        answers: [{ question: 'Which library?', options: ['Luxon'] }],
      },
    );
    expect(card(model)).toMatchObject({
      state: 'answered',
      answers: [{ question: 'Which library?', options: ['Luxon'] }],
    });
  });

  it('replays an unanswered question as skipped', () => {
    const question = {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'one' },
            { label: 'Luxon', description: 'two' },
          ],
        },
      ],
    };
    const model = replay(
      {
        type: 'permission.request',
        requestId: 'perm-1',
        request: { ...REQUEST, toolName: 'AskUserQuestion', question },
      },
      { type: 'permission.resolved', requestId: 'perm-1', outcome: 'allowed', answers: [] },
    );
    expect(card(model)).toMatchObject({ state: 'skipped' });
  });

  /**
   * The local record wins. Whoever sent the decision knows things the event
   * does not — the scope the user picked, for one — so a resolution arriving
   * after the card has already settled must not overwrite it.
   */
  it('does not overwrite a card that was already settled locally', () => {
    const model = build();
    for (const event of stream({
      type: 'permission.request',
      requestId: 'perm-1',
      request: REQUEST,
    })) {
      model.apply(event);
    }
    model.resolvePermission('perm-1', 'allowed', 'allowed for this session');
    model.apply({
      type: 'permission.resolved',
      runId: RUN,
      seq: 1,
      ts: 2,
      requestId: 'perm-1',
      outcome: 'allowed',
    });
    expect(card(model)).toMatchObject({ state: 'allowed', note: 'allowed for this session' });
  });

  /**
   * The retained history is bounded, so a long run can drop the request and
   * keep the resolution. There is no card to settle, and inventing one would
   * put a decision in the transcript with no ask above it.
   */
  it('ignores a resolution for a request it never saw', () => {
    const model = replay({ type: 'permission.resolved', requestId: 'perm-9', outcome: 'allowed' });
    expect(card(model)).toBeUndefined();
  });
});

describe('TranscriptModel activity groups', () => {
  /** `tool.start` + `tool.end` for one call, as a pair of event drafts. */
  function call(id: string, name: string, status: ToolEndStatus = 'ok') {
    return [
      { type: 'tool.start', toolCallId: id, name, input: {} },
      { type: 'tool.end', toolCallId: id, status },
    ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
  }

  /** One whole thinking block, the way a provider that does not stream sends it. */
  function thought(messageId: string, blockIndex: number, text: string) {
    return { type: 'thinking.delta', messageId, blockIndex, text } as Omit<
      AgentEvent,
      'runId' | 'seq' | 'ts'
    >;
  }

  it('folds a run of tool calls into one row and counts it by category', () => {
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      ...call('c2', 'Bash'),
      ...call('c3', 'Read'),
      ...call('c4', 'mcp__github__create_issue'),
    )) {
      model.apply(event);
    }

    const rows = model.getRowsSnapshot();
    expect(rows).toEqual(['g:t:c1']);
    expect(model.getListSnapshot()).toHaveLength(4);

    const group = model.getGroup('g:t:c1');
    expect(group?.ids).toEqual(['t:c1', 't:c2', 't:c3', 't:c4']);
    expect(group?.counts).toEqual({ command: 2, read: 1, mcp: 1 });
    expect(group?.running).toBe(0);
    expect(group?.failed).toBe(0);
  });

  it('does not break the work up when the agent says something mid-run', () => {
    /*
     * This asserted the opposite until the machinery moved to the foot of the
     * run, and the opposite is what it was reported as: a paragraph, a
     * `Ran 3 commands` bar, the rest of the paragraph. The prose is what the
     * reader came for, and a marker between its halves interrupts the one thing
     * the transcript exists to carry.
     *
     * So a message no longer splits the work in two. It flows on, and every
     * call in the run collects into one marker underneath it.
     */
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'halfway' },
      ...call('c2', 'Read'),
    )) {
      model.apply(event);
    }

    const rows = model.getRowsSnapshot();
    expect(rows).toHaveLength(2);
    // The message first, uninterrupted; one marker for both calls after it.
    expect(isGroupId(rows[0] as string)).toBe(false);
    expect(rows[1]).toBe('g:t:c1');
  });

  it('leaves the thinking between two calls in the thread, and sinks the calls', () => {
    const model = build();
    for (const event of stream(
      thought('m1', 0, 'where does this live'),
      ...call('c1', 'Grep'),
      thought('m1', 1, 'now the other file'),
      ...call('c2', 'Read'),
      thought('m1', 2, 'that explains it'),
    )) {
      model.apply(event);
    }
    model.flush();

    // The interleaving the marker used to swallow whole. Reasoning is what the
    // model was working out and reads in order with the prose around it; the
    // calls are the account of how, and collect underneath.
    //
    // One row for the three blocks, because the calls that separated them are
    // not on screen between them — they are in the marker below. Three folds
    // holding a sentence each was a column of chrome down the side of one train
    // of thought.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
    expect(model.getItem('k:m1:0')).toMatchObject({
      kind: 'thinking',
      text: 'where does this live\n\nnow the other file\n\nthat explains it',
    });

    const group = model.getGroup('g:t:c1');
    expect(group?.ids).toEqual(['t:c1', 't:c2']);
    expect(group?.counts).toEqual({ search: 1, read: 1 });
    expect(group?.running).toBe(0);
  });

  it('leaves thinking that did no work exactly where it happened', () => {
    /*
     * Reasoning before an answer, which is the commonest shape there is: the
     * model works out what to say and then says it, and read in that order it
     * is a conversation. Sinking it under the answer — which this briefly did,
     * back when reasoning and calls were one category — put the working-out
     * after the working-out's conclusion.
     */
    const model = build();
    for (const event of stream(
      thought('m1', 0, 'the user wants the short answer'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 1, text: 'no' },
    )) {
      model.apply(event);
    }

    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'a:m1:1']);
  });

  it('gives no row to a thinking block that arrives empty', () => {
    const model = build();
    for (const event of stream(
      thought('m1', 0, ''),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 1, text: 'no' },
    )) {
      model.apply(event);
    }

    // The fold would have said "thinking…" and opened onto nothing.
    expect(model.getRowsSnapshot()).toEqual(['a:m1:1']);
    expect(model.getItem('k:m1:0')).toBeUndefined();
  });

  it('keeps the redaction notice, which is not the same as empty', () => {
    const model = build();
    const [event] = stream({
      type: 'thinking.delta',
      messageId: 'm1',
      blockIndex: 0,
      text: '',
      redacted: true,
    });
    model.apply(event as AgentEvent);

    // Empty text, but it says something: the provider encrypted this one.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);
  });

  /*
   * The two kinds of row, interleaved every way a run interleaves them. The
   * Appearance switch no longer reaches this level at all — it decides whether
   * a reasoning row arrives expanded, not where it goes — so what these pin is
   * the rule itself: reasoning in place, calls at the foot, whatever order they
   * arrived in.
   */
  describe('reasoning against the work it happened between', () => {
    it('keeps both thoughts in the thread and folds the three calls beneath', () => {
      const model = build();
      for (const event of stream(
        thought('m1', 0, 'where does this live'),
        ...call('c1', 'Grep'),
        ...call('c2', 'Grep'),
        thought('m1', 1, 'now the other file'),
        ...call('c3', 'Read'),
      )) {
        model.apply(event);
      }

      // Both thoughts keep their place in order — in one row, since nothing was
      // said between them — and the three calls that used to be two markers
      // around them are one marker underneath.
      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
      expect(model.getGroup('g:t:c1')?.counts).toEqual({ search: 2, read: 1 });
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2', 't:c3']);
    });

    it('holds the thought that lands after the last call', () => {
      // The tail case: a run whose reasoning arrives *between* the work and the
      // answer. The marker is named for the first call, so a thought after it
      // does not move the marker's id — an expanded one must not collapse.
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        thought('m1', 0, 'now the other file'),
        ...call('c2', 'Read'),
        thought('m1', 1, 'that explains it'),
      )) {
        model.apply(event);
      }

      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
    });

    it('closes the marker when the model stops, and opens a fresh one for the next ask', () => {
      /*
       * The break. The model said its piece and is waiting, so the account of
       * how it got there is complete — and what is asked next is a new
       * question with a new account.
       */
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'found it' },
        { type: 'run.end', reason: 'completed' },
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'now fix it' },
        ...call('c2', 'Bash'),
        { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'done' },
      )) {
        model.apply(event);
      }

      const rows = model.getRowsSnapshot();
      // Two markers, one per turn, each under the answer it belongs to.
      expect(rows.filter((id) => id.startsWith('g:'))).toEqual(['g:t:c1', 'g:t:c2']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1']);
      expect(model.getGroup('g:t:c2')?.ids).toEqual(['t:c2']);
    });

    it('carries the accumulation across an interruption, because that is not a break', () => {
      /*
       * Stopping a run to redirect it is one request being steered, not two.
       * Splitting here would report the reader's impatience as a boundary in
       * what the agent did.
       */
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        { type: 'run.end', reason: 'interrupted' },
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'no, the other file' },
        ...call('c2', 'Read'),
        { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'got it' },
        { type: 'run.end', reason: 'completed' },
      )) {
        model.apply(event);
      }

      const rows = model.getRowsSnapshot();
      expect(rows.filter((id) => id.startsWith('g:'))).toEqual(['g:t:c1']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
      // The interruption itself is still on the record — it happened, and the
      // transcript is the record. It just is not a boundary.
      expect(rows.filter((id) => id.startsWith('e:'))).toHaveLength(2);
    });

    it('gives a run that only thought no marker at all', () => {
      // Nothing was done, so there is nothing to account for. A marker here
      // would be a fold over an empty list.
      const model = build();
      for (const event of stream(thought('m1', 0, 'hmm'))) model.apply(event);

      expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);
    });

    /*
     * A conversation read back off disk has no `run.end` anywhere in it.
     *
     * The provider's file records what was said, not what Artemis considered a
     * run — so `replayStoredSession` emits messages and calls and nothing else,
     * and the loop that folds machinery had no boundary to flush at until the
     * very end. Every call in the session collected into one marker under the
     * last message: the work of an hour parked below the conversation instead
     * of inside it, named for the first call of the *session* rather than the
     * first call of its run, which is also why `lib/foldMemory` could not match
     * a single key a live run had written.
     */
    it('reads a stored session back one marker per turn, not one per session', () => {
      const model = build();
      for (const event of stream(
        { type: 'text.complete', messageId: 'u1', role: 'user', text: 'find it', replay: true },
        ...call('c1', 'Grep'),
        { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'found it', replay: true },
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'now fix it', replay: true },
        ...call('c2', 'Bash'),
        { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'done', replay: true },
      )) {
        model.apply(event);
      }

      // The same shape the live run drew — compare the `run.end` case above,
      // which produces exactly these two ids from the same two bursts. That
      // equality is the point: it is what lets a marker the reader closed stay
      // closed when they come back to the conversation.
      const rows = model.getRowsSnapshot();
      expect(rows.filter((id) => id.startsWith('g:'))).toEqual(['g:t:c1', 'g:t:c2']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1']);
      expect(model.getGroup('g:t:c2')?.ids).toEqual(['t:c2']);
      // And each one sits under its own turn rather than at the foot of the
      // column: the first marker is above the second question, not below it.
      expect(rows.indexOf('g:t:c1')).toBeLessThan(rows.indexOf('u:2'));
    });

    it('does not treat a live steer as the end of a piece of work', () => {
      /*
       * The same row shape without the replay flag, which is what steering a
       * run mid-turn produces. It is the interruption case one level up: the
       * calls either side of it are one piece of work, and splitting them would
       * report the user's redirection as a boundary in what the agent did.
       */
      const model = build();
      for (const event of stream(
        ...call('c1', 'Grep'),
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'no, the other file' },
        ...call('c2', 'Read'),
      )) {
        model.apply(event);
      }

      expect(model.getRowsSnapshot().filter((id) => id.startsWith('g:'))).toEqual(['g:t:c1']);
      expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
    });
  });

  /*
   * One stretch of reasoning is one row.
   *
   * A turn emits `thinking / tool / thinking / tool …` and the calls sink to the
   * marker at the foot of the run — so the blocks end up adjacent on screen, and
   * a row apiece meant a dozen folds down the side of the pane holding a
   * sentence each. What separates two stretches is the agent *saying* something,
   * which is the only boundary a reader can see.
   */
  describe('a run of thinking blocks', () => {
    it('gathers into the row the first of them opened', () => {
      const model = build();
      for (const event of stream(
        thought('m1', 0, 'first, look'),
        ...call('c1', 'Grep'),
        thought('m2', 0, 'now the other file'),
      )) {
        model.apply(event);
      }
      model.flush();

      // Across messages, too: each turn of the tool loop is its own provider
      // message, so a stretch that survives two calls is three message ids.
      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
      expect(model.getItem('k:m1:0')).toMatchObject({
        text: 'first, look\n\nnow the other file',
      });
      expect(model.getItem('k:m2:0')).toBeUndefined();
    });

    it('is live again when the model goes back to thinking', () => {
      // A call between two blocks settles the first (`settleStreaming`). The
      // row is being written to again, so the pulse beside it has to come back
      // on — otherwise a turn that is still thinking looks finished.
      const model = build();
      for (const event of stream(thought('m1', 0, 'first, look'), ...call('c1', 'Grep'))) {
        model.apply(event);
      }
      model.flush();
      expect(model.getItem('k:m1:0')).toMatchObject({ streaming: false });

      model.apply(stream(thought('m2', 0, 'now the other file'))[0] as AgentEvent);
      model.flush();

      expect(model.getItem('k:m1:0')).toMatchObject({ streaming: true });
    });

    it('starts a fresh row once the agent has said something', () => {
      const model = build();
      for (const event of stream(
        thought('m1', 0, 'the user wants the short answer'),
        { type: 'text.complete', messageId: 'm1', role: 'assistant', blockIndex: 1, text: 'no' },
        thought('m2', 0, 'though they may want the why'),
      )) {
        model.apply(event);
      }
      model.flush();

      // The answer is the boundary. Merging across it would put reasoning the
      // model did *after* speaking into the paragraph it wrote before.
      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'a:m1:1', 'k:m2:0']);
    });

    it('never merges a redaction into prose, or prose into a redaction', () => {
      const model = build();
      for (const event of stream(
        thought('m1', 0, 'first, look'),
        { type: 'thinking.delta', messageId: 'm1', blockIndex: 1, text: '', redacted: true },
        thought('m1', 2, 'that explains it'),
      )) {
        model.apply(event);
      }
      model.flush();

      // "The provider withheld this one" is a notice about a block, so it can
      // neither be glued onto the end of prose it is not about nor swallow the
      // prose that follows it.
      expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'k:m1:1', 'k:m1:2']);
      expect(model.getItem('k:m1:0')).toMatchObject({ text: 'first, look' });
      expect(model.getItem('k:m1:2')).toMatchObject({ text: 'that explains it' });
    });

    it('keeps writing to the row a later delta of a merged block belongs to', () => {
      // The per-token path after a merge: the block has no row of its own, and
      // its second chunk still has to land at the end of the row it joined.
      const model = build();
      for (const event of stream(
        thought('m1', 0, 'first, look'),
        thought('m1', 1, 'then'),
        thought('m1', 1, ' the other file'),
      )) {
        model.apply(event);
      }
      model.flush();

      expect(model.getItem('k:m1:0')).toMatchObject({
        text: 'first, look\n\nthen the other file',
      });
    });
  });

  it('creates the block on the delta that first carries text', () => {
    const model = build();
    for (const event of stream(thought('m1', 0, ''), thought('m1', 0, 'here it is'))) {
      model.apply(event);
    }

    expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);
    expect(model.getItem('k:m1:0')).toMatchObject({ kind: 'thinking', text: 'here it is' });
  });

  it('gives an empty block no row of its own to stand in', () => {
    const model = build();
    for (const event of stream(
      thought('m1', 0, 'first, look'),
      ...call('c1', 'Grep'),
      thought('m1', 1, ''),
      ...call('c2', 'Read'),
    )) {
      model.apply(event);
    }

    // `k:m1:1` never became an item — a fold that says "thinking…" and opens
    // onto nothing is worse than no row.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
    expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1', 't:c2']);
  });

  it('leaves a lone thinking row alone when a call arrives after it', () => {
    const model = build();
    model.apply(stream(thought('m1', 0, 'let me look'))[0] as AgentEvent);
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0']);

    for (const event of stream(...call('c1', 'Read'))) model.apply(event);

    // The row the reader was already looking at keeps its id and its place. It
    // used to be swallowed into a marker at this moment, which moved text off
    // the screen as the agent worked.
    expect(model.getRowsSnapshot()).toEqual(['k:m1:0', 'g:t:c1']);
  });

  it('stays silent while a thinking block inside it streams', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'), thought('m1', 0, 'so far so good'))) {
      model.apply(event);
    }

    const groupId = model.getRowsSnapshot()[0] as string;
    const before = model.getGroup(groupId);
    const onGroup = vi.fn();
    model.subscribeGroup(groupId, onGroup);

    // The per-token path, now running through a member of the group. The
    // summary holds counters and no text, so nothing about it moved.
    model.apply(stream(thought('m1', 0, ' — keep going'))[0] as AgentEvent);

    expect(model.getGroup(groupId)).toBe(before);
    expect(onGroup).not.toHaveBeenCalled();
  });

  it('keeps a group id stable as the burst grows, so an open marker stays open', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'))) model.apply(event);
    const first = model.getRowsSnapshot()[0];

    for (const event of stream(...call('c2', 'Bash'), ...call('c3', 'Grep'))) model.apply(event);

    expect(model.getRowsSnapshot()).toEqual([first]);
    expect(model.getGroup(first as string)?.ids).toHaveLength(3);
  });

  it('reports work in flight, and a failure that must not stay hidden', () => {
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: {} },
      { type: 'tool.end', toolCallId: 'c1', status: 'error' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: {} },
    )) {
      model.apply(event);
    }
    const group = model.getGroup('g:t:c1');
    expect(group?.failed).toBe(1);
    expect(group?.running).toBe(1);
  });

  it('holds the snapshot identity steady while a sibling streams', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'))) model.apply(event);

    const groupId = model.getRowsSnapshot()[0] as string;
    const before = model.getGroup(groupId);
    const onGroup = vi.fn();
    model.subscribeGroup(groupId, onGroup);

    // Text arriving elsewhere is the per-token path: it must not touch the
    // group's identity and must not notify its subscriber.
    model.apply(
      stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'thinking out loud' })[0] as AgentEvent,
    );

    expect(model.getGroup(groupId)).toBe(before);
    expect(onGroup).not.toHaveBeenCalled();
  });

  it('notifies a group when one of its own calls finishes', () => {
    const model = build();
    model.apply(stream({ type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: {} })[0] as AgentEvent);

    const groupId = model.getRowsSnapshot()[0] as string;
    const before = model.getGroup(groupId);
    const onGroup = vi.fn();
    model.subscribeGroup(groupId, onGroup);

    model.apply({ type: 'tool.end', runId: RUN, seq: 1, ts: 2, toolCallId: 'c1', status: 'ok' });

    expect(onGroup).toHaveBeenCalledTimes(1);
    const after = model.getGroup(groupId);
    expect(after).not.toBe(before);
    expect(after?.running).toBe(0);
  });

  it('drops its groups on reset', () => {
    const model = build();
    for (const event of stream(...call('c1', 'Bash'))) model.apply(event);
    expect(model.getRowsSnapshot()).toHaveLength(1);

    model.reset();
    model.flush();

    expect(model.getRowsSnapshot()).toEqual([]);
    expect(model.getGroup('g:t:c1')).toBeUndefined();
  });
});

/*
 * Artifacts leave the fold — and the fold survives them leaving.
 *
 * The model is asked the question through an injected test, so these drive it
 * with a stand-in rather than the real `detectArtifact`: what is being pinned
 * here is the row arithmetic, and `artifact-tile.test.tsx` is where the real
 * predicate and the tile it produces are covered.
 */
describe('TranscriptModel artifacts', () => {
  function call(id: string, name: string, input: Record<string, unknown> = {}) {
    return [
      { type: 'tool.start', toolCallId: id, name, input },
      { type: 'tool.end', toolCallId: id, status: 'ok' },
    ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
  }

  function thought(messageId: string, blockIndex: number, text: string) {
    return { type: 'thinking.delta', messageId, blockIndex, text } as Omit<
      AgentEvent,
      'runId' | 'seq' | 'ts'
    >;
  }

  /** Every finished `Write` is an artifact. Enough to exercise the split. */
  function withArtifacts(): TranscriptModel {
    const model = build();
    model.setArtifactTest((item: ToolItem) => item.name === 'Write' && item.status === 'ok');
    return model;
  }

  it('lifts them out without breaking the burst in two', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Bash'),
      ...call('c2', 'Write', { file_path: '/tmp/report.html' }),
      ...call('c3', 'Bash'),
    )) {
      model.apply(event);
    }

    // The tile where it was made, and one marker for both commands at the
    // foot. Not marker/tile/marker.
    expect(model.getRowsSnapshot()).toEqual(['t:c2', 'g:t:c1']);
    const group = model.getGroup('g:t:c1');
    expect(group?.ids).toEqual(['t:c1', 't:c3']);
    // The lifted call is not a member, so the summary does not claim it too.
    expect(group?.counts).toEqual({ command: 2 });
  });

  it('keeps every artifact of a long burst, in order, where it was made', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Bash'),
      thought('m1', 0, 'now the html'),
      ...call('c2', 'Write', { file_path: '/tmp/a.html' }),
      thought('m1', 1, 'now the svg'),
      ...call('c3', 'Write', { file_path: '/tmp/b.svg' }),
      thought('m1', 2, 'now the md'),
      ...call('c4', 'Write', { file_path: '/tmp/c.md' }),
    )) {
      model.apply(event);
    }

    // The reasoning and the tiles read in the order the model produced them:
    // each thought, then the thing it made. A tile stands in the thread, so it
    // ends the stretch of reasoning the way an answer does — three rows here,
    // not one merged block with the three tiles parked under it. Only the
    // command sinks, to a marker at the foot.
    expect(model.getRowsSnapshot()).toEqual([
      'k:m1:0',
      't:c2',
      'k:m1:1',
      't:c3',
      'k:m1:2',
      't:c4',
      'g:t:c1',
    ]);
    expect(model.getItem('k:m1:1')).toMatchObject({ kind: 'thinking', text: 'now the svg' });
    expect(model.getGroup('g:t:c1')?.ids).toEqual(['t:c1']);
  });

  it('stands where it was made, so what the agent says next lands below it', () => {
    /*
     * The shape that was reported: a long turn writing document after document,
     * each announced in a sentence. The tiles used to collect at the foot of
     * the run, under the marker, so every new sentence arrived *above* the
     * growing stack — the reader was always scrolling back past the documents
     * to find the words about them.
     */
    const model = withArtifacts();
    for (const event of stream(
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'the report first' },
      ...call('c1', 'Write', { file_path: '/tmp/report.md' }),
      { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'now a chart' },
      ...call('c2', 'Bash'),
      ...call('c3', 'Write', { file_path: '/tmp/chart.svg' }),
      { type: 'text.complete', messageId: 'm3', role: 'assistant', text: 'both done' },
    )) {
      model.apply(event);
    }

    // Sentence, tile, sentence, tile, sentence — and the one command at the
    // foot, where the machinery goes.
    expect(model.getRowsSnapshot()).toEqual([
      'a:m1:0',
      't:c1',
      'a:m2:0',
      't:c3',
      'a:m3:0',
      'g:t:c2',
    ]);
  });

  it('does not move a tile when the calls around it keep coming', () => {
    // A live run: the marker at the foot grows with every command, and a tile
    // already on screen has to hold its place above it rather than sink with
    // the work that follows it.
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Write', { file_path: '/tmp/a.html' }),
      ...call('c2', 'Bash'),
    )) {
      model.apply(event);
    }
    expect(model.getRowsSnapshot()).toEqual(['t:c1', 'g:t:c2']);

    model.apply({ type: 'tool.start', runId: RUN, seq: 4, ts: 1004, toolCallId: 'c3', name: 'Bash', input: {} });
    model.flush();

    expect(model.getRowsSnapshot()).toEqual(['t:c1', 'g:t:c2']);
    expect(model.getGroup('g:t:c2')?.ids).toEqual(['t:c2', 't:c3']);
  });

  it('produces no marker when the burst was nothing but artifacts', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Write', { file_path: '/tmp/a.html' }),
      ...call('c2', 'Write', { file_path: '/tmp/b.html' }),
    )) {
      model.apply(event);
    }

    // Nothing is left hidden, so there is nothing to summarise.
    expect(model.getRowsSnapshot()).toEqual(['t:c1', 't:c2']);
  });

  it('surfaces the tile the moment the write finishes', () => {
    const model = withArtifacts();
    for (const event of stream(
      ...call('c1', 'Bash'),
      { type: 'tool.start', toolCallId: 'c2', name: 'Write', input: { file_path: '/tmp/a.html' } },
    )) {
      model.apply(event);
    }

    // Still running, so still ordinary work, so still folded.
    expect(model.getRowsSnapshot()).toEqual(['g:t:c1']);

    // Seq 3 continues the stream above — a gap would be a dropped event, and
    // the model would correctly add a notice row that has nothing to do with
    // what this is testing.
    model.apply({ type: 'tool.end', runId: RUN, seq: 3, ts: 1003, toolCallId: 'c2', status: 'ok' });
    model.flush();

    // `tool.end` is the verdict, and it has to restructure the rows to show it:
    // the call leaves the marker and stands where it happened, above it.
    expect(model.getRowsSnapshot()).toEqual(['t:c2', 'g:t:c1']);
  });

  /*
   * The list a surface reads to show every document of a conversation — the
   * same verdicts the rows are built from, kept as ids so nothing has to be
   * re-parsed to find them, and stable so a subscriber reading its length is
   * told about a document and not about a token.
   */
  describe('the artifacts snapshot', () => {
    it('lists the calls that made something, in the order they were made', () => {
      const model = withArtifacts();
      for (const event of stream(
        ...call('c1', 'Bash'),
        ...call('c2', 'Write', { file_path: '/tmp/a.html' }),
        { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'one down' },
        ...call('c3', 'Write', { file_path: '/tmp/b.md' }),
      )) {
        model.apply(event);
      }

      expect(model.getArtifactsSnapshot()).toEqual(['t:c2', 't:c3']);
    });

    it('is empty with no test installed, and empty again after a reset', () => {
      const bare = build();
      for (const event of stream(...call('c1', 'Write', { file_path: '/tmp/a.html' }))) {
        bare.apply(event);
      }
      expect(bare.getArtifactsSnapshot()).toEqual([]);

      const model = withArtifacts();
      for (const event of stream(...call('c1', 'Write', { file_path: '/tmp/a.html' }))) {
        model.apply(event);
      }
      expect(model.getArtifactsSnapshot()).toEqual(['t:c1']);
      model.reset();
      model.flush();
      expect(model.getArtifactsSnapshot()).toEqual([]);
    });

    it('keeps its identity until the set of artifacts moves', () => {
      const model = withArtifacts();
      for (const event of stream(...call('c1', 'Write', { file_path: '/tmp/a.html' }))) {
        model.apply(event);
      }
      const before = model.getArtifactsSnapshot();
      expect(before).toEqual(['t:c1']);

      // A token, a command starting and the command finishing: three flushes,
      // two of them structural, none of them a new document.
      model.apply({ type: 'text.delta', runId: RUN, seq: 2, ts: 1002, messageId: 'm1', blockIndex: 0, text: 'hi' });
      model.apply({ type: 'tool.start', runId: RUN, seq: 3, ts: 1003, toolCallId: 'c2', name: 'Bash', input: {} });
      model.apply({ type: 'tool.end', runId: RUN, seq: 4, ts: 1004, toolCallId: 'c2', status: 'ok' });
      model.flush();
      expect(model.getArtifactsSnapshot()).toBe(before);

      // A write that is still running is not yet a document.
      model.apply({ type: 'tool.start', runId: RUN, seq: 5, ts: 1005, toolCallId: 'c3', name: 'Write', input: { file_path: '/tmp/b.html' } });
      model.flush();
      expect(model.getArtifactsSnapshot()).toBe(before);

      // Its finishing is.
      model.apply({ type: 'tool.end', runId: RUN, seq: 6, ts: 1006, toolCallId: 'c3', status: 'ok' });
      model.flush();
      expect(model.getArtifactsSnapshot()).toEqual(['t:c1', 't:c3']);
    });

    it('drops what a rewind took with it', () => {
      const model = withArtifacts();
      for (const event of stream(
        ...call('c1', 'Write', { file_path: '/tmp/a.html' }),
        { type: 'text.complete', messageId: 'u2', role: 'user', text: 'again', replay: true },
        ...call('c2', 'Write', { file_path: '/tmp/b.html' }),
      )) {
        model.apply(event);
      }
      expect(model.getArtifactsSnapshot()).toEqual(['t:c1', 't:c2']);

      model.truncateFrom('u:1');
      model.flush();
      expect(model.getArtifactsSnapshot()).toEqual(['t:c1']);
    });
  });

  it('folds exactly as before when no test is installed', () => {
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      ...call('c2', 'Write', { file_path: '/tmp/report.html' }),
    )) {
      model.apply(event);
    }

    expect(model.getRowsSnapshot()).toEqual(['g:t:c1']);
  });
});

/*
 * The stall this suite exists to prevent.
 *
 * `markPending` latches on a single deferred flush, so whatever the scheduler
 * is must be *guaranteed* to run it. A window that stops producing frames —
 * occluded behind another Artemis window, minimised, on another Space — stops
 * running `requestAnimationFrame` callbacks, and a latch that is never cleared
 * silences the model permanently: every later event short-circuits, nothing is
 * notified, and the agent's work piles up invisibly until a reload dumps it in
 * one go. `startSessionFeed` already refuses to gate on visibility for exactly
 * this reason; the transcript has to hold the same line.
 */
describe('flush scheduling', () => {
  it('keeps notifying when animation frames stop arriving', () => {
    // Stands in for the timer half of the scheduler: the frame half never runs.
    const timers: Array<() => void> = [];
    const model = new TranscriptModel((flush) => timers.push(flush));

    const onList = vi.fn();
    model.subscribeList(onList);

    const [first, second] = stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'one' },
      { type: 'text.delta', messageId: 'm2', blockIndex: 0, text: 'two' },
    );

    model.apply(first as AgentEvent);
    expect(timers).toHaveLength(1);
    (timers.shift() as () => void)();
    expect(onList).toHaveBeenCalledTimes(1);

    // And the model is unlatched, so the next event schedules again rather than
    // being swallowed by a `pending` flag nothing will ever clear.
    model.apply(second as AgentEvent);
    expect(timers).toHaveLength(1);
    (timers.shift() as () => void)();
    expect(onList).toHaveBeenCalledTimes(2);
  });

  it('frameScheduler runs the flush even when no frame is ever produced', async () => {
    const realRaf = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    // A window that is not being composited: the callback is accepted and
    // dropped, which is what Chromium does for an occluded or minimised window.
    globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;

    try {
      const flush = vi.fn();
      frameScheduler(flush);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    }
  });

  it('flushes once when the frame arrives first, and does not flush twice', async () => {
    const flush = vi.fn();
    frameScheduler(flush);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe('rewind support', () => {
  it('keeps the provider id on a user message, replayed or echoed', () => {
    const model = build();
    for (const event of stream(
      { type: 'text.complete', messageId: 'uuid-1', role: 'user', text: 'stored', replay: true },
    )) {
      model.apply(event);
    }
    expect(model.getItem('u:1')).toMatchObject({ kind: 'user', messageId: 'uuid-1' });

    // The live path: an optimistic insert has no provider id — the echo is
    // where it learns one, and `rewindConversationTo` refuses a message that
    // never did.
    const pendingId = model.pushUserMessage('typed here');
    expect(model.getItem(pendingId)).toMatchObject({ kind: 'user', pending: true });
    model.apply({
      type: 'text.complete',
      messageId: 'uuid-2',
      role: 'user',
      text: 'typed here',
      runId: RUN,
      seq: 99,
      ts: 2000,
    } as AgentEvent);
    expect(model.getItem(pendingId)).toMatchObject({ pending: false, messageId: 'uuid-2' });
  });

  it('truncateFrom drops the item and everything after it, and nothing before', () => {
    const model = build();
    for (const event of stream(
      { type: 'text.complete', messageId: 'u1', role: 'user', text: 'first', replay: true },
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'answer one' },
      { type: 'text.complete', messageId: 'u2', role: 'user', text: 'second', replay: true },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: {} },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok' },
      { type: 'text.complete', messageId: 'm2', role: 'assistant', text: 'answer two' },
    )) {
      model.apply(event);
    }

    const before = model.getListSnapshot();
    const cut = before.find((id) => model.getItem(id)?.kind === 'user' && (model.getItem(id) as { text: string }).text === 'second') as string;
    model.truncateFrom(cut);

    const after = model.getListSnapshot();
    expect(after).toEqual(before.slice(0, before.indexOf(cut)));
    // The dropped tool call left the group index too — a marker summarising
    // items that no longer exist would be a fold over nothing.
    expect(model.getRowsSnapshot().filter((id) => id.startsWith('g:'))).toEqual([]);
    expect(model.getItem(cut)).toBeUndefined();
    expect(model.getItem('t:c1')).toBeUndefined();
  });
});

describe('user-row identity', () => {
  /** Every user row, reduced to what the eye checks. */
  function userRows(model: TranscriptModel): Array<{ text: string; pending: boolean }> {
    return model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .filter((item): item is NonNullable<typeof item> => item?.kind === 'user')
      .map((item) => ({
        text: (item as { text?: string }).text ?? '',
        pending: (item as { pending?: boolean }).pending === true,
      }));
  }

  it('merges a replayed prompt onto the optimistic row that claimed its id', () => {
    const model = build();
    const attachments = [
      { kind: 'image', mediaType: 'image/png', data: 'aGk=', name: 'shot.png' },
    ] as never;
    const id = model.pushUserMessage('hello?', attachments, 'run_1:prompt:1');
    model.confirmUserMessage(id);

    // The stall sweep re-applies the registry's retained copy — same identity,
    // borrowed seq, replay flag set. One row, and it keeps what only the
    // optimistic insert had.
    model.apply({
      type: 'text.complete',
      messageId: 'run_1:prompt:1',
      role: 'user',
      text: 'hello?',
      replay: true,
      runId: RUN,
      seq: 0,
      ts: 2000,
    } as AgentEvent);

    expect(userRows(model)).toEqual([{ text: 'hello?', pending: false }]);
    expect(model.getItem(id)).toMatchObject({ attachments, messageId: 'run_1:prompt:1' });
  });

  it('merges even while the row is still pending, and twice is once', () => {
    const model = build();
    model.pushUserMessage('hello?', undefined, 'run_1:prompt:1');

    const replayed = {
      type: 'text.complete',
      messageId: 'run_1:prompt:1',
      role: 'user',
      text: 'hello?',
      replay: true,
      runId: RUN,
      seq: 0,
      ts: 2000,
    } as AgentEvent;
    model.apply(replayed);
    model.apply(replayed);

    expect(userRows(model)).toEqual([{ text: 'hello?', pending: false }]);
  });

  it('re-claims a carried-over steer onto the new run it opens', () => {
    const model = build();
    // A steer pushed against a run that turned out to be over: its claim names
    // the old run, which never recorded the failed send.
    const id = model.pushUserMessage('carry me', undefined, 'run_old:prompt:2');
    model.claimUserMessage(id, 'run_new:prompt:1');

    model.apply({
      type: 'text.complete',
      messageId: 'run_new:prompt:1',
      role: 'user',
      text: 'carry me',
      replay: true,
      runId: RUN,
      seq: 0,
      ts: 2000,
    } as AgentEvent);
    // The old name must be gone: nothing will ever replay under it, and a
    // stale claim would catch the wrong message.
    model.apply({
      type: 'text.complete',
      messageId: 'run_old:prompt:2',
      role: 'user',
      text: 'someone else entirely',
      replay: true,
      runId: RUN,
      seq: 1,
      ts: 2001,
    } as AgentEvent);

    expect(userRows(model)).toEqual([
      { text: 'carry me', pending: false },
      { text: 'someone else entirely', pending: false },
    ]);
  });

  it('does not resurrect a claim across reset', () => {
    const model = build();
    model.pushUserMessage('before the reset', undefined, 'run_1:prompt:1');
    model.reset();

    model.apply({
      type: 'text.complete',
      messageId: 'run_1:prompt:1',
      role: 'user',
      text: 'before the reset',
      replay: true,
      runId: RUN,
      seq: 0,
      ts: 2000,
    } as AgentEvent);

    expect(userRows(model)).toEqual([{ text: 'before the reset', pending: false }]);
  });
});

/*
 * The gap check counts per run, not per pane.
 *
 * `seq` is dense per run, and the check exists to notice a transport that
 * dropped something. But a run whose `run.end` itself was dropped — the exact
 * loss being watched for — used to leave `lastSeq` holding the old run's
 * position, and the next run's dense-from-zero numbering read as "already
 * seen" until it climbed past it: every real gap in the newcomer's opening
 * events passed unremarked, in the one conversation that had already
 * demonstrated it drops things.
 */
describe('sequence gaps across runs', () => {
  const say = (runId: string, seq: number, text: string): AgentEvent =>
    ({
      type: 'text.complete',
      messageId: `${runId}-m${String(seq)}`,
      role: 'assistant',
      text,
      runId,
      seq,
      ts: 1,
    }) as AgentEvent;

  const noteRows = (model: TranscriptModel): readonly string[] =>
    model
      .getListSnapshot()
      .map((id) => model.getItem(id))
      .filter((item): item is NonNullable<typeof item> => item?.kind === 'notice')
      .map((item) => (item as { text?: string }).text ?? '');

  it('catches a gap in a new run even when the old run never delivered its end', () => {
    const model = build();
    model.apply(say('run_1', 0, 'one'));
    model.apply(say('run_1', 5, 'six'));
    expect(noteRows(model).filter((t) => t.includes('dropped in transit'))).toHaveLength(1);

    // run_1's end is never applied — the counter must not bleed into run_2.
    model.apply(say('run_2', 0, 'fresh start'));
    model.apply(say('run_2', 3, 'a real gap'));

    expect(noteRows(model).filter((t) => t.includes('dropped in transit'))).toHaveLength(2);
  });

  it('does not read a new run starting from zero as a gap or as the past', () => {
    const model = build();
    model.apply(say('run_1', 0, 'one'));
    model.apply(say('run_1', 1, 'two'));

    model.apply(say('run_2', 0, 'fresh start'));
    model.apply(say('run_2', 1, 'no gap here'));

    expect(noteRows(model)).toEqual([]);
  });
});

/**
 * A run that produced nothing says so.
 *
 * Reported as an agent that "spun for a second and insta-stopped": the turn
 * ended having said nothing, run nothing and thought nothing, and all the
 * transcript showed for it was a dim `52ms · 0 tok · $0`. That reads as the
 * agent shrugging, when what happened is that the provider had nothing to
 * send — worth naming, because the two are indistinguishable otherwise.
 */
describe('a silent run', () => {
  const ended = (model: TranscriptModel) => {
    const ids = model.getRowsSnapshot();
    return model.getItem(ids[ids.length - 1] as string);
  };

  it('is marked when the agent said, did and thought nothing', () => {
    const model = build();
    model.pushUserMessage('let me know when this is ready to install');
    for (const event of stream({ type: 'run.end', reason: 'completed', durationMs: 52 })) model.apply(event);

    expect(ended(model)).toMatchObject({ kind: 'run-end', silent: true });
  });

  it('is not marked when the agent spoke', () => {
    const model = build();
    for (const event of stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'On it.' }, { type: 'run.end', reason: 'completed' })) {
      model.apply(event);
    }

    expect(ended(model)).toMatchObject({ kind: 'run-end', silent: false });
  });

  it('is not marked when the agent only used a tool', () => {
    // Work without narration is still work: a turn that ran a command and
    // said nothing about it has not gone silent in the sense that matters.
    const model = build();
    for (const event of stream(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md' },
      { type: 'run.end', reason: 'completed' },
    )) {
      model.apply(event);
    }

    expect(ended(model)).toMatchObject({ kind: 'run-end', silent: false });
  });

  it('judges each run on its own, not on the one before it', () => {
    const model = build();
    for (const event of stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'On it.' }, { type: 'run.end', reason: 'completed' })) {
      model.apply(event);
    }
    // A second run, which produces nothing.
    model.apply({ type: 'run.end', reason: 'completed', runId: 'run_2', seq: 0, ts: 2000 } as AgentEvent);

    expect(ended(model)).toMatchObject({ kind: 'run-end', silent: true });
  });
});

/**
 * An offer is not machinery.
 *
 * A suggested task reaches the model as a tool call like any other, and every
 * other tool call in a run sinks into the marker at its foot. This one must
 * not: a question put to the reader, folded behind "Ran 36 commands", is a
 * question nobody answers. See `isSuggestedTaskCall`.
 */
describe('TranscriptModel suggested tasks', () => {
  const TASK = { title: 'Add tests', tldr: 'No coverage.', prompt: 'Write the tests.' };

  function call(id: string, name: string, input: Record<string, unknown> = {}) {
    return [
      { type: 'tool.start', toolCallId: id, name, input },
      { type: 'tool.end', toolCallId: id, status: 'ok' },
    ] as Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>;
  }

  it('stands where it was made while the work around it folds', () => {
    const model = build();
    for (const event of stream(
      ...call('c1', 'Bash'),
      { type: 'text.complete', messageId: 'm1', role: 'assistant', text: 'Done.' },
      ...call('c2', SUGGESTED_TASK_TOOL, TASK),
      ...call('c3', 'Bash'),
    )) {
      model.apply(event);
    }

    // The offer is its own row, directly under the answer it followed — which
    // is where the reader is looking when they finish reading. The two shell
    // calls are one marker, at the foot of the run, where the machinery goes.
    expect(model.getRowsSnapshot()).toEqual(['a:m1:0', 't:c2', 'g:t:c1']);
  });

  it('is not counted as a document', () => {
    // Nothing was made. The Documents surface lists things to open, and an
    // offer is not one of them.
    const model = build();
    model.setArtifactTest(() => true);
    for (const event of stream(...call('c1', SUGGESTED_TASK_TOOL, TASK))) model.apply(event);

    expect(model.getArtifactsSnapshot()).toEqual([]);
    expect(model.getRowsSnapshot()).toEqual(['t:c1']);
  });

  it('recognises the call from its name alone, malformed or not', () => {
    // A call the model got the arguments wrong on is still an offer it made,
    // and the row that draws it can say so. Folding it back into the marker
    // would hide the mistake in the one place nobody opens.
    const model = build();
    for (const event of stream(...call('c1', SUGGESTED_TASK_TOOL, { title: '' }))) {
      model.apply(event);
    }

    expect(isSuggestedTaskCall(model.getItem('t:c1'))).toBe(true);
    expect(model.getRowsSnapshot()).toEqual(['t:c1']);
  });

  it('says no to every other tool, including one merely named like it', () => {
    const model = build();
    for (const event of stream(...call('c1', 'suggest_task'), ...call('c2', 'Bash'))) {
      model.apply(event);
    }

    // The bare name is somebody else's MCP server. The prefixed one is ours,
    // and the prefix is the whole of the identity.
    expect(isSuggestedTaskCall(model.getItem('t:c1'))).toBe(false);
    expect(model.getRowsSnapshot()).toEqual(['g:t:c1']);
  });
});
