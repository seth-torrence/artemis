/**
 * The conversation, drawn.
 *
 * Every transcript row has one face here — user turns, streamed assistant
 * text rendered from markdown, tool calls with their diffs, permission
 * outcomes, notices, run ends — and the same faces serve three surfaces: the
 * live viewport, a replayed subagent transcript, and a resumed conversation.
 *
 * Live rows subscribe to their own id and are redrawn on the transcript
 * model's flush, so a token touches one row. The viewport bounds how many rows
 * exist at once (see `WINDOW_ROWS`), which is what keeps a long conversation
 * cheap in a layout that is redrawn whole.
 *
 * Pending permission rows draw nothing here; the card that answers them is a
 * separate live component, and drawing the request twice would be worse than
 * either once.
 *
 * The rows are drawn in the shape of the provider CLIs' own transcripts — a
 * marker in the gutter, content hanging under it, results on a connector —
 * because that is the shape their users already read fluently. See the note
 * over the rows for the one layout rule that keeps the viewport honest.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';

import type { AgentError, AgentEvent } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  classifyTool,
  describeActivity,
  detectFileEdit,
  formatDuration,
  formatTokens,
  formatUsd,
  isGroupId,
  oneLine,
  summarizeToolInput,
  syncScheduler,
  totalInputTokens,
  type ActivityGroup,
  type ToolCategory,
  type TranscriptItem,
} from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';
import { renderDiff } from '../render/diff.js';
import { renderMarkdownLines } from '../render/markdown.js';

/* -------------------------------------------------------------------------- */
/* Settling                                                                   */
/* -------------------------------------------------------------------------- */

function itemSettled(item: TranscriptItem | undefined): boolean {
  if (item === undefined) return true;
  switch (item.kind) {
    case 'user':
      return !item.pending;
    case 'assistant':
    case 'thinking':
      return !item.streaming;
    case 'tool':
      return item.status !== 'running';
    case 'permission':
      return item.state !== 'pending';
    default:
      return true;
  }
}

interface Snapshot {
  readonly key: string;
  readonly item?: TranscriptItem;
  readonly group?: ActivityGroup;
  readonly members?: readonly TranscriptItem[];
}

function snapshotRow(id: string, transcript: TranscriptModel, key: string): Snapshot | null {
  if (isGroupId(id)) {
    const group = transcript.getGroup(id);
    if (group === undefined) return null;
    const members = group.ids.map((memberId) => transcript.getItem(memberId)).filter((m): m is TranscriptItem => m !== undefined);
    return { key, group, members };
  }
  const item = transcript.getItem(id);
  return item === undefined ? null : { key, item };
}

function rowSettled(id: string, transcript: TranscriptModel): boolean {
  if (isGroupId(id)) {
    const group = transcript.getGroup(id);
    if (group === undefined) return true;
    return group.running === 0 && group.ids.every((memberId) => itemSettled(transcript.getItem(memberId)));
  }
  return itemSettled(transcript.getItem(id));
}


/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * The shape every row shares is the provider CLIs' own, because that is the
 * shape people already read: a marker in a two-column gutter and content that
 * wraps under itself, never under the marker. Under a tool call, a `⎿`
 * connector hangs what it returned. A blank line separates blocks, and the
 * colour of a tool's marker is its status: green for a call that returned,
 * red for one that failed, cyan while it runs.
 *
 * Four voices, four faces, because they were reported as looking alike:
 *
 *  - `▌` in the accent, text bold — **what the person said**. It was `>` with
 *    the text *dimmed*, which made someone's own words the faintest thing on
 *    a screen they are scanning to find them. They are the landmarks in a
 *    long transcript and they are now the brightest rows on it.
 *  - `●` — **what the agent said**. The CLIs draw this as `⏺`, which many
 *    terminal fonts render as a wide emoji glyph that swallows the gap before
 *    the text; see `SPEECH_MARKER`.
 *  - `◆` — **a tool the agent reached for**. It shared the agent's mark, so
 *    the agent speaking and the agent running a command were the same row at
 *    a glance. Speech is what someone is reading for, so speech kept the
 *    circle and the machinery took a new one.
 *  - `∴`, dim and italic — **thought**, unchanged; it was already distinct.
 *
 * Text is otherwise left in the terminal's foreground; dim is for what is
 * secondary, never for what is being said.
 *
 * Every row is `flexShrink={0}`, and this is not a nicety. Ink gives a Box
 * `flexShrink: 1` by default, and the viewport below is a column of fixed
 * height: a conversation taller than the screen had every row squeezed to a
 * fraction of its height while its text kept its full size and spilled over
 * the rows beneath — which read as the transcript overwriting itself. Rows
 * keep their size; the viewport clips.
 */

