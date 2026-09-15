/**
 * The half of the served bank wiring that `host.test.ts` cannot see: the
 * throttle on the pull, and the re-install when a pull moves the checkout.
 *
 * Real directories, a fake clock and a fake `git pull` — the fake is what
 * makes the "moved" case testable at all, since a test may not reach a remote,
 * and `sourceStamp` reads `.git` rather than spawning, so moving the checkout
 * is a file write.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectKey, REGISTRY_V2_FILE } from '@rx-artemis/core';

import {
  createServerMemoryBanks,
  mergeBankDirectories,
  withSystemPromptAppended,
} from './memoryBanks.js';

let root: string;
let dataDir: string;
let configDir: string;
let bank: string;
let cwd: string;

/** A path that never exists: this machine's own CLI registry stays out of it. */
const nowhere = (): string => join(root, 'no-cli-registry.json');

/** Point the bank's fake checkout at a commit. */
async function setHead(sha: string): Promise<void> {
  await writeFile(join(bank, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-server-banks-'));
  dataDir = join(root, 'data');
  configDir = join(dataDir, 'profiles', 'work');
  cwd = join(root, 'work');
  bank = join(root, 'bank');

  await Promise.all([
    mkdir(join(configDir, 'projects'), { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(join(bank, 'memories'), { recursive: true }),
    mkdir(join(bank, '.git', 'refs', 'heads'), { recursive: true }),
  ]);
  await writeFile(join(bank, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await setHead('aaaaaaa0000000000000000000000000000000000');
  await writeFile(
    join(bank, 'memories', 'unraid-paths.md'),
    '---\nname: unraid-paths\ndescription: Before writing a host path on an Unraid box\nmetadata:\n  type: reference\n---\n\nUse /mnt/user.\n',
  );
  await writeFile(
    join(dataDir, 'profiles.json'),
    JSON.stringify({
      version: 2,
      profiles: [{ id: 'prof_work', label: 'Work', providerId: 'claude', configDir }],
    }),
  );
  await writeFile(
    join(dataDir, REGISTRY_V2_FILE),
    JSON.stringify({
      version: 2,
      banks: [{ slug: 'cortex', path: bank, role: 'readwrite', enabled: true, profiles: { kind: 'all' } }],
      default: 'cortex',
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the server keeping its banks', () => {
  it('installs for the run\'s project, pulls once, and pulls again only past the window', async () => {
    let clock = 1_000_000;
    const pulls: string[] = [];
    const banks = createServerMemoryBanks({
      dataDir,
      cliRegistryPath: nowhere(),
      log: () => undefined,
      now: () => clock,
      pull: (path) => {
        pulls.push(path);
        return Promise.resolve({ pulled: false, detail: 'already up to date' });
      },
    });

    banks.prepare({ profileId: 'prof_work', cwd });
    // The install is synchronous: it is on disk by the time `prepare` returns,
    // which is what a first run in a new project depends on.
    const memory = join(configDir, 'projects', projectKey(cwd), 'memory');
    expect(existsSync(join(memory, 'banks', 'cortex', 'unraid-paths.md'))).toBe(true);
    expect(await readFile(join(memory, 'MEMORY.md'), 'utf8')).toContain('<!-- cerebro:cortex:begin -->');

    await banks.settle();
    expect(pulls).toEqual([bank]);

    // A burst of served turns costs one fetch.
    clock += 60_000;
    banks.prepare({ profileId: 'prof_work', cwd });
    await banks.settle();
    expect(pulls).toEqual([bank]);

    clock += 15 * 60_000;
    banks.prepare({ profileId: 'prof_work', cwd });
    await banks.settle();
    expect(pulls).toEqual([bank, bank]);
  });

  it('reinstalls when the pull moves the checkout, and not when it does not', async () => {
    let clock = 1_000_000;
    let moveOnPull = false;
    const banks = createServerMemoryBanks({
      dataDir,
      cliRegistryPath: nowhere(),
      log: () => undefined,
      now: () => clock,
      pull: async () => {
        if (moveOnPull) await setHead('bbbbbbb0000000000000000000000000000000000');
        return { pulled: true, detail: 'pulled' };
      },
    });
    const indexFile = join(configDir, 'projects', projectKey(cwd), 'memory', 'MEMORY.md');

    banks.prepare({ profileId: 'prof_work', cwd });
    await banks.settle();
    expect(await readFile(indexFile, 'utf8')).toContain('artemis@aaaaaaa');

    // The remote had something. The installed copies are a commit out of date
    // until the background half notices and writes them again.
    moveOnPull = true;
    clock += 15 * 60_000;
    banks.prepare({ profileId: 'prof_work', cwd });
    await banks.settle();
    expect(await readFile(indexFile, 'utf8')).toContain('artemis@bbbbbbb');
  });

  it('is a no-op for an account no bank reaches, and never throws', async () => {
    await writeFile(
      join(dataDir, REGISTRY_V2_FILE),
      JSON.stringify({
        version: 2,
        banks: [
          { slug: 'cortex', path: bank, role: 'readwrite', enabled: true, profiles: { kind: 'profiles', profileIds: ['prof_other'] } },
        ],
      }),
    );
    const pulls: string[] = [];
    const banks = createServerMemoryBanks({
      dataDir,
      cliRegistryPath: nowhere(),
      log: () => undefined,
      pull: (path) => {
        pulls.push(path);
        return Promise.resolve({ pulled: false, detail: '' });
      },
    });

    banks.prepare({ profileId: 'prof_work', cwd });
    await banks.settle();
    expect(pulls).toEqual([]);
    expect(banks.directoriesFor('prof_work')).toEqual([]);
    expect(banks.directoriesFor('prof_other')).toEqual([bank]);

    // A data directory that is not there at all is a run that starts anyway.
    const missing = createServerMemoryBanks({ dataDir: join(root, 'gone'), cliRegistryPath: nowhere(), log: () => undefined });
    expect(() => missing.prepare({ profileId: 'prof_work', cwd })).not.toThrow();
    expect(missing.directoriesFor('prof_work')).toEqual([]);
  });
});

describe('folding the banks into a run', () => {
  it('keeps the caller\'s own directories first, deduplicates, and no-ops by reference', () => {
    const own = ['/work/extra'];
    expect(mergeBankDirectories(own, [])).toBe(own);
    expect(mergeBankDirectories(undefined, [])).toBeUndefined();
    expect(mergeBankDirectories(undefined, ['/b/cortex'])).toEqual(['/b/cortex']);
    expect(mergeBankDirectories(own, ['/b/cortex'])).toEqual(['/work/extra', '/b/cortex']);
    // A resumed run already carrying its banks is handed its own array back.
    const already = ['/work/extra', '/b/cortex'];
    expect(mergeBankDirectories(already, ['/b/cortex'])).toBe(already);
  });

  it('appends after the caller\'s own instructions and leaves a replacement alone', () => {
    const base = { providerId: 'claude', profileId: 'p', cwd: '/w', prompt: 'hi' } as const;
    expect(withSystemPromptAppended(base, undefined)).toBe(base);
    expect(withSystemPromptAppended(base, 'Banks.').systemPrompt).toEqual({ kind: 'append', text: 'Banks.' });
    expect(
      withSystemPromptAppended({ ...base, systemPrompt: { kind: 'append', text: 'Rules.' } }, 'Banks.').systemPrompt,
    ).toEqual({ kind: 'append', text: 'Rules.\n\nBanks.' });
    const replaced = { ...base, systemPrompt: { kind: 'replace', text: 'Only this.' } } as const;
    expect(withSystemPromptAppended(replaced, 'Banks.')).toBe(replaced);
  });
});
