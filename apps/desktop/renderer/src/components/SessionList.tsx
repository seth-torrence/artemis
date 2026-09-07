/**
 * Every session, grouped by the project it ran in.
 * ============================================================================
 *
 *                               [ filter… ]
 *     ▾ ▪ artemis                        22
 *      ┌──────────────────────────────────┐
 *      │  Wire the adapter seam           │  ← open: a wash, no edge
 *      │  ⌥ main · ▪ Work                 │
 *      └──────────────────────────────────┘
 *     ▸ ▪ api                             9
 *     ▾ ▪ cli                             3
 *         Profile store encryption
 *         ▪ Home
 *
 * Every project, in name order, holding still. Every session inside one, newest
 * first.
 *
 * The list was once scoped to the working directory, with everything else behind
 * an "All projects" switcher, because an undifferentiated stream of every
 * repository buried the answer to "what was I doing in *this* repo". That fixed
 * the wrong half: scoping made the other question — "where was that session I
 * had open yesterday?" — unanswerable without first guessing the folder it was
 * in and switching to it, which meant changing directory, which ends the current
 * session. History you have to destroy your place to look at is not history you
 * can browse.
 *
 * The two levels sort differently because they answer different questions, and
 * the headings sorted by recency for a while on the assumption that they were
 * the same question. *Which project* is navigation, and navigation wants
 * furniture: a name, in the order anyone would guess, moving only when a project
 * is added or goes away. Sorting those by recency meant every prompt in any
 * project rewrote the whole sidebar, so the heading someone was reaching for
 * slid out from under the pointer. *Which session inside it* is recency, because
 * within one project the row you want is nearly always the one you touched last.
 * See `sessionGroups.ts`, which owns both rules.
 *
 * Clicking any row does the whole switch — provider, profile, directory and
 * transcript — because `resumeSession` already had to: a session id only
 * resolves against the directory it ran in. Crossing a project boundary from
 * here was always going to work; it was only ever the list that hid the rows.
 *
 * ## 0. Each project is its own fold, and there is no title over them
 *
 * There was a `SESSIONS` caption here once, and later the current repository's
 * name; both sat over a single fold for the entire list. The repository name
 * became a lie the moment the list held every project, and the fold answered a
 * question nobody has — "hide all my history at once" — while the one people do
 * have, "put *that* project away", had no control at all.
 *
 * So the fold is gone from here and each group heading folds its own project.
 * The filter has the row to itself.
 *
 * A `Sessions` caption is back in the shell refresh, and it is not the same
 * thing: it sits in `Sidebar` over the *column*, naming what the column is
 * beside a rail that offers other views, and its chevron collapses the column
 * rather than folding the list. What was wrong before was a caption that
 * folded everything below it; what is right now is a caption that says which
 * view you are in. See `docs/design/_layout.md` item 1.
 *
 * A group is a *project*, not a directory. Working in
 * `~/code/artemis/apps/desktop` you are working on *artemis*, and a session
 * split off into `~/code/artemis/.claude/worktrees/some-branch` is still work on
 * artemis — a heading reading "desktop", or a repository called "some-branch"
 * that the sidebar has never mentioned before and that takes those sessions out
 * of the project they belong to, is technically true and useless.
 *
 * The renderer has no `fs`, so the main process is asked once per directory —
 * see `projectRoots` in the store, which holds the answers and is what the
 * grouping keys on. Until an answer lands a session groups by its own directory,
 * which is what this list did before projects existed.
 *
 * The folds are persisted, per directory. A section the user closed and found
 * reopened on the next launch is the same discourtesy as a sidebar width that
 * resets. See `collapsedProjects` in the store for why the stored list is of
 * the *shut* projects rather than the open ones.
 *
 * ## 0b. Pinned sits above the projects, and only when it holds something
 *
 * A pinned session leaves its project for a section at the very top of the list,
 * the mirror of what archiving does at the bottom. Marking the row in place
 * instead would have been cheaper and useless: the point of pinning the session
 * you keep coming back to is not to decorate it, it is to stop hunting for it,
 * and a marked row is still wherever its project happened to sort to.
 *
 * The section is absent — not empty — until something is in it, so a sidebar
 * nobody has pinned anything in looks exactly as it always did. It is open by
 * default, where the archive is shut, because pinning is a request to keep
 * something in view. See `pinnedSessions` and `pinnedCollapsed` in the store.
 *
 * ## 0c. The row's menu answers to four letters
 *
 * `R`ename, `P`in, `A`rchive, `D`elete, each drawn as a key cap on the right of
 * its item, live while the menu is open. The whole of that feature is
 * `pressHotkey` plus a `data-hotkey` per item: the letter finds the item and
 * clicks it, so it cannot drift from what the mouse does. See `MenuAction`.
 *
 * ## 1. It is virtualised, over two row heights
 *
 * History runs to hundreds of rows, and mounting all of them costs a visible
 * hitch every time the list refreshes — which happens at the end of every run.
 * So rows are absolutely positioned inside a spacer of the full height and only
 * the slice inside the viewport (plus overscan) is mounted.
 *
 * Headings are shorter than session rows, so an offset is no longer
 * `index * ROW_HEIGHT`. Row starts are accumulated once per change of the row
 * array and the visible window is a binary search over them — see `indexAt`.
 * What is deliberately *not* back is the second copy of each heading pinned to
 * the top of the viewport to fake `position: sticky` inside an absolutely
 * positioned list. A heading you have scrolled past belongs to the rows you are
 * already reading; it did not earn its bookkeeping.
 *
 * ## 2. `ROW_HEIGHT` is a constant, and it is not arbitrary
 *
 * A row is two lines: a 12px title on an 18px leading and an 11px meta line on
 * a 16px leading, 2px apart — 36px of text. Add the button's 12px of vertical
 * padding and the 4px gap between rows and you get 52; 54 leaves two pixels of
 * slack. The meta line lost its timestamp and its terminal glyph and gained a
 * colour swatch, none of which changes its height — the line box is set by the
 * 11px type, and the swatch is 8px. Getting this wrong is not cosmetic: a row
 * that is *slightly* too short
 * squeezes the flex children, and because the title also carries `truncate`
 * (`overflow: hidden`) the glyphs are then clipped horizontally through the
 * middle. That was a real, shipped bug — the title line was being compressed
 * from 18px to 12px and every session title was sliced. Both lines now carry
 * `shrink-0`, so even if this arithmetic goes stale the text will overflow
 * visibly rather than be quietly cut in half.
 *
 * ## 3. Rows take primitives, so `memo` actually works
 *
 * A row's position is passed as a number, not as a `style` object. An object
 * literal is a new identity every render, which would defeat `memo` on every
 * row on every scroll frame — the exact opposite of the point.
 *
 * ## 4. It never subscribes to the transcript
 *
 * Streaming text lives in an external store React does not see (see
 * `state/transcript.ts`), and nothing here reads it. Scroll state is local. The
 * sidebar is therefore invisible to a `text.delta`, which is the property the
 * whole layout depends on: adding a persistent pane must not put a re-render on
 * the hot path.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  InboxIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ProfileId, SessionSummary } from '@rx-artemis/protocol';

import { useCapability, useProviderCapability } from '../hooks/useCapability';
import { condenseTitle, formatRelative } from '@rx-artemis/transcript';
import { lastSegment } from '../lib/paths';
import {
  flattenGroups,
  groupSessionsByProject,
  orderSessions,
  partitionSessions,
  sessionKey,
  type ListRow,
} from '../lib/sessionGroups';
import { writeSessionDrag } from '../lib/sessionDrag';
import {
  canReachSession,
  refreshSessions,
  renameSession,
  resumeSession,
  sessionOrderKey,
  toggleArchivedExpanded,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleSessionArchived,
  toggleSessionPinned,
  useApp,
} from '../state/store';
import { usePane } from '../state/paneContext';
import { ReasonButton } from './disabled-reason';
import { ProfileSwatch, StatusDot } from './primitives';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { ProjectTooltip, SessionTooltip } from './SessionTooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** See note 2 in the file header before changing this. */
const ROW_HEIGHT = 54;
/**
 * A group heading's row height.
 *
 * One 11px line on a 16px leading, with 4px of air above and below. Deliberately
 * much shorter than a session row: a heading is a divider with a word on it, and
 * at row height it would read as an unclickable entry in the list.
 */
