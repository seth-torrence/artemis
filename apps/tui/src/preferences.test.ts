/**
 * What the terminal remembers between launches.
 *
 * Reported as: reopening it means setting the account, the model and the mode
 * again. These pin the two rules that answer it — what is written down is
 * read back, and a model is remembered against the account that can actually
 * run it — plus the one that keeps a bad file from being a bad launch.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PreferencesStore, tuiStateDir } from './preferences.js';

const home = sep === '\\' ? 'C:\\Users\\ada' : '/home/ada';

describe('tuiStateDir', () => {
  it('is the state directory, not the cache one, on each platform', () => {
    // Losing a cache costs a slow launch; losing this costs the user their
    // settings, so it must not sit where a cleaner sweeps caches.
    expect(tuiStateDir({ platform: 'linux', home, env: {} })).toBe(join(home, '.local', 'state', 'artemis', 'tui'));
    expect(tuiStateDir({ platform: 'linux', home, env: { XDG_STATE_HOME: '/state' } })).toBe(join('/state', 'artemis', 'tui'));
    expect(tuiStateDir({ platform: 'darwin', home, env: {} })).toBe(
      join(home, 'Library', 'Application Support', 'Artemis', 'tui'),
    );
    expect(tuiStateDir({ platform: 'win32', home, env: { APPDATA: 'D:\\Roaming' } })).toBe(join('D:\\Roaming', 'Artemis', 'tui'));
  });

  it('lets ARTEMIS_TUI_STATE_DIR override everything', () => {
    // Already absolute, so resolving it is the identity — on either platform.
    const elsewhere = sep === '\\' ? 'D:\\elsewhere' : '/elsewhere';
    expect(tuiStateDir({ platform: 'linux', home, env: { ARTEMIS_TUI_STATE_DIR: elsewhere } })).toBe(elsewhere);
  });
});

describe('PreferencesStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'artemis-tui-prefs-')), 'nested');
  });
  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('reads back the account and mode the last launch was left in', async () => {
    const first = new PreferencesStore(dir);
    first.save({ profileId: 'prof_work', permissionMode: 'plan' });
    await first.flush();

    expect(new PreferencesStore(dir).get()).toMatchObject({ profileId: 'prof_work', permissionMode: 'plan' });
  });

  it('remembers a model against its own account, leaving the others alone', async () => {
    const store = new PreferencesStore(dir);
    store.saveModelFor('prof_work', { model: 'opus', effort: 'high' });
    store.saveModelFor('prof_home', { model: 'sonnet' });
    store.save({ profileId: 'prof_home' });
    await store.flush();

    // A model id belongs to the provider that named it; restoring one account's
    // onto another would be refused by the adapter at best.
    const reopened = new PreferencesStore(dir);
    expect(reopened.modelFor('prof_work')).toEqual({ model: 'opus', effort: 'high' });
    expect(reopened.modelFor('prof_home')).toEqual({ model: 'sonnet' });
    expect(reopened.modelFor('prof_never_used')).toBeUndefined();
    // And the later save did not take the models with it.
    expect(reopened.get().profileId).toBe('prof_home');
  });

  it('opens on nothing remembered rather than failing, whatever the file holds', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'preferences.json'), '{ not json', 'utf8');
    expect(new PreferencesStore(dir).get()).toEqual({});

    await writeFile(join(dir, 'preferences.json'), JSON.stringify({ version: 99, preferences: { profileId: 'x' } }), 'utf8');
    expect(new PreferencesStore(dir).get()).toEqual({});
  });
});
