/**
 * Headroom, and which account to recommend on it.
 *
 * These are pure functions over readings the main process polls, and they are
 * the whole of the "Recommended" section's judgement — the UI does no ranking
 * of its own. What is tested here is mostly what the recommendation *refuses*
 * to say: the exclusions are the part that keeps it from sending someone to a
 * metered account, or advising on numbers from twenty minutes ago.
 */

import { describe, expect, it } from 'vitest';

import { resolvePlanWeight } from './planCapacity.js';
import {
  applyPlanLimit,
  bindingWindow,
  PLAN_USAGE_MAX_AGE_MS,
  planHeadroom,
  recommendProfile,
  type PlanUsage,
  type PlanUsageWindow,
  planMeterSlots,
} from './usage.js';

const NOW = 1_700_000_000_000;

function usage(
  windows: readonly (Pick<PlanUsageWindow, 'id' | 'utilization'> & {
    label?: string;
    status?: PlanUsageWindow['status'];
  })[],
  overrides: Partial<PlanUsage> = {},
): PlanUsage {
  return {
    available: true,
    fetchedAt: NOW,
    windows: windows.map((w) => ({
      id: w.id,
      label: w.label ?? w.id,
      utilization: w.utilization,
      resetsAt: null,
      ...(w.status === undefined ? {} : { status: w.status }),
    })),
    ...overrides,
  };
}

describe('planHeadroom', () => {
  it('measures the window closest to full, not the average', () => {
    // 5% weekly and 98% five-hourly is an account with 2% of room. An average
    // would call it 48% and send someone into a wall.
    const reading = usage([
      { id: 'seven_day', utilization: 5 },
      { id: 'five_hour', utilization: 98 },
    ]);
    expect(planHeadroom(reading)).toBe(2);
  });

  it('is null when there is no plan, and 0 when the plan is full', () => {
    // The distinction the meter turns on: "not applicable" must not render as
    // "nothing used", and "full" must not render as "unknown".
    expect(planHeadroom({ available: false, windows: [], fetchedAt: NOW })).toBeNull();
    expect(planHeadroom(usage([{ id: 'five_hour', utilization: 100 }]))).toBe(0);
  });

  it('is null when every window omits its number', () => {
    expect(planHeadroom(usage([{ id: 'five_hour', utilization: null }]))).toBeNull();
  });

  it('is null for a reading that does not exist', () => {
    expect(planHeadroom(null)).toBeNull();
    expect(planHeadroom(undefined)).toBeNull();
  });
});

