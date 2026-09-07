/**
 * The file-edit diff.
 *
 * Pure logic with no DOM, so it is tested directly rather than through the
 * component. Three properties matter and each has a way of silently going
 * wrong:
 *
 *  1. **Detection is by argument shape, not tool name.** If it ever starts
 *     keying on `"Edit"`, the next provider's editor tool renders as a JSON
 *     dump and nobody notices until someone tries it.
 *  2. **The diff is correct and minimal.** A diff that shows more changed lines
 *     than actually changed trains the reader to skim it, which defeats the
 *     point of showing it before an agent writes to disk.
 *  3. **It is bounded.** This runs inside a transcript row while a run streams.
 */

import { describe, expect, it } from 'vitest';
import { detectFileEdit, type DiffRow } from './diff.js';

/** Just the changed lines, as `+`/`−` prefixed text. */
function changes(rows: readonly DiffRow[]): string[] {
  return rows
    .filter((r) => r.kind === 'add' || r.kind === 'del')
    .map((r) => `${r.kind === 'add' ? '+' : '-'}${r.text}`);
}

describe('detection', () => {
  it('recognises an edit from its before/after pair', () => {
    const edit = detectFileEdit('Edit', {
      file_path: '/w/src/a.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(edit).not.toBeNull();
    expect(edit?.path).toBe('/w/src/a.ts');
    expect(edit?.extension).toBe('ts');
  });

  /**
   * The property that keeps this provider-neutral. `apply_patch` with
   * `before`/`after` is not a tool Artemis ships today; it is the shape a
   * different CLI would plausibly use, and it must work without a code change.
   */
  it('recognises an unfamiliar tool that uses a known argument shape', () => {
    const edit = detectFileEdit('apply_patch', {
      path: 'src/main.rs',
      before: 'fn main() {}',
      after: 'fn main() { run(); }',
    });
    expect(edit).not.toBeNull();
    expect(edit?.extension).toBe('rs');
  });

  it('treats whole content on a writing tool as an all-new file', () => {
    const edit = detectFileEdit('Write', { file_path: '/w/new.md', content: 'a\nb\nc' });
    expect(edit?.whole).toBe(true);
    expect(edit?.added).toBe(3);
    expect(edit?.removed).toBe(0);
  });

  it('does not treat a read as an edit just because it carries content', () => {
    expect(detectFileEdit('Read', { file_path: '/w/a.ts', content: 'whatever' })).toBeNull();
  });

  it('ignores a tool call with no path', () => {
    expect(detectFileEdit('Edit', { old_string: 'a', new_string: 'b' })).toBeNull();
  });

  it('ignores an "edit" whose halves are identical', () => {
    // Rendering an all-context diff would claim a change happened. Falling back
    // to the raw view says less, but says nothing false.
    expect(
      detectFileEdit('Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'x' }),
    ).toBeNull();
  });

  it('ignores everything that is not an edit at all', () => {
    expect(detectFileEdit('Bash', { command: 'ls -la' })).toBeNull();
  });
});

describe('the diff itself', () => {
  it('marks only the lines that changed', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'one\ntwo\nthree\nfour',
      new_string: 'one\nTWO\nthree\nfour',
    });
    expect(changes(edit?.rows ?? [])).toEqual(['-two', '+TWO']);
    expect(edit?.added).toBe(1);
    expect(edit?.removed).toBe(1);
  });

  it('keeps line numbers aligned across an insertion', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'a\nc',
      new_string: 'a\nb\nc',
    });
    const rows = edit?.rows ?? [];
    const inserted = rows.find((r) => r.kind === 'add');
    expect(inserted?.text).toBe('b');
    expect(inserted?.newNo).toBe(2);
    // An inserted line has no counterpart in the original, so no old number.
    expect(inserted?.oldNo).toBeUndefined();
    // …and the line after it has shifted by one on the new side only.
    const tail = rows.filter((r) => r.kind === 'ctx').at(-1);
    expect(tail).toMatchObject({ text: 'c', oldNo: 2, newNo: 3 });
  });

  it('picks out the characters that changed within a modified line', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.ts',
      old_string: 'export const timeout = 1000;',
      new_string: 'export const timeout = 5000;',
    });
    const add = edit?.rows.find((r) => r.kind === 'add');
    expect(add?.spans).toBeDefined();
    const [start, end] = add?.spans?.[0] ?? [0, 0];
    // Exactly the digit that moved, not the whole line.
    expect(add?.text.slice(start, end)).toBe('5');
  });

  it('does not span-highlight a line that shares nothing with its counterpart', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'aaaa',
      new_string: 'zzzz',
    });
    // Highlighting the whole line adds nothing over the row's own colour.
    expect(edit?.rows.find((r) => r.kind === 'add')?.spans).toEqual([]);
  });

  it('collapses long runs of unchanged lines into a gap', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: `${body}\nlast`,
      new_string: `${body}\nLAST`,
    });
    const rows = edit?.rows ?? [];
    expect(rows.some((r) => r.kind === 'gap')).toBe(true);
    // A 61-line file with a one-line change must not render 61 rows.
    expect(rows.length).toBeLessThan(12);
  });
});

describe('bounds', () => {
  it('stays cheap on a large file with a small change', () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n');
    const started = Date.now();
    const edit = detectFileEdit('Edit', {
      file_path: 'big.txt',
      old_string: `${big}\ntail`,
      new_string: `${big}\nTAIL`,
    });
    // The affix stripping is what makes this linear; without it the LCS table
    // would be 25 million cells and this would be seconds, inside a row that
    // re-renders while a run streams.
    expect(Date.now() - started).toBeLessThan(500);
    expect(changes(edit?.rows ?? [])).toEqual(['-tail', '+TAIL']);
  });

  it('caps the rendered rows and says so', () => {
    const oldText = Array.from({ length: 4_000 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 4_000 }, (_, i) => `new ${i}`).join('\n');
    const edit = detectFileEdit('Edit', {
      file_path: 'huge.txt',
      old_string: oldText,
      new_string: newText,
    });
    expect(edit?.truncated).toBe(true);
    expect(edit?.rows.length).toBeLessThanOrEqual(600);
  });

  it('refuses to diff a payload past the line ceiling, without throwing', () => {
    const huge = Array.from({ length: 21_000 }, (_, i) => `l${i}`).join('\n');
    const edit = detectFileEdit('Write', { file_path: 'huge.log', content: huge });
    expect(edit?.truncated).toBe(true);
    expect(edit?.rows.length).toBeLessThan(100);
  });
});
