/**
 * Where Vite injects, and the comment that can steal the spot.
 * ============================================================================
 *
 * Vite does not parse these documents before injecting into them. It runs four
 * regular expressions over the raw text — one per injection point — and takes
 * the first match, so anything in the file that *looks* like `<head>` is a
 * candidate, including the same characters written inside an HTML comment or a
 * pair of backticks.
 *
 * That has bitten this repo once already, and the shape of the failure is the
 * reason it is worth a test of its own. `index.html`'s opening comment
 * explained the theme fallback and named the tag the boot script sits in. The
 * head-prepend regex matched that mention, four lines above the real element,
 * so `/@vite/client` and `@vitejs/plugin-react`'s Fast Refresh preamble were
 * both injected *inside the comment* and never ran. Every component module
 * then threw "@vitejs/plugin-react can't detect preamble" and `pnpm dev` came
 * up as a blank window — while packaged builds stayed perfectly fine, because
 * a build injects its stylesheet and script tags before the *closing* tag,
 * which no comment happened to contain. A first-time contributor met a dead
 * app; the release they could download worked.
 *
 * So the invariant is not "the comments are worded nicely". It is that for
 * every injection point Vite has, the first thing matching it is the real
 * element — checked against Vite's own regexes, copied here because a build
 * tool's internals are not importable and this is exactly the kind of detail
 * that changes under us.
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
 * Vite's injection points, transcribed from `vite/src/node/plugins/html.ts`.
 *
 * `carries` is what is lost when a match is stolen, and it is the only reason
 * the failure is hard to read: the dev-only points take the whole app down in
 * development and nothing in a release, and the build-only point does the
 * reverse.
 */
const INJECTION_POINTS = [
  {
    point: 'head-prepend',
    re: /([ \t]*)<head[^>]*>/i,
    carries: "the dev server's client and the Fast Refresh preamble",
  },
  { point: 'head', re: /([ \t]*)<\/head>/i, carries: "a build's stylesheet and script tags" },
  { point: 'body-prepend', re: /([ \t]*)<body[^>]*>/i, carries: 'tags plugins ask to have injected' },
  { point: 'body', re: /([ \t]*)<\/body>/i, carries: 'tags plugins ask to have injected' },
] as const;

const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** The comment the given offset falls inside, if it falls inside one. */
const commentAround = (html: string, offset: number): string | undefined =>
  [...html.matchAll(COMMENT_RE)].find(
    (comment) => offset > comment.index && offset < comment.index + comment[0].length,
  )?.[0];

describe.each(documents)('$name', ({ html }) => {
  it.each(INJECTION_POINTS)(
    'offers Vite the real element at its $point injection point',
    ({ re, carries }) => {
      const match = re.exec(html);
      // A document missing one of these entirely is a different bug, and Vite
      // has fallbacks for it; what this test is about is a match in the wrong
      // place.
      expect(match).not.toBeNull();

      const stolenBy = commentAround(html, match?.index ?? 0);
      expect(
        stolenBy && `${carries} would be injected into this comment:\n\n${stolenBy}`,
      ).toBeUndefined();
    },
  );
});
