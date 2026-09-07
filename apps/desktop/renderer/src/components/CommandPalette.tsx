/**
 * The command palette (⌘K / Ctrl-K).
 * ============================================================================
 *
 * The keyboard route to everything, and it stays that way now that the sidebar
 * exists. The two are not redundant: the sidebar is for *browsing* history —
 * grouped by project, scanned by eye — and this is for *reaching* a session or
 * a setting by typing four characters of its name. Removing the sessions page
 * here because the sidebar lists them would take the fast path away from
 * exactly the users who care most about it.
 *
 * ## Capability gating, in a list
 *
 * The rule elsewhere in the app is that an unsupported control renders disabled
 * *with a reason* rather than disappearing. That is harder in a command list,
 * where a disabled row is easy to skip past silently — so a gated group here
 * keeps its heading and replaces its items with the sentence explaining why
 * there are none. A user who cannot find "Resume session" learns that this
 * provider cannot resume one, instead of concluding Artemis lost the feature.
 *
 * Two capabilities gate the session entries and they are genuinely independent:
 *
 *  - `listSessions` — can past sessions be enumerated at all? Without it there
 *    is nothing to list.
 *  - `resumeSession` — can one be continued? Without it, picking a row would
 *    set `resumeSessionId` and then have it silently dropped when the run
 *    starts. A control that looks like it worked and did nothing is exactly the
 *    failure the capability system exists to prevent.
 *
 * ## Pages
 *
 * The palette is one level deep. The root lists actions; a few of them open a
 * sub-page (sessions, providers, a directory prompt) rather than a nested menu,
 * because `cmdk` filters a flat list and a submenu would hide matches from the
 * search that is the whole point of the surface.
 *
 * ## Settings has one command per section, not one command
 *
 * The settings surface is nine panes, and the palette is a search box: a user
 * who types "appearance" or "permissions" is naming a *destination*, and a
 * single "Open settings…" row would match neither. So every section gets its
 * own row through `openSettings(section)` — the This-machine band included,
 * which used to be missing and made Server and Routines the only settings you
 * could not type your way to — with a plain "Settings…" above them that
 * reopens wherever the user last was. The same thing `mod+,` does, which is
 * why that row is the one carrying the shortcut.
 *
 * The value strings carry the *old* names as keywords on purpose: "browser"
 * finds Permissions & access, "advanced" finds This machine, "cerebro" finds
 * the Memory banks row. Muscle memory is a caller too, and it does not read
 * release notes.
 *
 * ## Run-shaping flags are commands too
 *
 * Fast mode and ultracode are toggles on the status line, and this is the
 * keyboard route to the same pair. They are gated exactly as they are there —
 * the availability selectors and the reason strings both come from
 * `StatusLine`, so the two surfaces cannot drift into disagreeing about whether
 * a model offers something.
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import {
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  CpuIcon,
  FolderIcon,
  GaugeIcon,
  GitForkIcon,
  HistoryIcon,
  InfoIcon,
  KeyRoundIcon,
  LaptopIcon,
  MessageSquarePlusIcon,
  PaintbrushIcon,
  PanelLeftIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Undo2Icon,
  ZapIcon,
} from 'lucide-react';
import type { ProviderId, SessionSummary } from '@rx-artemis/protocol';

import { useCapability } from '../hooks/useCapability';
import { keyLabel } from '../hooks/useHotkeys';
import { formatRelative, oneLine } from '@rx-artemis/transcript';
import { shortenPath } from '../lib/paths';
import {
  activeModels,
  fastModeAvailable,
  isLive,
  newSession,
  openSettings,
  openTerminal,
  lastSettledUserItemId,
  refreshProviders,
  refreshSessions,
  rewindConversationTo,
  providerOffersFastMode,
  resumeSession,
  selectedModelOption,
  sessionOrderKey,
  setFastMode,
  setForkOnResume,
  setInfo,
  setModel,
  setPalette,
  setProvider,
  setThinkingLevel,
  thinkingLevels,
  activeThinkingLevel,
  ULTRACODE_LEVEL,
  toggleSidebar,
  ultracodeAvailable,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
// Only the reason strings come from the bar, so the palette's disabled
// explanations and the bar's cannot drift. The setters are the store's own —
// the exclusion between the two flags lives in the actions, not in a wrapper.
import { modelExhaustion, modelPressure } from '../state/modelFacts';
import { PressureDot } from './RunNavigator';
import { toneFor } from './PlanUsageMeter';
import { ProfileSwatch } from './primitives';
import { DirectoryChooser } from './WorkingDirectory';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Page = 'root' | 'sessions' | 'providers' | 'models' | 'cwd';

export function CommandPalette(): ReactElement {
  const open = useApp((s) => s.paletteOpen);
  const [page, setPage] = useState<Page>('root');
  const [search, setSearch] = useState('');

  // Every open starts at the root with an empty query. Reopening a palette
  // still showing the last search is disorienting, and reopening one still on a
  // sub-page is worse — the user asked for "the palette", not for wherever they
  // happened to leave it.
  useEffect(() => {
    if (open) {
      setPage('root');
      setSearch('');
    }
  }, [open]);

  const close = useCallback(() => setPalette(false), []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setPalette}
      title="Command palette"
      description="Search sessions, switch profile or model, and run commands."
      className="max-w-[620px]"
      showCloseButton={false}
    >
      {/*
       * The directory page deliberately sits *outside* `Command`. cmdk owns
       * keyboard handling for everything inside it — arrow keys move the
       * selection, Enter activates the highlighted row — and a free-text input
       * living under that is a fight over every keystroke. A page that asks for
       * typed input is not a command list and should not pretend to be one.
       */}
      {page === 'cwd' ? (
        <CwdPage onClose={close} onBack={() => setPage('root')} />
      ) : (
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={PLACEHOLDERS[page]}
            onKeyDown={(event) => {
              // Backspace at an empty query walks back out of a sub-page rather
              // than closing the dialog — the shape every palette with pages
              // uses, and part of why the pages are only one level deep.
              if (event.key === 'Backspace' && search.length === 0 && page !== 'root') {
                event.preventDefault();
                setPage('root');
              }
            }}
          />
          {/*
           * The highlight is a wash, scoped here rather than restated on every
           * row: shadcn highlights a command row with the `muted` surface,
           * which is a grey step — and a grey step on a floating surface is the
           * elevation model the palette stopped believing in. A wash is a
           * fraction of the ink over whatever is beneath, so it reads the same
           * on the popover as it would anywhere else.
           */}
          <CommandList className="max-h-[22rem] [&_[data-slot=command-item][data-selected=true]]:bg-wash-strong">
            {page === 'root' ? (
              <RootPage onPage={setPage} onClose={close} query={search} />
            ) : page === 'sessions' ? (
              <SessionsPage onClose={close} />
            ) : page === 'providers' ? (
              <ProvidersPage onClose={close} />
            ) : (
              <ModelsPage onClose={close} />
            )}
          </CommandList>
        </Command>
      )}
    </CommandDialog>
  );
}

