/**
 * Instructions — the prompts the agent is told before the conversation starts.
 * ============================================================================
 *
 * Text the user wrote, appended to the system prompt of every run it is scoped
 * to. The library itself lives in `AgentsSection.tsx`, named for the frozen
 * section id that resolves here; this file owns what the pane creates around it
 * — the title row and its save state, and the one sentence that says where the
 * other half went.
 *
 * The memory banks were composed under this pane for a while, on the argument
 * that a bank is the best-known instance of the rule the prompts state. The
 * argument still holds and the pane no longer does: a bank now carries a name,
 * a description, a format, a set of profiles and a per-entry validation report,
 * and none of that reads as a footnote under someone else's heading. They have
 * their own section again — see `MemoryBanksSection.tsx` — and what stays here
 * is the pointer to it, because the built-in prompt above is still the thing
 * that tells an agent the banks exist.
 *
 * The banks are still *read* here, and only for that prompt: whether the
 * built-in row is actually reaching the model is the conjunction `engine.ts`
 * composes runs with, and `banksAvailability` derives it from the same
 * reading the banks pane renders from. Two sources of truth for "is this
 * prompt live" is the one failure this surface must not have.
 */

import type { ReactElement } from 'react';

import { useAgentPrompts } from '../../hooks/useAgentPrompts';
import { banksAvailability, useMemoryBanks } from '../../hooks/useMemoryBanks';
import { AgentPromptsGroups, SaveIndicator } from './AgentsSection';
import { SettingsPane } from './pane';

export function InstructionsSection(): ReactElement {
  const prompts = useAgentPrompts();
  const banks = useMemoryBanks();

  return (
    <SettingsPane
      title="Instructions"
      description="What the agent is told before the conversation starts: prompts you write once and every run carries."
      actions={<SaveIndicator pane={prompts} />}
    >
      <AgentPromptsGroups pane={prompts} banksAvailable={banksAvailability(banks.status)} />

      <p className="text-2xs leading-relaxed text-ink-faint">
        The prompts above are instructions you state. The other half — your team&rsquo;s shared
        repositories of durable facts, which the agents maintain themselves — is under{' '}
        <em>Memory banks</em> in the list on the left.
      </p>
    </SettingsPane>
  );
}
