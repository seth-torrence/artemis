/**
 * The seam where the prompt library meets a run.
 *
 * `withSystemPromptAppended` is small, and it is the last thing standing
 * between a library the user has curated and the model actually being told
 * about it — so its three branches are worth stating as tests rather than
 * leaving to a reading of the function.
 *
 * The composition it is handed is tested in `protocol/agentPrompts.test.ts`;
 * what is here is only what happens to a `RunInput` afterwards.
 */

import { describe, expect, it } from 'vitest';

import type { RunInput } from '@rx-artemis/protocol';

import { builtInsFor, mergeAdditionalDirectories, rememberModels, withSystemPromptAppended } from './engine.js';

const RUN: RunInput = {
  providerId: 'claude',
  profileId: 'work',
  cwd: '/repo',
  prompt: 'do the thing',
};

describe('withSystemPromptAppended', () => {
  it('leaves the run untouched when the library says nothing', () => {
    // Absent rather than an empty `append`: an omitted `systemPrompt` is what
    // lets the provider's preset through, and an append carrying nothing would
    // still cost a prompt-cache round to say it.
    expect(withSystemPromptAppended(RUN, undefined)).toBe(RUN);
    expect(withSystemPromptAppended(RUN, '')).toBe(RUN);
  });

  it('appends to the provider preset on an ordinary run', () => {
    expect(withSystemPromptAppended(RUN, 'Run the typechecker.').systemPrompt).toEqual({
      kind: 'append',
      text: 'Run the typechecker.',
    });
  });

  it('treats an explicit default the same as an absent one', () => {
    const asked: RunInput = { ...RUN, systemPrompt: { kind: 'default' } };
    expect(withSystemPromptAppended(asked, 'Library.').systemPrompt).toEqual({
      kind: 'append',
      text: 'Library.',
    });
  });

  it("keeps a caller's own append, and puts it first", () => {
    // Both were asked for, so neither is dropped — and the caller's is the more
    // specific request, so it is the one the model reads first.
    const asked: RunInput = { ...RUN, systemPrompt: { kind: 'append', text: 'Caller.' } };
    expect(withSystemPromptAppended(asked, 'Library.').systemPrompt).toEqual({
      kind: 'append',
      text: 'Caller.\n\nLibrary.',
    });
  });

  it('refuses to fold the library into a replaced prompt', () => {
    // `replace` means the provider's preset should not be there. The library's
    // prompts are written to sit after a preset that has already described the
    // tools, so appending here would quietly change what they are added to.
    const asked: RunInput = { ...RUN, systemPrompt: { kind: 'replace', text: 'Only this.' } };
    expect(withSystemPromptAppended(asked, 'Library.')).toBe(asked);
  });

  it('does not mutate the input it was given', () => {
    const asked: RunInput = { ...RUN };
    withSystemPromptAppended(asked, 'Library.');
    expect(asked.systemPrompt).toBeUndefined();
  });
});

/**
 * The other per-run transform: folding the enabled memory banks into the
 * directories a run may reach. The engine's gating and the `banksForRun` read
 * are I/O; what is pure and worth pinning is the merge itself — that it never
 * drops the user's own folders, never doubles a bank, and leaves a machine with
 * the switch off exactly as it was.
 */
