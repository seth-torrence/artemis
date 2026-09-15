/**
 * What a run is told about the banks, from the v2 registry and the banks
 * themselves.
 *
 * Both hosts ask this: the desktop before every run, the headless server
 * before every served turn. The answer is scoped to the run's profile — a
 * bank attached to one account is not described to another — and carries
 * what the prompt renderer needs and nothing it does not: the bank's name and
 * description, how it is filed, its own instructions, and a budgeted index of
 * the entries that apply to the run's project, for a provider whose harness
 * does not load the project's memory file itself.
 */

import type { MemoryBankPromptInfo } from '@rx-artemis/protocol';

import { bankHome, projectKey, renderIndexBlock } from './bankIndex.js';
import { readBankAt } from './formats.js';
import { sourceStamp } from './install.js';
import { installableEntries, type Bank, type IndexBudget } from './model.js';
import { embeddedCli } from './registry.js';
import { scopeCoversProfile, type BankRecord, type BankRegistryV2 } from './registryV2.js';

export interface RunBanksOptions {
  readonly registry: BankRegistryV2;
  /**
   * The run's profile. Absent means a run that names no account, which only
   * the banks attached to every profile reach — a bank attached to a chosen
   * set is never described to a run that cannot say it is one of them.
   */
  readonly profileId?: string;
}

/** The banks a run on this profile should know about: enabled, in scope, and on disk. */
export function banksForProfile(options: RunBanksOptions): BankRecord[] {
  return options.registry.banks.filter(
    (bank) => bank.enabled && scopeCoversProfile(bank.profiles, options.profileId) && readBankAt(bank.path, { slug: bank.slug }) !== null,
  );
}

export interface DescribeRunBanksOptions extends RunBanksOptions {
  /** The run's working directory, for the index. Absent means an unscoped index. */
  readonly cwd?: string;
  /** Whether the memory tools are reachable from the run. */
  readonly toolsAvailable?: boolean;
  /** The CLI to name for a legacy bank that embeds none. */
  readonly fallbackCli?: string | null;
  /** ISO date for the index's managed line. Defaults to today. */
  readonly today?: string;
  /**
   * The index budget for each bank, when the host shares one allowance
   * between the banks a run carries. Absent means each bank's own.
   */
  readonly budget?: IndexBudget;
}

function describeOne(record: BankRecord, bank: Bank, isDefault: boolean, options: DescribeRunBanksOptions): MemoryBankPromptInfo {
  const entries = installableEntries(bank);
  const key = options.cwd === undefined ? '' : projectKey(options.cwd);
  const index = renderIndexBlock({
    slug: record.slug,
    entries,
    projectKey: key,
    repo: bank.root,
    source: sourceStamp(bank.root),
    today: options.today ?? new Date().toISOString().slice(0, 10),
    budget: options.budget ?? bank.indexBudget,
  });
  const instructions = record.role === 'readonly' ? undefined : (bank.instructions ?? undefined);
  const legacyLayout = bank.format === 'legacy-projects' ? 'projects' : bank.format === 'legacy-flat' ? 'flat' : undefined;
  const cli = bank.cli ?? embeddedCli(bank.root) ?? options.fallbackCli ?? 'bin/cerebro';
  return {
    slug: record.slug,
    isDefault,
    readonly: record.role === 'readonly',
    cli,
    ...(legacyLayout === undefined ? {} : { layout: legacyLayout }),
    ...(instructions === undefined ? {} : { instructions }),
    name: bank.name,
    ...(bank.description === null ? {} : { description: bank.description }),
    format: bank.format,
    home: bankHome(record.slug),
    filing: {
      levels: bank.memories.levels,
      ...(bank.memories.place === null ? {} : { place: bank.memories.place }),
    },
    index: {
      // The bullets only: the markers and the managed line belong to the file.
      text: index.text.split('\n').slice(2, -1).join('\n'),
      indexed: index.indexed,
      total: entries.length,
    },
    tools: options.toolsAvailable === true,
  };
}

/** The facts the prompt renderer needs, for the banks this run's profile carries. */
export function describeBanksForRun(options: DescribeRunBanksOptions): MemoryBankPromptInfo[] {
  const records = options.registry.banks.filter(
    (bank) => bank.enabled && scopeCoversProfile(bank.profiles, options.profileId),
  );
  const read: { record: BankRecord; bank: Bank }[] = [];
  for (const record of records) {
    const bank = readBankAt(record.path, { slug: record.slug });
    if (bank !== null) read.push({ record, bank });
  }
  const wanted = options.registry.defaultSlug;
  const resolvedDefault = read.some(({ record }) => record.slug === wanted) ? wanted : (read[0]?.record.slug ?? null);
  return read.map(({ record, bank }) => describeOne(record, bank, record.slug === resolvedDefault, options));
}