describe('recommendProfile', () => {
  it('names the account with the most room, and the window that decides it', () => {
    const result = recommendProfile(
      [
        { profileId: 'work', usage: usage([{ id: 'five_hour', utilization: 90 }]) },
        {
          profileId: 'personal',
          usage: usage([
            { id: 'five_hour', utilization: 30 },
            { id: 'seven_day', utilization: 40, label: '7 days' },
          ]),
        },
      ],
      { now: NOW },
    );

    expect(result?.profileId).toBe('personal');
    // 60, from the weekly window — the tighter of that account's two.
    expect(result?.headroom).toBe(60);
    expect(result?.binding.label).toBe('7 days');
    expect(result?.candidates).toBe(2);
  });

  it('never recommends an account that bills per token', () => {
    /*
      The exclusion that matters most. An API-key or Bedrock profile reports
      `available: false` because it is metered rather than capped; ranking it
      would read as infinite room and turn "my plan is full" into a silent
      switch to per-token billing.
    */
    const result = recommendProfile(
      [
        { profileId: 'plan', usage: usage([{ id: 'five_hour', utilization: 99 }]) },
        {
          profileId: 'metered',
          usage: { available: false, windows: [], fetchedAt: NOW },
        },
      ],
      { now: NOW },
    );

    expect(result).toBeNull();
  });

  it('ignores a reading older than the staleness window', () => {
    const stale = usage([{ id: 'five_hour', utilization: 10 }], {
      fetchedAt: NOW - PLAN_USAGE_MAX_AGE_MS - 1,
    });
    const fresh = usage([{ id: 'five_hour', utilization: 80 }]);

    // The stale account has far more room on paper and is still not the answer:
    // it may have been drained by another window since it was read.
    expect(
      recommendProfile(
        [
          { profileId: 'stale', usage: stale },
          { profileId: 'fresh', usage: fresh },
          { profileId: 'other', usage: usage([{ id: 'five_hour', utilization: 85 }]) },
        ],
        { now: NOW },
      )?.profileId,
    ).toBe('fresh');
  });

  it('treats a reading stamped in the future as current, not infinitely stale', () => {
    // A clock disagreeing with itself is not evidence that the reading is old.
    const result = recommendProfile(
      [
        { profileId: 'ahead', usage: usage([{ id: 'five_hour', utilization: 10 }], { fetchedAt: NOW + 60_000 }) },
        { profileId: 'here', usage: usage([{ id: 'five_hour', utilization: 50 }]) },
      ],
      { now: NOW },
    );
    expect(result?.profileId).toBe('ahead');
  });

  it('says nothing when only one account can be ranked', () => {
    // A "Recommended" heading over the only profile with a plan repeats the row
    // below it. The section earns its space when there is a choice.
    expect(
      recommendProfile([{ profileId: 'only', usage: usage([{ id: 'five_hour', utilization: 20 }]) }], {
        now: NOW,
      }),
    ).toBeNull();
  });

  it('skips accounts that have never been read', () => {
    expect(
      recommendProfile(
        [
          { profileId: 'known', usage: usage([{ id: 'five_hour', utilization: 20 }]) },
          { profileId: 'unread', usage: null },
          { profileId: 'missing', usage: undefined },
        ],
        { now: NOW },
      ),
    ).toBeNull();
  });

  it('skips an account whose windows all omit their numbers', () => {
    const result = recommendProfile(
      [
        { profileId: 'blank', usage: usage([{ id: 'five_hour', utilization: null }]) },
        { profileId: 'a', usage: usage([{ id: 'five_hour', utilization: 20 }]) },
        { profileId: 'b', usage: usage([{ id: 'five_hour', utilization: 30 }]) },
      ],
      { now: NOW },
    );
    expect(result?.profileId).toBe('a');
    expect(result?.candidates).toBe(2);
  });

  it('keeps the caller order on a tie, so the label does not swap between polls', () => {
    const tied = [
      { profileId: 'first', usage: usage([{ id: 'five_hour', utilization: 40 }]) },
      { profileId: 'second', usage: usage([{ id: 'five_hour', utilization: 40 }]) },
    ];
    expect(recommendProfile(tied, { now: NOW })?.profileId).toBe('first');
    // Same inputs, same answer — the property that makes it stable across polls.
    expect(recommendProfile(tied, { now: NOW })?.profileId).toBe('first');
  });

  it('recommends a full account when it is the least full one', () => {
    // Everything is exhausted and the menu still has to answer honestly rather
    // than go blank: 0% free is a fact, and hiding it would read as "no data".
    const result = recommendProfile(
      [
        { profileId: 'a', usage: usage([{ id: 'five_hour', utilization: 100 }]) },
        { profileId: 'b', usage: usage([{ id: 'five_hour', utilization: 100 }]) },
      ],
      { now: NOW },
    );
    expect(result?.headroom).toBe(0);
  });

  it('answers null for no accounts at all', () => {
    expect(recommendProfile([], { now: NOW })).toBeNull();
  });

  describe('across plans', () => {
    /*
      The limit of what any of this can claim. Providers report utilization as a
      percentage of a ceiling they never state — the Claude payload is
      `utilization` plus `resets_at`, and `subscription_type` is a bare word
      that cannot separate one Max tier from another. So a ranking across plans
      is a ranking of percentages unless every plan involved publishes its size
      relative to its provider's baseline — which is what `basis` reports, so
      the UI can word the claim to match what was actually compared.
    */
    it('claims a like-for-like comparison only when one plan is involved', () => {
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 70 }], { subscriptionType: 'max' }),
          },
          {
            profileId: 'b',
            usage: usage([{ id: 'five_hour', utilization: 20 }], { subscriptionType: 'max' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('b');
      expect(result?.basis).toBe('same-plan');
      expect(result?.subscriptionType).toBe('max');
    });

    it('does not claim one when the accounts are on different plans', () => {
      // A team account 60% free may hold less work than a max account 40% free.
      // The ranking still happens — a percentage ranking is useful — but it is
      // flagged so the row can say "of its own plan" instead of "most room".
      const result = recommendProfile(
        [
          {
            profileId: 'work',
            usage: usage([{ id: 'five_hour', utilization: 60 }], { subscriptionType: 'max' }),
          },
          {
            profileId: 'team',
            usage: usage([{ id: 'five_hour', utilization: 40 }], { subscriptionType: 'team' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('team');
      expect(result?.basis).toBe('percentage');
      expect(result?.subscriptionType).toBe('team');
    });

    it('treats an unreported plan as its own kind rather than as a match', () => {
      // "Unknown" is not evidence of being the same plan as "max".
      const result = recommendProfile(
        [
          {
            profileId: 'named',
            usage: usage([{ id: 'five_hour', utilization: 50 }], { subscriptionType: 'max' }),
          },
          { profileId: 'unnamed', usage: usage([{ id: 'five_hour', utilization: 10 }]) },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('unnamed');
      expect(result?.basis).toBe('percentage');
      expect(result?.subscriptionType).toBeUndefined();
    });

    it('reads two spellings of one plan as one plan', () => {
      // The tier is a free-text string from the provider; `Max` and `max` are
      // not two plans, and treating them as such would hedge a comparison that
      // is in fact like-for-like.
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 50 }], { subscriptionType: 'Max' }),
          },
          {
            profileId: 'b',
            usage: usage([{ id: 'five_hour', utilization: 10 }], { subscriptionType: 'max' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('same-plan');
    });

    it('ignores the plan of an account that was never in the running', () => {
      // A metered profile is excluded before ranking, so its (absent) plan must
      // not be what drops the basis from same-plan to percentage.
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 50 }], { subscriptionType: 'max' }),
          },
          {
            profileId: 'b',
            usage: usage([{ id: 'five_hour', utilization: 10 }], { subscriptionType: 'max' }),
          },
          { profileId: 'api-key', usage: { available: false, windows: [], fetchedAt: NOW } },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('same-plan');
      expect(result?.candidates).toBe(2);
    });
  });

  describe('weighted by plan size', () => {
    /*
      The question a percentage ranking gets wrong, and the one the plan table
      exists to answer: a Max plan holds twenty times a Pro plan's session, so
      the account with the smaller *share* free can easily have far more room.
      Providers publish that ratio in the product name even though they publish
      no absolute capacity, and a ratio is all an ordering needs.
    */
    const claude = (utilization: number, plan: string, subscriptionType: string) => ({
      usage: usage([{ id: 'five_hour', utilization }], { subscriptionType }),
      providerId: 'claude' as const,
      capacity: resolvePlanWeight({ providerId: 'claude', pinned: plan }),
    });

    it('prefers the bigger plan when the smaller one has a larger share free', () => {
      const result = recommendProfile(
        [
          { profileId: 'pro', ...claude(10, 'claude:pro', 'pro') },
          { profileId: 'max', ...claude(70, 'claude:max-20x', 'max') },
        ],
        { now: NOW },
      );

      // Pro is 90% free and Max 20x is 30% free — but 30% of twenty Pro windows
      // is six Pro windows, against nine tenths of one.
      expect(result?.profileId).toBe('max');
      expect(result?.basis).toBe('weighted');
      expect(result?.plan?.label).toBe('Max 20x');
    });

    it('still prefers the smaller plan when it genuinely has more capacity', () => {
      // The weighting has to be able to lose, or it is not a comparison at all.
      // An untouched Pro window scores 100; a Max 20x with 1% of its window
      // left scores 20. Twenty times a sliver is still less than a whole one.
      const result = recommendProfile(
        [
          { profileId: 'pro', ...claude(0, 'claude:pro', 'pro') },
          { profileId: 'max', ...claude(99, 'claude:max-20x', 'max') },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('pro');
      expect(result?.basis).toBe('weighted');
    });

    it('falls back to percentages when any plan publishes no ratio', () => {
      // A Team seat is not sold as a multiple of Pro, so the set cannot be
      // weighed at all — one unweighable account demotes the whole comparison.
      const result = recommendProfile(
        [
          { profileId: 'pro', ...claude(10, 'claude:pro', 'pro') },
          {
            profileId: 'team',
            usage: usage([{ id: 'five_hour', utilization: 70 }], { subscriptionType: 'team' }),
            providerId: 'claude',
            capacity: resolvePlanWeight({ providerId: 'claude', subscriptionType: 'team' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('percentage');
      expect(result?.profileId).toBe('pro');
    });

    it('never weighs one provider against another', () => {
      /*
        Both baselines weigh 1 and they are not the same size: Claude Pro and
        Codex Plus are each their own provider's smallest paid plan, and nobody
        publishes a rate between them. Two fully-documented plans still cannot
        be compared by capacity across that line.
      */
      const result = recommendProfile(
        [
          { profileId: 'claude', ...claude(70, 'claude:max-20x', 'max') },
          {
            profileId: 'codex',
            usage: usage([{ id: 'primary', utilization: 10 }], { subscriptionType: 'plus' }),
            providerId: 'codex',
            capacity: resolvePlanWeight({ providerId: 'codex', pinned: 'codex:plus' }),
          },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('percentage');
      // And so the winner is the one with the larger share, not the larger plan.
      expect(result?.profileId).toBe('codex');
    });

    it('reports that an unpinned tier was assumed', () => {
      // `max` alone cannot say which Max. The floor is used, the ranking still
      // happens, and the flag is what lets the UI offer to be told.
      const result = recommendProfile(
        [
          {
            profileId: 'a',
            usage: usage([{ id: 'five_hour', utilization: 70 }], { subscriptionType: 'max' }),
            providerId: 'claude',
            capacity: resolvePlanWeight({ providerId: 'claude', subscriptionType: 'max' }),
          },
          { profileId: 'b', ...claude(80, 'claude:pro', 'pro') },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('a');
      expect(result?.basis).toBe('weighted');
      expect(result?.assumedPlan).toBe(true);
      // The floor, not the tier the account might actually be on.
      expect(result?.plan?.label).toBe('Max 5x');
    });

    it('does not call a same-plan set weighted', () => {
      // Multiplying every side by the same number changes no order, and "most
      // room" is the stronger, simpler claim. See `basisFor`.
      const result = recommendProfile(
        [
          { profileId: 'a', ...claude(70, 'claude:max-20x', 'max') },
          { profileId: 'b', ...claude(20, 'claude:max-20x', 'max') },
        ],
        { now: NOW },
      );
      expect(result?.basis).toBe('same-plan');
    });
  });
  /*
    The herd, and what stops it.

    `recommendProfile` reads a poll that lags its own consequences: start a
    session, it takes the emptiest account and begins draining it, and for the
    next several minutes that account still *reads* as the emptiest. So it wins
    again, and again, and four sessions land on one profile while the rest sit
    idle. It gets worse with more accounts, because the poll walks them serially
    and a longer cycle is a longer blind window (#146).

    The fix is to subtract what the runs already on an account are committed to
    spending, before ranking. These assert the decision that comes out, not the
    constants it comes out of — see `planLoad.test.ts`.
  */
  describe('with work already running', () => {
    const heavy = { model: 'fable', effort: 'xhigh', ultracode: true };

    it('sends the next session elsewhere rather than onto the account it just filled', () => {
      // The bug, in two lines. Both accounts read identically because the poll
      // has not caught up with the run on `busy`; only the live run tells them
      // apart, and without it the tie would hand this to `busy` on list order.
      const result = recommendProfile(
        [
          { profileId: 'busy', usage: usage([{ id: 'five_hour', utilization: 20 }]), liveRuns: [heavy] },
          { profileId: 'idle', usage: usage([{ id: 'five_hour', utilization: 20 }]) },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('idle');
    });

    it('still prefers a busy account that is genuinely much emptier', () => {
      // The reservation is a thumb on the scale, not a veto. An account with
      // 95% free and one run on it is a better destination than one at 10% free,
      // and a correction that overrode that would just invert the original bug.
      const result = recommendProfile(
        [
          { profileId: 'busy', usage: usage([{ id: 'five_hour', utilization: 5 }]), liveRuns: [heavy] },
          { profileId: 'idle', usage: usage([{ id: 'five_hour', utilization: 90 }]) },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('busy');
    });

    it('weighs a heavy run more than a light one', () => {
      // Two accounts, both busy, both reading the same. The one running Haiku on
      // low is the better destination than the one running Fable on ultracode.
      const result = recommendProfile(
        [
          { profileId: 'fable', usage: usage([{ id: 'five_hour', utilization: 20 }]), liveRuns: [heavy] },
          {
            profileId: 'haiku',
            usage: usage([{ id: 'five_hour', utilization: 20 }]),
            liveRuns: [{ model: 'haiku', effort: 'low' }],
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('haiku');
    });

    it('counts sessions, so the fourth lands somewhere new', () => {
      const result = recommendProfile(
        [
          {
            profileId: 'three',
            usage: usage([{ id: 'five_hour', utilization: 20 }]),
            liveRuns: [heavy, heavy, heavy],
          },
          {
            profileId: 'one',
            usage: usage([{ id: 'five_hour', utilization: 20 }]),
            liveRuns: [heavy],
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('one');
    });

    it('picks the least over-committed when every account is loaded', () => {
      // Nothing is clamped at zero, deliberately. Clamping would tie both at
      // "no room" and hand the answer to list order — quite possibly the more
      // loaded one, which is the worst available answer to "where should this
      // go".
      const result = recommendProfile(
        [
          {
            profileId: 'worse',
            usage: usage([{ id: 'five_hour', utilization: 80 }]),
            liveRuns: [heavy, heavy, heavy, heavy],
          },
          {
            profileId: 'bad',
            usage: usage([{ id: 'five_hour', utilization: 80 }]),
            liveRuns: [heavy, heavy],
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('bad');
    });

    it('does not let one run wipe out a large plan', () => {
      /*
        The units question, and the one arrangement that catches getting it
        wrong.

        A reservation is denominated in points of a *baseline* window, and
        headroom is a percentage of *this* account's. Multiplying headroom by the
        plan weight converts it into baseline points, so the subtraction is like
        from like and the reservation stays an absolute amount.

        Subtract before weighting instead — `(headroom - reserved) * weight` —
        and the penalty gets multiplied by the plan size, so one Fable ultracode
        run costs a Max 20x account twenty times what it actually costs it. The
        numbers below are chosen so that mistake flips the answer: Pro is at 100%
        free and Max 20x at 20%, both carrying one identical run, and Max 20x is
        still by far the better destination because a fifth of its window is four
        Pro windows.
      */
      const result = recommendProfile(
        [
          {
            profileId: 'pro',
            usage: usage([{ id: 'five_hour', utilization: 0 }], { subscriptionType: 'pro' }),
            providerId: 'claude',
            capacity: resolvePlanWeight({ providerId: 'claude', pinned: 'claude:pro' }),
            liveRuns: [heavy],
          },
          {
            profileId: 'max20',
            usage: usage([{ id: 'five_hour', utilization: 80 }], { subscriptionType: 'max' }),
            providerId: 'claude',
            capacity: resolvePlanWeight({ providerId: 'claude', pinned: 'claude:max-20x' }),
            liveRuns: [heavy],
          },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('max20');
      expect(result?.basis).toBe('weighted');
    });

    it('changes nothing when nothing is running', () => {
      // The regression guard. An install where no run is live must rank exactly
      // as it did before any of this existed.
      const idle = recommendProfile(
        [
          { profileId: 'a', usage: usage([{ id: 'five_hour', utilization: 70 }]) },
          { profileId: 'b', usage: usage([{ id: 'five_hour', utilization: 20 }]) },
        ],
        { now: NOW },
      );
      const empty = recommendProfile(
        [
          { profileId: 'a', usage: usage([{ id: 'five_hour', utilization: 70 }]), liveRuns: [] },
          { profileId: 'b', usage: usage([{ id: 'five_hour', utilization: 20 }]), liveRuns: [] },
        ],
        { now: NOW },
      );
      expect(idle?.profileId).toBe('b');
      expect(empty?.profileId).toBe('b');
      expect(empty?.headroom).toBe(idle?.headroom);
    });

    it('reports the account\'s real headroom, not the reserved figure', () => {
      // The reservation decides *where to go*; it is not a claim about the
      // meter. A row reading "12% free" for an account the provider says is 80%
      // free would be this correction leaking into a reading it has no business
      // restating.
      const result = recommendProfile(
        [
          { profileId: 'busy', usage: usage([{ id: 'five_hour', utilization: 20 }]), liveRuns: [heavy] },
          { profileId: 'idle', usage: usage([{ id: 'five_hour', utilization: 25 }]) },
        ],
        { now: NOW },
      );
      expect(result?.profileId).toBe('idle');
      expect(result?.headroom).toBe(75);
    });
  });
});

describe('the live verdict', () => {
  it('binds a rejected window over a fuller allowed one', () => {
    // The exact shape of the bug this exists for: the weekly reads 97 and is
    // refusing, the five-hour reads 98 and is not. The account is limited by
    // the window that is *rejecting*, not the one with the bigger number.
    const reading = usage([
      { id: 'five_hour', utilization: 98 },
      { id: 'seven_day', utilization: 97, status: 'rejected' },
    ]);
    expect(bindingWindow(reading)?.id).toBe('seven_day');
    expect(planHeadroom(reading)).toBe(0);
  });

  it('binds a rejected window even when it has no number at all', () => {
    const reading = usage([
      { id: 'five_hour', utilization: 40 },
      { id: 'seven_day', utilization: null, status: 'rejected' },
    ]);
    expect(bindingWindow(reading)?.id).toBe('seven_day');
    expect(planHeadroom(reading)).toBe(0);
  });

  it('keeps a rejected account in the ranking, at zero, where it can never win', () => {
    const result = recommendProfile(
      [
        {
          profileId: 'spent',
          usage: usage([{ id: 'seven_day', utilization: 60, status: 'rejected' }]),
        },
        { profileId: 'ok', usage: usage([{ id: 'seven_day', utilization: 90 }]) },
      ],
      { now: NOW },
    );
    // 10% of room beats "the provider is refusing", whatever the percentages
    // say — and the refused account still counts among the candidates beaten.
    expect(result?.profileId).toBe('ok');
    expect(result?.candidates).toBe(2);
  });
});

describe('applyPlanLimit', () => {
  const polled = usage([
    { id: 'five_hour', utilization: 33 },
    { id: 'seven_day', utilization: 97 },
  ]);

  it('marks the named window and stamps the merge time', () => {
    const merged = applyPlanLimit(polled, { status: 'rejected', windowId: 'seven_day' }, NOW + 5_000);
    expect(merged).not.toBeNull();
    const window = merged?.windows.find((w) => w.id === 'seven_day');
    expect(window?.status).toBe('rejected');
    // The polled number stands: the report carried a verdict, not a reading.
    expect(window?.utilization).toBe(97);
    expect(merged?.fetchedAt).toBe(NOW + 5_000);
    // The other window is untouched.
    expect(merged?.windows.find((w) => w.id === 'five_hour')?.status).toBeUndefined();
  });

  it('is not news when nothing changed', () => {
    // The provider reports on every API response. An ordinary "allowed" on a
    // window holding no verdict restates the cache and must not broadcast.
    expect(applyPlanLimit(polled, { status: 'ok', windowId: 'five_hour' }, NOW + 1)).toBeNull();
    // Same verdict twice: the second is not news either.
    const rejected = applyPlanLimit(polled, { status: 'rejected', windowId: 'seven_day' }, NOW + 1);
    expect(
      applyPlanLimit(rejected, { status: 'rejected', windowId: 'seven_day' }, NOW + 2),
    ).toBeNull();
  });

  it('clears a held verdict when the provider allows again', () => {
    // A 5-hour window rolling over mid-session arrives as exactly this.
    const rejected = applyPlanLimit(polled, { status: 'rejected', windowId: 'five_hour' }, NOW + 1);
    const cleared = applyPlanLimit(rejected, { status: 'ok', windowId: 'five_hour' }, NOW + 2);
    expect(cleared?.windows.find((w) => w.id === 'five_hour')?.status).toBe('ok');
  });

  it('carries a fresh percentage when the report has one', () => {
    const merged = applyPlanLimit(
      polled,
      { status: 'warning', windowId: 'five_hour', utilization: 91, resetsAt: NOW + 60_000 },
      NOW + 1,
    );
    const window = merged?.windows.find((w) => w.id === 'five_hour');
    expect(window?.utilization).toBe(91);
    expect(window?.resetsAt).toBe(NOW + 60_000);
    expect(window?.status).toBe('warning');
  });

  it('creates the window when nothing has been polled yet', () => {
    const merged = applyPlanLimit(null, { status: 'rejected', windowId: 'five_hour', label: '5 hours' }, NOW);
    expect(merged?.available).toBe(true);
    expect(merged?.windows).toEqual([
      { id: 'five_hour', label: '5 hours', utilization: null, resetsAt: null, status: 'rejected' },
    ]);
  });

  it('never attaches a verdict to a window the report did not name', () => {
    expect(applyPlanLimit(polled, { status: 'rejected' }, NOW)).toBeNull();
  });

  it('keeps the polled label over the report\'s', () => {
    const named = usage([{ id: 'five_hour', utilization: 10, label: '5 hours' }]);
    const merged = applyPlanLimit(
      named,
      { status: 'rejected', windowId: 'five_hour', label: 'five hour' },
      NOW,
    );
    expect(merged?.windows[0]?.label).toBe('5 hours');
  });

  it('replaces an unavailable snapshot rather than merging into it', () => {
    // "No plan limits apply" contradicted by a live verdict: the verdict wins.
    const metered: PlanUsage = { available: false, windows: [], fetchedAt: NOW };
    const merged = applyPlanLimit(metered, { status: 'rejected', windowId: 'five_hour' }, NOW + 1);
    expect(merged?.available).toBe(true);
    expect(merged?.windows).toHaveLength(1);
  });
});

describe('planMeterSlots', () => {
  const at = (id: string, utilization: number | null, label = id): PlanUsageWindow => ({
    id,
    label,
    utilization,
    resetsAt: null,
  });
  const plan = (windows: readonly PlanUsageWindow[]): PlanUsage => ({ available: true, windows, fetchedAt: 0 });

  it('draws the 5-hour, the week and Fable, in that order, whatever order the plan lists them', () => {
    const slots = planMeterSlots(
      plan([at('model_scoped:Fable', 8), at('seven_day', 12), at('model_scoped:Opus', 40), at('five_hour', 61)]),
    );

    expect(slots.map((slot) => [slot.label, slot.window.utilization])).toEqual([
      ['5hr', 61],
      ['Week', 12],
      ['Fable', 8],
    ]);
  });

  it('skips a window the plan does not report rather than drawing it empty', () => {
    // A Codex plan meters a 5-hour and a weekly window and nothing per model.
    const slots = planMeterSlots(plan([at('five_hour', 10), at('seven_day', 40)]));

    expect(slots.map((slot) => slot.label)).toEqual(['5hr', 'Week']);
  });

  it('gives Fable a slot by name only, case-insensitively', () => {
    expect(planMeterSlots(plan([at('five_hour', 1), at('model_scoped:fable', 2)])).map((s) => s.label)).toEqual([
      '5hr',
      'Fable',
    ]);
    // Another model's bucket does not stand in for Fable's.
    expect(planMeterSlots(plan([at('five_hour', 1), at('model_scoped:Opus', 90)])).map((s) => s.label)).toEqual(['5hr']);
  });

  it('falls back to the window closest to full, under its own name, on a plan with none of the three', () => {
    const slots = planMeterSlots(plan([at('primary', 12, '30 days'), at('secondary', 3, '24 hours')]));

    expect(slots).toEqual([{ id: 'primary', label: '30 days', window: at('primary', 12, '30 days') }]);
  });

  it('draws nothing when the plan is unknown or does not apply', () => {
    expect(planMeterSlots(null)).toEqual([]);
    expect(planMeterSlots({ available: false, unavailableReason: 'API key billing', windows: [], fetchedAt: 0 })).toEqual([]);
  });
});
