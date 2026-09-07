/**
 * The transcript pane.
 * ============================================================================
 *
 * THE PERFORMANCE CONTRACT. This is the app's hot path and the rules below are
 * not stylistic — breaking any one of them turns a fast provider's output into
 * O(items) work per token:
 *
 *  1. **The list renders ids, not items.** `useTranscriptRows` fires only when
 *     the transcript's *shape* changes — a block appears, or it is reset. A
 *     token never touches it, so `Transcript` itself does not re-render while
 *     text streams.
 *  2. **Every row is memoised and fetches its own item.** `useTranscriptItem`
 *     subscribes to one id, so a `text.delta` notifies exactly one leaf.
 *     `Row` is wrapped in `memo` so a structural change (some *other* block
 *     appearing) does not re-render the rows that did not change.
 *  3. **Streaming text is never markdown.** Markdown is parsed once, when the
 *     block completes. Re-parsing a long answer on every frame is the single
 *     most expensive thing this UI could do. What a streaming block renders
 *     instead is `StreamingText`, which fades in each new word and holds the
 *     same rule one level down: the cost is per word *arriving*, never per word
 *     on screen.
 *  4. **Nothing here reads streaming text into `useApp`.** The transcript model
 *     lives outside React on purpose; see `state/transcript.ts`.
 *
 * A consequence worth knowing: the scroll follower uses a `ResizeObserver` on
 * the content element rather than an effect on the id list, because streaming
 * text grows the content without changing the list at all.
 *
 * The scroll container here is a plain overflow div rather than shadcn's
 * `ScrollArea` — also deliberate. Tail-following needs direct `scrollTop`
 * control of the real scroller, and Radix's viewport is an internal element
 * this version does not hand back.
 *
 * ============================================================================
 * THIS IS THE ONLY COLUMN.
 *
 * There is no detail pane to send anything to, so everything a tool call
 * produced expands *in place*: a one-line summary that opens to reveal the full
 * input and output, a file edit that opens as a real diff, and a permission
 * prompt that is answered where it happened. Rule 2 above is what makes that
 * affordable — an expanded row's open state is local to the row, and the row is
 * memoised on its own id, so opening one cannot re-render the rest and a
 * streaming sibling cannot collapse it.
 *
 * ============================================================================
 * THE LAYOUT: A SPINE, AND TWO SIDES OF A CONVERSATION
 *
 * Every row is a fixed label gutter (the *spine*) beside a content column. The
 * spine carries the tone system — `work` in cyan, `thinking` in sage, `end` in
 * mint or amber or signal — which is how the pane stays scannable at a glance
 * now that the content column is much wider than it used to be.
 *
 * `align` flips the whole row, gutter included, so a user turn puts its label
 * on the right where the bubble is. That is the back-and-forth: the user speaks
 * from the right in a filled beam bubble, everything the agent does answers
 * from the left.
 *
 * Four choices inside that worth stating, because each had an obvious
 * alternative:
 *
 *  - **`Bubble` only — `components/ui/message` is not used.** `Message` is the
 *    registry's full chat row: avatar slot, header, footer, group. This pane
 *    needs one of those four, and a row that is three flex utilities long is
 *    not worth a second component system layered over the first. The row div
 *    below still declares `group/message` and `data-align`, because those are
 *    the hooks `bubble.tsx` itself selects on — renaming the group would
 *    quietly break a vendored file's own styling.
 *  - **The user bubble is `surface`, not `default`.** `default` fills with
 *    `--primary`, which here is beam at 73% lightness. A one-line prompt would
 *    survive that; a pasted twenty-line spec is a floodlight in a dark room
 *    someone is sitting in for eight hours. `surface` is `--wash-user` — the
 *    same beam at 24% over whatever is beneath it — so a prompt is unmistakably
 *    "yours", legible in `--ink`, and quiet at any length.
 *  - **The agent bubble is `ghost`.** Agent output here is code-heavy markdown
 *    — fenced blocks, tables, diff-adjacent prose — not chat banter. A filled
 *    80%-wide blob would both squeeze the code and fight `.md`, which already
 *    draws its own wells and rules. Ghost strips the chrome and lets the answer
 *    read as full-width prose, which is what it is.
 *  - **No avatar on either side.** An agent turn used to carry the mark of the
 *    provider that answered, on the grounds that with two accounts signed in
 *    *which model wrote this* is a fact about the transcript. It is — and it is
 *    a fact that does not change from row to row, so it was the same disc
 *    repeated down the whole thread, once per paragraph, while the status line
 *    and the header both name the provider already. What it cost was the thing
 *    the design otherwise protects: a turn's gutter is now empty until the
 *    pointer arrives with its clock. A subagent still gets its word, because
 *    that one *does* differ per row.
 *
 * Thinking, tool calls, permissions, notices and run-ends are NOT conversation
 * turns and are not bubbles. They stay the compact rows that expand in place,
 * aligned onto the same spine so the column reads as one thread.
 *
 * ============================================================================
 * A STRETCH OF WORK ARRIVES AS ONE MARKER, NOT FORTY ROWS
 *
 * A turn that touches forty files used to be forty rows of machinery between
 * two sentences of answer. A run of *machinery* — the model's thinking and the
 * calls it makes, in whatever order they interleave — is folded into a single
 * activity marker, "Ran 36 commands, read 6 files, used a tool", that expands
 * in place to the individual pieces, each still the card it always was.
 *
 * Thinking is in the fold because leaving it out undid the fold. A real turn
 * emits `thinking / tool / thinking / tool …`, so grouping only the calls left
 * a marker around each single call with a thinking row wedged between every
 * pair — nine rows saying, between them, "the agent worked on this". The
 * boundary that matters to a reader is not "was this a tool call", it is "did
 * anyone say anything": the burst runs until the agent speaks.
 *
 * The folding happens in the transcript model, not here, and that is forced by
 * rule 1 rather than chosen: grouping is a question about neighbours, and a row
 * that looked at its neighbours would have to read items during render. See
 * `ActivityGroup` in `state/transcript.ts` for how it stays off the per-token
 * path.
 *
 * What this file owns is the phrasing and the icons, and one rule about both: a
 * failure is never summarised away. A group holding an error or a denial says
 * so on the collapsed line and opens itself, because "Ran 36 commands" reading
 * identically whether or not one of them failed is the single worst thing this
 * marker could do.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  AppWindowIcon,
  ArrowDownIcon,
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  ListChecksIcon,
  PlugIcon,
  SearchIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  TerminalIcon,
  GitForkIcon,
  Undo2Icon,
  CircleStopIcon,
  HourglassIcon,
  PaperclipIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';

import { attachmentBytes, isImageAttachment } from '@rx-artemis/protocol';

import { useFold } from '../hooks/useFold';
import { useCapability } from '../hooks/useCapability';
import { useActivityGroup, useTranscriptItem, useTranscriptRows } from '../hooks/useTranscript';
import { recallFold, rememberFold } from '../lib/foldMemory';
import { formatBytes } from '../lib/attachments';
import { detectArtifact } from '../lib/artifact';
import { detectFileEdit } from '@rx-artemis/transcript';
import { previewablePath } from '../lib/preview';
import {
  activeCapabilities,
  blankTranscript,
  interruptRun,
  isLive,
  openFile,
  openPreview,
  rewindConversationTo,
  useApp,
  type ConversationWidth,
} from '../state/store';
import type { FileReference } from '../lib/filePaths';
import { ReasonButton } from './disabled-reason';
import { usePane, usePaneRef } from '../state/paneContext';
import {
  formatClock,
  formatDuration,
  formatJson,
  formatTokens,
  formatUsd,
  oneLine,
  summarizeToolInput,
} from '@rx-artemis/transcript';
import {
  TOOL_CATEGORY_ORDER,
  classifyTool,
  describeActivity,
  type ToolCategory,
} from '@rx-artemis/transcript';
import {
  isGroupId,
  type ActivityGroup,
  type AssistantItem,
  type CommandItem,
  type NoticeItem,
  type PermissionItem,
  type RunEndItem,
  type ThinkingItem,
  type ToolItem,
  type UserItem,
} from '@rx-artemis/transcript';
import { DiffView } from './DiffView';
import { ActivityIndicator } from './Activity';
import { ConversationLoading, EmptyState } from './EmptyState';
import { InlinePermission } from './InlinePermission';
import { Markdown } from './Markdown';
import { CodeBlock, Fold, StatusDot, ToneBadge, toneClasses, type Tone } from './primitives';
import { StreamingText } from './StreamingText';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Markdown parsing is skipped above this size; the cost is not worth it. */
const MARKDOWN_LIMIT = 80_000;