describe('mergeAdditionalDirectories', () => {
  const BANKS = ['/home/me/Documents/cortex', '/home/me/Documents/team'];

  it('does nothing when the master switch is off — reference returned untouched', () => {
    // A machine that has not opted in starts exactly the run it always did,
    // undefined included.
    expect(mergeAdditionalDirectories(undefined, BANKS, false)).toBeUndefined();
    const own = ['/work/extra'];
    expect(mergeAdditionalDirectories(own, BANKS, false)).toBe(own);
  });

  it('does nothing when there are no banks to add', () => {
    const own = ['/work/extra'];
    expect(mergeAdditionalDirectories(own, [], true)).toBe(own);
    expect(mergeAdditionalDirectories(undefined, [], true)).toBeUndefined();
  });

  it('attaches the banks when the switch is on and the run brought none', () => {
    expect(mergeAdditionalDirectories(undefined, BANKS, true)).toEqual(BANKS);
  });

  it("keeps the user's own directories first, then the banks", () => {
    expect(mergeAdditionalDirectories(['/work/extra'], BANKS, true)).toEqual([
      '/work/extra',
      ...BANKS,
    ]);
  });

  it('is idempotent: a resumed run already carrying its banks is handed back unchanged', () => {
    const already = ['/work/extra', ...BANKS];
    expect(mergeAdditionalDirectories(already, BANKS, true)).toBe(already);
  });

  it('dedupes a path present on both sides without disturbing order', () => {
    const own = ['/home/me/Documents/cortex', '/work/extra'];
    expect(mergeAdditionalDirectories(own, BANKS, true)).toEqual([
      '/home/me/Documents/cortex',
      '/work/extra',
      '/home/me/Documents/team',
    ]);
  });
});

/**
 * The third pure transform, and the one with a fact about the world behind it:
 * a provider's catalogue is not stable while a model is rolling out. Two asks a
 * minute apart, same binary and same account, disagreed about whether
 * `claude-fable-5-1` existed (observed 2026-09-01). The picker must not be a
 * coin flip, and above all a model already on screen must not vanish because an
 * incidental refetch landed on the other answer.
 */
describe('rememberModels', () => {
  const model = (id: string) => ({ id, label: id });
  const FABLE_5 = model('claude-fable-5[1m]');
  const FABLE_5_1 = model('claude-fable-5-1[1m]');
  const SONNET = model('sonnet');

  it('takes the fresh list whole when nothing has been seen before', () => {
    const fresh = [FABLE_5_1, SONNET];
    // Reference-identical: a first answer is the answer, not a merge with an
    // empty set.
    expect(rememberModels(undefined, fresh)).toBe(fresh);
    expect(rememberModels([], fresh)).toBe(fresh);
  });

  it('hands back the fresh list untouched when it already holds everything', () => {
    const fresh = [FABLE_5_1, SONNET];
    expect(rememberModels([SONNET], fresh)).toBe(fresh);
  });

  it('carries a model this answer forgot, so the rollout cannot take it away', () => {
    // The failure this exists to prevent: 5.1 was on screen, an unrelated
    // refetch got the other backend, and the row disappeared.
    expect(rememberModels([FABLE_5_1, SONNET], [FABLE_5, SONNET])).toEqual([
      FABLE_5,
      SONNET,
      FABLE_5_1,
    ]);
  });

  it("keeps the provider's own order for what it just said", () => {
    // The fresh list leads, in the order it arrived: that is the provider's
    // opinion about what to show first, and a carried model is the exception
    // rather than a peer.
    expect(rememberModels([SONNET], [FABLE_5_1, FABLE_5]).slice(0, 2)).toEqual([
      FABLE_5_1,
      FABLE_5,
    ]);
  });

  it('merges a model that came back rather than listing it twice', () => {
    expect(rememberModels([FABLE_5_1], [FABLE_5_1, SONNET])).toEqual([FABLE_5_1, SONNET]);
  });
});

describe('builtInsFor', () => {
  const every = new Set<'builtin:cerebro'>(['builtin:cerebro']);

  it('keeps the memory-bank prompt for a provider that runs here', () => {
    expect(builtInsFor('claude', every)).toBe(every);
    expect(builtInsFor('llamacpp', every)).toBe(every);
  });

  it('keeps it home for a run an Artemis server executes elsewhere', () => {
    // The prompt names this machine's banks and this machine's CLI path; the
    // server describes its own. The user's prompts are not built-ins and are
    // unaffected by this set.
    expect(builtInsFor('artemis', every).has('builtin:cerebro')).toBe(false);
    expect(builtInsFor('artemis', new Set())).toEqual(new Set());
  });
});
