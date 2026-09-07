/**
 * The application shell.
 * ============================================================================
 *
 * A header over a floating sidebar and the working area:
 *
 *     +------------------------------------------------------------------+
 *     | [◧]  artemis › Wire the adapter seam      [⊞][⊟] [+]  [⚙]  HEADER  |
 *     +------------------------------------------------------------------+
 *     |  ╭──────────────────╮ |  artemis › Wire…  ┊  api › Rate limiter  |
 *     |  │ [+ New session][◧]│ |  TRANSCRIPT       ┊  TRANSCRIPT          |
 *     |  │ ── artemis · 22 ─│ |  COMPOSER·STATUS  ┊  COMPOSER·STATUS     |
 *     |  │  every project   │ |┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈|
 *     |  ╰──────────────────╯ |  cli › Flag parsing                      |
 *     |  ╭──────────────────╮ |  TRANSCRIPT                              |
 *     |  │ ↓ 0.4.0 available│ |  COMPOSER·STATUS                         |
 *     |  ╰──────────────────╯ |                                          |
 *     +------------------------------------------------------------------+
 *
 * ## The working area holds a grid of conversations
 *
 * A pane is a whole conversation — its own directory, account, model, run,
 * permission queue and transcript — and the window can show up to four across
 * and four down. The grid is *rows of columns* rather than a matrix, which is
 * why a third conversation added under a left/right pair spans the full width
 * instead of quartering the window. All of that lives in `WorkingArea`;
 * everything about what a pane *owns* lives in `state/pane.ts`.
 *
 * What matters here is the division of responsibility this file used to blur:
 * the header, the sidebar, the banners, the palette and the settings dialog are
 * the *window's*, and there is one of each no matter how many panes are open.
 * Each of those surfaces acts on the focused pane.
 *
 * ## The header carries what is true of the window
 *
 * It used to exist for a different reason, and the difference is worth keeping
 * written down. `Sidebar` returned `null` when collapsed — not a rail, not a
 * sliver — so its own close button could not bring it back, and the toggle had
 * to live somewhere always-mounted. The header was that somewhere.
 *
 * That is true again (2026-08-30, the 7D pass): the rail era in between gave
 * the sidebar a way to reopen itself, and the rail turned out to be a column
 * of doubles standing beside the thing it doubled. Collapsed is `null` once
 * more, and the header shows the way back exactly while it is needed — one
 * control, one home at a time. What the bar holds otherwise is what belongs
 * to the *window*: the name of what it is pointed at, the way into the
 * palette (centred), the opener, settings, the theme, and the drag region.
 *
 * ## The sidebar floats
 *
 * It is a card with a margin, a border and a shadow, sitting on the window
 * background rather than being a column welded to the frame. It holds every
 * project, most recently worked in first, and a row click carries provider,
 * profile, directory and transcript across together.
 *
 * The update surface is the chip in the header — one home that never
 * disappears, whatever the sidebar is doing. See `UpdateChip` in `AppHeader`.
 *
 * ## The status line belongs to the composer, not to the window
 *
 * Profile, model, thinking effort, permission mode, working directory: every
 * segment describes what the *next run* will do, so the bar lines up with the
 * input's edges inside the working column instead of spanning the app. See
 * `StatusLine`'s own header.
 *
 * The working directory is the strictest case of that rule and the reason it is
 * worth stating twice. It is a property of the session in this column — it
 * follows the session you select, and changing it ends the session rather than
 * moving one somewhere its transcript was never written. The sidebar used to
 * offer it too, one row under New session, which framed it as a standing window
 * setting the next session would inherit. It does not live there any more.
 *
 * ## What stayed where it was
 *
 *  - tool input, output and diffs        → expand in place, in the transcript
 *  - permission prompts                  → inline, where they happened, so a
 *                                          failed decision is reported
 *                                          somewhere the user is looking
 *  - run facts and the capability matrix → the run inspector dialog
 *  - every command, and session search   → still ⌘K. Sessions live in the
 *                                          sidebar as well; the palette remains
 *                                          the keyboard route to them.
 *
 * ## Performance
 *
 * The sidebar is a sibling of the transcript, not an ancestor, and nothing in
 * it reads the transcript store. Streaming deltas are delivered to leaf rows by
 * an external store React never sees (`state/transcript.ts`), so adding a
 * persistent pane put no work on the per-token path. Do not lift transcript
 * state up into this component to share it with the sidebar. The header follows
 * the same rule: it names the session, never its contents.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { useHotkeys } from './hooks/useHotkeys';
import { AppHeader } from './components/AppHeader';
import { CommandPalette } from './components/CommandPalette';
import { ErrorSurface } from './components/ErrorSurface';
import { openFindInSession } from './components/FindInSession';
import { RunInfoDialog } from './components/RunInfoDialog';
import { SettingsDialog } from './components/settings';
import { Sidebar } from './components/Sidebar';
import { WorkingArea } from './components/WorkingArea';
import { LogoMark } from './components/logo';
import { paneState } from './state/pane';
import {
  bootstrap,
  closeSettings,
  denyPendingPermission,
  focusedPane,
  installEventBridge,
  installSuggestionFeed,
  installPlanUsageFeed,
  installRunWatchdog,
  installSettingsMenuFeed,
  installBrowserFeed,
  installTerminalFeed,
  startSessionFeed,
  interruptRun,
  isLive,
  newSession,
  openSettings,
  setInfo,
  setPalette,
  splitPane,
  toggleSidebar,
  togglePalette,
  toggleBrowser,
  toggleTerminal,
  useApp,
} from './state/store';

/**
 * What Escape does, in priority order.
 *
 * Exported and free-standing rather than written inline in the hotkey map,
 * because the *order* is the whole design and an order is a thing worth
 * asserting: each branch returns, so the list reads as "the most local thing
 * first". Left inline it could only be exercised by mounting the entire app,
 * which is a high price for a five-branch decision — and the branch at the
 * bottom is the one under a user preference, so it has to be cheap to test.
 *
 * The composer has a handler of its own; see the note there. `useHotkeys`
 * ignores text fields, and the composer is where the caret lives, so a key
 * bound only here would do nothing exactly when the user needed it.
 */