/**
 * How an answer reads before it is markdown — while it streams, and for the
 * rare block too large to parse. Shared so those two never drift apart and the
 * markdown swap at the end of a turn is not also a change of typeface.
 *
 * No `font-mono`: this has to match `.md`, which is sans. An answer arriving a
 * word at a time in one face and reflowing into another the instant it finished
 * was the most visible symptom of mono-by-default, because the swap happens in
 * front of the reader.
 */
const STREAMING_TEXT = 'text-sm leading-relaxed break-words whitespace-pre-wrap text-ink';

/**
 * How wide the conversation column is allowed to get.
 *
 * A static lookup, NOT `` `max-w-${width}` ``: Tailwind v4 finds classes by
 * scanning source text for literals, so an interpolated name is never generated
 * and the column would silently fall back to full-bleed. Every value here has
 * to appear verbatim somewhere in the file, and this object is that somewhere.
 *
 * `comfortable` is deliberately *wider* than the `max-w-4xl` this pane used
 * before the overhaul. The ask was a wider conversation, and the setting most
 * people never touch is the one that has to deliver it; the two steps above it
 * are for people who want more. `full` is uncapped on purpose — at that point
 * the reader has explicitly said they want the whole window, and second-guessing
 * them with a hidden prose measure would make the setting a lie.
 *
 * Exported, because this is the measure of the *column*, not of the transcript:
 * the composer and the status line sit on the same one. They used to pin
 * themselves to `max-w-4xl` while this read `max-w-5xl`, so the input and the
 * chips under it were narrower than the messages above them — the seams never
 * lined up, and the drift got worse the wider the pane was. One lookup, three
 * consumers, and the edges cannot disagree again (decided 2026-08-30, with the
 * 7D pass).
 */
