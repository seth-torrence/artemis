/**
 * The run navigator.
 * ============================================================================
 *
 * One surface for the whole "who runs it, on what, how hard" decision. The
 * profile chip and the model chip on the status line both open this popover: a
 * Finder-style column navigator, columns revealed left to right as picks land
 * — **Profile → Model → Effort** — with a footer of toggles that exist only
 * when the picked combination supports them (fast mode, the permission level)
 * and the read-only facts that travel with the choice (context, plan meters).
 *
 * ## Why one surface
 *
 * The two chips used to open two menus, and the split was profile-blind in
 * exactly the way that mattered: the model menu offered Fable identically
 * whether that account's Fable weekly window was untouched or `rejected`,
 * because nothing in it read `planUsageByProfile`. The data path was already
 * profile-aware — catalogues are fetched per account, pins are per profile —
 * only the decision path was not. Unifying the menus is what lets every model
 * row know the three facts (`modelFacts.ts`): exhaustion, pressure and cost
 * posture, joined through `modelIdentity` rather than string equality.
 *
 * The chips themselves stay on the bar — model and permission remain the
 * always-visible pair — and so does every door the old menus held: Manage,
 * "Edit quick access…", the run-reports note, the disabled-with-reason states.
 * A merged surface may merge chrome; it may not remove information.
 *
 * ## Picks do not close the surface
 *
 * A Finder column's whole point is that a pick lands and the next column
 * answers it: pick a profile and the model column re-reads that account's
 * pins and pressure; pick a model and the effort ladder narrows to its rungs.
 * Closing on every pick would turn three related choices back into three menu
 * trips. Escape and clicking away close it, as they close every menu.
 *
 * ## Row vocabulary is deliberately reusable
 *
 * `ModelFactRow` and `PressureDot` are exported: the §5 hand-off
 * picker presents the same decision — candidates with live meters and
 * disabled-with-reason exhaustion — and must speak the same language rather
 * than a dialect of it.
 */

import { Fragment, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { ListTreeIcon, SearchIcon } from 'lucide-react';
import { bindingWindow, isProfileEnabled } from '@rx-artemis/protocol';
import type {
  PermissionMode,
  PlanRecommendation,
  PlanUsage,
  ProfileId,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderId,
  ProviderModelOption,
} from '@rx-artemis/protocol';

import { usePermissionModes } from '../hooks/useCapability';
import { formatTokens } from '@rx-artemis/transcript';
import { shortenPath } from '../lib/paths';
import {
  ULTRACODE_LEVEL,
  activeCapabilities,
  activeModel,
  activeModels,
  activeProfile,
  activeProviderLabel,
  activeThinkingLevel,
  isLive,
  learnedContextWindow,
  openSettings,
  planRecommendation,
  quickModels,
  serverLocationProfiles,
  setRunLocation,
  setFastMode,
  setModel,
  setPermissionMode,
  setProfile,
  setThinkingLevel,
  thinkingLevels,
  useApp,
} from '../state/store';
import {
  modelExhaustion,
  modelPressure,
  recommendModel,
  type ModelPressure,
} from '../state/modelFacts';
import { hiddenModelCount, navigatorColumns, navigatorFooter, navigatorModelRows } from '../state/runNavigator';
import {
  groupServedAccounts,
  scopedToServedAccount,
  sectionServedAccounts,
  servedAccountSlug,
  servedGaugeFor,
  type ServedAccount,
} from '../state/servedAccounts';
import { useServedAccount } from '../hooks/useServedAccount';
import { usePane, usePaneRef } from '../state/paneContext';
import { UsageRing, meterSlots, toneFor } from './PlanUsageMeter';
import { ProfileSwatch } from './primitives';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Permission-mode vocabulary                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Here rather than in `StatusLine` because both surfaces speak it — the mode
 * chip on the bar and the footer's permission control — and the import must
 * run one way (`StatusLine` imports this file, never the reverse).
 */
export const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'plan',
  default: 'ask',
  acceptEdits: 'accept edits',
  auto: 'auto',
  dontAsk: 'never ask',
  bypassPermissions: 'bypass',
};

export const MODE_NOTES: Record<PermissionMode, string> = {
  plan: 'Research and propose only. No file is written and no command runs.',
  default: 'Prompt for anything not already allowed.',
  acceptEdits: 'Auto-approve file edits; prompt for everything else.',
  auto: 'The provider’s own classifier decides, and prompts on risk.',
  dontAsk: 'Never prompt — deny instead of asking.',
  bypassPermissions: 'Approve everything. Every tool call runs without asking.',
};

/* -------------------------------------------------------------------------- */
/* The surface                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The navigator's content, rendered inside whichever chip's menu opened it.
 *
 * Both chips mount this same component, which is what "their menus unify"
 * means in practice: one implementation, one set of rules, anchored at the
 * chip that was clicked. Only one can be open at a time, so the user only
 * ever sees one navigator.
 */
