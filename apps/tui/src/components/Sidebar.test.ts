/**
 * The order of the rail.
 *
 * "The conversation list is not in order" was reported against the first
 * version, which lifted the current project to the top and sorted the other
 * folders by recency — so the rail rearranged itself whenever a conversation
 * anywhere was touched or the working directory changed. These lock down the
 * desktop's rules instead: folders by name and holding still, conversations
 * inside one newest first, worktrees folded into their repository, and the
 * "… n more" row that stands in for what the cap hides.
 */

import { describe, expect, it } from 'vitest';
import type { ProfileId, SessionId, SessionSummary } from '@rx-artemis/protocol';

import { ARCHIVED_FOLDER, railRows, type RailRow } from './Sidebar.js';

/** A SessionSummary with only the fields the rail reads. */
function session(
  over: Partial<SessionSummary> & { id: string; cwd: string; updatedAt: number; tag?: string },
): SessionSummary {
  return {
    providerId: 'claude',
    profileId: 'prof_personal' as ProfileId,
    title: over.id,
    ...over,
    id: over.id as SessionId,
  } as SessionSummary;
}

const identity = (cwd: string): string => cwd;
const ALL_OPEN: ReadonlySet<string> = new Set(['/w/api', '/w/web', '/w/zebra', '/archive/alpha', '/w/new', ARCHIVED_FOLDER]);

/** The rows as a compact script: `folder:api`, `session:x`, `more:3`. */
function script(rows: readonly RailRow[]): readonly string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'new':
        return 'new';
      case 'new-elsewhere':
        return 'new-elsewhere';
      case 'folder':
        return `folder:${row.label}${row.open ? '' : '(folded)'}`;
      case 'session':
        return `session:${row.session.id}`;
      case 'more':
        return `more:${String(row.hidden)}`;
      default:
        return '?';
    }
  });
}

describe('railRows', () => {
  it('orders folders by name, whatever their conversations have been doing', () => {
    const rows = railRows([
        session({ id: 'z', cwd: '/w/zebra', updatedAt: 300 }),
        session({ id: 'a', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'w', cwd: '/w/web', updatedAt: 200 }),
      ],
      ALL_OPEN,
      identity,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:a', 'folder:web', 'session:w', 'folder:zebra', 'session:z']);
  });

  it('draws no folder for a project with nothing in it, wherever you are standing', () => {
    // Reported: the directory you happen to be in got a heading of its own
    // with no rows under it. A heading promises contents, the working
    // directory is already named in the header and on the settings line, and
    // the rail is a list of conversations rather than of places.
    const rows = railRows([session({ id: 'z', cwd: '/w/zebra', updatedAt: 1 })], ALL_OPEN, identity);

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:zebra', 'session:z']);
  });

  it('sorts by the name the heading shows, not the path under it', () => {
    const rows = railRows([session({ id: 'x', cwd: '/w/zebra', updatedAt: 1 }), session({ id: 'y', cwd: '/archive/alpha', updatedAt: 2 })],
      new Set(),
      identity,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:alpha(folded)', 'folder:zebra(folded)']);
  });

  it('orders conversations inside a folder newest first, whatever order they arrived in', () => {
    const rows = railRows([
        session({ id: 'old', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'newest', cwd: '/w/api', updatedAt: 300 }),
        session({ id: 'middle', cwd: '/w/api', updatedAt: 200 }),
      ],
      ALL_OPEN,
      identity,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:newest', 'session:middle', 'session:old']);
  });

  it('keeps a fixed order when two conversations share a timestamp', () => {
    const tie = [session({ id: 'b', cwd: '/w/api', updatedAt: 5 }), session({ id: 'a', cwd: '/w/api', updatedAt: 5 })];

    expect(script(railRows(tie, ALL_OPEN, identity))).toEqual(script(railRows([...tie].reverse(), ALL_OPEN, identity)));
  });

  it('files a worktree under the repository it was split off from', () => {
    const projectOf = (cwd: string): string => (cwd.startsWith('/w/api') ? '/w/api' : cwd);
    const rows = railRows([
        session({ id: 'main', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'branch', cwd: '/w/api/.claude/worktrees/feature', updatedAt: 200 }),
      ],
      ALL_OPEN,
      projectOf,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:branch', 'session:main']);
    expect(rows[2]).toMatchObject({ kind: 'folder', count: 2 });
  });

  it('shows the newest few of a big folder and a row for the rest, until expanded', () => {
    const many = Array.from({ length: 11 }, (_, i) => session({ id: `s${String(i)}`, cwd: '/w/api', updatedAt: i }));

    const capped = railRows(many, ALL_OPEN, identity);
    expect(script(capped).slice(3)).toEqual([
      'session:s10',
      'session:s9',
      'session:s8',
      'session:s7',
      'session:s6',
      'session:s5',
      'session:s4',
      'session:s3',
      'more:3',
    ]);
    expect(capped[2]).toMatchObject({ kind: 'folder', count: 11 });

    const expanded = railRows(many, ALL_OPEN, identity, () => undefined, new Set(['/w/api']));
    // Two openers, the folder heading, then every conversation.
    expect(script(expanded)).toHaveLength(3 + 11);
    expect(script(expanded).at(-1)).toBe('session:s0');
  });

  it('shows a folded folder as a heading only, with its full count', () => {
    const rows = railRows([session({ id: 'a', cwd: '/w/api', updatedAt: 1 }), session({ id: 'b', cwd: '/w/api', updatedAt: 2 })],
      new Set(['/w/web']),
      identity,
    );

    // `web` was open and empty; it is not drawn at all, so the folded `api`
    // is the only heading and it still carries what it is hiding.
    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api(folded)']);
    expect(rows[2]).toMatchObject({ kind: 'folder', count: 2 });
  });

  it('files an archived conversation into its own folder at the foot, not its project', () => {
    const rows = railRows(
      [
        session({ id: 'live', cwd: '/w/api', updatedAt: 2 }),
        session({ id: 'put-away', cwd: '/w/api', updatedAt: 3, tag: 'archived' }),
      ],
      new Set(['/w/api', ARCHIVED_FOLDER]),
      identity,
    );

    // Newest first would have put `put-away` at the top of `api`; archiving
    // is what takes it out of the project altogether, and the archive sorts
    // last however the projects are named.
    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:live', 'folder:archived', 'session:put-away']);
  });

  it('keeps the archive folded away, and out of the way, until it is asked for', () => {
    const rows = railRows(
      [session({ id: 'gone', cwd: '/w/api', updatedAt: 1, tag: 'archived' })],
      new Set(),
      identity,
    );

    // The project it came from has nothing left in it, so it is not drawn at
    // all — one archived conversation must not leave an empty heading behind.
    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:archived(folded)']);
  });

  it('labels a row from another account and leaves the current account’s alone', () => {
    const rows = railRows([
        session({ id: 'mine', cwd: '/w/api', updatedAt: 2 }),
        session({ id: 'theirs', cwd: '/w/api', updatedAt: 1, profileId: 'prof_work' as ProfileId }),
      ],
      ALL_OPEN,
      identity,
      (s) => (s.profileId === 'prof_work' ? 'work' : undefined),
    );

    expect(rows[3]).toMatchObject({ kind: 'session' });
    expect(rows[3]).not.toHaveProperty('account');
    expect(rows[4]).toMatchObject({ kind: 'session', account: 'work' });
  });
});