const HEADER_HEIGHT = 24;
/** Rows kept mounted beyond each edge, so a fast flick does not show gaps. */
const OVERSCAN = 6;
/**
 * Viewport height assumed before the first measurement.
 *
 * `clientHeight` is zero on the very first paint and under jsdom, and a
 * zero-height viewport would render zero rows. Guessing tall is the safe
 * direction: the worst case is a few extra rows for one frame.
 */
const ASSUMED_VIEWPORT = 720;
/** Below this many sessions, scanning beats typing and the field is clutter. */
const FILTER_THRESHOLD = 8;

export function SessionList(): ReactElement {
  const sessions = useApp((s) => s.sessions);
  const loading = useApp((s) => s.sessionsLoading);
  const error = useApp((s) => s.sessionsError);
  const profiles = useApp((s) => s.profiles);
  const collapsedProjects = useApp((s) => s.collapsedProjects);
  const archivedSessions = useApp((s) => s.archivedSessions);
  const archivedExpanded = useApp((s) => s.archivedExpanded);
  const pinnedSessions = useApp((s) => s.pinnedSessions);
  const pinnedCollapsed = useApp((s) => s.pinnedCollapsed);
  const listing = useCapability('listSessions');

  const [query, setQuery] = useState('');

  const profileLabel = useCallback(
    (id: ProfileId): string | undefined => profiles.find((p) => p.id === id)?.label,
    [profiles],
  );

  /*
   * Every project, grouped, in name order; every session inside one, newest
   * first.
   *
   * `groupSessionsByProject` owns the query matching, both orders and the id
   * tie-break, and it is the part of this feature that has tests — filtering
   * here instead would quietly fork all four.
   */
  const collapsed = useMemo(() => new Set(collapsedProjects), [collapsedProjects]);
  const archivedKeys = useMemo(() => new Set(archivedSessions), [archivedSessions]);
  const pinnedKeys = useMemo(() => new Set(pinnedSessions), [pinnedSessions]);

  /*
   * A worktree's sessions belong to the repository it was split off from.
   *
   * `projectRoots` holds only the directories that group somewhere else — a
   * worktree, a subdirectory of a checkout — so this is the identity function
   * for everything else and for every directory whose answer has not landed
   * yet. See the field in the store for why the map is that shape.
   */
  const projectRoots = useApp((s) => s.projectRoots);
  const projectOf = useCallback((cwd: string) => projectRoots[cwd], [projectRoots]);

  /*
   * Rows hold their place while their agent is working.
   *
   * `updatedAt` is the transcript file's mtime, and the feed re-reads it every
   * four seconds while anything is live, so ordering several working sessions by
   * it made the list trade places under the pointer. `sessionOrderHold` pins each
   * one where it was when its run started; see the field for the whole story.
   */
  const hold = useApp((s) => s.sessionOrderHold);
  const orderKey = useCallback(
    (session: SessionSummary) => sessionOrderKey(session, hold),
    [hold],
  );

  /*
   * Pinned and archived sessions are both lifted out *before* grouping, so they
   * leave their project rather than changing colour inside it — a project whose
   * every session has been archived disappears from the list entirely, which is
   * the point of putting them away, and a pinned session is at the top of the
   * sidebar rather than wherever its project happens to have sorted to.
   *
   * Both sections are filtered by the same query as everything else, so a search
   * still finds what you pinned and what you put away.
   */
  const rows = useMemo(() => {
    const split = partitionSessions(sessions, { pinned: pinnedKeys, archived: archivedKeys });
    return flattenGroups(
      groupSessionsByProject(split.active, { query, profileLabel, orderKey, projectOf }),
      collapsed,
      {
        pinned: {
          sessions: orderSessions(split.pinned, { query, profileLabel, orderKey }),
          collapsed: pinnedCollapsed,
        },
        archived: {
          sessions: orderSessions(split.archived, { query, profileLabel, orderKey }),
          collapsed: !archivedExpanded,
        },
      },
    );
  }, [
    sessions,
    query,
    profileLabel,
    orderKey,
    projectOf,
    collapsed,
    archivedKeys,
    archivedExpanded,
    pinnedKeys,
    pinnedCollapsed,
  ]);

  /** Unfiltered, so the count does not jump around while typing. */
  const total = sessions.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-hairline">
      {/*
       * The filter is the only thing left on this row. A "Sessions" title sat
       * here, folding the whole list from one control — a caption for a list
       * whose contents are obvious, over a fold that answered the wrong
       * question. Folding is per project now, on the group headings, which is
       * the level anyone actually wants to put away.
       */}
      {total > FILTER_THRESHOLD ? (
        <div className="px-1.5 pt-2 pb-1.5">
          <div className="relative min-w-0">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            {/*
              The Console field: `rounded-lg`, a hairline-strong edge and a
              wash ground. Height is untouched — this is a 24px field in a
              224px column and the shape is the only thing the language
              changes. The wash is stated rather than inherited because
              `Input`'s own ground is `dark:bg-input/30`, an alpha of the
              *border* token, which is not a fill in this vocabulary.
            */}
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter…"
              aria-label="Filter sessions"
              spellCheck={false}
              className="h-6 rounded-lg border-hairline-strong bg-wash pl-6.5 text-2xs md:text-2xs dark:bg-wash"
            />
          </div>
        </div>
      ) : (
        <div className="pt-1.5" />
      )}

      <>
        {/*
         * The capability note sits *above* the rows rather than replacing
         * them, and never empties the list.
         *
         * `listSessions` used to blank it: selecting an account whose CLI
         * cannot enumerate history removed every other provider's sessions
         * from the screen too. That was the wrong scope. This list spans
         * providers, so the capability of the one currently selected decides
         * what is *missing* from it, not whether there is anything to show —
         * and the sentence says exactly that much.
         *
         * A `resumeSession` banner used to hang beneath this one, and it was
         * the same wrong scope one step further: it declared every row
         * unclickable because the *active* provider could not resume, when
         * each row resumes under its own. Selecting a llama.cpp profile
         * turned the whole sidebar off. The rows now gate themselves on the
         * provider they actually belong to, which leaves nothing true for a
         * blanket banner to say.
         */}
        {!listing.supported ? (
          <p className="border-y border-hairline bg-wash px-2.5 py-1.5 text-2xs leading-snug text-ink-muted">
            {listing.reason} Its own sessions are not in this list; everything below belongs to the
            other accounts.
          </p>
        ) : null}

        {error ? (
          <Note tone="signal">
            {/* The backend's own sentence — a paraphrase would lose the cause. */}
            {error}
            <button
              type="button"
              onClick={() => void refreshSessions()}
              className="mt-1 block text-2xs text-beam-text underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </Note>
        ) : loading && sessions.length === 0 ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <NothingHere filtered={total > 0} query={query} />
        ) : (
          <VirtualRows rows={rows} />
        )}
      </>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Group headings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One project's heading, and the control that folds it.
 *
 * ## The fold lives here, not over the whole list
 *
 * There was a `Sessions` title above the list with a single fold on it. It was a
 * caption for a list whose contents are obviously sessions, and its fold
 * answered a question nobody has — "hide all my history at once" — while the one
 * people do have, "put *that* project away", had no control at all. So the title
 * is gone and every project folds independently.
 *
 * The whole row is the control rather than a chevron beside a label, because a
 * 10px target next to a word that looks clickable and is not is the kind of
 * thing people click three times before reading. The chevron is the
 * *affordance*; `aria-expanded` says the same thing to a screen reader.
 *
 * ## The count is the project's, not the visible rows'
 *
 * It stays put when the group is folded — that is the number worth reading while
 * it is shut, and it is why folding a project does not make it look empty. It is
 * also unfiltered, so it does not count down while someone types in the filter.
 *
 * Rendered as an ordinary row rather than a `position: sticky` element: the rows
 * are absolutely positioned inside a spacer, where sticky does not apply, and
 * faking it needs a second pinned copy of the heading plus the bookkeeping to
 * know which one it is. That was in this file once and is not worth its weight.
 */
