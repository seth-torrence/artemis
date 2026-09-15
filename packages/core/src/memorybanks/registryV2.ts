/**
 * Artemis's own record of the machine's banks, with what the CLI's could not
 * hold: which profiles each bank reaches.
 *
 * `memory-banks.json` in the host's data directory. The CLI's registry
 * (`~/.config/cerebro/config.json`, read by `registry.ts`) stays in step in
 * both directions: it is imported the first time this file is missing, it is
 * re-read whenever it is newer than this one — so `cerebro setup`, `forget`,
 * `enable` and `disable` run by hand still take effect — and the fields it
 * understands are mirrored back after every write here, so a machine that
 * also runs stock Claude Code with the CLI's hook keeps syncing the same
 * banks. Two writers, reconciled by modification time; the CLI never learns
 * about profile scope and never has to.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseRegistry, type BankRegistry, type RegistryBank } from './registry.js';

export const REGISTRY_V2_FILE = 'memory-banks.json';
export const REGISTRY_V2_VERSION = 2;

/**
 * Which profiles a bank reaches. `all` covers profiles added later; a list
 * means exactly those — the same distinction the prompt library draws.
 */
export type BankProfileScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'profiles'; readonly profileIds: readonly string[] };

export interface BankRecord extends RegistryBank {
  readonly profiles: BankProfileScope;
}

export interface BankRegistryV2 {
  readonly version: 2;
  readonly banks: readonly BankRecord[];
  readonly defaultSlug: string | null;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function scopeCoversProfile(scope: BankProfileScope, profileId: string | undefined): boolean {
  if (scope.kind === 'all') return true;
  return profileId !== undefined && scope.profileIds.includes(profileId);
}

export function registryV2Path(dataDir: string): string {
  return join(dataDir, REGISTRY_V2_FILE);
}

function parseScope(value: unknown): BankProfileScope {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'profiles' && Array.isArray(record['profileIds'])) {
      return {
        kind: 'profiles',
        profileIds: record['profileIds'].filter((id): id is string => typeof id === 'string'),
      };
    }
  }
  return { kind: 'all' };
}

/** Parse the v2 file. `null` for anything that is not one. */
export function parseRegistryV2(text: string): BankRegistryV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== REGISTRY_V2_VERSION || !Array.isArray(record['banks'])) return null;
  const banks: BankRecord[] = [];
  for (const entry of record['banks']) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const slug = item['slug'];
    const path = item['path'];
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) continue;
    if (typeof path !== 'string' || path.length === 0) continue;
    if (banks.some((bank) => bank.slug === slug)) continue;
    banks.push({
      slug,
      path,
      role: item['role'] === 'readonly' ? 'readonly' : 'readwrite',
      enabled: item['enabled'] !== false,
      profiles: parseScope(item['profiles']),
    });
  }
  const wanted = record['default'];
  const defaultSlug = banks.some((bank) => bank.slug === wanted) ? (wanted as string) : (banks[0]?.slug ?? null);
  return { version: REGISTRY_V2_VERSION, banks, defaultSlug };
}

/** Lift the CLI's registry into a v2 one: every bank reaches every profile. */
export function fromCliRegistry(registry: BankRegistry): BankRegistryV2 {
  return {
    version: REGISTRY_V2_VERSION,
    banks: registry.banks.map((bank) => ({ ...bank, profiles: { kind: 'all' } })),
    defaultSlug: registry.defaultSlug,
  };
}

/**
 * Bring a v2 registry up to date with a newer CLI registry.
 *
 * The CLI's answer wins for what it knows — which banks exist, their paths,
 * roles, enabled flags and the default — and the v2 record keeps what the CLI
 * cannot know, the profile scope. A CLI registry that lists nothing is left
 * alone: a corrupt or emptied file must not drop every bank on this machine.
 */
