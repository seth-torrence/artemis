/**
 * The update check's contract: it orders versions the way release tags do,
 * asks GitHub at most once a day, and only ever answers with something newer.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadingCache } from './cache.js';
import { UPDATE_CHECK_KEY, checkForUpdate, compareVersions, installRoot } from './update.js';

describe('compareVersions', () => {
  it('orders numerically, part by part, and puts a prerelease below its release', () => {
    expect(compareVersions('2.5.0', '2.4.8')).toBeGreaterThan(0);
    expect(compareVersions('2.4.10', '2.4.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.4.8', '2.4.8')).toBe(0);
    expect(compareVersions('2.5.0-beta.1', '2.5.0')).toBeLessThan(0);
    expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0);
  });
});

describe('installRoot', () => {
  it('is the installer’s directory when the launcher set it, and nothing for a checkout', () => {
    expect(installRoot({ ARTEMIS_TUI_INSTALL: '/home/ada/.local/share/artemis-tui' })).toBe('/home/ada/.local/share/artemis-tui');
    expect(installRoot({})).toBeUndefined();
    expect(installRoot({ ARTEMIS_TUI_INSTALL: '' })).toBeUndefined();
  });
});

describe('checkForUpdate', () => {
  let dir: string;
  const caches: ReadingCache[] = [];
  const cacheAt = (path: string): ReadingCache => {
    const cache = new ReadingCache(path);
    caches.push(cache);
    return cache;
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artemis-tui-update-'));
  });
  afterEach(async () => {
    // The cache writes in the background; the directory goes after it has.
    await Promise.all(caches.splice(0).map((cache) => cache.flush()));
    await rm(dir, { recursive: true, force: true });
  });

  const answering = (tag: string): typeof fetch =>
    vi.fn(async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 })) as unknown as typeof fetch;

  it('reports a newer release and stays quiet when current', async () => {
    const cache = cacheAt(dir);
    expect(await checkForUpdate('2.4.8', cache, { fetchImpl: answering('v2.5.0') })).toBe('2.5.0');
    expect(await checkForUpdate('2.5.0', cacheAt(join(dir, 'b')), { fetchImpl: answering('v2.5.0') })).toBeNull();
  });

  it('asks once a day, and reads the remembered answer in between', async () => {
    const cache = cacheAt(dir);
    const fetchImpl = answering('v2.5.0');
    await checkForUpdate('2.4.8', cache, { fetchImpl, now: 1_000 });
    await checkForUpdate('2.4.8', cache, { fetchImpl, now: 2_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.get(UPDATE_CHECK_KEY)?.value).toBe('2.5.0');
    await checkForUpdate('2.4.8', cache, { fetchImpl, now: 1_000 + 25 * 60 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a failed request as no news', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate('2.4.8', cacheAt(dir), { fetchImpl: failing })).toBeNull();
  });
});
