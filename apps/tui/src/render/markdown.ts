/**
 * Markdown, for a terminal.
 *
 * The assistant writes markdown; a terminal draws characters. This is the
 * smallest translation that reads well: headings bold, emphasis as the
 * terminal's own bold and italic, code in a colour, fenced blocks set off with
 * a gutter, bullets normalised to one glyph, links as text with the address
 * dimmed beside it. It is not a markdown parser and does not try to be one —
 * tables come through as their source, nested structures keep their
 * indentation and nothing more.
 *
 * Why hand-rolled: the desktop's `Markdown.tsx` is `react-markdown` over a DOM,
 * and the terminal libraries that render markdown pull in a highlighter and a
 * parser to do what forty lines of regex do adequately for a transcript.
 *
 * Streaming is the constraint that shapes the code. Text arrives a token at a
 * time and is re-rendered whole on every frame, so this must be cheap, must
 * never throw on a half-written construct — an unclosed fence, a `**` with no
 * partner — and must produce output that does not jump around as the closing
 * marker arrives. Line-based processing with inline rules that leave an
 * unmatched marker alone gives all three.
 */

import {
  BOLD,
  BOLD_OFF,
  CYAN,
  DIM,
  FG_OFF,
  ITALIC,
  ITALIC_OFF,
  RESET,
  UNDERLINE,
  UNDERLINE_OFF,
} from './ansi.js';

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Inline emphasis. Code spans are split out first and the rest never looks
 * inside them — a `**` inside backticks is a literal.
 */
function inline(text: string): string {
  const parts = text.split(/(`+[^`]*`+)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const code = part.replace(/^`+|`+$/g, '');
        return `${CYAN}${code}${FG_OFF}`;
      }
      return part
        .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/__(.+?)__/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
        .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `${UNDERLINE}$1${UNDERLINE_OFF} ${DIM}$2${RESET}`);
    })
    .join('');
}

/**
 * One rendered line: what hangs in the margin — a bullet, a number, a quote
 * bar, a fence gutter — and the text beside it. A terminal wraps a long line
 * back to column zero, under the bullet; a renderer that keeps the two apart
 * can wrap the text under itself instead, which is what makes a list read as
 * a list. `hang` is the prefix's visible width, so the caller need not
 * measure through the escape codes.
 */
export interface MarkdownLine {
  readonly prefix: string;
  readonly hang: number;
  readonly body: string;
}

const line = (body: string, prefix = '', hang = 0): MarkdownLine => ({ prefix, hang, body });

/** The rendered markdown as one string, lines joined. */
export function renderMarkdown(source: string): string {
  return renderMarkdownLines(source)
    .map((entry) => entry.prefix + entry.body)
    .join('\n');
}

export function renderMarkdownLines(source: string): readonly MarkdownLine[] {
  const out: MarkdownLine[] = [];
  let fence: string | null = null;

  for (const raw of source.split('\n')) {
    const text = raw.replace(/\r$/, '');

    if (fence !== null) {
      if (FENCE.test(text) && text.trim().startsWith(fence)) {
        fence = null;
        continue;
      }
      out.push(line(text, `${DIM}│${RESET} `, 2));
      continue;
    }

    const open = FENCE.exec(text);
    if (open !== null) {
      fence = open[1] ?? '```';
      const lang = open[2] ?? '';
      out.push(line(`${DIM}│${lang.length > 0 ? ` ${lang}` : ''}${RESET}`));
      continue;
    }

    if (RULE.test(text)) {
      out.push(line(`${DIM}${'─'.repeat(24)}${RESET}`));
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading !== null) {
      const inner = inline(heading[2] ?? '');
      out.push(
        line(
          (heading[1]?.length ?? 2) === 1
            ? `${BOLD}${UNDERLINE}${inner}${UNDERLINE_OFF}${BOLD_OFF}`
            : `${BOLD}${inner}${BOLD_OFF}`,
        ),
      );
      continue;
    }

    const bullet = BULLET.exec(text);
    if (bullet !== null) {
      const indent = bullet[1] ?? '';
      out.push(line(inline(bullet[2] ?? ''), `${indent}${DIM}•${RESET} `, indent.length + 2));
      continue;
    }

    const ordered = ORDERED.exec(text);
    if (ordered !== null) {
      const indent = ordered[1] ?? '';
      const number = `${ordered[2] ?? ''}.`;
      out.push(line(inline(ordered[3] ?? ''), `${indent}${DIM}${number}${RESET} `, indent.length + number.length + 1));
      continue;
    }

    const quote = QUOTE.exec(text);
    if (quote !== null) {
      out.push(line(`${inline(quote[1] ?? '')}${RESET}`, `${DIM}▎ `, 2));
      continue;
    }

    out.push(line(inline(text)));
  }

  return out;
}
