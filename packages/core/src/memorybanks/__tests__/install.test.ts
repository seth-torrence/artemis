/**
 * The index block and the install into a project's memory, against real
 * directories. The shapes here are the CLI's — markers, paths, the scoped
 * index — so the assertions double as the compatibility contract.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bankHome,
  beginMarker,
  endMarker,
  entryIndexedFor,
  isInstallableProjectKey,
  projectKey,
  renderIndexBlock,
  replaceBlock,
  stripBlock,
} from '../bankIndex.js';
import { readBankAt } from '../formats.js';
import { installBank, profileProjectKeys, readGitHead, readProfileDirs, uninstallBank } from '../install.js';
import type { BankEntry } from '../model.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-bank-install-'));
}

function entry(name: string, extra: Partial<BankEntry> = {}): BankEntry {
  return {
    name,
    title: name,
    description: `About ${name}`,
    body: 'Fact.',
    file: `memories/${name}.md`,
    scope: {},
    type: 'reference',
    added: null,
    author: null,
    appliesTo: [],
    data: { name, description: `About ${name}`, metadata: { type: 'reference' } },
    problems: [],
    warnings: [],
    ...extra,
  };
}

describe('the CLI\'s addresses, kept', () => {
  it('namespaces markers and homes, except for the legacy slug', () => {
    expect(beginMarker('cortex')).toBe('<!-- cerebro:cortex:begin -->');
    expect(endMarker('cortex')).toBe('<!-- cerebro:cortex:end -->');
    expect(beginMarker('cerebro')).toBe('<!-- cerebro:begin -->');
    expect(bankHome('cortex')).toBe('banks/cortex');
    expect(bankHome('cerebro')).toBe('cerebro');
  });

  it('flattens a project path to its key', () => {
    const key = projectKey(join(tmpdir(), 'some.repo'));
    expect(key).toMatch(/^[A-Za-z0-9-]+$/);
    expect(key.endsWith('-some-repo')).toBe(true);
    expect(key).toBe(projectKey(join(tmpdir(), 'x', '..', 'some.repo')));
  });

  it('skips worktrees and scratch trees', () => {
    expect(isInstallableProjectKey('C--Users-david-claude')).toBe(true);
    expect(isInstallableProjectKey('C--Users-david-claude-artemis--claude-worktrees-agent-1')).toBe(false);
    expect(isInstallableProjectKey('-private-tmp-x')).toBe(false);
    expect(isInstallableProjectKey('-tmp-x')).toBe(false);
  });

  it('scopes an entry to a project by directory name', () => {
    const scoped = entry('a', { appliesTo: ['artemis'] });
    expect(entryIndexedFor(scoped, 'C--Users-david-claude-artemis')).toBe(true);
    expect(entryIndexedFor(scoped, 'C--Users-david-claude-cortex')).toBe(false);
    expect(entryIndexedFor(entry('b'), 'anything')).toBe(true);
  });
});

describe('renderIndexBlock', () => {
  const base = { slug: 'cortex', projectKey: 'C--x-cortex', repo: '/b/cortex', source: 'artemis@1234567', today: '2026-09-15' };

  it('lists what applies and counts what does not', () => {
    const block = renderIndexBlock({
      ...base,
      entries: [entry('one'), entry('two', { appliesTo: ['elsewhere'] })],
      budget: { lines: 80, bytes: 12_000 },
    });
    expect(block.text.split('\n')[0]).toBe('<!-- cerebro:cortex:begin -->');
    expect(block.text).toContain('- [one](banks/cortex/one.md) — About one');
    expect(block.text).not.toContain('two.md');
    expect(block.text).toContain('plus 1 memories scoped to other repos');
    expect(block.text.endsWith('<!-- cerebro:cortex:end -->')).toBe(true);
    expect(block.indexed).toBe(1);
    expect(block.elsewhere).toBe(1);
  });

  it('stops at the budget and says how many more there are', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`m${String(i)}`));
    const block = renderIndexBlock({ ...base, entries, budget: { lines: 3, bytes: 12_000 } });
    expect(block.indexed).toBe(3);
    expect(block.cut).toBe(7);
    expect(block.text).toContain('plus 7 more on disk in banks/cortex/');
  });

  it('always lists at least one entry, however small the byte budget', () => {
    const block = renderIndexBlock({ ...base, entries: [entry('long')], budget: { lines: 10, bytes: 5 } });
    expect(block.indexed).toBe(1);
  });
});

describe('marked blocks', () => {
  it('replaces in place, appends when absent, and strips cleanly', () => {
    const begin = beginMarker('a');
    const end = endMarker('a');
    const block = `${begin}\n- x\n${end}`;
    expect(replaceBlock('', block, begin, end)).toBe(`${block}\n`);
    const appended = replaceBlock('# Mine\n', block, begin, end);
    expect(appended).toBe(`# Mine\n\n${block}\n`);
    const replaced = replaceBlock(appended, `${begin}\n- y\n${end}`, begin, end);
    expect(replaced).toContain('- y');
    expect(replaced).not.toContain('- x');
    expect(stripBlock(replaced, begin, end)).toBe('# Mine\n');
    expect(stripBlock(`${block}\n`, begin, end)).toBe('');
  });
});

describe('installBank', () => {
  function bankDir(): string {
    const dir = scratch();
    mkdirSync(join(dir, 'memories'));
    writeFileSync(join(dir, 'memories', 'one.md'), '---\nname: one\ndescription: First\nmetadata:\n  type: reference\n---\n\nOne.\n');
    writeFileSync(join(dir, 'memories', 'two.md'), '---\nname: two\ndescription: Second\nmetadata:\n  type: reference\n  applies_to: elsewhere\n---\n\nTwo.\n');
    writeFileSync(join(dir, 'memories', 'bad.md'), 'no frontmatter');
    return dir;
  }

  it('writes the valid entries, indexes the scoped ones, and prunes the stale', () => {
    const dir = bankDir();
    const bank = readBankAt(dir, { slug: 'team' });
    expect(bank).not.toBeNull();
    const memoryDir = join(scratch(), 'memory');
    mkdirSync(join(memoryDir, 'banks', 'team'), { recursive: true });
    writeFileSync(join(memoryDir, 'banks', 'team', 'stale.md'), 'old');
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# My own notes\n');
    writeFileSync(join(memoryDir, 'one.md'), 'a personal memory at the same slug');

    const report = installBank(bank!, { slug: 'team', memoryDir, projectKey: 'C--x-here', source: 'artemis@abc1234', today: '2026-09-15' });
    expect(report).toEqual({ installed: 2, pruned: 1, indexed: 1, shadowed: ['one'], refused: null });
    expect(readdirSync(join(memoryDir, 'banks', 'team')).sort()).toEqual(['one.md', 'two.md']);
    const installed = readFileSync(join(memoryDir, 'banks', 'team', 'one.md'), 'utf8');
    expect(installed).toContain('source: artemis@abc1234');
    expect(installed).toContain('bank: team');
    expect(installed).toContain('synced: 2026-09-15');
    expect(installed).toContain('\nOne.\n');
    const index = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(index.startsWith('# My own notes\n')).toBe(true);
    expect(index).toContain('- [One](banks/team/one.md) — First');
    expect(index).toContain('plus 1 memories scoped to other repos');
  });

  it('refuses to install a bank with nothing valid over what is there', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'memories'));
    writeFileSync(join(dir, 'memories', 'bad.md'), 'nope');
    const bank = readBankAt(dir, { slug: 'team' });
    const memoryDir = join(scratch(), 'memory');
    mkdirSync(join(memoryDir, 'banks', 'team'), { recursive: true });
    writeFileSync(join(memoryDir, 'banks', 'team', 'keep.md'), 'still here');
    const report = installBank(bank!, { slug: 'team', memoryDir, projectKey: 'k', source: 's', today: 'd' });
    expect(report.refused).toContain('refusing to install an empty bank');
    expect(existsSync(join(memoryDir, 'banks', 'team', 'keep.md'))).toBe(true);
  });

  it('uses the legacy home and unprefixed markers for the legacy slug', () => {
    const dir = bankDir();
    const bank = readBankAt(dir, { slug: 'cerebro' });
    const memoryDir = join(scratch(), 'memory');
    installBank(bank!, { slug: 'cerebro', memoryDir, projectKey: 'k', source: 's', today: 'd' });
    expect(existsSync(join(memoryDir, 'cerebro', 'one.md'))).toBe(true);
    const installed = readFileSync(join(memoryDir, 'cerebro', 'one.md'), 'utf8');
    expect(installed).not.toContain('bank: cerebro');
    const index = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(index).toContain('<!-- cerebro:begin -->');
    expect(index).toContain('(cerebro/one.md)');
  });

  it('uninstalls the copies and the block, removing an emptied index', () => {
    const dir = bankDir();
    const bank = readBankAt(dir, { slug: 'team' });
    const memoryDir = join(scratch(), 'memory');
    installBank(bank!, { slug: 'team', memoryDir, projectKey: 'k', source: 's', today: 'd' });
    uninstallBank('team', memoryDir);
    expect(existsSync(join(memoryDir, 'banks'))).toBe(false);
    expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(false);
  });
});

describe('where the profiles are', () => {
  it('reads profiles.json and lists a profile\'s installable projects', () => {
    const root = scratch();
    const configDir = join(root, 'profiles', 'one');
    mkdirSync(join(configDir, 'projects', 'C--x-repo'), { recursive: true });
    mkdirSync(join(configDir, 'projects', 'C--x-repo--claude-worktrees-a'), { recursive: true });
    mkdirSync(join(configDir, 'projects', '-tmp-scratch'), { recursive: true });
    writeFileSync(join(root, 'profiles.json'), JSON.stringify({ profiles: [{ id: 'p1', label: 'One', configDir }, { label: 'Gone', configDir: join(root, 'nope') }] }));
    expect(readProfileDirs(root)).toEqual([{ id: 'p1', label: 'One', configDir }]);
    expect(profileProjectKeys(configDir)).toEqual(['C--x-repo']);
  });
});

describe('readGitHead', () => {
  it('reads a branch head from a loose or packed ref without spawning', () => {
    const repo = scratch();
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), 'abcdef0123456789\n');
    expect(readGitHead(repo)).toBe('abcdef0');
    const packed = scratch();
    mkdirSync(join(packed, '.git'));
    writeFileSync(join(packed, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(packed, '.git', 'packed-refs'), '# pack-refs\n1234567890abcdef refs/heads/main\n');
    expect(readGitHead(packed)).toBe('1234567');
    expect(readGitHead(scratch())).toBeNull();
  });
});
