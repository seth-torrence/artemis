import { describe, expect, it } from 'vitest';

import { BOLD, BOLD_OFF, CYAN, DIM, FG_OFF, ITALIC, ITALIC_OFF, RESET } from './ansi.js';
import { renderMarkdown, renderMarkdownLines } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders emphasis and code spans, and leaves plain text alone', () => {
    expect(renderMarkdown('plain')).toBe('plain');
    expect(renderMarkdown('a **b** c')).toBe(`a ${BOLD}b${BOLD_OFF} c`);
    expect(renderMarkdown('a *b* c')).toBe(`a ${ITALIC}b${ITALIC_OFF} c`);
    expect(renderMarkdown('run `ls -la` now')).toBe(`run ${CYAN}ls -la${FG_OFF} now`);
  });

  it('does not look for emphasis inside code spans, and 2*3*4 is arithmetic', () => {
    expect(renderMarkdown('`**not bold**`')).toBe(`${CYAN}**not bold**${FG_OFF}`);
    expect(renderMarkdown('2*3*4')).toBe('2*3*4');
    expect(renderMarkdown('snake_case_name')).toBe('snake_case_name');
  });

  it('sets fenced code off with a gutter and never styles its contents', () => {
    const out = renderMarkdown('```ts\nconst **x** = 1;\n```\nafter');
    expect(out.split('\n')).toEqual([
      `${DIM}│ ts${RESET}`,
      `${DIM}│${RESET} const **x** = 1;`,
      'after',
    ]);
  });

  it('survives an unclosed fence mid-stream', () => {
    expect(renderMarkdown('```\nhalf').split('\n')).toEqual([
      `${DIM}│${RESET}`,
      `${DIM}│${RESET} half`,
    ]);
  });

  it('normalises bullets and keeps ordered numbers', () => {
    expect(renderMarkdown('- one\n* two\n  - nested\n3. three')).toBe(
      [
        `${DIM}•${RESET} one`,
        `${DIM}•${RESET} two`,
        `  ${DIM}•${RESET} nested`,
        `${DIM}3.${RESET} three`,
      ].join('\n'),
    );
  });

  it('bolds headings and dims quotes and rules', () => {
    expect(renderMarkdown('## Title')).toBe(`${BOLD}Title${BOLD_OFF}`);
    expect(renderMarkdown('> said')).toBe(`${DIM}▎ said${RESET}`);
    expect(renderMarkdown('---')).toBe(`${DIM}${'─'.repeat(24)}${RESET}`);
  });

  it('leaves an unmatched marker alone', () => {
    expect(renderMarkdown('a **b')).toBe('a **b');
  });

  it('keeps what hangs in the margin apart from the text, with its width', () => {
    expect(renderMarkdownLines('- one\n  2. two\n> q\nplain')).toEqual([
      { prefix: `${DIM}•${RESET} `, hang: 2, body: 'one' },
      { prefix: `  ${DIM}2.${RESET} `, hang: 5, body: 'two' },
      { prefix: `${DIM}▎ `, hang: 2, body: `q${RESET}` },
      { prefix: '', hang: 0, body: 'plain' },
    ]);
  });
});
