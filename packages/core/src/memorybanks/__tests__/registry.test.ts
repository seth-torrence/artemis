/**
 * Reading the banks' own files, the way the CLI writes them.
 *
 * Fixtures are real directories under the OS temp dir rather than mocks of
 * `fs`: the questions here are about what is on disk — is there a
 * `memories/` folder, does `cerebro.json` declare a layout, does the
 * instructions file exist and stay inside the bank — and a mock of the
 * filesystem would be a second implementation of the thing under test.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BANK_INSTRUCTIONS_LIMIT,
  banksOnDisk,
  describeBanksForPrompt,
  isBank,
  legacyBankRoot,
  parseBankConfig,
  parseRegistry,
  readBankConfig,
  readBankInstructions,
  registryPath,
} from '../registry.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-bank-'));
}

/** A flat bank: a `memories/` folder is all the CLI has ever required. */
function flatBank(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'memories'));
  return dir;
}

/** A `projects` bank as cortex is laid out: no `memories/` at all. */
function projectsBank(extra: Record<string, unknown> = {}): string {
  const dir = scratch();
  mkdirSync(join(dir, 'projects', 'personal', 'homelab', 'memories'), { recursive: true });
  writeFileSync(
    join(dir, 'cerebro.json'),
    JSON.stringify({ version: 1, layout: 'projects', default_org: 'personal', ...extra }),
  );
  return dir;
}

describe('parseRegistry', () => {
  it('reads the multi-bank shape, defaulting role and enabled', () => {
    const registry = parseRegistry(
      JSON.stringify({
        banks: [
          { slug: 'cortex', path: '/b/cortex' },
          { slug: 'docs', path: '/b/docs', role: 'readonly', enabled: false },
          { slug: 'Not A Slug', path: '/b/x' },
          { slug: 'nopath' },
        ],
        default: 'docs',
      }),
    );
    expect(registry.banks).toEqual([
      { slug: 'cortex', path: '/b/cortex', role: 'readwrite', enabled: true },
      { slug: 'docs', path: '/b/docs', role: 'readonly', enabled: false },
    ]);
    expect(registry.defaultSlug).toBe('docs');
  });

  it('reads the single-bank shape as one legacy bank', () => {
    expect(parseRegistry(JSON.stringify({ bank: '/Users/x/Documents/cerebro' }))).toEqual({
      banks: [{ slug: 'cerebro', path: '/Users/x/Documents/cerebro', role: 'readwrite', enabled: true }],
      defaultSlug: 'cerebro',
    });
  });

  it('falls back to the first bank when the default names nothing present', () => {
    const registry = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'a', path: '/a' }], default: 'gone' }),
    );
    expect(registry.defaultSlug).toBe('a');
  });

  it('reads garbage as no banks', () => {
    expect(parseRegistry('not json')).toEqual({ banks: [], defaultSlug: null });
    expect(parseRegistry('[]')).toEqual({ banks: [], defaultSlug: null });
    expect(parseRegistry('{}')).toEqual({ banks: [], defaultSlug: null });
  });
});

describe('where the files are', () => {
  it('honours XDG_CONFIG_HOME, then falls back to ~/.config', () => {
    expect(registryPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(
      join('/xdg', 'cerebro', 'config.json'),
    );
    expect(registryPath({}, '/home/u')).toBe(join('/home/u', '.config', 'cerebro', 'config.json'));
  });

  it('lets ARTEMIS_CEREBRO_ROOT move the legacy clone', () => {
    expect(legacyBankRoot({ ARTEMIS_CEREBRO_ROOT: '/elsewhere' }, '/home/u')).toBe('/elsewhere');
    expect(legacyBankRoot({}, '/home/u')).toBe(join('/home/u', 'Documents', 'cerebro'));
  });
});

describe('parseBankConfig', () => {
  it('reads the layout, the default org and the instructions file', () => {
    expect(
      parseBankConfig(
        JSON.stringify({ layout: 'projects', default_org: 'personal', instructions: 'AGENTS.md' }),
      ),
    ).toEqual({ layout: 'projects', defaultOrg: 'personal', instructions: 'AGENTS.md' });
  });

  it('reads anything unrecognised as the flat default', () => {
    // A bank written against a newer CLI, a hand-edit, a BOM from PowerShell:
    // none of them may change a bank's shape under this reader.
    expect(parseBankConfig(JSON.stringify({ layout: 'hexagonal' }))).toEqual({ layout: 'flat' });
    expect(parseBankConfig(JSON.stringify({ default_org: 'Not Slug', instructions: 7 }))).toEqual({
      layout: 'flat',
    });
    expect(parseBankConfig('﻿{"layout":"projects"}')).toEqual({ layout: 'projects' });
    expect(parseBankConfig('nope')).toEqual({ layout: 'flat' });
    expect(parseBankConfig('[]')).toEqual({ layout: 'flat' });
  });

  it('reads a bank with no config as a flat bank', () => {
    expect(readBankConfig(flatBank())).toEqual({ layout: 'flat' });
  });
});

describe('isBank', () => {
  it('accepts a memories/ folder, as it always has', () => {
    expect(isBank(flatBank())).toBe(true);
  });

  it('accepts a projects layout that has dropped its memories/ folder', () => {
    // The case that used to make a bank vanish: cortex keeps an empty
    // `memories/` only so that older readers see one. The layout is what says
    // it is a bank.
    expect(isBank(projectsBank())).toBe(true);
  });

  it('refuses a projects/ folder that no config claims', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'projects'));
    expect(isBank(dir)).toBe(false);
  });

  it('refuses a directory with neither, and a missing one', () => {
    expect(isBank(scratch())).toBe(false);
    expect(isBank(join(scratch(), 'nowhere'))).toBe(false);
  });
});

