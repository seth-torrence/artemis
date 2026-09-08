/**
 * Replaying stored sessions.
 *
 * The bug these lock down: clicking a session in the sidebar resumed it
 * against an empty transcript. The agent had the whole conversation in
 * context; the user could see none of it.
 */

import { describe, expect, it } from 'vitest';
import type { RunId, SessionId } from '@rx-artemis/protocol';
import { replayStoredMessage, replayStoredSession, type StoredMessage } from '../history.js';

const TS = 1_700_000_000_000;

function ctx() {
  let seq = 0;
  return {
    runId: 'run_1' as RunId,
    sessionId: 'sesn_1' as SessionId,
    ts: TS,
    next: () => seq++,
  };
}

function assistant(content: unknown, uuid = 'msg_1'): StoredMessage {
  return { type: 'assistant', uuid, message: { role: 'assistant', content } };
}

/**
 * Timestamps.
 *
 * The bug: every replayed event was stamped with the read time, on the belief
 * that stored records carried no wall-clock time. They do — the SDK returns
 * `timestamp` on every user and assistant record — so a reopened conversation
 * showed the moment of the reload on every single line.
 */
describe('replayed timestamps', () => {
  const RECORDED = Date.parse('2026-08-20T09:15:00.000Z');

  it('carries the message`s own recorded time, not the read time', () => {
    const [event] = replayStoredMessage(
      {
        type: 'assistant',
        uuid: 'msg_1',
        timestamp: '2026-08-20T09:15:00.000Z',
        message: { id: 'msg_01', content: [{ type: 'text', text: 'hi' }] },
      },
      ctx(),
    );

    expect(event?.ts).toBe(RECORDED);
    expect(event?.ts).not.toBe(TS);
  });

  it('gives every block of one message the same time', () => {
    // One record, one recorded moment: the live stream's block-by-block
    // arrival is not in the transcript and must not be invented.
    const events = replayStoredMessage(
      {
        type: 'assistant',
        uuid: 'msg_1',
        timestamp: '2026-08-20T09:15:00.000Z',
        message: {
          id: 'msg_01',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      },
      ctx(),
    );

    expect(events.length).toBeGreaterThan(1);
    expect(new Set(events.map((event) => event.ts))).toEqual(new Set([RECORDED]));
  });

  it('keeps distinct messages at their distinct times', () => {
    const events = replayStoredSession(
      [
        { type: 'user', uuid: 'u1', timestamp: '2026-08-20T09:15:00.000Z', message: { role: 'user', content: 'hi' } },
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-08-20T09:16:30.000Z',
          message: { id: 'msg_01', content: [{ type: 'text', text: 'hello' }] },
        },
      ],
      ctx(),
    );

    const stamps = [...new Set(events.map((event) => event.ts))];
    expect(stamps).toEqual([RECORDED, Date.parse('2026-08-20T09:16:30.000Z')]);
  });

  it('accepts epoch milliseconds as well as an ISO string', () => {
    const [event] = replayStoredMessage(
      { type: 'assistant', uuid: 'm', timestamp: RECORDED, message: { id: 'm1', content: [{ type: 'text', text: 'x' }] } },
      ctx(),
    );
    expect(event?.ts).toBe(RECORDED);
  });

  it('falls back to the read time for a record with no usable timestamp', () => {
    // Absent, unparseable, and NaN-producing all take the fallback: a `NaN`
    // reaching the envelope renders as "Invalid Date", which is worse than the
    // read time it replaced.
    for (const timestamp of [undefined, '', 'last Tuesday', Number.NaN, {}]) {
      const [event] = replayStoredMessage(
        {
          type: 'assistant',
          uuid: 'm',
          ...(timestamp === undefined ? {} : { timestamp }),
          message: { id: 'm1', content: [{ type: 'text', text: 'x' }] },
        },
        ctx(),
      );
      expect(event?.ts).toBe(TS);
    }
  });
});

