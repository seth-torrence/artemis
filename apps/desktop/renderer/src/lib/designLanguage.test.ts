/**
 * Two rules of the design language, enforced rather than described.
 *
 * ## Nothing in the normal flow may lift.
 *
 * This is Sheet's one structural rule and the easiest thing in the design to
 * lose, because losing it takes no decision at all — a `shadow-md` copied from
 * a registry component, or a `ring-1 ring-foreground/5` pasted from the card
 * beside it, and the six-step elevation model is quietly back in the components
 * after the tokens stopped believing in it. That is exactly what happened
 * between the palette landing and this test being written: `index.css` said
 * depth was deleted while the sidebar, the update card, the bug report row and
 * shadcn's `Card` were all still floating.
 *
 * Depth is carried by `--line`. A fill that lifts is reserved for things that
 * genuinely *are* above the content, and those are enumerated below rather than
 * detected, because "is this an overlay" is a design decision and not something
 * a regex can be trusted to infer.
 *
 * ## What this does not police
 *
 * Focus rings. `ring-2 ring-ring/50` and friends are an accessibility
 * requirement, not decoration, and Sheet has no opinion about them. Only the
 * two decorative spellings are checked: a drop shadow, and the hairline ring
 * drawn in `--foreground` that shadcn cards use to fake a lifted edge.
 *
 * ## Small caps are spelled one way.
 *
 * The chrome label — uppercase mono at 11px with wide tracking — was written
 * twelve different ways before `.chrome-label` existed: `tracking-wider`,
 * `tracking-[0.14em]`, `tracking-[0.16em]`, `tracking-wide` and nothing at all,
 * with and without `font-mono`, sometimes at `font-semibold`. Each was a
 * reasonable local choice; together they were an inconsistency you could see.
 * Uppercase without tracking is the failure that matters — small caps crowd
 * without it — so that is what this checks.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Surfaces that are above the content, and may say so.
 *
 * Popovers, menus, dialogs and tooltips overlay whatever is beneath them, and a
 * language with no elevation has no other way to communicate that — this is the
 * `--float` exception the stylesheet documents.
 *
 * `primitives.tsx` is deliberately *not* here even though it contains a ring:
 * its swatch carries a `sheet:allow-lift` marker instead, because exempting one
 * line leaves the rest of the file policed and exempting the file does not.
 *
 * The four below the Radix set are not overlays in its sense but are the same
 * argument: `Transcript` floats a "jump to latest" button over the scrolling
 * column, `WorkingArea` floats a ghost under the cursor while a pane is being
 * dragged, `SlashCommandMenu` floats over the transcript above the composer, and
 * `FindInSession` floats the find bar over the conversation it is searching —
 * in the flow it would push the transcript down and move the line being read,
 * which is the opposite of what a find bar is for. All four are detached from
 * the flow they sit over. The menu is hand-rolled rather than a `popover`
 * precisely because it must *not* take focus — the user is still typing — so it
 * cannot inherit the exception from the primitive.
 */
const MAY_LIFT = new Set([
  'components/FindInSession.tsx',
  'components/SlashCommandMenu.tsx',
  'components/Transcript.tsx',
  'components/WorkingArea.tsx',
  'components/ui/alert-dialog.tsx',
  'components/ui/context-menu.tsx',
  'components/ui/dialog.tsx',
  'components/ui/dropdown-menu.tsx',
  'components/ui/popover.tsx',
  'components/ui/select.tsx',
  'components/ui/tooltip.tsx',
]);

/** A drop shadow, or the decorative hairline ring that fakes a lifted edge. */
const LIFTS = /\b(shadow-(?:xs|sm|md|lg|xl|2xl)\b|ring-foreground\/)/;

/**
 * A local opt-out, for the handful of cases where a ring is *definition* rather
 * than elevation — a colour swatch needs an edge or it dissolves into whichever
 * ground it lands on. Written beside the line it excuses, because an exception
 * kept in a list at the top of a test file is an exception nobody re-reads.
 */
const ALLOW = 'sheet:allow-lift';

function sourcesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(full, rel));
    } else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('elevation is reserved for overlays', () => {
  const files = sourcesUnder(join(ROOT, 'components'), 'components');

  it('found the component tree', () => {
    // A traversal that silently found nothing would pass every check below.
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files.filter((f) => !MAY_LIFT.has(f)))('%s stays on the plane', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const offending = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => LIFTS.test(line))
      // The marker sits in the comment above the line it excuses.
      .filter(([n]) => !source.split('\n').slice(Math.max(0, n - 5), n).some((l) => l.includes(ALLOW)));

    expect(
      offending.map(([n, line]) => `${file}:${n} ${line.trim().slice(0, 90)}`),
      `${file} lifts off the plane. If it genuinely overlays content, add it to MAY_LIFT with a reason.`,
    ).toEqual([]);
  });

  it('keeps the allowlist honest', () => {
    // An entry that no longer lifts is an entry that should be removed, or the
    // list becomes a place exceptions go to be forgotten.
    for (const file of MAY_LIFT) {
      let source: string;
      try {
        source = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue; // A listed file that no longer exists is not this test's problem.
      }
      expect(LIFTS.test(source), `${file} is allowed to lift but no longer does — drop it`).toBe(
        true,
      );
    }
  });
});

describe('small caps are spelled one way', () => {
  const files = sourcesUnder(join(ROOT, 'components'), 'components');

  it.each(files)('%s uses .chrome-label rather than its own tracking', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const offending = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      // Only className strings; prose in a comment may say "uppercase" freely.
      .filter(([, line]) => /className=/.test(line) && /\buppercase\b/.test(line))
      .filter(([, line]) => !/chrome-label/.test(line));

    expect(
      offending.map(([n, line]) => `${file}:${n} ${line.trim().slice(0, 90)}`),
      `${file} hand-rolls a small-caps label. Use .chrome-label — it carries the tracking.`,
    ).toEqual([]);
  });
});
