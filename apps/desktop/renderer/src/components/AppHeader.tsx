/**
 * The window header — which *is* the title bar.
 * ============================================================================
 *
 *     ┌──────────────────────────────────────────────────────────────────┐
 *     │ ●●● [◧?] artemis › Wire…  [ ⌕ Search  ⌘K ]  [⋮][⚙]|[◫☀☾] [–□✕] │
 *     └──────────────────────────────────────────────────────────────────┘
 *       ↑    ↑    ↑               ↑                  ↑  ↑   ↑      ↑
 *       │    │    │               │                  │  │   │      └ Windows/
 *       │    │    │               │                  │  │   │        Linux
 *       │    │    │               │                  │  │   └ theme
 *       │    │    │               │                  │  └ settings
 *       │    │    │               │                  └ the opener (kebab)
 *       │    │    │               └ the way into the palette, centred
 *       │    │    └ what the focused pane shows
 *       │    └ show the sidebar — rendered only while the list is closed
 *       └ macOS traffic lights: the system's own, drawn over this bar
 *
 * Three groups, and the outer two flex equally from a zero basis — that is
 * what centres the search on the window rather than on the leftovers. This is
 * round seven's frame (docs/design/7d-full.html), landed 2026-08-30.
 *
 * ## This bar replaced the title bar rather than sitting under it
 *
 * `main/window.ts` hides the platform's title bar, so what is drawn here is the
 * only chrome the window has. That file explains why; the consequence for this
 * one is that the header now owes the user everything the native bar used to
 * provide, and the two ends of that debt are handled differently:
 *
 *  - **macOS** keeps its traffic lights. They are still AppKit's — the system
 *    draws them, handles the clicks, and does full screen — so there is nothing
 *    to implement, only room to leave. See {@link useTrafficLightGutter}.
 *  - **Windows and Linux** get nothing back from the system, so
 *    {@link WindowControls} draws minimize, maximize and close and routes them
 *    through `artemis.window.*`.
 *
 * Dragging and double-click-to-zoom come free with the drag region below; they
 * are Chromium's, not ours.
 *
 * ## With a grid open, this names the focused pane
 *
 * The header is the window's, and the window can be showing several
 * conversations. Rather than trying to name them all in one line, it names
 * whichever pane has focus, and each pane carries its own caption — see
 * `WorkingArea`. That is why the title is read through `usePane` (which falls
 * back to the focused pane outside a pane) rather than off the app store.
 *
 * ## Splitting is in the opener, not on the bar
 *
 * The bar once carried a split-right and a split-down button, and later a row
 * of four surface toggles. Both generations had the same flaw: a header that
 * grows a control per operation competes with the panes' own captions for the
 * same job, and rarely-pressed buttons spend the window's most permanent
 * chrome. The kebab menu (`OpenMenu`) is the standing answer — every surface
 * and both splits, one quiet control, each row teaching its own shortcut.
 * Closing stays on each pane's caption, where the thing being closed is
 * unambiguous.
 *
 * ## Why the app grew a header
 *
 * Originally because a control that vanishes along with the thing it controls
 * makes hiding a one-way door: the sidebar collapsed to nothing, so its toggle
 * had to live somewhere that did not. The status line held it first, which was
 * wrong on its own terms — that bar says *what the next prompt will do*, and
 * "is the sidebar showing" is not that. So the window got a bar of its own.
 *
 * The rail-era answer — the sidebar reopens itself, the header keeps a
 * permanent copy — is retired with the rail (2026-08-30). The toggle now has
 * one home at a time: on the list's own caption while it is open, and here,
 * in the strip that never disappears, exactly while it is not. That is the
 * original argument, kept, without the standing duplicate.
 *
 * ## New session is not here either
 *
 * It was, on the argument that hiding the sidebar must not hide the app's
 * primary action. The button is gone and that argument still stands, so the
 * routes that answer it are `⌘N`, the command palette, and the sidebar's own
 * button — none of which depend on this bar. If hiding the sidebar ever does
 * start to feel like losing the way to start work, this is the paragraph that
 * was wrong, and the button comes back.
 *
 * ## The whole bar is an Electron drag region
 *
 * `.drag-region` / `.no-drag` are Artemis utilities (`index.css`) over
 * `-webkit-app-region`, which has no Tailwind equivalent. The rule that bites:
 * a drag region swallows clicks, so **every interactive child needs
 * `.no-drag`** or it becomes decoration that drags the window instead of
 * firing its handler. If a button in here ever stops responding, this is why.
 */

