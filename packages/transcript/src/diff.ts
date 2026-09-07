/**
 * Turning a file-editing tool call into a reviewable diff.
 *
 * A tool call that rewrites a file is the single most consequential thing an
 * agent does, and the raw JSON of an `Edit` — two long strings under
 * `old_string` and `new_string` — is unreadable at exactly the moment it most
 * needs reading. So edits are detected here and rendered as a real diff with
 * +/- gutters, rather than being left to the generic argument dump.
 *
 * ## Provider-neutral by construction
 *
 * Nothing in this file names a provider or a tool. Detection is driven by
 * *argument shape*: a path-ish key plus either a before/after pair or a
 * whole-content key. That is deliberate — Claude calls it `Edit` with
 * `old_string`/`new_string`, another CLI will call it `apply_patch` with
 * `before`/`after`, and a diff view that only works for one vendor's tool names
 * would have to be rewritten for every provider added. The alias tables below
 * are the whole of the provider-specific knowledge, and they are additive.
 *
 * ## Cost
 *
 * This runs inside a transcript row, which may be re-rendered while a run
 * streams, so it is bounded twice over: common prefix and suffix lines are
 * stripped before any quadratic work happens (which is what makes the common
 * case — a three-line change in a thousand-line file — linear), and the
 * remaining window is refused outright past {@link LCS_CELL_BUDGET}, falling
 * back to a block replacement rather than locking the frame.
 */

import type { JsonObject, JsonValue } from '@rx-artemis/protocol';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One rendered line of a diff. */
export interface DiffRow {
  /** `gap` is a collapsed run of unchanged lines, not a line of the file. */
  readonly kind: 'add' | 'del' | 'ctx' | 'gap';
  readonly text: string;
  /** 1-based line number in the original file. Absent on `add` and `gap`. */
  readonly oldNo?: number;
  /** 1-based line number in the new file. Absent on `del` and `gap`. */
  readonly newNo?: number;
  /** How many unchanged lines a `gap` row stands for. */
  readonly skipped?: number;
  /**
   * Character ranges within {@link text} that differ from the line this one
   * replaced, as `[start, end)` pairs.
   *
   * Only populated for lines that pair up one-to-one with a counterpart, which
   * is the case that matters: a "changed" line is otherwise rendered as a whole
   * red line and a whole green line, and the reader has to diff two long lines
   * by eye to find the one identifier that moved.
   */
  readonly spans?: readonly (readonly [number, number])[];
}

