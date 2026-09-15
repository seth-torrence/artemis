/**
 * Installing a bank into a project's memory: the files, and the index block.
 *
 * The layout is the CLI's own, kept exactly — `<configDir>/projects/<key>/
 * memory/banks/<slug>/<name>.md` beside a marked block in that project's
 * `MEMORY.md`, bare `memory/cerebro/` for the legacy slug — because Claude
 * Code's auto-memory reads that file and directory, and because a machine
 * that also runs the CLI must find one install, not two.
 *
 * Every entry lands on disk; only the ones scoped to the project land in the
 * index. The index is what a session pays context for, so it lists what this
 * repository needs, while the files stay a complete mirror so links resolve
 * and anything can be opened by name.
 *
 * One refusal, the CLI's own from 0.8.1: a bank whose every entry failed to
 * validate is not installed over what is already there. Nothing valid is not
 * the same as nothing, and pruning a project's copies down to nothing because
 * a bank broke would be the memory system erasing the memory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bankHome, beginMarker, endMarker, hasBlock, isInstallableProjectKey, renderIndexBlock, replaceBlock, stripBlock } from './bankIndex.js';
import { serializeFrontmatter } from './frontmatter.js';
import { installableEntries, type Bank, type BankEntry, type IndexBudget } from './model.js';
import { LEGACY_BANK_SLUG } from './registry.js';

export interface InstallOptions {
  readonly slug: string;
  /** `<configDir>/projects/<key>/memory` */
  readonly memoryDir: string;
  readonly projectKey: string;
  /** Provenance stamp for the managed line and each file's metadata. */
  readonly source: string;
  /** ISO date. */
  readonly today: string;
  readonly budget?: IndexBudget;
}

export interface InstallReport {
  readonly installed: number;
  readonly pruned: number;
  readonly indexed: number;
  /** Personal memories at the same slug as an installed entry. */
  readonly shadowed: readonly string[];
  /** Why nothing was written, when nothing was. */
  readonly refused: string | null;
}

/** The text of an installed copy: the entry, with where it came from added to its frontmatter. */
export function renderInstalledEntry(entry: BankEntry, extra: Readonly<Record<string, string>>): string {
  const data = entry.data ?? { name: entry.name, description: entry.description };
  const metadata = data['metadata'];
  const nested = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata);
  const ordered: Record<string, unknown> = {};
  if (data['name'] !== undefined) ordered['name'] = data['name'];
  if (data['description'] !== undefined) ordered['description'] = data['description'];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'name' || key === 'description') continue;
    ordered[key] = value;
  }
  if (nested) {
    ordered['metadata'] = { ...(metadata as Record<string, unknown>), ...extra };
  } else {
    ordered['artemis'] = { ...extra };
  }
  return serializeFrontmatter(ordered, entry.body);
}

/** Install one bank into one project's memory directory. */
export function installBank(bank: Bank, options: InstallOptions): InstallReport {
  const entries = installableEntries(bank);
  if (entries.length === 0 && bank.entries.length > 0) {
    return {
      installed: 0,
      pruned: 0,
      indexed: 0,
      shadowed: [],
      refused: `none of the ${String(bank.entries.length)} file(s) in ${bank.root} validates — refusing to install an empty bank over what is already installed`,
    };
  }
  const home = join(options.memoryDir, bankHome(options.slug));
  mkdirSync(home, { recursive: true });

  const keep = new Set(entries.map((entry) => `${entry.name}.md`));
  let pruned = 0;
  for (const existing of readdirSync(home)) {
    if (existing.endsWith('.md') && !keep.has(existing)) {
      unlinkSync(join(home, existing));
      pruned += 1;
    }
  }

  const extra: Record<string, string> = {
    repo: bank.root,
    source: options.source,
    synced: options.today,
    ...(options.slug === LEGACY_BANK_SLUG ? {} : { bank: options.slug }),
  };
  const shadowed: string[] = [];
  for (const entry of entries) {
    if (existsSync(join(options.memoryDir, `${entry.name}.md`))) shadowed.push(entry.name);
    writeFileSync(join(home, `${entry.name}.md`), renderInstalledEntry(entry, extra), 'utf8');
  }

  const block = renderIndexBlock({
    slug: options.slug,
    entries,
    projectKey: options.projectKey,
    repo: bank.root,
    source: options.source,
    today: options.today,
    budget: options.budget ?? bank.indexBudget,
  });
  const indexFile = join(options.memoryDir, 'MEMORY.md');
  const current = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '';
  writeFileSync(indexFile, replaceBlock(current, block.text, beginMarker(options.slug), endMarker(options.slug)), 'utf8');

  return { installed: entries.length, pruned, indexed: block.indexed, shadowed, refused: null };
}

