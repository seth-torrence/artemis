/**
 * Artemis's registry, and how it stays in step with the CLI's, plus what a
 * run is told from it.
 */

import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { banksForProfile, describeBanksForRun } from '../describe.js';
import {
  parseRegistryV2,
  readRegistryV2,
  reconcileWithCli,
  registryV2Path,
  renderCliRegistry,
  scopeCoversProfile,
  withBank,
  withoutBank,
  writeRegistryV2,
  type BankRegistryV2,
} from '../registryV2.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-registry-'));
}

function bank(dir: string, name: string): void {
  mkdirSync(join(dir, 'memories'), { recursive: true });
  writeFileSync(join(dir, 'memories', `${name}.md`), `---\nname: ${name}\ndescription: About ${name}\nmetadata:\n  type: reference\n---\n\nFact.\n`);
}

const two: BankRegistryV2 = {
  version: 2,
  banks: [
    { slug: 'cortex', path: '/b/cortex', role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
    { slug: 'client', path: '/b/client', role: 'readonly', enabled: true, profiles: { kind: 'profiles', profileIds: ['p1'] } },
  ],
  defaultSlug: 'cortex',
};

describe('parseRegistryV2', () => {
  it('reads the file and refuses anything else', () => {
    expect(parseRegistryV2(JSON.stringify({ version: 2, banks: [{ slug: 'a', path: '/a', profiles: { kind: 'profiles', profileIds: ['p'] } }], default: 'a' }))).toEqual({
      version: 2,
      banks: [{ slug: 'a', path: '/a', role: 'readwrite', enabled: true, profiles: { kind: 'profiles', profileIds: ['p'] } }],
      defaultSlug: 'a',
    });
    expect(parseRegistryV2('{"version":1,"banks":[]}')).toBeNull();
    expect(parseRegistryV2('nope')).toBeNull();
  });
});

describe('staying in step with the CLI', () => {
  it('imports the CLI registry when there is no v2 file', () => {
    const dataDir = scratch();
    const cliPath = join(scratch(), 'config.json');
    writeFileSync(cliPath, JSON.stringify({ banks: [{ slug: 'cortex', path: '/b/cortex' }], default: 'cortex' }));
    const { registry, dirty } = readRegistryV2({ dataDir, cliRegistryPath: cliPath });
    expect(dirty).toBe(true);
    expect(registry.banks).toEqual([{ slug: 'cortex', path: '/b/cortex', role: 'readwrite', enabled: true, profiles: { kind: 'all' } }]);
  });

  it('folds a newer CLI registry in, keeping the profile scope it cannot know', () => {
    const reconciled = reconcileWithCli(two, {
      banks: [
        { slug: 'client', path: '/b/client', role: 'readwrite', enabled: false },
        { slug: 'new', path: '/b/new', role: 'readwrite', enabled: true },
      ],
      defaultSlug: 'new',
    });
    expect(reconciled.banks).toEqual([
      { slug: 'client', path: '/b/client', role: 'readwrite', enabled: false, profiles: { kind: 'profiles', profileIds: ['p1'] } },
      { slug: 'new', path: '/b/new', role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
    ]);
    expect(reconciled.defaultSlug).toBe('new');
    expect(reconcileWithCli(two, { banks: [], defaultSlug: null })).toBe(two);
  });

  it('writes v2, mirrors the CLI file with its other keys kept, and leaves v2 the newer', () => {
    const dataDir = scratch();
    const cliPath = join(scratch(), 'config.json');
    writeFileSync(cliPath, JSON.stringify({ banks: [], custom: 'kept' }));
    writeRegistryV2({ dataDir, cliRegistryPath: cliPath }, two);
    const mirrored = JSON.parse(readFileSync(cliPath, 'utf8')) as Record<string, unknown>;
    expect(mirrored['custom']).toBe('kept');
    expect(mirrored['banks']).toEqual([
      { slug: 'cortex', path: '/b/cortex', role: 'readwrite', enabled: true },
      { slug: 'client', path: '/b/client', role: 'readonly', enabled: true },
    ]);
    expect(mirrored['default']).toBe('cortex');
    expect(mirrored['bank']).toBe('/b/cortex');
    const again = readRegistryV2({ dataDir, cliRegistryPath: cliPath });
    expect(again.dirty).toBe(false);
    expect(again.registry).toEqual(two);
  });

  it('re-reads the CLI file when it is newer', () => {
    const dataDir = scratch();
    const cliPath = join(scratch(), 'config.json');
    writeFileSync(cliPath, JSON.stringify({ banks: [] }));
    writeRegistryV2({ dataDir, cliRegistryPath: cliPath }, two);
    writeFileSync(cliPath, JSON.stringify({ banks: [{ slug: 'cortex', path: '/b/cortex', enabled: false }] }));
    const later = new Date(Date.now() + 5000);
    utimesSync(cliPath, later, later);
    const { registry, dirty } = readRegistryV2({ dataDir, cliRegistryPath: cliPath });
    expect(dirty).toBe(true);
    expect(registry.banks).toEqual([{ slug: 'cortex', path: '/b/cortex', role: 'readwrite', enabled: false, profiles: { kind: 'all' } }]);
  });

  it('renders the CLI file from nothing', () => {
    expect(JSON.parse(renderCliRegistry(two, null))).toEqual({
      banks: [
        { slug: 'cortex', path: '/b/cortex', role: 'readwrite', enabled: true },
        { slug: 'client', path: '/b/client', role: 'readonly', enabled: true },
      ],
      default: 'cortex',
      bank: '/b/cortex',
    });
    expect(registryV2Path('/data')).toBe(join('/data', 'memory-banks.json'));
  });
});

describe('editing a registry', () => {
  it('adds, replaces and removes, keeping a sensible default', () => {
    const added = withBank(two, { slug: 'x', path: '/x', role: 'readwrite', enabled: true, profiles: { kind: 'all' } });
    expect(added.banks.map((b) => b.slug)).toEqual(['cortex', 'client', 'x']);
    const removed = withoutBank(added, 'cortex');
    expect(removed.defaultSlug).toBe('client');
    expect(withoutBank(withoutBank(removed, 'client'), 'x').defaultSlug).toBeNull();
  });

  it('answers scope questions', () => {
    expect(scopeCoversProfile({ kind: 'all' }, undefined)).toBe(true);
    expect(scopeCoversProfile({ kind: 'profiles', profileIds: ['p1'] }, 'p1')).toBe(true);
    expect(scopeCoversProfile({ kind: 'profiles', profileIds: ['p1'] }, 'p2')).toBe(false);
    expect(scopeCoversProfile({ kind: 'profiles', profileIds: ['p1'] }, undefined)).toBe(false);
  });
});

describe('what a run is told', () => {
  it('describes only the banks the profile carries, with filing, index and instructions', () => {
    const cortex = scratch();
    mkdirSync(join(cortex, 'projects', 'personal', 'homelab', 'memories'), { recursive: true });
    writeFileSync(join(cortex, 'cerebro.json'), JSON.stringify({ layout: 'projects', default_org: 'personal', instructions: 'AGENTS.md' }));
    writeFileSync(join(cortex, 'AGENTS.md'), 'Read INDEX.md first.');
    writeFileSync(
      join(cortex, 'projects', 'personal', 'homelab', 'memories', 'nas.md'),
      '---\nname: nas\ndescription: About the NAS\nmetadata:\n  type: reference\n  org: personal\n  project: homelab\n---\n\nFact.\n',
    );
    const client = scratch();
    bank(client, 'theirs');
    const registry: BankRegistryV2 = {
      version: 2,
      banks: [
        { slug: 'cortex', path: cortex, role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
        { slug: 'client', path: client, role: 'readonly', enabled: true, profiles: { kind: 'profiles', profileIds: ['work'] } },
        { slug: 'gone', path: join(scratch(), 'nope'), role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
      ],
      defaultSlug: 'cortex',
    };
    expect(banksForProfile({ registry, profileId: 'home' }).map((b) => b.slug)).toEqual(['cortex']);
    expect(banksForProfile({ registry, profileId: 'work' }).map((b) => b.slug)).toEqual(['cortex', 'client']);

    const [described] = describeBanksForRun({ registry, profileId: 'home', cwd: '/w/homelab', toolsAvailable: true, today: '2026-09-15' });
    expect(described).toMatchObject({
      slug: 'cortex',
      name: 'cortex',
      isDefault: true,
      readonly: false,
      format: 'legacy-projects',
      layout: 'projects',
      home: 'banks/cortex',
      filing: { levels: ['org', 'project'], place: 'projects/{org}/{project}/memories/{name}.md' },
      instructions: 'Read INDEX.md first.',
      tools: true,
    });
    expect(described?.index).toEqual({ text: '- [Nas](banks/cortex/nas.md) — About the NAS', indexed: 1, total: 1 });
    expect(described?.cli).toBe('bin/cerebro');

    const work = describeBanksForRun({ registry, profileId: 'work', fallbackCli: '/vendored/cerebro' });
    expect(work.map((b) => b.slug)).toEqual(['cortex', 'client']);
    expect(work[1]).toMatchObject({ readonly: true, format: 'legacy-flat', cli: '/vendored/cerebro' });
    expect(work[1]).not.toHaveProperty('instructions');
  });
});