const GroupHeading = memo(function GroupHeading({
  project,
  count,
  collapsed,
  top,
}: {
  readonly project: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly top: number;
}): ReactElement {
  /*
   * Is the focused column inside this project? `usePane` outside a column
   * resolves to the focused one, so the heading marks the project the header is
   * naming.
   *
   * Through `projectRoots`, not by comparing directories: a column working in a
   * worktree of this repository is in this project, and that is the whole point
   * of grouping them together. See the field in the store.
   */
  const cwd = usePane((s) => s.cwd);
  const current = useApp((s) => (s.projectRoots[cwd] ?? cwd) === project);

  const name = projectLabel(project);

  /*
   * The heading's tooltip was `title={project}` — the one hover surface in the
   * sidebar the app did not draw itself. It now uses the same bubble as the
   * session rows (`ProjectTooltip`), which is what lets a root deep in a
   * worktree wrap instead of running past the edge. A heading with no project
   * has nothing to add to its own label, so it gets no tooltip at all rather
   * than a bubble restating "No project".
   */
  const heading = (
    <button
      type="button"
      onClick={() => toggleProjectCollapsed(project)}
      aria-expanded={!collapsed}
      className="flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-wash"
    >
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          'size-2.5 shrink-0 text-ink-faint transition-transform',
          collapsed && '-rotate-90',
        )}
      />
      {/*
        One folder, drawn the same way in every heading.
        ------------------------------------------------------------------
        Both the glyph and its colour used to turn on whether this was the
        directory you were standing in, and the glyph did so invisibly: the
        repository variant was chosen from `workspace`, which described only
        the directory the column was standing in, so "is a git repo" and "is
        the active project" were the same condition wearing different clothes.
        A project's icon would silently change shape as you moved away from
        it, which says something about the project that is not true.

        So it is one folder at one weight throughout. The active project is
        still marked — by the label beside this, which is a claim about
        which project you are in rather than about what kind of thing it is.
      */}
      <FolderIcon aria-hidden="true" className="size-2.5 shrink-0 text-beam-text" />
      <span
        className={cn(
          'chrome-label min-w-0 truncate',
          current ? 'text-ink-muted' : 'text-ink-faint',
        )}
      >
        {name ?? 'No project'}
      </span>
      <GroupCount count={count} />
    </button>
  );

  return (
    <div style={{ top, height: HEADER_HEIGHT }} className="absolute inset-x-0 px-1.5">
      {name === null ? (
        heading
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{heading}</TooltipTrigger>
          <TooltipContent side="right">
            <ProjectTooltip project={project} count={count} />
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});

/**
 * The Pinned section's heading, above every project.
 *
 * Same shape as {@link GroupHeading} and {@link ArchiveHeading} — it is a fold
 * with a word on it — and, like the archive's, deliberately not the same
 * component: it names no directory and marks no current project, because it
 * spans all of them.
 *
 * It exists only while something is pinned. `flattenGroups` emits no row for an
 * empty section, so an untouched sidebar looks exactly as it did before pinning
 * was added rather than growing a permanent "Pinned · 0" — a heading for a
 * folder you have put nothing in is furniture that teaches nothing.
 *
 * The pin is `text-beam-text`, the accent this list already uses to mark the active
 * project, rather than the archive's `text-ink-faint`. The two sections are
 * opposite claims and should not be the same weight: one is the shelf you put
 * things on to keep seeing them, and drawing it in the colour of what has been
 * put away would say the reverse.
 */
const PinnedHeading = memo(function PinnedHeading({
  count,
  collapsed,
  top,
}: {
  readonly count: number;
  readonly collapsed: boolean;
  readonly top: number;
}): ReactElement {
  return (
    <div style={{ top, height: HEADER_HEIGHT }} className="absolute inset-x-0 px-1.5">
      <button
        type="button"
        onClick={() => togglePinnedCollapsed()}
        aria-expanded={!collapsed}
        title="Sessions you have kept in front of you, from every project."
        className="flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-wash"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 text-ink-faint transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        <PinIcon aria-hidden="true" className="size-2.5 shrink-0 text-beam-text" />
        <span className="chrome-label min-w-0 truncate text-ink-muted">Pinned</span>
        <GroupCount count={count} />
      </button>
    </div>
  );
});

/**
 * The Archived section's heading.
 *
 * Built to the same shape as {@link GroupHeading} so the two read as one list
 * rather than as a list plus an appendix, but deliberately not the same
 * component: it names no directory, marks no current project, and folds on its
 * own preference rather than on `collapsedProjects` — see `archivedExpanded`
 * for why the polarity differs.
 */
const ArchiveHeading = memo(function ArchiveHeading({
  count,
  collapsed,
  top,
}: {
  readonly count: number;
  readonly collapsed: boolean;
  readonly top: number;
}): ReactElement {
  return (
    <div style={{ top, height: HEADER_HEIGHT }} className="absolute inset-x-0 px-1.5">
      <button
        type="button"
        onClick={() => toggleArchivedExpanded()}
        aria-expanded={!collapsed}
        title="Sessions you have put away. Still on disk, still resumable."
        className="flex h-full w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-wash"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 text-ink-faint transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        <ArchiveIcon aria-hidden="true" className="size-2.5 shrink-0 text-ink-faint" />
        <span className="chrome-label min-w-0 truncate text-ink-faint">Archived</span>
        <GroupCount count={count} />
      </button>
    </div>
  );
});

/**
 * How many sessions the group holds, at the far end of its heading.
 *
 * Right-aligned and on its own, which is the Console language's `.grp .ct`
 * (`margin-left: auto`, muted, regular weight). What it replaced was `·22`
 * hard against the project's name with a hairline rule running out to the
 * edge — a mid-dot doing the work of a gap, and a rule drawn *because* the
 * count had nowhere else to be. Pushing the number to the end gives every
 * heading one column of counts to read down, and the rule has nothing left to
 * separate.
 *
 * `tabular-nums` stays and `font-mono` goes: this is chrome, and mono in this
 * vocabulary means the machine produced the string. Lining figures are what
 * keep a column of counts from wobbling, and the sans face has them.
 *
 * The leading space is load-bearing and invisible, in that order. The heading
 * is a button, so its text *is* its accessible name, and the mid-dot was the
 * only thing keeping "artemis" and "22" from being announced as "artemis22".
 * A space says the same thing better and costs nothing on screen: leading
 * whitespace at the start of a line box is dropped in layout, so the number
 * still sits flush against the heading's trailing edge.
 */
function GroupCount({ count }: { readonly count: number }): ReactElement {
  return (
    <span className="chrome-label ml-auto shrink-0 tabular-nums text-ink-faint">
      {` ${String(count)}`}
    </span>
  );
}

/**
 * What to call this project.
 *
 * The last segment of its root, which *is* the repository's name: a group is
 * keyed on the checkout the sessions belong to, so `~/code/artemis` and every
 * worktree of it arrive here as `~/code/artemis` and read as "artemis". Before
 * the project resolves — a build with no `workspace.describe`, or the moment
 * before the first reply lands — the key is the session's own directory and
 * this names that instead, which is what the heading always used to show.
 *
 * `null` means there is no working directory at all, which is a different thing
 * from an unnamed one and is rendered as its own faint placeholder state.
 *
 * It no longer takes the pane's `WorkspaceNames`, and both of the fields it used
 * to prefer were wrong here once worktrees group under their repository: that
 * description is of the *place* the column is standing in, so a column inside a
 * worktree would have retitled this heading after the worktree — the exact
 * split the grouping exists to undo. It also only ever described the current
 * directory, which is why every other heading fell back to this line anyway.
 */
function projectLabel(project: string): string | null {
  if (project.trim().length === 0) return null;
  return lastSegment(project);
}

/* -------------------------------------------------------------------------- */
/* Virtualiser                                                                */
/* -------------------------------------------------------------------------- */

function VirtualRows({ rows }: { readonly rows: readonly ListRow[] }): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A filter keystroke — or a project switch — can leave the scroller parked
  // past the end of a much shorter list, which would show an empty window until
  // the user scrolled.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || element.scrollTop === 0) return;
    if (element.scrollTop > element.scrollHeight - element.clientHeight) {
      element.scrollTop = 0;
      setScrollTop(0);
    }
  }, [rows]);

  /*
   * Where every row starts, and where the list ends.
   *
   * Two row heights means an offset is no longer `index * ROW_HEIGHT`, so the
   * starts are accumulated once per change of `rows` and the window is found by
   * binary search over them. `offsets` has one extra entry — the end of the last
   * row — so `offsets[i + 1]` is always the bottom of row `i` and the total
   * height is the final element, with no special case for an empty list.
   */
  const offsets = useMemo(() => {
    const starts = new Array<number>(rows.length + 1);
    let y = 0;
    for (let i = 0; i < rows.length; i += 1) {
      starts[i] = y;
      const kind = rows[i]?.kind;
      y += kind === 'session' ? ROW_HEIGHT : HEADER_HEIGHT;
    }
    starts[rows.length] = y;
    return starts;
  }, [rows]);

  const height = viewport > 0 ? viewport : ASSUMED_VIEWPORT;
  const total = offsets[rows.length] ?? 0;

  const first = Math.max(0, indexAt(offsets, scrollTop) - OVERSCAN);
  const last = Math.min(rows.length - 1, indexAt(offsets, scrollTop + height) + OVERSCAN);

  const visible: ReactElement[] = [];
  for (let i = first; i <= last; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const top = offsets[i] ?? 0;
    if (row.kind === 'header') {
      visible.push(
        <GroupHeading
          key={row.key}
          project={row.project}
          count={row.count}
          collapsed={row.collapsed}
          top={top}
        />,
      );
      continue;
    }
    if (row.kind === 'pinned-header') {
      visible.push(
        <PinnedHeading key={row.key} count={row.count} collapsed={row.collapsed} top={top} />,
      );
      continue;
    }
    if (row.kind === 'archive-header') {
      visible.push(
        <ArchiveHeading key={row.key} count={row.count} collapsed={row.collapsed} top={top} />,
      );
      continue;
    }
    // `row.key` is `sessionKey` — an id is unique inside the profile that owns
    // it, not globally, and two profiles surfacing the same id would collide
    // into one React key and silently drop a row.
    visible.push(
      <Row
        key={row.key}
        top={top}
        session={row.session}
        pinned={row.pinned ?? false}
        archived={row.archived ?? false}
      />,
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
    >
      <div className="relative" style={{ height: total }}>
        {visible}
      </div>
    </div>
  );
}