/** A marker in the gutter and content that wraps under itself. */
function Block({
  marker,
  color,
  dim,
  spaced = true,
  children,
}: {
  readonly marker: string;
  readonly color?: string;
  readonly dim?: boolean;
  /** A blank line above. Off for a line that belongs to the block before it. */
  readonly spaced?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="row" marginTop={spaced ? 1 : 0} flexShrink={0}>
      <Box width={2} flexShrink={0}>
        <Text color={color} dimColor={dim}>
          {marker}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/** What a call returned, hung under it on a connector. */
function Returned({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box width={3} flexShrink={0}>
        <Text dimColor>⎿ </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The agent's voice. A plain circle, U+25CF, and not the CLIs' `⏺` (U+23FA):
 * that one has an emoji presentation in many terminal fonts — a rounded
 * square with a hollow circle — drawn two cells wide while the layout allots
 * one, so the mark ran straight into the text with no gap. U+25CF is one cell
 * everywhere a terminal runs.
 */
const SPEECH_MARKER = '●';
/** Every tool row and tool group, distinct from the mark the agent speaks with. */
const TOOL_MARKER = '◆';

const TOOL_MARK: Record<string, { color?: string; dim?: boolean }> = {
  running: { color: 'cyan' },
  ok: { color: 'green' },
  error: { color: 'red' },
  denied: { color: 'yellow' },
  cancelled: { dim: true },
};

/** How many lines of a result are shown before "… +n lines". */
const RESULT_LINES = 3;
/*
 * What a call returned is a preview, and a preview is one line per line: a
 * diff row or a result line longer than the screen is cut, not wrapped,
 * because a wrapped line of code reads as two lines of code.
 */

/**
 * How much of a diff is shown. An edit is usually small and the change is
 * the point, so most of it fits; a whole written file is content rather than
 * change, and a screenful of `+` lines says nothing a count does not.
 */
const EDIT_LINES = 20;
const WRITE_LINES = 6;

function ToolRow({ item }: { readonly item: Extract<TranscriptItem, { kind: 'tool' }> }): React.JSX.Element {
  const mark = TOOL_MARK[item.status] ?? TOOL_MARK['ok'];
  const summary = summarizeToolInput(item.input);
  const edit = detectFileEdit(item.name, item.input);
  const resultLines =
    edit === null && item.status === 'ok' && item.resultText !== undefined
      ? item.resultText.split('\n').filter((line) => line.trim().length > 0)
      : [];
  const hidden = Math.max(0, resultLines.length - RESULT_LINES);
  return (
    <Block marker={TOOL_MARKER} color={mark?.color} dim={mark?.dim}>
      <Text>
        {item.title !== undefined ? (
          <Text bold>{oneLine(item.title, 160)}</Text>
        ) : (
          <>
            <Text bold>{item.name}</Text>
            {summary.length > 0 && <Text dimColor>({oneLine(summary, 140)})</Text>}
          </>
        )}
        {item.durationMs !== undefined && item.durationMs >= 1_000 && <Text dimColor>{`  ${formatDuration(item.durationMs)}`}</Text>}
      </Text>
      {edit !== null && (
        <Returned>
          {renderDiff(edit, edit.removed === 0 ? WRITE_LINES : EDIT_LINES).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line}
            </Text>
          ))}
        </Returned>
      )}
      {resultLines.length > 0 && (
        <Returned>
          {resultLines.slice(0, RESULT_LINES).map((line, i) => (
            <Text key={i} dimColor wrap="truncate">
              {oneLine(line, 160)}
            </Text>
          ))}
          {hidden > 0 && <Text dimColor>{`… +${String(hidden)} line${hidden === 1 ? '' : 's'}`}</Text>}
        </Returned>
      )}
      {item.status === 'denied' && (
        <Returned>
          <Text color="yellow">Denied</Text>
        </Returned>
      )}
      {item.status === 'cancelled' && (
        <Returned>
          <Text dimColor>Cancelled</Text>
        </Returned>
      )}
      {item.error !== undefined && (
        <Returned>
          <Text color="red">Error: {oneLine(item.error.message, 300)}</Text>
        </Returned>
      )}
    </Block>
  );
}

function ItemRow({ item }: { readonly item: TranscriptItem }): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <Block marker="▌" color={ACCENT}>
          <Text bold dimColor={item.pending}>
            {item.text}
          </Text>
        </Block>
      );
    case 'assistant':
      if (item.text.length === 0) return null;
      return (
        <Block marker={SPEECH_MARKER}>
          {renderMarkdownLines(item.text).map((line, i) =>
            line.hang === 0 ? (
              // An empty Text has no height; a blank line needs one space to be a line.
              <Text key={i} dimColor={item.synthetic === true}>
                {line.body.length === 0 ? ' ' : line.body}
              </Text>
            ) : (
              <Box key={i} flexDirection="row" flexShrink={0}>
                <Box width={line.hang} flexShrink={0}>
                  <Text>{line.prefix}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor={item.synthetic === true}>{line.body.length === 0 ? ' ' : line.body}</Text>
                </Box>
              </Box>
            ),
          )}
        </Block>
      );
    case 'thinking':
      return (
        <Block marker="∴" dim spaced>
          {/*
           * Whole, and in the paragraphs it was written in. It used to be
           * `oneLine(text, 200)`, which flattened the reasoning into a single
           * line and then cut its tail off — and unlike the desktop, where a
           * long block folds open on demand, a terminal row offered no way to
           * ask for the rest, so the end of a thought was simply unreadable.
           */}
          {(item.redacted ? ['Thinking (redacted)'] : item.text.split('\n')).map((line, i) => (
            // An empty Text has no height; a blank line needs one space to be a line.
            <Text key={i} dimColor italic>
              {line.length === 0 ? ' ' : line}
            </Text>
          ))}
        </Block>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'permission':
      if (item.state === 'pending') return null;
      return (
        <Block marker="⚿" dim spaced={false}>
          <Text dimColor>
            {item.request.toolName} — {item.state}
            {item.note !== undefined ? `: ${oneLine(item.note, 120)}` : ''}
          </Text>
        </Block>
      );
    case 'notice': {
      const color = item.level === 'error' ? 'red' : item.level === 'warn' ? 'yellow' : undefined;
      return (
        <Block marker={item.level === 'error' ? '✗' : item.level === 'warn' ? '!' : 'ℹ'} color={color} dim={item.level === 'info'}>
          <Text color={color} dimColor={item.level === 'info'}>
            {item.text}
          </Text>
          {item.detail?.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Block>
      );
    }
    case 'command':
      return (
        <Block marker="/" dim>
          <Text dimColor>
            {item.name}
            {item.args !== undefined ? ` ${item.args}` : ''}
          </Text>
          {item.output !== undefined && item.output.length > 0 && (
            <Text color={item.failed === true ? 'red' : undefined} dimColor={item.failed !== true}>
              {item.output}
            </Text>
          )}
        </Block>
      );
    case 'run-end': {
      const tokens = totalInputTokens(item.usage?.tokens);
      const parts = [
        item.durationMs !== undefined ? formatDuration(item.durationMs) : undefined,
        tokens !== undefined ? `${formatTokens(tokens)} tok` : undefined,
        item.usage?.costUsd !== undefined ? formatUsd(item.usage.costUsd) : undefined,
      ].filter((part): part is string => part !== undefined);
      if (item.reason === 'completed') {
        /*
         * A turn that produced nothing is named rather than left as a bare
         * duration. `52ms · 0 tok` under a message reads as the agent
         * shrugging; what it usually means is that the provider had nothing
         * to send — a message that was queued rather than answered, say. The
         * two are indistinguishable unless one of them says so.
         */
        return (
          <Block marker="" dim spaced={false}>
            <Text dimColor>{[...(item.silent ? ['no reply'] : []), ...parts].join(' · ')}</Text>
          </Block>
        );
      }
      return (
        <Block marker="✗" color={item.reason === 'error' ? 'red' : 'yellow'} spaced={false}>
          <Text color={item.reason === 'error' ? 'red' : 'yellow'}>
            {item.reason === 'interrupted' ? 'Interrupted' : item.reason.replace(/_/g, ' ')}
            {parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}
          </Text>
          {item.error !== undefined && <Text color="red">{oneLine(item.error.message, 300)}</Text>}
        </Block>
      );
    }
    default:
      return null;
  }
}

