/**
 * The bank prompt a host composes for its own machine. Real directories, as
 * in `registry.test.ts`: the question is what a registry on disk produces for
 * a particular run — its account, its project, its provider.
 *
 * Every case names both registry files. A test that let either default would
 * read the developing machine's own banks and pass or fail by accident.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { joinSystemPromptAppends, machineBankPrompt } from '../prompt.js';
import { REGISTRY_V2_FILE, type BankProfileScope } from '../registryV2.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-host-bank-'));
}

/** A legacy-projects bank with one memory in it, and its own instructions. */
function projectsBank(): string {
  const bank = scratch();
  const memories = join(bank, 'projects', 'personal', 'homelab', 'memories');
  mkdirSync(memories, { recursive: true });
  writeFileSync(
    join(memories, 'unraid-paths.md'),
    '---\nname: unraid-paths\ndescription: Before writing a host path on an Unraid box\nmetadata:\n  type: reference\n  org: personal\n  project: homelab\n---\n\nUse /mnt/user.\n',
  );
  mkdirSync(join(bank, 'bin'));
  writeFileSync(join(bank, 'bin', 'cerebro'), '#!/usr/bin/env python3\n');
  writeFileSync(
    join(bank, 'cerebro.json'),
    JSON.stringify({ layout: 'projects', default_org: 'personal', instructions: 'AGENTS.md' }),
  );
  writeFileSync(join(bank, 'AGENTS.md'), 'Read INDEX.md first.');
  return bank;
}

/** A data directory whose v2 registry lists one bank at one scope. */
function dataDirFor(bank: string, slug: string, profiles: BankProfileScope): string {
  const dataDir = scratch();
  writeFileSync(
    join(dataDir, REGISTRY_V2_FILE),
    JSON.stringify({
      version: 2,
      banks: [{ slug, path: bank, role: 'readwrite', enabled: true, profiles }],
      default: slug,
    }),
  );
  return dataDir;
}

/** A path nothing is ever written to: the "this machine has no such file" case. */
const NOWHERE = join(scratch(), 'none');

describe('machineBankPrompt', () => {
  it('describes the banks the registry enables, from their own config', () => {
    const bank = projectsBank();
    const dataDir = dataDirFor(bank, 'cortex', { kind: 'all' });

    const text = machineBankPrompt({ dataDir, cliRegistryPath: NOWHERE, legacyRoot: NOWHERE });
    expect(text).toContain('`cortex`');
    expect(text).toContain('--org <org> --project <project>');
    expect(text).toContain('Read INDEX.md first.');
    expect(text).toContain(join(bank, 'bin', 'cerebro'));
  });

  it('describes a scoped bank to the profile it is attached to, and to no other', () => {
    const dataDir = dataDirFor(projectsBank(), 'cortex', { kind: 'profiles', profileIds: ['prof_work'] });
    const where = { dataDir, cliRegistryPath: NOWHERE, legacyRoot: NOWHERE };

    expect(machineBankPrompt({ ...where, profileId: 'prof_work' })).toContain('`cortex`');
    expect(machineBankPrompt({ ...where, profileId: 'prof_personal' })).toBeUndefined();
    // A caller that names no account is not one of the named accounts, which
    // is `scopeCoversProfile`'s rule: an attachment to one profile is not a
    // thing an unidentified run inherits.
    expect(machineBankPrompt(where)).toBeUndefined();
  });

  it('carries the project\'s index inline for a provider whose harness will not load it', () => {
    const dataDir = dataDirFor(projectsBank(), 'cortex', { kind: 'all' });
    const cwd = scratch();
    const where = { dataDir, cliRegistryPath: NOWHERE, legacyRoot: NOWHERE, cwd };

    const inlined = machineBankPrompt({ ...where, providerId: 'llamacpp' });
    expect(inlined).toContain('What `cortex` holds for this project');
    expect(inlined).toContain('Before writing a host path on an Unraid box');

    // A Claude harness loads the project's memory file itself, so the index is
    // named rather than repeated.
    const claude = machineBankPrompt({ ...where, providerId: 'claude' });
    expect(claude).not.toContain('What `cortex` holds for this project');
    // And a caller that names no provider gets the same, unchanged, text.
    expect(machineBankPrompt(where)).toBe(claude);
  });

  it('keeps a machine with only the legacy clone working, under the legacy slug', () => {
    const legacyRoot = projectsBank();
    const dataDir = scratch();

    const text = machineBankPrompt({ dataDir, cliRegistryPath: NOWHERE, legacyRoot });
    expect(text).toContain('`cerebro`');
    expect(text).toContain('Read INDEX.md first.');

    // A directory that is a bank but carries no CLI is not that clone: the
    // evidence `banksOnDisk` has always asked for.
    const bare = scratch();
    mkdirSync(join(bare, 'memories'));
    expect(machineBankPrompt({ dataDir, cliRegistryPath: NOWHERE, legacyRoot: bare })).toBeUndefined();
  });

  it('imports the CLI\'s registry once and writes Artemis\'s own', () => {
    const bank = projectsBank();
    const dataDir = scratch();
    const cliRegistryPath = join(scratch(), 'config.json');
    writeFileSync(cliRegistryPath, JSON.stringify({ banks: [{ slug: 'cortex', path: bank }], default: 'cortex' }));

    expect(machineBankPrompt({ dataDir, cliRegistryPath, legacyRoot: NOWHERE })).toContain('`cortex`');
    expect(existsSync(join(dataDir, REGISTRY_V2_FILE))).toBe(true);
  });

  it('is undefined for a machine with no registry, no legacy clone, or only disabled banks', () => {
    const dataDir = scratch();
    expect(machineBankPrompt({ dataDir, cliRegistryPath: NOWHERE, legacyRoot: NOWHERE })).toBeUndefined();

    const off = dataDirFor(projectsBank(), 'off', { kind: 'all' });
    writeFileSync(
      join(off, REGISTRY_V2_FILE),
      JSON.stringify({ version: 2, banks: [{ slug: 'off', path: projectsBank(), enabled: false, profiles: { kind: 'all' } }] }),
    );
    expect(machineBankPrompt({ dataDir: off, cliRegistryPath: NOWHERE, legacyRoot: NOWHERE })).toBeUndefined();
  });
});

describe('joinSystemPromptAppends', () => {
  it('joins what is there with a blank line, and answers undefined for nothing', () => {
    expect(joinSystemPromptAppends('Rules.', undefined, 'Bank.')).toBe('Rules.\n\nBank.');
    expect(joinSystemPromptAppends(undefined, '  ', '')).toBeUndefined();
    expect(joinSystemPromptAppends()).toBeUndefined();
  });
});