/** A file edit, ready to render. */
export interface FileEdit {
  /** Path as the tool named it. Displayed verbatim; never resolved or opened. */
  readonly path: string;
  /** Lower-case file extension, for the language chip. Empty when there is none. */
  readonly extension: string;
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  /** True when the payload was clipped for size; the UI must say so. */
  readonly truncated: boolean;
  /**
   * True when the tool supplied whole new content rather than a before/after
   * pair — a file write. Every line is an addition, and the UI should not
   * imply that the absence of deletions means the file was empty before.
   */
  readonly whole: boolean;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Unchanged lines kept either side of a change before collapsing to a gap. */
const CONTEXT_LINES = 3;

/** Rows past this are dropped; a diff longer than this is not being read. */
const MAX_ROWS = 600;

/**
 * Ceiling on the LCS table. 250k cells is roughly a 500×500-line window, which
 * is far past any edit a person reviews, and it bounds the work at a few
 * milliseconds rather than letting a machine-generated rewrite of a large file
 * stall the frame.
 */
const LCS_CELL_BUDGET = 250_000;

/** Lines past this in a single payload are not diffed at all. */
const MAX_LINES = 20_000;

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/** Argument names that carry the path being edited, in order of preference. */
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file'];

/**
 * Before/after argument pairs, in order of preference.
 *
 * Ordered so that a tool supplying several pairs (a notebook edit carrying both
 * source and content) resolves to the most specific one first.
 */
const EDIT_PAIRS: readonly (readonly [string, string])[] = [
  ['old_string', 'new_string'],
  ['oldString', 'newString'],
  ['old_source', 'new_source'],
  ['old_text', 'new_text'],
  ['old_content', 'new_content'],
  ['old_str', 'new_str'],
  ['before', 'after'],
];

/** Argument names that carry whole new file content, for a write. */
const WHOLE_KEYS = ['content', 'contents', 'new_source', 'newSource', 'text', 'source'];

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Recognise a file-editing tool call and build its diff.
 *
 * Returns `null` for anything that is not an edit, which is the overwhelming
 * majority of tool calls — the caller falls back to the generic argument view.
 *
 * `toolName` is accepted but deliberately **not** matched against a list of
 * known editor tools: it is used only to distinguish a write from a read-like
 * call that happens to carry content. Matching on names would make this file
 * provider-specific for no gain, since the argument shape is already decisive.
 */
export function detectFileEdit(toolName: string, input: JsonObject | undefined): FileEdit | null {
  if (!input) return null;

  const path = PATH_KEYS.map((key) => str(input[key])).find(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (path === undefined) return null;

  const extension = extensionOf(path);

  for (const [oldKey, newKey] of EDIT_PAIRS) {
    const before = str(input[oldKey]);
    const after = str(input[newKey]);
    if (before === undefined || after === undefined) continue;
    // An edit whose halves are identical is not an edit. Rendering an all-context
    // diff would claim a change happened; falling through to the raw view says
    // less but says nothing false.
    if (before === after) return null;
    return build(path, extension, before, after, false);
  }

  // A whole-content write. Guarded on the tool name only to the extent of
  // requiring it to look like a mutation: a `Read` result is not an edit, and
  // some providers echo the file's content back in the *input* of a read.
  if (!/write|create|save|put|add|edit|patch|update|replace/i.test(toolName)) return null;
  const whole = WHOLE_KEYS.map((key) => str(input[key])).find(
    (value): value is string => value !== undefined,
  );
  if (whole === undefined) return null;
  return build(path, extension, '', whole, true);
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

function build(
  path: string,
  extension: string,
  before: string,
  after: string,
  whole: boolean,
): FileEdit {
  const oldLines = before.length === 0 && whole ? [] : before.split('\n');
  const newLines = after.split('\n');

  if (oldLines.length + newLines.length > MAX_LINES) {
    return {
      path,
      extension,
      rows: [
        { kind: 'gap', text: 'Payload too large to diff', skipped: oldLines.length },
        ...newLines.slice(0, 40).map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })),
      ],
      added: newLines.length,
      removed: oldLines.length,
      truncated: true,
      whole,
    };
  }

  const raw = diffLines(oldLines, newLines);
  const paired = pairSpans(raw);
  const collapsed = collapse(paired);

  let added = 0;
  let removed = 0;
  for (const row of raw) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'del') removed += 1;
  }

  const truncated = collapsed.length > MAX_ROWS;
  return {
    path,
    extension,
    rows: truncated ? collapsed.slice(0, MAX_ROWS) : collapsed,
    added,
    removed,
    truncated,
    whole,
  };
}

/**
 * Line diff: strip the common prefix and suffix, then LCS the middle.
 *
 * The stripping is not an optimisation detail — it is what makes this usable.
 * A typical agent edit changes a handful of lines in a file of hundreds, and
 * the affixes account for nearly all of it, leaving an LCS table small enough
 * to be free. It also produces a better diff than LCS alone, which is free to
 * "match" identical blank lines or braces from anywhere in the file and
 * generate a shredded result.
 */
function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;

  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i += 1) {
    rows.push({ kind: 'ctx', text: oldLines[i] ?? '', oldNo: i + 1, newNo: i + 1 });
  }

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);

  if (midOld.length * midNew.length > LCS_CELL_BUDGET) {
    // Too big to align properly. A block replacement is honest — it says every
    // one of these lines changed, which is true, just less precise than it
    // could be — and it is bounded.
    midOld.forEach((text, i) => rows.push({ kind: 'del', text, oldNo: start + i + 1 }));
    midNew.forEach((text, i) => rows.push({ kind: 'add', text, newNo: start + i + 1 }));
  } else {
    rows.push(...lcsRows(midOld, midNew, start));
  }

  for (let i = 0; i < oldLines.length - endOld; i += 1) {
    rows.push({
      kind: 'ctx',
      text: oldLines[endOld + i] ?? '',
      oldNo: endOld + i + 1,
      newNo: endNew + i + 1,
    });
  }
  return rows;
}

