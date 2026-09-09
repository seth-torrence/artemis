/**
 * Capability lookup.
 *
 * Artemis drives three providers with three unrelated transports, and the UI has
 * to degrade against whichever one is active rather than assume they can all
 * do everything. Every gated control asks this hook the same question and gets
 * back both the answer and the sentence to show the user — so an unsupported
 * control renders disabled *with an explanation*, never silently missing.
 */

import type { Capabilities, PermissionMode, ProviderId } from '@rx-artemis/protocol';
import { activeCapabilities, activeProviderLabel } from '../state/store';
import { usePane } from '../state/paneContext';

/** The boolean fields of {@link Capabilities}. */
export type CapabilityKey = {
  [K in keyof Capabilities]-?: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities];

/** How each capability is described in a tooltip. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  interactivePermissions: 'interactive tool approval',
  partialMessages: 'token-by-token streaming',
  midRunSteering: 'sending messages mid-run',
  forkSession: 'forking a session',
  listSessions: 'listing past sessions',
  subagents: 'subagents',
  subagentTranscripts: "opening a subagent's transcript",
  renameSession: 'renaming a session',
  deleteSession: 'deleting a session',
  tagSession: 'archiving a session',
  resumeSession: 'resuming a session',
  rewind: 'rewinding a conversation',
  usageReporting: 'token usage reporting',
  costReporting: 'cost reporting',
  planUsageReporting: 'plan usage reporting',
  systemPromptAppend: 'standing instructions from the prompt library',
  imageInput: 'images in a prompt',
  fileInput: 'file attachments',
  taskSuggestions: 'follow-up tasks suggested by the agent',
};

export interface CapabilityStatus {
  readonly supported: boolean;
  /** Empty when supported; a full sentence when not. */
  readonly reason: string;
  readonly label: string;
}

/**
 * Answered for the column this component is in.
 *
 * Two panes can be pointed at two providers, so a capability is not a property
 * of the window: the composer on the left may steer mid-run while the one on
 * the right is disabled with Codex's reason attached, at the same moment.
 */
export function useCapability(key: CapabilityKey): CapabilityStatus {
  const supported = usePane((s) => activeCapabilities(s)[key]);
  const provider = usePane(activeProviderLabel);
  const hasProvider = usePane((s) => s.providers.length > 0);
  const label = CAPABILITY_LABELS[key];

  if (supported) return { supported: true, reason: '', label };
  return {
    supported: false,
    label,
    reason: hasProvider
      ? `${provider} does not support ${label}.`
      : `No provider is available yet, so ${label} is unavailable.`,
  };
}

/**
 * Answered for a *named* provider, not the active one.
 *
 * {@link useCapability} degrades controls that act through the column's
 * current selection — the composer, the mode picker. This one is for controls
 * that act on something which carries its own provider: a session row resumes
 * under `session.providerId` whatever the column is pointed at, so gating it
 * on the active provider asks the wrong party entirely. That is how selecting
 * a llama.cpp profile disabled every Claude conversation in the sidebar —
 * llama.cpp cannot resume sessions, and nobody was asking it to.
 */
export function useProviderCapability(
  providerId: ProviderId,
  key: CapabilityKey,
): CapabilityStatus {
  // `find` answers with a stable element reference, so the subscription only
  // fires when the descriptor list itself is replaced.
  const descriptor = usePane((s) => s.providers.find((p) => p.id === providerId));
  const label = CAPABILITY_LABELS[key];

  if (descriptor?.capabilities[key] === true) return { supported: true, reason: '', label };
  return {
    supported: false,
    label,
    reason:
      descriptor === undefined
        ? `No provider is available yet, so ${label} is unavailable.`
        : `${descriptor.label} does not support ${label}.`,
  };
}

/** Permission modes the active provider accepts. Empty means "not applicable". */
export function usePermissionModes(): readonly PermissionMode[] {
  return usePane((s) => activeCapabilities(s).permissionModes);
}
