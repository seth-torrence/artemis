/**
 * The dock: a tab strip, and whatever is under the tab in front.
 * ============================================================================
 *
 *     ╭─────────────────────────────────────────────╮
 *     │ ◱ sales.html ✕ │ ▸ zsh ✕ │ ▸ pnpm ✕ │ +     │  ← the strip
 *     ├─────────────────────────────────────────────┤
 *     │                                             │
 *     │   ~/libra ❯ pnpm dev                        │
 *     │   ▸ ready in 412ms                          │
 *     ╰─────────────────────────────────────────────╯
 *
 * Unlike things share this rail — a file the agent wrote, a shell the user asked
 * for, a page either of them opened — and `state/dock.ts` explains why that is
 * one surface rather than several. This is the drawing half of it.
 *
 * ## Whose dock is it? The conversation's.
 *
 * The strip is scoped to the focused conversation by default and shows every
 * visible conversation's tabs only when the scope chip says `all` — the same
 * `dockScope` the delegated list has always read, generalised to the whole
 * rail per ADR 0002. In the `all` view every tab wears a small pane number so
 * a 2×2 split's four shells are four labelled things rather than four
 * identical icons, and the strip's action buttons act on the conversation *in
 * view* (`dockActionPane`), never silently on the focused column.
 *
 * ## The strip is hand-rolled, and `ui/tabs.tsx` is right there
 *
 * shadcn's `Tabs` wraps Radix, which gives correct roving focus and correct
 * `aria-controls` wiring for free — and has no notion of a tab that can be
 * closed. The ✕ is not decoration here; it is the control the whole feature was
 * asked for, and putting an interactive element inside a Radix `TabsTrigger`
 * means a button inside a button: invalid markup, and a click target that
 * activates the tab on its way to closing it.
 *
 * So the roles are written out by hand — `tablist`, `tab`, `tabpanel`,
 * `aria-selected`, arrow-key navigation — and the ✕ is a sibling of the tab's
 * label rather than a child of the tab. That is the same trade the sidebar's
 * resize handle makes, and for the same reason: the library is not wrong, it is
 * solving a different problem.
 *
 * ## Chrome's rules, because they are the ones people have learned
 *
 * The ✕ shows on the active tab and on hover, never on all of them at once — a
 * strip of four terminals with four ✕s reads as a warning rather than as tabs.
 * Middle-click closes, because it does everywhere else. And the strip never
 * reorders itself: see {@link visibleTabs}.
 *
 * ## Every terminal and every browser stays mounted
 *
 * The panel below renders **all** visible terminals and browsers and hides the
 * inactive ones, rather than rendering only the active one. That is not a
 * performance choice — it is what keeps `TerminalView`'s attach/detach cycle
 * from running on every tab click, which would move the live element back to the
 * parking lot and refit it twice per switch. The preview is the opposite: it is
 * cheap to rebuild and expensive to keep, since a hidden `<iframe>` goes on
 * running whatever script it was given.
 *
 * A browser is mounted for a sharper version of the same reason, and hidden a
 * *different* way. Its page is a native view composited above this document, so
 * `hidden` on the element would leave the page painted over an empty pane —
 * the hiding has to happen in the main process, which is why `BrowserPane`
 * takes `visible` rather than reading the active tab itself.
 *
 * The terminal split leans on the same arrangement: splitting shows several of
 * the already-mounted slots at once inside a container whose display changes,
 * so no xterm element moves, and the `ResizeObserver` each `TerminalView`
 * already runs refits every cell as the grid takes shape.
 */

import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactElement } from 'react';
import {
  BotIcon,
  FileCodeIcon,
  FilesIcon,
  FileTextIcon,
  GlobeIcon,
  LayoutGridIcon,
  PinIcon,
  PlusIcon,
  Rows2Icon,
  SquareArrowOutUpRightIcon,
  TerminalIcon,
  UsersIcon,
  XIcon,
  FolderIcon,
} from 'lucide-react';

import {
  agentViewIsLive,
  allPanes,
  closeAgentTab,
  closeDocuments,
  closeFile,
  closeFiles,
  closePreview,
  closeTasks,
  closeTerminal,
  closeBrowser,
  dockActionPane,
  dockTabHomePaneId,
  focusDockTab,
  liveTaskCount,
  MAX_SPLIT_TERMINALS,
  openTerminal,
  pinFile,
  toggleBrowser,
  toggleDocuments,
  toggleFiles,
  toggleTasks,
  toggleTerminal,
  setDockScope,
  taskCount,
  terminalSplitFor,
  toggleTerminalSplit,
  sameTab,
  tabKey,
  useApp,
  type DockTab,
  type TerminalRecord,
} from '../state/store';
import { AgentPane } from './AgentPane';
import { DocumentsPane } from './DocumentsPane';
import { FileViewer } from './FileViewer';
import { PreviewPane } from './PreviewPane';
import { FilesPane } from './FilesPane';
import { TasksPane } from './TasksPane';
import { TerminalView } from './TerminalView';
import { BrowserPane } from './BrowserPane';
import { DockHeader } from './DockHeader';
import { lastSegment } from '../lib/paths';
import { IconButton } from './disabled-reason';
import { cn } from '@/lib/utils';

