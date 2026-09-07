/**
 * Which written file is an *artifact*, as opposed to a file that merely could
 * be rendered.
 * ============================================================================
 *
 * `previewablePath` answers a narrow question — "is this a page, and where is
 * it" — and it answers yes for a great many files nobody wants thrown on
 * screen: every `README.md` the agent touches, every `.svg` icon it drops into
 * `assets/`, every HTML fixture under `test/`. That predicate is exactly right
 * for *offering a button*, which is all it was ever asked to do. It is the wrong
 * predicate for anything that acts on its own.
 *
 * This module answers the stronger question, because two features need it and
 * both of them are rude when wrong:
 *
 *  - the transcript replaces the raw `Write` row with a tile, which hides a diff
 *    the reader might have wanted, and
 *  - the first artifact of a run opens the preview pane by itself, which takes
 *    over half the window.
 *
 * ## The two tests, and what each one is really for
 *
 * **It has to look like a whole document.** A page that begins `<!doctype html>`
 * is a thing someone meant to look at. A page that begins `<div class="row">` is
 * a fragment — a template partial, a component's rendered output, a snippet
 * pasted into a fixture — and framing it produces a sliver of unstyled text that
 * looks like a bug in the preview rather than what it is. Checking the first
 * bytes is a cheap, honest proxy for "this is a document, not a piece of one".
 *
 * **It has to be somewhere output goes.** This is the load-bearing one, and it
 * is worth being clear that it is a *heuristic about intent* rather than a fact
 * about the file. An artifact is something made for the person watching; it is
 * scratch output, and it lands in `/tmp`, in the scratchpad, on the Desktop. A
 * `.html` written *into the project* is far more often a template, a fixture, a
 * docs page or a build input — a source file, which is to say something the
 * reader wants as a **diff**, not as a rendering.
 *
 * So: anywhere outside the working directory qualifies, and inside it only
 * {@link SCRATCH_SEGMENTS} do. That second clause exists because the first one
 * alone was wrong in an ordinary case — an agent asked to "build me a dashboard"
 * puts it in `out/` or `build/` *inside* the project, and that is an artifact by
 * every meaning of the word. What the two clauses have in common is the real
 * rule, which neither states directly: **an artifact is written where generated
 * things go, and source is written where source goes.**
 *
 * A false negative still costs only a click — {@link previewablePath} keeps
 * offering the Preview button on the row — while a false positive hides a source
 * diff behind a tile and hijacks the window during ordinary work. Where the two
 * clauses leave a gap, it should keep leaning that way.
 *
 * ## What is deliberately *not* required
 *
 * Neither test looks at the tool's name, and neither requires a whole-file
 * write. An `Edit` to a page that already exists is how an artifact gets
 * revised — "make the chart blue" is an `Edit`, and the reader wants the pane to
 * follow it — so an edit to a qualifying path is an artifact *update*
 * ({@link Artifact.fresh} `=== false`) rather than a non-artifact. The
 * document-shape test cannot be applied to one, because an edit's payload is a
 * fragment by construction; the directory test carries it alone.
 */

import type { FileEdit } from '@rx-artemis/transcript';
import { previewablePath } from './preview';
import { separatorFor, type Platform } from './paths';

/**
 * How the pane will render it — the same split `main/preview.ts` makes.
 *
 * `page` is framed and may execute script; `markdown` is handed back as text.
 * Kept here so the tile can say which it is without importing the main
 * process's table.
 */
export type ArtifactKind = 'page' | 'markdown';

/** A file worth showing as itself, rather than as a diff. */
export interface Artifact {
  /** Absolute path, resolved the same way {@link previewablePath} resolves it. */
  readonly path: string;
  /** Final path segment. What the tile is titled. */
  readonly title: string;
  readonly kind: ArtifactKind;
  /** Lower-case extension, for the tile's type line. */
  readonly extension: string;
  /**
   * True when this call wrote the whole file, false when it edited one.
   *
   * The caller uses it to decide how loud to be: a fresh artifact may open the
   * pane, an update may only refresh a pane already showing that same path. It
   * is the difference between "something new arrived" and "the thing you are
   * looking at changed", and conflating them is what would make a long editing
   * session flap the pane open on every tweak.
   */
  readonly fresh: boolean;
  /**
   * Rough size of what was written, in bytes, when it can be known.
   *
   * Absent for an edit, whose payload is a fragment and whose total is not
   * knowable from the tool call. The pane reports the real figure once the file
   * is read; this is only for the tile's subtitle before that happens.
   */
  readonly bytes?: number;
}

/** Extensions the pane frames, versus the one it renders as text. */
const KIND: Readonly<Record<string, ArtifactKind>> = {
  html: 'page',
  htm: 'page',
  svg: 'page',
  md: 'markdown',
  markdown: 'markdown',
};

/**
 * What the first bytes of a whole document look like, per kind.
 *
 * Anchored at the start after whitespace, and case-insensitive because `<!DOCTYPE`
 * is conventionally shouted. A leading comment or XML declaration is allowed
 * before the root element for SVG, which is how most tools emit one.
 *
 * Markdown has no counterpart and is absent on purpose: there is no syntactic
 * mark that separates a whole markdown document from a piece of one, every
 * markdown file is valid from its first character, and inventing a rule (a
 * leading `#`? front matter?) would reject perfectly ordinary documents. The
 * directory test is what carries markdown, which is also why the common false
 * positive — a `README.md` — is caught: it is written into the project.
 */
const DOCUMENT_HEAD: Readonly<Record<string, RegExp>> = {
  html: /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i,
  htm: /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i,
  svg: /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*)*<svg[\s>]/i,
};