describe('replayStoredMessage', () => {
  it('keys replayed blocks on the provider message id, not the envelope uuid', () => {
    // The live mapper keys blocks on `message.id`. If replay keyed on the
    // envelope `uuid` instead, a turn that was both replayed and live could
    // never merge — the transcript would show it twice.
    const [event] = replayStoredMessage(
      { type: 'assistant', uuid: 'envelope-uuid', message: { id: 'msg_01', content: [{ type: 'text', text: 'hi' }] } },
      ctx(),
    );

    expect(event).toMatchObject({ messageId: 'msg_01' });
  });

  it('falls back to the envelope uuid when a record carries no message id', () => {
    const [event] = replayStoredMessage(
      { type: 'assistant', uuid: 'envelope-uuid', message: { content: [{ type: 'text', text: 'hi' }] } },
      ctx(),
    );

    expect(event).toMatchObject({ messageId: 'envelope-uuid' });
  });

  it('replays assistant text as a completed block, flagged as replay', () => {
    const [event] = replayStoredMessage(assistant([{ type: 'text', text: 'hello' }]), ctx());

    expect(event).toMatchObject({
      type: 'text.complete',
      role: 'assistant',
      text: 'hello',
      // The protocol models this explicitly so the UI need not infer it.
      replay: true,
    });
  });

  it('accepts a bare string as shorthand for one text block', () => {
    // User messages are commonly stored as `content: "..."` rather than blocks.
    const events = replayStoredMessage(
      { type: 'user', uuid: 'm', message: { role: 'user', content: 'do the thing' } },
      ctx(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text.complete', role: 'user', text: 'do the thing' });
  });

  it('drops a stored task notification instead of attributing it to the user', () => {
    // The harness writes background-task notifications into a user slot,
    // marked only by an `origin` the SDK's stored-session read strips before
    // this module sees the record. Replayed as a user row, the whole
    // `<task-notification>…` frame appeared in the transcript as though the
    // person had typed it — one per settled task.
    const events = replayStoredMessage(
      {
        type: 'user',
        uuid: 'm',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>a12e2a10</task-id>\n<status>completed</status>\n<summary>Agent "Audit scripts" finished</summary>\n</task-notification>',
        },
      },
      ctx(),
    );

    expect(events).toEqual([]);
  });

  it('replays a message sent mid-turn from the attachment the CLI filed it as', () => {
    // The CLI never files a mid-turn message as a user turn. It feeds the
    // words to the model as a `queued_command` attachment at the next tool
    // boundary and writes that record — so a replay that read only `user`
    // records showed a reply discussing a message that was nowhere above it,
    // on every reopen. The row goes back where the CLI read it.
    const events = replayStoredMessage(
      {
        type: 'attachment',
        uuid: 'att-1',
        timestamp: '2026-09-07T11:02:49.848Z',
        attachment: {
          type: 'queued_command',
          prompt: 'also, add find in page',
          source_uuid: '08197866-c398-41f7-911a-748a289355bf',
          commandMode: 'prompt',
          timestamp: '2026-09-07T11:02:49.848Z',
        },
      },
      ctx(),
    );

    expect(events).toEqual([
      {
        runId: 'run_1',
        seq: 0,
        ts: Date.parse('2026-09-07T11:02:49.848Z'),
        type: 'text.complete',
        messageId: 'att-1',
        role: 'user',
        text: 'also, add find in page',
        blockIndex: 0,
        replay: true,
      },
    ]);
  });

  it('ignores every other kind of attachment', () => {
    // A file the model was shown, an editor selection: the CLI files those
    // the same way, and none of them is a person's sentence.
    for (const attachment of [
      { type: 'file', filename: 'notes.md', content: 'hello' },
      { type: 'selected_lines_in_ide', filename: 'a.ts', content: 'x' },
      { type: 'queued_command' },
      'not even an object',
    ]) {
      expect(replayStoredMessage({ type: 'attachment', uuid: 'att', attachment }, ctx())).toEqual([]);
    }
  });

  it('drops the interrupt markers the CLI records when a turn is stopped', () => {
    const c = ctx();
    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      expect(
        replayStoredMessage(
          { type: 'user', uuid: 'm', message: { role: 'user', content: [{ type: 'text', text }] } },
          c,
        ),
      ).toEqual([]);
    }
  });

  it('keeps assistant text that merely quotes the notification frame', () => {
    // The shape check is scoped to user slots: the model *talking about* a
    // task notification is ordinary assistant text and must replay.
    const [event] = replayStoredMessage(
      assistant([{ type: 'text', text: '<task-notification> is the frame the harness uses.' }]),
      ctx(),
    );

    expect(event).toMatchObject({ type: 'text.complete', role: 'assistant' });
  });

  it('replays a stored thinking block', () => {
    const [event] = replayStoredMessage(
      assistant([{ type: 'thinking', thinking: 'weighing the options', signature: 'sig' }]),
      ctx(),
    );

    expect(event).toMatchObject({ type: 'thinking.delta', text: 'weighing the options' });
  });

  it('skips a thinking block the provider stored without its text', () => {
    // Roughly half the `thinking` blocks in a real stored transcript are an
    // empty string beside a full signature — the provider kept the block and
    // withheld its content. Replaying those filled the transcript with folds
    // that opened onto nothing.
    const events = replayStoredMessage(
      assistant([
        { type: 'thinking', thinking: '', signature: 'a'.repeat(3232) },
        { type: 'text', text: 'the answer' },
      ]),
      ctx(),
    );

    expect(events.some((e) => e.type === 'thinking.delta')).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text.complete', text: 'the answer' });
  });

  it('replays a tool call and its result as a matched pair', () => {
    const events = replayStoredSession(
      [
        assistant([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/a.ts' } }]),
        { type: 'user', uuid: 'm2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
      ],
      ctx(),
    );

    expect(events[0]).toMatchObject({ type: 'tool.start', toolCallId: 'tu_1', name: 'Read' });
    expect(events[1]).toMatchObject({ type: 'tool.end', toolCallId: 'tu_1', status: 'ok' });
  });

  it('maps a failed tool result to error status', () => {
    const [event] = replayStoredMessage(
      { type: 'user', uuid: 'm', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true }] } },
      ctx(),
    );

    expect(event).toMatchObject({ status: 'error' });
  });

  it('drops system messages, which were never shown live', () => {
    // Compact boundaries and provider notices. Surfacing them on replay would
    // add noise that was not in the original conversation.
    expect(
      replayStoredMessage({ type: 'system', uuid: 'm', message: { content: 'compacted' } }, ctx()),
    ).toEqual([]);
  });

  it('skips blocks it does not understand instead of failing the replay', () => {
    // A transcript written by a newer provider must still render its
    // recognisable parts. One unknown block must not blank the whole session.
    const events = replayStoredMessage(
      assistant([
        { type: 'text', text: 'before' },
        { type: 'some_future_block', payload: {} },
        { type: 'text', text: 'after' },
      ]),
      ctx(),
    );

    expect(events.map((e) => (e as { text: string }).text)).toEqual(['before', 'after']);
  });

  it('survives malformed messages without throwing', () => {
    const c = ctx();
    expect(replayStoredMessage({ type: 'assistant', uuid: 'm', message: null }, c)).toEqual([]);
    expect(replayStoredMessage({ type: 'assistant', uuid: 'm', message: {} }, c)).toEqual([]);
    expect(
      replayStoredMessage({ type: 'assistant', uuid: 'm', message: { content: 'x' } }, c),
    ).toHaveLength(1);
  });

  it('drops blocks missing the ids the UI needs to pair them', () => {
    // A tool_use with no id can never be matched to its result, so rendering
    // it would leave a call that never completes.
    const c = ctx();
    expect(replayStoredMessage(assistant([{ type: 'tool_use', name: 'Read' }]), c)).toEqual([]);
    expect(replayStoredMessage(assistant([{ type: 'tool_result', content: 'x' }]), c)).toEqual([]);
  });
});