describe('readBankInstructions', () => {
  it('reads the named file from inside the bank', () => {
    const dir = projectsBank({ instructions: 'AGENTS.md' });
    writeFileSync(join(dir, 'AGENTS.md'), '﻿# How to use this bank\n\nRead INDEX.md first.\n');
    expect(readBankInstructions(dir, readBankConfig(dir))).toBe(
      '# How to use this bank\n\nRead INDEX.md first.',
    );
  });

  it('refuses a path that escapes the bank', () => {
    const dir = projectsBank({ instructions: '../outside.md' });
    writeFileSync(join(dir, '..', 'outside.md'), 'not yours');
    expect(readBankInstructions(dir, readBankConfig(dir))).toBeUndefined();
  });

  it('answers nothing for a missing or empty file, or no key', () => {
    const named = projectsBank({ instructions: 'AGENTS.md' });
    expect(readBankInstructions(named, readBankConfig(named))).toBeUndefined();
    writeFileSync(join(named, 'AGENTS.md'), '   \n');
    expect(readBankInstructions(named, readBankConfig(named))).toBeUndefined();
    const unnamed = projectsBank();
    expect(readBankInstructions(unnamed, readBankConfig(unnamed))).toBeUndefined();
  });

  it('cuts a long file at the limit and says so', () => {
    const dir = projectsBank({ instructions: 'AGENTS.md' });
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(BANK_INSTRUCTIONS_LIMIT + 500));
    const text = readBankInstructions(dir, readBankConfig(dir));
    expect(text).toBeDefined();
    expect(text!.startsWith('x'.repeat(BANK_INSTRUCTIONS_LIMIT))).toBe(true);
    expect(text).toContain('only the first 4000 characters');
    expect(text!.length).toBeLessThan(BANK_INSTRUCTIONS_LIMIT + 200);
  });
});

describe('the banks a run is told about', () => {
  it('keeps registered, enabled banks that exist, whatever their layout', () => {
    const flat = flatBank();
    const nested = projectsBank();
    const registry = {
      banks: [
        { slug: 'team', path: flat, role: 'readwrite' as const, enabled: true },
        { slug: 'cortex', path: nested, role: 'readwrite' as const, enabled: true },
        { slug: 'off', path: flat, role: 'readwrite' as const, enabled: false },
        { slug: 'gone', path: join(scratch(), 'nope'), role: 'readonly' as const, enabled: true },
      ],
      defaultSlug: 'cortex',
    };
    expect(banksOnDisk({ registry }).map((bank) => bank.slug)).toEqual(['team', 'cortex']);
  });

  it('falls back to the legacy clone only when it carries the CLI', () => {
    const root = flatBank();
    const empty = { banks: [], defaultSlug: null };
    expect(banksOnDisk({ registry: empty, legacyRoot: root })).toEqual([]);
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'cerebro'), '#!/usr/bin/env python3\n');
    expect(banksOnDisk({ registry: empty, legacyRoot: root })).toEqual([
      { slug: 'cerebro', path: root, role: 'readwrite', enabled: true },
    ]);
    expect(banksOnDisk({ registry: empty })).toEqual([]);
  });

  it('describes each bank with its layout, default org and instructions', () => {
    const nested = projectsBank({ instructions: 'AGENTS.md' });
    writeFileSync(join(nested, 'AGENTS.md'), 'Every fact names a project.');
    mkdirSync(join(nested, 'bin'));
    writeFileSync(join(nested, 'bin', 'cerebro'), '#!/usr/bin/env python3\n');
    const flat = flatBank();
    const registry = {
      banks: [
        { slug: 'cortex', path: nested, role: 'readwrite' as const, enabled: true },
        { slug: 'team', path: flat, role: 'readwrite' as const, enabled: true },
      ],
      defaultSlug: 'cortex',
    };
    expect(describeBanksForPrompt({ registry, fallbackCli: '/vendored/cerebro' })).toEqual([
      {
        slug: 'cortex',
        isDefault: true,
        readonly: false,
        cli: join(nested, 'bin', 'cerebro'),
        layout: 'projects',
        defaultOrg: 'personal',
        instructions: 'Every fact names a project.',
      },
      { slug: 'team', isDefault: false, readonly: false, cli: '/vendored/cerebro', layout: 'flat' },
    ]);
  });

  it('withholds a read-only bank\'s instructions, and promotes a survivor to default', () => {
    // Somebody else maintains a read-only bank; their notes are not standing
    // text for this machine's agents. And a stale `default` naming a bank that
    // is gone must not leave the prompt with no primary.
    const theirs = projectsBank({ instructions: 'AGENTS.md' });
    writeFileSync(join(theirs, 'AGENTS.md'), 'Do as we say.');
    const registry = {
      banks: [{ slug: 'theirs', path: theirs, role: 'readonly' as const, enabled: true }],
      defaultSlug: 'gone',
    };
    const [bank] = describeBanksForPrompt({ registry });
    expect(bank).toMatchObject({ slug: 'theirs', isDefault: true, readonly: true, cli: 'bin/cerebro' });
    expect(bank).not.toHaveProperty('instructions');
  });
});