type ToolRowItem = Extract<TranscriptItem, { kind: 'tool' }>;

/**
 * A run's calls, folded as the desktop folds them.
 *
 * What has finished is one line — "Ran 12 commands, read 3 files" — and what
 * is still running is drawn in full beneath it, so the eye has one place to
 * look for what the agent is doing now and one number for how much it has
 * done. A call folds into the count the moment it settles. A call that
 * failed or was refused stays out, in full, with its error: the desktop's
 * rule too, because the one call worth reading in a burst of forty is the
 * one that went wrong.
 */
function GroupRow({ members }: { readonly group: ActivityGroup; readonly members: readonly TranscriptItem[] }): React.JSX.Element {
  const calls = members.filter((member): member is ToolRowItem => member.kind === 'tool');
  const folded = calls.filter((call) => call.status === 'ok' || call.status === 'cancelled');
  const shown = calls.filter((call) => call.status !== 'ok' && call.status !== 'cancelled');
  const counts: Partial<Record<ToolCategory, number>> = {};
  for (const call of folded) {
    const category = classifyTool(call.name);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  const summary = describeActivity(counts);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {summary.length > 0 && (
        <Block marker={TOOL_MARKER} color="green">
          <Text>{summary}</Text>
        </Block>
      )}
      {shown.map((call) => (
        <ToolRow key={call.id} item={call} />
      ))}
    </Box>
  );
}

