/**
 * The fold: a run's calls read as one count, what is still running or went
 * wrong stays out in full, and the count sits where the first call was made
 * rather than after the answer the calls produced.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AgentEvent } from '@rx-artemis/protocol';

import { ReplayRows } from './Transcript.js';

/** Envelope filler; timestamps rise with position, which is what the order rests on. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('the transcript fold', () => {
  it('counts what finished, shows what is running and what failed, in the order things began', async () => {
    const events = stream(
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Looking around.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: 'README.md' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: '# Artemis' },
      { type: 'tool.start', toolCallId: 'c3', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'tool.end', toolCallId: 'c3', status: 'error', error: { message: 'exit code 1' } },
      { type: 'tool.start', toolCallId: 'c4', name: 'Bash', input: { command: 'sleep 100' } },
      { type: 'text.delta', messageId: 'm2', blockIndex: 0, text: 'Still going.' },
    );
    const { lastFrame } = render(<ReplayRows events={events} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Ran a command, read a file');
    expect(frame).toContain('Bash(pnpm test)');
    expect(frame).toContain('Error: exit code 1');
    expect(frame).toContain('Bash(sleep 100)');
    // Folded away: a finished call is a number, not a row.
    expect(frame).not.toContain('Bash(ls)');
    expect(frame).not.toContain('README.md');

    const at = (text: string): number => frame.indexOf(text);
    expect(at('Looking around.')).toBeLessThan(at('Ran a command'));
    expect(at('Ran a command')).toBeLessThan(at('Bash(sleep 100)'));
    expect(at('Bash(sleep 100)')).toBeLessThan(at('Still going.'));
  });
});

/**
 * Four voices, four faces.
 *
 * Reported as: "messages from me, messages from the agent, thinking — it's
 * all too similar looking." Two of them were literally the same glyph, and
 * the person's own words were the dimmest thing on the screen.
 */
describe('who is speaking', () => {
  it('gives the person, the agent, its tools and its thinking a mark each', async () => {
    const events = stream(
      { type: 'thinking.delta', messageId: 'm0', blockIndex: 0, text: 'Weighing it up.' },
      { type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'Looking around.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'sleep 100' } },
    );
    const { lastFrame } = render(<ReplayRows events={events} />);
    await tick();
    const frame = lastFrame() ?? '';

    const markerOf = (text: string): string | undefined =>
      frame.split('\n').find((line) => line.includes(text))?.trimStart().slice(0, 1);

    // The agent speaking and the agent running a command shared one mark, so at
    // a glance they were the same row. Speech is what someone reads for, so
    // speech kept the mark and the machinery took a new one.
    // `●`, not `⏺`: U+23FA has an emoji presentation in many terminal fonts —
    // a rounded square with a hollow circle, drawn two cells wide while the
    // layout allots one — so the mark ran into the text with no gap. U+25CF
    // is a plain circle and one cell everywhere.
    expect(markerOf('Looking around.')).toBe('●');
    expect(markerOf('Bash(sleep 100)')).toBe('◆');
    expect(markerOf('Weighing it up.')).toBe('∴');
  });

  it('draws what the person said as the brightest row, not the faintest', async () => {
    // It was `>` with the text dimmed. Their own words are the landmarks in a
    // long transcript; they must not be the hardest thing on it to find.
    const events = stream({ type: 'text.complete', messageId: 'u1', role: 'user', text: 'Count to three.' });
    const { lastFrame } = render(<ReplayRows events={events} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Count to three.');
    const line = frame.split('\n').find((candidate) => candidate.includes('Count to three.')) ?? '';
    expect(line.trimStart().startsWith('▌')).toBe(true);
  });
});

/**
 * Thinking is shown whole.
 *
 * Reported as: "thinking blocks tend to cut themselves off after a certain
 * length, I need to see all of the thinking." They were passed through
 * `oneLine(text, 200)`, which both flattened the paragraphs and cut the tail
 * — and unlike the desktop, which folds a long block open on demand, a
 * terminal row had no way to ask for the rest.
 */
describe('thinking', () => {
  it('does not cut a long block off', async () => {
    const tail = 'PLANNEDCONCLUSION';
    const long = `First I need to weigh the options. ${'Considering the trade-offs at length. '.repeat(12)}${tail}`;
    expect(long.length).toBeGreaterThan(400);

    const { lastFrame } = render(<ReplayRows events={stream({ type: 'thinking.delta', messageId: 'm0', blockIndex: 0, text: long })} />);
    await tick();
    const frame = lastFrame() ?? '';

    // The end of the thought is on screen, and nothing was elided.
    expect(frame).toContain(tail);
    expect(frame).not.toContain('…');
  });

  it('keeps the paragraphs it was written in', async () => {
    const text = 'One idea.\n\nA second, separate idea.';
    const { lastFrame } = render(<ReplayRows events={stream({ type: 'thinking.delta', messageId: 'm0', blockIndex: 0, text })} />);
    await tick();
    const lines = (lastFrame() ?? '').split('\n').map((line) => line.trim());

    // Flattened to one line, two thoughts read as one run-on sentence.
    expect(lines.some((line) => line.endsWith('One idea.'))).toBe(true);
    expect(lines.some((line) => line.includes('A second, separate idea.'))).toBe(true);
  });
});

/**
 * A turn that produced nothing says so.
 *
 * Reported as the agent "spinning for a second and insta-stopping": all the
 * transcript showed was a dim duration, which reads as a shrug rather than as
 * the provider having had nothing to send.
 */
describe('a silent run', () => {
  it('names it, rather than showing a bare duration', async () => {
    const { lastFrame } = render(<ReplayRows events={stream({ type: 'run.end', reason: 'completed', durationMs: 52 })} />);
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toMatch(/no reply/i);
    expect(frame).toContain('52ms');
  });

  it('leaves an ordinary finished turn alone', async () => {
    const { lastFrame } = render(
      <ReplayRows
        events={stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'On it.' }, { type: 'run.end', reason: 'completed', durationMs: 900 })}
      />,
    );
    await tick();

    expect(lastFrame() ?? '').not.toMatch(/no reply/i);
  });
});