const PLACEHOLDERS: Record<Page, string> = {
  root: 'Type a command or search…',
  sessions: 'Search past sessions…',
  providers: 'Choose a provider…',
  models: 'Choose a model…',
  cwd: 'Working directory…',
};

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

function RootPage({
  onPage,
  onClose,
  query,
}: {
  readonly onPage: (page: Page) => void;
  readonly onClose: () => void;
  /** What is typed, so sessions can join the list once there is something to match. */
  readonly query: string;
}): ReactElement {
  const listing = useCapability('listSessions');
  const resuming = useCapability('resumeSession');
  const forking = useCapability('forkSession');
  const rewinding = useCapability('rewind');
  const pane = usePaneRef();
  const resumeId = usePane((s) => s.resumeSessionId);
  /*
   * What the wind-back commands below have to ask, rather than `resumeId`.
   *
   * `resumeSessionId` is only promoted when a run ends, so a conversation on
   * its *first* run knows its id only as `run.sessionId` — and these commands
   * are now offered mid-run. `rewindConversationTo` has always read the pair,
   * so gating on half of it was the palette disagreeing with the action behind
   * it about whether there was anything to act on.
   */
  const windBackId = usePane((s) => s.resumeSessionId ?? s.run?.sessionId ?? null);
  const live = usePane(isLive);
  const forkOnResume = usePane((s) => s.forkOnResume);
  const sidebarCollapsed = useApp((s) => s.sidebarCollapsed);
  const models = usePane(activeModels);
  const model = usePane(selectedModelOption);
  const fastOk = usePane(fastModeAvailable);
  const fastOffered = usePane(providerOffersFastMode);
  const levels = usePane(thinkingLevels);
  const thinking = usePane(activeThinkingLevel);
  const fast = usePane((s) => s.fastMode);
  const ultra = usePane((s) => s.ultracode);
  const sessions = useApp((s) => s.sessions);
  const hold = useApp((s) => s.sessionOrderHold);

  /*
   * Sessions, right here, as soon as there is something to match them against.
   *
   * The bar says it searches sessions and the header's entry says so twice, and
   * until this they were a page down: the reader typed a session's name into a
   * list of commands, got "Nothing matches that", and had no way to know that
   * the thing they asked for was behind a row called "Resume a past session…".
   * A promise on the surface has to be true *of the surface*.
   *
   * Only while something is typed. Every session in the history above the
   * commands would bury the commands, and an empty palette is a menu rather
   * than a search — which is what the page below is still for when someone
   * wants to browse rather than to look something up.
   *
   * No filtering here: `cmdk` matches on each row's `value`, which `SessionRow`
   * fills with the title, the opening prompt, the branch, the project and the
   * profile. Rendering them is enough; the ones that do not match never draw.
   */
  const searching = query.trim().length > 0 && listing.supported && sessions.length > 0;
  const ordered = searching
    ? [...sessions].sort((a, b) => sessionOrderKey(b, hold) - sessionOrderKey(a, hold))
    : [];

  return (
    <>
      <CommandEmpty>Nothing matches that.</CommandEmpty>

      <CommandGroup heading="Session">
        <CommandItem
          onSelect={() => {
            newSession();
            onClose();
          }}
        >
          <MessageSquarePlusIcon />
          New session
          <CommandShortcut>{keyLabel('mod+n')}</CommandShortcut>
        </CommandItem>

        {/*
         * Filed under Session rather than under a surface of its own, because
         * that is what it is scoped to: the shell opens on *this* conversation's
         * working directory and disappears with it. `openTerminal` rather than
         * `toggleTerminal` — the toggle is a focus bounce now, and a palette
         * entry that sometimes only moved the caret would do less than its
         * label promises. "Open" opens, every time.
         */}
        <CommandItem
          onSelect={() => {
            void openTerminal();
            onClose();
          }}
        >
          <SquareTerminalIcon />
          Open a terminal here
          <CommandShortcut>{keyLabel('mod+j')}</CommandShortcut>
        </CommandItem>

        {/*
         * Forking is offered only when there is something to fork *and* the
         * provider can do it. Both halves are explained rather than hidden:
         * "nothing to fork yet" is a state the user can fix, and "this provider
         * cannot fork" is a fact they should learn.
         *
         * A toggle, not a one-way switch. `forkOnResume` changes what the next
         * prompt does, so a command that could only ever turn it *on* would let
         * a mis-click silently branch the session with no way back — and the
         * palette closes, so the mistake would not even be visible. The composer
         * shows the same state and can also change it.
         *
         * Closed mid-run, and this is the one fork command that is. A live
         * pane's next prompt is a *steer* into the running turn, and `run.end`
         * clears the flag on its way past — so the promise on this row was one
         * the app could not keep from here. The two commands that can are named
         * in the reason: both branch at a message rather than arming the field.
         */}
        <GatedItem
          supported={forking.supported && resumeId !== null && !live}
          reason={
            !forking.supported
              ? forking.reason
              : resumeId === null
                ? 'There is no session to fork yet — start or resume one first.'
                : 'This conversation is working — fork from a message instead, or wait for the turn to finish.'
          }
          onSelect={() => {
            setForkOnResume(!forkOnResume);
            onClose();
          }}
        >
          <GitForkIcon />
          {forkOnResume
            ? 'Continue the session in place instead of forking'
            : 'Fork the current session on the next prompt'}
        </GatedItem>

        {/*
         * The keyboard path to the controls under a user turn — resolved at
         * select time against whatever the last settled user message is then,
         * because the palette can stay open while a transcript moves. "Last
         * message" rather than a picker: winding back one exchange is the
         * overwhelmingly common ask, and the per-message buttons cover the
         * rest.
         */}
        <GatedItem
          supported={rewinding.supported && windBackId !== null && !live}
          reason={
            !rewinding.supported
              ? rewinding.reason
              : windBackId === null
                ? 'There is no session to rewind yet — start or resume one first.'
                : 'This conversation is working — a turn still being written cannot be wound back.'
          }
          onSelect={() => {
            const target = lastSettledUserItemId(pane);
            if (target !== null) void rewindConversationTo(target, { fork: false }, pane);
            onClose();
          }}
        >
          <Undo2Icon />
          Rewind to your last message
        </GatedItem>

        <GatedItem
          supported={forking.supported && rewinding.supported && windBackId !== null}
          reason={
            !forking.supported
              ? forking.reason
              : !rewinding.supported
                ? rewinding.reason
                : 'There is no session to fork from yet — start or resume one first.'
          }
          onSelect={() => {
            const target = lastSettledUserItemId(pane);
            if (target !== null) void rewindConversationTo(target, { fork: true }, pane);
            onClose();
          }}
        >
          <GitForkIcon />
          Fork from your last message
        </GatedItem>

        <GatedItem
          supported={listing.supported}
          reason={listing.reason}
          onSelect={() => onPage('sessions')}
        >
          <HistoryIcon />
          Resume a past session…
          {resuming.supported ? null : (
            <span className="ml-auto font-mono text-2xs text-amber">view only</span>
          )}
        </GatedItem>
      </CommandGroup>

      <CommandSeparator />

      <CommandGroup heading="Configure">
        <CommandItem onSelect={() => onPage('cwd')}>
          <FolderIcon />
          Set working directory…
        </CommandItem>
        <CommandItem
          onSelect={() => {
            toggleSidebar();
            onClose();
          }}
        >
          <PanelLeftIcon />
          {sidebarCollapsed ? 'Show the session sidebar' : 'Hide the session sidebar'}
          <CommandShortcut>{keyLabel('mod+b')}</CommandShortcut>
        </CommandItem>
        <GatedItem
          supported={models.length > 0}
          reason="This provider does not offer a model choice, so Artemis sends no model and the provider picks its own."
          onSelect={() => onPage('models')}
        >
          <CpuIcon />
          Switch model…
        </GatedItem>
        {/*
         * Both flags are offered as *toggles*, never as "turn on". A one-way
         * command would let a mis-click change what the next run costs with no
         * way back from the same surface — and the palette closes behind it, so
         * the change would not even be on screen. The same argument as the fork
         * command above.
         *
         * Turning either on turns the other off; `setFastMode` carries
         * that rule and says why.
         */}
        {/*
          Listed disabled when this *model* has no fast mode — the palette is a
          place people search by name, and a command that vanishes is a command
          they conclude does not exist. Not listed at all when the *provider* has
          none: on Codex there is no model to switch to and the command could
          never do anything, so the search result would be the lie instead.
        */}
        {fastOffered ? (
          <GatedItem
            supported={fastOk}
            reason={
              model
                ? `${model.label} does not offer fast mode.`
                : 'Choose a model that offers fast mode.'
            }
            onSelect={() => {
              setFastMode(!fast);
              onClose();
            }}
          >
            <ZapIcon />
            {fast ? 'Turn fast mode off' : 'Turn fast mode on'}
          </GatedItem>
        ) : null}
        {/*
          Thinking is one ladder now, `low` up to ultracode, so the palette
          offers the rungs rather than a separate ultracode switch. A rung the
          selected model cannot do is listed disabled — the palette is a place
          people search by name, and a command that vanishes is a command they
          conclude does not exist.
        */}
        {levels.map((level) => (
          <GatedItem
            key={level.id}
            supported={level.available}
            reason={model ? `${model.label} does not offer ${level.label}.` : ''}
            onSelect={() => {
              setThinkingLevel(level.id);
              onClose();
            }}
          >
            {level.id === ULTRACODE_LEVEL ? <SparklesIcon /> : <BrainIcon />}
            Thinking: {level.label}
            {level.id === thinking ? (
              <span className="ml-auto font-mono text-2xs text-beam-text">current</span>
            ) : null}
          </GatedItem>
        ))}
        <CommandItem onSelect={() => onPage('providers')}>
          <PlugIcon />
          Switch provider…
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />

      <CommandGroup heading="Settings">
        <CommandItem onSelect={() => openSettings()}>
          <SettingsIcon />
          Settings…
          <CommandShortcut>{keyLabel('mod+,')}</CommandShortcut>
        </CommandItem>
        <CommandItem
          value="settings profiles credentials accounts billing"
          onSelect={() => openSettings('profiles')}
        >
          <KeyRoundIcon />
          Profiles and credentials…
        </CommandItem>
        <CommandItem
          value="settings models catalogue quick access pins"
          onSelect={() => openSettings('models')}
        >
          <CpuIcon />
          Models and quick access…
        </CommandItem>
        <CommandItem
          value="settings runs fast mode ultracode run summary handoff hand over spend"
          onSelect={() => openSettings('runs')}
        >
          <GaugeIcon />
          Runs…
        </CommandItem>
        <CommandItem
          value="settings instructions agents prompts standing system prompt global prompt injection"
          onSelect={() => openSettings('agents')}
        >
          <BotIcon />
          Instructions and standing prompts…
        </CommandItem>
        {/*
          A second door into the Instructions pane, kept because "memory banks"
          and "cerebro" are what people type — and aimed one level deeper than
          the row above through the anchor, at the banks themselves. The id is
          the historical address; `openSettings` resolves it.
        */}
        <CommandItem
          value="settings memory banks cerebro team memories shared knowledge instructions"
          onSelect={() => openSettings('cerebro', { row: 'memory-banks' })}
        >
          <BrainIcon />
          Memory banks…
        </CommandItem>
        <CommandItem
          value="settings permissions access tools allow deny directories browser chrome preview external default logins"
          onSelect={() => openSettings('permissions')}
        >
          <ShieldIcon />
          Permissions and access…
        </CommandItem>
        <CommandItem
          value="settings appearance width density theme motion text size sidebar thinking"
          onSelect={() => openSettings('appearance')}
        >
          <PaintbrushIcon />
          Appearance…
        </CommandItem>
        <CommandItem
          value="settings server lend serve models http api port connections tokens"
          onSelect={() => openSettings('server')}
        >
          <ServerIcon />
          Server…
        </CommandItem>
        <CommandItem
          value="settings routines schedule scheduled cron appointments"
          onSelect={() => openSettings('routines')}
        >
          <CalendarClockIcon />
          Routines…
        </CommandItem>
        <CommandItem
          value="settings this machine advanced shared claude config scripts recent folders beta updates channel"
          onSelect={() => openSettings('advanced')}
        >
          <LaptopIcon />
          This machine…
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />

      <CommandGroup heading="Inspect">
        <CommandItem onSelect={() => setInfo(true)}>
          <InfoIcon />
          Run details and provider capabilities
        </CommandItem>
        <GatedItem
          supported={listing.supported}
          reason={listing.reason}
          onSelect={() => {
            void refreshSessions();
            onClose();
          }}
        >
          <RefreshCwIcon />
          Reload session history
        </GatedItem>
        <CommandItem
          onSelect={() => {
            void refreshProviders(true);
            onClose();
          }}
        >
          <RefreshCwIcon />
          Re-probe providers
        </CommandItem>
      </CommandGroup>

      {/* Last, under the commands, because a palette is answerable to what was
          typed *and* to what it offers: putting a hundred sessions above four
          commands would make the commands unreachable by eye. cmdk keeps the
          group out of the DOM entirely when nothing in it matches. */}
      {ordered.length === 0 ? null : (
        <>
          <CommandSeparator />
          <CommandGroup heading="Sessions">
            {ordered.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                disabled={!resuming.supported}
                onSelect={() => {
                  resumeSession(session);
                  onClose();
                }}
              />
            ))}
          </CommandGroup>
        </>
      )}
    </>
  );
}

