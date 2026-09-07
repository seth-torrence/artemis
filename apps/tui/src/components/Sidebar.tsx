/**
 * The left rail: every conversation this account has, in folders.
 *
 * The desktop's session list, in a column. Conversations come from every
 * account's store, across every directory each has worked in — a row from
 * another account says so, and opening it switches to that account — and
 * are grouped by *project* — the repository, with every worktree of it folded
 * into the same folder — exactly as the desktop groups them: a worktree of
 * The conversation you are in wears a `●`; one still working wears a `◐`,
 * and one that has stopped to ask permission a yellow `⚿`. Those last two are
 * how a turn you have switched away from stays visible — see `app.tsx` on the
 * pool of conversations.
 *
 * Artemis is still Artemis. Opening a conversation moves the working
 * directory to wherever it ran, worktree included. Folders are in name order
 * and hold still, as the desktop's are — a heading someone is reaching for
 * must not slide away because a conversation elsewhere was touched — and the
 * conversations inside one are newest first. The project you are in starts
 * open; the others start folded, and Enter on a heading folds or unfolds it.
 * A folder shows its newest few and then an "… n more" row; Enter on that
 * shows the rest.
 *
 * The two rows at the top are the two ways to begin: here, or somewhere else.
 * The second opens the folder chooser, because the folder you want is a thing
 * to pick from a list rather than a path to type out.
 *
 * A folder with nothing in it is not drawn at all — including the one you are
 * standing in. A heading over no rows is a promise of contents, and the
 * directory you are working in is already named in the header and on the
 * settings line; it does not need a third, empty announcement of itself.
 *
 * Archived conversations leave their project for a folder of their own at the
 * foot of the rail, which starts folded. Archiving writes a tag into the
 * provider's own store — the same tag the desktop writes — so a row put away
 * here is put away there, and neither app keeps a list of the other's rows.
 *
 * One cursor walks the whole rail — "new", then each folder's heading and
 * its conversations — and Enter does the one thing that row means. The rail
 * draws the cursor only while it has focus (Tab), so the composer's cursor and
 * this one are never both lit. Colours are the terminal's own: the accent is
 * the theme's magenta, the rest is foreground and dim.
 *
 * Nothing here decides anything. What Enter *does* is the app's; the rail
 * reports which row was chosen.
 */

import { basename } from 'node:path';
import { homedir } from 'node:os';

import { Box, Text } from 'ink';
import { isArchived, type SessionSummary } from '@rx-artemis/protocol';
import { compareFolderNames, formatRelative, oneLine } from '@rx-artemis/transcript';

import { shortenPath } from '../directories.js';
import { ACCENT } from '../theme.js';

export type RailRow =
  | { readonly kind: 'new' }
  | { readonly kind: 'new-elsewhere' }
  | { readonly kind: 'folder'; readonly project: string; readonly label: string; readonly count: number; readonly open: boolean }
  | { readonly kind: 'session'; readonly session: SessionSummary; readonly account?: string }
  | { readonly kind: 'more'; readonly project: string; readonly hidden: number };

/** How many conversations a folder shows before "… n more"; Enter on that row shows the rest. */
const PER_FOLDER = 8;

/**
 * The archive's stand-in for a project root.
 *
 * Not a path, and it cannot be one: it has to sort last and it has to be
 * impossible for a real directory to collide with. A leading NUL does both —
 * no filesystem produces it, and it sorts after every printable name.
 */
export const ARCHIVED_FOLDER = '\u0000archived';

/** Newest first; a session id is unique per account, so the account breaks a timestamp tie. */
function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || `${a.profileId}:${a.id}`.localeCompare(`${b.profileId}:${b.id}`);
}