export function DockPane(): ReactElement | null {
  const tabs = useApp((s) => s.visibleDockTabs);
  const active = useApp((s) => s.activeDockTab);
  if (tabs.length === 0) return null;

  return (
    /*
     * A row, not a column — `_layout.md` item 5.
     *
     * The tabs were a horizontal strip across the top, which put them in
     * competition with the panel's width: every tab took room from the thing
     * the panel exists to show, and a fourth or fifth one started scrolling
     * sideways in the narrowest surface in the window. A 34px icon column costs
     * the same 34px whether the dock holds two tabs or nine.
     */
    <section
      aria-label="Dock"
      /*
        No border, by request (2026-08-30): beside a bordered conversation
        card and across a gutter, the dock's own outline read as a box in a
        box. The card is told by its fill and its corners; the gutter does
        the separating.
      */
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-panel"
    >
      <DockStrip tabs={tabs} active={active} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DockBody tabs={tabs} active={active} />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                  */
/* -------------------------------------------------------------------------- */

function DockStrip({
  tabs,
  active,
}: {
  readonly tabs: readonly DockTab[];
  readonly active: DockTab | null;
}): ReactElement {
  const strip = useRef<HTMLDivElement>(null);
  const scope = useApp((s) => s.dockScope);
  // Whether the window even has a second conversation to widen the scope to.
  // With one pane the chip would be a control that changes nothing.
  const severalPanes = useApp((s) => allPanes(s).length > 1);
  // The conversation the strip's actions belong to: the one in view, which is
  // the focused pane's under `'pane'` scope and the active tab's under `'all'`.
  const actionPane = useApp((s) => dockActionPane(s));
  const splitOn = useApp((s) => terminalSplitFor(s, actionPane));
  /*
   * Owner badges exist only in the `all` view of a split window — the one
   * arrangement where two identical icons can belong to two conversations.
   * Everywhere else the answer to "whose is this tab" is "the conversation
   * you are looking at", and a number would be noise.
   */
  const badged = scope === 'all' && severalPanes;
  const panes = useApp(allPanes);
  const shellsInView = tabs.filter(
    (tab) => tab.kind === 'terminal' && dockTabHomePaneId(tab) === actionPane.id,
  ).length;

  /*
   * Up/down move between tabs, Home/End jump to the ends — what a vertical
   * `tablist` is expected to do. Left/right are kept as aliases rather than
   * dropped: the strip was horizontal until the shell refresh, and a reader
   * whose fingers learned it there should not find the keys dead.
   *
   * Focus moves with selection, because a roving tabindex that selects without
   * focusing strands the keyboard on the tab that has gone quiet.
   */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    // Roving focus over the strip's rendered tabs — openers included. It used
    // to walk the `tabs` array and *select* as it went, which was coherent
    // when every button was an instance; an opener cannot be selected, only
    // pressed, so the arrows now move focus and Enter is the press.
    const nodes = [...(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    if (nodes.length === 0) return;
    const at = nodes.findIndex((node) => node === document.activeElement);
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? nodes.length - 1
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (at + 1 + nodes.length) % nodes.length
            : (at - 1 + nodes.length) % nodes.length;
    nodes[to]?.focus();
  }, []);

  return (
    // The rail is two boxes now: a tab list that scrolls, and a footer that
    // does not. The `+` used to live inside the scrolling column, which put it
    // wherever the ninth tab pushed it — including past the fold, where the
    // one control for "another of these" was the thing that scrolled away.
    // A footer costs the strip nothing when it fits and keeps the button
    // reachable when it does not.
    <div className="flex w-10 shrink-0 flex-col">
      {/*
        The scope chip, generalised from the delegated list to the whole rail.

        It heads the strip rather than the footer because it changes what the
        strip *is* — this conversation's tabs, or everyone's — and a control
        that reframes a list belongs above it, where the tasks pane has always
        drawn its own copy of the same choice. One `dockScope` feeds both, so
        the strip and the delegated rows can never disagree about scope.

        Rendered only when a second conversation exists to widen into; a
        one-pane window's dock is already both readings at once.
      */}
      <IconButton
          label={
            severalPanes
              ? scope === 'all'
                ? 'Show only this conversation’s tabs'
                : 'Show every conversation’s tabs'
              : 'This conversation’s tabs — scope widens when a second conversation opens'
          }
          disabled={!severalPanes}
          disabledReason="One conversation is open, so its tabs and every tab are the same reading."
          size="icon-xs"
          aria-pressed={scope === 'all'}
          onClick={() => setDockScope(scope === 'all' ? 'pane' : 'all')}
          // The mockup's `.scope` is a pill at the head of the strip
          // (docs/design/7d-full.html): `rounded-full` on a hairline, filled
          // when it is the wider reading. Ours carries a glyph rather than the
          // word "pane" because it is a toggle and not a caption, but it takes
          // the same shape so the head of the strip reads as one thing.
          className={cn(
            'mx-auto my-1 shrink-0 rounded-full border border-hairline',
            scope === 'all' ? 'bg-wash-strong text-ink' : 'text-ink-faint hover:bg-wash',
          )}
        >
          <LayoutGridIcon />
        </IconButton>
      <div
        ref={strip}
        role="tablist"
        aria-label="Dock tabs"
        onKeyDown={onKeyDown}
        // 34px of icons down the left edge. `overflow-y-auto` rather than
        // `-x`: a dock with nine tabs scrolls vertically, where there is room,
        // instead of eating the width of the panel it is labelling. `min-h-0`
        // is what lets the list shrink under the footer instead of pushing it
        // out of the rail.
        //
        // Padded and centred, which is the opposite of what this said while the
        // tabs were full-bleed filled rows: those had to meet the strip's edges
        // or their fill floated with a sliver of panel showing through it. A
        // 7D tab is a *rounded button* (`.dstrip .dt` in
        // docs/design/7d-full.html), so it wants air on every side — the strip
        // supplies it here and the gap between tabs goes to the mockup's 4px.
        className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto py-1.5"
      >
        {STANDING_KINDS.map((slot) => {
          const instances = tabs.filter((tab) => tab.kind === slot.kind);
          // File viewers ride with the folder they came from: the `file`
          // kind has no standing slot of its own, so its tabs follow `files`.
          const viewers =
            slot.kind === 'files' ? tabs.filter((tab) => tab.kind === 'file') : [];
          if (instances.length === 0 && viewers.length === 0) {
            return <KindOpener key={slot.kind} slot={slot} pane={actionPane} />;
          }
          return [...instances, ...viewers].map((tab) => (
            <DockTabButton
              key={tabKey(tab)}
              tab={tab}
              active={sameTab(tab, active)}
              // The badge is the pane's ordinal in the grid, which is also the
              // order the scoped strip walks conversations in — so tab groups
              // and numbers count the same way.
              ownerBadge={badged ? ownerBadgeFor(tab, panes) : null}
            />
          ));
        })}
      </div>
      {/*
        The split: this conversation's shells side by side. In the footer with
        the `+` because the two are the same kind of statement about the same
        scope — "more of this conversation's terminals on screen" — and only
        offered once there are two shells to arrange.
      */}
      {shellsInView >= 2 ? (
        <IconButton
          label={splitOn ? 'Fold the terminals back into tabs' : 'Split the terminals'}
          size="icon-xs"
          aria-pressed={splitOn}
          onClick={() => toggleTerminalSplit(actionPane)}
          className={cn(
            'mx-auto my-0.5 shrink-0 rounded-md',
            splitOn ? 'bg-wash-strong text-ink' : 'text-ink-faint hover:bg-wash',
          )}
        >
          <Rows2Icon />
        </IconButton>
      ) : null}
      {/*
        Still one button, and still a terminal.

        This was briefly a menu when the rail grew a second kind of live thing,
        and a menu is the wrong shape for it: two items behind a click is more
        work than the one action it replaced, and `+` on a strip of tabs already
        means "another of these" everywhere else. The browser has its own
        control in the header beside the terminal's, which is where a reader
        looks for "open a thing" — see `AppHeader`.

        It opens in the conversation the strip is showing — `dockActionPane` —
        not silently in the focused column, which under the `all` scope could
        be a conversation whose tabs are nowhere near the pointer.
      */}
      <IconButton
        label="Open another terminal"
        size="icon-xs"
        onClick={() => void openTerminal(dockActionPane())}
        className="mx-auto my-0.5 shrink-0 rounded-md text-ink-faint hover:bg-wash"
      >
        <PlusIcon />
      </IconButton>
    </div>
  );
}

/**
 * The number a tab wears in the all-conversations view, and the words behind
 * it. The ordinal is the owning pane's position in the grid — the same order
 * the strip groups by — so "2" always means "the second column".
 */
function ownerBadgeFor(
  tab: DockTab,
  panes: readonly { readonly id: string }[],
): { readonly text: string; readonly label: string } | null {
  const home = dockTabHomePaneId(tab);
  if (home === null) return null;
  const index = panes.findIndex((pane) => pane.id === home);
  if (index < 0) return null;
  return { text: String(index + 1), label: `pane ${String(index + 1)}` };
}


/**
 * The seven standing surfaces, in the mockup's order.
 *
 * 7D's strip is not a list of what exists — it is the dock saying what it
 * *can* show (docs/design/7d-full.html, `.dstrip`): the kinds, always drawn,
 * the ones with something behind them lit. The app's strip used to render
 * only live tabs, which on a fresh conversation was two icons and a lot of
 * rail — the sparseness read as a different product. A kind with no instance
 * is an opener: terminal, browser, folder, the documents list and delegated
 * work can be opened by pressing them; a subagent's output and a preview
 * cannot be conjured, so those two follow the disabled-with-reason rule
 * instead of hiding.
 *
 * The documents list sits after the folder for the strip's own reason: it is
 * the other view of the column's *things* — what it has made, beside where it
 * is working — and a fixed place beside the folder is one nobody's pointer
 * has to hunt for.
 */
const STANDING_KINDS = [
  { kind: 'terminal', label: 'Open a terminal', open: toggleTerminal },
  { kind: 'browser', label: 'Open the browser', open: toggleBrowser },
  { kind: 'files', label: 'Open the working folder', open: toggleFiles },
  { kind: 'documents', label: 'Open the documents this conversation made', open: toggleDocuments },
  { kind: 'tasks', label: 'Open delegated work', open: toggleTasks },
  {
    kind: 'agent',
    label: 'Subagent output',
    reason: 'A subagent\u2019s output opens here once one runs.',
  },
  {
    kind: 'preview',
    label: 'Preview',
    reason: 'A preview opens here when the agent writes one.',
  },
] as const;

const KIND_GLYPHS: Record<(typeof STANDING_KINDS)[number]['kind'], ReactElement> = {
  terminal: <TerminalIcon className="size-3 shrink-0" aria-hidden="true" />,
  browser: <GlobeIcon className="size-3 shrink-0" aria-hidden="true" />,
  files: <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />,
  documents: <FilesIcon className="size-3 shrink-0" aria-hidden="true" />,
  tasks: <UsersIcon className="size-3 shrink-0" aria-hidden="true" />,
  agent: <BotIcon className="size-3 shrink-0" aria-hidden="true" />,
  preview: <SquareArrowOutUpRightIcon className="size-3 shrink-0" aria-hidden="true" />,
};

/** A kind with nothing behind it yet: the same 28px shape, offered. */
function KindOpener({
  slot,
  pane,
}: {
  readonly slot: (typeof STANDING_KINDS)[number];
  readonly pane: Parameters<typeof toggleTerminal>[0];
}): ReactElement {
  return (
    <IconButton
      label={slot.label}
      disabled={!('open' in slot)}
      disabledReason={'reason' in slot ? slot.reason : undefined}
      onClick={() => ('open' in slot ? slot.open(pane) : undefined)}
      className="size-7 shrink-0 rounded-md text-ink-faint/80 hover:bg-wash"
    >
      {KIND_GLYPHS[slot.kind]}
    </IconButton>
  );
}

function DockTabButton({
  tab,
  active,
  ownerBadge,
}: {
  readonly tab: DockTab;
  readonly active: boolean;
  readonly ownerBadge: { readonly text: string; readonly label: string } | null;
}): ReactElement | null {
  if (tab.kind === 'preview') return <PreviewTabButton id={tab.id} active={active} ownerBadge={ownerBadge} />;
  if (tab.kind === 'file') return <FileTabButton id={tab.id} active={active} ownerBadge={ownerBadge} />;
  if (tab.kind === 'terminal') return <TerminalTabButton id={tab.id} active={active} ownerBadge={ownerBadge} />;
  if (tab.kind === 'browser') return <BrowserTabButton id={tab.id} active={active} ownerBadge={ownerBadge} />;
  if (tab.kind === 'tasks') return <TasksTabButton paneId={tab.paneId} active={active} ownerBadge={ownerBadge} />;
  // Named rather than left to a fallthrough. The `default` case used to assume
  // `agent` was the only kind left, which is true right up until it is not —
  // adding `files` to the union turned a compile error into the only warning
  // anyone got.
  if (tab.kind === 'files') return <FilesTabButton paneId={tab.paneId} active={active} ownerBadge={ownerBadge} />;
  if (tab.kind === 'documents') {
    return <DocumentsTabButton paneId={tab.paneId} active={active} ownerBadge={ownerBadge} />;
  }
  return (
    <AgentTabButton paneId={tab.paneId} taskId={tab.taskId} active={active} ownerBadge={ownerBadge} />
  );
}

interface OwnerBadge {
  readonly text: string;
  readonly label: string;
}

/**
 * The shared shell of a tab: the button, the ✕, and Chrome's hover rules.
 *
 * A `group` so the ✕ can appear on hover of the whole tab rather than only on
 * hover of itself — a two-pixel target that has to be hovered before it is
 * visible is not a target.
 */
function TabShell({
  active,
  label,
  title,
  icon,
  onSelect,
  onClose,
  onPromote,
  closeLabel,
  muted,
  ownerBadge,
  ended,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly title: string;
  readonly icon: ReactElement;
  readonly onSelect: () => void;
  /**
   * What the ✕ does — which is not the same thing on all these tabs. A
   * preview's destroys a snapshot, a terminal's kills a shell, and the
   * delegated list's closes a view of work that goes on running either way.
   */
  readonly onClose: () => void;
  /** A double-click's meaning, where a tab has one: pinning a transient file. */
  readonly onPromote?: () => void;
  readonly closeLabel: string;
  readonly muted?: boolean;
  /**
   * The pane number worn in the all-conversations view. `null` everywhere
   * else — see `DockStrip`, which decides when owners need saying.
   */
  readonly ownerBadge: OwnerBadge | null;
  /**
   * True for a live surface whose process has ended. Its own mark rather than
   * a reuse of `muted`, because muted also means "loading" and "settled", and
   * "the shell behind this tab is gone" was recorded as indistinguishable at
   * a glance — the dot says it without hover.
   */
  readonly ended?: boolean;
}): ReactElement {
  return (
    <div
      /*
       * An icon in a column, so the name moves to the tooltip and the ✕ to a
       * hover corner. The label is not lost: `DockHeader` carries it in full at
       * the top of the panel, which is where a reader looks for "what am I
       * looking at" — the strip's job here is only "which of these".
       *
       * The active marker is the *fill*, not an accent rule down the left edge.
       * The rule was there because a full-bleed tab in a vertical strip has no
       * shared edge with the panel to merge into, so the fill alone had nothing
       * to make it read as selected. A 7D tab is a discrete rounded button
       * (`.dstrip .dt.on` in docs/design/7d-full.html) — a shape with its own
       * outline — so `bg-wash-strong` is legible as "this one" without a second
       * mark, and the beam stops being spent on something the fill already says.
       */
      className={cn(
        'group relative flex size-7 shrink-0 items-center justify-center rounded-md',
        active ? 'bg-wash-strong text-ink' : 'text-ink-faint hover:bg-wash',
      )}
      // Middle-click closes, as it does on every other tab strip. On `auxiliary`
      // rather than `click` because a middle button never produces a `click`.
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose();
      }}
      onDoubleClick={onPromote}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // Roving tabindex: one stop for the whole strip, arrows move within it.
        tabIndex={active ? 0 : -1}
        title={ownerBadge === null ? title : `${ownerBadge.label} · ${title}`}
        onClick={onSelect}
        aria-label={ownerBadge === null ? label : `${label} (${ownerBadge.label})`}
        // `muted` is a terminal that has exited or a view still loading. It was
        // a strike-through on the name; with the name gone it dims the icon,
        // which says the same thing in the room a 34px column has.
        className={cn('grid size-6 place-items-center outline-none', muted === true && 'opacity-50')}
      >
        {icon}
        <span className="sr-only">{ownerBadge === null ? label : `${label} (${ownerBadge.label})`}</span>
      </button>
      {ownerBadge !== null ? (
        // Bottom-left, opposite the ✕'s corner, so the two marks cannot
        // collide. Presentational: the number is already in the button's
        // accessible name above.
        //
        // A pill on a hairline rather than a bare digit — the `.ob` badge from
        // docs/design/7d-full.html. At this size the ring is what separates
        // "whose tab is this" from a stray character in the icon beneath it.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 left-0 rounded-full border border-hairline bg-panel px-1 text-3xs leading-none tabular-nums text-ink-faint"
        >
          {ownerBadge.text}
        </span>
      ) : null}
      {ended === true ? (
        // The exited mark: a hollow dot where the owner badge would sit in the
        // scoped view. Decoration for the eye; the words live in the tooltip.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0.5 bottom-0.5 size-1.5 rounded-full border border-ink-faint"
        />
      ) : null}
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={onClose}
        className={cn(
          // `rounded-full`, because it now sits on a rounded tab: a square chip
          // pinned to a 6px corner reads as a corner that broke off.
          'absolute top-0 right-0 grid size-3.5 place-items-center rounded-full bg-panel text-ink-faint transition-opacity hover:bg-wash-strong hover:text-ink',
          /*
           * Pinned to the tab's top-right corner rather than sitting beside the
           * icon. A 34px column has no room for two targets in a row, and an ✕
           * that shrank the icon to fit would make the thing you aim at smaller
           * than the thing you rarely want.
           *
           * Chrome's rule otherwise, unchanged: the active tab always offers
           * its ✕, the others on hover — but *only* on hover here, because a
           * permanently-visible ✕ overlapping a 24px icon reads as part of it.
           * Focusable throughout: `opacity-0` hides it from the eye and
           * `focus-visible` brings it back for the keyboard.
           */
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          active && 'text-ink',
        )}
      >
        <XIcon className="size-2.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function PreviewTabButton({
  id,
  active,
  ownerBadge,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement | null {
  const preview = useApp((s) => s.previews.find((one) => one.id === id));
  if (preview === undefined) return null;

  return (
    <TabShell
      active={active}
      label={preview.title}
      title={preview.path}
      // The glyph says which of the two this is, which is also the difference
      // between what will and will not run. Kept from `PreviewPane`'s old header.
      icon={
        preview.kind === 'frame' ? (
          <SquareArrowOutUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <FileTextIcon className="size-3 shrink-0" aria-hidden="true" />
        )
      }
      onSelect={() => focusDockTab({ kind: 'preview', id })}
      onClose={() => closePreview(id)}
      closeLabel={`Close ${preview.title}`}
      ownerBadge={ownerBadge}
    />
  );
}

/**
 * The file a link in the transcript opened.
 *
 * Titled with the file's own name and captioned with its path, which is the same
 * pairing the preview tab uses — a strip full of `index.ts` is what you get from
 * titling these with anything longer, and the path is one hover away.
 *
 * Its ✕ is the preview's, not the terminal's: it drops a snapshot the renderer
 * is holding, and the link that opened it is still in the transcript.
 *
 * A transient tab — the conversation's follow-the-reading slot, which the next
 * file replaces — dims the way a settled tab does, and says so in the tooltip.
 * Double-click pins it, which is the gesture editors have taught for exactly
 * this promotion; the viewer's header carries the same action as a button.
 */
function FileTabButton({
  id,
  active,
  ownerBadge,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement | null {
  const file = useApp((s) => s.files.find((one) => one.id === id));
  if (file === undefined) return null;

  return (
    <TabShell
      active={active}
      label={file.title}
      title={file.pinned ? file.path : `${file.path} — transient; double-click to pin`}
      icon={<FileCodeIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'file', id })}
      onClose={() => closeFile(id)}
      onPromote={file.pinned ? undefined : () => pinFile(id)}
      closeLabel={`Close ${file.title}`}
      muted={!file.pinned}
      ownerBadge={ownerBadge}
    />
  );
}

function TerminalTabButton({
  id,
  active,
  ownerBadge,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement | null {
  const record = useApp((s) => s.terminals.find((terminal) => terminal.info.id === id));
  if (record === undefined) return null;

  return (
    <TabShell
      active={active}
      label={record.title}
      title={
        record.exited
          ? `${record.info.shell} · ${record.info.cwd} — exited`
          : `${record.info.shell} · ${record.info.cwd}`
      }
      icon={<TerminalIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'terminal', id })}
      onClose={() => closeTerminal(id)}
      closeLabel={`Close ${record.title}`}
      // A shell that has ended keeps its tab so its last words stay readable —
      // dimmed, and wearing the ended dot, so it is plain without a hover that
      // nothing is listening any more.
      muted={record.exited}
      ended={record.exited}
      ownerBadge={ownerBadge}
    />
  );
}

/**
 * A page's tab.
 *
 * Labelled by the page's title, which main falls back to the host for — so a
 * tab says `example.com` while a document is loading and its own name once it
 * has one, which is what a browser does and what keeps two of these apart.
 *
 * The title is page-authored text. It is capped in `main/browser.ts` and
 * rendered here as text, never as markup.
 */
function BrowserTabButton({
  id,
  active,
  ownerBadge,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement | null {
  const record = useApp((s) => s.browsers.find((browser) => browser.info.id === id));
  if (record === undefined) return null;

  const { title, url, loading } = record.info.state;
  const label = title.length > 0 ? title : 'New browser';

  return (
    <TabShell
      active={active}
      label={label}
      title={url.length > 0 ? url : 'No address yet'}
      icon={<GlobeIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'browser', id })}
      onClose={() => closeBrowser(id)}
      closeLabel={`Close ${label}`}
      // Dimmed while the page is on its way, which is the one piece of progress
      // this strip has room for — the address bar has the stop button.
      muted={loading}
      ownerBadge={ownerBadge}
    />
  );
}

/**
 * The one tab nobody opens, and the one whose ✕ costs nothing.
 *
 * Its label is the count, so the strip answers "is anything still running" while
 * the pane is shut — which is the question the transcript answered wrongly by
 * saying "delegated to 3 agents" in the past tense while they worked.
 *
 * The ✕ closes the view and leaves the work alone. That is worth saying plainly
 * because the two tabs to its left have taught the opposite: a preview's ✕
 * destroys the snapshot, a terminal's kills the shell. This pane owns nothing —
 * the rows live on the conversation, the subagents live in the provider — so
 * dismissing it is closer to collapsing a panel than to closing a document.
 * `closeTasks` writes down what was on screen so it stays shut; the next thing
 * delegated brings it back, the same way the first one did.
 */
/** The folder browser's tab. One per column, like the delegated list's. */
function FilesTabButton({
  paneId,
  active,
  ownerBadge,
}: {
  readonly paneId: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement {
  return (
    <TabShell
      active={active}
      label="Files"
      title="The working folder"
      icon={<FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'files', paneId })}
      onClose={() => closeFiles(paneId)}
      closeLabel="Close the folder browser"
      ownerBadge={ownerBadge}
    />
  );
}

/**
 * The documents list's tab. One per column, like the folder browser's, and
 * with the folder browser's ✕: it closes a view and drops nothing — every
 * document is still in the thread as a tile, and the list comes back on the
 * next press.
 */
function DocumentsTabButton({
  paneId,
  active,
  ownerBadge,
}: {
  readonly paneId: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement {
  return (
    <TabShell
      active={active}
      label="Documents"
      title="The documents this conversation made"
      icon={<FilesIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'documents', paneId })}
      onClose={() => closeDocuments(paneId)}
      closeLabel="Close the documents list"
      ownerBadge={ownerBadge}
    />
  );
}

function TasksTabButton({
  paneId,
  active,
  ownerBadge,
}: {
  readonly paneId: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement | null {
  // Two numbers rather than one object: a selector that allocates returns a new
  // identity every call, which zustand reads as a change and React resolves by
  // re-rendering for ever.
  const total = useApp((s) => taskCount(s, paneId));
  const live = useApp((s) => liveTaskCount(s, paneId));
  if (total === 0) return null;

  return (
    <TabShell
      active={active}
      label={live === 0 ? 'Delegated' : `${String(live)} running`}
      title={
        live === 0
          ? `${String(total)} finished task${total === 1 ? '' : 's'}`
          : `${String(live)} of ${String(total)} still running`
      }
      icon={<UsersIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'tasks', paneId })}
      onClose={() => closeTasks(paneId)}
      // "Hide" rather than "Close", because the ✕ beside it on a terminal ends a
      // process and this one ends nothing. The word is the only warning the user
      // gets before they click.
      closeLabel="Hide delegated work"
      // Nothing is running: the tab is a record rather than a readout, and it
      // reads as one.
      muted={live === 0}
      ownerBadge={ownerBadge}
    />
  );
}

/**
 * One agent's own conversation, opened from a row in the tab to its left.
 *
 * Named after the work rather than the agent type, because that is what the
 * user clicked: the row said "Audit scripts, CI, packaging" and the tab that
 * opens from it should say the same thing. The type — `Explore`, a workflow's
 * name — is in the row and in the transcript's own first turn.
 *
 * Its ✕ is the weakest in the strip: this tab owns nothing, not even a view of
 * something running. It is a read of a file, so closing it stops a poll and
 * nothing else. The agent keeps working, the row keeps its ⏹, and clicking the
 * row again reopens exactly this.
 */
function AgentTabButton({
  paneId,
  taskId,
  active,
  ownerBadge,
}: {
  readonly paneId: string;
  readonly taskId: string;
  readonly active: boolean;
  readonly ownerBadge: OwnerBadge | null;
}): ReactElement | null {
  const key = `${paneId}:${taskId}`;
  const title = useApp((s) => s.agentViews.find((one) => one.key === key)?.title);
  const live = useApp((s) => agentViewIsLive(s, key));
  if (title === undefined) return null;

  return (
    <TabShell
      active={active}
      label={title}
      title={live ? `${title} — still running` : `${title} — finished`}
      icon={<BotIcon className="size-3 shrink-0" aria-hidden="true" />}
      onSelect={() => focusDockTab({ kind: 'agent', paneId, taskId })}
      onClose={() => closeAgentTab(paneId, taskId)}
      closeLabel={`Close ${title}`}
      // Struck through once the agent has finished, the same way an exited
      // shell's tab is: the transcript is a record now rather than a readout.
      muted={!live}
      ownerBadge={ownerBadge}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The body                                                                   */
/* -------------------------------------------------------------------------- */

function DockBody({
  tabs,
  active,
}: {
  readonly tabs: readonly DockTab[];
  readonly active: DockTab | null;
}): ReactElement {
  const terminals = useApp((s) => s.terminals);
  const splits = useApp((s) => s.terminalSplits);
  const showPreview = active?.kind === 'preview';

  /*
   * Which terminals the split shows, when it shows any.
   *
   * Computed here with `useMemo` rather than in a store selector, because the
   * answer is an array and a selector that allocates returns a new identity
   * every call — the re-render-for-ever hazard `TasksTabButton` documents.
   * The inputs are the four stable store values this component already
   * subscribes to.
   *
   * The set is the active terminal's *conversation's* shells, in strip order,
   * capped at `MAX_SPLIT_TERMINALS` — T3's four, because a fifth cell in the
   * narrowest panel on screen is a porthole. Shells past the cap keep their
   * tabs and stay reachable one click away.
   */
  const splitIds = useMemo(() => {
    if (active?.kind !== 'terminal') return [];
    const mine = terminals.find((one) => one.info.id === active.id);
    if (mine === undefined) return [];
    const key = mine.owner.sessionId ?? mine.owner.paneId;
    if (!splits.includes(key)) return [];
    return tabs
      .filter((tab): tab is DockTab & { kind: 'terminal' } => tab.kind === 'terminal')
      .map((tab) => tab.id)
      .filter((id) => {
        const record = terminals.find((one) => one.info.id === id);
        return record !== undefined && (record.owner.sessionId ?? record.owner.paneId) === key;
      })
      .slice(0, MAX_SPLIT_TERMINALS);
  }, [active, terminals, splits, tabs]);

  const splitting = splitIds.length >= 2;

  return (
    <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
        The mockup's `.dh` over a shell: what this is, and whether it is
        alive — "zsh · artemis · live" (docs/design/7d-full.html). The strip's
        tab already knows both, but the tab is an icon now, and the panel is
        where a reader looks for "what am I looking at". No ✕ here: only the
        tab's ✕ ends a shell, and that rule predates this bar.
      */}
      {active?.kind === 'terminal'
        ? (() => {
            const mine = terminals.find((one) => one.info.id === active.id);
            if (mine === undefined) return null;
            return (
              <DockHeader className="gap-2">
                <span className="min-w-0 truncate text-2xs text-ink-muted">
                  {lastSegment(mine.info.shell)} · {lastSegment(mine.info.cwd)}
                </span>
                <span
                  className={cn(
                    'ml-auto shrink-0 font-mono text-2xs',
                    mine.exited ? 'text-ink-faint' : 'text-mint',
                  )}
                >
                  {splitting
                    ? `${String(splitIds.length)} live`
                    : mine.exited
                      ? 'ended'
                      : 'live'}
                </span>
              </DockHeader>
            );
          })()
        : null}
      {showPreview && active?.kind === 'preview' ? <PreviewPane id={active.id} /> : null}
      {/*
       * Keyed by the tab's id, so switching between two open files scrolls each
       * from where that file was left rather than inheriting the other's
       * position — and so the jump to a `:line` runs again when a link reopens
       * one that is already here.
       */}
      {active?.kind === 'file' ? <FileViewer key={active.id} id={active.id} /> : null}
      {active?.kind === 'files' ? <FilesPane paneId={active.paneId} /> : null}
      {active?.kind === 'documents' ? <DocumentsPane paneId={active.paneId} /> : null}
      {active?.kind === 'tasks' ? <TasksPane paneId={active.paneId} /> : null}
      {/*
       * Only the active one, unlike the terminals below. An agent tab holds no
       * live element to re-parent — its transcript lives in the store, not in
       * the DOM — so unmounting costs a re-render and keeps the poll in the one
       * tab the user is actually reading.
       */}
      {active?.kind === 'agent' ? (
        <AgentPane key={tabKey(active)} viewKey={`${active.paneId}:${active.taskId}`} />
      ) : null}
      {/*
       * One container for every terminal slot, so the split is a change of
       * *display* on an element whose children never move. `contents` when
       * tabbed — the slots behave as direct children of the panel column, as
       * they always did — and a grid when split. No xterm element is
       * re-parented either way; see the file header.
       *
       * Two shells stack (the dock is the narrowest panel on screen; side by
       * side they would be two portholes), three or four take the 2×2.
       */}
      <div
        className={cn(
          splitting
            ? 'grid min-h-0 min-w-0 flex-1 gap-px'
            : 'contents',
          splitting && splitIds.length === 2 && 'grid-rows-2',
          splitting && splitIds.length > 2 && 'grid-cols-2 grid-rows-2',
        )}
      >
        {tabs.map((tab) => {
          if (tab.kind !== 'terminal') return null;
          const record = terminals.find((one) => one.info.id === tab.id);
          if (record === undefined) return null;
          const shown = splitting
            ? splitIds.includes(tab.id)
            : active?.kind === 'terminal' && active.id === tab.id;
          return (
            <div
              key={tab.id}
              // `hidden` rather than unmounting: see the file header. An inactive
              // terminal keeps its element in this slot and simply stops being
              // painted, so switching tabs never re-parents a live xterm.
              hidden={!shown}
              className={cn(
                'min-h-0 min-w-0 flex-col',
                shown ? 'flex' : 'hidden',
                // Inside the split grid a cell must not `flex-1` against the
                // column — the grid owns the sizing.
                shown && !splitting && 'flex-1',
              )}
            >
              <TerminalView id={record.info.id} />
            </div>
          );
        })}
      </div>
      {/*
       * Mounted for every browser, like the terminals above, and for a stronger
       * version of the same reason. A terminal that unmounted would re-parent a
       * live xterm; a browser that unmounted would tell main to detach the view
       * and lose the rectangle, so the page would vanish on every tab switch
       * and come back a frame late at the wrong size.
       *
       * `visible` is what does the hiding, and it goes to main rather than to
       * CSS: a native view is composited above this document, so `hidden` on
       * this element would leave the page painted over an empty pane.
       */}
      {tabs.map((tab) => {
        if (tab.kind !== 'browser') return null;
        const shown = active?.kind === 'browser' && active.id === tab.id;
        return (
          <div
            key={tab.id}
            className={cn('min-h-0 min-w-0 flex-1 flex-col', shown ? 'flex' : 'hidden')}
          >
            <BrowserPane id={tab.id} visible={shown} />
          </div>
        );
      })}
    </div>
  );
}
