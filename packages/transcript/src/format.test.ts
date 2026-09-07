/**
 * Title condensation.
 *
 * The one function in `format.ts` with a rule rather than a formula. Most
 * session titles are not titles at all — an adapter falls back to the opening
 * prompt when the provider has not written a summary — so this is what stands
 * between the sidebar and a column of half-sentences clipped mid-word at
 * whatever pixel the column happens to end on.
 */

import { describe, expect, it } from 'vitest';

import { condenseTitle } from './format.js';

describe('condenseTitle', () => {
  it('leaves a real title alone', () => {
    expect(condenseTitle('Wire the adapter seam')).toBe('Wire the adapter seam');
  });

  it('clips a prompt to whole words', () => {
    const prompt =
      'Can you take a look at the failing permission test and work out why it only fails in CI?';
    const result = condenseTitle(prompt);

    expect(result.endsWith('…')).toBe(true);
    // Whole words: nothing before the ellipsis is a fragment of one.
    expect(prompt.startsWith(result.slice(0, -1))).toBe(true);
    expect(result.slice(0, -1).trimEnd()).toBe(result.slice(0, -1));
  });

  it('gives every row the same budget', () => {
    // The property that matters. Two prompts opening identically used to clip
    // at different points, which made a list of them unreadable.
    const a = condenseTitle('Can you take a look at the failing test in the runner package');
    const b = condenseTitle('Can you take a look at the failing test in the protocol package');
    expect(a).toBe(b);
  });

  it('collapses newlines and runs of space, since a title is one line', () => {
    expect(condenseTitle('  Fix   the\n\nresume bug  ')).toBe('Fix the resume bug');
  });

  it('clips on length as well as word count', () => {
    const long = 'supercalifragilistic expialidocious antidisestablishmentarianism floccinaucinihilipilification';
    const result = condenseTitle(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith('…')).toBe(true);
  });

  it('never returns nothing for a single enormous word', () => {
    // The first word always goes in, or a title made of one long token would
    // render as a bare ellipsis.
    const result = condenseTitle('a'.repeat(200));
    expect(result).toBe('a'.repeat(200));
  });

  it('passes an empty title straight through', () => {
    expect(condenseTitle('')).toBe('');
    expect(condenseTitle('   ')).toBe('');
  });
});
