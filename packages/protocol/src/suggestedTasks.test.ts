/**
 * What a suggested task is allowed to be.
 *
 * Two of the three things here are read from *model output* — a tool call's
 * arguments — and one of them becomes a branch and a directory name. So the
 * assertions are mostly about refusal and reduction rather than about the happy
 * path: a chip with no words on it, a prompt that is a novel, and a title that
 * would escape the directory it is supposed to name.
 */

import { describe, expect, it } from 'vitest';

import {
  isSuggestedTaskTarget,
  parseSuggestedTask,
  SUGGESTED_TASK_LIMITS,
  SUGGESTED_TASK_SERVER,
  SUGGESTED_TASK_TOOL,
  suggestedTaskBranch,
} from './suggestedTasks.js';

describe('the tool name', () => {
  it('is addressed the way the SDK addresses an MCP tool', () => {
    // The whole persistence story rests on this string: it is what a stored
    // transcript carries, and what a reader of one matches on years later.
    expect(SUGGESTED_TASK_TOOL).toBe(`mcp__${SUGGESTED_TASK_SERVER}__suggest_task`);
  });
});

describe('parsing a call', () => {
  it('reads a well-formed suggestion', () => {
    expect(
      parseSuggestedTask({
        title: 'Add tests for the parser',
        tldr: 'The new branch in parseHeader has no coverage.',
        prompt: 'Write unit tests for parseHeader in src/parse.ts.',
      }),
    ).toEqual({
      title: 'Add tests for the parser',
      tldr: 'The new branch in parseHeader has no coverage.',
      prompt: 'Write unit tests for parseHeader in src/parse.ts.',
    });
  });

  it('trims, because a title with a trailing newline is a title', () => {
    expect(parseSuggestedTask({ title: '  Tidy up \n', prompt: ' do it ' })?.title).toBe('Tidy up');
  });

  it('accepts a suggestion with no summary', () => {
    // A missing `tldr` is a suggestion that explains itself badly, not one that
    // cannot be drawn — the title and the prompt are the two loadbearing fields.
    expect(parseSuggestedTask({ title: 'Tidy up', prompt: 'Tidy up the imports.' })).toEqual({
      title: 'Tidy up',
      tldr: '',
      prompt: 'Tidy up the imports.',
    });
  });

  it.each([
    ['no title', { prompt: 'do the thing' }],
    ['a blank title', { title: '   ', prompt: 'do the thing' }],
    ['no prompt', { title: 'Do the thing' }],
    ['a blank prompt', { title: 'Do the thing', prompt: '' }],
    ['a non-string title', { title: 12, prompt: 'do the thing' }],
    ['nothing at all', {}],
  ])('refuses a call with %s', (_why, input) => {
    expect(parseSuggestedTask(input as never)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'add tests'],
    ['an array', [{ title: 'a', prompt: 'b' }]],
    ['null', null],
  ])('refuses %s, which is not a call at all', (_why, input) => {
    expect(parseSuggestedTask(input as never)).toBeNull();
  });

  it('truncates rather than refusing an over-long field', () => {
    // The agent got the work right and the length wrong. Throwing the
    // suggestion away over a verbose summary would be the wrong trade.
    const parsed = parseSuggestedTask({
      title: 'x'.repeat(SUGGESTED_TASK_LIMITS.title + 50),
      prompt: 'do it',
    });
    expect(parsed?.title).toHaveLength(SUGGESTED_TASK_LIMITS.title);
    expect(parsed?.title.endsWith('…')).toBe(true);
  });

  it('caps the prompt, which is the field that becomes a message', () => {
    const parsed = parseSuggestedTask({
      title: 'Big',
      prompt: 'p'.repeat(SUGGESTED_TASK_LIMITS.prompt + 1000),
    });
    expect(parsed?.prompt).toHaveLength(SUGGESTED_TASK_LIMITS.prompt);
  });
});

describe('naming the branch', () => {
  it('slugs the title under a prefix', () => {
    expect(suggestedTaskBranch('Add tests for the parser')).toBe('task/add-tests-for-the-parser');
  });

  it.each([
    ['../../etc/passwd', 'task/etc-passwd'],
    ['C:\\Windows\\system32', 'task/c-windows-system32'],
    ['feat: do —- the thing!!', 'task/feat-do-the-thing'],
    ['  leading and trailing  ', 'task/leading-and-trailing'],
  ])('reduces %j to a name that is only a name', (title, expected) => {
    // The branch becomes a directory under the checkout and a ref in `.git`.
    // Everything that could make it mean somewhere else is gone by here — and
    // `main/validate.ts` checks the same shape again on the way through IPC,
    // because this function is not the only thing that can reach that channel.
    expect(suggestedTaskBranch(title)).toBe(expected);
  });

  it('never ends on a dash, even when the cut lands mid-word', () => {
    const branch = suggestedTaskBranch(`${'word '.repeat(20)}tail`);
    expect(branch.endsWith('-')).toBe(false);
  });

  it('falls back to the prefix when nothing survives', () => {
    // A title in a script this cannot transliterate is not a bug, and the
    // worktree still has to be creatable.
    expect(suggestedTaskBranch('日本語のタイトル')).toBe('task');
  });
});

describe('the target guard', () => {
  it('accepts the four and nothing else', () => {
    expect(isSuggestedTaskTarget('worktree')).toBe(true);
    expect(isSuggestedTaskTarget('here')).toBe(true);
    // What a preference written by a build that spelled them differently would
    // look like on the way back in.
    expect(isSuggestedTaskTarget('cloud')).toBe(false);
    expect(isSuggestedTaskTarget(undefined)).toBe(false);
  });
});