import { type ReactElement } from 'react';
import {
  CastIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FilesIcon,
  FolderIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MinusIcon,
  PanelLeftIcon,
  PlusIcon,
  Settings2Icon,
  SquareIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  SquareTerminalIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react';

import { useDocuments } from '../hooks/useDocuments';
import { keyLabel } from '../hooks/useHotkeys';
import { useWindowState } from '../hooks/useWindowState';
import { installUpdate, restartForUpdate, useUpdateState } from '../hooks/useUpdateState';
import { updatePercent, type UpdateStep } from '@rx-artemis/protocol';
import { hasNativeWindowChrome, resolveBridge } from '../lib/bridge';
import { describeRemote, readRemoteConfig } from '../lib/remoteConfig';
import { lastSegment } from '../lib/paths';
import { cn } from '../lib/utils';
import { ArrowDownIcon, SearchIcon } from 'lucide-react';
import {
  conversationName,
  focusWaitingPane,
  newSession,
  openSettings,
  splitPane,
  togglePalette,
  toggleBrowser,
  toggleDocuments,
  toggleFiles,
  toggleTasks,
  toggleTerminal,
  toggleSidebar,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { IconButton } from './disabled-reason';
import { StatusDot } from './primitives';
import { ThemeToggle } from './ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Room reserved for the macOS traffic lights, in pixels.
 *
 * The group is 52px wide and `main/window.ts` puts its left edge at 16, so the
 * buttons end at 68. The remainder is the gap before the sidebar toggle, whose
 * own optical padding does the rest.
 *
 * The 16 is that file's to choose and this is the only number here that depends
 * on it: if the traffic lights move, this moves with them.
 */
const TRAFFIC_LIGHT_GUTTER = 76;

/**
 * How much space to leave at the leading edge for buttons Artemis does not draw.
 *
 * Three conditions, and full screen is the one worth explaining. macOS takes
 * its traffic lights away when a window goes full screen — they move into the
 * overlay that slides down with the menu bar — so a gutter that stayed put
 * would leave a 76px hole at the start of the bar for as long as the user was
 * in full screen. It closes, and reopens on the way out.
 *
 * The other two are static: no other platform has traffic lights, and a
 * window with no native chrome behind it — dev's browser tab — has none to
 * leave room for. Remote mode is *not* that case: the conversation lives on
 * another machine but the window is exactly as native as ever, which is what
 * `hasNativeWindowChrome` answers.
 */
function useTrafficLightGutter(fullScreen: boolean): number {
  const platform = useApp((s) => s.platform);
  // Subscribed so the gutter re-answers after bootstrap settles the mode.
  useApp((s) => s.bridgeMode);

  if (platform !== 'darwin' || !hasNativeWindowChrome() || fullScreen) return 0;
  return TRAFFIC_LIGHT_GUTTER;
}

/* -------------------------------------------------------------------------- */
/* Window controls                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimize, maximize and close, for the platforms that hand back nothing.
 *
 * Renders `null` on macOS, where the traffic lights are the system's own and a
 * second set of buttons doing the same three jobs would be a bug rather than a
 * feature — and in dev's browser tab, where there is no window to act on.
 *
 * Drawn in Artemis's own idiom rather than to Windows' 46×32px metrics. Those
 * metrics only read as native inside a native title bar, and this bar is
 * plainly the app's — so matching the icon buttons two positions to the left is
 * the more coherent choice. Close keeps a red hover, because that convention is
 * about consequence rather than about geometry.
 *
 * Every button is `.no-drag`, or it would drag the window instead of firing.
 */
function WindowControls({ maximized, focused }: {
  readonly maximized: boolean;
  readonly focused: boolean;
}): ReactElement | null {
  const platform = useApp((s) => s.platform);
  useApp((s) => s.bridgeMode);

  if (platform === 'darwin' || !hasNativeWindowChrome()) return null;

  // Fire and forget. Each channel does answer with the resulting state, but the
  // state this renders from is already on its way over the push channel — and
  // `close` in particular resolves about a window that no longer exists.
  const send = (action: 'minimize' | 'toggleMaximize' | 'close') => () => {
    void resolveBridge().bridge?.window[action]({});
  };

  return (
    <div
      // Dimmed while the window is in the background, which is what every
      // platform does to its own controls. The header's *content* is left
      // alone: a title that faded whenever the user clicked another app would
      // be movement without meaning.
      className={cn('ml-1 flex shrink-0 items-center gap-0.5', !focused && 'opacity-60')}
    >
      <IconButton
        label="Minimize"
        onClick={send('minimize')}
        className="no-drag shrink-0 text-ink-faint"
      >
        <MinusIcon />
      </IconButton>
      <IconButton
        label={maximized ? 'Restore' : 'Maximize'}
        onClick={send('toggleMaximize')}
        className="no-drag shrink-0 text-ink-faint"
      >
        {/* Two overlapping squares for restore, one for maximize — the glyphs
            Windows itself uses, so the button says which way it will go. */}
        {maximized ? <CopyIcon /> : <SquareIcon />}
      </IconButton>
      <IconButton
        label="Close"
        onClick={send('close')}
        className="no-drag shrink-0 text-ink-faint hover:bg-destructive/20 hover:text-destructive"
      >
        <XIcon />
      </IconButton>
    </div>
  );
}

/**
 * What this window is pointed at, in words.
 *
 * The focused column's conversation, named by the one selector the pane
 * captions use as well — see `conversationName`, which is where the rule about
 * *which* session a column is showing lives. The header and a caption naming
 * the same column differently is the disagreement having one answer prevents.
 *
 * The selector returns a string, so it is compared by value and a transcript
 * delta cannot re-render the header.
 */
function useSessionTitle(): string {
  return usePane(conversationName);
}

/**
 * Says, permanently, that this window is showing another machine.
 *
 * A chip in the window's own chrome rather than a banner or a toast, because
 * the fact is standing: every conversation, run and terminal on screen lives
 * on the named machine, and a user who forgets that mid-keystroke types into
 * the wrong computer. Clicking it opens the Remote settings section, which is
 * where the way back out lives.
 */
function RemoteChip(): ReactElement | null {
  const bridgeMode = useApp((s) => s.bridgeMode);
  if (bridgeMode !== 'remote') return null;
  const config = readRemoteConfig();
  const name = config === null ? 'remote' : describeRemote(config);
  return (
    <button
      type="button"
      onClick={() => openSettings('remote')}
      title={`Showing ${name} — click for the connection`}
      // Round, because it always was: Console changes what a chip is *made*
      // of — an alpha edge over a wash, rather than a grey step with a solid
      // rule around it — and leaves the shapes alone.
      className="no-drag flex shrink-0 items-center gap-1 rounded-full border border-hairline-strong bg-wash px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-wash-strong hover:text-ink"
    >
      <CastIcon className="size-3" aria-hidden="true" />
      <span className="max-w-[10rem] truncate">{name}</span>
    </button>
  );
}

export function AppHeader(): ReactElement {
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const cwd = usePane((s) => s.cwd);
  const title = useSessionTitle();
  // A count, not the rows: this only decides whether the button has anything to
  // open, and a selector returning the array would re-render the header on every
  // progress message the delegated work emits.
  const delegated = usePane((s) => s.tasks.length);
  // The same shape for the documents: the row shows how many there are, and
  // the list behind it is recomputed only when a document arrives — the
  // artifacts snapshot it reads keeps its identity through every token.
  const documents = useDocuments().length;
  // Subscribed once, here, and passed down. Two components calling the hook
  // would open two IPC subscriptions to describe one window.
  const windowState = useWindowState();
  const gutter = useTrafficLightGutter(windowState.fullScreen);
  const pane = usePaneRef();

  const project = cwd.trim().length > 0 ? lastSegment(cwd) : null;

  return (
    <header
      // `pl` is overridden inline only when there are traffic lights to clear;
      // see `useTrafficLightGutter`.
      style={gutter > 0 ? { paddingLeft: gutter } : undefined}
      // The rule at the bottom is doing real work: the header and the app body
      // below it are both `bg-abyss`, so without it the window chrome and the
      // conversation are one continuous field and the title reads as though it
      // belongs to the transcript. A hairline rather than anything heavier,
      // to match the seam the dock's tab strip already draws.
      className="drag-region flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-abyss px-2"
    >
      {/*
        The left third: the way back to the sessions list — only while the list
        is closed — then identity. The toggle used to be permanent here, and the
        sidebar kept a rail to reopen itself besides: two homes both occupied.
        Now the control has one home at a time. Open, it is the chevron on the
        list's own caption; closed, it is this button, in the one strip that
        never disappears. `⌘B` works in both states either way.
      */}
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-1">
        {collapsed ? (
          <IconButton
            label={`Show the sidebar (${keyLabel('mod+b')})`}
            onClick={toggleSidebar}
            className="no-drag shrink-0 text-ink-muted"
          >
            <PanelLeftIcon />
          </IconButton>
        ) : null}
        <div className="mx-1 flex min-w-0 items-center gap-1.5">
          <RemoteChip />
          {project === null ? (
            /* Faint, not amber. This is a placeholder for a value nobody has
               set yet, sitting in the window's own chrome — it is not a
               warning, and it was colouring the first thing in the header on
               every fresh launch. The empty state says "not ready to run" in
               as many words, which is where that belongs. */
            <span className="shrink-0 text-xs text-ink-faint">No project</span>
          ) : (
            /* Full path on hover — the basename alone is ambiguous across
               checkouts, and two worktrees of the same repo share it. */
            <span
              title={cwd}
              className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-ink"
            >
              {project}
            </span>
          )}
          <ChevronRightIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
          <h1 className="min-w-0 truncate text-xs font-normal text-ink-muted">{title}</h1>
        </div>
      </div>

      {/*
        The centre third: the way in. Centred on the *window*, not on whatever
        is left after the title — the two groups either side flex equally, so a
        long session name ellipsises instead of shoving the bar off the centre
        line. See `SearchEntry` for why it is a button dressed as a field.
      */}
      <SearchEntry />

      {/* The right third. Status first, then the opener, then the app. */}
      <div className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-1">
        <UpdateChip />
        <WaitingBadge />
        <OpenMenu delegated={delegated} documents={documents} pane={pane} />
        <IconButton
          label={`Settings (${keyLabel('mod+,')})`}
          onClick={() => openSettings()}
          className="no-drag shrink-0 text-ink-faint"
        >
          <Settings2Icon />
        </IconButton>
        {/*
          Last in the row, and the only control here that is not a button.

          It sits beside Settings rather than inside it because it is the one
          preference whose whole effect is the window you are looking at — the
          transcript, the sidebar, this header. Everything behind a modal would
          be covered by the modal you opened to change it.

          A separator ahead of it: the controls to the left act on the
          *conversation* and this one acts on the application. Without the rule
          they read as a row of peers.
        */}
        <div className="mx-0.5 h-4 w-px shrink-0 bg-line" aria-hidden="true" />
        <ThemeToggle />

        <WindowControls maximized={windowState.maximized} focused={windowState.focused} />
      </div>
    </header>
  );
}

/**
 * The opener — one kebab where four icon buttons stood.
 *
 * Terminal, browser, delegated work and the working folder each had a header
 * button, which put four rarely-pressed controls in the window's most
 * permanent chrome and still taught nobody the chords. A menu answers both:
 * the header carries one quiet control, and every row states its shortcut, so
 * the list is the legend the app otherwise keeps only in the empty state.
 *
 * A kebab and not a plus, deliberately. Most of these rows *reveal* something
 * that already exists — the shell, the page, the folder, the work — and a `+`
 * promises creation. The two rows that do create sit in their own group at the
 * foot, under the word that says so.
 *
 * Delegated work keeps its disabled-with-reason contract from the button it
 * replaces: shown, struck through by the platform's disabled styling, with the
 * sentence in `title` — never hidden.
 *
 * Documents is the row that answers "where did that report go". Every
 * document the agent makes is a tile in the thread, where it was made — which
 * is the right place while the reader is there and forty screens up an hour
 * later. The row opens the index of them in the dock, and carries the count
 * the way Delegated does, so the menu says whether there is anything to find
 * before it is opened. Never disabled: a conversation that has made nothing
 * has an empty list that says so, and a struck-through row on exactly the
 * conversation where someone wonders whether anything was made would be the
 * menu refusing to answer the question.
 */
function OpenMenu({
  delegated,
  documents,
  pane,
}: {
  readonly delegated: number;
  readonly documents: number;
  readonly pane: ReturnType<typeof usePaneRef>;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Open a surface" className="no-drag shrink-0 text-ink-faint">
          <EllipsisVerticalIcon />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Open in the dock
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => toggleTerminal(pane)}>
          <SquareTerminalIcon />
          Terminal
          <DropdownMenuShortcut>{keyLabel('mod+j')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleBrowser(pane)}>
          <GlobeIcon />
          Browser
          <DropdownMenuShortcut>{keyLabel('mod+shift+b')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleFiles(pane)}>
          <FolderIcon />
          Working folder
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleDocuments(pane)}>
          <FilesIcon />
          Documents
          {documents > 0 ? <DropdownMenuShortcut>{documents}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={delegated === 0}
          title={delegated === 0 ? 'Nothing delegated in this conversation yet.' : undefined}
          onSelect={() => toggleTasks(pane)}
        >
          <UsersIcon />
          Delegated work
          {delegated > 0 ? <DropdownMenuShortcut>{delegated}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs text-ink-faint">
          Split this conversation
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => splitPane('right')}>
          <SquareSplitHorizontalIcon />
          Split right
          <DropdownMenuShortcut>{keyLabel('mod+\\')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => splitPane('down')}>
          <SquareSplitVerticalIcon />
          Split down
          <DropdownMenuShortcut>{keyLabel('mod+shift+\\')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs text-ink-faint">New</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => newSession(pane)}>
          <PlusIcon />
          New session
          <DropdownMenuShortcut>{keyLabel('mod+n')}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * How many conversations have stopped and are waiting on you.
 *
 * The one thing in this header that is about the *window* rather than the
 * conversation in front of you, and it is here because that is the problem it
 * solves: a pane parked on a permission in the other column, or behind the one
 * you are reading, is invisible until you happen to look. The agent is not
 * working, it is waiting, and nothing was saying so from anywhere you were
 * likely to be looking.
 *
 * Renders nothing at zero. A badge that is always present and usually says "0"
 * teaches the eye to skip it, which is the opposite of what an alert is for —
 * and the header is narrow enough that a permanent slot would cost the title
 * real width on every window that never needs it.
 *
 * Amber, matching the sidebar dot and the activity indicator: three surfaces,
 * one colour, one meaning. Clicking focuses the first waiting pane; see
 * `focusWaitingPane` for why "first" is layout order.
 *
 * A *toned* chip rather than a solid amber tile — Console's `.pill.mode`:
 * amber text, an amber edge at 45%, an amber wash behind. The solid version
 * was the loudest object in a bar whose other three controls are outlines, and
 * it said "error" at a glance when what it means is "something is parked".
 * Nothing is lost by the change: the hue is the signal, the badge is the only
 * amber thing up here, and it still renders only when the count is non-zero.
 */
function WaitingBadge(): ReactElement | null {
  const waiting = useApp((s) => s.waitingSessions.length);
  if (waiting === 0) return null;

  const label =
    waiting === 1 ? '1 conversation is waiting for you' : `${waiting} conversations are waiting for you`;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        focusWaitingPane();
      }}
      className="no-drag flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border border-amber/45 bg-amber/10 px-2 text-2xs font-medium text-amber transition-colors hover:bg-amber/20"
    >
      {/* The dot is `tone="amber"` now rather than a hole punched in the fill
          with `amber-ink`. On a wash there is no fill to punch: the ink token
          exists for text sitting *on* solid amber, and over a 10% tint it is
          whatever the theme's foreground happens to be. */}
      <StatusDot tone="amber" />
      {waiting} waiting
    </button>
  );
}

/**
 * The one update surface.
 *
 * `_layout.md` item 3: in the command bar, always, whatever else is open. It
 * used to be three places telling one story — a card in the sidebar, a dot on
 * the rail when the sidebar was shut, and, before that, a strip under the
 * header for when both were gone. Each existed because the one before it could
 * disappear. The command bar cannot, so one is enough and the other two are
 * gone.
 *
 * A chip rather than a sentence, because the header is not where an update is
 * *read* — it is where it is noticed. Clicking installs when there is something
 * to install and restarts when the new version is already staged, which are the
 * only two things anyone wants from it; everything else the card used to say is
 * a consequence of one of those two.
 *
 * Renders nothing while the updater is idle, which is almost always.
 */
function UpdateChip(): ReactElement | null {
  const state = useUpdateState();
  if (state.phase === 'idle') return null;

  const version = state.version ?? '';
  const ready = state.phase === 'ready';
  const failed = state.phase === 'error';
  const busy = state.phase === 'working' || state.phase === 'restarting';

  /*
   * While busy the chip counts rather than merely dimming. It is the surface a
   * user sees when the sidebar is hidden, and 60% opacity is not a signal that
   * anything is happening — it is what made an install indistinguishable from
   * a dead button, and got Update clicked three times.
   */
  const percent = state.phase === 'working' ? updatePercent(state.progress) : null;
  const step = state.phase === 'working' ? (state.progress?.step ?? null) : null;

  const label = failed
    ? 'The update could not be installed'
    : ready
      ? `Artemis ${version} is ready — restart to use it`.trim()
      : busy
        ? busyLabel(step, version, percent)
        : `Artemis ${version} is available`.trim();

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={() => {
        if (ready) restartForUpdate();
        else if (!busy) installUpdate();
      }}
      /*
       * A toned chip, like the waiting badge beside it: the tone at 45% for
       * the edge, a wash of the same tone on hover. `font-mono` stays — the
       * chip's payload is a version string, which is machine output, and the
       * rule Console keeps is that mono means exactly that rather than
       * "chrome". `rounded-md` is the control radius; it was `rounded-sm`,
       * which is the radius this language gives to key caps and swatches.
       */
      className={cn(
        'no-drag flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-2xs transition-colors',
        failed
          ? 'border-signal/45 text-signal hover:bg-signal/10'
          : 'border-beam/45 text-beam-text hover:bg-beam/10',
        busy && 'opacity-60',
      )}
    >
      {busy ? (
        <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        <ArrowDownIcon className="size-3" aria-hidden="true" />
      )}
      {failed
        ? 'update failed'
        : ready
          ? `restart for ${version}`
          : busy
            ? percent === null
              ? (step ?? 'working')
              : `${String(percent)}%`
            : version}
    </button>
  );
}

