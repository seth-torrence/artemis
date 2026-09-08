/**
 * Putting the CLI's queued-command records back among the messages.
 *
 * The SDK's stored-session read returns user and assistant records only, so
 * the adapter reads the `queued_command` attachment records off the
 * transcript file and merges them by time — the one ordering both kinds of
 * record carry. These pin the merge: order, the page edges, and a record
 * with no time, which cannot be placed and is left out.
 */

import { describe, expect, it } from 'vitest';

import { mergeQueuedCommands, type StoredMessage } from '../history.js';

const at = (seconds: number): string => new Date(1_700_000_000_000 + seconds * 1_000).toISOString();

function user(text: string, seconds: number, uuid = `u-${String(seconds)}`): StoredMessage {
  return { type: 'user', uuid, timestamp: at(seconds), message: { role: 'user', content: text } };
}

function queued(text: string, seconds: number | undefined, uuid = `q-${String(seconds)}`): StoredMessage {
  return {
    type: 'attachment',
    uuid,
    ...(seconds === undefined ? {} : { timestamp: at(seconds) }),
    attachment: { type: 'queued_command', prompt: text },
  };
}

const texts = (rows: readonly StoredMessage[]): string[] =>
  rows.map((row) =>
    row.type === 'attachment'
      ? `q:${String((row.attachment as { prompt: string }).prompt)}`
      : String((row.message as { content: string }).content),
  );

describe('mergeQueuedCommands', () => {
  it('slots each record in after the last message before it', () => {
    const merged = mergeQueuedCommands(
      [user('one', 10), user('two', 20), user('three', 30)],
      [queued('after two', 25), queued('after one', 15)],
      { first: true, last: true },
    );
    expect(texts(merged)).toEqual(['one', 'q:after one', 'two', 'q:after two', 'three']);
  });

  it('keeps records past the edges only on the page that owns them', () => {
    const page = [user('two', 20), user('three', 30)];
    const records = [queued('before', 5), queued('within', 25), queued('after', 35)];

    // A middle page: neither edge is its own.
    expect(texts(mergeQueuedCommands(page, records, { first: false, last: false }))).toEqual([
      'two',
      'q:within',
      'three',
    ]);
    // The first page keeps what came before its first message…
    expect(texts(mergeQueuedCommands(page, records, { first: true, last: false }))).toEqual([
      'q:before',
      'two',
      'q:within',
      'three',
    ]);
    // …and the last keeps what came after its last.
    expect(texts(mergeQueuedCommands(page, records, { first: false, last: true }))).toEqual([
      'two',
      'q:within',
      'three',
      'q:after',
    ]);
  });

  it('leaves out a record with no time, which has nowhere to go', () => {
    expect(texts(mergeQueuedCommands([user('one', 10)], [queued('lost', undefined)], { first: true, last: true }))).toEqual([
      'one',
    ]);
  });

  it('is the page itself when there is nothing to merge', () => {
    const page = [user('one', 10)];
    expect(mergeQueuedCommands(page, [], { first: true, last: true })).toBe(page);
  });
});