/** Remove one bank's copies and its block from one project's memory directory. */
export function uninstallBank(slug: string, memoryDir: string): void {
  const home = join(memoryDir, bankHome(slug));
  if (existsSync(home)) {
    for (const existing of readdirSync(home)) {
      if (existing.endsWith('.md')) unlinkSync(join(home, existing));
    }
    try {
      rmdirSync(home);
    } catch {
      // Something of the user's is in there; leave it.
    }
    if (slug !== LEGACY_BANK_SLUG) {
      try {
        rmdirSync(join(memoryDir, 'banks'));
      } catch {
        // Other banks remain.
      }
    }
  }
  const indexFile = join(memoryDir, 'MEMORY.md');
  if (!existsSync(indexFile)) return;
  const current = readFileSync(indexFile, 'utf8');
  if (!hasBlock(current, slug)) return;
  const stripped = stripBlock(current, beginMarker(slug), endMarker(slug));
  if (stripped.length === 0) unlinkSync(indexFile);
  else writeFileSync(indexFile, stripped, 'utf8');
}

/** Is a bank installed in this project's memory directory? */
export function isInstalled(slug: string, memoryDir: string): boolean {
  try {
    return statSync(join(memoryDir, bankHome(slug))).isDirectory();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Where the profiles keep their projects                                     */
/* -------------------------------------------------------------------------- */

export interface ArtemisProfileDir {
  /** The profile's id, the thing a bank's scope names. Empty for a file that predates ids. */
  readonly id: string;
  readonly label: string;
  readonly configDir: string;
}

/** The profiles a data directory's `profiles.json` names, those whose directory exists. */
export function readProfileDirs(dataDir: string): ArtemisProfileDir[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dataDir, 'profiles.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const list = (raw as Record<string, unknown>)['profiles'];
  if (!Array.isArray(list)) return [];
  const out: ArtemisProfileDir[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const configDir = record['configDir'];
    if (typeof configDir !== 'string' || configDir.length === 0) continue;
    try {
      if (!statSync(configDir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({
      id: typeof record['id'] === 'string' ? record['id'] : '',
      label: typeof record['label'] === 'string' ? record['label'] : '',
      configDir,
    });
  }
  return out;
}

/** The project keys a profile has memory directories for, worktrees and scratch trees excluded. */
export function profileProjectKeys(configDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(configDir, 'projects'));
  } catch {
    return [];
  }
  return names
    .filter((name) => isInstallableProjectKey(name))
    .filter((name) => {
      try {
        return statSync(join(configDir, 'projects', name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** `<configDir>/projects/<key>/memory` */
export function projectMemoryDir(configDir: string, key: string): string {
  return join(configDir, 'projects', key, 'memory');
}

/* -------------------------------------------------------------------------- */
/* Provenance without spawning                                                */
/* -------------------------------------------------------------------------- */

/**
 * The short commit a checkout is at, read from `.git` without running git —
 * this is asked on the path of a run start. `null` for anything but a plain
 * checkout on a branch or a detached head with a packed or loose ref.
 */
export function readGitHead(root: string): string | null {
  let gitDir = join(root, '.git');
  try {
    const stat = statSync(gitDir);
    if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (pointer === null) return null;
      gitDir = join(root, pointer[1]?.trim() ?? '');
    }
  } catch {
    return null;
  }
  let head: string;
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (ref === null) return /^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, 7) : null;
  const refName = ref[1]?.trim() ?? '';
  const commonDir = ((): string => {
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      return join(gitDir, common);
    } catch {
      return gitDir;
    }
  })();
  try {
    return readFileSync(join(commonDir, refName), 'utf8').trim().slice(0, 7);
  } catch {
    // A packed ref, then.
  }
  try {
    const packed = readFileSync(join(commonDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((entry) => entry.endsWith(` ${refName}`));
    return line === undefined ? null : line.slice(0, 7);
  } catch {
    return null;
  }
}

/** `artemis@<sha>`, or `artemis@unknown` for a bank that is not a checkout. */
export function sourceStamp(root: string): string {
  return `artemis@${readGitHead(root) ?? 'unknown'}`;
}