export function RunNavigatorContent(): ReactElement {
  const modelRevealed = usePane((s) => navigatorColumns(s).model);
  const effortRevealed = usePane((s) => navigatorColumns(s).effort);

  return (
    <DropdownMenuContent
      align="start"
      side="top"
      /*
       * `rounded-xl` restates the surface radius the primitive hardcodes at
       * `rounded-lg`: this is a popover body, and Console draws those one step
       * softer than the rows inside them so the corner reads as an edge of the
       * window rather than of a row.
       *
       * The row rules are scoped here rather than repeated on thirty menu
       * items: a navigator row is highlighted with a wash — a fraction of the
       * ink over whatever is beneath — not with the `accent` surface shadcn
       * reaches for, which is `--float` in dark and so disappears against the
       * popover it sits on. The picked row keeps the lighter wash underneath
       * the highlight, so "what is selected" survives the pointer moving away
       * from it.
       */
      className={cn(
        'w-fit rounded-[10px] p-0',
        '[&_[data-slot=dropdown-menu-item]]:rounded-md [&_[data-slot=dropdown-menu-radio-item]]:rounded-md',
        '[&_[data-slot=dropdown-menu-item]:focus]:bg-wash-strong',
        '[&_[data-slot=dropdown-menu-radio-item]:focus]:bg-wash-strong',
        '[&_[data-slot=dropdown-menu-sub-trigger]:focus]:bg-wash-strong',
        '[&_[data-slot=dropdown-menu-sub-trigger][data-state=open]]:bg-wash-strong',
        '[&_[data-slot=dropdown-menu-radio-item][data-state=checked]]:bg-wash',
      )}
    >
      <div className="flex items-stretch divide-x divide-hairline">
        <ProfileColumn />
        {modelRevealed ? <ModelColumn /> : null}
        {effortRevealed ? <EffortColumn /> : null}
      </div>
      <NavigatorFooter />
    </DropdownMenuContent>
  );
}

