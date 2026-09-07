/**
 * Plan usage: how much of the subscription's capacity is gone.
 *
 * Deliberately narrow: four things and their reset times — context window, the
 * 5-hour limit, the weekly limit, and any per-model weekly (Fable, Opus,
 * Sonnet). No session cost, no token totals, no plan marketing. Those answer
 * "what did this run cost"; this answers "how much room is left".
 *
 * Context window is the odd one out — it belongs to the *run*, not the account,
 * and it has no reset time because it clears when you start a new session. It
 * is here because it is the other half of "how much room is left", and having
 * to look in two places for that is the thing worth avoiding. It therefore
 * renders even when plan limits are unavailable, which is why it sits above
 * the early returns rather than inside the windows list.
 *
 * ## The trigger is three rings
 *
 *     5hr ⬤  Week ⬤  Fable ⬤
 *
 * The three limits worth watching without opening anything, each named in front
 * of the ring reporting it. See the comment on the trigger for why three rather
 * than one, and {@link meterSlots} for what happens on a plan that does not have
 * these particular windows.
 *
 * ## Stale-while-revalidate
 *
 * A refresh spawns a provider subprocess and takes a second or two, which is
 * far too slow to open a popover on. So the cached reading paints immediately
 * and the fresh one swaps in behind it. The alternative — a spinner on every
 * open — makes a glanceable gauge feel like a page load.
 *
 * The cost of a refresh is a subprocess, **not** model tokens: the provider
 * answers this over its control channel, so opening this popover never bills
 * anything.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { GaugeIcon, RefreshCwIcon } from 'lucide-react';

import {
  isModelScoped,
  planMeterSlots,
  type PlanLimitStatus,
  type PlanUsage,
  type PlanUsageWindow,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';
import { formatTokens } from '@rx-artemis/transcript';
import { useServedAccount } from '../hooks/useServedAccount';
import { activeCapabilities, activeProviderLabel, useApp } from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { paneState } from '../state/pane';
import { WithReason } from './disabled-reason';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { cn } from '../lib/utils';

/**
 * Colour by pressure, not by aesthetics.
 *
 * The thresholds are deliberately pessimistic: a window at 75% during a long
 * session is worth noticing *before* it stops you, because the reset can be
 * hours away.
 *
 * Exported because the profile picker colours its per-account cap with it. Two
 * copies of these thresholds would drift, and the drift would be the worst kind
 * — an account showing amber in the menu and red in the meter is the same
 * account described two ways on one bar, which is precisely the disagreement
 * this status line exists to avoid.
 */
export function toneFor(utilization: number | null, status?: PlanLimitStatus): string {
  // The provider's verdict outranks the thresholds: a window it is rejecting
  // on is at the far end of the scale whatever its stale percentage reads.
  if (status === 'rejected') return 'text-signal';
  if (utilization === null) return 'text-ink-faint';
  if (utilization >= 90) return 'text-signal';
  if (utilization >= 75) return 'text-amber';
  return 'text-ink-muted';
}

function barToneFor(utilization: number | null, status?: PlanLimitStatus): string {
  if (status === 'rejected') return 'bg-signal';
  if (utilization === null) return 'bg-line';
  if (utilization >= 90) return 'bg-signal';
  if (utilization >= 75) return 'bg-amber';
  return 'bg-mint';
}

/* -------------------------------------------------------------------------- */
/* The rings                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One ring's three surfaces: the arc that fills, the disc it encircles, and the
 * number sitting on that disc.
 *
 * The disc is tinted with the same hue as the arc rather than left a neutral
 * surface, and that is the part doing the peripheral-vision work. An arc is two
 * pixels of colour at this size — enough to read when you look at it, not
 * enough to *catch* you — whereas a whole circle going amber is noticeable
 * without being looked at, which is the entire reason a status line carries a
 * meter instead of a menu item.
 */
interface RingTone {
  readonly arc: string;
  readonly disc: string;
  readonly text: string;
}