/** `~/code/repo` for a path under the home directory. */
/**
 * The rail's rows in cursor order.
 *
 * `projectOf` maps a working directory to the project it belongs to — the
 * repository root, or the main checkout for a linked worktree — and is what
 * keeps worktrees together. A directory nobody has resolved yet is its own
 * project until the answer lands. Which folder is *open* is the caller's, not
 * this function's: the app seeds it with the project the working directory is
 * in, and Enter changes it from there.
 *
 * Folders sort by name — the same comparator as every folder list in the
 * desktop — and so never move when a conversation is worked on; the current
 * project is not lifted to the top, because a heading that jumps whenever the
 * working directory changes is a heading that cannot be found by position.
 * It is always present, even with nothing in it, so a fresh directory has a
 * heading to open a conversation under. Conversations sort newest first here
 * rather than trusting the input's order: the list is assembled from several
 * accounts' stores, and this is the one place that decides what "in order"
 * means for the rail.
 *
 * `expanded` names the folders showing every conversation rather than the
 * newest `PER_FOLDER`; the "… n more" row is what adds a folder to it.
 */
export function railRows(
  sessions: readonly SessionSummary[],
  open: ReadonlySet<string>,
  projectOf: (cwd: string) => string,
  /** Label for a session's account when it is not the current one; `undefined` when it is. */
  accountOf: (session: SessionSummary) => string | undefined = () => undefined,
  expanded: ReadonlySet<string> = new Set(),
): readonly RailRow[] {
  const byProject = new Map<string, SessionSummary[]>();
  const archived: SessionSummary[] = [];
  for (const session of sessions) {
    if (isArchived(session)) {
      archived.push(session);
      continue;
    }
    const project = projectOf(session.cwd);
    const list = byProject.get(project) ?? [];
    list.push(session);
    byProject.set(project, list);
  }

  const folders = [...byProject.entries()].sort(([a], [b]) => compareFolderNames(a, b));
  if (archived.length > 0) folders.push([ARCHIVED_FOLDER, archived]);

  const rows: RailRow[] = [{ kind: 'new' }, { kind: 'new-elsewhere' }];
  for (const [project, list] of folders) {
    // An empty folder is not drawn: a heading over no rows promises contents
    // it does not have, and the only folder that could be empty is the one the
    // working directory is in, which is already named twice on screen.
    if (list.length === 0) continue;
    const isOpen = open.has(project);
    rows.push({
      kind: 'folder',
      project,
      label: project === ARCHIVED_FOLDER ? 'archived' : basename(project) || project,
      count: list.length,
      open: isOpen,
    });
    if (!isOpen) continue;
    const ordered = [...list].sort(newestFirst);
    const shown = expanded.has(project) ? ordered : ordered.slice(0, PER_FOLDER);
    for (const session of shown) {
      const account = accountOf(session);
      rows.push({ kind: 'session', session, ...(account === undefined ? {} : { account }) });
    }
    if (shown.length < ordered.length) rows.push({ kind: 'more', project, hidden: ordered.length - shown.length });
  }
  return rows;
}

/**
 * What a conversation is doing, for the glyph in front of its title.
 *
 * `running` and `awaiting` are the two a *parked* conversation can be in
 * — the ones that make switching away from a turn safe to do, because the
 * rail is then the only place that says the turn is still going, or that it
 * has stopped to ask something.
 */
export type RailActivity = 'running' | 'awaiting';

export interface SidebarProps {
  readonly rows: readonly RailRow[];
  readonly selected: number;
  readonly focused: boolean;
  readonly activeSessionId?: string;
  /** Conversations with a turn in flight, or stopped on a question, by session id. */
  readonly activity?: ReadonlyMap<string, RailActivity>;
  /** The project the working directory belongs to. */
  readonly currentProject: string;
  readonly width: number;
  readonly height: number;
  readonly loading: boolean;
}

