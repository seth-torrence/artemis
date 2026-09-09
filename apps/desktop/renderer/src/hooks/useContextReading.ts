/**
 * How full the conversation is, answered once for every surface that asks.
 * ============================================================================
 *
 * Three places want this number — the status bar's meter, the popover row
 * underneath it, and the run-details dialog — and until now each computed it
 * from a slightly different set of fields. That is exactly the disagreement a
 * status line exists to avoid: two readings of one conversation, on one screen,
 * that do not match.
 *
 * The subtlety worth centralising is the *denominator*, which arrives from two
 * different places at two different times:
 *
 *  - The live run's own `usage.contextWindow`, once the provider has stated
 *    one. For a local server that is the size the process was started with; for
 *    Claude it rides on the result message.
 *  - Failing that, what this model reported on a previous run. The renderer
 *    files those per model and persists them, so the second run on a model has
 *    a scale from its first token rather than from its last.
 *
 * And there is deliberately **no third fallback**. A table of model specs held
 * in the client would go stale silently and print a confidently wrong "of 128k"
 * under a server serving 32k — so an unknown window stays unknown, and the
 * surfaces render occupancy with no scale rather than a guess with one.
 */

import { formatTokens } from '@rx-artemis/transcript';

import { activeCapabilities, activeProviderLabel, learnedContextWindow } from '../state/store';
import { usePane } from '../state/paneContext';

export interface ContextReading {
  /**
   * The provider can answer this at all.
   *
   * `contextReporting`, not `usageReporting`: a provider can report what a turn
   * spent without being able to say how full the window is, and the Artemis
   * Server relay is exactly that — it carries token counts and no context at
   * all. Gating on the wrong one is what left it showing "no run yet" against a
   * conversation that had plainly run.
   */
  readonly reporting: boolean;
  /** Tokens the conversation is holding, or `undefined` before anything runs. */
  readonly tokens: number | undefined;
  /** The window they sit in, or `undefined` when nobody has stated one. */
  readonly window: number | undefined;
  /** 0–100, or `null` when either half is missing. */
  readonly utilization: number | null;
  /** `12.3k / 32k`, or `12.3k` with no window known. Empty when nothing has run. */
  readonly label: string;
  readonly providerLabel: string;
}

export function useContextReading(): ContextReading {
  const usage = usePane((s) => s.run?.usage);
  const reporting = usePane((s) => activeCapabilities(s).contextReporting);
  const providerLabel = usePane(activeProviderLabel);

  /*
   * The remembered window is looked up twice over, and the two lookups are not
   * the same question.
   *
   * While a run exists the model that matters is the one the *run* is using —
   * changing the picker mid-run must not re-scale a gauge describing a
   * conversation the new model has never seen. Before any run there is no such
   * model, and the honest answer is the picked one's remembered window, so the
   * meter carries a scale from the moment a profile is chosen rather than from
   * the end of the first turn.
   */
  const model = usePane((s) => s.run?.model);
  const running = usePane((s) => s.run !== null);
  const rememberedForRun = usePane((s) => (model === undefined ? undefined : s.contextWindows[model]));
  const rememberedForPick = usePane(learnedContextWindow);
  const remembered = model === undefined ? rememberedForPick : rememberedForRun;

  const window = usage?.contextWindow ?? remembered;

  // Before the first usage event a started session genuinely holds no context
  // beyond its prompt, so 0 is the honest reading — not "unknown".
  const tokens = usage?.contextTokens ?? (running && window !== undefined ? 0 : undefined);

  const utilization =
    reporting && tokens !== undefined && window !== undefined && window > 0
      ? Math.min(100, (tokens / window) * 100)
      : null;

  /*
   * The window is omitted rather than dashed when it is unknown.
   *
   * "12.3k / —" invites the reading that the *server* is refusing to say, which
   * is a fault; "12.3k" simply reports what is known. The tooltip and the
   * popover carry the longer explanation.
   */
  const label =
    !reporting || tokens === undefined
      ? ''
      : window === undefined
        ? formatTokens(tokens)
        : `${formatTokens(tokens)} / ${formatTokens(window)}`;

  return { reporting, tokens, window, utilization, label, providerLabel };
}