/** Same thresholds as {@link toneFor}, and deliberately so — see its header. */
function ringToneFor(utilization: number | null, status?: PlanLimitStatus): RingTone {
  if (status === 'rejected') {
    return { arc: 'stroke-signal', disc: 'fill-signal/15', text: 'text-signal' };
  }
  if (utilization === null) {
    return { arc: 'stroke-line', disc: 'fill-line/25', text: 'text-ink-faint' };
  }
  if (utilization >= 90) {
    return { arc: 'stroke-signal', disc: 'fill-signal/15', text: 'text-signal' };
  }
  if (utilization >= 75) {
    return { arc: 'stroke-amber', disc: 'fill-amber/15', text: 'text-amber' };
  }
  return { arc: 'stroke-mint', disc: 'fill-mint/12', text: 'text-ink-muted' };
}

/*
 * Geometry, in the 36-unit box the SVG below is drawn in.
 *
 * The disc's radius is the ring's *inner* edge rather than something smaller:
 * at the 24px this renders at, a one-unit gap between the two would come out
 * under a pixel — invisible, and paid for by a smaller face for the number. So
 * the circle is solid to the ring and the ring sits directly on it.
 *
 * 24px is the smallest size at which `100` still clears the ring on both sides
 * at a legible face. It was 22px, where it did not: the digits touched the arc
 * at the one reading you most need to be able to read.
 */
const RING_RADIUS = 15;
const RING_STROKE = 4;
const DISC_RADIUS = RING_RADIUS - RING_STROKE / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * One window, as a filled ring with its percentage inside it.
 *
 * Nothing here is announced: the drawing is `aria-hidden`, and the number is
 * inside a button whose `aria-label` overrides its children. That is the right
 * outcome rather than an oversight — the label spells out every ring as "5hr
 * 61%", and a bare "61" read out with no window attached is worse than silence.
 *
 * The arc is not rendered at all at zero. A round line cap on a zero-length
 * dash paints a dot, and a dot at the twelve o'clock position reads as a sliver
 * of usage on a window that has none.
 */
