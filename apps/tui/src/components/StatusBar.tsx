/**
 * The two lines under the composer.
 *
 * The first says *what the next message goes out as* — account, model and
 * its effort, permission mode — sitting directly under the thing that sends
 * it, and at its right edge how full the plan is: the 5-hour window, the
 * week, and Fable's own bucket where the plan meters one, the same three the
 * desktop's rings show. The second says what is happening now: a spinner
 * while the provider works, what the keys do, tokens and cost so far.
 *
 * Every value here is read from the conversation's state rather than echoed
 * from the last thing chosen — the mode, in particular, is what the provider
 * *said* it started in, which is why it can differ from the picker until the
 * next turn. `bypassPermissions` is painted red: it is the one mode where this
 * line is a warning, and it must never look like the others.
 *
 * Colours are the terminal's own. Each half of each line truncates rather
 * than wraps: a status line that folds onto a second row pushes the layout
 * out of its fixed height, and a clipped account name costs less than that.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { isTaskLive, planMeterSlots, type PermissionMode, type PlanMeterSlot } from '@rx-artemis/protocol';
import { contextRatio, formatTokens, formatUsd, totalInputTokens } from '@rx-artemis/transcript';

import type { ConversationState } from '../conversation.js';
import { ACCENT, SPINNER, SPINNER_MS } from '../theme.js';

const MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  default: 'ask',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: "don't ask",
  bypassPermissions: 'BYPASS PERMISSIONS',
};

export interface StatusBarProps {
  readonly state: ConversationState;
  /** A transient message with priority over the hints, e.g. "press again to quit". */
  readonly flash?: string;
  /** What the keys do right now, e.g. for the sidebar. */
  readonly hint?: string;
  /** A newer release than this copy, when the daily check found one. */
  readonly update?: string;
  /**
   * The width this bar actually has — the terminal less the rail, not the
   * terminal. Handing it the whole screen is how the bars came to cost
   * "BYPASS PERMISSIONS" its tail on a terminal wide enough for both.
   */
  readonly columns?: number;
}

/**
 * A window's fullness as a bar.
 *
 * Two rules keep it from lying, and both matter more than the arithmetic:
 * any use at all lights the first cell, so a window that has been started on
 * never reads as untouched; and the last cell is held back until the window
 * really is full, so a full bar means full rather than "nearly".
 */
export function meterBar(utilization: number, cells: number): string {
  if (cells <= 0) return '';
  const exact = Math.round((utilization / 100) * cells);
  const floor = utilization > 0 ? 1 : 0;
  const ceiling = utilization >= 100 ? cells : cells - 1;
  const filled = Math.max(floor, Math.min(exact, ceiling));
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

/**
 * Colour by pressure, in the terminal's own colours — and by the desktop's
 * thresholds (`PlanUsageMeter.toneFor`), so an account is never amber in one
 * app and red in the other. Pessimistic on purpose: a window at 75% is worth
 * noticing before it stops you, because the reset can be hours away. The
 * provider's verdict outranks the number — a window it is rejecting on is at
 * the far end whatever its stale percentage reads.
 */
export function meterTone(utilization: number | null, status?: string): 'green' | 'yellow' | 'red' | undefined {
  if (status === 'rejected') return 'red';
  if (utilization === null) return undefined;
  if (utilization >= 90) return 'red';
  if (utilization >= 75) return 'yellow';
  return 'green';
}

/**
 * How many cells each bar gets, or none at all.
 *
 * The readings sit in a box that does not shrink, so every cell here is a
 * column taken from the account and model line beside it, which truncates.
 * Three bars cost three times what they look like they cost, and eight cells
 * each was enough to push "BYPASS PERMISSIONS" — the one word on that line
 * nobody should have to guess at — off the end of a 140-column terminal.
 * `columns` is what this bar has rather than what the screen has, which is
 * the other half of the same mistake. On a narrow terminal the number alone
 * is worth more than a picture of it.
 */
export function meterCells(columns: number): number {
  if (columns >= 118) return 5;
  if (columns >= 98) return 4;
  return 0;
}

/**
 * One window's reading, coloured by pressure: red at 90, yellow at 75 — the
 * desktop's own thresholds, pessimistic on purpose because a reset can be
 * hours away. A window the provider is rejecting on is red whatever its
 * stale percentage reads, and says so.
 *
 * The bar is the same reading again, in a shape that can be taken in without
 * being read: which window is filling up is then a glance rather than three
 * numbers to compare. The number stays — it is the precise one, and the bar
 * at this size cannot be.
 */
function PlanReading({ slot, cells }: { readonly slot: PlanMeterSlot; readonly cells: number }): React.JSX.Element {
  const { utilization, status } = slot.window;
  const rejected = status === 'rejected';
  const pct = utilization === null ? (rejected ? '!' : '—') : `${String(Math.round(utilization))}%`;
  const tone = meterTone(utilization, status);
  const hot = tone === 'red';
  // The filled cells carry the tone; the empty ones stay dim, so the bar
  // reads as a level rather than a coloured block of fixed length.
  const bar = utilization === null ? '' : meterBar(utilization, cells);
  const filled = bar.replace(/░+$/, '');
  const empty = bar.slice(filled.length);
  return (
    <Text>
      <Text dimColor>{slot.label} </Text>
      {cells > 0 && utilization !== null && (
        <Text>
          <Text color={tone}>{filled}</Text>
          <Text dimColor>{empty}</Text>{' '}
        </Text>
      )}
      <Text color={tone} bold={hot} dimColor={tone === undefined}>
        {rejected ? `${pct} out` : pct}
      </Text>
    </Text>
  );
}

/** A braille spinner that only ticks while something is happening. */
function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER[frame] ?? '' : '';
}

