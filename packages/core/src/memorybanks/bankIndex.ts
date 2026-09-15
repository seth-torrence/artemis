/**
 * The index a project's memory file carries for one bank, and the marked
 * block it sits in.
 *
 * The block is the CLI's: `<!-- cerebro:<slug>:begin -->` to
 * `<!-- cerebro:<slug>:end -->`, unprefixed for the legacy slug, one bullet
 * per entry pointing at the installed copy. Kept byte-compatible in its
 * markers so an older CLI's `pull` and `uninstall` still find the block, and
 * so a machine that runs both keeps one block rather than two.
 *
 * Two things are new. Links use forward slashes on every platform (the CLI
 * wrote backslashes on Windows, which a markdown link does not survive), and
 * the block has a budget: Claude Code loads the first two hundred lines or
 * twenty-five kilobytes of a memory file and drops the rest, so an index that
 * lists everything is an index whose tail nobody reads. Past the budget the
 * block says how many more are on disk and stops.
 */

import { resolve } from 'node:path';

import type { BankEntry, IndexBudget } from './model.js';
import { LEGACY_BANK_SLUG } from './registry.js';

const LEGACY_BEGIN = '<!-- cerebro:begin -->';
const LEGACY_END = '<!-- cerebro:end -->';

export function beginMarker(slug: string): string {
  return slug === LEGACY_BANK_SLUG ? LEGACY_BEGIN : `<!-- cerebro:${slug}:begin -->`;
}

export function endMarker(slug: string): string {
  return slug === LEGACY_BANK_SLUG ? LEGACY_END : `<!-- cerebro:${slug}:end -->`;
}

/**
 * Where a bank's installed copies live inside a project's `memory/`
 * directory: bare `cerebro/` for the legacy slug, `banks/<slug>/` otherwise.
 * One reserved name rather than an open-ended set, because the directory is
 * the user's own.
 */
export function bankHome(slug: string): string {
  return slug === LEGACY_BANK_SLUG ? 'cerebro' : `banks/${slug}`;
}

/**
 * A project's key: its absolute path with everything but letters and digits
 * flattened to a dash. The CLI's own derivation, kept exactly, because the
 * installed directories already carry these names.
 */
export function projectKey(path: string): string {
  return resolve(path).replace(/[^A-Za-z0-9]/g, '-');
}

/** Project directories no bank installs into: worktrees and scratch trees. */
const SKIP_PROJECT_KEY = /-claude-worktrees-|--worktrees-/;
const SKIP_PROJECT_PREFIXES = ['-private-', '-var-', '-tmp'];

export function isInstallableProjectKey(key: string): boolean {
  if (SKIP_PROJECT_KEY.test(key)) return false;
  return !SKIP_PROJECT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Does an entry belong in this project's index?
 *
 * Unscoped entries go everywhere. A scoped one matches a project whose key is
 * the entry, or ends with `-<entry>` — a directory name matched against a
 * flattened path, which is the CLI's rule and carries the CLI's known
 * over-match (`brain` matches `telehealth-brain`).
 */
export function entryIndexedFor(entry: BankEntry, key: string): boolean {
  if (entry.appliesTo.length === 0) return true;
  const target = key.toLowerCase();
  return entry.appliesTo.some((raw) => {
    const norm = raw.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
    return target === norm || target.endsWith(`-${norm}`);
  });
}

export interface IndexBlockOptions {
  readonly slug: string;
  readonly entries: readonly BankEntry[];
  readonly projectKey: string;
  /** The bank's checkout, named in the managed line. */
  readonly repo: string;
  /** A provenance stamp such as `artemis@1a2b3c4`. */
  readonly source: string;
  /** ISO date. */
  readonly today: string;
  readonly budget: IndexBudget;
}

export interface IndexBlock {
  readonly text: string;
  /** Entries listed. */
  readonly indexed: number;
  /** Entries scoped to other repositories, on disk but not listed. */
  readonly elsewhere: number;
  /** Entries this project would have listed but the budget cut. */
  readonly cut: number;
}

export function indexLine(home: string, entry: BankEntry): string {
  return `- [${entry.title}](${home}/${entry.name}.md) — ${entry.description}`;
}

/** Render one bank's block for one project. Pure. */
export function renderIndexBlock(options: IndexBlockOptions): IndexBlock {
  const home = bankHome(options.slug);
  const candidates = options.entries.filter((entry) => entryIndexedFor(entry, options.projectKey));
  const elsewhere = options.entries.length - candidates.length;

  const lines: string[] = [];
  let bytes = 0;
  let listed = 0;
  for (const entry of candidates) {
    const line = indexLine(home, entry);
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (listed > 0 && (listed >= options.budget.lines || bytes + cost > options.budget.bytes)) break;
    lines.push(line);
    bytes += cost;
    listed += 1;
  }
  const cut = candidates.length - listed;
  if (cut > 0) {
    lines.push(`- …plus ${String(cut)} more on disk in ${home}/ — open by name, or search the bank`);
  }
  if (elsewhere > 0) {
    lines.push(
      `- …plus ${String(elsewhere)} memories scoped to other repos, on disk in ${home}/ — open by name, or search the bank`,
    );
  }
  const text = [
    beginMarker(options.slug),
    `<!-- Managed by Artemis memory banks from ${options.repo} @ ${options.source} (${options.today}). Do not edit; Artemis refreshes it at run start. -->`,
    ...lines,
    endMarker(options.slug),
  ].join('\n');
  return { text, indexed: listed, elsewhere, cut };
}

/* -------------------------------------------------------------------------- */
/* Marked blocks in a file                                                    */
/* -------------------------------------------------------------------------- */

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace the first `begin…end` span, or append the block after a blank line. */
export function replaceBlock(text: string, block: string, begin: string, end: string): string {
  const pattern = new RegExp(`${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`);
  if (pattern.test(text)) return text.replace(pattern, () => block);
  const trimmed = text.trimEnd();
  return trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
}

/** Remove the span and tidy the trailing newlines it leaves. */
export function stripBlock(text: string, begin: string, end: string): string {
  const pattern = new RegExp(`\\n?${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}\\n?`);
  const stripped = text.replace(pattern, '\n');
  const tidy = stripped.replace(/\n{3,}/g, '\n\n').trim();
  return tidy.length === 0 ? '' : `${tidy}\n`;
}

/** Is a bank's block present in the text? */
export function hasBlock(text: string, slug: string): boolean {
  return text.includes(beginMarker(slug)) && text.includes(endMarker(slug));
}