export function Sidebar({
  rows,
  selected,
  focused,
  activeSessionId,
  activity,
  currentProject,
  width,
  height,
  loading,
}: SidebarProps): React.JSX.Element {
  const inner = Math.max(8, width - 3);
  // Rows the screen can hold: title, hint, and one line each. The window
  // follows the cursor so a long list can still be walked.
  const budget = Math.max(3, height - 4);
  const first = focused ? Math.max(0, Math.min(selected - Math.floor(budget / 2), rows.length - budget)) : 0;
  const visible = rows.slice(first, first + budget);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderBottom={false}
      borderDimColor={!focused}
      borderColor={focused ? ACCENT : undefined}
    >
      <Text color={ACCENT} bold>
        CONVERSATIONS
      </Text>
      {loading && !rows.some((row) => row.kind === 'session') && <Text dimColor>  reading…</Text>}
      {visible.map((row, i) => {
        const index = first + i;
        const isSelected = focused && index === selected;
        const cursor = isSelected ? '❯' : ' ';
        switch (row.kind) {
          case 'new':
            return (
              <Text key="new">
                <Text color={ACCENT}>{cursor} </Text>
                <Text color={isSelected ? ACCENT : undefined} bold={isSelected} dimColor={!isSelected}>
                  + new conversation
                </Text>
              </Text>
            );
          case 'new-elsewhere':
            return (
              <Text key="new-elsewhere">
                <Text color={ACCENT}>{cursor} </Text>
                <Text color={isSelected ? ACCENT : undefined} bold={isSelected} dimColor={!isSelected}>
                  + in another folder…
                </Text>
              </Text>
            );
          case 'folder': {
            const current = row.project === currentProject;
            const glyph = row.open ? '▾' : '▸';
            return (
              <Box key={`folder:${row.project}`} marginTop={1} flexDirection="column">
                <Text>
                  <Text color={ACCENT}>{cursor} </Text>
                  <Text bold color={isSelected ? ACCENT : undefined} dimColor={!current && !isSelected}>
                    {glyph} {oneLine(row.label, inner - 8)}
                  </Text>
                  <Text dimColor>{` ${String(row.count)}`}</Text>
                </Text>
                {isSelected && <Text dimColor>{'    '}{oneLine(shortenPath(row.project, homedir()), inner - 4)}</Text>}
              </Box>
            );
          }
          case 'session': {
            const active = row.session.id === activeSessionId;
            const doing = activity?.get(row.session.id);
            /*
             * One glyph, in front of the title, saying which conversation you
             * are in and what the others are doing. Colour alone did not
             * carry it: the row you are in was the accent and so was the row
             * under the cursor, which is two different things wearing one
             * face.
             */
            const glyph = doing === 'awaiting' ? '⚿' : doing === 'running' ? '◐' : active ? '●' : ' ';
            const glyphColour = doing === 'awaiting' ? 'yellow' : doing === 'running' ? 'cyan' : ACCENT;
            return (
              <Box key={`session:${row.session.id}`} flexDirection="column">
                <Text>
                  <Text color={ACCENT}>{cursor} </Text>
                  <Text color={glyphColour} bold={active}>{glyph}</Text>
                  <Text color={isSelected || active ? ACCENT : undefined} bold={isSelected || active} dimColor={!isSelected && !active}>
                    {' '}
                    {oneLine(row.session.title, inner - 4 - (row.account === undefined ? 0 : row.account.length + 3))}
                  </Text>
                  {row.account !== undefined && <Text dimColor>{` · ${row.account}`}</Text>}
                </Text>
                {isSelected && (
                  <Text dimColor>
                    {'      '}
                    {oneLine(
                      [
                        formatRelative(row.session.updatedAt),
                        row.session.gitBranch,
                        row.session.model,
                      ]
                        .filter((part): part is string => part !== undefined && part.length > 0)
                        .join(' · '),
                      inner - 6,
                    )}
                  </Text>
                )}
              </Box>
            );
          }
          case 'more':
            return (
              <Text key={`more:${row.project}`}>
                <Text color={ACCENT}>{cursor} </Text>
                <Text color={isSelected ? ACCENT : undefined} bold={isSelected} dimColor={!isSelected}>
                  {'  '}… {String(row.hidden)} more
                </Text>
              </Text>
            );
          default:
            return null;
        }
      })}
      <Box flexGrow={1} />
      <Text dimColor>{focused ? '↑↓ · Enter · a · d · Esc' : 'Tab: conversations'}</Text>
    </Box>
  );
}
