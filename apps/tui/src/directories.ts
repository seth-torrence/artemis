/**
 * Choosing where to work, without typing a path.
 * ============================================================================
 *
 * Two lists, and between them they answer nearly every case:
 *
 *  - **Recents** — the folders already worked in, newest first, which is the
 *    desktop's rule for the control above its composer: the folder someone
 *    wants is almost always one they have been in before, so the menu is the
 *    fast path and browsing is the fallback. They are derived from the stored
 *    conversations rather than kept in a list of their own, so the two cannot
 *    disagree and a folder never has to be "registered" to appear.
 *  - **A folder browser** — for the one case the recents cannot answer, a
 *    directory the agent has never run in.
 *
 * Both are built here as plain rows over plain data, so the walking, sorting
 * and shortening are testable without a terminal.
 */

import type { Dirent } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

/** A folder already worked in. */
export interface RecentDirectory {
  readonly path: string;
  /** How it reads on screen: `~` for the home directory, and its parent for context. */
  readonly label: string;
  /** When a conversation there was last touched. */
  readonly updatedAt: number;
  /** How many conversations are stored there. */
  readonly count: number;
}

interface SessionLike {
  readonly cwd: string;
  readonly updatedAt: number;
}

/**
 * The folders conversations have run in, newest first.
 *
 * The current directory is always among them even when nothing has run there
 * yet — it is where Enter would start a conversation, so it has to be
 * offerable, and a chooser that cannot offer "here" is a chooser that cannot
 * express staying put.
 */
export function recentDirectories(
  sessions: readonly SessionLike[],
  currentCwd: string,
  home: string,
): readonly RecentDirectory[] {
  const byPath = new Map<string, { updatedAt: number; count: number }>();
  for (const session of sessions) {
    const seen = byPath.get(session.cwd);
    if (seen === undefined) byPath.set(session.cwd, { updatedAt: session.updatedAt, count: 1 });
    else byPath.set(session.cwd, { updatedAt: Math.max(seen.updatedAt, session.updatedAt), count: seen.count + 1 });
  }
  // Newest wins, so that "here" sorts to the top when it is also the most
  // recently worked in, and appears at all when it is not.
  if (!byPath.has(currentCwd)) byPath.set(currentCwd, { updatedAt: Number.MAX_SAFE_INTEGER, count: 0 });

  return [...byPath.entries()]
    .map(([path, seen]) => ({ path, label: shortenPath(path, home), updatedAt: seen.updatedAt, count: seen.count }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
}

/**
 * A path as a person would write it: `~/code/artemis` rather than the full
 * thing, which on a narrow terminal is the difference between a readable row
 * and a truncated one.
 */
export function shortenPath(path: string, home: string): string {
  if (path === home) return '~';
  const prefix = home.endsWith(sep) ? home : home + sep;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/** A row in the folder browser. */
export type BrowseRow =
  | { readonly kind: 'choose'; readonly path: string }
  | { readonly kind: 'up'; readonly path: string }
  | { readonly kind: 'down'; readonly path: string; readonly name: string };

/**
 * What the browser offers while standing in `path`.
 *
 * The first row chooses where you are, so that arriving somewhere and
 * accepting it is Enter — no second key to learn, and nothing to guess about
 * how to say "this one". Then the parent, then the subdirectories in name
 * order.
 *
 * Only directories, because only a directory can be chosen, and a list of
 * files would be a list of rows that do nothing. Hidden ones are dropped, for
 * the same reason the shell hides them.
 *
 * A symlink counts as a directory here. It usually is one — pnpm's
 * `node_modules` is nothing but symlinked directories, and people link their
 * project folders about — and `isDirectory()` is false for every one of them,
 * which made those folders invisible in a listing that showed their
 * siblings. Telling the difference for certain would mean a `stat` per entry,
 * hundreds of them for a directory like that; instead a link that turns out
 * not to be a directory fails when it is opened, and says so.
 */
export function browseRows(
  path: string,
  entries: readonly Pick<Dirent, 'name' | 'isDirectory' | 'isSymbolicLink'>[],
): readonly BrowseRow[] {
  const parent = dirname(path);
  const rows: BrowseRow[] = [{ kind: 'choose', path }];
  if (parent !== path) rows.push({ kind: 'up', path: parent });
  const directories = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const name of directories) rows.push({ kind: 'down', path: join(path, name), name });
  return rows;
}

/** The label for a browser row. */
export function browseRowLabel(row: BrowseRow, home: string): string {
  switch (row.kind) {
    case 'choose':
      return `use this folder`;
    case 'up':
      return `..  ${shortenPath(row.path, home)}`;
    case 'down':
      return `${row.name}${sep}`;
  }
}

/** Where a browser opens: the chosen folder if it is one, else its parent. */
export function browseStart(cwd: string): string {
  return cwd.length > 0 ? cwd : sep;
}

/** The name a folder is known by in a heading. */
export function folderName(path: string, home: string): string {
  return basename(path) || shortenPath(path, home);
}
