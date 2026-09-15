/**
 * The memory-bank prompt for the machine this process runs on.
 *
 * The desktop composes it in its engine, from its own registry, gated by its
 * own master switch. The headless server has no engine and no switch, but it
 * has the same registry — Artemis's own `memory-banks.json` in the host's data
 * directory, with the CLI's `config.json` folded in when that one is newer —
 * and a served run executes here, among *these* banks. So the server composes
 * the same text the desktop would, from the same reader and the same renderer,
 * and the client keeps its own bank prompt at home.
 *
 * Three things the run decides rather than the machine. Its **profile**: a
 * bank attached to one account is not described to another, which is the whole
 * point of the scope the v2 registry holds and the CLI's could not. Its
 * **directory**: the index each bank carries is the slice of it that applies
 * to the project about to start. Its **provider**: a harness that loads the
 * project's memory file itself is told where the index is, and one that does
 * not is handed the index inline — see `renderMemoryBanksPrompt`.
 *
 * Nothing here spawns — see `registryV2.ts` and `formats.ts` — so it is safe
 * on the path of every served turn.
 */

import { renderMemoryBanksPrompt } from '@rx-artemis/protocol';

import { describeBanksForRun } from './describe.js';
import { embeddedCli, LEGACY_BANK_SLUG, legacyBankRoot, registryPath } from './registry.js';
import {
  readRegistryV2,
  writeRegistryV2,
  REGISTRY_V2_VERSION,
  scopeCoversProfile,
  type BankRegistryV2,
} from './registryV2.js';
import { sharedIndexBudget } from './sync.js';

export interface MachineBankPromptOptions {
  /** The host's data directory: where Artemis's own `memory-banks.json` lives. */
  readonly dataDir: string;
  /** The CLI's registry file to stay in step with. Defaults to the CLI's own location. */
  readonly cliRegistryPath?: string;
  /** Where the single-bank era's clone would be. Defaults to the CLI's own. */
  readonly legacyRoot?: string;
  /** The run's account. A bank scoped away from it is not described. */
  readonly profileId?: string;
  /** The run's working directory, for each bank's index. */
  readonly cwd?: string;
  /** The serving provider, for whether the index is carried in the prompt itself. */
  readonly providerId?: string;
}

const NOTHING: BankRegistryV2 = { version: REGISTRY_V2_VERSION, banks: [], defaultSlug: null };

/**
 * The single-bank era's clone, as a registry of one.
 *
 * A machine whose banks were only ever the CLI's — a clone in the old place
 * and no registry of either generation — keeps working, under the slug the
 * CLI kept stable for it. The embedded CLI is the evidence that the directory
 * really is that clone rather than some other checkout at the same path, which
 * is the test `banksOnDisk` has always applied.
 */
function legacyRegistry(root: string): BankRegistryV2 {
  if (root.length === 0 || embeddedCli(root) === null) return NOTHING;
  return {
    version: REGISTRY_V2_VERSION,
    banks: [
      { slug: LEGACY_BANK_SLUG, path: root, role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
    ],
    defaultSlug: LEGACY_BANK_SLUG,
  };
}

/**
 * The prompt for this machine's banks as this run should meet them, or
 * `undefined` when there are none to describe — the answer that leaves the
 * provider's preset untouched.
 */
export function machineBankPrompt(options: MachineBankPromptOptions): string | undefined {
  const where = {
    dataDir: options.dataDir,
    cliRegistryPath: options.cliRegistryPath ?? registryPath(),
  };
  const { registry, dirty } = readRegistryV2(where);
  if (dirty) {
    try {
      writeRegistryV2(where, registry);
    } catch {
      // The write is a courtesy to the next read — an import of the CLI's
      // file, or a re-reconciliation. This run already holds the answer, and a
      // read-only data directory must not cost it its banks.
    }
  }
  const effective =
    registry.banks.length > 0 ? registry : legacyRegistry(options.legacyRoot ?? legacyBankRoot());
  // The run's share of a project's index allowance: one bank keeps nearly all
  // of it, several divide it, so the inline index a non-Claude provider gets
  // is bounded the same way the installed file is.
  const inScope = effective.banks.filter(
    (bank) => bank.enabled && scopeCoversProfile(bank.profiles, options.profileId),
  ).length;
  const banks = describeBanksForRun({
    registry: effective,
    ...(options.profileId === undefined ? {} : { profileId: options.profileId }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    budget: sharedIndexBudget(inScope),
    // The memory tools are the desktop's MCP surface; a host that has them
    // says so itself. Neither host offers them on this path today.
    toolsAvailable: false,
  });
  if (banks.length === 0) return undefined;
  return renderMemoryBanksPrompt(banks, {
    // A Claude harness loads the project's memory file itself, so inlining
    // would say everything twice; every other provider would otherwise have to
    // go and read a file outside its working tree, which most cannot.
    inlineIndex: options.providerId !== undefined && options.providerId !== 'claude',
  });
}

/**
 * Several appends as one, joined the way the desktop engine joins a run's
 * own append with the library: a blank line between, nothing around. Empty
 * and absent parts vanish, and nothing at all is `undefined` rather than
 * `''` — an append carrying nothing would still cost a prompt-cache round to
 * say nothing.
 */
export function joinSystemPromptAppends(
  ...parts: readonly (string | undefined)[]
): string | undefined {
  const kept = parts.map((part) => part?.trim() ?? '').filter((part) => part.length > 0);
  return kept.length === 0 ? undefined : kept.join('\n\n');
}
