import type { JsonValue, TokenUsage, UsageSnapshot } from '@rx-artemis/protocol';

/** `1234` → `1.2k`. Token counts get large and column width does not. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Cost, with enough precision that sub-cent runs do not all read as `$0.00`. */
export function formatUsd(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Wall-clock duration in the smallest unit that still reads clearly. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Coarse "when", for session lists. */
export function formatRelative(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '';
  const delta = Math.max(0, now - ts);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Coarse "when", pointed forward — for appointments rather than history.
 *
 * {@link formatRelative}'s clamp reads every future moment as "just now",
 * which is the right lie for a session list and the wrong one for a schedule.
 */
export function formatUntil(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '';
  const delta = Math.max(0, ts - now);
  if (delta < 90_000) return 'within a minute';
  if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)}m`;
  if (delta < 86_400_000) return `in ${Math.round(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `in ${Math.round(delta / 86_400_000)}d`;
  return `on ${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** Clock time, for transcript gutters. */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Last path segment, for a cwd chip. Handles both separators. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

/**
 * Order two directories the way a person looks for one: by folder name.
 *
 * By *name*, not by path, because the name is what a heading shows and what
 * the user is scanning for; sorting on the whole path groups by whatever tree
 * a project happens to live in, an order nobody can predict from the labels.
 * The path breaks ties, so two `api` checkouts sit together in a fixed order
 * rather than swapping between renders. `sensitivity: 'base'` keeps `Artemis`
 * next to `artemis` instead of in an uppercase block; `numeric` puts `run-2`
 * before `run-10`.
 *
 * Every folder list in Artemis — the desktop's sidebar and directory menus,
 * the terminal's rail — sorts on this one comparator, so no two of them can
 * read in different orders.
 */
export function compareFolderNames(a: string, b: string): number {
  const collate = (x: string, y: string): number =>
    x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
  return collate(basename(a), basename(b)) || collate(a, b);
}

/** Collapse whitespace and clip, for one-line summaries. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Words a condensed title keeps, and the length past which it stops early. */
const TITLE_WORDS = 8;
const TITLE_CHARS = 56;

/**
 * A session title short enough to be a title.
 *
 * Adapters resolve a title in order of preference — the user's own, then the
 * provider's generated summary, then **the first prompt** — and that last one
 * is not a title at all. It is however far and away the most common, because a
 * summary only exists once the provider has bothered to write one, so most
 * rows in a real sidebar are headed by the opening paragraph of a conversation.
 *
 * `truncate` alone does not fix that. CSS clips at whatever pixel the column
 * ends on, which lands mid-word and, worse, lands in a *different* place per
 * row — so a list of prompts that all open "Can you take a look at…" renders as
 * a column of near-identical text ending in ragged fragments. Clipping to whole
 * words at a fixed count gives every row the same budget and ends it somewhere
 * a person would have ended it.
 *
 * Applied to every title, not only the derived ones. A user who typed a
 * sentence as a custom title gets the same treatment, which is the right call
 * for a 200px column — and the row's tooltip restates the title in full
 * (see `sessionTooltipTitle`) either way, so nothing is lost, only folded.
 *
 * The ellipsis is the character, not three dots: it is one glyph of column
 * width instead of three.
 */
export function condenseTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return flat;

  const words = flat.split(' ');
  const kept: string[] = [];
  let length = 0;

  for (const word of words) {
    // Stop *before* exceeding the budget rather than after, so a title that
    // opens with one very long word is still clipped rather than passed
    // through whole — but never to nothing: the first word always goes in.
    if (kept.length > 0 && (kept.length >= TITLE_WORDS || length + word.length > TITLE_CHARS)) {
      return `${kept.join(' ')}…`;
    }
    kept.push(word);
    length += word.length + 1;
  }
  return kept.join(' ');
}

const MAX_JSON_CHARS = 20_000;

/**
 * Pretty JSON for the inspector panes.
 *
 * Tool results can be megabytes (a `Read` of a large file, a `Bash` that
 * cats a log). Rendering that as one text node janks the whole transcript, so
 * the payload is clipped and the clip is announced rather than hidden.
 */
export function formatJson(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '';
  return text.length > MAX_JSON_CHARS
    ? `${text.slice(0, MAX_JSON_CHARS)}\n\n… clipped (${text.length.toLocaleString()} characters total)`
    : text;
}

/**
 * A one-line gloss of a tool's arguments for the collapsed row.
 *
 * Provider-neutral: it looks for the handful of argument names that show up
 * across every agent CLI, then falls back to the first short scalar.
 */
export function summarizeToolInput(input: Record<string, JsonValue> | undefined): string {
  if (!input) return '';
  const preferred = [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'prompt',
    'description',
    'notebook_path',
  ];
  for (const key of preferred) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return oneLine(value, 96);
  }
  for (const [, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length <= 96) return oneLine(value, 96);
  }
  const keys = Object.keys(input);
  return keys.length > 0 ? `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }` : '';
}

/** Total billable input tokens, cached and uncached. */
export function totalInputTokens(t: TokenUsage | undefined): number | undefined {
  if (!t) return undefined;
  return t.inputTokens + (t.cacheReadInputTokens ?? 0) + (t.cacheCreationInputTokens ?? 0);
}

/** Context fill as a 0–1 ratio, when the provider reports both halves. */
export function contextRatio(usage: UsageSnapshot | undefined): number | undefined {
  if (!usage?.contextTokens || !usage.contextWindow) return undefined;
  return Math.min(1, usage.contextTokens / usage.contextWindow);
}
