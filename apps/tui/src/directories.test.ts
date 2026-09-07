/**
 * Choosing where to work.
 *
 * Reported as: typing a path into `/cwd` is the wrong way to move. The right
 * way is the desktop's — pick a folder already worked in, or browse for one.
 * These pin what those two lists contain and in what order.
 *
 * Paths are built with `node:path` rather than written as literals, because
 * the code under test is: a POSIX literal here passes on a Mac and fails on
 * the Windows runner, which is exactly what it did the first time.
 */

import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { browseRowLabel, browseRows, recentDirectories, shortenPath } from './directories.js';

/** An absolute path on whichever platform the test is running on. */
const path = (...parts: readonly string[]): string => join(sep, ...parts);
const HOME = path('home', 'ada');
const FS_ROOT = path();

type Entry = { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean };
const dirent = (name: string, directory = true): Entry => ({
  name,
  isDirectory: () => directory,
  isSymbolicLink: () => false,
});
const link = (name: string): Entry => ({ name, isDirectory: () => false, isSymbolicLink: () => true });

describe('recentDirectories', () => {
  const api = path('w', 'api');
  const web = path('w', 'web');
  const sessions = [
    { cwd: api, updatedAt: 300 },
    { cwd: web, updatedAt: 100 },
    { cwd: api, updatedAt: 500 },
  ];

  it('lists folders once, newest first, counting what is in them', () => {
    const recents = recentDirectories(sessions, api, HOME);

    // `api` holds two conversations and is dated by the newer of them.
    expect(recents).toEqual([
      { path: api, label: api, updatedAt: 500, count: 2 },
      { path: web, label: web, updatedAt: 100, count: 1 },
    ]);
  });

  it('offers the current folder even when nothing has run there', () => {
    const fresh = path('w', 'fresh');
    const recents = recentDirectories(sessions, fresh, HOME);

    // It is where Enter would start a conversation, so it has to be
    // offerable; a chooser that cannot offer "here" cannot express staying.
    expect(recents[0]).toMatchObject({ path: fresh, count: 0 });
    expect(recents.map((recent) => recent.path)).toEqual([fresh, api, web]);
  });

  it('writes a path the way a person would', () => {
    const inside = join(HOME, 'code', 'x');

    expect(recentDirectories([{ cwd: inside, updatedAt: 1 }], HOME, HOME)).toEqual([
      { path: HOME, label: '~', updatedAt: Number.MAX_SAFE_INTEGER, count: 0 },
      { path: inside, label: `~${sep}code${sep}x`, updatedAt: 1, count: 1 },
    ]);
  });
});

describe('shortenPath', () => {
  it('shortens only a real prefix of home', () => {
    expect(shortenPath(HOME, HOME)).toBe('~');
    expect(shortenPath(join(HOME, 'x'), HOME)).toBe(`~${sep}x`);
    // `…/adamant` is not inside `…/ada`, however it reads.
    const sibling = path('home', 'adamant', 'x');
    expect(shortenPath(sibling, HOME)).toBe(sibling);
  });
});

describe('browseRows', () => {
  const api = path('w', 'api');

  it('offers where you are first, then up, then the folders in name order', () => {
    const rows = browseRows(api, [dirent('src'), dirent('Docs'), dirent('lib')]);

    // Choosing is the first row so that accepting a folder is Enter, with no
    // second key to learn.
    expect(rows).toEqual([
      { kind: 'choose', path: api },
      { kind: 'up', path: path('w') },
      { kind: 'down', path: join(api, 'Docs'), name: 'Docs' },
      { kind: 'down', path: join(api, 'lib'), name: 'lib' },
      { kind: 'down', path: join(api, 'src'), name: 'src' },
    ]);
  });

  it('shows a symlinked folder, which is most of what some directories hold', () => {
    // `isDirectory()` is false for every entry in a pnpm `node_modules`, and
    // dropping them made those folders invisible beside their siblings.
    const modules = join(api, 'node_modules');
    const rows = browseRows(modules, [link('react'), dirent('@types')]);

    expect(rows.map((row) => row.path)).toEqual([
      modules,
      api,
      join(modules, '@types'),
      join(modules, 'react'),
    ]);
  });

  it('leaves out files and hidden folders, and has no way up from the root', () => {
    const rows = browseRows(FS_ROOT, [dirent('etc'), dirent('.git'), dirent('README.md', false)]);

    expect(rows).toEqual([
      { kind: 'choose', path: FS_ROOT },
      { kind: 'down', path: join(FS_ROOT, 'etc'), name: 'etc' },
    ]);
  });

  it('labels the rows as they read on screen', () => {
    const rows = browseRows(join(HOME, 'code'), [dirent('artemis')]);

    // The `..` row names where it goes — the parent — not where you are.
    expect(rows.map((row) => browseRowLabel(row, HOME))).toEqual(['use this folder', '..  ~', `artemis${sep}`]);
  });
});