export function UsageRing({
  utilization,
  status,
}: {
  readonly utilization: number | null;
  readonly status?: PlanLimitStatus;
}): ReactElement {
  const tone = ringToneFor(utilization, status);
  /*
    A rejected window draws full whatever its number reads. The ring is the
    glanceable surface, and "97" with a sliver of arc missing reads as "still
    going" — which is the exact misreading the verdict exists to correct. The
    number keeps saying what the provider last reported; the geometry says
    what the provider is doing.
  */
  const filled =
    status === 'rejected' ? 100 : utilization === null ? 0 : Math.max(0, Math.min(100, utilization));
  const text =
    utilization === null ? (status === 'rejected' ? '!' : '—') : String(Math.round(utilization));

  return (
    <span className="relative inline-flex size-6 shrink-0 items-center justify-center">
      {/*
        `-rotate-90` starts the arc at twelve o'clock. It is on the whole SVG
        rather than on the two circles because the box is square and centred, so
        rotating it moves nothing but the arc's origin.
      */}
      <svg viewBox="0 0 36 36" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={DISC_RADIUS} className={tone.disc} />
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          className="stroke-line/60"
        />
        {filled > 0 ? (
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            /*
              The gap is a whole circumference rather than the remainder, so
              there is no arithmetic that can round into a second dash appearing
              at the top of the circle.
            */
            strokeDasharray={`${(RING_CIRCUMFERENCE * filled) / 100} ${RING_CIRCUMFERENCE}`}
            className={cn('transition-[stroke-dasharray] duration-300', tone.arc)}
          />
        ) : null}
      </svg>

      {/*
        A step smaller at three digits. Only 100 is three digits, and it is the
        reading that most needs to be legible rather than clipped by the ring it
        sits inside.
      */}
      <span
        className={cn(
          'relative font-mono leading-none tabular-nums',
          text.length > 2 ? 'text-[8px]' : 'text-[9px]',
          tone.text,
        )}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * One ring on the bar: which window it reports and what to call it.
 *
 * `window` is nullable because the trigger has to occupy space before the first
 * reading lands — see {@link PLACEHOLDER_SLOTS}.
 */
export interface MeterSlot {
  readonly key: string;
  readonly label: string;
  readonly window: PlanUsageWindow | null;
}

/**
 * What the bar looks like before it knows anything.
 *
 * Three dashed rings rather than nothing at all: the trigger is a control the
 * user clicks to open the popover, and one that appears a second after launch —
 * shoving the rest of the row sideways as it does — is worse than one that
 * starts empty and fills in. The names are the ones a Claude plan will have.
 */
const PLACEHOLDER_SLOTS: readonly MeterSlot[] = [
  { key: 'five_hour', label: '5hr', window: null },
  { key: 'seven_day', label: 'Week', window: null },
  { key: 'model_scoped', label: 'Fable', window: null },
];

/**
 * The rings to draw, in order.
 *
 * Which windows earn a ring — the 5-hour, the week, Fable's own bucket, or the
 * binding window on a plan with none of those — is {@link planMeterSlots}, in
 * protocol, so the terminal UI's readout and this bar cannot disagree. What is
 * decided here is only the empty case: three dashed rings rather than nothing,
 * because the trigger is a control the user clicks, and one that appears a
 * second after launch — shoving the rest of the row sideways as it does — is
 * worse than one that starts empty and fills in.
 */
// Exported for the run navigator's footer, which draws the same three rings —
// same slots, same skip rules — so the two surfaces cannot disagree about
// which windows are worth a ring.
export function meterSlots(usage: PlanUsage | null): readonly MeterSlot[] {
  const slots = planMeterSlots(usage).map((slot) => ({ key: slot.id, label: slot.label, window: slot.window }));
  return slots.length > 0 ? slots : PLACEHOLDER_SLOTS;
}

/** One ring's contribution to the trigger's label: "5hr 61%". */
function describeSlot(slot: MeterSlot): string {
  const pct = slot.window?.utilization ?? null;
  const reading = `${slot.label} ${pct === null ? 'unknown' : `${String(Math.round(pct))}%`}`;
  return slot.window?.status === 'rejected' ? `${reading} — limit reached` : reading;
}

/**
 * The exact wall-clock reset, with the countdown as secondary.
 *
 * The exact time is what was asked for and it is the more useful of the two:
 * "resets in 4h" needs mental arithmetic before you can decide whether to wait
 * or to stop for the day. The countdown stays alongside it because a bare
 * timestamp does not say whether that is soon.
 *
 * A window resetting more than a day out shows its weekday and date — "3:00 PM"
 * alone would read as today.
 */
function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '';
  const ms = resetsAt - now;
  if (ms <= 0) return 'resetting now';

  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const exact = sameDay
    ? clock
    : `${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock}`;

  const minutes = Math.round(ms / 60_000);
  const countdown =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`.replace(' 0m', '')
        : `${Math.round(minutes / (24 * 60))}d`;

  return `resets ${exact} · in ${countdown}`;
}

/**
 * Windows that answer questions nobody asks mid-run.
 *
 * Claude's payload carries these alongside the limits that actually stop you,
 * and showing seven bars would bury the two that matter.
 *
 * `nimbus_quill` is an internal experiment flag riding the rate-limits payload
 * — utilization 0, no reset time, named after nothing a user could act on. Its
 * codename siblings (`tangelo`, `cinder_cove`, …) arrive as `null` and never
 * render; this one arrives as an object and drew a permanent 0% bar.
 */
const NOT_WORTH_A_BAR: ReadonlySet<string> = new Set([
  'seven_day_oauth_apps',
  'extra_usage',
  'nimbus_quill',
]);

/**
 * Is this window worth a bar?
 *
 * A deny-list, and it used to be an allow-list — `five_hour`, `seven_day*`,
 * model-scoped — which quietly made this component Claude-only. Codex reports
 * its windows as `primary` and `secondary`, matched none of those names, and so
 * a plan whose usage had been fetched perfectly well rendered as "No limits
 * reported for this plan". `PlanUsageWindowId` is documented as open-ended
 * precisely so a provider can contribute its own vocabulary; an allow-list of
 * one provider's names is the opposite of honouring that.
 *
 * So: everything is shown unless it is known noise. A window this file has never
 * heard of is far more likely to be a new limit worth seeing than a new kind of
 * clutter, and the failure modes are not symmetric — one extra bar is a
 * cosmetic problem, a missing bar is a plan that runs out without warning.
 *
 * Usage credits are the one *conditional* entry. They are overflow billing
 * rather than a limit: nothing about the plan runs out when they sit at zero,
 * and zero is the state most accounts are permanently in — so an always-on row
 * would be permanent noise, while a row that appears is the news itself
 * ("you are now spending past your plan"). Hidden until there is a number
 * greater than nothing to report.
 */
function isShown(window: PlanUsageWindow): boolean {
  if (NOT_WORTH_A_BAR.has(window.id)) return false;
  if (window.id === 'spend') return window.utilization !== null && window.utilization > 0;
  return true;
}

/** Order: overall limits first, then per-model, then a provider's own names. */
function displayRank(id: string): number {
  if (id === 'five_hour') return 0;
  if (id === 'seven_day') return 1;
  if (id.startsWith('seven_day') || isModelScoped(id)) return 2;
  // Unfamiliar ids sort last rather than into the middle of Claude's ladder —
  // they are shown now (see `isShown`), and where they belong is unknowable
  // from the id alone.
  return 3;
}

function ageHint(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * The newer of two readings of the same account, or whichever one exists.
 *
 * `fetchedAt` rather than a preference for either source, because neither
 * subsumes the other and which is fresher genuinely alternates — see
 * {@link usePlanUsage}.
 */
function newerReading(a: PlanUsage | null, b: PlanUsage | null): PlanUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.fetchedAt > a.fetchedAt ? b : a;
}

/**
 * One profile's plan usage, cached-then-fresh, and never behind the poll.
 *
 * A hook rather than a prop drilled down from one owner, because two unrelated
 * places ask this question about two different profiles: the status bar asks
 * about the *active* one, and each card on the profiles screen asks about its
 * own. Keeping the read here means both get the same staleness rules and the
 * same guard against a late response landing on the wrong account.
 *
 * `follow` is the "did the question change under us" test. The status bar's
 * profile can change while a read is in flight — the user switches accounts —
 * and attributing one account's limits to another is a worse answer than none.
 * A card's profile cannot change, so it passes nothing.
 *
 * ## Two sources, and the rings used to see only one
 *
 * Artemis holds this fact in two places, and for a while they were not
 * connected:
 *
 *  - **This hook's own state**, filled by {@link load} — on mount, on a profile
 *    change, and when the popover opens.
 *  - **`planUsageByProfile`** in the app store, which the main process's poll
 *    pushes into every few minutes for *every* account.
 *
 * The rings rendered the first and never read the second. So the three numbers
 * on the status bar were frozen at whatever the last `load` returned: sit on one
 * account while an agent works through a long job and the 5-hour ring would not
 * move, though the true figure was in the store the whole time, one selector
 * away. Reloading the window fixed it, because that remounts the meter — which
 * is exactly the "I have to refresh to see changes" this was reported as.
 *
 * Neither source subsumes the other, which is why this takes the newer of the
 * two rather than preferring one. The poll is the only thing that keeps an idle
 * account current; the local read is the only thing current in the instant after
 * a profile switch or a manual refresh, before the next cycle comes round.
 */
function usePlanUsage(
  profileId: string | null,
  follow?: () => string | null,
): {
  readonly usage: PlanUsage | null;
  readonly refreshing: boolean;
  readonly load: (mode: 'cached' | 'refresh') => Promise<boolean>;
} {
  /*
    The reading is stored *with* the profile it describes, and read back only
    on a match, rather than being cleared by an effect when `profileId`
    changes. An effect clears one render too late, and that render is the one
    that paints the previous account's percentage under the new account's
    name — the exact mislabelling the in-flight guard below exists to prevent.
  */
  const [held, setHeld] = useState<{ readonly of: string; readonly usage: PlanUsage } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const local = held !== null && held.of === profileId ? held.usage : null;
  /*
    The poll's copy of the same account. Selected by id rather than taking the
    whole map, so a cycle that re-reads seven *other* profiles does not re-render
    this meter seven times — the entries are replaced individually, so the one
    this subscribes to keeps its identity until it is the one that moved.
  */
  const polled = useApp((s) => (profileId === null ? null : (s.planUsageByProfile[profileId] ?? null)));
  const usage = newerReading(local, polled);

  /** Resolves true when a reading actually landed, so a caller can escalate. */
  const load = useCallback(
    async (mode: 'cached' | 'refresh'): Promise<boolean> => {
      if (profileId === null) return false;
      const { bridge } = resolveBridge();
      if (!bridge) return false;

      if (mode === 'refresh') setRefreshing(true);
      const res = await call(() => bridge.usagePlan[mode]({ profileId }));
      if (mode === 'refresh') setRefreshing(false);

      if (follow && follow() !== profileId) return false;
      if (res.ok && res.value.usage !== null) {
        const fresh = res.value.usage;
        /*
          Never backwards, for the same reason `newerReading` exists a few lines
          up. The two modes race: opening the popover fires `cached` and then
          `refresh`, and a card that misses the cache escalates to a refresh
          while the cached reply may still be in flight. A `refresh` spawns a
          CLI and takes a second or two, so the *older* cached reading can be
          the one that lands last — and unguarded it would overwrite the fresh
          figure it was only ever meant to precede.
        */
        setHeld((prev) =>
          prev !== null && prev.of === profileId && fresh.fetchedAt < prev.usage.fetchedAt
            ? prev
            : { of: profileId, usage: fresh },
        );
        return true;
      }
      return false;
    },
    // `follow` is read at call time, not closed over as a dependency: the
    // status bar passes an inline arrow, so depending on it would rebuild
    // `load` every render and re-fire the effect below in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId],
  );

  return { usage, refreshing, load };
}

/**
 * How often a visible reading re-reads the wall clock.
 *
 * The labels it feeds are minute-granular — "in 2h 45m", "5m ago" — with one
 * 45-second boundary in {@link ageHint}, so a quarter of a minute is fine enough
 * that neither is ever visibly wrong and coarse enough that a popover left open
 * is not re-rendering every second to produce identical text.
 */
const CLOCK_TICK_MS = 15_000;

/**
 * A clock that stays honest for as long as it is being read.
 *
 * `Date.now()` taken during render is only current if something else happens to
 * re-render, and nothing here reliably does: a reading arrives every couple of
 * minutes at most, the poll skips cycles when no window is looking, and a cycle
 * that pushes an unchanged payload does not even change the identity of the
 * entry this subscribes to. So `now` froze at whatever the clock said when the
 * component last rendered and drifted further from the truth the longer it went
 * untouched — "resets 3:10 PM · in 4h 18m" at twenty-five past twelve, where the
 * two halves are computed from the same `resetsAt` and cannot both be right.
 *
 * The exact time is the trustworthy half of that pairing: `resetsAt` is an
 * absolute instant, so it survives any amount of staleness. It is only the
 * countdown — and the "5m ago" beside it — that need a live clock underneath.
 *
 * `active` stops the timer when nothing is reading it, which for the status bar
 * is whenever its popover is shut. That is the same bargain `useTicker` strikes
 * in `TasksPane`, and it matters more here: this component sits in a row that is
 * on screen for the whole session.
 */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Immediately, not on the first interval: reopening the popover must not
    // show a quarter-minute-old countdown while it waits for the next tick.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

export function PlanUsageMeter(): ReactElement | null {
  const pane = usePaneRef();
  const profileId = usePane((s) => s.activeProfileId);
  const supported = usePane((s) => activeCapabilities(s).planUsageReporting);
  const providerLabel = usePane(activeProviderLabel);

  /*
   * At an Artemis Server profile the reading belongs to the *served account*
   * behind the active pick, not to the profile: the poller fans the server's
   * usage report out into the served-account map, and the profile-keyed pair
   * of sources below stays empty for it on purpose. The hook joins the pick
   * to its gauge; `load('refresh')` still works, because main answers it for
   * a server profile by re-running the same fan-out.
   */
  const served = useServedAccount();

  const [open, setOpen] = useState(false);
  const { usage: profileUsage, refreshing, load } = usePlanUsage(
    profileId,
    () => paneState(pane).activeProfileId,
  );
  const usage = served.atServer ? (served.gauge?.usage ?? null) : profileUsage;
  // Only the popover's body reads this — the rings show percentages, which have
  // no clock in them — so the timer runs only while the popover is open.
  const now = useClock(open);

  // Paint from cache as soon as the trigger exists, so the rings can already
  // carry a colour before they are ever clicked.
  useEffect(() => {
    void load('cached');
  }, [load]);

  // Opening is what triggers the network read — see the header note.
  useEffect(() => {
    if (open) void load('refresh');
  }, [open, load]);

  /*
   * A served gauge has no cache to paint from — main's plan-usage cache is
   * profile-keyed and the poller's first sweep is minutes away in the worst
   * case — so a server pane whose map is still empty asks once. One HTTP read
   * of the server's own cache, not a CLI spawn; deps keep it to one ask per
   * profile rather than one per render.
   */
  const servedEmpty = served.atServer && served.gauge === undefined;
  useEffect(() => {
    if (servedEmpty) void load('refresh');
  }, [servedEmpty, load]);

  if (profileId === null) return null;

  if (!supported) {
    return (
      /*
        Still the gauge glyph here, deliberately, rather than three empty rings:
        an unfilled ring is indistinguishable from a ring at 0%, and "this
        provider cannot report limits" must not read as "you have used none of
        them". A different shape is the point.
      */
      <WithReason reason={`${providerLabel} does not report plan usage.`} side="top">
        <span aria-disabled="true" className="px-1 text-ink-faint opacity-60">
          <GaugeIcon className="size-3" aria-hidden="true" />
        </span>
      </WithReason>
    );
  }

  const slots = meterSlots(usage);

  /*
    Three rings, not one bar.

    The bar reported a single window chosen in settings, and that setting was
    the tell: picking between the 5-hour, the weekly and the per-model limit
    only *is* a choice because a bar the width of this one can carry one of
    them. But the three answer different questions on different clocks — the
    5-hour is what stops you mid-task, the weekly is what you budget across
    days, the per-model one is what runs out first if you lean on the expensive
    model — and none of them substitutes for the others. Choosing meant being
    blind to two.

    A ring is what makes three fit. It carries its fill and its number in the
    same 22px, where a bar needs its length to be readable at all, so the row
    costs about as much width as the labelled bar did and says three times as
    much. Each is named in front of it, because a percentage whose window you
    have to remember by position is a percentage you will misread.

    The popover underneath is unchanged and still lists every window the plan
    reports, including the ones with no ring here.
  */
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Plan usage — ${slots.map(describeSlot).join(', ')}`}
        // Chrome only. `gap-2` between slots and `gap-1` inside one is 7D
        // `.meter`/`.meter .slot` verbatim, and the hover goes to the wash the
        // chips beside it wear rather than a tint of the hairline colour.
        className="flex items-center gap-2 rounded-md px-1 hover:bg-wash"
      >
        {slots.map((slot) => (
          <span key={slot.key} className="flex shrink-0 items-center gap-1">
            <span className="font-mono text-2xs text-ink-faint">{slot.label}</span>
            <UsageRing
              utilization={slot.window?.utilization ?? null}
              status={slot.window?.status}
            />
          </span>
        ))}
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-72 p-3">
        <PlanUsageBody usage={usage} refreshing={refreshing} now={now} onRefresh={() => void load('refresh')} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The same limits, on a profile card.
 *
 * No context-window row here, unlike the popover: a context window belongs to
 * the live run, and the profiles screen is about accounts — three cards each
 * claiming the same window would be three copies of one number that describes
 * none of them.
 *
 * Reads cache only. The popover refreshes because opening it is a deliberate
 * "tell me now"; this screen renders every profile at once, and refreshing all
 * of them on mount would spawn a provider subprocess per account for a screen
 * the user may have opened to rename something. The refresh control on each
 * card is how a fresh reading is asked for.
 */
/**
 * One at a time, across every card on the profiles screen.
 *
 * A cache miss escalates to a real fetch, and a real fetch spawns the provider's
 * CLI. Every card mounting at once would therefore start one subprocess per
 * account simultaneously — on a machine with six profiles that is six CLIs
 * racing for the CPU the moment a settings pane opens. Chaining them costs a
 * little latency on the last card and nothing on the first.
 *
 * Module-level on purpose: the cards are siblings that know nothing about each
 * other, so the queue cannot live in any one of them.
 */
let usageQueue: Promise<unknown> = Promise.resolve();

function enqueueUsageFetch(run: () => Promise<unknown>): Promise<void> {
  // `catch` before chaining: one profile whose CLI is missing or wedged must
  // not stop every card behind it in the queue from ever loading.
  const next: Promise<void> = usageQueue.then(run, run).then(
    () => undefined,
    () => undefined,
  );
  usageQueue = next;
  return next;
}

export function ProfilePlanUsage({
  profileId,
  supported,
  providerLabel,
}: {
  readonly profileId: string;
  readonly supported: boolean;
  readonly providerLabel: string;
}): ReactElement | null {
  const { usage, refreshing, load } = usePlanUsage(profileId);
  /*
    Always ticking, unlike the status bar's: this card has no open/shut state to
    gate on — its countdown is on screen for as long as the profiles page is —
    and it was the worse of the two offenders. `now` was captured once at mount
    and advanced only when the refresh button was pressed, so a settings pane
    left open drifted by exactly however long it had been open, with no upper
    bound and nothing on screen to suggest the number had stopped moving.
  */
  const now = useClock(true);

  /*
   * Cached first, then a real fetch if that came back with nothing.
   *
   * The cache is only ever filled by a refresh, and the only thing refreshing
   * on its own is the status bar — for the active profile. So a cached-only
   * read left every *other* account's card blank, which read as "this account
   * has no plan" rather than "nobody has asked yet". A page whose whole subject
   * is your accounts should answer for all of them.
   *
   * Escalation is once per card per mount: `usage` is not in the dependency
   * list, so a fetch that legitimately returns nothing — an API-key profile
   * with no plan behind it — does not re-arm this effect into a loop.
   */
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      const cached = await load('cached');
      if (cached || cancelled) return;
      await enqueueUsageFetch(async () => {
        if (cancelled) return;
        await load('refresh');
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [load, supported]);

  if (!supported) {
    return (
      <p className="text-2xs text-ink-faint">{providerLabel} does not report plan usage.</p>
    );
  }

  return (
    <PlanWindows
      usage={usage}
      refreshing={refreshing}
      now={now}
      // No clock to stamp here any more: `useClock` keeps `now` current on its
      // own, which is what the stamp on this button was standing in for.
      onRefresh={() => void load('refresh')}
    />
  );
}

function PlanUsageBody(props: {
  readonly usage: PlanUsage | null;
  readonly refreshing: boolean;
  readonly now: number;
  readonly onRefresh: () => void;
}): ReactElement {
  /*
    Context window first, and outside the plan branches.

    It is a property of the run rather than the account, so it is knowable even
    when plan limits are not — an API-key profile has no limits to report but
    still has a context window filling up.
  */
  return (
    <div className="flex flex-col gap-2.5">
      <ContextWindowRow />
      <PlanWindows {...props} />
    </div>
  );
}

function PlanWindows({
  usage,
  refreshing,
  now,
  onRefresh,
}: {
  readonly usage: PlanUsage | null;
  readonly refreshing: boolean;
  readonly now: number;
  readonly onRefresh: () => void;
}): ReactElement {
  // Cold start: nothing cached and the first read still in flight.
  if (usage === null) {
    return (
      <p className="text-2xs text-ink-faint">
        {refreshing ? 'Reading plan usage…' : 'No plan usage recorded yet.'}
      </p>
    );
  }

  // A profile that bills per token has no limits to report. That is an answer,
  // not a failure, and it must not look like "0% used".
  if (!usage.available) {
    return <p className="text-2xs text-ink-muted">{usage.unavailableReason}</p>;
  }

  const shown = usage.windows
    .filter((w) => isShown(w))
    .slice()
    .sort((a, b) => displayRank(a.id) - displayRank(b.id) || a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="chrome-label tracking-wide text-ink-faint">
          {usage.subscriptionType ? `${usage.subscriptionType} plan` : 'Plan usage'}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-auto gap-1 px-1 py-0.5 text-2xs font-normal text-ink-faint hover:text-ink-muted"
        >
          <RefreshCwIcon className={cn('size-2.5', refreshing && 'animate-spin')} aria-hidden="true" />
          {refreshing ? 'updating' : ageHint(usage.fetchedAt, now)}
        </Button>
      </div>

      {shown.length === 0 ? (
        <p className="text-2xs text-ink-faint">No limits reported for this plan.</p>
      ) : (
        shown.map((window) => <WindowRow key={window.id} window={window} now={now} />)
      )}
    </div>
  );
}

/**
 * How full the current conversation's context is.
 *
 * Not a plan limit — it belongs to the run, not the account — but it is the
 * other "how much room is left" number, and answering both in one place is
 * why this row lives here rather than only in the status bar.
 *
 * It has no reset time by design: a context window empties when you start a
 * new session, not on a clock.
 */
function ContextWindowRow(): ReactElement {
  const usage = usePane((s) => s.run?.usage);
  const reporting = usePane((s) => activeCapabilities(s).usageReporting);
  const providerLabel = usePane(activeProviderLabel);

  // The live run only learns its window at run end, so during a turn we fall
  // back to what this model reported last time. That memory is persisted, so
  // after the first ever run on a model the total is known from launch.
  //
  // Deliberately no hardcoded default: a model's window is the provider's fact
  // to state, and a table of specs here would go stale silently and show a
  // confidently wrong denominator. Unknown stays blank until the model says.
  const model = usePane((s) => s.run?.model);
  const running = usePane((s) => s.run !== null);
  const remembered = usePane((s) => (model === undefined ? undefined : s.contextWindows[model]));
  const window = usage?.contextWindow ?? remembered;

  // Before the first usage event a started session genuinely holds no context
  // beyond its prompt, so 0 is the honest reading — not "unknown".
  const tokens = usage?.contextTokens ?? (running && window !== undefined ? 0 : undefined);
  const pct =
    reporting && tokens !== undefined && window ? Math.min(100, (tokens / window) * 100) : null;

  /*
    Three distinct states, and they must not collapse into one dash:
      - the provider cannot report usage at all   → say which provider, and why
      - it can, but nothing has run yet           → say so
      - it has                                    → the numbers
    A bare "—" for the first case reads as a bug rather than a limitation.
  */
  const note = !reporting
    ? `${providerLabel} does not report token usage`
    : pct === null
      ? 'no run yet'
      : `${formatTokens(tokens ?? 0)} of ${formatTokens(window ?? 0)} · clears on a new session`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="truncate text-ink-muted">Context window</span>
        <span className={cn('shrink-0 font-mono tabular-nums', toneFor(pct))}>
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-line/60">
        <div
          className={cn('h-full rounded-full transition-[width]', barToneFor(pct))}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>

      <span className="text-2xs text-ink-faint">{note}</span>
    </div>
  );
}

function WindowRow({
  window,
  now,
}: {
  readonly window: PlanUsageWindow;
  readonly now: number;
}): ReactElement {
  const pct = window.utilization;
  const rejected = window.status === 'rejected';
  const reset = resetLabel(window.resetsAt, now);
  /*
    The verdict gets the hint line, and the reset time rides behind it: on a
    rejected window "when does it come back" is the whole question, so the two
    belong in one sentence rather than the verdict displacing the answer.
  */
  const hint = rejected
    ? `limit reached — requests are being refused${reset === '' ? '' : ` · ${reset}`}`
    : reset;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="truncate text-ink-muted">{window.label}</span>
        <span className={cn('shrink-0 font-mono tabular-nums', toneFor(pct, window.status))}>
          {pct === null ? (rejected ? '100%' : '—') : `${Math.round(pct)}%`}
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-line/60">
        <div
          className={cn('h-full rounded-full transition-[width]', barToneFor(pct, window.status))}
          // Full on a rejected window whatever the number reads — the bar is
          // the glance, and a sliver of green headroom on a window the
          // provider is refusing on is the misreading this feature removes.
          style={{ width: `${rejected ? 100 : (pct ?? 0)}%` }}
        />
      </div>

      {hint === '' ? null : (
        <span className={cn('text-2xs', rejected ? 'text-signal' : 'text-ink-faint')}>{hint}</span>
      )}
    </div>
  );
}
