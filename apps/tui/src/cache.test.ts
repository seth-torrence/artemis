/**
 * The reading cache's contract: what was set is there on the next launch, and
 * nothing that goes wrong with the file becomes the launch's problem.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CATALOGUE_KEY, ReadingCache, modelsKey, tuiCacheDir, usageKey } from './cache.js';

const home = sep === '\\' ? 'C:\\Users\\ada' : '/home/ada';

describe('tuiCacheDir', () => {
  it('follows XDG on Linux, with ~/.cache as the fallback', () => {
    expect(tuiCacheDir({ platform: 'linux', home, env: { XDG_CACHE_HOME: '/xdg' } })).toBe(join('/xdg', 'artemis', 'tui'));
    expect(tuiCacheDir({ platform: 'linux', home, env: {} })).toBe(join(home, '.cache', 'artemis', 'tui'));
  });

  it('uses Caches on macOS and LOCALAPPDATA on Windows', () => {
    expect(tuiCacheDir({ platform: 'darwin', home, env: {} })).toBe(join(home, 'Library', 'Caches', 'Artemis', 'tui'));
    expect(tuiCacheDir({ platform: 'win32', home, env: { LOCALAPPDATA: 'D:\\Local' } })).toBe(join('D:\\Local', 'Artemis', 'tui'));
    expect(tuiCacheDir({ platform: 'win32', home, env: {} })).toBe(join(home, 'AppData', 'Local', 'Artemis', 'tui'));
  });

  it('lets ARTEMIS_TUI_CACHE_DIR override everything', () => {
    // Resolved to an absolute path, which on Windows gains the drive.
    expect(tuiCacheDir({ platform: 'darwin', home, env: { ARTEMIS_TUI_CACHE_DIR: '/elsewhere' } })).toBe(resolve('/elsewhere'));
  });
});

describe('ReadingCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'artemis-tui-cache-')), 'nested');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('remembers a reading across two launches, with when it was read', async () => {
    const first = new ReadingCache(dir);
    first.set(usageKey('p1'), { available: true, windows: [] }, 1_000);
    first.set(modelsKey('p1'), { models: [{ id: 'm' }], live: true }, 2_000);
    await first.flush();

    const second = new ReadingCache(dir);
    expect(second.get(usageKey('p1'))).toEqual({ at: 1_000, value: { available: true, windows: [] } });
    expect(second.get(modelsKey('p1'))?.at).toBe(2_000);
    expect(second.get(CATALOGUE_KEY)).toBeUndefined();
  });

  it('keeps the newest of two quick writes', async () => {
    const cache = new ReadingCache(dir);
    cache.set('k', 'old', 1);
    cache.set('k', 'new', 2);
    await cache.flush();

    expect(new ReadingCache(dir).get('k')).toEqual({ at: 2, value: 'new' });
    // And nothing half-written is left beside the file.
    expect(JSON.parse(await readFile(join(dir, 'readings.json'), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('treats a corrupt or foreign file as empty rather than failing the launch', async () => {
    await new ReadingCache(dir).flush();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'readings.json'), '{not json', 'utf8');
    expect(new ReadingCache(dir).get('k')).toBeUndefined();

    await writeFile(join(dir, 'readings.json'), JSON.stringify({ version: 99, entries: { k: { at: 1, value: 1 } } }), 'utf8');
    expect(new ReadingCache(dir).get('k')).toBeUndefined();
  });

  it('is usable before the directory exists', async () => {
    const cache = new ReadingCache(join(dir, 'deeper'));
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', 1);
    await cache.flush();
    expect(new ReadingCache(join(dir, 'deeper')).get('k')?.value).toBe(1);
  });
});