/**
 * A command row that is either selectable or explained.
 *
 * `cmdk` gives a disabled item `aria-disabled` and skips it during keyboard
 * navigation, which is the right behaviour — but on its own it makes the row
 * mute. The reason is rendered as part of the row instead, so the explanation
 * is present whether the user is reading, hovering, or listening.
 */
function GatedItem({
  supported,
  reason,
  onSelect,
  children,
}: {
  readonly supported: boolean;
  readonly reason: string;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}): ReactElement {
  if (supported) return <CommandItem onSelect={onSelect}>{children}</CommandItem>;
  return (
    <CommandItem disabled className="flex-col items-start gap-0.5 opacity-100">
      <span className="flex w-full items-center gap-2 text-ink-faint line-through">{children}</span>
      <span className="pl-6 text-2xs leading-snug text-ink-faint no-underline">{reason}</span>
    </CommandItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sessions, flat and searchable.
 *
 * Deliberately *not* grouped the way the sidebar groups them: `cmdk` filters a
 * flat list, and folding rows under headings would hide matches from the search
 * that is the whole point of this surface. The project and the profile are put
 * on each row instead, and into the row's search value, so "artemis auth" and
 * "work account" both find something.
 */
function SessionsPage({ onClose }: { readonly onClose: () => void }): ReactElement {
  const resuming = useCapability('resumeSession');
  const listing = useCapability('listSessions');
  const sessions = useApp((s) => s.sessions);
  const loading = useApp((s) => s.sessionsLoading);
  const error = useApp((s) => s.sessionsError);
  const scope = useApp((s) => s.sessionsScope);
  const hold = useApp((s) => s.sessionOrderHold);

  if (!listing.supported) return <Note title="Not supported" body={listing.reason} />;
  if (error) return <Note title="Could not read history" body={error} tone="error" />;
  if (loading && sessions.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3" aria-busy="true" aria-label="Loading sessions">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  // The sidebar's order, not a second opinion on it — and held still for the
  // sessions that are running, so the list does not reshuffle while it is open
  // and the arrow keys are moving through it. See `AppState.sessionOrderHold`.
  const ordered = [...sessions].sort(
    (a, b) => sessionOrderKey(b, hold) - sessionOrderKey(a, hold),
  );

  return (
    <>
      <CommandEmpty>No session matches that.</CommandEmpty>
      {resuming.supported ? null : (
        <p className="border-b border-hairline bg-wash px-3 py-2 text-2xs leading-snug text-ink-muted">
          {resuming.reason} These are listed for reference only — picking one would not carry the
          conversation forward, so they cannot be selected.
        </p>
      )}
      <CommandGroup heading={scope === 'all' ? 'Sessions — all projects' : 'Sessions — this directory'}>
        {ordered.length === 0 ? (
          <p className="px-2 py-3 text-2xs text-ink-faint">
            Nothing yet. Sessions you start show up here and in the sidebar.
          </p>
        ) : (
          ordered.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              disabled={!resuming.supported}
              onSelect={() => {
                resumeSession(session);
                onClose();
              }}
            />
          ))
        )}
      </CommandGroup>
    </>
  );
}

function SessionRow({
  session,
  disabled,
  onSelect,
}: {
  readonly session: SessionSummary;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const platform = useApp((s) => s.platform);
  const profile = useApp((s) => s.profiles.find((p) => p.id === session.profileId));

  return (
    <CommandItem
      // `value` is what cmdk filters on, so it carries everything a user might
      // reasonably type: title, opening prompt, branch, project and profile.
      value={`${session.title} ${session.firstPrompt ?? ''} ${session.gitBranch ?? ''} ${session.cwd} ${profile?.label ?? ''} ${session.id}`}
      disabled={disabled}
      onSelect={onSelect}
      className={cn('flex-col items-start gap-0.5', disabled && 'opacity-60')}
    >
      <span className="flex w-full items-baseline gap-2">
        <SquareTerminalIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{session.title}</span>
        <span className="shrink-0 font-mono text-2xs text-ink-faint">
          {formatRelative(session.updatedAt)}
        </span>
      </span>
      {session.firstPrompt ? (
        <span className="w-full truncate pl-5 font-mono text-2xs text-ink-faint">
          {oneLine(session.firstPrompt, 72)}
        </span>
      ) : null}
      {/* Project and profile, because resuming switches to both — see
          `resumeSession`. Showing them here is what makes that predictable
          rather than a surprise after the fact. */}
      <span className="flex w-full items-center gap-2 pl-5 font-mono text-2xs text-ink-faint">
        <span title={session.cwd}>{shortenPath(session.cwd, { platform, max: 28 })}</span>
        <span className="flex items-center gap-1">
          <ProfileSwatch color={profile?.color} />
          {profile?.label ?? 'profile missing'}
        </span>
        {session.gitBranch ? <span>{session.gitBranch}</span> : null}
      </span>
    </CommandItem>
  );
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Unavailable providers are listed, greyed, with the reason.
 *
 * Hiding one tells the user nothing; showing "Codex — no adapter registered in
 * this build" tells them where the product is going and stops them hunting for
 * a setting that does not exist.
 */
function ProvidersPage({ onClose }: { readonly onClose: () => void }): ReactElement {
  const providers = useApp((s) => s.providers);
  const activeId = usePane((s) => s.activeProviderId);

  return (
    <>
      <CommandEmpty>No provider matches that.</CommandEmpty>
      <CommandGroup heading="Providers">
        {providers.length === 0 ? (
          <p className="px-2 py-3 text-2xs text-ink-faint">
            No providers were reported. The main process may not have finished starting.
          </p>
        ) : (
          providers.map((provider) => (
            <CommandItem
              key={provider.id}
              value={provider.label}
              disabled={!provider.available}
              className="flex-col items-start gap-0.5"
              onSelect={() => {
                setProvider(provider.id as ProviderId);
                onClose();
              }}
            >
              <span className="flex w-full items-center gap-2">
                <PlugIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className={cn('text-xs', provider.available ? 'text-ink' : 'text-ink-faint')}>
                  {provider.label}
                </span>
                {provider.id === activeId ? (
                  <span className="ml-auto font-mono text-2xs text-beam-text">active</span>
                ) : null}
              </span>
              {provider.available ? null : (
                <span className="pl-5 text-2xs leading-snug text-amber">
                  {provider.unavailableReason ?? 'Unavailable.'}
                </span>
              )}
            </CommandItem>
          ))
        )}
      </CommandGroup>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

function ModelsPage({ onClose }: { readonly onClose: () => void }): ReactElement {
  const models = usePane(activeModels);
  const current = usePane((s) => s.model);
  /*
    The same three facts the navigator's rows carry — exhaustion, pressure,
    cost posture — read off the same polled map through the same helpers
    (`modelFacts.ts`), so the two surfaces cannot disagree about whether a
    model has room. Read-only here, never a fetch: this is a list mounted by a
    keystroke, and a subprocess per row would be the hazard the profile rows
    already document.
  */
  const profileId = usePane((s) => s.activeProfileId);
  const usage = useApp((s) => (profileId === null ? null : (s.planUsageByProfile[profileId] ?? null)));
  // Captured at mount — the page opens, the facts are judged then.
  const [now] = useState(() => Date.now());

  return (
    <>
      <CommandEmpty>No model matches that.</CommandEmpty>
      <CommandGroup heading="Model">
        {/*
          This page lists the whole catalogue, not the quick-access subset the
          status-line picker shows. The two surfaces are for different things:
          that one is a shortlist you reach with the mouse, and this is the one
          you reach by typing four characters of a name you already know. A
          shortlist you have to search is not a search.
        */}
        {models.map((model) => {
          const exhausted = modelExhaustion(model, usage, now);
          const pressure = modelPressure(model, usage);
          return (
            <CommandItem
              key={model.id}
              // Everything a user might type: short label, full name, alias and
              // the wire id it resolves to. "sonnet" and "claude-sonnet-5" should
              // both find the same row.
              value={`${model.label} ${model.displayName ?? ''} ${model.id} ${model.resolvedModel ?? ''}`}
              // Present-but-disabled with the reason inline — the GatedItem
              // treatment, applied to a model rather than a command. A model
              // that vanished would read as withdrawn; one that is struck
              // through with a reset time reads as what it is: out until then.
              disabled={exhausted !== null}
              className={cn('flex-col items-start gap-0.5', exhausted !== null && 'opacity-100')}
              onSelect={() => {
                setModel(model.id);
                onClose();
              }}
            >
              <span className="flex w-full items-center gap-2">
                <CpuIcon className="size-3 shrink-0" aria-hidden="true" />
                <span
                  className={cn(
                    'text-xs',
                    exhausted === null ? 'text-ink' : 'text-ink-faint line-through',
                  )}
                >
                  {model.displayName ?? model.label}
                </span>
                {model.supportsFastMode === true ? (
                  <ZapIcon className="size-3 shrink-0 text-cyan" aria-label="offers fast mode" />
                ) : null}
                {model.supportsUltracode === true ? (
                  <SparklesIcon
                    className="size-3 shrink-0 text-beam-text"
                    aria-label="offers ultracode"
                  />
                ) : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs">
                  {pressure !== null ? (
                    <span className="flex items-center gap-1">
                      <PressureDot pressure={pressure} />
                      {pressure.window.status === 'rejected' ? (
                        <span className="tabular-nums text-signal">out</span>
                      ) : pressure.utilization === null ? null : (
                        <span
                          className={cn(
                            'tabular-nums',
                            toneFor(pressure.utilization, pressure.window.status),
                          )}
                        >
                          {Math.round(pressure.utilization)}%
                        </span>
                      )}
                    </span>
                  ) : null}
                  {current === model.id ? <span className="text-beam-text">selected</span> : null}
                </span>
              </span>
              {exhausted !== null ? (
                <span className="pl-5 text-2xs leading-snug text-signal no-underline">
                  {exhausted.reason}
                </span>
              ) : null}
              <span className="pl-5 text-2xs leading-snug text-ink-faint">{model.note}</span>
              {model.resolvedModel ? (
                <span className="pl-5 font-mono text-2xs text-ink-faint/75">
                  {model.resolvedModel}
                </span>
              ) : null}
            </CommandItem>
          );
        })}
      </CommandGroup>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Working directory                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The directory page.
 *
 * The chooser itself is shared with the sidebar and the status line
 * (`WorkingDirectory.tsx`) so there is one implementation of "how do I say
 * where the agent works", not three that drift. It offers the host's folder
 * picker when the bridge exposes one and a validated path field either way.
 */
function CwdPage({
  onClose,
  onBack,
}: {
  readonly onClose: () => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div className="p-3">
      <DirectoryChooser onDone={onClose} onCancel={onBack} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

function Note({
  title,
  body,
  tone = 'neutral',
}: {
  readonly title: string;
  readonly body: string;
  readonly tone?: 'neutral' | 'error';
}): ReactElement {
  return (
    <div className="px-3 py-6 text-center">
      <p className={cn('text-2xs font-medium', tone === 'error' ? 'text-signal' : 'text-ink-muted')}>
        {title}
      </p>
      <p className="mt-1 text-2xs leading-snug text-ink-faint">{body}</p>
    </div>
  );
}