function RowContent({ snapshot }: { readonly snapshot: Snapshot }): React.JSX.Element | null {
  if (snapshot.group !== undefined) return <GroupRow group={snapshot.group} members={snapshot.members ?? []} />;
  if (snapshot.item !== undefined) return <ItemRow item={snapshot.item} />;
  return null;
}

/** A row still subject to change: subscribed to its own id, redrawn on flush. */
function LiveRow({ id, transcript }: { readonly id: string; readonly transcript: TranscriptModel }): React.JSX.Element | null {
  const group = isGroupId(id);
  const snapshot = useSyncExternalStore(
    (onChange) => (group ? transcript.subscribeGroup(id, onChange) : transcript.subscribeItem(id, onChange)),
    () => (group ? transcript.getGroup(id) : transcript.getItem(id)),
  );
  if (snapshot === undefined) return null;
  const built = snapshotRow(id, transcript, id);
  return built === null ? null : <RowContent snapshot={built} />;
}

/* -------------------------------------------------------------------------- */
/* The viewport                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Rows in the order they began.
 *
 * The model files a run's calls under one group and parks that group at the
 * foot of the run — the desktop's marker, which sits below the prose. Read
 * top to bottom in a terminal, that puts "Ran 3 commands" after the answer
 * the commands produced. Every row carries when it started, and ordering on
 * that puts the fold where the first call was made: after the thought that
 * led to it, before the text that came of it — with what is running now
 * directly under the count. A stable sort, so rows that began together keep
 * the model's order.
 */