export function pressEscape(): void {
  const state = useApp.getState();
  if (state.paletteOpen) {
    setPalette(false);
    return;
  }
  if (state.infoOpen) {
    setInfo(false);
    return;
  }
  const pane = focusedPane(state);
  const session = paneState(pane);
  // A parked prompt owns Escape. Denying is the safe answer and it unblocks
  // the provider; interrupting a run that owes a decision would strand it.
  //
  // Only *this* pane's queue. A prompt parked in another pane is still
  // answerable on its own card, and having Escape reach across a divider
  // would deny a tool call the user is not looking at.
  if (session.permissionQueue.length > 0) {
    void denyPendingPermission(pane);
    return;
  }
  if (state.screen === 'profiles') {
    closeSettings();
    return;
  }
  /*
   * The last branch, and the only one the setting reaches.
   *
   * Everything above is Escape doing what Escape does everywhere — close the
   * thing in front of you, answer the thing blocking you. Stopping a run is the
   * one that is destructive and the one people asked to be able to switch off,
   * so it is gated and the rest is not. Off, Escape simply stops here rather
   * than doing something else instead.
   */
  if (state.escapeStopsRun && isLive(session)) void interruptRun(pane);
}

export function App(): ReactElement {
  const bridgeMode = useApp((s) => s.bridgeMode);
  const booted = useApp((s) => s.booted);
  const started = useRef(false);

  /**
   * Subscribe *before* bootstrapping. Events for a run can arrive before the
   * call that started it resolves, and a listener installed afterwards would
   * miss the beginning of the stream.
   */
  useEffect(() => {
    const unsubscribe = installEventBridge();
    // The sidebar's history is not only written by this window — another Artemis
    // window, or the user's own CLI in a terminal, writes into the same store.
    // The feed is what keeps the list current without a reload; see
    // `startSessionFeed`.
    const stopFeed = startSessionFeed();
    // Plan usage arrives unasked, from main's poller, for every account rather
    // than the active one — which is what lets the profile menu recommend.
    const stopUsageFeed = installPlanUsageFeed();
    // Before `bootstrap`, for the same reason `installEventBridge` is: bootstrap
    // adopts the shells main is still holding, and the first output from one of
    // them arrives on this channel. Subscribing afterwards would drop whatever a
    // busy terminal printed during the adoption.
    const stopTerminalFeed = installTerminalFeed();
    // Beside the terminal feed and for its reason: `bootstrap` re-adopts the
    // pages main is still holding, and a page that navigates during that
    // adoption pushes its state on this channel.
    const stopBrowserFeed = installBrowserFeed();
    // The macOS menu bar's Settings… item. Nothing races here — the click can
    // only arrive after the app is up — but it is torn down with the rest.
    const stopSettingsMenuFeed = installSettingsMenuFeed();
    // The stall sweep: a live pane whose feed has gone quiet is checked
    // against main and healed from its retained events, so a lost stream costs
    // seconds instead of a ⌘R. Installed with the feeds because it is one — the
    // pull-shaped half of the push channel above.
    const stopWatchdog = installRunWatchdog();
    // Predictions arrive seconds after a run ends — well after `bootstrap` —
    // so ordering is relaxed here; it rides with the feeds because it is one.
    const stopSuggestionFeed = installSuggestionFeed();
    if (!started.current) {
      started.current = true;
      void bootstrap();
    }
    return () => {
      unsubscribe();
      stopWatchdog();
      stopSuggestionFeed();
      stopFeed();
      stopUsageFeed();
      stopTerminalFeed();
      stopBrowserFeed();
      stopSettingsMenuFeed();
    };
  }, []);

  useHotkeys({
    /*
     * `!` — fires even from inside a text field. The palette has to be
     * reachable from the composer, which is where the caret spends its life.
     */
    /*
     * Every session-scoped shortcut below acts on the *focused* pane, and says
     * so by resolving `focusedPane()` itself rather than leaning on the store's
     * default argument. The difference is only legibility — the default is the
     * same pane — but a reader of this file should not have to open the store to
     * find out which of several conversations ⌘N clears.
     */
    '!mod+k': () => {
      // Never over a permission prompt: the run is parked and the answer is
      // owed. Opening a palette on top of it would put a scrim over the one
      // thing that unblocks the agent.
      if (paneState(focusedPane()).permissionQueue.length > 0) return;
      togglePalette();
    },
    escape: pressEscape,
    /*
     * `!` — fires from inside a text field, and that is the whole point: the
     * caret lives in the composer, and ⌘F pressed there means "search what I
     * am reading", exactly as it does in a browser. The bar it opens belongs
     * to the focused column, and takes the keystrokes from there itself.
     */
    '!mod+f': () => {
      openFindInSession(focusedPane().id);
    },
    'mod+n': () => newSession(focusedPane()),
    'mod+b': toggleSidebar,
    /*
     * `!` — fires from inside a text field, and here that is not a nicety.
     *
     * xterm receives keys through a hidden `<textarea>`, which is exactly what
     * `isTextEntry` looks for, so a plain `mod+j` binding would work everywhere
     * in the app *except* while a terminal has focus — that is, except while
     * you are looking at the thing the shortcut toggles. It would fail
     * silently, which is the same trap the `mod+shift+\` comment below
     * describes from the other direction.
     *
     * Nothing is given up by claiming it: ⌘J is not a key any shell binds, and
     * every terminal key that matters — ⌃C, ⌃D, ⌃Z, Escape — is unbound here
     * and reaches the shell untouched.
     */
    '!mod+j': () => toggleTerminal(focusedPane()),
    /*
     * ⌘⇧B for the browser. `⌘B` is the sidebar and stays that way — this is the
     * shifted neighbour, which is the pattern `⌘\` and `⌘⇧\` already set.
     *
     * `!` for `mod+j`'s reason, aimed at a different text field: the address bar
     * is an `<input>`, so a plain binding would fail exactly while the reader
     * was looking at the browser it toggles.
     *
     * One thing it genuinely cannot do, and it is worth writing down rather than
     * leaving to be discovered: while the *page itself* has focus, the keystroke
     * goes to the page. A `WebContentsView` is a separate renderer, not an
     * element in this document, so nothing here sees the event. Click the app's
     * chrome first — which is what a browser's own shortcuts do too when focus
     * is inside a plugin.
     */
    '!mod+shift+b': () => toggleBrowser(focusedPane()),
    /*
     * `⌘\` splits to the right, `⌘⇧\` splits downwards.
     *
     * Two keys rather than one toggle, because the two produce different
     * layouts and neither is undone by repeating it — a third press of a
     * "toggle" would have to guess which of three panes to destroy. Closing has
     * no shortcut on purpose: with up to sixteen panes open, a keystroke that
     * ends a conversation should be aimed at a specific one, and the button on
     * each pane's caption is that aim.
     *
     * Both act on the focused pane, whose brighter caption marks it. A split
     * the grid has no room for is a no-op here; the header's buttons say why.
     */
    'mod+\\': () => splitPane('right'),
    /*
     * Two spellings for one chord, and the second is not a typo.
     *
     * `useHotkeys` builds its combo from `event.key`, which is the character
     * the keyboard *produced* — and Shift turns `\` into `|`. So a binding
     * written the way it is spoken (`mod+shift+\`) never matches anything, and
     * does so silently: no error, no warning, a shortcut that simply does
     * nothing. Registering both is the honest fix at this level; teaching
     * `describe()` to reason about physical keys would change the meaning of
     * every existing binding to solve one.
     */
    'mod+shift+\\': () => splitPane('down'),
    'mod+shift+|': () => splitPane('down'),
    /*
     * `screen === 'profiles'` still means "the settings surface is open" — the
     * value kept its historical name so that every existing call site stayed
     * correct. Which pane it shows is the separate `settingsSection`, and
     * `openSettings()` with no argument deliberately leaves that alone so the
     * shortcut reopens wherever the user last was.
     */
    'mod+,': () => {
      if (useApp.getState().screen === 'profiles') closeSettings();
      else openSettings();
    },
    'mod+i': () => setInfo(!useApp.getState().infoOpen),
  });

  if (booted && bridgeMode === 'unavailable') return <DeadEnd />;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-abyss">
      <AppHeader />
      {/*
        Cards on a canvas — the 7D shell (docs/design/7d-full.html, `.body`).

        The sidebar, every conversation pane and the dock are detached rounded
        panels sitting on the darker window ground, with a 7px gutter between
        them and the same inset around them. The first conversion moved the
        tokens and left the regions welded edge-to-edge, and the app kept
        reading as a slab whatever its corners did — the geometry *is* the
        design language, not a nicety on top of it. Each card owns its border
        and radius (`Sidebar`, `PaneColumn`, `DockPane`); this container owns
        only the ground, the inset and the gutters, so a region cannot decide
        its own gap and drift off the grid.
      */}
      <div className="flex min-h-0 flex-1 gap-[7px] bg-abyss p-[7px]">
        <Sidebar />
        {/*
          The banner surface spans the working area rather than sitting inside a
          column, because a banner is the *window* reporting: "could not list
          providers", "no bridge to the main process". The failures that belong
          to one conversation are already reported inside it — a run that fails
          writes its reason into that column's transcript, and a permission
          decision that will not send says so on its own card.

          The controls under each transcript belong to the input, not to the
          window; see `WorkingArea`, which owns that arrangement now.
        */}
        <main className="flex min-w-0 min-h-0 flex-1 flex-col">
          <ErrorSurface />
          <WorkingArea />
        </main>
      </div>

      <CommandPalette />
      <RunInfoDialog />
      {/*
        Mounted unconditionally, unlike the full-screen profiles surface it
        replaces. It is a Radix dialog and reads its own open state off the
        store (`screen === 'profiles'` — see the `mod+,` note above), so
        gating it here would unmount it mid-transition and cost the close
        animation.
      */}
      <SettingsDialog />
    </div>
  );
}

/**
 * What the window shows when there is no preload script.
 *
 * The renderer has no fallback path to the outside world by design, so this is
 * genuinely terminal — better to say so plainly than to render an app whose
 * every button silently fails.
 */
function DeadEnd(): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-abyss px-8 text-center">
      <LogoMark size={30} className="text-signal" />
      <h1 className="text-lg font-semibold tracking-tight text-ink">Artemis could not start</h1>
      <p className="max-w-md text-xs leading-relaxed text-ink-muted">
        The preload bridge is missing, so this window has no way to reach the main process. Nothing
        in the interface would work. Restart Artemis; if it keeps happening, the app’s preload script
        failed to load.
      </p>
    </div>
  );
}
