/**
 * Where Vite injects, and the second mention that can steal the spot.
 * ============================================================================
 *
 * Vite does not parse these documents before injecting into them. It runs four
 * regular expressions over the raw text — one per injection point — and takes
 * the first match, so anything in the file that *looks* like an opening head
 * tag is a candidate: in a comment, in prose, inside backticks, inside a
 * string in the boot script, anywhere at all.
 *
 * That has bitten this repo once, and the shape of the failure is why it is
 * worth a test of its own. `index.html`'s opening comment explained the theme
 * fallback and named the tag the boot script sits in. The head-prepend regex
 * matched that mention, thirteen lines above the real element, so
 * `/@vite/client` and `@vitejs/plugin-react`'s Fast Refresh preamble were both
 * injected *inside the comment* and never ran. Every component module then
 * threw "@vitejs/plugin-react can't detect preamble" and `pnpm dev` came up as
 * a blank window — while packaged builds stayed perfectly fine, because a
 * build injects its stylesheet and script tags before the *closing* tag, which
 * no comment happened to contain. A first-time contributor met a dead app; the
 * release they could download worked.
 *
 * So the invariant is counted rather than located: each of the four things
 * Vite looks for occurs **exactly once** in the document. One occurrence is
 * necessarily the element itself, which makes "the first match is the real
 * element" true by arithmetic — and it holds against every way a lookalike can
 * be written, without this test having to enumerate them. A second occurrence
 * is the bug, wherever it sits and however it is quoted.
 *
 * Vite's four regexes are transcribed here because a build tool's internals
 * are not importable. If a future Vite changes them this goes stale rather
 * than wrong: the document still has one of each, and the comment in
 * `index.html` still says why that matters.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RENDERER = new URL('../', import.meta.url);

/** Every HTML document Vite is pointed at: the app, and the design gallery. */
const documents = readdirSync(fileURLToPath(RENDERER))
  .filter((entry) => entry.endsWith('.html'))
  .map((entry) => ({
    name: entry,
    html: readFileSync(fileURLToPath(new URL(entry, RENDERER)), 'utf8'),
  }));

/**
 * Vite's injection points, transcribed from `vite/src/node/plugins/html.ts`
 * and made global so they can be counted rather than located.
 *
 * `carries` is what a second occurrence steals, and it is the only reason the
 * failure is hard to read: the dev-only point takes the whole app down in
 * development and nothing in a release, and the build-only point does the
 * reverse.
 */
const INJECTION_POINTS = [
  {
    point: 'head-prepend',
    re: /([ \t]*)<head[^>]*>/gi,
    carries: "the dev server's client and the Fast Refresh preamble",
  },
  { point: 'head', re: /([ \t]*)<\/head>/gi, carries: "a build's stylesheet and script tags" },
  {
    point: 'body-prepend',
    re: /([ \t]*)<body[^>]*>/gi,
    carries: 'tags a plugin asks to have injected',
  },
  { point: 'body', re: /([ \t]*)<\/body>/gi, carries: 'tags a plugin asks to have injected' },
] as const;

const COMMENT_RE = /<!--[\s\S]*?-->/g;

const isInsideComment = (html: string, offset: number): boolean =>
  [...html.matchAll(COMMENT_RE)].some(
    (comment) => offset > comment.index && offset < comment.index + comment[0].length,
  );

/** Every occurrence as `line 6: … (in a comment)`, which is the whole diagnosis. */
const locate = (html: string, matches: RegExpExecArray[]): string =>
  matches
    .map((match) => {
      const line = html.slice(0, match.index).split('\n').length;
      const where = isInsideComment(html, match.index) ? ' (in a comment)' : '';
      return `  line ${line}: ${match[0].trim()}${where}`;
    })
    .join('\n');

/*
 * Discovery is asserted rather than trusted: `describe.each([])` registers no
 * tests and passes, so a rename or a move that found nothing would delete this
 * guard and report success. Pinned to the exact list on purpose — a third
 * entry should be added here by someone who has thought about it.
 */
it('finds both documents Vite is pointed at', () => {
  expect(documents.map((document) => document.name).sort()).toEqual([
    'index.html',
    'preview.html',
  ]);
});

describe.each(documents)('$name', ({ html }) => {
  it.each(INJECTION_POINTS)(
    'gives Vite exactly one candidate for its $point injection point',
    ({ re, carries }) => {
      const matches = [...html.matchAll(re)];
      expect(
        matches.length,
        matches.length > 1
          ? `${carries} may be injected at the wrong one of these:\n${locate(html, matches)}`
          : 'Vite has nothing to match, and will fall back to injecting elsewhere',
      ).toBe(1);
    },
  );
});
