/**
 * The dock: things a conversation put on screen beside itself.
 * ============================================================================
 *
 *     ╭──────────────────────╮╭───────────────────────────╮
 *     │ artemis › Wire seam  ││ ◱ sales.html ✕   ▸ zsh ✕ +│  ← the tab strip
 *     ├──────────────────────┤├───────────────────────────┤
 *     │  TRANSCRIPT          ││                           │
 *     │  COMPOSER · STATUS   ││   ~/libra ❯ pnpm dev      │
 *     ╰──────────────────────╯╰───────────────────────────╯
 *
 * Several kinds of thing live in the right-hand rail: a **preview**, which is a
 * file the agent wrote; a **terminal**, which is a shell the user asked for; and
 * a **browser**, which is a page. They have almost nothing in common as objects
 * — one is a snapshot of some bytes, one is a running process, one is a native
 * view the main process draws — and exactly one thing in common as *UI*: each
 * belongs to a conversation, and none makes any sense next to a different one.
 * This module is that one thing, factored out.
 *
 * ## Ownership, and why it needs two ids
 *
 * A {@link DockOwner} names a conversation the way `PreviewOwner` always has:
 * by pane, by run, and by session, because no one of them covers a
 * conversation's whole life.
 *
 * A run has no `sessionId` until `session.started` arrives — which is precisely
 * the window in which a fresh conversation writes its first artifact or gets its
 * first terminal — so the run id identifies it until the session id exists. Once
 * it does, {@link learnSessionId} adopts it, and from then on ownership survives
 * the run ending, a later resume, and a fork. Before either exists, a brand new
 * pane that has never run anything is identified by the pane alone, which is
 * what makes "open a terminal in an empty session" work at all.
 *
 * ## Where the two kinds part company
 *
 * When a conversation leaves the screen:
 *
 *  - **its preview is destroyed.** It was a snapshot; reopening it is one click
 *    on the tile that is still in the transcript.
 *  - **its terminal is only hidden.** The shell keeps running.
 *  - **its browser is only hidden**, on the terminal's side of the line and for
 *    the terminal's reason.
 *
 * That asymmetry is the single most important decision in this feature, so it is
 * worth stating why rather than leaving it to be discovered. A preview costs
 * nothing to recreate and holds no state anyone would miss. A terminal is the
 * opposite on both counts: it is very often a `pnpm dev`, a `tail -f`, or an
 * ssh session, and killing one because the user clicked another conversation in
 * the sidebar would make the feature actively dangerous to use. So the tab
 * disappears with its conversation, comes back with it, and only the ✕ ends the
 * process — which is exactly what a tab's ✕ means everywhere else.
 *
 * A browser sorts with the terminal because the test is "could this be rebuilt
 * from what is still on screen", and a page cannot: it has a scroll position, a
 * session cookie, and quite possibly a half-filled form. Reloading it is not
 * reopening it.
 *
 * ## Everything here is pure
 *
 * No store, no `Pane`, no bridge. The functions take a description of what the
 * columns are currently showing ({@link ShownConversation}) and answer questions
 * about it. That is what lets the reconciliation rules — the part with all the
 * edge cases — be tested without building a window.
 */

import type {
  BrowserId,
  BrowserInfo,
  RunId,
  SessionId,
  TerminalId,
  TerminalInfo,
} from '@rx-artemis/protocol';
import type { PaneId } from './pane';

/**
 * Which tab the dock is showing.
 *
 * A discriminated union rather than a string, because a terminal's identity is
 * its {@link TerminalId} and flattening that into `"terminal:abc"` would mean
 * parsing it back out at every use. {@link tabKey} exists for the two places
 * that genuinely need a string — a React `key` and a `Set` — and nowhere else.
 */
