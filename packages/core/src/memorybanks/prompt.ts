/**
 * The memory-bank prompt for the machine this process runs on.
 *
 * The desktop composes it in its engine, from its own registry, gated by its
 * own master switch. The headless server has no engine and no switch, but it
 * has the same registry — the CLI's `~/.config/cerebro/config.json` under the
 * process's home — and a served run executes here, among *these* banks. So
 * the server composes the same text the desktop would, from the same reader
 * and the same renderer, and the client keeps its own bank prompt at home.
 *
 * Consent is the CLI's: a bank is described only if `cerebro enable` left it
 * enabled in the registry and it is present on disk. Nothing here spawns —
 * see `registry.ts` — so it is safe on the path of every served turn.
 */

import { renderMemoryBanksPrompt } from '@rx-artemis/protocol';

import { describeBanksForPrompt, legacyBankRoot, readRegistry, registryPath } from './registry.js';

export interface MachineBankPromptOptions {
  /** The registry file to read. Defaults to the CLI's own location. */
  readonly registryPath?: string;
  /** Where the single-bank era's clone would be. Defaults to the CLI's own. */
  readonly legacyRoot?: string;
}

/**
 * The prompt for this machine's banks, or `undefined` when it has none to
 * describe — the answer that leaves the provider's preset untouched.
 */
export function machineBankPrompt(options: MachineBankPromptOptions = {}): string | undefined {
  const banks = describeBanksForPrompt({
    registry: readRegistry(options.registryPath ?? registryPath()),
    legacyRoot: options.legacyRoot ?? legacyBankRoot(),
  });
  if (banks.length === 0) return undefined;
  return renderMemoryBanksPrompt(banks);
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