/**
 * Index of the row containing `y`.
 *
 * Binary search for the last start at or before `y`. Clamped to a real index at
 * both ends: `y` below the first row and `y` past the last are both routine —
 * overscan asks for offsets outside the list on purpose — and the caller clamps
 * again against `rows.length`.
 */
function indexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  // `offsets` carries a trailing end-of-list entry, which is not a row.
  let high = offsets.length - 2;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low);
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

const Row = memo(function Row({
  session,
  top,
  pinned,
  archived,
}: {
  readonly session: SessionSummary;
  readonly top: number;
  readonly pinned: boolean;
  readonly archived: boolean;
}): ReactElement {
  /*
   * "Open in *a* column", not "open in the focused one".
   *
   * With the window split, the same session can be showing on either side, and
   * a row that only lit up for the focused column would go dark the moment the
   * user clicked into the other one — the row would stop marking a session that
   * is plainly on screen. So this asks the question the user is actually
   * asking: is this open anywhere?
   *
   * Read off `openSessions` rather than computed from the panes, for the same
   * reason `running` below reads `runningSessions`: which session a column is
   * showing is a fact about a *pane's* store, and this component subscribes to
   * the window's. This line used to reach across the two — `allPanes(s).some(p
   * => paneState(p).resumeSessionId === session.id)` — which React had no way
   * to invalidate, so the mark appeared only when an unrelated window write
   * forced a repaint, and the id it compared was the wrong one for a session
   * that had not finished its first turn. See `syncOpenSessions`.
   */
  const active = useApp((s) => s.openSessions.includes(session.id));
  /*
   * Working, whether or not it is on screen.
   *
   * A conversation the user walked away from keeps running — see
   * `AppState.background` — and this row is then the only place it exists in the
   * UI. Without the marker, an agent halfway through a refactor looks exactly
   * like a transcript that finished last Tuesday, and the user has no way to
   * know there is anything to come back to.
   *
   * Read off `runningSessions` rather than computed from the panes, because run
   * state lives in a store this component does not subscribe to. See
   * `syncRunningSessions`.
   */
  const running = useApp((s) => s.runningSessions.includes(session.id));
  /*
   * Waiting outranks running, and that ordering is the whole point of drawing
   * two colours instead of one.
   *
   * A running conversation needs nothing from anybody — the dot is a courtesy.
   * A waiting one has stopped and will stay stopped until someone answers it,
   * and the sidebar is the only place that fact is visible when the pane is not
   * on screen. `activityOf` already ranks them this way at the foot of the
   * transcript; the two must not disagree about what a conversation is doing.
   */
  const waiting = useApp((s) => s.waitingSessions.includes(session.id));
  const profile = useApp((s) => s.profiles.find((p) => p.id === session.profileId));
  /*
   * Asked of the *session's* provider, never the column's active one.
   *
   * Every control on this row acts on the conversation under
   * `session.providerId` — resuming switches the column to it, rename, delete
   * and archive write to its store — so the provider whose capabilities govern
   * is the row's, whatever the column is currently pointed at. Gating on the
   * active provider is how selecting a llama.cpp profile disabled the entire
   * sidebar: llama.cpp cannot resume a session, and none of these rows was
   * asking it to.
   */
  const resuming = useProviderCapability(session.providerId, 'resumeSession');
  const renaming = useProviderCapability(session.providerId, 'renameSession');
  const deleting = useProviderCapability(session.providerId, 'deleteSession');
  const tagging = useProviderCapability(session.providerId, 'tagSession');

  /*
   * Whether this row is allowed to name an account at all.
   *
   * Set when the transcript lives in a store several profiles reach and nothing
   * recorded which one ran it — the shared-config arrangement, where
   * `projects/` is symlinked into every profile. `session.profileId` is then
   * the adapter's stable pick among the sharers and means nothing, so naming it
   * would print the same account on every shared row. The sidebar's account
   * marker exists to answer "whose is this", and the honest answer here is
   * nothing rather than the first profile in the list.
   *
   * It clears itself: opening the session records the account it was opened
   * under, so the badge appears from the next listing onward. See
   * `SessionSummary.profileIsUnknown`.
   */
  const unattributed = session.profileIsUnknown === true;
  /*
   * A session no existing profile can reach cannot be resumed at all — its
   * transcript lives in a config directory nothing points at any more. Say so
   * on the row rather than letting the click fail somewhere the user is not
   * looking.
   *
   * Asked of every profile that shares the store, not just the one on the
   * summary. With `projects/` shared, deleting the profile the adapter happened
   * to pick leaves the transcript exactly where it was and two other accounts
   * still reading it; treating that row as orphaned would disable a resume that
   * works.
   */
  const orphaned = useApp((s) => !s.profiles.some((p) => canReachSession(session, p.id)));

  /*
   * Two pieces of row-local UI state, and both are deliberately here rather
   * than in the store.
   *
   * `editing` is a text field that exists for a few seconds; `confirming` is a
   * dialog answering one question about one row. Neither is a fact about the
   * application — putting either in the store would make every row re-render
   * when any row started an edit, on a list that is virtualised precisely to
   * avoid that.
   */
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  /*
   * The rename field replaces the whole row, not just its first line.
   *
   * Overlaying an input on top of the button would leave a resume click live
   * underneath it — the row's own click handler is what the user is trying to
   * type inside. Swapping the row out means there is nothing behind the field
   * to hit by accident, and the row comes back the moment the edit ends.
   */
  if (editing) {
    return (
      <div style={{ top, height: ROW_HEIGHT }} className="absolute inset-x-0 px-2 py-0.5">
        <RenameField session={session} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div
      style={{ top, height: ROW_HEIGHT }}
      className="absolute inset-x-0 px-2 py-0.5"
      /*
       * The drag source for the split, and it is the outermost wrapper rather
       * than the button or the context-menu trigger inside it.
       *
       * A `<button draggable>` is a fight: the element already owns pointer
       * gestures for its own activation, and browsers differ on whether a drag
       * that starts on one suppresses the click. The trigger is no better — it
       * owns the right-button gesture. Hanging the drag on the positioning
       * wrapper the row already has costs nothing, drags the whole row, and
       * leaves both the click and the context menu exactly as they were.
       *
       * An orphaned session is not draggable, for the same reason its button is
       * disabled and its menu items are: there is nowhere it could be opened.
       */
      draggable={!orphaned}
      onDragStart={(event) => {
        if (orphaned) {
          event.preventDefault();
          return;
        }
        writeSessionDrag(event.dataTransfer, session);
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="h-full w-full">
      <ReasonButton
        variant="ghost"
        disabled={orphaned || !resuming.supported}
        disabledReason={
          orphaned
            ? 'No profile still points at the config directory holding this session, so its transcript cannot be reached.'
            : resuming.supported
              ? undefined
              : resuming.reason
        }
        /*
         * Everything the two truncated lines cannot afford to show — the whole
         * title, the directory, the branch, the account, the model, the
         * timestamp the meta line evicted. It was a dash-joined sentence here
         * once, and the sentence is what issue #85 was about: a working
         * directory is one unbroken token, and it walked straight out of the
         * bubble. `SessionTooltip` is the card that replaced it, and it owns
         * the wrapping.
         */
        tooltip={<SessionTooltip session={session} profile={profile} running={running} />}
        tooltipSide="right"
        onClick={() => resumeSession(session)}
        /*
         * Selection is a fill, not an edge.
         *
         * The open row used to carry a 2px beam border down its leading side
         * with a raised ground behind it — two marks for one fact, and the
         * border was the louder of the pair on a row whose own text is 12px.
         * Console marks the chosen thing by *ground*: `bg-wash-strong` and the
         * title in full ink, the same pair the dock's scope buttons use, so a
         * selected row and a selected tab are recognisably one idea. Dropping
         * the border also takes the 2px indent off the leading edge, which is
         * what let the title start on the same vertical rule as its heading.
         *
         * The hover wash is spelled twice because `ghost` sets
         * `dark:hover:bg-muted/50`, and a `.dark`-scoped selector outranks a
         * bare `hover:` no matter which order Tailwind emits them in.
         *
         * `rounded-md` rather than `lg`: the rows are the many, and the one
         * control here that starts something — New session, one row up in
         * `Sidebar` — keeps the larger radius to itself.
         */
        className={cn(
          'h-full w-full flex-col items-start justify-center gap-0.5 rounded-md px-2 py-1.5 text-left font-normal hover:bg-wash dark:hover:bg-wash',
          active && 'bg-wash-strong text-ink',
          // Put away, and it should look it — but still legible, because these
          // rows are only on screen when the user went looking for them.
          archived && 'opacity-60',
        )}
      >
        {/* `shrink-0` on both lines: see note 2 in the file header. Without it
            a row one pixel too short compresses the line box and `truncate`
            clips the glyphs through the middle. */}
        {/* No native `title` on either line. Both used to carry one — the full
            title here, the profile below — and each raced the row's own bubble:
            hover long enough and the OS chip landed on top of the tooltip that
            already says it. `SessionTooltip` is now the single answer. */}
        <span
          className={cn(
            'flex w-full shrink-0 items-center gap-1.5 truncate text-xs',
            active ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {/* Ahead of the title, not after it: the title is what truncates, and
              a marker on the far side of a clip is a marker nobody sees. */}
          {/* Amber is the app's "you are being waited on" colour — the same one
              the activity indicator and the permission card use, so the sidebar
              is saying the thing the pane would say. Not pulsing: a pulse reads
              as progress, and nothing is progressing. */}
          {waiting ? (
            <StatusDot tone="amber" />
          ) : running ? (
            <StatusDot tone="cyan" pulse />
          ) : null}
          <span className="truncate">{condenseTitle(session.title)}</span>
          {/*
            7D's `.ago`, back on the row: `formatRelative` documents itself
            "for session lists" and had fallen out of this one. Compacted to
            the mockup's register — "4m", not "4m ago" — because at this size
            the suffix is the row's widest word saying nothing. The tooltip
            still speaks in full sentences.
          */}
          <span className="ml-auto shrink-0 pl-1 font-mono text-2xs font-normal text-ink-faint">
            {formatRelative(session.updatedAt).replace('just now', 'now').replace(' ago', '')}
          </span>
        </span>
        <span className="flex w-full shrink-0 items-center gap-1 font-mono text-2xs text-ink-faint">
          {/*
           * The branch yields first. It is the field with a long tail — release
           * branches carry ticket numbers and slashes — and it is the one whose
           * head still identifies it after a clip, which is not true of a
           * profile called "Personal (billing)".
           */}
          {/*
            `min-w-0` without `flex-1`: it must be *able* to shrink, but must
            not grow. Growing would push the separator and the profile out to
            the right edge on every row wide enough to fit them, which is the
            pinned-right layout this replaced, arrived at by accident.
          */}
          {session.gitBranch ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <GitBranchIcon className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{session.gitBranch}</span>
            </span>
          ) : null}
          {/* Both sides, not just the branch. The separator joins two things,
              and an unattributed row draws no profile — a `·` conditioned on
              the branch alone would trail off the end of the branch with
              nothing after it. */}
          {session.gitBranch && !unattributed ? (
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
          ) : null}
          {/*
           * The profile marker, per row rather than per project: two profiles
           * can hold sessions in the same directory, and which account a resume
           * will bill is not something to leave to inference.
           *
           * It used to be pinned right with `ml-auto` and clipped at twelve
           * characters, which is how "Personal" and "Personal (billing)" became
           * the same word on screen — the exact pair the marker exists to tell
           * apart. It now sits directly after the branch and is given the room:
           * the branch takes the slack and truncates, this does not.
           */}
          {/*
           * Nothing at all when the owner was never recorded, rather than a
           * placeholder word. "unknown" in the account slot is still a claim
           * about the account, and it would sit on most rows of a shared
           * install's history — a column of the same non-answer, which reads as
           * a broken field rather than an absent fact. The tooltip is where
           * there is room to say which it is; the row just leaves the space.
           */}
          {unattributed ? null : (
            <span
              className={cn(
                'flex min-w-0 max-w-[11rem] shrink-0 items-center gap-1',
                orphaned && 'text-amber',
              )}
            >
              <ProfileSwatch color={profile?.color} />
              <span className="truncate">{profile ? profile.label : 'profile missing'}</span>
            </span>
          )}
        </span>
      </ReasonButton>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-48" onKeyDown={pressHotkey}>
          {/*
           * Rename and Delete are capability-gated; Pin and Archive are not, and
           * that asymmetry is the design. The first two write to the provider's
           * own store, so a provider that cannot do them must not offer them.
           * Pinning and archiving are Artemis's own bookkeeping and work against
           * every provider, including one whose CLI cannot even list its
           * history.
           */}
          <MenuAction
            hotkey="r"
            disabled={!renaming.supported}
            title={renaming.supported ? undefined : renaming.reason}
            onSelect={() => setEditing(true)}
          >
            <PencilIcon aria-hidden="true" />
            Rename
          </MenuAction>

          <MenuAction hotkey="p" onSelect={() => toggleSessionPinned(session)}>
            {pinned ? (
              <>
                <PinOffIcon aria-hidden="true" />
                Unpin
              </>
            ) : (
              <>
                <PinIcon aria-hidden="true" />
                Pin
              </>
            )}
          </MenuAction>

          {/*
           * A scheduler's firing is archived by rule, not by entry — see
           * `partitionSessions` — so "Unarchive" on one would remove nothing
           * and change nothing. Disabled with the reason rather than hidden,
           * matching how capability gaps read above; the way to keep a firing
           * in view is the pin, which outranks the rule. Archiving a *pinned*
           * firing still works (it clears the pin and the rule refiles it), so
           * the item is only inert in the direction that would lie.
           */}
          {/*
            Two reasons this can be inert, and they are different in kind.
            The scheduled-run rule is a *policy*: the row is archived because
            nothing put it in view, so offering "unarchive" would lie. The
            capability is a *fact about the provider*: archiving writes a tag
            onto the stored session, and a provider whose store has no tag —
            Codex, the local servers — has nowhere to put it. Both say so
            rather than vanishing, which is the rule `disabled-reason.tsx` sets
            out and the one rename and delete already follow.
          */}
          <MenuAction
            hotkey="a"
            disabled={(archived && session.spawnedBy !== undefined) || !tagging.supported}
            title={
              !tagging.supported
                ? tagging.reason
                : archived && session.spawnedBy !== undefined
                  ? 'Scheduled runs stay archived — pin one to keep it in view'
                  : undefined
            }
            onSelect={() => void toggleSessionArchived(session)}
          >
            {archived ? (
              <>
                <ArchiveRestoreIcon aria-hidden="true" />
                Unarchive
              </>
            ) : (
              <>
                <ArchiveIcon aria-hidden="true" />
                Archive
              </>
            )}
          </MenuAction>

          <ContextMenuSeparator />

          <MenuAction
            hotkey="d"
            variant="destructive"
            disabled={!deleting.supported}
            title={deleting.supported ? undefined : deleting.reason}
            /*
             * Opening the dialog is deferred out of the `onSelect` tick.
             *
             * Radix restores focus to the trigger as the menu unmounts, and a
             * dialog mounted synchronously inside that same tick fights it for
             * focus — the dialog opens without it, so Escape and the default
             * button do nothing until the user clicks. Letting the menu finish
             * closing first is the documented way out.
             */
            onSelect={() => setTimeout(() => setConfirming(true), 0)}
          >
            <Trash2Icon aria-hidden="true" />
            Delete…
          </MenuAction>
        </ContextMenuContent>
      </ContextMenu>

      {/*
       * Mounted only while it is open, so a virtualised list is not carrying a
       * dialog per row. `DeleteSessionDialog` asks the main process whether the
       * session is still running as it opens, which is a question worth asking
       * once per confirmation rather than once per render.
       */}
      {confirming ? (
        <DeleteSessionDialog session={session} onClose={() => setConfirming(false)} />
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* The row's menu, and its letters                                            */
/* -------------------------------------------------------------------------- */

/**
 * The letters the row's menu answers to: Rename, Pin, Archive, Delete.
 *
 * They are the initials of the actions, which is the only mapping worth having
 * — a hotkey nobody can derive from the word next to it is a hotkey nobody uses
 * — and they are unambiguous here because the menu has four items and no two
 * begin with the same letter. Un-pinning and un-archiving keep the letter of the
 * thing they undo: `P` is "the pin", not "pin", so the same key toggles it in
 * both directions rather than moving when the row's state changes.
 *
 * A set rather than a bare `length === 1` check because the key is interpolated
 * into an attribute selector below, and `"` or `]` arriving from a keyboard
 * layout nobody tested would be a syntax error thrown at a right-click.
 */
type Hotkey = 'r' | 'p' | 'a' | 'd';
const HOTKEYS: ReadonlySet<string> = new Set<Hotkey>(['r', 'p', 'a', 'd']);

/**
 * Turn a letter into the click it stands for.
 *
 * The key finds the item in the DOM and clicks it, rather than calling the
 * action directly. That is deliberate: clicking is the path Radix already
 * defines, so the letter inherits every behaviour the mouse has — the menu
 * closes, `onSelect` fires exactly once, and a *disabled* item stays inert,
 * because Radix's own handler is what checks. Wiring the actions a second time
 * behind the keys would be the same four calls with a separate set of bugs, and
 * the first one to drift would be the gating on a provider that cannot delete.
 *
 * `preventDefault` is not decoration. Radix composes this handler ahead of its
 * own and skips that one when the default is prevented, which is what stops a
 * letter from *also* being fed to the menu's built-in typeahead and moving the
 * focus ring somewhere the user did not ask for.
 *
 * Modified presses are left alone. ⌘R is the window reloading and ⌘D is the
 * platform's, and a menu that swallowed them because it happened to be open
 * would be taking keys that were never aimed at it.
 */
function pressHotkey(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (!HOTKEYS.has(key)) return;

  const item = event.currentTarget.querySelector<HTMLElement>(`[data-hotkey="${key}"]`);
  if (!item) return;
  event.preventDefault();
  item.click();
}

/**
 * One menu item, with its letter on the right.
 *
 * The letter is in three places — the cap the eye reads, the `data-hotkey` the
 * keyboard resolves against, and the `aria-keyshortcuts` a screen reader
 * announces — and they must agree, so one argument writes all three. Three
 * hand-kept copies per item is how a menu ends up showing `A` for an item that
 * answers to `R`.
 *
 * The cap itself is `aria-hidden`: `aria-keyshortcuts` is the accessible way to
 * say this, and leaving the glyph in the accessibility tree would rename the
 * item to "Rename R".
 */
function MenuAction({
  hotkey,
  disabled,
  title,
  variant,
  onSelect,
  children,
}: {
  readonly hotkey: Hotkey;
  readonly disabled?: boolean;
  readonly title?: string | undefined;
  readonly variant?: 'default' | 'destructive';
  readonly onSelect: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ContextMenuItem
      data-hotkey={hotkey}
      aria-keyshortcuts={hotkey.toUpperCase()}
      disabled={disabled}
      title={title}
      variant={variant}
      onSelect={onSelect}
    >
      {children}
      <Kbd aria-hidden="true" className="ml-auto">
        {hotkey.toUpperCase()}
      </Kbd>
    </ContextMenuItem>
  );
}

/**
 * The rename field, in place of the row.
 *
 * Commits on Enter and on blur; abandons on Escape. Blur-commits rather than
 * blur-cancels because the field is opened from a menu and dismissed by
 * clicking away, and the reading of "click away" that loses typing is the one
 * people complain about — every other list in this app that renames in place
 * behaves the same way.
 */
function RenameField({
  session,
  onDone,
}: {
  readonly session: SessionSummary;
  readonly onDone: () => void;
}): ReactElement {
  const [value, setValue] = useState(session.title);
  /*
   * Guards the double-commit. Enter commits and then blurs, and the blur
   * handler would commit the same edit a second time — harmless for the store,
   * but it is a second IPC write and a second chance to fail.
   */
  const done = useRef(false);

  const finish = useCallback(
    (commit: boolean): void => {
      if (done.current) return;
      done.current = true;
      if (commit) void renameSession(session, value);
      onDone();
    },
    [session, value, onDone],
  );

  return (
    <Input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
        // Arrow keys and Home/End belong to the field while it is open. Without
        // this the sidebar's own key handling would move the selection out from
        // under a cursor the user is using to edit.
        event.stopPropagation();
      }}
      onFocus={(event) => event.target.select()}
      aria-label={`Rename session: ${session.title}`}
      spellCheck={false}
      // The same field shape as the filter above it — see the note there for
      // why the ground is stated rather than inherited.
      className="h-full w-full rounded-lg border-hairline-strong bg-wash px-2 text-xs md:text-xs dark:bg-wash"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Nothing to show.
 *
 * Two different sentences, because the two cases call for different next
 * actions: an empty project is waiting for a first session, whereas an empty
 * *filter* means the sessions are there and the query is wrong.
 */
function NothingHere({
  filtered,
  query,
}: {
  readonly filtered: boolean;
  readonly query: string;
}): ReactElement {
  return (
    <Empty className="gap-2 px-3 py-6">
      <EmptyHeader className="gap-1.5">
        <EmptyMedia variant="icon" className="mb-0 size-7 rounded-lg bg-wash-strong">
          <InboxIcon className="size-3.5 text-ink-faint" aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-xs text-ink-muted">
          {filtered ? 'No match' : 'No sessions yet'}
        </EmptyTitle>
        <EmptyDescription className="text-2xs leading-snug text-ink-faint">
          {filtered
            ? `No session in any project matches “${query.trim()}”.`
            : 'Every session you start shows up here, grouped by the project it ran in.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * A line of prose where the session list would be.
 *
 * `signal` is for a failure the user can retry. `muted` and `faint` are both
 * neutral, and neither is a warning colour — a capability this provider does not
 * have is a fact about the product, not something going wrong, and amber made
 * "Codex cannot list past sessions" read as an error the user had caused. Same
 * move as the alert cards, where the icon carries the warning and the card does
 * not.
 */
function Note({
  tone,
  children,
}: {
  readonly tone: 'faint' | 'muted' | 'signal';
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p
      className={cn(
        'px-2.5 py-3 text-2xs leading-snug',
        tone === 'faint' && 'text-ink-faint',
        tone === 'muted' && 'text-ink-muted',
        tone === 'signal' && 'text-signal',
      )}
    >
      {children}
    </p>
  );
}

function LoadingRows(): ReactElement {
  return (
    <div className="flex flex-col gap-3 px-2.5 py-2" aria-busy="true" aria-label="Loading sessions">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex flex-col gap-1">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}