export type DockTab =
  /**
   * A file the agent wrote, framed or rendered. One tab per conversation.
   *
   * Keyed by id where it used to be a constant, because the constant was the
   * bug: one preview for the whole window meant previewing something in pane B
   * silently replaced what pane A was reading — the window-singleton behaviour
   * ADR 0002 exists to end. The id is minted by `openPreview`, which keeps it
   * to **one preview per conversation**: a second artifact previewed in the
   * same conversation replaces that conversation's preview in place, keeping
   * the id so the strip does not reshuffle, and touches nobody else's.
   */
  | { readonly kind: 'preview'; readonly id: string }
  /**
   * A file, shown as text. One tab each.
   *
   * This was keyed by nothing for a long time — one file at a time, as the
   * preview then was — on the grounds that a tab per file would let a reader
   * skimming one paragraph fill the strip with eight of them. What that traded
   * away turned out to be the more valuable half: following a second link
   * *replaced* the first, so two files could not be read together, and reading
   * two files together is most of what reading code is.
   *
   * The strip is the reason it is affordable now. It runs down the side rather
   * than across the top, so a ninth tab costs 34 vertical pixels in a column
   * that scrolls, not a slice of the composer's width. And the skim-debris
   * problem the old constant guarded against — forty tabs across a long
   * session — is answered by *transience* rather than by a singleton: a file
   * opens into a transient tab that the next file replaces, and only a pinned
   * one claims a lasting place in the strip. See `FileState.pinned`.
   *
   * Opening a path that is already open focuses that tab instead of adding a
   * second — see `openFile`, which is what keeps a link clicked twice from
   * being two identical tabs.
   */
  | { readonly kind: 'file'; readonly id: string }
  /**
   * The working directory, listed.
   *
   * Keyed by pane rather than being a constant: unlike the preview and the file
   * tab — which are *one* thing the conversation put on screen — this is a view
   * of a column's `cwd`, and two columns in different directories want two
   * listings. It is the same reason the tasks tab carries a `paneId`.
   */
  | { readonly kind: 'files'; readonly paneId: PaneId }
  /**
   * Every document the conversation has made, listed.
   *
   * Keyed by pane for the folder browser's reason: it is a view of what a
   * column's *transcript* holds, and two columns hold two transcripts. Unlike
   * the preview — which is one artifact, framed — this is the index of all of
   * them, and the way back to any one of them once it has scrolled out of
   * sight: a long turn writes twenty documents and the tiles for them are
   * wherever in the thread the agent made them.
   */
  | { readonly kind: 'documents'; readonly paneId: PaneId }
  | { readonly kind: 'terminal'; readonly id: TerminalId }
  /**
   * A page the user opened, drawn by the main process behind this pane.
   *
   * Keyed by id and owned exactly like a terminal, because it is the same kind
   * of object: a *live* thing with state nobody can reconstruct. A page has a
   * scroll position, a session cookie and possibly a half-filled form, so it is
   * hidden when its conversation leaves the screen and destroyed only by the ✕.
   * The preview and file tabs go the other way for the opposite reason — they
   * are snapshots, and the link that made one is still in the transcript.
   */
  | { readonly kind: 'browser'; readonly id: BrowserId }
  /**
   * What one conversation has delegated. One tab, however many tasks — the list
   * is the pane's content, not the strip's.
   *
   * Keyed by pane rather than being a constant, because there can be two of
   * these on screen at once: a
   * split with an agent working in each column has two sets of delegated work,
   * and they are not the same list. The pane is the right key rather than the
   * run — the rows outlive the run that launched them, which is the entire
   * subject — and rather than the session, which does not exist yet for a
   * conversation whose first turn is the one delegating.
   */
  | { readonly kind: 'tasks'; readonly paneId: PaneId }
  /**
   * One delegated agent's own conversation, opened from a row in the tasks tab.
   *
   * The list answers "what is running"; this answers "what is it *doing*", and
   * nothing else can. A subagent writes its own transcript beside its parent's
   * and the parent keeps only the final report — so the work itself, the tool
   * calls and the reasoning, exists on disk in a file the delegating session
   * never shows. Without this the only view of an agent is a one-line summary.
   *
   * Keyed by pane *and* task, for the reason the tasks tab is keyed by pane:
   * two columns can each have delegated work, and their agents are not the same
   * agents. The task id is the provider's own, which is also the id its
   * transcript is filed under — see `openAgentTab`.
   */
  | { readonly kind: 'agent'; readonly paneId: PaneId; readonly taskId: string };