export const COLUMN_MAX: Record<ConversationWidth, string> = {
  // 920px is 7D's `--w-col`, measured off the judged mockup rather than the
  // nearest Tailwind stop — `max-w-5xl` (1024) was the nearest stop, and a
  // hundred pixels of extra measure is exactly the kind of drift a judged
  // design exists to forbid.
  comfortable: 'max-w-[920px]',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

export function Transcript(): ReactElement {
  const rows = useTranscriptRows();
  // A scalar the user changes from Appearance, not transcript state — reading
  // it here costs one subscription that fires roughly never, and does not go
  // near rule 4 (which is about streaming text, not preferences).
  const width = useApp((s) => s.conversationWidth);
  /**
   * Which conversation this column is showing.
   *
   * Read for one purpose: {@link pinned} lives in a ref, and this component is
   * mounted once per column and never keyed on the conversation — so opening a
   * different session used to inherit the *previous* one's scroll state. Having
   * scrolled up to read something (which unpins) meant the next session you
   * opened did not follow its tail either, and the browser kept the old
   * `scrollTop`, landing you partway up a conversation you had just opened.
   */
  const conversationId = usePane((s) => s.run?.sessionId ?? s.resumeSessionId ?? null);
  /**
   * What the blank under zero rows means — a conversation still being read in,
   * or genuinely nothing. The store owns the answer (`blankTranscript`) so its
   * tests can hold the screen's predicate to account; this component only
   * consults it, and only when there are no rows to draw instead.
   */
  const blank = usePane(blankTranscript);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Last observed offset, to tell a user scrolling up from the box growing. */
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);

  /**
   * Re-read the pin from a scroll event.
   *
   * Unpinning asks for **evidence the user moved up**, not merely for the
   * viewport to be short of the bottom, and that is the whole correction here.
   * The follower assigns `scrollTop` as content lands; each assignment queues a
   * scroll event that is handled after further rows may have grown the box, so
   * a handler that unpinned on "not at the bottom right now" unpinned itself
   * mid-load — precisely when a session's history arrives in bulk — and nothing
   * ever pinned it again. Growth alone never moves `scrollTop` down; a person
   * does.
   *
   * Re-pinning stays unconditional at the bottom, which is what makes this
   * self-healing: scroll back down and the tail is followed again, and a
   * transcript that is cleared (the box collapses to the viewport) reads as
   * "at the bottom" and re-pins on its own.
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 48;
    const movedUp = el.scrollTop < lastTop.current;
    lastTop.current = el.scrollTop;

    if (atBottom) pinned.current = true;
    else if (movedUp) pinned.current = false;

    // Tied to the pin rather than to the distance: while the follower is still
    // catching up with a burst of rows, offering to jump to an end it is
    // already on its way to is noise.
    const wanted = !pinned.current;
    setShowJump((current) => (current === wanted ? current : wanted));
  }, []);

  /**
   * A conversation change starts at its end, always.
   *
   * The counterpart to the ref's persistence: whatever the last conversation
   * left behind, opening one is a request to see where it got to. The follower
   * below does the rest as history lands, because this leaves it pinned.
   */
  useEffect(() => {
    pinned.current = true;
    lastTop.current = 0;
    setShowJump(false);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [conversationId]);

  /**
   * Follow the tail while the user is at the bottom, and stop the moment they
   * scroll up. Observing the content box catches streaming growth, which no
   * React-level signal would.
   *
   * The turn-entry animation also grows the box for ~160ms after a turn
   * appears, so this fires a handful of extra times per turn. That is fine —
   * the handler only assigns `scrollTop` — but it is why the animation is a
   * short translate rather than a height transition, which would fight the
   * follower for as long as it ran.
   */
  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!pinned.current) return;
      viewport.scrollTop = viewport.scrollHeight;
      // Recorded here rather than left to the scroll event this assignment
      // queues: `lastTop` is "the offset we last knew about", and it has to
      // include the ones we caused. Waiting for the event would leave a stale
      // value in the window before it arrives, and a user scroll landing in
      // that window would compare against an offset from before the follower
      // moved — reading as *downward* and failing to unpin.
      lastTop.current = viewport.scrollTop;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const jumpToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        {/* Horizontal padding lives here rather than on each row so every row —
            bubble or machinery — shares one left edge for its gutter.

            `gap-3` is 7D's `--gap-msg`, and the change of heart is worth
            recording: the log-tight `gap-0.5` treated machinery rows as lines
            in a block, and the judged mockup treats every row as a card that
            breathes. Twelve pixels between cards is what makes wash-filled
            surfaces read as surfaces instead of as stripes — the fine-tuned
            7d-full.html shows exactly this rhythm on a burst of tool rows,
            and it was chosen looking at one. */}
        <div
          ref={contentRef}
          className={cn('mx-auto flex w-full flex-col gap-3 px-4 py-3.5', COLUMN_MAX[width])}
        >
          {rows.length === 0 ? (
            blank === 'loading' ? (
              <ConversationLoading />
            ) : (
              <EmptyState />
            )
          ) : (
            rows.map((id) => <Row key={id} id={id} />)
          )}
          {/* What the pane is doing, riding the conversation's tail: inside the
              content column so it sits at the bottom of the text itself —
              pushed down by every row that streams in, scrolling with the
              transcript, and sharing the column's measure so the rule crosses
              exactly the width the prose does. See `Activity.tsx`. */}
          <ActivityIndicator />
        </div>
      </div>

      {showJump ? (
        <Button
          variant="outline"
          size="xs"
          onClick={jumpToEnd}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-hairline-strong bg-float px-3 shadow-lg shadow-black/40"
        >
          <ArrowDownIcon />
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/* Row dispatch                                                               */
/* -------------------------------------------------------------------------- */

const Row = memo(function Row({ id }: { readonly id: string }): ReactElement | null {
  // A group id names a fold of several tool calls rather than one item, and
  // subscribes to a different slice of the model. Splitting before the item
  // lookup keeps `ItemRow` on the single-id subscription that rule 2 requires.
  if (isGroupId(id)) return <ActivityRow id={id} />;
  return <ItemRow id={id} />;
});

const ItemRow = memo(function ItemRow({ id }: { readonly id: string }): ReactElement | null {
  const item = useTranscriptItem(id);
  if (!item) return null;

  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />;
    case 'assistant':
      return <AssistantRow item={item} />;
    case 'thinking':
      return <ThinkingRow item={item} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'permission':
      return <PermissionRow item={item} />;
    case 'notice':
      return <NoticeRow item={item} />;
    case 'command':
      return <CommandRow item={item} />;
    case 'run-end':
      return <RunEndRow item={item} />;
    default:
      return null;
  }
});

/**
 * Shared row chrome: the label gutter and the content column.
 *
 * `w-14` is not arbitrary. `formatClock` produces `HH:MM:SS` — eight monospace
 * characters, ~53px at `text-2xs` — and the clock has to fit on one line or the
 * gutter reflows on hover and shoves every row down by a line. 3.5rem is the
 * first Tailwind step that clears it.
 *
 * The clock *cross-fades with the chrome* rather than sitting under it, and
 * that is what made this pane tight. Stacked, it reserved a second 16px line in
 * every gutter whether or not anyone was hovering — so a collapsed work marker
 * was 35px of row around 16px of content, and a one-line answer had 29px of
 * dead space beneath it. Reserving nothing means the row is exactly as tall as
 * what is in it, which is why the gap between rows could come down to 2px
 * without the thread closing up.
 *
 * Absolute-positioning the clock *below* the chrome instead would keep the
 * avatar on screen while hovering, and was tried: with rows 2px apart a revealed
 * clock paints straight over the next row's label. Swapping is the version that
 * costs no height and cannot collide.
 *
 * The gutter follows `align`: the row reverses for `end`, so a user turn's
 * label lands on the right next to its bubble. The text alignment has to flip
 * with it, hence the `group-data-[align=end]/message` override — without it the
 * label would be right-aligned against the window edge, hanging off the bubble
 * it names.
 *
 * The two group names are load-bearing and do different jobs. `group/message`
 * is what `bubble.tsx` selects on to self-align a bubble inside a reversed row,
 * so it has to keep that name even though `components/ui/message` is not used;
 * plain `group` is what the clock's hover reveal uses.
 *
 * An empty `label` renders nothing at all, which is how an agent turn and a
 * notice both get a gutter that is only the clock.
 */
function Line({
  label,
  tone = 'neutral',
  ts,
  align = 'start',
  pinLabel = false,
  children,
  className,
}: {
  readonly label: string;
  readonly tone?: Tone;
  readonly ts?: number;
  readonly align?: 'start' | 'end';
  /**
   * Keep the label while the pointer is over the row, instead of trading it for
   * the clock.
   *
   * The trade is right for most rows: the label repeats what the shape of the
   * row already says, so hovering swaps a redundancy for something you cannot
   * otherwise see. It is wrong for a row whose label is the *only* thing
   * distinguishing it from ordinary output — reasoning in the thread reads as
   * an answer without it, and it disappeared exactly when the reader pointed at
   * the passage they were trying to identify. The clock still arrives; it just
   * does not evict the one word that says what this is.
   */
  readonly pinLabel?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div
      data-align={align}
      className={cn(
        'group group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse',
        className,
      )}
    >
      <div className="relative flex w-14 shrink-0 flex-col items-end pt-px group-data-[align=end]/message:items-start">
        <div
          className={cn(
            'flex flex-col items-end gap-0.5 transition-opacity group-data-[align=end]/message:items-start',
            // Only fade for a row that has a clock to arrive in its place. A
            // pinned label never fades — see `pinLabel`.
            ts === undefined || pinLabel ? undefined : 'group-hover:opacity-0',
          )}
        >
          {label === '' ? null : (
            <div
              className={cn('chrome-label', toneClasses.text[tone])}
            >
              {label}
            </div>
          )}
        </div>
        {ts === undefined ? null : (
          <div
            className={cn(
              'pointer-events-none absolute right-0 font-mono text-2xs text-ink-faint opacity-0 transition-opacity group-hover:opacity-60 group-data-[align=end]/message:right-auto group-data-[align=end]/message:left-0',
              // Under a pinned label rather than over it: nothing is being
              // swapped out, so the two need somewhere to sit side by side.
              pinLabel ? 'top-4' : 'top-px',
            )}
          >
            {formatClock(ts)}
          </div>
        )}
      </div>
      {/* The registry's `MessageContent` uses `gap-2.5`, tuned for a chat app
          with one bubble per turn; the transcript stacks a bubble against a
          badge, so it wants a tighter rhythm. */}
      <div className="flex w-full min-w-0 flex-col gap-1 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function UserRow({ item }: { readonly item: UserItem }): ReactElement {
  const pane = usePaneRef();
  const live = usePane(isLive);
  const rewind = useCapability('rewind');
  const fork = useCapability('forkSession');
  /*
   * A settled message is a rewind point; the provider's id for it is resolved
   * when the control is used, not required before it appears — see
   * `resolveRewindAnchor` for why a live-typed row cannot have learned it.
   *
   * A live run no longer hides the pair, because it only ever had an argument
   * against one of them. Forking does not touch the conversation it branches
   * from — the provider reads the stored transcript and writes elsewhere — so
   * a working agent is no reason to withhold it, and making someone sit
   * through a long turn before they may ask the same question a different way
   * was the whole complaint. See `branchLiveConversation` for where the branch
   * goes when the column is busy. Rewind is the opposite move and stays
   * refused mid-run, disabled-with-reason rather than absent — the app's
   * standing rule, and the same treatment an unsupported *capability* gets, so
   * a Codex pane says why the control does nothing rather than lacking it.
   *
   * A pending send still hides both: there is no stored message for either to
   * anchor to yet.
   */
  const showControls = !item.pending;

  /*
   * Whether the provider has read *this* message yet.
   *
   * The pane's queued set is the one source of truth — the same array the
   * composer's strip counts — so the row and the strip can never disagree
   * about a message, which is precisely what went wrong before: the strip
   * counted sends and had no way to hear a delivery, so it went on announcing
   * a queued message while the agent was already acting on it.
   *
   * Keyed on the message's own identity where it has one, and on the row's
   * local id where it does not. Both are what `submitPrompt` filed the steer
   * under, in the same order of preference, so the lookup and the write agree
   * without either needing to know why the id might be missing.
   *
   * A boolean out of the selector rather than the array, for zustand's sake:
   * an array identity is rebuilt whenever the run object is, and every settled
   * user row in a long conversation subscribes to this.
   */
  const key = item.messageId ?? item.id;
  const queued = usePane((s) => (isLive(s) ? (s.run?.queuedSteers?.includes(key) ?? false) : false));

  return (
    <Line label="you" tone="beam" ts={item.ts} align="end" className="turn-in mt-2 group/turn">
      <Bubble
        align="end"
        /*
         * A wash of the accent, not the accent.
         *
         * This was `tinted`, which derives its fill from `--primary` at reduced
         * chroma and computed a different colour in each theme; then it was a
         * neutral surface, which lost the one thing a prompt bubble is for.
         * `surface` is now 7D's own answer — `--wash-user`, 24% beam over
         * whatever is beneath — so the most repeated element in the app is
         * unmistakably the user's without being lit up.
         *
         * `surface` is a variant of its own rather than `ghost` plus classes.
         * `ghost` is the "no bubble at all" variant — it zeroes the radius, the
         * padding and the width cap at a specificity the caller cannot beat,
         * which is exactly what it did when this was first written: the prompt
         * came out as a full-width square with no padding.
         */
        variant="surface"
        // Dimmed means "Artemis has not confirmed delivery" — a prompt whose
        // call failed stays dimmed on purpose.
        className={cn(item.pending && 'opacity-70')}
      >
        {/* Sans, matching the composer the text was typed into: a prompt should
            look the same after it is sent as it did while it was being written.
            That symmetry is why this moved off mono with the composer and not
            separately — a path or a shell fragment inside a prompt is a fragment
            of a sentence, and backticks around it get a mono `code` span from
            `.md` on the agent's side anyway.

            `whitespace-pre-wrap` stays, and is now the only thing preserving the
            shape of a pasted block here: line breaks and runs of spaces survive,
            columns no longer line up. A prompt that is really a wall of code
            belongs in backticks or a file, not in the bubble's own typeface.

            One radius, off the scale — 7D's `--r-bub` is the same 8px every card
            in the pane takes, which `rounded-lg` now is. The tail went with it:
            a square corner cut into a 21px radius was legible, and cut into an
            8px one it is a rendering artefact. Alignment and the accent wash are
            what say who spoke, and both say it louder than a corner did. */}
        <BubbleContent className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
          {/* Attachments above the text, in the order the model receives them.
              A transcript that showed them the other way round would be a
              record of a prompt nobody sent.

              `items-start` because the row mixes a tall thumbnail with short
              chips, and flexbox's default `stretch` would blow each chip up to
              the image's height. */}
          {item.attachments && item.attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap items-start justify-end gap-1.5">
              {item.attachments.map((attachment) =>
                isImageAttachment(attachment) ? (
                  <img
                    key={attachment.id}
                    src={`data:${attachment.mediaType};base64,${attachment.data}`}
                    alt={attachment.name ?? 'Attached image'}
                    title={attachment.name ?? 'Attached image'}
                    // Capped rather than full-bleed: a tall screenshot at full
                    // width would push the prompt it belongs to off the screen,
                    // and this is a record of what was sent, not a viewer.
                    className="max-h-48 max-w-full rounded-md border border-hairline object-contain"
                  />
                ) : (
                  /* A file has no picture, so the record of it is its name and
                     size — the same two facts the agent was given. Deliberately
                     not a link: the staged copy is deleted when the run ends,
                     and a control that stops working after a minute is worse
                     than no control. */
                  <span
                    key={attachment.id}
                    title={`${attachment.name} — ${formatBytes(attachmentBytes(attachment))}`}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-hairline px-2 py-1 font-mono text-2xs text-ink-muted"
                  >
                    <PaperclipIcon className="size-3 shrink-0" />
                    <span className="truncate text-ink">{attachment.name}</span>
                    <span className="shrink-0">{formatBytes(attachmentBytes(attachment))}</span>
                  </span>
                ),
              )}
            </div>
          ) : null}
          {item.text}
        </BubbleContent>
      </Bubble>

      {/*
        Rewind and fork, under the turn they act on.

        Hover-revealed rather than always drawn, because they repeat under
        every settled user turn and are wanted at most once a conversation —
        but revealed by *the row's* hover, not the buttons' own, so they are
        discoverable by pointing anywhere near the message. Order matches
        destructiveness read right-to-left toward the bubble's tail: fork (the
        reversible one — the original survives) sits outward, rewind against
        the tail.

        Both put the message's text back in the composer; the difference is
        what happens to everything after it. Fork leaves this conversation
        whole and branches a new one; rewind winds this one back. See
        `rewindConversationTo`.

        And, while the provider has not read this message yet, two more: what
        state it is in, and the lever that changes it. They belong here rather
        than beside the bubble because they are about *this* message, and the
        composer's strip — which asks the coarser question, is anything
        waiting — is too far from it to answer "did it hear what I just
        typed". Both surfaces read the pane's one queued set, which is what
        stops them from ever disagreeing about a message.
      */}
      {showControls ? (
        <span
          className={cn(
            'mt-0.5 flex items-center gap-0.5 self-end transition-opacity',
            /*
              Held open while the message is waiting. The rest of this row is
              hover-revealed because a rewind is wanted at most once a
              conversation, but a delivery state is not an action — it is the
              answer to "did it hear me", which is the question being asked at
              exactly the moment nobody is pointing at anything. It goes back
              to hiding the instant the message is read, which is the whole
              behaviour: the indicator resolves by leaving.
            */
            queued
              ? 'opacity-100'
              : 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100',
          )}
        >
          {queued ? (
            <>
              {/* The strip's wording, in the space a row has for it. The
                  composer says where the message sits in the provider's
                  schedule; under the message itself that is already implied,
                  so this says only which of the two states it is in. */}
              <span
                title="Sent into a turn that was already running — the agent reads it at its next pause, or after this turn"
                className="mr-1 flex items-center gap-1 rounded-md border border-hairline bg-wash px-1.5 py-0.5 text-2xs text-ink-muted"
              >
                <HourglassIcon className="size-3 shrink-0" aria-hidden="true" />
                Queued
              </span>
              {/*
                The same lever the composer offers, aimed from the message it
                is about. Interrupting does not discard the queue — the CLI
                keeps queued messages across an interrupt by design, which is
                what makes "stop and read this now" a safe thing to offer at
                all — so this changes when the message is read and nothing
                else. It is the interrupt, not a re-send: the message is
                already with the provider.
              */}
              <ReasonButton
                variant="ghost"
                tooltip="Read it now — interrupt what the agent is doing so it takes this message up"
                aria-label="Interrupt the turn so this message is read now"
                onClick={() => void interruptRun(pane)}
                className="size-auto rounded-sm p-1 text-ink-faint outline-none hover:bg-wash-strong hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <CircleStopIcon className="size-3" aria-hidden="true" />
              </ReasonButton>
            </>
          ) : null}
          <ReasonButton
            variant="ghost"
            disabled={!fork.supported}
            disabledReason={fork.reason}
            tooltip="Fork from here — branch a new conversation, keeping this one"
            aria-label="Fork the conversation from this message"
            onClick={() => void rewindConversationTo(item.id, { fork: true }, pane)}
            className="size-auto rounded-sm p-1 text-ink-faint outline-none hover:bg-wash-strong hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <GitForkIcon className="size-3" aria-hidden="true" />
          </ReasonButton>
          <ReasonButton
            variant="ghost"
            disabled={!rewind.supported || live}
            disabledReason={
              rewind.supported
                ? 'This conversation is still being written — wait for the turn to finish, or fork instead.'
                : rewind.reason
            }
            tooltip="Rewind to here — wind the conversation back to before this message"
            aria-label="Rewind the conversation to before this message"
            onClick={() => void rewindConversationTo(item.id, { fork: false }, pane)}
            className="size-auto rounded-sm p-1 text-ink-faint outline-none hover:bg-wash-strong hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Undo2Icon className="size-3" aria-hidden="true" />
          </ReasonButton>
        </span>
      ) : null}
    </Line>
  );
}

function AssistantRow({ item }: { readonly item: AssistantItem }): ReactElement {
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  /*
   * Stable across the row's life, so `Markdown`'s memo keeps holding: an
   * identity that changed every render would re-parse the answer on every
   * keystroke in the composer below it. `pane` is a handle rather than a value,
   * so it does not change as the conversation does — and `cwd` moves only when
   * the user points this column somewhere else, which is exactly when the paths
   * in the answer above resolve to different files and *should* be re-checked.
   */
  const files = useMemo(
    () => ({ cwd, open: (reference: FileReference) => void openFile(reference, pane) }),
    [cwd, pane],
  );

  // Which repository a bare `#123` in the answer names — the directory's
  // origin, read once per workspace change. Stable for the same reason `cwd`
  // is: it moves only when the column points somewhere else.
  const repo = usePane((s) => s.workspace?.github ?? null);

  return (
    <Line
      // No word for the main agent: the shape of the row already says whose
      // turn this is, and a word repeated under every paragraph is the same
      // clutter the provider mark was. A subagent still needs one — that is a
      // fact about *this* row rather than about the whole thread.
      label={item.agentId ? 'subagent' : ''}
      tone="neutral"
      ts={item.ts}
      className="turn-in mt-1.5"
    >
      {/* `ghost` zeroes the padding and the fill, so `.md` renders against the
          page exactly as it did before the bubbles landed and needs no
          bubble-specific overrides. `w-full` replaces `BubbleContent`'s default
          `w-fit`: a shrink-wrapped answer would let one long line decide how
          wide the tables and code blocks below it are allowed to be. */}
      <Bubble variant="ghost">
        <BubbleContent className="w-full">
          {item.streaming ? (
            <StreamingText text={item.text} className={STREAMING_TEXT} />
          ) : item.text.length > MARKDOWN_LIMIT ? (
            <div className={STREAMING_TEXT}>{item.text}</div>
          ) : (
            <div className="md text-ink">
              <Markdown files={files} repo={repo}>{item.text}</Markdown>
            </div>
          )}
        </BubbleContent>
      </Bubble>
      {item.stopReason && item.stopReason !== 'end_turn' && item.stopReason !== 'tool_use' ? (
        <ToneBadge tone="amber" className="w-fit">
          stop: {item.stopReason}
        </ToneBadge>
      ) : null}
    </Line>
  );
}

/**
 * The marks a preview should not be showing the reader.
 *
 * Reasoning arrives as markdown often enough that the collapsed line was
 * regularly `**Planning the retry path**` — the syntax spent on emphasis nobody
 * can see in a 64-character excerpt. Only the unambiguous ones are stripped:
 * a lone `*` or `_` is as likely to be a glob or a `snake_case` identifier as it
 * is to be italics, and mangling a path to un-italicise nothing is a worse
 * trade than leaving one asterisk in.
 */
const PREVIEW_MARKS = /^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+|\*\*|__|~~|`/gm;

/** The one line of it worth showing collapsed. */
function thinkingPreview(item: ThinkingItem): string {
  if (item.redacted) return 'redacted by the provider';
  return oneLine(item.text.replace(PREVIEW_MARKS, ''), 64) || 'thinking…';
}

/**
 * Whether this block is markdown, or prose that merely contains a hyphen.
 *
 * The model writes its reasoning in markdown much of the time — bold headers on
 * each move, numbered plans, a fenced snippet it is about to write — and
 * rendering that as literal asterisks was the complaint. Parsing *everything*
 * would be the shorter code and the wrong behaviour: plain reasoning is full of
 * `snake_case`, indented pasted output and bare URLs, all of which markdown has
 * opinions about, and none of which the model meant as markup.
 *
 * So the block has to show a tell. Each alternative below is a construct that
 * does not occur by accident: paired emphasis, an ATX heading, a list marker at
 * the start of a line, a fence, backticked code, a blockquote, a link.
 */
const MARKDOWN_TELL =
  /\*\*[^*\n]+\*\*|(?:^|\n)\s{0,3}#{1,6}\s|(?:^|\n)\s{0,3}(?:[-*+]|\d+[.)])\s|```|`[^`\n]+`|(?:^|\n)\s{0,3}>\s|\[[^\]\n]+\]\([^)\s]+\)/;

/** What a withheld block says instead of itself. */
const REDACTED = 'This thinking block was encrypted or withheld by the provider.';

/**
 * A block the provider withheld: the machine's own notice, in a machine's own
 * box.
 *
 * The one square surface left in the thinking row, and the reason it survived
 * the rest of it going: this is not the model thinking where you can read it,
 * it is the transport telling you there is nothing to read. `rounded-none` is
 * `--radius-machine` — see the note beside it in `index.css`, which names this
 * block by name.
 */
function RedactedBlock(): ReactElement {
  return (
    <div className="rounded-none border border-hairline bg-wash px-3 py-2 font-mono text-2xs leading-relaxed text-ink-faint">
      {REDACTED}
    </div>
  );
}

/**
 * How reasoning reads before it is markdown — and, for a block that never
 * becomes markdown, permanently.
 *
 * The answer's own measure and leading, one colour down. Everything that used to
 * separate the two is gone: the rule down the left, the 3px of indent it stood
 * in, the 11px size and the italic. Each of them was a way of saying "this is an
 * aside" a second time, and stacked they turned a long stretch of reasoning into
 * a column of its own running down the side of the conversation — the thing to
 * scroll past rather than the thing to read. The label in the gutter says what
 * the row is; `--ink-muted` says it is not the answer; the text sits on the same
 * left edge as every other sentence in the pane and reads like one.
 */
const THINKING_TEXT = 'text-sm leading-relaxed break-words whitespace-pre-wrap text-ink-muted';

/**
 * The block itself.
 *
 * Three ways it can be drawn, in the order they are tested:
 *
 *  - **A notice**, for a block the provider withheld — the one square surface
 *    left in this row, and the reason it survived.
 *  - **Plain text**, while it streams, when it is too large to parse, or when
 *    it is prose rather than markup. Streaming stays plain per rule 3 in the
 *    header: the text grows in place as the model writes it, at one text node
 *    per flush rather than a parse per frame.
 *  - **Markdown**, once the block is settled and shows a {@link MARKDOWN_TELL}.
 *    The model writes its reasoning in markdown constantly and a fold full of
 *    `**` and `-` was the reader doing the parsing by eye.
 *
 * `md-quiet` is what keeps a heading inside reasoning from being drawn in
 * `--ink`: the markdown is styled like the answer's, in the aside's colour. No
 * `files` or `repo` — a path the model muttered to itself is not an invitation
 * to open a file, and the link machinery would be a subscription per span on
 * text nobody is clicking.
 */
function ThinkingBody({ item }: { readonly item: ThinkingItem }): ReactElement {
  if (item.redacted) return <RedactedBlock />;
  if (item.streaming || item.text.length > MARKDOWN_LIMIT || !MARKDOWN_TELL.test(item.text)) {
    return <div className={THINKING_TEXT}>{item.text}</div>;
  }
  return (
    <div className="md md-quiet text-ink-muted">
      <Markdown>{item.text}</Markdown>
    </div>
  );
}

/**
 * A stretch of reasoning, standing in the thread where the model wrote it.
 *
 * One row per *stretch*, not per provider block: consecutive thinking blocks are
 * merged in the model, so what used to be eight folds down the side of the pane
 * — each holding one sentence, with the calls that separated them sunk into the
 * marker below — is the paragraph of working-out it always was. The thing that
 * ends a stretch is the agent saying something. See `thinkingRow` in
 * `state/transcript.ts`.
 *
 * A bare fold on the spine rather than a card, because this is the only shape
 * it takes: reasoning is a message in the thread, sitting where the model wrote
 * it, and never a member of the marker at the foot of the run.
 *
 * Open by default, which is what the switch begins at. The collapsed line is
 * still worth keeping: it is how a reader who wants the reasoning in general
 * gets past the one block that turned out to be four thousand words about a
 * typo.
 */
function ThinkingRow({ item }: { readonly item: ThinkingItem }): ReactElement {
  const shown = useApp((s) => s.showThinking);
  /*
   * The one fold in the app that holds its own state, and hands it to `Fold`
   * rather than letting `useFold` keep it. What `useFold` cannot do is re-seed:
   * its default is read once per mount, which is exactly right for a fold whose
   * default is a fact about the block, and wrong here, where the default is a
   * switch the reader can move while looking at the row. A standalone thinking
   * row keeps its id when the switch flips and so is never remounted — it would
   * have sat there closed while the pane rearranged around it, the setting
   * looking broken at the precise moment it is being tried.
   *
   * So: remembered choice first, then the switch — and the switch *moving* is
   * itself an instruction, which is what the adjustment below says. It is the
   * React-documented shape for state derived from a changing input (no effect,
   * no second paint), and it means a per-block click wins until the reader
   * makes a statement about all of them.
   */
  const [open, setOpen] = useState(() => recallFold(item.id) ?? shown);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    setOpen(shown);
  }

  const toggle = (next: boolean): void => {
    setOpen(next);
    // Remembered per block, so a reader who collapsed one long block finds it
    // collapsed on the way back up.
    rememberFold(item.id, next);
  };

  return (
    <Line label="thinking" tone="sage" ts={item.ts} pinLabel>
      <Fold
        open={open}
        onOpenChange={toggle}
        triggerClassName="text-2xs"
        summary={
          <span className="flex min-w-0 items-center gap-1.5 text-sage/80">
            <BrainIcon className="size-3 shrink-0" aria-hidden="true" />
            {/* Open, the excerpt would be the next line repeated — so the header
                falls back to naming itself, the way the card's does. Closed, the
                excerpt is the only thing saying what is in there, and it is set
                in the prose face because it is prose, unlike a tool row's
                preview, which is a real command. */}
            {open ? (
              <span className="shrink-0 chrome-label">thinking</span>
            ) : (
              <span className="truncate text-2xs">{thinkingPreview(item)}</span>
            )}
            {item.streaming ? <StatusDot tone="sage" pulse /> : null}
          </span>
        }
      >
        {/* One treatment, however the block came to be open. The switch decides
            whether reasoning is on screen; it was never a reason for the prose
            under it to be set differently, and the two shapes it used to have
            differed by a pixel of type size and the colour of a rule that has
            since gone. */}
        <ThinkingBody item={item} />
      </Fold>
    </Line>
  );
}

/**
 * A tool call that is a row of its own rather than a member of a burst.
 *
 * Two things arrive here, and the gutter label is the whole reason this is not
 * one line inside `ItemRow`:
 *
 *  - **An artifact.** The model deliberately keeps these out of the fold, so
 *    that a page the agent made is visible and openable without first opening a
 *    dropdown labelled "edited 5 files" — see `ActivityGroup` in
 *    `state/transcript.ts`. It gets its own label, because `tool` in the gutter
 *    beside a tile that says `report.html` describes the mechanism at exactly
 *    the moment the reader has stopped caring about it.
 *  - **An escapee.** A call that ended up ungrouped for any other reason. The
 *    bare card under a `tool` label is the honest fallback it always was.
 *
 * The artifact test is repeated here rather than threaded down from the model,
 * which is a real duplicate parse — but only of the rows that reach top level,
 * and after the hoist that is the artifacts and almost nothing else. Paying it
 * on a handful of rows per session is the cheaper half of the trade against
 * putting `cwd` into `ToolCard`'s props and out of its own memo.
 */
function ToolRow({ item }: { readonly item: ToolItem }): ReactElement {
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const artifact = useMemo(
    () =>
      item.status === 'ok'
        ? detectArtifact(detectFileEdit(item.name, item.input), cwd, platform)
        : null,
    [item.name, item.input, item.status, cwd, platform],
  );

  return (
    <Line
      label={artifact ? 'artifact' : 'tool'}
      tone={artifact ? 'sage' : 'cyan'}
      ts={item.ts}
      className={artifact ? 'my-1' : undefined}
    >
      <ToolCard item={item} />
    </Line>
  );
}

const TOOL_TONE: Record<ToolItem['status'], Tone> = {
  running: 'cyan',
  ok: 'mint',
  error: 'signal',
  denied: 'amber',
  cancelled: 'neutral',
};

/**
 * A tool call: one compact card that expands in place.
 *
 * Collapsed it is icon + name + primary argument, which is all a reader needs
 * to follow what the agent is doing. Expanded it reveals the full input and
 * output — and, when the call edits a file, a diff instead of two walls of
 * quoted string.
 *
 * Not a bubble, and that is the point: a tool call is not something anyone
 * said. It keeps card chrome so the eye can tell work from speech without
 * reading a word.
 *
 * No `Line` of its own: these are rendered inside an expanded {@link
 * ActivityRow}, which owns the gutter for the whole burst. A card that drew its
 * own spine would put a second `tool` label under the marker's.
 *
 * Open state is local, which is what lets it survive the re-renders driven by
 * the external transcript store — and remembered under the call's own id, so
 * opening a card, leaving the session and coming back does not close it again.
 * The two folds *inside* it keep their own memory, keyed off the same id: a
 * reader who opened the result and closed the input meant both.
 */
function ToolCard({ item }: { readonly item: ToolItem }): ReactElement {
  const [open, setOpen] = useFold(item.id);
  const tone = TOOL_TONE[item.status];
  const summary = item.title ?? summarizeToolInput(item.input);
  const failed = item.status === 'error' || item.status === 'denied';
  const Icon = CATEGORY_ICON[classifyTool(item.name)];

  // Recomputed only when the arguments change, which for a tool call is once:
  // `tool.end` carries the result, not a new input. A diff is cheap but not
  // free, and this row can be re-rendered by its own status transition.
  const edit = useMemo(() => detectFileEdit(item.name, item.input), [item.name, item.input]);

  // The pane this card is in, so a preview opens against *this* column's
  // working directory and reports a failure into *this* column's transcript.
  // One subscription that fires on a focus change and never on a token.
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const previewable = useMemo(
    () => previewablePath(edit, cwd, platform),
    [edit, cwd, platform],
  );

  /*
   * The stronger question, asked of the same parse — see `lib/artifact.ts`. A
   * hit replaces the tool row with a tile, so it is deliberately much harder to
   * satisfy than `previewable` above: this one hides a diff, and that is only
   * the right trade for a file whose *rendering* is the point.
   *
   * Never for a call that failed, for the reason the Preview button gives
   * below — there is no file behind a tile whose write was denied.
   */
  const artifact = useMemo(
    () => (item.status === 'ok' ? detectArtifact(edit, cwd, platform) : null),
    [edit, cwd, platform, item.status],
  );

  return (
    <div
      /*
       * 7D's `.step`: a wash of the ink, a hairline, and the 8px every card in
       * the pane takes. The fill is `--wash` rather than a step down the grey
       * scale, so the card sits on whatever surface the column is drawn on and
       * reads the same in both themes.
       *
       * The hairline goes to 12% for a card that is open or holding an
       * artifact — the two states that have earned an edge you can see — and
       * neither carries a second fill, because a card that changes colour when
       * you open it reads as a state change rather than a disclosure.
       */
      className={cn(
        'rounded-lg border bg-wash',
        failed ? 'border-signal/35' : 'border-hairline',
        open && !failed && 'border-hairline-strong',
        artifact && 'border-hairline-strong',
      )}
    >
      {/*
        An artifact takes the row rather than adding to it.

        The tool call is still there — the disclosure below opens to the same
        diff and the same raw arguments any other write has — but what the row
        *says* changes: a page the agent made is named by its title and its
        kind, not by the tool that happened to produce it. `Write` and
        `/tmp/a1b2/report.html` are facts about the mechanism, and the mechanism
        is not what the reader is looking for once the thing itself exists.
      */}
      {artifact ? (
        <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Hide the diff' : 'Show the diff'}
            className="shrink-0 rounded-sm p-0.5 text-ink-faint outline-none hover:bg-wash-strong focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronRightIcon
              className={cn('size-3 transition-transform', open && 'rotate-90')}
              aria-hidden="true"
            />
          </button>

          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-wash-strong">
            {artifact.kind === 'page' ? (
              <AppWindowIcon className="size-3.5 text-cyan" aria-hidden="true" />
            ) : (
              <FileTextIcon className="size-3.5 text-sage" aria-hidden="true" />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-col">
            <span title={artifact.path} className="truncate text-xs font-semibold text-ink">
              {artifact.title}
            </span>
            <span className="truncate font-mono text-2xs text-ink-faint">
              {artifact.kind === 'page' ? 'page' : 'markdown'}
              {artifact.bytes === undefined ? '' : ` · ${formatBytes(artifact.bytes)}`}
              {artifact.fresh ? '' : ' · edited'}
            </span>
          </span>

          <Button
            variant="outline"
            size="xs"
            onClick={() => void openPreview(artifact.path, pane)}
            className="shrink-0"
          >
            <SquareArrowOutUpRightIcon />
            Open
          </Button>
        </div>
      ) : null}

      {/*
        A row rather than a single button, because the preview action cannot
        live inside the disclosure control: a button nested in a button is
        invalid markup, and the browsers that tolerate it fire both handlers, so
        opening a preview would also toggle the card underneath it.
      */}
      {artifact ? null : (
      <div className="flex w-full min-w-0 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-wash-strong focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Icon
            className={cn(
              'size-3 shrink-0',
              item.status === 'running' ? 'text-cyan' : 'text-ink-faint',
            )}
            aria-hidden="true"
          />
          <span className="shrink-0 font-mono text-xs font-semibold text-ink">{item.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">
            {summary}
          </span>
          {/* A file edit advertises its size in the collapsed row. Whether an
              edit touched three lines or three hundred is the single most
              useful thing to know before deciding to open it. */}
          {edit && !edit.whole ? (
            <span className="shrink-0 font-mono text-2xs">
              <span className="text-mint">+{edit.added}</span>{' '}
              <span className="text-signal">−{edit.removed}</span>
            </span>
          ) : null}
          {item.durationMs === undefined ? null : (
            <span className="shrink-0 font-mono text-2xs text-ink-faint">
              {formatDuration(item.durationMs)}
            </span>
          )}
          <ToneBadge tone={tone}>
            {item.status === 'running' ? <StatusDot tone="cyan" pulse /> : null}
            {item.status}
          </ToneBadge>
        </button>

        {/*
          Only for a call that *succeeded*. A write that errored, was denied or
          was cancelled left no file — or left half of one — and a Preview button
          beside a red badge would be an invitation to open something that is not
          there, answered by a failure a moment later.
        */}
        {previewable !== null && item.status === 'ok' ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void openPreview(previewable, pane)}
            className="mr-2 shrink-0"
          >
            <SquareArrowOutUpRightIcon />
            Preview
          </Button>
        ) : null}
      </div>
      )}

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-hairline px-2.5 py-2">
          {edit ? <DiffView edit={edit} /> : null}

          <Fold
            // The raw arguments stay available even when a diff was rendered:
            // the diff is a reading of the input, and the input is the record.
            defaultOpen={edit === null}
            rememberAs={`${item.id}:input`}
            triggerClassName="text-2xs"
            summary={
              <span className="font-mono text-2xs">{edit ? 'raw arguments' : 'input'}</span>
            }
          >
            <CodeBlock text={formatJson(item.input)} />
          </Fold>

          {item.status === 'running' ? (
            <p className="font-mono text-2xs text-cyan">still running…</p>
          ) : (
            <Fold
              // A failure opens itself. Everything else stays folded: a
              // successful `Read` of a 4,000-line file is noise.
              defaultOpen={failed}
              rememberAs={`${item.id}:result`}
              triggerClassName="text-2xs"
              summary={
                <span className={cn('font-mono text-2xs', failed && 'text-signal')}>
                  {failed ? 'error' : 'result'}
                </span>
              }
            >
              <CodeBlock
                tone={failed ? 'error' : 'neutral'}
                text={
                  item.error
                    ? `${item.error.code}: ${item.error.message}\n\n${item.resultText ?? formatJson(item.result)}`
                    : (item.resultText ?? formatJson(item.result))
                }
              />
            </Fold>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The activity marker                                                        */
/* -------------------------------------------------------------------------- */

/** One glyph per category, for the marker's icon cluster and each tool card. */
const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  command: TerminalIcon,
  edit: FilePenLineIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: BotIcon,
  plan: ListChecksIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
};

/** At most this many icons lead the marker; past three it is a smudge. */
const MAX_MARKER_ICONS = 3;

/**
 * A burst of work, as one line.
 *
 * The collapsed line is the whole point — "Ran 36 commands, read 6 files, used
 * a tool" is what someone scrolling back wants, and forty individual cards
 * interleaved with the thinking between them is what they were getting.
 * Expanding restores every piece, in order, exactly as it was.
 *
 * It holds calls and only calls. The reasoning that used to be folded in here
 * with them stands in the thread where the model wrote it — see `ActivityGroup`
 * in `state/transcript.ts` for why the two stopped being one category.
 *
 * Two things are deliberately *not* summarised away:
 *
 *  - **Failures.** A group holding an error or a denial says so on the
 *    collapsed line, in signal. A marker that read the same whether or not
 *    something broke would be worse than no marker.
 *  - **Work in flight.** While a call is still running the line reads in
 *    present tense with a pulsing dot, so a long `Bash` looks like progress
 *    rather than a thread that stopped.
 *
 * It says those things *on the line*, and stays shut. A failure used to open
 * the marker, which sounds protective and was not: `defaultOpen` is read once
 * per mount, so it could never catch the case it was written for — a group
 * failing while the reader watches — and the case it did catch was the reader
 * arriving. Opening a conversation dropped them at the foot of a marker holding
 * every failed call in it, with the conversation itself scrolled off the top.
 * The signal-toned count is what carries a failure now, and one click is what
 * carries the reader into it.
 *
 * The gutter beside it carries no label. "work" only repeated the icons and the
 * sentence next to them, and the failure it used to colour is already on the
 * line itself, in signal — the first point above is what carries that now.
 */
const ActivityRow = memo(function ActivityRow({ id }: { readonly id: string }): ReactElement | null {
  const group = useActivityGroup(id);
  if (!group) return null;
  return <ActivityMarker group={group} />;
});

function ActivityMarker({ group }: { readonly group: ActivityGroup }): ReactElement {
  const live = group.running > 0;
  const summary = describeActivity(group.counts, live);
  const icons: Array<{ key: string; Icon: LucideIcon; tone?: string }> = [];
  for (const category of TOOL_CATEGORY_ORDER) {
    if ((group.counts[category] ?? 0) > 0) {
      icons.push({ key: category, Icon: CATEGORY_ICON[category] });
    }
  }

  return (
    <Line label="" ts={group.ts}>
      <Fold
        // Closed unless the reader opened it, whatever happened inside — see the
        // note above. The group id keys that memory: it is `g:` + its first
        // member's id, so it names the same burst after a replay, which is what
        // makes a marker left open come back open. See `lib/foldMemory.ts`.
        rememberAs={group.id}
        triggerClassName="text-2xs"
        summary={
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="flex shrink-0 items-center gap-1">
              {icons.slice(0, MAX_MARKER_ICONS).map(({ key, Icon, tone }) => (
                <Icon
                  key={key}
                  className={cn('size-3', tone ?? (live ? 'text-cyan' : 'text-ink-faint'))}
                  aria-hidden="true"
                />
              ))}
            </span>
            <span className="truncate font-mono text-2xs">{summary}</span>
            {live ? <StatusDot tone="cyan" pulse /> : null}
            {group.failed > 0 ? (
              <span className="shrink-0 font-mono text-2xs text-signal">
                · {group.failed} failed
              </span>
            ) : null}
          </span>
        }
      >
        <div className="flex flex-col gap-1">
          {group.ids.map((memberId) => (
            <MemberCard key={memberId} id={memberId} />
          ))}
        </div>
      </Fold>
    </Line>
  );
}

/**
 * One member of an expanded group — always a call.
 *
 * Subscribed by its own id and memoised, which is rule 2 applied one level
 * down: a `tool.end` inside an open marker re-renders that one card and not the
 * other thirty-nine beside it.
 */
const MemberCard = memo(function MemberCard({ id }: { readonly id: string }): ReactElement | null {
  const item = useTranscriptItem(id);
  if (item?.kind !== 'tool') return null;
  return <ToolCard item={item} />;
});

/**
 * A parked request, answered where it happened.
 *
 * The card itself is `InlinePermission`; this only supplies the transcript's
 * row chrome. Pending requests get a coloured rail label so they are findable
 * by scrolling as well as by the status line's counter — amber for an approval,
 * because that is a risk decision, and cyan for a question, because it is not.
 */
function PermissionRow({ item }: { readonly item: PermissionItem }): ReactElement {
  const pending = item.state === 'pending';
  const asking = item.request.question !== undefined;
  return (
    <Line
      label={asking ? (pending ? 'answer?' : 'question') : pending ? 'approve?' : 'approval'}
      tone={pending ? (asking ? 'cyan' : 'amber') : 'neutral'}
      ts={item.ts}
      className={pending ? 'my-1' : undefined}
    >
      <InlinePermission item={item} />
    </Line>
  );
}

function NoticeRow({ item }: { readonly item: NoticeItem }): ReactElement {
  const tone: Tone = item.level === 'error' ? 'signal' : item.level === 'warn' ? 'amber' : 'neutral';
  const Icon = item.level === 'info' ? InfoIcon : TriangleAlertIcon;
  return (
    <Line label="" ts={item.ts}>
      <div className="flex items-start gap-1.5 py-0.5">
        <Icon
          className={cn('mt-[2px] size-3 shrink-0', toneClasses.text[tone])}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <span className="font-mono text-2xs text-ink-muted">{item.text}</span>
          {item.detail ? (
            <span className="ml-1.5 font-mono text-2xs text-ink-faint">{item.detail}</span>
          ) : null}
        </div>
      </div>
    </Line>
  );
}

/**
 * A slash command, as one line rather than two bubbles of markup.
 *
 *     ⌘ /model  opus[1m]
 *       Set model to Fable 5 and saved as your default
 *
 * Sized like a notice, not like a turn. This is the register the row belongs
 * in: something happened to the session, it is worth a line of the record, and
 * it is not what anybody opened the transcript to read. The old rendering —
 * two full-width chat bubbles of raw XML per `/effort` — was loud in exactly
 * the proportion it was uninformative.
 *
 * The name keeps its slash, because that is how it was typed and how it is
 * searched for. The output is the host's own words and is shown verbatim,
 * wrapped rather than truncated: these lines are one sentence in practice, and
 * a "Set model to …" the user has to expand to read is not worth the row.
 */
function CommandRow({ item }: { readonly item: CommandItem }): ReactElement {
  return (
    <Line label="" ts={item.ts}>
      <div className="flex items-start gap-1.5 py-0.5">
        {/* The failure tone lives on the icon rather than the whole row: the
            command still ran, and colouring its name red would read as the
            command itself being wrong rather than its result. */}
        {item.failed === true ? (
          <TriangleAlertIcon
            className={cn('mt-[2px] size-3 shrink-0', toneClasses.text.signal)}
            aria-hidden="true"
          />
        ) : (
          <TerminalIcon className="mt-[2px] size-3 shrink-0 text-ink-faint" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <span className="font-mono text-2xs text-ink">/{item.name}</span>
          {/* Arguments in the muted weight, because the command is what the
              row is *about* and the argument qualifies it — the same
              relationship the notice row draws between text and detail. */}
          {item.args === undefined ? null : (
            <span className="ml-1.5 font-mono text-2xs text-ink-muted">{item.args}</span>
          )}
          {item.output === undefined ? null : (
            <div
              className={cn(
                'font-mono text-2xs whitespace-pre-wrap',
                item.failed === true ? toneClasses.text.signal : 'text-ink-faint',
              )}
            >
              {item.output}
            </div>
          )}
        </div>
      </div>
    </Line>
  );
}

const END_TONE: Record<RunEndItem['reason'], Tone> = {
  completed: 'mint',
  interrupted: 'amber',
  disposed: 'neutral',
  max_turns: 'amber',
  budget_exceeded: 'amber',
  permission_denied: 'amber',
  error: 'signal',
};

/**
 * The run-end block, trimmed to the user's `runSummary` setting.
 *
 * Two rules hold across all three settings, and they are why this is not a
 * plain boolean:
 *
 *  - **A failure is never hidden.** `'never'` still renders an errored run —
 *    just the reason and the message, with the accounting dropped. This row is
 *    the only place a run's error text and code ever appear, so hiding it would
 *    turn a failed run into one that simply stopped.
 *  - **Anything the user has to act on stays.** `'failures'` keeps interrupted,
 *    `max_turns` and `budget_exceeded` too: each means the answer on screen is
 *    cut short, which is not something to infer from the absence of a row.
 *
 * The cost of hiding a clean run's block is that consecutive runs lose their
 * visual boundary — the `end` gutter label was doing that work. Prompts are
 * bubbles, so the seam is still legible; if that stops being true, the fix is a
 * rule between runs, not putting the accounting back.
 */
function RunEndRow({ item }: { readonly item: RunEndItem }): ReactElement | null {
  const setting = useApp((s) => s.runSummary);
  const tone = END_TONE[item.reason];
  const usage = item.usage;
  const failed = item.reason === 'error';

  /*
   * A run that produced nothing is never hidden, whatever the setting — the
   * same rule failures get, and for the same reason. Hiding a clean run costs
   * a visual boundary; hiding *this* one leaves the reader's message with no
   * row under it at all, which is indistinguishable from the agent having
   * ignored them. It was reported as exactly that.
   */
  if (!item.silent && (setting === 'never' ? !failed : setting === 'failures' && item.reason === 'completed')) {
    return null;
  }
  const accounting = setting !== 'never';

  return (
    <Line label="end" tone={tone} ts={item.ts} className="mt-1.5 mb-2">
      <div
        /*
         * 7D draws the end of a run as mono meta between two faint rules; this
         * keeps the card, because a failed run puts an error message and a code
         * under the same heading and a line between rules has nowhere to put
         * them. What it takes from `.end` is the register — the same wash and
         * hairline as the work above it, mono for the accounting, and no
         * uppercase anywhere.
         */
        className={cn(
          'rounded-lg border px-2.5 py-1.5',
          failed ? 'border-signal/40 bg-signal/5' : 'border-hairline bg-wash',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            {failed ? (
              <TriangleAlertIcon className="size-3 text-signal" aria-hidden="true" />
            ) : (
              <SparklesIcon className="size-3 text-mint" aria-hidden="true" />
            )}
            <span className="chrome-label text-ink-muted">
              {item.silent ? 'no reply' : item.reason.replace(/_/g, ' ')}
            </span>
          </span>
          {accounting && item.durationMs !== undefined ? (
            <Stat label="took" value={formatDuration(item.durationMs)} />
          ) : null}
          {accounting && item.numTurns !== undefined ? (
            <Stat label="turns" value={String(item.numTurns)} />
          ) : null}
          {accounting && usage ? (
            <>
              <Stat label="in" value={formatTokens(usage.tokens.inputTokens)} />
              <Stat label="out" value={formatTokens(usage.tokens.outputTokens)} />
              {usage.tokens.cacheReadInputTokens === undefined ? null : (
                <Stat label="cached" value={formatTokens(usage.tokens.cacheReadInputTokens)} />
              )}
              {usage.costUsd === undefined ? null : (
                <Stat label="cost" value={formatUsd(usage.costUsd)} emphasis />
              )}
            </>
          ) : null}
        </div>

        {item.error ? (
          <div className="mt-1.5">
            <p className="font-mono text-2xs text-signal">{item.error.message}</p>
            <p className="mt-0.5 font-mono text-2xs text-ink-faint">
              code {item.error.code}
              {item.error.retryable ? ' · retryable' : ''}
            </p>
          </div>
        ) : null}
      </div>
    </Line>
  );
}

function Stat({
  label,
  value,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-mono text-2xs text-ink-faint">{label}</span>
      <span className={cn('font-mono text-2xs', emphasis ? 'text-beam-text' : 'text-ink-muted')}>
        {value}
      </span>
    </span>
  );
}