/** Shared column chrome: fixed width, its own scroll, one text column. */
function Column({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={cn('flex max-h-80 w-56 flex-col overflow-y-auto p-1.5', className)}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Column 1: Profile                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every profile, grouped by the provider that owns it.
 *
 * Providers keep their catalogue order — the order `providers:list` reported —
 * so the sections do not reshuffle as accounts are added. A profile whose
 * provider is not in that list still gets a section, keyed by its raw id: an
 * account is not worth hiding because the build it belongs to is missing, and
 * that is exactly when someone needs to see it.
 */
function profilesByProvider(
  profiles: readonly ProfileMetadata[],
  providers: readonly ProviderDescriptor[],
): readonly { readonly id: ProviderId; readonly label: string; readonly profiles: readonly ProfileMetadata[] }[] {
  const order = new Map<ProviderId, string>();
  for (const provider of providers) order.set(provider.id, provider.label);
  for (const profile of profiles) {
    if (!order.has(profile.providerId)) order.set(profile.providerId, profile.providerId);
  }

  const sections = [];
  for (const [id, label] of order) {
    const owned = profiles.filter((p) => p.providerId === id);
    if (owned.length > 0) sections.push({ id, label, profiles: owned });
  }
  return sections;
}

/**
 * The first column: which account runs.
 *
 * The rules are the profile menu's, unchanged — this column *is* that menu,
 * rehomed:
 *
 * - **Not scoped to the active provider.** A profile belongs to exactly one
 *   CLI, so the provider follows the account; grouping by provider is what
 *   makes one flat list readable and puts "switching account can switch CLI"
 *   in front of the person doing it.
 * - **A disabled profile is missing, unless it is the one running.** Hiding is
 *   the entire effect of `disabled`; the running account stays because a radio
 *   group whose value names no row paints no check, and the row says why it is
 *   there rather than looking like the filter leaked.
 * - **Mid-run the rows go quiet, with the reason above them once.** `setProfile`
 *   refuses mid-run — a session belongs to the account it started on — and this
 *   is where that is said *before* the click rather than in a banner after it.
 *   The column still opens: it also holds Manage and every account's sign-in
 *   state, none of which a run has any bearing on.
 */
/**
 * The server's accounts, as the first column when the pane runs there.
 *
 * Rows are the catalogue's own grouping: every route is `account/model`, so
 * the accounts are the route prefixes and picking one picks its first model
 * (the model column then narrows within it). Each row wears the account's
 * gauge from the served-usage map, matched by label — the server enforces
 * label uniqueness for exactly this reason (a slug is an address).
 */
function ServerAccountRows({ profileId }: { readonly profileId: ProfileId }): ReactElement {
  const pane = usePaneRef();
  const catalogue = usePane(activeModels);
  const selected = usePane(activeModel);
  const live = usePane(isLive);
  const gauges = useApp((s) => s.planUsageByServerAccount);

  const accounts = useMemo(() => groupServedAccounts(catalogue), [catalogue]);
  // The local provider list names the sections. The ids are the same union on
  // both sides — one product — so a server's `codex` account files under the
  // heading this build calls Codex, and a provider it has never heard of keeps
  // its raw id rather than vanishing.
  const providers = useApp((s) => s.providers);
  const sections = useMemo(
    () => sectionServedAccounts(accounts, providers),
    [accounts, providers],
  );

  // Exact join on the serving side's id where the catalogue carries one; the
  // label match is the fallback for a server old enough not to send it.
  const gaugeFor = (account: ServedAccount): { readonly usage: PlanUsage } | undefined => {
    if (account.id !== undefined) {
      const exact = gauges[`${profileId}/${account.id}`];
      if (exact !== undefined) return exact;
    }
    for (const [key, entry] of Object.entries(gauges)) {
      if (key.startsWith(`${profileId}/`) && entry.label === account.label) return entry;
    }
    return undefined;
  };

  const activeSlug = servedAccountSlug(selected);

  return (
    <>
      <DropdownMenuLabel className="chrome-label text-2xs text-ink-faint">
        Account on this server
      </DropdownMenuLabel>
      {accounts.length === 0 ? (
        <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
          The server serves no models yet. Sign an account in from its profile card.
        </p>
      ) : (
        <DropdownMenuRadioGroup
          value={activeSlug ?? ''}
          onValueChange={(slug) => {
            const account = accounts.find((candidate) => candidate.slug === slug);
            if (account !== undefined && account.models[0] !== undefined && !live) {
              setModel(account.models[0], pane);
            }
          }}
        >
          {/*
           * Sectioned by provider, the same as the local account column above.
           * One section comes back unheaded, so a server whose accounts are all
           * on one provider — and any server too old to say — draws exactly the
           * flat list it always did.
           */}
          {sections.map((section, index) => (
            <Fragment key={section.providerId ?? `ungrouped-${String(index)}`}>
              {section.label === null ? null : (
                <DropdownMenuLabel className="text-2xs text-ink-faint">
                  {section.label}
                </DropdownMenuLabel>
              )}
              {section.accounts.map((account) => {
                const gauge = gaugeFor(account);
                const window = gauge === undefined ? null : bindingWindow(gauge.usage);
                return (
                  <DropdownMenuRadioItem
                    key={account.slug}
                    value={account.slug}
                    className="text-2xs"
                    disabled={live}
                  >
                    <span className="min-w-0 flex-1 truncate">{account.label}</span>
                    {window !== null && window.utilization !== null ? (
                      /* `utilization` is already 0–100 — see `PlanUsageWindow`. */
                      <span className={cn('ml-2 font-mono text-2xs', toneFor(window.utilization))}>
                        {String(Math.round(window.utilization))}%
                      </span>
                    ) : null}
                  </DropdownMenuRadioItem>
                );
              })}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      )}
    </>
  );
}

function ProfileColumn(): ReactElement {
  const pane = usePaneRef();
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);
  const platform = useApp((s) => s.platform);
  const activeId = usePane((s) => s.activeProfileId);
  const live = usePane(isLive);

  /*
   * The location tier. A server is a *place that runs accounts*, not an
   * account — so when one is configured it gets the tier above the account
   * list, and its profile row leaves the Local sections entirely. Where the
   * pane currently runs is read off the active profile rather than the
   * sticky preference, so the tier can never disagree with the pane it
   * describes; the sticky value is what `newSession` consults.
   */
  const servers = useMemo(() => serverLocationProfiles(profiles), [profiles]);
  const activeProfile = profiles.find((p) => p.id === activeId);
  const atServer = activeProfile?.providerId === 'artemis' ? activeProfile.id : null;

  const selectable = useMemo(
    () =>
      profiles.filter(
        (p) =>
          (isProfileEnabled(p) || p.id === activeId) &&
          // With a tier to hold them, servers are locations, not rows here.
          (servers.length === 0 || p.providerId !== 'artemis'),
      ),
    [profiles, activeId, servers],
  );
  const sections = useMemo(
    () => profilesByProvider(selectable, providers),
    [selectable, providers],
  );

  return (
    <Column>
      {servers.length > 0 ? (
        <>
          <DropdownMenuLabel className="chrome-label text-2xs text-ink-faint">
            Where
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={atServer ?? 'local'}
            onValueChange={(value) => setRunLocation(value as 'local' | ProfileId, pane)}
          >
            <DropdownMenuRadioItem value="local" className="text-2xs" disabled={live}>
              {/* The window's own machine, named in its own vocabulary — a
                  Windows user reading "This Mac" concludes the row is someone
                  else's computer. */}
              {platform === 'darwin' ? 'This Mac' : platform === 'win32' ? 'This PC' : 'This machine'}
            </DropdownMenuRadioItem>
            {servers.map((server) => (
              <DropdownMenuRadioItem
                key={server.id}
                value={server.id}
                className="text-2xs"
                disabled={live}
              >
                {server.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
        </>
      ) : null}

      {atServer !== null ? (
        <ServerAccountRows profileId={atServer} />
      ) : (
        <>
      {/* Suppressed rather than disabled while a run is going: this row is an
          action ("take me there") and there is nowhere to be taken. The line
          below says why, which is more use than a greyed shortcut. */}
      {live ? null : <RecommendedProfile />}

      {live ? (
        <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
          A run is going. A session belongs to the account it started on, so accounts move
          when it ends.
        </p>
      ) : null}

      {sections.length === 0 ? (
        /*
          Two different dead ends, and they need different sentences. "No
          profile exists" is the first-run state and the answer is to make
          one; "every profile is disabled" is a thing the user did, and the
          answer is to undo it — telling them nothing exists would be a lie
          about their own accounts.
        */
        <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
          {profiles.length === 0
            ? 'No profile exists yet. A run needs an account, which comes from a profile.'
            : 'Every profile is disabled. A run needs an account — turn one back on in Manage.'}
        </p>
      ) : (
        <DropdownMenuRadioGroup
          value={activeId ?? ''}
          onValueChange={(value) => setProfile(value as ProfileId, pane)}
        >
          {sections.map((section, index) => (
            <Fragment key={section.id}>
              {/*
               * The heading is dropped when there is only one provider, where
               * it would label a distinction the user does not have. It
               * appears the moment a second one exists, which is also the
               * moment picking a profile starts changing which CLI runs.
               */}
              {index === 0 ? (
                <DropdownMenuLabel className="chrome-label text-2xs text-ink-faint">
                  Profile
                </DropdownMenuLabel>
              ) : null}
              {/*
                Provider sub-headers only when there is more than one — the
                mockup's own profile column does exactly this ("OpenAI" under
                the rows). The column's name above is 7D's; the sub-header
                still marks where picking a profile starts changing which CLI
                runs.
              */}
              {sections.length > 1 ? (
                <>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel className="text-2xs text-ink-faint">
                    {section.label}
                  </DropdownMenuLabel>
                </>
              ) : null}
              {section.profiles.map((candidate) => (
                <ProfileItem key={candidate.id} id={candidate.id} locked={live} />
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      )}
        </>
      )}

      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-2xs"
        // Aimed at the list itself, not just the pane: "Manage" from this
        // surface means "show me my profiles", not "show me the top of a page
        // that has them".
        onSelect={() => openSettings('profiles', { row: 'profile-list' })}
      >
        Manage
      </DropdownMenuItem>
    </Column>
  );
}

/**
 * The sentence behind the Recommended row, which is where the whole argument
 * lives. The row is a name; this is the case for it, and it has to be
 * *self-correcting* — a reader who disagrees should be able to see which step
 * they disagree with, because every basis is a different quality of evidence.
 * (See `PlanRecommendationBasis` for what each claim is allowed to mean.)
 */
function explainRecommendation(recommendation: PlanRecommendation): string {
  const share = `${String(Math.round(recommendation.headroom))}% free on its ${recommendation.binding.label} limit`;
  const across = `across ${String(recommendation.candidates)} accounts`;

  const basis =
    recommendation.basis === 'same-plan'
      ? `${share} — the most room ${across} on this plan.`
      : recommendation.basis === 'weighted'
        ? // The plan is named because the number on its own now understates the
          // pick — 30% of a Max 20x window is six Pro windows.
          `${share}, and ${recommendation.plan?.label ?? 'its plan'} is the largest plan in play — the most actual capacity ${across}, not the largest percentage.`
        : `${share} — the largest share of its own plan ${across}. They are on different plans, and providers report only percentages, never how much a plan holds, so this is not a comparison of capacity.`;

  if (!recommendation.assumedPlan || recommendation.basis !== 'weighted') return basis;
  return `${basis} That tier is an assumption — the provider reports a plan family, never which tier of it — so set the exact plan on the profile if it is wrong.`;
}

/**
 * Which account has room right now, at the top of the column.
 *
 * A `DropdownMenuItem` outside the radio group rather than a duplicate radio
 * row inside it: two radio items with one value both paint their check, which
 * reads as two accounts active at once — and the recommendation is an action
 * ("take me there"), not a fifth state of the choice below. It renders nothing
 * when there is no comparison to make — one account, stale readings, metered
 * billing; `recommendProfile` holds those rules and explains each.
 */

/**
 * 7D's `.rc` pill — the word "rec" worn by the row itself, in the accent's
 * reading colour. It replaces a `DropdownMenuLabel` that said "Recommended"
 * above the row: the label spent a whole row on a fact about the next row,
 * and the mockup's inline pill says the same thing in the row's own gutter.
 * The explanatory sentence stays on the row's `title`.
 */
function RecPill(): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 rounded-full border border-beam-text px-[5px] py-px font-mono text-[9px] leading-none text-beam-text"
    >
      rec
    </span>
  );
}

function RecommendedProfile(): ReactElement | null {
  const pane = usePaneRef();
  const profiles = useApp((s) => s.profiles);
  const usageByProfile = useApp((s) => s.planUsageByProfile);

  /*
   * `Date.now()` is captured at mount, not on every render, and that is exactly
   * right here: Radix mounts this content when the surface opens, so the
   * staleness rule is re-judged at the moment the user is about to act on the
   * answer. A `useApp` selector could not return this — see `planRecommendation`.
   */
  const recommendation = useMemo(
    () => planRecommendation(profiles, usageByProfile, Date.now()),
    [profiles, usageByProfile],
  );
  if (recommendation === null) return null;

  const profile = profiles.find((p) => p.id === recommendation.profileId);
  if (!profile) return null;

  const why = explainRecommendation(recommendation);

  return (
    <>
      <DropdownMenuItem
        className="gap-1.5 py-[7px] text-2xs"
        onSelect={() => setProfile(profile.id, pane)}
        title={why}
      >
        <ProfileSwatch color={profile.color} />
        <span className="min-w-0 flex-1 truncate text-ink">{profile.label}</span>
        <RecPill />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * One profile row: swatch, name, quiet facts beside it, and how full the
 * account is at the row's end — the binding window, coloured on the same
 * thresholds as the rings (`toneFor`), read down the column so ten accounts
 * can be compared without reading each one. Rendered straight off the polled
 * map, never a fetch: a cache-miss escalation per row would spawn one CLI
 * subprocess per profile every time the surface opened.
 */
function ProfileItem({
  id,
  locked = false,
}: {
  readonly id: ProfileId;
  /** A run is going, so no row is selectable. The column says why once, above. */
  readonly locked?: boolean;
}): ReactElement | null {
  const profile = useApp((s) => s.profiles.find((p) => p.id === id));
  const status = useApp((s) => s.authByProfile[id]);
  const usage = useApp((s) => s.planUsageByProfile[id]);
  const polledTier = usage?.subscriptionType;
  const platform = useApp((s) => s.platform);
  if (!profile) return null;

  const path = shortenPath(profile.configDir, { platform, max: 60 });
  /*
   * The plan tier, from whichever source has it. Gated on *not having been
   * checked and found signed out* rather than on having been checked and found
   * signed in — the same rule the chip's amber follows. The auth probe's own
   * answer wins where there is one, because it is the more direct read; the
   * polled `subscriptionType` covers every fresh launch, where `authByProfile`
   * is empty until the profiles screen has been opened.
   */
  const tier =
    status?.loggedIn === false ? undefined : (status?.subscriptionType ?? polledTier);

  /*
   * `bindingWindow` rather than a particular window or an average: a plan is
   * as full as its tightest limit. Absent until the poll has been round, and
   * absent forever on metered billing — both render nothing rather than a zero.
   */
  const binding = bindingWindow(usage);
  const capacity = binding?.utilization ?? null;
  // The provider's live verdict, when one has been heard. A rejected account
  // showing its last polled percentage is the menu repeating the exact
  // misreading the verdict corrects.
  const rejected = binding?.status === 'rejected';

  return (
    <DropdownMenuRadioItem
      value={profile.id}
      disabled={locked}
      className="gap-2 text-2xs"
      /*
        Selecting a profile keeps the surface open: the pick lands and the
        model column to the right re-answers for the new account, which is the
        entire point of a column navigator. Escape still closes.
      */
      onSelect={(event) => event.preventDefault()}
      title={
        [
          status?.email,
          rejected
            ? `its ${binding?.label ?? ''} limit is reached — requests are being refused`
            : capacity === null
              ? undefined
              : `${String(Math.round(capacity))}% of its ${binding?.label ?? ''} limit used`,
          path,
        ]
          .filter(Boolean)
          .join(' — ') || path
      }
    >
      {/*
       * The name is the only flexible thing on the row: `min-w-0`+`truncate` on
       * it, `shrink-0` on the texts after it, so under pressure the name elides
       * and the tier survives.
       */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <ProfileSwatch color={profile.color} />
        <span className="min-w-0 truncate text-ink">{profile.label}</span>
        {tier !== undefined ? <span className="shrink-0 text-ink-faint">{tier}</span> : null}
        {isProfileEnabled(profile) ? null : (
          <span className="shrink-0 text-ink-faint italic">disabled</span>
        )}
        {status !== undefined && !status.loggedIn ? (
          <span className="shrink-0 text-amber">signed out</span>
        ) : null}
      </span>
      {rejected ? (
        <span className="shrink-0 tabular-nums text-signal">out</span>
      ) : capacity === null ? null : (
        <span className={cn('shrink-0 tabular-nums', toneFor(capacity))}>
          {Math.round(capacity)}%
        </span>
      )}
    </DropdownMenuRadioItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Column 2: Model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The second column: which model, with the three facts on every row.
 *
 * Pins first, catalogue behind the search, "Edit quick access…" as the door to
 * the full list — the old picker's shape, kept. What is new is that each row
 * now reads the profile's plan: exhaustion disables it with the reason and
 * reset inline, pressure tints its meter dot, and cost posture prints the
 * exact `MODEL_LOAD` multiplier so "fable = 8× sonnet against your plan" is
 * visible at selection time rather than discovered at the weekly wall.
 */
function ModelColumn(): ReactElement {
  const pane = usePaneRef();
  const profileId = usePane((s) => s.activeProfileId);
  const catalogue = usePane(activeModels);
  const fullQuick = usePane(quickModels);
  const selected = usePane(activeModel);
  const providerLabel = usePane(activeProviderLabel);
  const atServer = usePane((s) => activeProfile(s)?.providerId === 'artemis');
  // What the *run* reports it is actually using, which can differ from what
  // was asked for — the provider may substitute. Shown once it is known.
  const running = usePane((s) => s.run?.model);
  const gauges = useApp((s) => s.planUsageByServerAccount);
  const profileUsage = useApp((s) =>
    profileId === null ? undefined : s.planUsageByProfile[profileId],
  );

  /*
   * At a server the flattened catalogue holds every account's copy of every
   * model, so two Claude accounts list "Opus 5" twice with nothing visible to
   * tell the rows apart. The account column above already made that choice —
   * so the *default* list narrows to it: the pins that belong to the account,
   * or its whole slice of the catalogue when no pin survives the narrowing.
   * The search deliberately does not narrow — its placeholder says "all
   * models", `navigatorModelRows`'s own doc promises the whole catalogue, and
   * a hit in another account is a legitimate way to switch account and model
   * in one pick (the account radio follows the selection's slug). The counts
   * stay full-catalogue for the same reason: "N more" is the door to
   * everything this server serves, not to the slice already showing.
   */
  const activeSlug = atServer ? servedAccountSlug(selected) : null;
  const quick = useMemo(() => {
    if (activeSlug === null) return fullQuick;
    const scopedQuick = fullQuick.filter((model) => servedAccountSlug(model) === activeSlug);
    return scopedQuick.length > 0 ? scopedQuick : scopedToServedAccount(catalogue, activeSlug);
  }, [fullQuick, activeSlug, catalogue]);

  // At a server the gauge that gates a row is its own account's, not the
  // profile's — the profile map has no entry for a server on purpose. This is
  // the *selected* account's reading, for the footer's recommendation; each
  // row reads its own below.
  const usage = atServer
    ? (profileId === null ? undefined : servedGaugeFor(gauges, profileId, selected)?.usage)
    : profileUsage;

  const [query, setQuery] = useState('');
  // Captured per mount — Radix mounts this content on open, so exhaustion and
  // recommendation are judged at the moment the user is about to act.
  const [now] = useState(() => Date.now());

  const listed = useMemo(
    () => navigatorModelRows(catalogue, quick, selected, query),
    [catalogue, quick, selected, query],
  );
  const recommendation = useMemo(
    () => recommendModel(quick, selected, usage, now),
    [quick, selected, usage, now],
  );

  if (catalogue.length === 0) {
    // Revealed but dead, with the same sentence the chip's disabled state
    // carries — the column must not vanish while the chip explains.
    return (
      <Column>
        <DropdownMenuLabel className="chrome-label text-2xs text-ink-faint">Model</DropdownMenuLabel>
        <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
          {providerLabel} does not offer a model choice, so Artemis sends no model and the
          provider picks its own.
        </p>
      </Column>
    );
  }

  const hidden = hiddenModelCount(catalogue.length, listed.length);
  // The search earns its box only when it can reach something the list does
  // not already show — a search over a list you can see all of is furniture.
  const searchable = hidden > 0 || catalogue.length > 8 || query.trim().length > 0;

  return (
    <Column className="w-64">
      {/* The column's own name, like its two siblings — the label below this
          point had only ever rendered in the no-model-choice branch. */}
      <DropdownMenuLabel className="chrome-label text-2xs text-ink-faint">Model</DropdownMenuLabel>
      {recommendation !== null ? (
        <>
          <DropdownMenuItem
            className="gap-1.5 py-[7px] text-2xs"
            onSelect={() => setModel(recommendation.model.id, pane)}
            title={`${String(Math.round(recommendation.headroom))}% of its ${recommendation.binding.label} window is unused, against ${String(Math.round(recommendation.selectedHeadroom))}% for ${selected?.label ?? 'the selected model'} — ranked across ${String(recommendation.candidates)} pinned models.`}
          >
            <span className="min-w-0 flex-1 truncate text-ink">{recommendation.model.label}</span>
            <RecPill />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}

      {searchable ? (
        <div className="relative mx-1 mb-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            /*
              The menu owns every printable key for typeahead; without the
              stop, typing into this box would also walk the focus through the
              rows below it. Navigation keys are let through on purpose —
              Escape must still close, arrows must still move.
            */
            onKeyDown={(event) => {
              if (event.key.length === 1 || event.key === 'Backspace') event.stopPropagation();
            }}
            placeholder="Search all models…"
            aria-label="Search models"
            spellCheck={false}
            className="h-6 w-full rounded-md border border-hairline-strong bg-inset/60 pr-2 pl-6 font-mono text-2xs text-ink outline-none placeholder:text-ink-faint focus:border-ring"
          />
        </div>
      ) : null}

      <DropdownMenuRadioGroup
        value={selected?.id ?? ''}
        onValueChange={(value) => setModel(value, pane)}
      >
        {listed.map((model) => (
          <ModelFactRow
            key={model.id}
            model={model}
            // A search can surface another account's rows, and a row's
            // exhaustion and pressure belong to the account that would be
            // billed — its own, not the one currently picked.
            usage={
              (atServer && profileId !== null
                ? servedGaugeFor(gauges, profileId, model)?.usage
                : usage) ?? null
            }
            now={now}
          />
        ))}
      </DropdownMenuRadioGroup>

      {listed.length === 0 ? (
        <p className="px-2 py-3 text-center text-2xs text-ink-faint">
          No model matches “{query}”.
        </p>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="h-6 gap-1.5 px-2 text-2xs"
        // The row anchor is what makes this "Edit quick access" rather than
        // "open the Models pane": the pins live below the provenance block
        // and the catalogue header, and the click promised the pins.
        onSelect={() => openSettings('models', { row: 'quick-access' })}
      >
        <ListTreeIcon className="size-3 shrink-0" aria-hidden="true" />
        Edit quick access…
        {hidden > 0 ? (
          <span className="ml-auto font-mono text-2xs text-ink-faint">{hidden} more</span>
        ) : null}
      </DropdownMenuItem>

      {running && running !== selected?.resolvedModel && running !== selected?.id ? (
        <p className="px-2 pt-0.5 pb-1.5 font-mono text-2xs text-ink-faint">
          this run reports: {running}
        </p>
      ) : null}
    </Column>
  );
}

/**
 * One model row that knows the three facts.
 *
 * Anatomy: name flush left; `$`-pips with the exact multiplier beside it; the
 * pressure dot and the binding window's number at the trailing edge, read down
 * the column exactly like the profile rows' caps. An exhausted model keeps its
 * place, struck through, with the reason and reset inline — the `GatedItem`
 * precedent: a row that vanishes is a model the user concludes was taken away.
 *
 * Exported for the §5 hand-off picker, which presents the same decision and
 * must speak the same row vocabulary.
 */
export function ModelFactRow({
  model,
  usage,
  now,
}: {
  readonly model: ProviderModelOption;
  readonly usage: PlanUsage | null;
  readonly now: number;
}): ReactElement {
  const exhausted = modelExhaustion(model, usage, now);
  const pressure = modelPressure(model, usage);

  return (
    /*
     * Name flush left, tick on the right — shadcn's radio item reserves the
     * left gutter for its indicator, which would indent every name past the
     * labels around it; the indicator moves to the trailing edge instead so
     * the surface keeps one text column.
     */
    <DropdownMenuRadioItem
      value={model.id}
      disabled={exhausted !== null}
      // A pick lands and the effort column re-answers; the surface stays open.
      onSelect={(event) => event.preventDefault()}
      className="py-1 pr-7 pl-2 text-xs data-disabled:opacity-100 [&>span:first-child]:right-2 [&>span:first-child]:left-auto"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate',
              exhausted === null ? 'text-ink' : 'text-ink-faint line-through',
            )}
          >
            {model.label}
          </span>
          {pressure !== null ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <PressureDot pressure={pressure} />
              {pressure.window.status === 'rejected' ? (
                <span className="tabular-nums text-signal">out</span>
              ) : pressure.utilization === null ? null : (
                <span className={cn('tabular-nums', toneFor(pressure.utilization, pressure.window.status))}>
                  {Math.round(pressure.utilization)}%
                </span>
              )}
            </span>
          ) : null}
        </span>
        {exhausted !== null ? (
          <span className="text-2xs leading-snug text-ink-faint no-underline">
            {exhausted.reason}
          </span>
        ) : null}
      </span>
    </DropdownMenuRadioItem>
  );
}

/*
 * REMOVED: `CostPips` — the `$` pips and multiplier that sat beside every
 * model name here, in the palette and in settings. Editorial where the rows
 * needed facts: the pressure dot and the plan meters already say what is
 * left, and pricing a model in dollar glyphs at selection time second-guessed
 * a choice the user is equipped to make (removed 2026-08-30, by request).
 * `costPosture` and `MODEL_LOAD` stay in `state/modelFacts.ts` — the data
 * outlived its costume; nothing renders it today.
 */

/**
 * The row's meter dot: pressure at a glance, matching `PlanUsageMeter`
 * semantics — a warning verdict tints it whatever the percentage reads, and a
 * rejected window draws full (solid signal) regardless.
 */
export function PressureDot({ pressure }: { readonly pressure: ModelPressure }): ReactElement {
  const { window, utilization } = pressure;
  const tone =
    window.status === 'rejected'
      ? 'bg-signal'
      : window.status === 'warning'
        ? 'bg-amber'
        : utilization === null
          ? 'bg-line'
          : utilization >= 90
            ? 'bg-signal'
            : utilization >= 75
              ? 'bg-amber'
              : 'bg-mint';
  return (
    <span
      aria-hidden="true"
      title={`${window.label} is the window that binds this model`}
      className={cn('size-1.5 shrink-0 rounded-full', tone)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Column 3: Effort                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The third column: the thinking ladder, `low` up to ultracode.
 *
 * One list, not a submenu — a column navigator's last column *is* the ladder.
 * Ultracode is the top rung rather than a switch (see `ULTRACODE_LEVEL` for
 * the translation) and remains mutually exclusive with fast mode: picking it
 * clears the flag in the action itself (`setThinkingLevel`), so the footer's
 * switch below cannot disagree with the rung chosen here. A rung the selected
 * model cannot do is disabled and unexplained, the same deliberate silence the
 * old ladder kept — the answer is always "this model does not do that".
 */
function EffortColumn(): ReactElement | null {
  const pane = usePaneRef();
  const levels = usePane(thinkingLevels);
  const current = usePane(activeThinkingLevel);
  if (levels.length === 0) return null;

  return (
    <Column className="w-64">
      <DropdownMenuLabel className="chrome-label text-2xs text-ink-faint">Effort</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={current ?? ''}
        onValueChange={(value) => setThinkingLevel(value, pane)}
      >
        {levels.map((level) => (
          <DropdownMenuRadioItem
            key={level.id}
            value={level.id}
            disabled={!level.available}
            onSelect={(event) => event.preventDefault()}
            className="items-start text-2xs"
          >
            <span className="flex min-w-0 flex-col">
              <span className={cn(level.id === ULTRACODE_LEVEL ? 'text-beam-text' : 'text-ink')}>
                {level.label}
              </span>
              <span className="text-2xs leading-snug text-ink-faint">{level.note}</span>
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </Column>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                     */
/* -------------------------------------------------------------------------- */

/** Shared chrome for a footer row: label, then control at the trailing edge. */
function ShapeRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex h-6 items-center gap-2 px-2">
      <span className="shrink-0 text-2xs text-ink-faint">{label}</span>
      <span className="ml-auto flex min-w-0 items-center">{children}</span>
    </div>
  );
}

/**
 * The footer: toggles that exist only when the picked combination supports
 * them, and the read-only facts that travel with the choice.
 *
 * Fast mode keeps the model popover's exact rules (`navigatorFooter` holds
 * them): hidden when the *provider* has no such concept, disabled without a
 * reason when the *model* does not — the answer is always "this model does not
 * do that", which the dead switch already says. The permission level is the
 * same choice the mode chip owns, offered here because it completes "what will
 * the next prompt do" without a second trip; the chip stays on the bar as the
 * always-visible pair's other half. Context readout and plan meters stay in
 * the footer — both answer "how much room is left" for the combination picked
 * above them.
 */
function NavigatorFooter(): ReactElement | null {
  const fastPresence = usePane((s) => navigatorFooter(s).fastMode);
  const fastShown = usePane((s) => navigatorFooter(s).fastModeOn);
  const modes = usePermissionModes();
  const window = usePane(learnedContextWindow);
  const profileId = usePane((s) => s.activeProfileId);
  const planSupported = usePane((s) => activeCapabilities(s).planUsageReporting);
  const profileUsage = useApp((s) =>
    profileId === null ? null : (s.planUsageByProfile[profileId] ?? null),
  );
  // At a server the meters describe the account behind the pick above, whose
  // reading lives in the served map — the profile map holds nothing for it.
  const served = useServedAccount();
  const pane = usePaneRef();
  const mode = usePane((s) => s.permissionMode);

  const usage = served.atServer ? (served.gauge?.usage ?? null) : profileUsage;
  const slots = planSupported && usage?.available === true ? meterSlots(usage) : [];
  const anything =
    fastPresence !== 'absent' || modes.length > 0 || window !== undefined || slots.length > 0;
  if (!anything) return null;

  return (
    <div className="border-t border-hairline p-1">
      {fastPresence !== 'absent' ? (
        <ShapeRow label="Fast mode">
          <Switch
            checked={fastShown}
            disabled={fastPresence === 'disabled'}
            onCheckedChange={(next) => setFastMode(next, pane)}
            aria-label="Fast mode"
            className="scale-90"
          />
        </ShapeRow>
      ) : null}

      {modes.length > 0 ? (
        <DropdownMenuSub>
          {/*
            `[&>svg:last-child]:ml-0` kills the `ml-auto` shadcn puts on the
            submenu chevron: two `ml-auto` elements in one flex row split the
            free space between them, and only the value should push.
          */}
          <DropdownMenuSubTrigger className="h-6 gap-2 px-2 py-0 text-2xs [&>svg:last-child]:ml-0">
            <span className="text-ink-faint">Permission</span>
            <span
              className={cn(
                'ml-auto',
                mode === 'bypassPermissions' && modes.includes(mode)
                  ? 'text-signal'
                  : modes.includes(mode)
                    ? 'text-ink'
                    : 'text-amber',
              )}
            >
              {modes.includes(mode) ? MODE_LABELS[mode] : `${mode} (not accepted)`}
            </span>
          </DropdownMenuSubTrigger>
          {/* Fixed width for the notes to wrap at, not a min-width for
              max-content to blow past — the lesson the thinking ladder taught.
              The row rules are restated because a submenu is portalled out of
              the content above and inherits none of its scoped classes. */}
          <DropdownMenuSubContent
            className={cn(
              'w-72 rounded-xl',
              '[&_[data-slot=dropdown-menu-radio-item]]:rounded-md',
              '[&_[data-slot=dropdown-menu-radio-item]:focus]:bg-wash-strong',
              '[&_[data-slot=dropdown-menu-radio-item][data-state=checked]]:bg-wash',
            )}
          >
            <DropdownMenuLabel className="text-2xs text-ink-faint">
              When should the agent ask before acting?
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mode}
              onValueChange={(value) => setPermissionMode(value as PermissionMode, pane)}
            >
              {modes.map((value) => (
                <DropdownMenuRadioItem key={value} value={value} className="items-start text-2xs">
                  <span className="flex min-w-0 flex-col">
                    <span className={cn(value === 'bypassPermissions' ? 'text-signal' : 'text-ink')}>
                      {MODE_LABELS[value]}
                    </span>
                    <span className="text-2xs leading-snug text-ink-faint">{MODE_NOTES[value]}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}

      {window !== undefined ? (
        /*
          A fact, not a control: the number is *learned* from a completed run
          rather than declared by the catalogue, so it is blank until this
          model has run once. Blank is the honest state.
        */
        <ShapeRow label="Context">
          <span className="font-mono text-2xs text-ink-muted">{formatTokens(window)}</span>
        </ShapeRow>
      ) : null}

      {slots.length > 0 ? (
        <ShapeRow label="Plan">
          <span className="flex items-center gap-2">
            {slots.map((slot) => (
              <span key={slot.key} className="flex shrink-0 items-center gap-1">
                <span className="font-mono text-2xs text-ink-faint">{slot.label}</span>
                <UsageRing
                  utilization={slot.window?.utilization ?? null}
                  status={slot.window?.status}
                />
              </span>
            ))}
          </span>
        </ShapeRow>
      ) : null}
    </div>
  );
}
