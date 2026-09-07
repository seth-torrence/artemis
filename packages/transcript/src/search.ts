/**
 * Finding a word in a conversation.
 * ============================================================================
 *
 * What ⌘F/Ctrl+F asks of a transcript: every place a phrase appears, in the
 * order it was said, each one named by the row a reader can be taken to.
 *
 * ## Why the model and not the page
 *
 * The obvious implementation is the browser's: walk the rendered text. It is
 * also the one that quietly loses half the conversation. A transcript collapses
 * — a burst of forty tool calls is one marker, reasoning is a fold, a long tool
 * result is behind a disclosure — and a collapsed fold's text is not in the
 * document at all. Searching the *model* finds the sentence you remember
 * whether or not it happens to be unfolded, and hands back the row that stands
 * for it, which is the thing that can be scrolled to. The renderer paints what
 * it can on top of that; see `lib/findHighlight.ts`.
 *
 * ## What counts as the text of a row
 *
 * Whatever a reader would say the row *says* — see {@link searchableText}. A
 * tool call's text includes its input and its result, because "which command
 * wrote that file" is the question people actually ask a transcript, and the
 * answer is in the arguments rather than in any prose around them.
 *
 * ## Cost
 *
 * A search is a linear pass over every item, and a long session holds
 * megabytes of tool output. Two things keep that from being felt on every
 * keystroke: the extracted text is cached against the item object, which the
 * model replaces only when the item changes, so a second search over an
 * unchanged transcript is a scan of strings already built; and the caller
 * debounces. The cap on results exists for the same reason a browser's does —
 * a two-letter query in a long session matches everywhere, and neither the
 * counter nor the eye needs more than the first few hundred.
 */

import type { TranscriptItem, TranscriptModel } from './transcript.js';

/** One occurrence of the query, and where to take the reader to see it. */
export interface TranscriptMatch {
  /** The item the phrase is in. */
  readonly itemId: string;
  /** The row that item is drawn in — a group id when it folded into a burst. */
  readonly rowId: string;
  /** Where the match starts in that item's {@link searchableText}. */
  readonly at: number;
  /** How long the match is — the query's length, kept for the caller's sake. */
  readonly length: number;
}

/** Past this many, a query is too broad to be worth counting exactly. */
export const SEARCH_LIMIT = 500;

/**
 * The words of one row, as a reader would say them.
 *
 * Not a rendering: order and separators are for matching, not for reading, and
 * nothing here is shown to anyone. The `switch` is exhaustive on purpose — a
 * new kind of row is a compile error here, which is the only reliable way to
 * keep search from silently going blind to it.
 */
export function searchableText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
      return item.text;
    case 'notice':
      return join(item.text, item.detail);
    case 'command':
      return join(`/${item.name}`, item.args, item.output);
    case 'run-end':
      return join(item.result, item.error?.message);
    case 'permission':
      return join(
        item.request.title,
        item.request.toolName,
        item.request.plan?.plan,
        ...(item.request.question?.questions ?? []).flatMap((question) => [
          question.question,
          question.header,
          ...question.options.map((option) => join(option.label, option.description)),
        ]),
        item.note,
      );
    case 'tool':
      // The input carries the file path, the command line and the pattern —
      // the words people search a transcript for. `stringify` rather than a
      // pretty-print: this is a haystack, and the difference is whitespace.
      return join(item.title, item.name, stringify(item.input), item.resultText ?? stringify(item.result));
  }
}

function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== '').join('\n');
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    // A cyclic or otherwise unserialisable result is not searchable. It is also
    // not a reason for the search to fail.
    return undefined;
  }
}

/*
 * Keyed by the item *object*, which the model replaces whenever the item
 * changes and keeps otherwise — so an entry is never stale, and one that is no
 * longer reachable is collected with the snapshot it belonged to.
 */
const extracted = new WeakMap<TranscriptItem, string>();

function textOf(item: TranscriptItem): string {
  const cached = extracted.get(item);
  if (cached !== undefined) return cached;
  const text = searchableText(item);
  extracted.set(item, text);
  return text;
}

/**
 * Every occurrence of `query` in a transcript, in the order it was said.
 *
 * Case-insensitive and literal: a phrase, not a pattern. Whitespace-only and
 * empty queries match nothing rather than everything, which is what makes the
 * bar's "no results" honest while someone is still typing.
 *
 * The result is capped at {@link SEARCH_LIMIT}; `capped` says so, so a caller
 * can render "500+" instead of a number it would be wrong to trust.
 */
export function searchTranscript(
  model: TranscriptModel,
  query: string,
  limit: number = SEARCH_LIMIT,
): { readonly matches: readonly TranscriptMatch[]; readonly capped: boolean } {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { matches: [], capped: false };

  const matches: TranscriptMatch[] = [];
  for (const itemId of model.getListSnapshot()) {
    const item = model.getItem(itemId);
    if (item === undefined) continue;
    const haystack = textOf(item).toLowerCase();

    let at = haystack.indexOf(needle);
    if (at === -1) continue;
    const rowId = model.rowIdFor(itemId);
    while (at !== -1) {
      if (matches.length >= limit) return { matches, capped: true };
      matches.push({ itemId, rowId, at, length: needle.length });
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  return { matches, capped: false };
}