/** Classic LCS table walk. Only ever called on a window inside the budget. */
function lcsRows(a: readonly string[], b: readonly string[], offset: number): DiffRow[] {
  const n = a.length;
  const m = b.length;
  // (n+1)*(m+1) Int32 cells; the budget above keeps this to about 1 MB worst case.
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * (m + 1) + j] ?? 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'ctx', text: a[i] ?? '', oldNo: offset + i + 1, newNo: offset + j + 1 });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      rows.push({ kind: 'del', text: a[i] ?? '', oldNo: offset + i + 1 });
      i += 1;
    } else {
      rows.push({ kind: 'add', text: b[j] ?? '', newNo: offset + j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ kind: 'del', text: a[i] ?? '', oldNo: offset + i + 1 });
    i += 1;
  }
  while (j < m) {
    rows.push({ kind: 'add', text: b[j] ?? '', newNo: offset + j + 1 });
    j += 1;
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Intra-line spans                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Mark the characters that actually changed on lines that pair up.
 *
 * Without this a one-character change to a 200-character line renders as a
 * whole red line above a whole green line, and finding the difference is left
 * to the reader — which is exactly the work the diff was supposed to do. Only
 * runs where deletions and additions are the same length are paired: anything
 * else is an insertion or a removal rather than a modification, and inventing a
 * correspondence would highlight noise.
 */
function pairSpans(rows: readonly DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) break;
    if (row.kind !== 'del') {
      out.push(row);
      index += 1;
      continue;
    }

    let delEnd = index;
    while (rows[delEnd]?.kind === 'del') delEnd += 1;
    let addEnd = delEnd;
    while (rows[addEnd]?.kind === 'add') addEnd += 1;

    const dels = rows.slice(index, delEnd);
    const adds = rows.slice(delEnd, addEnd);

    if (dels.length > 0 && dels.length === adds.length) {
      for (let k = 0; k < dels.length; k += 1) {
        const del = dels[k];
        const add = adds[k];
        if (!del || !add) continue;
        const [delSpans, addSpans] = charSpans(del.text, add.text);
        out.push({ ...del, spans: delSpans });
        adds[k] = { ...add, spans: addSpans };
      }
      out.push(...adds);
    } else {
      out.push(...dels, ...adds);
    }
    index = addEnd;
  }
  return out;
}

/**
 * The differing middles of two strings, as one span each.
 *
 * Prefix/suffix trimming rather than a character-level LCS: it is O(n), it
 * cannot produce the confetti a character LCS makes of reordered code, and for
 * the case this exists to serve — a renamed identifier, a changed literal, an
 * added argument — it lands on exactly the right range.
 */
function charSpans(
  before: string,
  after: string,
): [readonly (readonly [number, number])[], readonly (readonly [number, number])[]] {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start += 1;

  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  // A line whose every character differs gets no spans: highlighting the whole
  // line adds nothing over the row's own colour.
  if (start === 0 && endBefore === before.length && endAfter === after.length) return [[], []];

  return [
    endBefore > start ? [[start, endBefore] as const] : [],
    endAfter > start ? [[start, endAfter] as const] : [],
  ];
}

/* -------------------------------------------------------------------------- */
/* Context collapsing                                                         */
/* -------------------------------------------------------------------------- */

/** Replace long unchanged runs with a single gap row. */
function collapse(rows: readonly DiffRow[]): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind === 'add' || row.kind === 'del') {
      for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(rows.length - 1, i + CONTEXT_LINES); k += 1) {
        keep[k] = true;
      }
    }
  });

  const out: DiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`, skipped });
        skipped = 0;
      }
      out.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) {
    out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}`, skipped });
  }
  return out;
}