function describeStatus(state: ConversationState): string {
  switch (state.status) {
    case 'idle':
      return state.sessionId === undefined ? 'ready' : 'idle';
    case 'starting':
      return 'starting…';
    case 'running':
      return state.queued > 0 ? `working · ${String(state.queued)} queued` : 'working…';
    case 'awaiting_permission':
      return 'waiting for you';
    default:
      return '';
  }
}

export function StatusBar({ state, flash, hint, update, columns = 0 }: StatusBarProps): React.JSX.Element {
  const { settings, usage } = state;
  const mode = settings.permissionMode;
  const tokens = totalInputTokens(usage?.tokens);
  const ratio = contextRatio(usage);
  const cost = usage?.costUsd;
  const slots = planMeterSlots(state.planUsage);
  const liveTasks = state.tasks.filter(isTaskLive).length;
  const busy = state.status === 'starting' || state.status === 'running';
  const spinner = useSpinner(busy);
  const model = settings.modelLabel ?? settings.model ?? 'default model';
  const details = [
    settings.effort,
    settings.fastMode === true ? 'fast' : undefined,
    settings.ultracode === true ? 'ultracode' : undefined,
  ].filter((part): part is string => part !== undefined);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          <Text bold>{settings.profileLabel}</Text>
          <Text dimColor>{` ${settings.providerLabel}`}</Text>
          <Text dimColor>{' · '}</Text>
          <Text>{model}</Text>
          {details.length > 0 && <Text dimColor>{` ${details.join(' ')}`}</Text>}
          <Text dimColor>{' · '}</Text>
          <Text color={mode === 'bypassPermissions' ? 'red' : mode === 'plan' ? ACCENT : undefined} bold={mode === 'bypassPermissions'}>
            {MODE_LABEL[mode]}
          </Text>
        </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text>
            {slots.map((slot, i) => (
              <Text key={slot.id}>
                {i > 0 && <Text dimColor>{' · '}</Text>}
                <PlanReading slot={slot} cells={meterCells(columns)} />
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          {flash !== undefined ? (
            <Text color="yellow">{flash}</Text>
          ) : (
            <>
              {busy && <Text color={ACCENT}>{spinner} </Text>}
              <Text dimColor={!busy && state.status !== 'awaiting_permission'} color={state.status === 'awaiting_permission' ? 'yellow' : undefined}>
                {describeStatus(state)}
              </Text>
              {busy && (
                <Text dimColor>{state.capabilities.midRunSteering ? ' · Enter steers · Esc interrupts' : ' · Esc interrupts'}</Text>
              )}
              {hint !== undefined && <Text dimColor>{` · ${hint}`}</Text>}
            </>
          )}
        </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
        <Text>
          {tokens !== undefined && (
            <Text dimColor>
              {formatTokens(tokens)} tok{ratio !== undefined ? ` (${String(Math.round(ratio * 100))}%)` : ''}
            </Text>
          )}
          {cost !== undefined && <Text dimColor>{' · '}{formatUsd(cost)}</Text>}
          {liveTasks > 0 && <Text color="cyan">{` · ${String(liveTasks)} task${liveTasks === 1 ? '' : 's'}`}</Text>}
          {update !== undefined && <Text color="yellow">{` · ${update} is out: artemis-tui --update`}</Text>}
          <Text dimColor>{' · /help'}</Text>
        </Text>
        </Box>
      </Box>
    </Box>
  );
}