describe('replayStoredSession', () => {
  it('preserves the provider ordering and issues a strictly increasing seq', () => {
    // Re-sorting a transcript would interleave tool calls with the wrong
    // results; the sequence is what the transcript renders in.
    const events = replayStoredSession(
      [assistant([{ type: 'text', text: 'one' }], 'a'), assistant([{ type: 'text', text: 'two' }], 'b')],
      ctx(),
    );

    expect(events.map((e) => (e as { text: string }).text)).toEqual(['one', 'two']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('groups blocks from one stored message under one messageId', () => {
    const events = replayStoredSession(
      [assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'shared')],
      ctx(),
    );

    expect(events.every((e) => (e as { messageId: string }).messageId === 'shared')).toBe(true);
    expect(events.map((e) => (e as { blockIndex: number }).blockIndex)).toEqual([0, 1]);
  });
});

import { resolveRewindPoint } from '../history.js';

/** A stored user prompt — text the person typed, no tool results. */
function prompt(text: string, uuid: string): StoredMessage {
  return { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** A stored tool result, which also travels in a user envelope. */
function toolResult(uuid: string): StoredMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  };
}

describe('resolveRewindPoint', () => {
  const CHAIN: readonly StoredMessage[] = [
    prompt('find it', 'u1'),
    assistant([{ type: 'text', text: 'found it' }], 'a1'),
    prompt('now fix it', 'u2'),
    toolResult('r1'),
    assistant([{ type: 'text', text: 'done' }], 'a2'),
  ];

  it('re-enters the chain at the entry before the prompt', () => {
    expect(resolveRewindPoint(CHAIN, 'u2')).toEqual({
      resumeSessionAt: 'a1',
      // The dropped range is one turn — u2, its tool result, its answer — so
      // the drops-turn acknowledgement can vouch for it.
      dropsTurn: 'u2',
    });
  });

  it('omits the drops-turn acknowledgement when the range spans turns', () => {
    // Winding back past u1 drops u2's whole turn too, and the provider's
    // acknowledgement names a single prompt. The point still resolves; the
    // provider's own guard decides whether the deeper truncation is allowed.
    expect(resolveRewindPoint(CHAIN, 'u1')).toBeNull();

    const longer = [prompt('zeroth', 'u0'), assistant([{ type: 'text', text: 'ok' }], 'a0'), ...CHAIN];
    expect(resolveRewindPoint(longer, 'u1')).toEqual({ resumeSessionAt: 'a0' });
  });

  it('answers null for a uuid the chain does not hold, and for the first entry', () => {
    // Both mean the rewind cannot happen: no anchor to re-enter at. The very
    // first prompt has nothing before it — rewinding past it is "start a new
    // session", which is a different button.
    expect(resolveRewindPoint(CHAIN, 'unknown')).toBeNull();
    expect(resolveRewindPoint(CHAIN, 'u1')).toBeNull();
  });

  it('does not mistake a tool result for a turn boundary', () => {
    // r1 rides a user envelope but nobody asked it — if it counted as a
    // prompt, rewinding to u2 would drop "two turns" and lose the
    // acknowledgement it is entitled to.
    const point = resolveRewindPoint(CHAIN, 'u2');
    expect(point?.dropsTurn).toBe('u2');
  });
});