/**
 * How much of the payload to look at.
 *
 * The head is reassembled from diff rows, and a generated page can be tens of
 * thousands of them. The marker being looked for is in the first line or two of
 * any real document, so a handful of rows is both sufficient and a bound on the
 * work done inside a transcript row that re-renders while a run streams.
 */
const HEAD_ROWS = 8;

/**
 * Decide whether a tool call produced an artifact.
 *
 * Returns `null` for everything that is not one, which is nearly every tool
 * call. The caller draws its ordinary row and offers the ordinary button.
 */
export function detectArtifact(
  edit: FileEdit | null,
  cwd: string,
  platform: Platform,
): Artifact | null {
  const path = previewablePath(edit, cwd, platform);
  if (path === null || edit === null) return null;

  const kind = KIND[edit.extension];
  if (kind === undefined) return null;

  // Where the file sits relative to the project. See the header — this is the
  // test that does most of the work, and the one most likely to want tuning.
  const inside = relativeSegments(path, cwd, platform);
  if (inside !== null && !inside.some(isScratchSegment)) return null;

  if (!edit.whole) {
    // An edit: a fragment, so there is nothing to shape-check and no total size
    // to report. It qualifies on the directory test alone, as an update.
    return { path, title: lastSegment(path), kind, extension: edit.extension, fresh: false };
  }

  const shape = DOCUMENT_HEAD[edit.extension];
  if (shape !== undefined && !shape.test(headOf(edit))) return null;

  return {
    path,
    title: lastSegment(path),
    kind,
    extension: edit.extension,
    fresh: true,
    ...(edit.truncated ? {} : { bytes: byteLengthOf(edit) }),
  };
}

/**
 * The first few lines of what was written.
 *
 * A whole-file write arrives as a diff whose every row is an addition, so the
 * file's own opening lines are simply the first `add` rows' text. Reassembled
 * rather than kept alongside because `FileEdit` deliberately does not retain the
 * raw payload — the diff *is* the parse, and a second copy of a large file held
 * in a transcript item for the sake of a regex would be the wrong trade.
 */
function headOf(edit: FileEdit): string {
  const lines: string[] = [];
  for (const row of edit.rows) {
    if (row.kind !== 'add') continue;
    lines.push(row.text);
    if (lines.length >= HEAD_ROWS) break;
  }
  return lines.join('\n');
}

/** Size of the written payload, near enough for a subtitle. */
function byteLengthOf(edit: FileEdit): number {
  let total = 0;
  for (const row of edit.rows) {
    if (row.kind !== 'add') continue;
    // Counted in UTF-8 because that is what the file is, and a page full of
    // box-drawing characters would otherwise under-report by a third.
    total += new TextEncoder().encode(row.text).length + 1;
  }
  return total;
}

/** Final path segment, for either separator. Not `lastSegment` from `paths`. */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Directory names that mean "generated", not "written by hand".
 *
 * The list is short and conventional on purpose. Every name here is one a
 * project would ordinarily gitignore, which is the closest thing to a
 * machine-readable statement that its contents are output — and being wrong in
 * the *inclusive* direction is the expensive one, so a name that is sometimes
 * source (`public`, `docs`, `static`, `assets`) is deliberately absent even
 * though generated pages do sometimes land there.
 *
 * Matched on any segment of the path below the working directory, not just the
 * first, so `packages/web/dist/report.html` qualifies in a monorepo the same way
 * `dist/report.html` does at the root.
 */
const SCRATCH_SEGMENTS: ReadonlySet<string> = new Set([
  'out',
  'output',
  'outputs',
  'dist',
  'build',
  'tmp',
  'temp',
  'scratch',
  'scratchpad',
  'artifacts',
  'generated',
  'reports',
  'coverage',
  'target',
  '.cache',
  '.tmp',
  // Artemis's own output directory inside a project. Automatic handoff writes
  // its document here, and the rule this list encodes — generated things go in
  // generated places — puts it squarely in scope: nothing in `.artemis/` is
  // source, and a handoff is written to be read rather than diffed.
  '.artemis',
]);

function isScratchSegment(segment: string): boolean {
  return SCRATCH_SEGMENTS.has(segment.toLowerCase());
}

/**
 * The directories between `cwd` and `path`, or `null` when `path` is not inside
 * `cwd` at all.
 *
 * The filename itself is not included: a file called `out.html` is not in an
 * output directory, and a caller checking segments would have no way to tell the
 * two apart if the last one were handed to it.
 *
 * Compared as text, with two accommodations and no attempt at more: separators
 * are normalised so a Windows tool call mixing `/` and `\` still matches, and
 * the comparison is case-insensitive on the two platforms whose filesystems
 * conventionally are. Symlinks, `..` segments and case-sensitive volumes on
 * macOS are all out of scope — this decides whether to draw a tile, and the
 * worst outcome of getting it wrong is a tile that should have been a diff.
 */
function relativeSegments(path: string, cwd: string, platform: Platform): string[] | null {
  if (cwd.length === 0) return null;
  const separator = separatorFor(platform);
  const fold = (value: string): string => {
    const unified = value.replace(/[\\/]/g, separator);
    const trimmed = unified.endsWith(separator) ? unified.slice(0, -separator.length) : unified;
    return platform === 'linux' ? trimmed : trimmed.toLowerCase();
  };
  const base = fold(cwd);
  const target = fold(path);
  if (target === base) return [];
  if (!target.startsWith(`${base}${separator}`)) return null;
  // Drop the filename — see above.
  return target.slice(base.length + separator.length).split(separator).slice(0, -1);
}