/** A stable string for one tab. For React keys and set membership only. */
export function tabKey(tab: DockTab): string {
  switch (tab.kind) {
    case 'preview':
      return `preview:${tab.id}`;
    case 'file':
      return `file:${tab.id}`;
    case 'files':
      return `files:${tab.paneId}`;
    case 'documents':
      return `documents:${tab.paneId}`;
    case 'terminal':
      return `terminal:${tab.id}`;
    case 'browser':
      return `browser:${tab.id}`;
    case 'tasks':
      return `tasks:${tab.paneId}`;
    default:
      return `agent:${tab.paneId}:${tab.taskId}`;
  }
}

/** Whether two tabs are the same tab. */
export function sameTab(a: DockTab | null, b: DockTab | null): boolean {
  if (a === null || b === null) return a === b;
  return tabKey(a) === tabKey(b);
}

/**
 * Which conversation something in the dock belongs to.
 *
 * See the file header for why all three fields exist and why two of them are
 * optional. An owner with neither `runId` nor `sessionId` is a pane that has
 * never run anything — legitimate, and identified by `paneId` alone.
 */
export interface DockOwner {
  readonly paneId: PaneId;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
}

/**
 * What one column is showing right now.
 *
 * The projection of a `Pane` that this module needs, and nothing more. Built by
 * the store from the visible panes; see `describeShown` there.
 */
export interface ShownConversation {
  readonly paneId: PaneId;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
  /**
   * Whether this column has delegated work it is still offering a tab for.
   *
   * Not simply "has any": a column whose rows have all been dismissed by the
   * tab's ✕ answers no until something new is delegated. The store decides that
   * — see `showsTasks` — because it is a question about rows, and carrying the
   * rows through here would make every progress message rebuild the strip.
   */
  readonly hasTasks?: boolean;
  /**
   * Whether the user asked for that tab by hand, rather than it arriving.
   *
   * The one thing separating a delegated tab from every other surface the agent
   * puts in the dock: it has two origins. It appears on its own when work is
   * delegated, and it opens on a press of the header's Delegated button. Only
   * the first is an agent surface, so only the first is what "the dock never
   * opens on its own" is about — and without this flag that setting takes the
   * button with it, leaving an enabled control that does nothing at all.
   *
   * Written while the tab is open and cleared by its ✕, so it authorises *this*
   * tab rather than every future one. Work delegated after the user shut it
   * stays out of the strip, which is the promise the setting makes.
   */
  readonly tasksRequested?: boolean;
  /**
   * Whether this column has asked for the folder browser.
   *
   * Unlike `hasTasks` there is no "is there anything to show" beside it: a
   * working directory always exists, so asking is the only thing that can put
   * the tab on the strip. Which also means `dockAutoOpen` has no say — nothing
   * arrives here on its own for the dock to reveal.
   */
  readonly filesRequested?: boolean;
  /**
   * Whether this column has asked for its documents listed.
   *
   * The folder browser's rule, for the folder browser's reason: the list is
   * only ever a request, never an arrival. A conversation that has made
   * nothing still has an (empty) list to show, and one that has made twenty
   * documents announces each of them in the thread as a tile — so nothing
   * about the count is a reason to put the tab on the strip uninvited.
   */
  readonly documentsRequested?: boolean;
}

/**
 * One browser, as the window holds it.
 *
 * `title` follows the page rather than the address for the reason a terminal's
 * follows the running program: a strip of tabs all saying `https` would be
 * useless the moment there were two of them. It is page-authored text, so it is
 * capped by main and rendered as text.
 */
