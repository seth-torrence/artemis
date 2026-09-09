/**
 * Tool servers on a profile: written, read back, and never carrying a secret.
 *
 * The interesting assertions are the ones about the file. `profiles.json` is
 * unencrypted, so what must be true is that a config with a literal token never
 * reaches it, that a hand-edited record cannot smuggle an unreviewed field into
 * the object the adapter eventually spawns from, and that the whole list is
 * carried on `ProfileMetadata` — because an editor cannot offer to change a
 * list it is not allowed to read, which is the exact bug the `baseUrl` field
 * was moved out of `publicEnv` to fix.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_API_KEY_ENV, LOCAL_BASE_URL_ENV } from '@rx-artemis/protocol';
import type { ToolServerConfig } from '@rx-artemis/protocol';

import { MemoryProfileSecrets } from '../secrets.js';
import { ProfileStore } from '../store.js';

let dir: string;
let store: ProfileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artemis-tool-servers-'));
  store = new ProfileStore({ userDataDir: dir, secrets: new MemoryProfileSecrets() });
});

const draft = (toolServers?: readonly ToolServerConfig[]) => ({
  label: 'Local',
  providerId: 'llamacpp' as const,
  configDir: join(dir, 'local'),
  ...(toolServers === undefined ? {} : { toolServers }),
});

const GITHUB: ToolServerConfig = {
  name: 'github',
  transport: 'http',
  url: 'https://api.github.com/mcp',
  headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
};

const storeFile = () => join(dir, 'profiles.json');

describe('writing', () => {
  it('round-trips a server through the file', async () => {
    const created = await store.create(draft([GITHUB]));
    const read = await store.require(created.id);
    expect(read.toolServers).toEqual([GITHUB]);

    const onDisk = JSON.parse(await readFile(storeFile(), 'utf8')) as {
      profiles: { toolServers?: unknown }[];
    };
    expect(onDisk.profiles[0]?.toolServers).toEqual([GITHUB]);
  });

  it('refuses a config with a token in it, rather than saving it', async () => {
    // Nothing downstream could undo a secret written here in the clear, so the
    // save is what has to fail.
    await expect(
      store.create(
        draft([{ ...GITHUB, headers: { Authorization: 'Bearer ghp_0123456789abcdefghij' } }]),
      ),
    ).rejects.toThrow(/\$\{NAME\}/);
  });

  it('replaces the list wholesale on a patch, and an empty array keeps none', async () => {
    const created = await store.create(draft([GITHUB]));

    const renamed = await store.update(created.id, {
      toolServers: [{ ...GITHUB, name: 'gh' }],
    });
    expect(renamed.toolServers?.map((server) => server.name)).toEqual(['gh']);

    const cleared = await store.update(created.id, { toolServers: [] });
    expect(cleared.toolServers).toBeUndefined();
  });

  it('leaves the list alone when the patch does not mention it', async () => {
    const created = await store.create(draft([GITHUB]));
    const renamed = await store.update(created.id, { label: 'Renamed' });
    expect(renamed.toolServers).toEqual([GITHUB]);
  });

  it('keeps only the fields the protocol names', async () => {
    const created = await store.create(
      draft([{ ...GITHUB, surprise: 'not a field' } as unknown as ToolServerConfig]),
    );
    expect(Object.keys(created.toolServers?.[0] ?? {}).sort()).toEqual([
      'headers',
      'name',
      'transport',
      'url',
    ]);
  });
});

describe('reading a file someone edited by hand', () => {
  it('drops a list with a malformed entry rather than half of it', async () => {
    const created = await store.create(draft([GITHUB]));
    const raw = JSON.parse(await readFile(storeFile(), 'utf8')) as {
      profiles: Record<string, unknown>[];
    };
    // Half a tool-server config is a run whose tools depend on which half
    // survived. A profile that reports none is a state the user can see.
    raw.profiles[0]!['toolServers'] = [GITHUB, { name: 'broken', transport: 'telepathy' }];
    await writeFile(storeFile(), JSON.stringify(raw));

    const store2 = new ProfileStore({ userDataDir: dir, secrets: new MemoryProfileSecrets() });
    expect((await store2.require(created.id)).toolServers).toBeUndefined();
  });

  it('does not let an unreviewed key ride in from disk', async () => {
    const created = await store.create(draft([GITHUB]));
    const raw = JSON.parse(await readFile(storeFile(), 'utf8')) as {
      profiles: Record<string, unknown>[];
    };
    raw.profiles[0]!['toolServers'] = [{ ...GITHUB, shell: true, command: '/bin/sh' }];
    await writeFile(storeFile(), JSON.stringify(raw));

    const store2 = new ProfileStore({ userDataDir: dir, secrets: new MemoryProfileSecrets() });
    // `command` on an http server is refused by the protocol's own check, so
    // the whole list goes; nothing named `shell` was ever going to survive the
    // rebuild in any case.
    expect((await store2.require(created.id)).toolServers).toBeUndefined();
  });
});

describe('what the renderer is told', () => {
  it('carries the whole list on the metadata', async () => {
    // Unlike `publicEnv` beside it. An editor cannot offer to change a list it
    // is not allowed to read, and there is nothing secret in one: a value that
    // looked like a credential was refused on the way in.
    const created = await store.create(draft([GITHUB]));
    const listed = await store.list();
    expect(listed.find((profile) => profile.id === created.id)?.toolServers).toEqual([GITHUB]);
  });

  it('still carries no key, and says only that one is set', async () => {
    const created = await store.create({ ...draft([GITHUB]), apiKey: 'sk-endpoint' });
    const described = await store.describe(created.id);
    expect(described?.hasApiKey).toBe(true);
    expect(JSON.stringify(described)).not.toContain('sk-endpoint');
  });
});

describe('the managed variables are untouched by any of this', () => {
  it('leaves the endpoint and its key exactly where they were', async () => {
    const created = await store.create({ ...draft([GITHUB]), baseUrl: 'http://127.0.0.1:40114' });
    const read = await store.require(created.id);
    expect(read.baseUrl).toBe('http://127.0.0.1:40114');
    expect(read.publicEnv[LOCAL_BASE_URL_ENV]).toBeUndefined();
    expect(read.publicEnv[LOCAL_API_KEY_ENV]).toBeUndefined();
  });
});