/**
 * What the chip says, at length, while an install runs.
 *
 * `checking` is the one step that does not name a version: it runs before the
 * download to find out whether the offer has been superseded, so the version
 * beside it would be the one thing it might be about to change.
 */
function busyLabel(step: UpdateStep | null, version: string, percent: number | null): string {
  if (step === 'checking') return 'Checking for a newer version';
  if (step === null) return `Working on Artemis ${version}`.trim();
  return `${step} Artemis ${version}${percent === null ? '' : ` — ${String(percent)}%`}`.trim();
}

/**
 * The way into the palette, `_layout.md` item 2.
 *
 * A field rather than an icon, and it is not a field: it is a button dressed as
 * one, because the palette owns the input and two text boxes for one query
 * would be one too many. What the shape buys is that people look for search in
 * something search-shaped — `⌘K` is the fastest way in and also the one nobody
 * finds without being told.
 *
 * In the command bar because that is where a window-level action belongs: the
 * palette searches every session, every file and every command, not the
 * conversation in front of you. The rail carries the same action for when the
 * pointer is already over there.
 *
 * `max-w-md` and `hidden lg:flex`: it is the first thing that should give up
 * room, since the two things beside it — what you are looking at, and what
 * wants you — are facts, and this is a door that has a keyboard shortcut.
 */
function SearchEntry(): ReactElement {
  return (
    <button
      type="button"
      onClick={togglePalette}
      aria-label={`Search sessions and commands (${keyLabel('mod+k')})`}
      /*
       * The Console field, shared with the sidebar's filter: `rounded-lg`, a
       * hairline-strong edge, a wash ground. The geometry — centred, `max-w-md`,
       * `hidden lg:flex` — is what the paragraph above argues for and is not
       * what changed.
       *
       * Hover answers in the ground rather than in the edge. It used to darken
       * the border to `line-strong`, which is a token held to 3:1 for controls
       * that are *owed* contrast; borrowing it for a hover state meant the
       * quietest control in the bar produced the hardest line in it.
       */
      className="no-drag mx-2 hidden h-6 w-full max-w-md min-w-0 items-center gap-2 rounded-lg border border-hairline-strong bg-wash px-2 text-2xs text-ink-faint transition-colors hover:bg-wash-strong hover:text-ink-muted lg:flex"
    >
      <SearchIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">Search sessions and commands</span>
      <span aria-hidden="true" className="ml-auto shrink-0 font-mono opacity-70">
        {keyLabel('mod+k')}
      </span>
    </button>
  );
}