export interface BrowserRecord {
  readonly info: BrowserInfo;
  readonly owner: DockOwner;
  /**
   * True for a page an agent opened with a tool, absent for one the user asked
   * for. The record is kept either way — main is driving the page and it must
   * stay closeable and re-ownable — but `visibleTabs` only surfaces an
   * agent-opened page while the dock is allowed to open on its own. Marked on
   * the record rather than resolved at arrival so that turning the setting on
   * later reveals the pages that arrived while it was off.
   */
  readonly agentOpened?: boolean;
}

/**
 * One terminal, as the window holds it.
 *
 * `title` is separate from `info.shell` because it follows the running program:
 * a shell that starts as `zsh` becomes `vim` and then `zsh` again, reported by
 * the OSC title sequence xterm already parses. A tab that always said `zsh`
 * would be useless the moment there were two of them.
 */
export interface TerminalRecord {
  readonly info: TerminalInfo;
  readonly owner: DockOwner;
  readonly title: string;
  /** True once the shell has exited. The tab stays until the user closes it. */
  readonly exited: boolean;
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Is the conversation this belongs to on screen?
 *
 * Three cases, in the order they are decided:
 *
 *  1. **A session id settles it outright.** That is the durable identity — it
 *     survives the run ending and matches a later resume of the same
 *     conversation, in whichever column it was resumed into. A terminal follows
 *     its conversation across the grid, which is the behaviour people expect
 *     from something they think of as "this project's shell".
 *  2. **A run id, in the column it started in.** Before `session.started` there
 *     is nothing durable to match on, so identity is the run — and a pane whose
 *     run has since been replaced is showing a different conversation even
 *     though it is the same column.
 *  3. **Neither: the pane itself.** A conversation that has never run anything.
 */
export function ownerIsShown(owner: DockOwner, shown: readonly ShownConversation[]): boolean {
  if (owner.sessionId !== undefined) {
    return shown.some((one) => one.sessionId === owner.sessionId);
  }
  if (owner.runId !== undefined) {
    return shown.some((one) => one.paneId === owner.paneId && one.runId === owner.runId);
  }
  // Case 3, and note that it does **not** compare runs. A terminal opened on an
  // empty session belongs to the column, and stays there as the column is used:
  // sending the first prompt starts a run, and a check that required the pane's
  // run to still match `undefined` would make the tab vanish at exactly that
  // moment — the shell disappearing the first time you talk to the agent.
  return shown.some((one) => one.paneId === owner.paneId);
}

/**
 * The session id this owner's conversation has learned since, if any.
 *
 * Returns `null` when there is nothing to adopt — which is the overwhelmingly
 * common case, since an owner adopts at most once and most of them arrive with a
 * session id already.
 *
 * Two guards, and both are about adopting the *wrong* id rather than about
 * tidiness:
 *
 *  - **There has to be a run to learn from.** Adoption models one specific
 *    event: a run that had no session id being told what it is. An owner with no
 *    run is not waiting to find out — it is a terminal opened on an empty
 *    column, and letting it adopt would mean the first session resumed into that
 *    column quietly claiming it, so closing that session would take an unrelated
 *    shell with it.
 *  - **The run has to still be the same one.** A pane that has moved on is a
 *    different conversation, and taking its session id would re-home the tab
 *    onto work this owner has nothing to do with.
 */
export function learnSessionId(
  owner: DockOwner,
  shown: readonly ShownConversation[],
): SessionId | null {
  if (owner.sessionId !== undefined || owner.runId === undefined) return null;
  const home = shown.find((one) => one.paneId === owner.paneId);
  if (home === undefined || home.runId !== owner.runId) return null;
  return home.sessionId ?? null;
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which shown conversation is showing this owner, if any.
 *
 * The same three-case precedence {@link ownerIsShown} decides with, returning
 * the conversation instead of a boolean — because the strip now *groups* tabs
 * under the conversation that owns them, and a yes/no cannot say which group a
 * session-owned terminal resumed into a different column belongs to.
 */
export function shownOwning(
  owner: DockOwner,
  shown: readonly ShownConversation[],
): ShownConversation | undefined {
  if (owner.sessionId !== undefined) {
    return shown.find((one) => one.sessionId === owner.sessionId);
  }
  if (owner.runId !== undefined) {
    return shown.find((one) => one.paneId === owner.paneId && one.runId === owner.runId);
  }
  return shown.find((one) => one.paneId === owner.paneId);
}

/**
 * The tabs to draw, left to right — grouped by the conversation that owns them.
 *
 * ## Conversation-major, not kind-major
 *
 * The strip used to interleave every visible conversation's tabs by kind: all
 * previews, then all terminals, then all browsers. In a 2×2 split that made
 * four terminals from four conversations four identical unlabelled icons — the
 * "whose dock is it?" problem e-catch left open, and ADR 0002 answers: a
 * surface belongs to a conversation, so the strip walks the conversations in
 * grid order and lays each one's surfaces out together. Within a conversation
 * the old order holds exactly: preview, files, terminals, browsers, the folder
 * browser, the documents list, tasks, and its opened agents.
 *
 * Both orders are *fixed* — the point was never the sequence but that a strip
 * must not reorder itself and move the ✕ the user was aiming at, the same
 * reason `sessionOrderHold` exists for the sidebar. Grid order only changes
 * when panes open or close, which is the user's own hand.
 *
 * ## `focus` is the scope
 *
 * When `focus` names a pane, only the conversation shown in *that pane* emits
 * tabs — the dock scoped to the focused conversation, which is the 2.0
 * default. `null` is the all-panes toggle: every shown conversation's group,
 * in grid order. The records behind the hidden groups are untouched either
 * way; scope decides what is drawn, never what exists. That distinction is the
 * same one the terminal's hide-versus-kill rule rests on, one level up.
 *
 * Tasks stay pinned late in their group for the old reason, sharpened: it is
 * the one tab nobody opens — the agent delegates something and it appears,
 * mid-turn — and anywhere earlier, that arrival would shift tabs out from
 * under a pointer already on the way to one. Its ✕ dismisses the tab and
 * nothing else; see `closeTasks` in the store.
 */
export function visibleTabs(
  /**
   * The open previews, in the order their conversations opened them. One per
   * conversation — `openPreview` enforces that — so a group never holds two.
   */
  previews: readonly { readonly id: string; readonly owner: DockOwner }[],
  terminals: readonly TerminalRecord[],
  shown: readonly ShownConversation[],
  /**
   * Agent transcripts the user has opened, in the order they opened them.
   *
   * Passed as (pane, task) pairs rather than as whole views, for the reason
   * `hasTasks` is a boolean: this module decides which tabs exist, and carrying
   * a transcript model through it would rebuild the strip on every message the
   * agent produced.
   */
  agents: readonly { readonly paneId: PaneId; readonly taskId: string }[] = [],
  /**
   * The open files, in the order they were opened.
   *
   * Each is drawn while its conversation is on screen and destroyed when that
   * conversation leaves, which is the preview's rule and holds for the same
   * reason: it is a snapshot of some bytes, and the way back is the path — in
   * the transcript, or in the folder browser.
   */
  files: readonly { readonly id: string; readonly owner: DockOwner }[] = [],
  /**
   * Pages this window has open, in the order they were opened.
   *
   * Ordered and placed exactly like {@link terminals}, and for the reason the
   * strip never reorders itself: a browser and a shell are both things the user
   * asked for, and interleaving them by recency would move the ✕ somebody was
   * aiming at.
   */
  browsers: readonly BrowserRecord[] = [],
  /**
   * Whether surfaces the *agent* put here may claim a tab.
   *
   * False is the appearance option "the dock never opens on its own": a tasks
   * tab that *arrived* with delegated work, and agent-opened pages, stay out of
   * the strip entirely, because any tab in an empty strip is what opens the
   * dock. Everything the user opened — preview, file, shells, their own pages,
   * agent transcripts they clicked into, and a delegated tab they asked for by
   * hand, which is {@link ShownConversation.tasksRequested} — is user input and
   * stays. The suppressed records still exist; flipping the setting back on
   * reveals them on the next reconcile.
   */
  agentSurfaces: boolean = true,
  /**
   * The pane whose conversation the strip is scoped to, or `null` for every
   * visible conversation. See the header: scope filters what is drawn, and
   * must never decide what exists.
   */
  focus: PaneId | null = null,
): readonly DockTab[] {
  const tabs: DockTab[] = [];
  const scoped = focus === null ? shown : shown.filter((one) => one.paneId === focus);

  for (const one of scoped) {
    for (const preview of previews) {
      if (shownOwning(preview.owner, shown) === one) tabs.push({ kind: 'preview', id: preview.id });
    }
    // Beside the preview rather than at the end: both are "a file this
    // conversation put on screen", and the two arriving in different places
    // would make the group's order look arbitrary.
    for (const file of files) {
      if (shownOwning(file.owner, shown) === one) tabs.push({ kind: 'file', id: file.id });
    }
    for (const terminal of terminals) {
      if (shownOwning(terminal.owner, shown) === one) {
        tabs.push({ kind: 'terminal', id: terminal.info.id });
      }
    }
    // After the shells rather than before them, which is only a convention —
    // but a fixed one, so that opening a browser never shifts a terminal's ✕.
    for (const browser of browsers) {
      if (browser.agentOpened === true && !agentSurfaces) continue;
      if (shownOwning(browser.owner, shown) === one) {
        tabs.push({ kind: 'browser', id: browser.info.id });
      }
    }
    // Before the delegated list, because it is a view of the *place* the column
    // is working rather than of what it has done there — and a fixed order so
    // opening one never shifts the other's ✕.
    if (one.filesRequested === true) tabs.push({ kind: 'files', paneId: one.paneId });
    // Beside the folder browser: both are views of the column's own things
    // rather than surfaces something opened, and both arrive only by request.
    if (one.documentsRequested === true) tabs.push({ kind: 'documents', paneId: one.paneId });
    if (one.hasTasks === true && (agentSurfaces || one.tasksRequested === true)) {
      tabs.push({ kind: 'tasks', paneId: one.paneId });
    }
    // A column's open agents sit directly after its own list, so the thing a
    // tab was opened *from* stays beside it rather than at the far end of a
    // split's strip.
    for (const agent of agents) {
      if (agent.paneId === one.paneId) tabs.push({ kind: 'agent', ...agent });
    }
  }
  return tabs;
}

/**
 * Which tab should be active, given what is visible.
 *
 * Keeps the current one when it is still there. Otherwise falls to the
 * **neighbour on the left**, or the first tab when there is none — the same rule
 * `closePane` uses for focus, and the same one a browser uses when you close a
 * tab: the eye is already near where the closed tab was, and jumping to the far
 * end of the strip is disorienting.
 *
 * `previous` is the strip as it was *before* whatever changed, which is what
 * makes "the neighbour on the left" answerable at all — after the fact, the
 * closed tab's position is gone.
 */
export function nextActiveTab(
  active: DockTab | null,
  visible: readonly DockTab[],
  previous: readonly DockTab[] = visible,
): DockTab | null {
  if (visible.length === 0) return null;
  if (active !== null && visible.some((tab) => sameTab(tab, active))) return active;

  const wasAt = active === null ? -1 : previous.findIndex((tab) => sameTab(tab, active));
  if (wasAt > 0) {
    // Walk left from where it was until something that survived turns up.
    for (let i = wasAt - 1; i >= 0; i -= 1) {
      const candidate = previous[i] as DockTab;
      if (visible.some((tab) => sameTab(tab, candidate))) return candidate;
    }
  }
  return visible[0] as DockTab;
}


/* -------------------------------------------------------------------------- */
/* What survives a restart                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One conversation's dock arrangement, as it goes into preferences.
 *
 * **An arrangement, not a session.** That distinction is the whole design here,
 * and it is what makes each field honest about how much it can promise.
 *
 * A browser is a URL, and reopening one gets you the page you were on. A file
 * and a preview are paths, and the same is true of them. A terminal is neither:
 * its value is a live process and its scrollback, and a process does not
 * survive the application exiting. So terminals are stored as a *count* — how
 * many were open — and restored as fresh shells in the pane's directory. What
 * comes back is the shape of the workspace, not the work.
 *
 * Storing a terminal's title would be the tempting mistake: a tab that says
 * `vim` and holds a new `zsh` is worse than one that says `zsh`, because the
 * first is a claim and the second is a fact.
 *
 * What changed under ADR 0002 is the *key*, not the shape. This used to be one
 * window-level record of whatever the focused pane had at quit — the honest
 * ninety per cent of a world where the dock was the window's. Surfaces belong
 * to conversations now, so preferences hold a map of these **per session id**
 * ({@link parseDockArrangements}), and each conversation's arrangement comes
 * back when *that conversation* is next opened. Session ids are the one dock
 * identity that survives a relaunch — pane ids are minted fresh per launch,
 * which is why nothing in here may ever key on one.
 */
export interface DockLayout {
  /** URLs of the browsers that were open, in tab order. */
  readonly browsers: readonly string[];
  /**
   * How many terminals were open. A count and not a list, because nothing about
   * a terminal survives except that it existed — see the note above.
   */
  readonly terminals: number;
  /** Paths of the files that were open in the viewer, in tab order. */
  readonly files: readonly string[];
  /** Path of the artifact that was previewed, if any. */
  readonly preview: string | null;
  /**
   * Which tab was in front, by kind.
   *
   * A kind rather than a `DockTab`, because the ids inside one are minted at
   * runtime — a stored `{ kind: 'terminal', id: 't3' }` would name a terminal
   * that no longer exists. The kind is enough to put the right *sort* of tab in
   * front, and `nextActiveTab` already handles the rest.
   */
  readonly activeKind: DockTab['kind'] | null;
}

/** Nothing open. What a machine with no stored layout restores. */
export const EMPTY_DOCK_LAYOUT: DockLayout = {
  browsers: [],
  terminals: 0,
  files: [],
  preview: null,
  activeKind: null,
};

/**
 * Read a stored layout back, tolerating anything.
 *
 * Preferences are JSON a user can edit and a previous build wrote, so every
 * field is checked rather than trusted. A malformed layout restores nothing,
 * which is the state the app was in before this existed — never a reason to
 * fail a launch.
 */
export function parseDockLayout(value: unknown): DockLayout {
  if (typeof value !== 'object' || value === null) return EMPTY_DOCK_LAYOUT;
  const raw = value as Record<string, unknown>;

  const browsers = Array.isArray(raw['browsers'])
    ? raw['browsers'].filter((url): url is string => typeof url === 'string' && url.length > 0)
    : [];

  // Bounded like the browsers and for the same reason: this is the one list a
  // hand-edited preferences file can make the app read from disk on launch.
  const files = Array.isArray(raw['files'])
    ? raw['files'].filter((path): path is string => typeof path === 'string' && path.length > 0)
    : [];

  const count = raw['terminals'];
  // Clamped rather than trusted: a hand-edited `terminals: 9999` would spawn
  // nine thousand shells on launch, which is a denial of service by typo.
  const terminals =
    typeof count === 'number' && Number.isFinite(count) && count > 0
      ? Math.min(Math.floor(count), MAX_RESTORED_TERMINALS)
      : 0;

  const kind = raw['activeKind'];
  const activeKind =
    typeof kind === 'string' && (DOCK_TAB_KINDS as readonly string[]).includes(kind)
      ? (kind as DockTab['kind'])
      : null;

  return {
    browsers: browsers.slice(0, MAX_RESTORED_BROWSERS),
    terminals,
    files: files.slice(0, MAX_RESTORED_FILES),
    preview: typeof raw['preview'] === 'string' && raw['preview'].length > 0 ? raw['preview'] : null,
    activeKind,
  };
}

/**
 * Ceilings on what a restore will reopen.
 *
 * Not a guess at what is reasonable — a bound on what a corrupt or hostile
 * preferences file can make the app do on launch. Reopening is the one thing
 * that happens before the user can intervene.
 */
export const MAX_RESTORED_TERMINALS = 8;
export const MAX_RESTORED_BROWSERS = 8;
export const MAX_RESTORED_FILES = 8;

/**
 * How many conversations' arrangements preferences keep.
 *
 * A bound on the map, not on any one restore — each entry is already clamped by
 * the ceilings above when it is read. Without this the map would grow by one
 * entry per conversation that ever opened a surface and shrink only when the
 * user emptied a dock by hand, which is a preferences file that expands for
 * ever. Twelve covers every conversation anyone plausibly rotates between;
 * the capture keeps the most recently touched (see `captureDockArrangements`
 * in the store, which appends touched sessions last).
 */
export const MAX_STORED_ARRANGEMENTS = 12;

/**
 * Read the per-session arrangement map back, tolerating anything.
 *
 * `parseDockLayout`'s posture, one level up: preferences are JSON a user can
 * edit and a previous build wrote, so the map, its keys and every entry are
 * checked rather than trusted. A malformed map restores nothing — never a
 * reason to fail a launch — and a malformed entry costs only itself.
 *
 * Entries that parse to nothing at all are dropped rather than kept: an empty
 * arrangement restores nothing, so storing it would only crowd real entries
 * out of the {@link MAX_STORED_ARRANGEMENTS} window.
 *
 * The cap keeps the *last* entries rather than the first, because the capture
 * writes most-recently-touched last — so a hand-grown or ancient map loses its
 * stalest conversations, which is the eviction the cap means.
 */
export function parseDockArrangements(value: unknown): Record<string, DockLayout> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, DockLayout> = {};
  for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sessionId.length === 0) continue;
    const layout = parseDockLayout(entry);
    const empty =
      layout.browsers.length === 0 &&
      layout.terminals === 0 &&
      layout.files.length === 0 &&
      layout.preview === null;
    if (!empty) out[sessionId] = layout;
  }
  const keys = Object.keys(out);
  if (keys.length <= MAX_STORED_ARRANGEMENTS) return out;
  const kept: Record<string, DockLayout> = {};
  for (const key of keys.slice(keys.length - MAX_STORED_ARRANGEMENTS)) {
    kept[key] = out[key] as DockLayout;
  }
  return kept;
}

/**
 * Every tab kind, for validating a stored one.
 *
 * A `Record` over the union rather than a hand-written list, because a
 * hand-written list can silently run one short: `'files'` was missing for as
 * long as the strip has had a folder browser, so a layout captured with that
 * tab in front wrote an `activeKind` this parser then rejected on the next
 * launch — restore quietly put nothing in front. Spelling it this way makes
 * the compiler refuse the next kind added to {@link DockTab} until it is
 * listed here too.
 */
const EVERY_DOCK_TAB_KIND: Record<DockTab['kind'], true> = {
  preview: true,
  file: true,
  files: true,
  documents: true,
  terminal: true,
  browser: true,
  tasks: true,
  agent: true,
};

const DOCK_TAB_KINDS = Object.keys(EVERY_DOCK_TAB_KIND) as readonly DockTab['kind'][];
