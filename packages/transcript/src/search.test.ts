/**
 * Finding a word in a conversation.
 *
 * The point of searching the model rather than the page is that a transcript
 * hides most of itself: reasoning is a fold, and a burst of tool calls is one
 * marker. These pin that — a phrase inside a folded tool call is found, and the
 * row handed back is the marker a reader can actually be taken to.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';

import { TranscriptModel, syncScheduler } from './transcript.js';
import { SEARCH_LIMIT, searchTranscript, searchableText } from './search.js';

const RUN = 'run_1';

function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: RUN, seq: index, ts: 1000 + index })) as AgentEvent[];
}

/** A conversation: a question, an answer, and a burst of machinery between. */
function conversation(): TranscriptModel {
  const model = new TranscriptModel(syncScheduler);
  model.confirmUserMessage(model.pushUserMessage('where does the pelican live?'));
  for (const event of stream(
    { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'The pelican is in the config.' },
    { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'grep -r pelican src' } },
    { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'src/birds.ts: pelican' },
    { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { path: 'src/birds.ts' } },
    { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: 'nothing to see' },
    { type: 'text.complete', messageId: 'm2', role: 'assistant', blockIndex: 0, text: 'The Pelican lives in src/birds.ts.' },
  )) {
    model.apply(event);
  }
  model.flush();
  return model;
}

describe('searchTranscript', () => {
  it('finds every occurrence, in the order it was said', () => {
    const { matches, capped } = searchTranscript(conversation(), 'pelican');
    expect(capped).toBe(false);
    // The question, the reasoning, the command, its output, and the answer.
    expect(matches).toHaveLength(5);
    expect(matches.map((match) => match.length)).toEqual([7, 7, 7, 7, 7]);
  });

  it('takes the reader to the marker a folded call is behind', () => {
    const model = conversation();
    const { matches } = searchTranscript(model, 'grep -r');
    expect(matches).toHaveLength(1);
    const [only] = matches;
    // The item is the tool call; the row is the burst it disappeared into, and
    // is a row the transcript actually draws.
    expect(only?.itemId).toBe('t:c1');
    expect(only?.rowId.startsWith('g:')).toBe(true);
    expect(model.getRowsSnapshot()).toContain(only?.rowId);
  });

  it('ignores case, and matches a phrase rather than a pattern', () => {
    const model = conversation();
    expect(searchTranscript(model, 'PELICAN').matches).toHaveLength(5);
    expect(searchTranscript(model, 'peli.can').matches).toHaveLength(0);
    expect(searchTranscript(model, 'lives in src').matches).toHaveLength(1);
  });

  it('counts repeats inside one row separately', () => {
    const model = new TranscriptModel(syncScheduler);
    model.confirmUserMessage(model.pushUserMessage('bird bird bird'));
    const { matches } = searchTranscript(model, 'bird');
    expect(matches.map((match) => match.at)).toEqual([0, 5, 10]);
  });

  it('matches nothing for a query that is only whitespace', () => {
    const model = conversation();
    expect(searchTranscript(model, '').matches).toEqual([]);
    expect(searchTranscript(model, '   ').matches).toEqual([]);
  });

  it('stops at the cap and says it stopped', () => {
    const model = new TranscriptModel(syncScheduler);
    model.confirmUserMessage(model.pushUserMessage('a '.repeat(SEARCH_LIMIT + 20)));
    const { matches, capped } = searchTranscript(model, 'a');
    expect(matches).toHaveLength(SEARCH_LIMIT);
    expect(capped).toBe(true);
  });
});

describe('searchableText', () => {
  it('reads a tool call as its arguments and its result', () => {
    const model = conversation();
    const call = model.getItem('t:c1');
    expect(call).toBeDefined();
    const text = searchableText(call!);
    expect(text).toContain('Bash');
    expect(text).toContain('grep -r pelican src');
    expect(text).toContain('src/birds.ts: pelican');
  });

  it('reads a notice as its text and its detail', () => {
    const model = new TranscriptModel(syncScheduler);
    const id = model.note('warn', 'the bank is read-only', 'nothing was written');
    expect(searchableText(model.getItem(id)!)).toBe('the bank is read-only\nnothing was written');
  });
});