function inOrderOfStart(ids: readonly string[], transcript: TranscriptModel): readonly string[] {
  const startOf = (id: string): number => (isGroupId(id) ? transcript.getGroup(id)?.ts : transcript.getItem(id)?.ts) ?? 0;
  return ids
    .map((id, index) => ({ id, index, ts: startOf(id) }))
    .sort((a, b) => a.ts - b.ts || a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * How many rows are handed to Ink at once while following the conversation.
 *
 * A screen shows a few dozen lines; a conversation has hundreds of rows. Only
 * the tail is rendered, so a token arriving in a long conversation costs a
 * bounded amount of work rather than a walk over everything that was ever
 * said. Scrolling back extends the window by this much at a time, as far up
 * as the person goes, and following again lets it go.
 */
const WINDOW_ROWS = 40;

export interface TranscriptViewportProps {
  readonly transcript: TranscriptModel;
  /** A run is in flight. */
  readonly live: boolean;
  /** Lines scrolled back from the end. `0` follows the conversation. */
  readonly offset: number;
  /** How far back it is possible to scroll, in lines, as of the last layout. */
  readonly onExtent?: (extent: { readonly maxOffset: number; readonly viewportLines: number }) => void;
}

/**
 * The conversation in a fixed-height box, anchored to the bottom.
 *
 * Bottom-anchored by layout — `justifyContent: flex-end` inside an
 * `overflow: hidden` box — so the newest content is always visible and older
 * content is clipped off the top, which is what a chat pane does. The box
 * takes whatever height the column has left after the composer, the status
 * line and any open card: it grows to fill and shrinks to nothing, never the
 * other way round, so a tall permission card pushes the conversation up
 * rather than the composer off the screen.
 *
 * Scrolling is by *line*, not by row. A row can be a whole run's worth of
 * tool calls — taller than the screen — and scrolling by rows meant the top
 * of such a row could never be looked at: the pane always showed its foot.
 * So the content column is pushed down by the offset with a negative bottom
 * margin, the clip does the rest, and the column's measured height says how
 * far up there is to go. Rows beyond the rendered window are brought in as
 * the offset approaches the top of what is drawn.
 */
export function TranscriptViewport({ transcript, live, offset, onExtent }: TranscriptViewportProps): React.JSX.Element {
  const rows = useSyncExternalStore(transcript.subscribeList, transcript.getRowsSnapshot);
  const [windowRows, setWindowRows] = useState(WINDOW_ROWS);
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const [measured, setMeasured] = useState({ content: 0, viewport: 0 });

  const following = offset === 0;
  const start = Math.max(0, rows.length - (following ? WINDOW_ROWS : windowRows));
  const shown = inOrderOfStart(rows.slice(start), transcript);

  // Measured after every render: Ink lays out on commit, so the numbers are
  // one frame behind at worst. Only a change is stored, or this would loop.
  useEffect(() => {
    const content = contentRef.current === null ? 0 : measureElement(contentRef.current).height;
    const viewport = viewportRef.current === null ? 0 : measureElement(viewportRef.current).height;
    setMeasured((current) => (current.content === content && current.viewport === viewport ? current : { content, viewport }));
  });

  const maxOffset = Math.max(0, measured.content - measured.viewport);
  const clamped = Math.min(offset, maxOffset);
  const nearTop = measured.content - measured.viewport - clamped < measured.viewport;

  useEffect(() => {
    onExtent?.({ maxOffset, viewportLines: measured.viewport });
  }, [maxOffset, measured.viewport, onExtent]);

  // More rows when the person is about to run out of what is drawn; fewer
  // again once they are back at the end.
  useEffect(() => {
    if (following) {
      if (windowRows !== WINDOW_ROWS) setWindowRows(WINDOW_ROWS);
      return;
    }
    if (nearTop && start > 0) setWindowRows((current) => current + WINDOW_ROWS);
  }, [following, nearTop, start, windowRows]);

  const above = start > 0 || clamped < maxOffset;

  // The clip and the "more below" line are siblings: a line drawn inside the
  // clip would sit on top of a content line and let its tail show through.
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} paddingX={1}>
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        {rows.length === 0 && (
          <Box flexDirection="column" justifyContent="center" flexGrow={1} paddingLeft={1}>
            <Text dimColor>Type a message to begin. /help lists commands.</Text>
            <Text dimColor>Tab moves to the sidebar. ↑↓ or the wheel scroll back; Esc interrupts a turn. Ctrl+C twice quits.</Text>
          </Box>
        )}
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginBottom={-clamped}>
          {above && clamped > 0 && (
            <Box flexShrink={0}>
              <Text dimColor>{start > 0 ? '↑ earlier · keep scrolling' : '↑ earlier'}</Text>
            </Box>
          )}
          {shown.map((id) => (
            <Box key={id} flexDirection="column" flexShrink={0}>
              <LiveRow id={id} transcript={transcript} />
            </Box>
          ))}
        </Box>
      </Box>
      {clamped > 0 && (
        <Box flexShrink={0}>
          <Text color="yellow">{`↓ ${String(clamped)} more line${clamped === 1 ? '' : 's'}${live ? ' · streaming' : ''} · Esc to follow`}</Text>
        </Box>
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* A finished transcript, drawn once                                          */
/* -------------------------------------------------------------------------- */

export interface ReplayRowsProps {
  /** Events from a store, in order. Nothing here is live. */
  readonly events: readonly AgentEvent[];
  /** Rows to show from the end; the rest is summarised in one line. */
  readonly maxRows?: number;
}

/**
 * What a delegated agent did, or any other stored stretch of events, run
 * through the same reducer as the live transcript and drawn from the tail.
 * Synchronous scheduler, so the rows exist by the time this returns.
 */
export function ReplayRows({ events, maxRows = 60 }: ReplayRowsProps): React.JSX.Element {
  const snapshots = useMemo(() => {
    const model = new TranscriptModel(syncScheduler);
    for (const event of events) model.apply(event);
    model.flush();
    return inOrderOfStart(model.getRowsSnapshot(), model)
      .map((id) => snapshotRow(id, model, id))
      .filter((snapshot): snapshot is Snapshot => snapshot !== null);
  }, [events]);
  const shown = snapshots.slice(-maxRows);
  return (
    <Box flexDirection="column">
      {snapshots.length === 0 && <Text dimColor>Nothing recorded.</Text>}
      {snapshots.length > shown.length && (
        <Text dimColor>⋯ {String(snapshots.length - shown.length)} earlier rows not shown</Text>
      )}
      {shown.map((snapshot) => (
        <RowContent key={snapshot.key} snapshot={snapshot} />
      ))}
    </Box>
  );
}