export function reconcileWithCli(current: BankRegistryV2, cli: BankRegistry): BankRegistryV2 {
  if (cli.banks.length === 0) return current;
  const banks: BankRecord[] = cli.banks.map((bank) => {
    const known = current.banks.find((entry) => entry.slug === bank.slug);
    return { ...bank, profiles: known?.profiles ?? { kind: 'all' } };
  });
  const defaultSlug = banks.some((bank) => bank.slug === cli.defaultSlug) ? cli.defaultSlug : (banks[0]?.slug ?? null);
  return { version: REGISTRY_V2_VERSION, banks, defaultSlug };
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

export interface ReadRegistryV2Options {
  readonly dataDir: string;
  /** The CLI's registry file, when this machine has one to stay in step with. */
  readonly cliRegistryPath?: string;
}

export interface ReadRegistryV2Result {
  readonly registry: BankRegistryV2;
  /** The v2 file needs writing: it was missing, or the CLI's was newer. */
  readonly dirty: boolean;
}

/** The machine's banks, from the v2 file with the CLI's folded in when newer. Never throws. */
export function readRegistryV2(options: ReadRegistryV2Options): ReadRegistryV2Result {
  const path = registryV2Path(options.dataDir);
  let current: BankRegistryV2 | null = null;
  try {
    current = parseRegistryV2(readFileSync(path, 'utf8'));
  } catch {
    current = null;
  }
  const cliPath = options.cliRegistryPath;
  const cli = cliPath === undefined || !existsSync(cliPath) ? null : parseRegistry(readFileSync(cliPath, 'utf8'));

  if (current === null) {
    const empty: BankRegistryV2 = { version: REGISTRY_V2_VERSION, banks: [], defaultSlug: null };
    const registry = cli === null ? empty : fromCliRegistry(cli);
    return { registry, dirty: cli !== null && cli.banks.length > 0 };
  }
  if (cli !== null && cliPath !== undefined && mtimeOf(cliPath) > mtimeOf(path)) {
    const reconciled = reconcileWithCli(current, cli);
    return { registry: reconciled, dirty: JSON.stringify(reconciled) !== JSON.stringify(current) };
  }
  return { registry: current, dirty: false };
}

function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename is what mattered.
    }
    throw error;
  }
}

/** The v2 file's text, stable key order so a no-op write is byte-identical. */
export function renderRegistryV2(registry: BankRegistryV2): string {
  const banks = registry.banks.map((bank) => ({
    slug: bank.slug,
    path: bank.path,
    role: bank.role,
    enabled: bank.enabled,
    profiles: bank.profiles.kind === 'all' ? { kind: 'all' } : { kind: 'profiles', profileIds: [...bank.profiles.profileIds] },
  }));
  return `${JSON.stringify({ version: REGISTRY_V2_VERSION, banks, ...(registry.defaultSlug === null ? {} : { default: registry.defaultSlug }) }, null, 2)}\n`;
}

/**
 * The CLI's file with this registry's banks in it, keeping any other keys the
 * file already had. `bank` mirrors the default's path for the pre-multi-bank
 * CLI, as the CLI's own writer does.
 */
export function renderCliRegistry(registry: BankRegistryV2, existingText: string | null): string {
  let existing: Record<string, unknown> = {};
  if (existingText !== null) {
    try {
      const parsed = JSON.parse(existingText.replace(/^﻿/, '')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const banks = registry.banks.map((bank) => ({ slug: bank.slug, path: bank.path, role: bank.role, enabled: bank.enabled }));
  const fallback = registry.banks.find((bank) => bank.slug === registry.defaultSlug) ?? registry.banks[0];
  const next: Record<string, unknown> = { ...existing, banks };
  if (registry.defaultSlug !== null) next['default'] = registry.defaultSlug;
  else delete next['default'];
  if (fallback !== undefined) next['bank'] = fallback.path;
  else delete next['bank'];
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Write the v2 file, mirror the CLI's, and leave the v2 file the newer of the
 * two so the next read does not fold the mirror straight back in.
 */
export function writeRegistryV2(options: ReadRegistryV2Options, registry: BankRegistryV2): void {
  const path = registryV2Path(options.dataDir);
  atomicWrite(path, renderRegistryV2(registry));
  const cliPath = options.cliRegistryPath;
  if (cliPath !== undefined) {
    let existing: string | null = null;
    try {
      existing = readFileSync(cliPath, 'utf8');
    } catch {
      existing = null;
    }
    const mirrored = renderCliRegistry(registry, existing);
    if (existing === null || existing.replace(/\r\n/g, '\n') !== mirrored) {
      try {
        atomicWrite(cliPath, mirrored);
      } catch {
        // The CLI's file is a courtesy to the CLI; Artemis's own record is written.
      }
    }
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // Ordering by mtime is best-effort; the content is what matters.
    }
  }
}

/** A registry with one bank's record replaced or appended. */
export function withBank(registry: BankRegistryV2, record: BankRecord): BankRegistryV2 {
  const present = registry.banks.some((bank) => bank.slug === record.slug);
  const banks = present ? registry.banks.map((bank) => (bank.slug === record.slug ? record : bank)) : [...registry.banks, record];
  return { ...registry, banks, defaultSlug: registry.defaultSlug ?? record.slug };
}

/** A registry without one bank. */
export function withoutBank(registry: BankRegistryV2, slug: string): BankRegistryV2 {
  const banks = registry.banks.filter((bank) => bank.slug !== slug);
  const defaultSlug = banks.some((bank) => bank.slug === registry.defaultSlug) ? registry.defaultSlug : (banks[0]?.slug ?? null);
  return { ...registry, banks, defaultSlug };
}
