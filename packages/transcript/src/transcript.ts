/**
 * The transcript model.
 *
 * This is the renderer's hot path and the one place where a naive React
 * implementation falls over: a fast provider emits a `text.delta` every few
 * milliseconds, and putting that in component state re-renders the whole
 * transcript per token — O(items) work per token, which is O(n²) over a turn.
 *
 * So the transcript lives outside React, in this plain-TS store, and React
 * subscribes to it at two different granularities:
 *
 *  - **the list** — an array of item ids, which changes only when an item is
 *    added or removed. Adding a token does not touch it.
 *  - **one item** — each rendered item subscribes to *its own id*, so a delta
 *    notifies exactly one leaf component.
 *  - **one activity group** — runs of consecutive machinery (thinking blocks
 *    and tool calls) are folded into a single summarised row, because grouping
 *    is about neighbours and a component here is never allowed to see its
 *    neighbours. See {@link ActivityGroup}, which explains why that constraint
 *    forces the work down here and how it stays off the per-token path.
 *
 * Deltas are appended to a mutable string buffer and coalesced: a burst of
 * fifty tokens produces one snapshot and one notification on the next frame,
 * not fifty. Snapshots are immutable and reference-stable between flushes,
 * which is exactly the contract `useSyncExternalStore` wants.
 *
 * The model is framework-free and synchronous when handed a synchronous
 * scheduler, which is how it is tested.
 */

import type {
  AgentError,
  AgentEvent,
  Attachment,
  JsonObject,
  JsonValue,
  PermissionRequest,
  QuestionAnswer,
  RunEndReason,
  RunId,
  StopReason,
  ThinkingDeltaEvent,
  ToolEndStatus,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { classifyTool, type ActivityCounts, type ToolCategory } from './tools.js';

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

interface ItemBase {
  readonly id: string;
  readonly ts: number;
}

/** Something the user typed. `pending` until the provider echoes it back. */
export interface UserItem extends ItemBase {
  readonly kind: 'user';
  readonly text: string;
  readonly pending: boolean;
  /**
   * Read out of a stored session rather than typed here.
   *
   * Kept because it is the only run boundary a replay has. A live transcript
   * learns where one piece of work ended from `run.end`; stored history has no
   * such record — see {@link TranscriptModel.rebuildRows} — and a turn the user
   * started is the same boundary written in the provider's own file.
   */
  readonly replay?: boolean;
  /**
   * The provider's own id for this message — for Claude, the chain uuid the
   * stored session files this entry under.
   *
   * This is the handle rewind and fork-from-here need: `rewindToMessageId` on
   * a run input names a user prompt by exactly this id. Replayed history
   * carries the provider's stored uuid; a locally-typed message carries the
   * registry's predictable `${runId}:prompt:${n}` from the moment it is
   * pushed — which doubles as the identity a re-delivered copy merges on. See
   * {@link TranscriptModel.pushUserMessage}.
   */
  readonly messageId?: string;
  /**
   * Images sent with the message.
   *
   * The full attachments, base64 and all, kept for as long as the transcript
   * holds the turn — which is what lets the thumbnail render without a fetch,
   * and is the reason `IMAGE_ATTACHMENT_LIMITS` is as small as it is. Replayed
   * history has none: the providers' stored transcripts record what the model
   * was sent, and reconstructing a thumbnail from that is a different feature.
   */
  readonly attachments?: readonly Attachment[];
}

/** One assistant text block, streamed or whole. */
export interface AssistantItem extends ItemBase {
  readonly kind: 'assistant';
  readonly messageId: string;
  readonly blockIndex: number;
  readonly text: string;
  readonly streaming: boolean;
  readonly stopReason?: StopReason;
  readonly replay?: boolean;
  readonly synthetic?: boolean;
  readonly agentId?: string;
}

/** Extended thinking. Collapsed by default in the UI. */
export interface ThinkingItem extends ItemBase {
  readonly kind: 'thinking';
  /**
   * The message and block this row *started* at.
   *
   * A row is not one provider block. A turn emits `thinking / tool / thinking /
   * tool …`, the calls sink to the marker at the foot of the run, and what was
   * left standing in the thread was a stack of folds each holding one paragraph
   * of a single train of thought. Consecutive blocks are appended to the row the
   * first of them opened — see {@link TranscriptModel.thinkingRow} — so a stretch
   * of reasoning is one block of prose, and the thing that ends it is the agent
   * saying something.
   */
  readonly messageId: string;
  readonly blockIndex: number;
  readonly text: string;
  readonly streaming: boolean;
  readonly redacted: boolean;
  readonly agentId?: string;
}

/** Status of a tool call as the transcript sees it. */
export type ToolStatus = 'running' | ToolEndStatus;

export interface ToolItem extends ItemBase {
  readonly kind: 'tool';
  readonly toolCallId: string;
  readonly name: string;
  readonly title?: string;
  readonly input: JsonObject;
  readonly status: ToolStatus;
  readonly result?: JsonValue;
  readonly resultText?: string;
  readonly error?: AgentError;
  readonly durationMs?: number;
  readonly agentId?: string;
  readonly parentToolCallId?: string;
}

/**
 * A parked request, kept in the transcript so the decision is a record.
 *
 * Covers both things a provider can park on: an approval, and a question (when
 * `request.question` is set). They share an item because they share a
 * lifecycle — one pending card that turns into one settled record — and because
 * the transcript's job is the same either way: say what was asked and what the
 * user answered, at the point in the conversation where it happened.
 */
export interface PermissionItem extends ItemBase {
  readonly kind: 'permission';
  readonly requestId: string;
  readonly request: PermissionRequest;
  /** `answered` is the question counterpart of `allowed`. */
  readonly state: 'pending' | 'allowed' | 'denied' | 'answered' | 'skipped';
  readonly note?: string;
  /**
   * What was chosen, for a settled question.
   *
   * Kept rather than flattened into {@link note} so the record can show the
   * questions as they were asked with the choices marked — the same card,
   * read-only — instead of a sentence that loses which options were on offer.
   */
  readonly answers?: readonly QuestionAnswer[];
}

/** Engine-level chatter: session start, re-attach, dropped events. */
export interface NoticeItem extends ItemBase {
  readonly kind: 'notice';
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly detail?: string;
}

/**
 * A slash command the user ran, and what the host printed.
 *
 * Its own row rather than a user bubble, because it is not something the user
 * *said*. `/model` never reached the model; it changed the session and printed
 * a line. Drawing it as a chat message — which is what the raw envelope did —
 * puts words in the user's mouth and files a settings change as a turn.
 */
export interface CommandItem extends ItemBase {
  readonly kind: 'command';
  readonly name: string;
  readonly args?: string;
  readonly output?: string;
  readonly failed?: boolean;
}

/** The terminal card for a run. */
export interface RunEndItem extends ItemBase {
  readonly kind: 'run-end';
  readonly reason: RunEndReason;
  readonly error?: AgentError;
  readonly usage?: UsageSnapshot;
  readonly durationMs?: number;
  readonly numTurns?: number;
  readonly result?: string;
  /**
   * The run produced nothing at all — no answer, no tool call, no reasoning.
   *
   * Worth naming because the alternative is indistinguishable from it: a bare
   * `52ms · 0 tok` under a message reads as the agent shrugging, when what
   * happened is that the provider had nothing to send. Set on every run-end,
   * so `false` is a run that did something rather than a run from a build
   * that did not know to ask.
   */
  readonly silent: boolean;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | NoticeItem
  | CommandItem
  | RunEndItem;

/* -------------------------------------------------------------------------- */
/* Activity groups                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The tool calls of one run, gathered under it and summarised.
 *
 * The transcript draws one marker per group — "Ran 36 commands, read 6 files"
 * — instead of one row per call, because a turn that touches forty files is
 * forty rows of machinery between two sentences of actual answer.
 *
 * ## Calls, and nothing but calls
 *
 * Reasoning is not in here, and the distinction is the whole point. A tool call
 * is an account of *how* the answer was arrived at, which is worth keeping and
 * is not worth reading in line; a thinking block is the model working out
 * *what* to say, which belongs beside the saying of it. They are two kinds of
 * thing, so they get two treatments: the calls sink to the foot of the run (see
 * {@link TranscriptModel} for that walk), and the reasoning stays exactly where
 * it happened.
 *
 * This used to be otherwise — both were "machinery" and a burst of either
 * folded into a marker where it fell. What that produced was a conversation
 * interrupted mid-paragraph by a bar reading `Ran 3 commands`, and reasoning
 * that could only be reached by opening one. The rule now is simply: prose and
 * reasoning read top to bottom, and the work is underneath.
 *
 * ## An artifact is never folded
 *
 * One kind of call is lifted out of the burst rather than hidden inside it: one
 * that produced an artifact ({@link ArtifactTest}). The marker exists to hide
 * *machinery*, and a page the agent made is not machinery — it is the
 * deliverable. Folded away it reads as "edited 5 files", a description of the
 * work rather than of the thing the work produced, and reaching it costs a click
 * into a dropdown whose label gives no hint anything is in there worth opening.
 *
 * Lifted, **not** treated as a boundary. An artifact does not end the run and
 * does not start a new one — the burst is walked to its natural end and only
 * then split into what stays folded and what comes out. So a turn that writes
 * three artifacts among its work reads
 *
 *     ▸ work · Ran 4 commands, edited 2 files
 *     ▤ report.html                              [ Open ]
 *     ▤ chart.svg                                [ Open ]
 *     ▤ notes.md                                 [ Open ]
 *
 * — one folded line, with the things worth opening beside it. Ending the run at
 * each artifact instead would be the obvious implementation and the wrong one:
 * it turns a single burst into a marker per gap, so the more the agent made, the
 * more machinery rows the reader has to scroll past to see it.
 *
 * A lifted call is not a member of the group, so the summary does not count it
 * either. "Edited 5 files" beside five tiles that *are* those files would be the
 * same work reported twice, and the marker's job is to describe what is still
 * hidden. A burst whose only calls were artifacts therefore has nothing left to
 * summarise and produces no marker at all.
 *
 * ## Why this is computed here and not in the component
 *
 * The transcript's performance contract says the list hands React ids and
 * nothing else, so a row can never see its neighbours. Grouping is *inherently*
 * about neighbours, so it cannot happen in a row — a component that looked
 * left to decide whether it starts a group would have to read items during
 * render, which is the exact thing that makes streaming O(items) per token.
 *
 * So the model does it, and it stays cheap because of when it runs:
 *
 *  - **membership** is rebuilt only on a structural change, alongside the
 *    `ids` snapshot that is already O(items). A token never triggers it.
 *  - **the summary** is O(members) and holds no text, so a thinking delta
 *    inside a group rebuilds a handful of counters that compare equal and
 *    notifies nobody. What the reader sees of that delta is the member card,
 *    which subscribes to its own id like every other row.
 *
 * Snapshots are reference-stable: an unchanged group keeps its object identity
 * across flushes, which is what `useSyncExternalStore` requires and what stops
 * a marker re-rendering every time a sibling streams.
 */
export interface ActivityGroup {
  /** `g:` + the first member's id. Distinct from every item id by prefix. */
  readonly id: string;
  /** Member item ids, in transcript order. Tool calls, and nothing else. */
  readonly ids: readonly string[];
  /** When the burst started — the first member's timestamp. */
  readonly ts: number;
  /** How many calls of each kind, for the summary line. */
  readonly counts: ActivityCounts;
  /** Calls still running. Non-zero means the marker reads in present tense. */
  readonly running: number;
  /** Calls that errored or were denied. Never hidden behind a collapsed row. */
  readonly failed: number;
}

/** True for a row id that names an {@link ActivityGroup} rather than an item. */
export function isGroupId(id: string): boolean {
  return id.startsWith('g:');
}

/**
 * Did this finished call produce something the reader is meant to *look at*?
 *
 * Injected rather than imported because the answer depends on the pane's
 * working directory and the host platform — see `lib/artifact.ts` — and neither
 * belongs in a model whose job is the shape of the transcript. `pane.ts` closes
 * over both and hands the closure down.
 *
 * The model's use for it is narrow and structural: an artifact does not get
 * folded. See {@link ActivityGroup} for why that is worth a rule of its own.
 */
export type ArtifactTest = (item: ToolItem) => boolean;

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/** How a coalesced flush gets deferred. Injectable so tests can run it now. */
export type Scheduler = (flush: () => void) => void;

/**
 * One frame, for the hosts that have no frames to offer.
 *
 * Node and jsdom have no `requestAnimationFrame`, so there the timer is not a
 * backstop but the whole scheduler, and it should approximate the display clock
 * it stands in for. `cwd.test.ts` waits two of these for a flush.
 */
const FRAME_MS = 16;

/**
 * How long to wait for a frame that was asked for before flushing without it.
 *
 * Comfortably longer than a frame at any refresh rate a display has, so that a
 * window which *is* being composited always flushes on its own frame and the
 * paragraph below keeps holding — this must not become the thing that drives a
 * healthy window. Short enough that a window which is not being composited
 * stays legible: ten flushes a second is far more than a reader can follow and
 * far fewer than a token stream produces.
 */
const FLUSH_FALLBACK_MS = 100;

/**
 * One flush per animation frame — the display cannot show more than that —
 * with a timer underneath for the windows that never get one.
 *
 * ## Why the timer is not belt-and-braces
 *
 * {@link TranscriptModel.markPending} latches: it sets `pending` and hands the
 * flush to this function, and every event that arrives before that flush runs
 * short-circuits on the flag. So the scheduler's contract is not "soon" but
 * *"eventually, always"* — a deferred flush that never runs does not delay the
 * transcript, it silences the model permanently. Nothing is notified again for
 * the life of the page, while `dirty` and the text buffers go on filling up
 * behind it.
 *
 * `requestAnimationFrame` alone cannot meet that contract, because a frame is
 * not something a window is entitled to. Chromium stops compositing a window
 * with no visible surface — minimised, fully covered by another application, on
 * a Space the user has switched away from, behind a sleeping display — and the
 * queued callback is then simply never run. That is not an edge case here; it is
 * the ordinary shape of using this app, which exists to be left alone while an
 * agent works and looked at again afterwards.
 *
 * The symptom is the worst one this app has. The transcript stops dead while the
 * agent carries on; the buffered work then lands in a single burst when frames
 * resume or the page is reloaded, so the one moment the user cannot follow what
 * happened is the moment all of it appears.
 * `windowSecurityPreferences` sets `backgroundThrottling: false` against
 * exactly this failure and it does not reach here — that keeps *timers* honest
 * while the window is in the background, which is what makes the fallback below
 * work, but it does not buy frames for a window that is not being drawn.
 * `startSessionFeed` refuses to gate on visibility for the same reason, in the
 * same words.
 *
 * So the two race and the first to arrive wins, once. A composited window is
 * unaffected: its frame lands inside 17ms and cancels the timer, so the flush
 * stays on the display's own clock.
 */
export const frameScheduler: Scheduler = (flush) => {
  if (typeof requestAnimationFrame !== 'function') {
    setTimeout(flush, FRAME_MS);
    return;
  }

  let done = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const once = (): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    flush();
  };

  frame = requestAnimationFrame(once);
  timer = setTimeout(once, FLUSH_FALLBACK_MS);
};

/** Flush immediately. Used by tests. */
export const syncScheduler: Scheduler = (flush) => flush();

type Listener = () => void;

const EMPTY_IDS: readonly string[] = Object.freeze([]);

/**
 * Told when a run's stream turns out to have a hole in it.
 *
 * The transcript's own answer to a `seq` gap is a note and carrying on — for
 * most events the loss is a few words of text, and the next flush corrects the
 * screen. But one droppable event is load-bearing: a lost `run.end` leaves the
 * *store* believing the run is live forever, and the store is the half that
 * owns run state. So the drop is reported outward, to whoever registered.
 *
 * A module-level setter rather than an import of the store, because the
 * dependency points the other way — `store.ts` (via `pane.ts`) imports this
 * module, and the transcript reaching back into it would close the cycle. Same
 * seam as `setHostPlatform` in `pane.ts`: the owner pushes a hook in, once.
 */
type EventsDroppedHook = (runId: RunId) => void;

let onEventsDropped: EventsDroppedHook | null = null;

export function setEventsDroppedHook(hook: EventsDroppedHook | null): void {
  onEventsDropped = hook;
}

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

export class TranscriptModel {
  private readonly schedule: Scheduler;

  private ids: string[] = [];
  private idsSnapshot: readonly string[] = EMPTY_IDS;
  private items = new Map<string, TranscriptItem>();

  /**
   * The renderable sequence: `ids` with runs of machinery folded into groups.
   *
   * Rebuilt only on a structural change — see {@link ActivityGroup}. `groupOf`
   * is the reverse index, so a changed member can find its group in O(1)
   * instead of a scan.
   */
  private rowsSnapshot: readonly string[] = EMPTY_IDS;
  private groupMembers = new Map<string, readonly string[]>();
  private groupOf = new Map<string, string>();
  private groupSnapshots = new Map<string, ActivityGroup>();
  private groupListeners = new Map<string, Set<Listener>>();

  /** Authoritative text for streaming blocks; folded into snapshots on flush. */
  private buffers = new Map<string, string>();

  /** Ordered block ids per assistant message, for `text.complete` without an index. */
  private messageBlocks = new Map<string, string[]>();

  /**
   * The reasoning row still being written to, and which blocks have joined it.
   *
   * A run of thinking blocks is one row (see {@link ThinkingItem.messageId}), so
   * a delta has to be able to find the row its block was merged into on every
   * later chunk — that is `thinkingMerged`, block id to row id.
   *
   * `thinkingStreak` is the row an *unseen* block joins, and it is cleared by
   * {@link insert} the moment anything that is not reasoning or a tool call
   * lands in the thread. That is the whole rule: the agent speaking ends the
   * stretch, a tool call does not — calls sink to the marker at the foot of the
   * run, so two blocks with a call between them are neighbours on screen.
   */
  private thinkingStreak: string | null = null;
  /** Has the agent produced anything in the run now open? See `RunEndItem.silent`. */
  private produced = false;
  private thinkingMerged = new Map<string, string>();

  /** Optimistic user items still waiting for the provider to echo them. */
  private unconfirmedUser: string[] = [];

  /**
   * User rows by the message identity they claim, so a re-delivered prompt
   * merges instead of duplicating.
   *
   * Two id spaces land here and never collide: the registry's predictable
   * `${runId}:prompt:${n}` (claimed by the optimistic row at push time, and
   * what the stall sweep's heal replays), and the provider's own uuids
   * (learned from echoes and stored history). See {@link completeUserText}.
   */
  private userClaims = new Map<string, string>();

  /**
   * Indexes of open work, so settling a turn is O(open) rather than O(items).
   * A long transcript should not get slower every time a tool starts.
   */
  private streaming = new Set<string>();
  private openTools = new Set<string>();

  private dirty = new Set<string>();
  private structural = false;
  private pending = false;

  /**
   * How to tell an artifact from ordinary work, and what it last answered.
   *
   * The verdicts are memoised because {@link rebuildRows} asks per item per
   * rebuild, and the test is not cheap — it re-parses the call's input into a
   * diff. Memoising turns that into once per *call*, which is what the row
   * rendering the card already pays.
   *
   * An entry is dropped in {@link replace}, because the answer genuinely changes
   * there: a call is only ever an artifact once it has finished, so the verdict
   * that matters is the one taken after `tool.end` merges the result in.
   */
  private artifactTest: ArtifactTest | null = null;
  private artifactVerdicts = new Map<string, boolean>();

  private listListeners = new Set<Listener>();
  private itemListeners = new Map<string, Set<Listener>>();

  private counter = 0;
  private lastSeq: number | null = null;
  /** Which run `lastSeq` is counting — see {@link checkSequence}. */
  private lastSeqRun: RunId | null = null;

  constructor(schedule: Scheduler = frameScheduler) {
    this.schedule = schedule;
  }

  /**
   * Teach the model which calls produced artifacts, so it can keep them out of
   * the fold. See {@link ArtifactTest}.
   *
   * Installing a test — or replacing one, which is how a pane reacts to its
   * working directory moving — throws away every cached verdict and rebuilds the
   * rows, since the same call can stop being an artifact when `cwd` changes
   * underneath it. Both are O(items) and both happen approximately never.
   */
  setArtifactTest(test: ArtifactTest | null): void {
    if (test === this.artifactTest) return;
    this.artifactTest = test;
    this.artifactVerdicts.clear();
    this.structural = true;
    this.markPending();
  }

  /* ---- reads ---------------------------------------------------------- */

  /** Stable array of item ids. New identity only on structural change. */
  getListSnapshot = (): readonly string[] => this.idsSnapshot;

  /**
   * Stable array of *row* ids — the list the transcript actually renders.
   *
   * Same as {@link getListSnapshot} except that a run of consecutive machinery
   * — thinking blocks and tool calls — appears as one `g:` group id. Changes
   * identity on exactly the same beat, so it costs a subscription and no extra
   * render.
   */
  getRowsSnapshot = (): readonly string[] => this.rowsSnapshot;

  /** Stable snapshot of one item. New identity only when that item changed. */
  getItem = (id: string): TranscriptItem | undefined => this.items.get(id);

  /**
   * Stable snapshot of one activity group.
   *
   * Built on first read and cached; the cache entry survives until the group's
   * membership or one of its members changes, which is what makes the identity
   * safe to hand `useSyncExternalStore`.
   */
  getGroup = (id: string): ActivityGroup | undefined => {
    const cached = this.groupSnapshots.get(id);
    if (cached) return cached;
    const built = this.buildGroup(id);
    if (built) this.groupSnapshots.set(id, built);
    return built;
  };

  get length(): number {
    return this.ids.length;
  }

  /** True once anything at all has been rendered — drives the empty state. */
  get isEmpty(): boolean {
    return this.ids.length === 0;
  }

  /* ---- subscriptions -------------------------------------------------- */

  subscribeList = (listener: Listener): (() => void) => {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  };

  subscribeItem = (id: string, listener: Listener): (() => void) => {
    let set = this.itemListeners.get(id);
    if (!set) {
      set = new Set();
      this.itemListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.itemListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.itemListeners.delete(id);
    };
  };

  subscribeGroup = (id: string, listener: Listener): (() => void) => {
    let set = this.groupListeners.get(id);
    if (!set) {
      set = new Set();
      this.groupListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.groupListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.groupListeners.delete(id);
    };
  };

  /* ---- writes --------------------------------------------------------- */

  /**
   * Add the user's message optimistically, before the round-trip returns.
   *
   * `messageId` is the identity the registry will file this prompt under —
   * `${runId}:prompt:${n}`, predictable because the renderer mints the run id
   * itself and counts what it sends. Claiming it here is what makes a later
   * replay of the retained prompt *merge onto this row* instead of drawing a
   * second copy: the stall sweep heals a quiet window by re-applying the
   * run's retained events into a transcript that was never reset, and the
   * retained prompt is one of them. See {@link completeUserText}.
   */
  pushUserMessage(text: string, attachments?: readonly Attachment[], messageId?: string): string {
    const id = `u:${++this.counter}`;
    this.insert({
      id,
      ts: Date.now(),
      kind: 'user',
      text,
      pending: true,
      ...(messageId === undefined ? {} : { messageId }),
      ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    });
    if (messageId !== undefined) this.userClaims.set(messageId, id);
    this.unconfirmedUser.push(id);
    return id;
  }

  /**
   * Move a user row onto a different message identity.
   *
   * For exactly one caller: the steer that raced the end of its run. The row
   * was pushed claiming the old run's next prompt slot; the send came back
   * "that run is over" and the prompt is being carried into a fresh run as its
   * opening message — which the registry will file under the *new* run's id.
   * The old claim is dropped rather than kept as an alias, because the old
   * registry entry never recorded the failed send: nothing will ever replay
   * under that name.
   */
  claimUserMessage(id: string, messageId: string): void {
    const existing = this.items.get(id);
    if (existing?.kind !== 'user') return;
    if (existing.messageId !== undefined && this.userClaims.get(existing.messageId) === id) {
      this.userClaims.delete(existing.messageId);
    }
    this.userClaims.set(messageId, id);
    this.replace(id, { ...existing, messageId });
  }

  /**
   * Mark an optimistic user message as delivered.
   *
   * {@link pushUserMessage} renders the prompt before the round-trip returns
   * and flags it `pending`, which the UI draws dimmed. Something has to clear
   * that flag, and the provider echo cannot: the Claude mapper deliberately
   * drops the echo of Artemis's own prompt (the renderer already drew it), so
   * `completeUserText`'s reconciliation branch never runs for a live turn and
   * every message the user ever sent would stay dimmed for the life of the
   * window, with its id accumulating in `unconfirmedUser` forever.
   *
   * So confirmation happens at the point Artemis actually knows the text was
   * delivered — when `runs.start` / `runs.send` resolves. A prompt whose call
   * *failed* is deliberately left pending: dimmed then means what it says.
   */
  confirmUserMessage(id: string): void {
    const index = this.unconfirmedUser.indexOf(id);
    if (index >= 0) this.unconfirmedUser.splice(index, 1);
    const existing = this.items.get(id);
    if (existing?.kind !== 'user' || !existing.pending) return;
    this.replace(id, { ...existing, pending: false });
  }

  /** Add an engine-level note. */
  note(level: NoticeItem['level'], text: string, detail?: string): string {
    const id = `n:${++this.counter}`;
    this.insert({
      id,
      ts: Date.now(),
      kind: 'notice',
      level,
      text,
      ...(detail === undefined ? {} : { detail }),
    });
    return id;
  }

  /** Record the user's answer to a parked request. */
  resolvePermission(
    requestId: string,
    state: Exclude<PermissionItem['state'], 'pending'>,
    note?: string,
    answers?: readonly QuestionAnswer[],
  ): void {
    const id = `p:${requestId}`;
    const existing = this.items.get(id);
    if (!existing || existing.kind !== 'permission') return;
    this.replace(id, {
      ...existing,
      state,
      ...(note === undefined ? {} : { note }),
      ...(answers === undefined ? {} : { answers }),
    });
  }

  /**
   * Write a terminal card for a run that never produced a `run.end`.
   *
   * The only legitimate caller is the store, when `runs.start` fails outright:
   * there is no event stream to carry the real terminal event, and leaving the
   * transcript open forever is worse than recording the failure locally.
   */
  localRunEnd(reason: RunEndReason, error?: AgentError): void {
    this.settleStreaming();
    this.failOpenToolCalls(reason);
    const id = `e:${++this.counter}`;
    const silent = !this.produced;
    this.produced = false;
    this.insert({
      id,
      ts: Date.now(),
      kind: 'run-end',
      reason,
      silent,
      ...(error === undefined ? {} : { error }),
    });
    this.lastSeq = null;
  }

  /**
   * Drop one item and everything after it. The local half of a rewind.
   *
   * The provider's file is wound back by the next run (see
   * `RunInput.rewindToMessageId`); this winds back what is on screen, so the
   * conversation reads as already-rewound while the retyped prompt is being
   * written. Only called between runs — the store gates it on an idle pane —
   * so there is no streaming block or open call to worry about mid-flight:
   * anything of the kind in the dropped suffix is settled history.
   *
   * Indexes are cleaned by deletion rather than rebuilt from scratch so the
   * surviving prefix keeps its object identity — the rows above the cut must
   * not re-render because the rows below it left.
   */
  truncateFrom(id: string): void {
    const at = this.ids.indexOf(id);
    if (at < 0) return;

    const dropped = this.ids.slice(at);
    this.ids = this.ids.slice(0, at);

    for (const droppedId of dropped) {
      this.items.delete(droppedId);
      this.buffers.delete(droppedId);
      this.streaming.delete(droppedId);
      this.openTools.delete(droppedId);
      this.dirty.delete(droppedId);
      this.artifactVerdicts.delete(droppedId);
      const index = this.unconfirmedUser.indexOf(droppedId);
      if (index >= 0) this.unconfirmedUser.splice(index, 1);
    }
    // A claim pointing at a dropped row must not catch a later replay and
    // resurrect it as a "merge" onto nothing.
    for (const [messageId, itemId] of this.userClaims) {
      if (!this.items.has(itemId)) this.userClaims.delete(messageId);
    }
    // Block routing is keyed by message id, not item id, so it cannot be
    // trimmed entry-wise — but every entry that pointed into the dropped
    // suffix now points at nothing, and `resolveAssistantBlock` treats a
    // dangling entry as "make a new block", which is the right answer for a
    // message id that comes back after a rewind.
    for (const [messageId, blocks] of this.messageBlocks) {
      if (blocks.some((blockId) => blockId !== undefined && !this.items.has(blockId))) {
        this.messageBlocks.delete(messageId);
      }
    }
    // Same argument for the reasoning merges: a block routed into a row that
    // has been dropped would append the reasoning of a rewound turn onto
    // nothing, and the open stretch cannot go on being open once its row is
    // gone.
    for (const [blockId, rowId] of this.thinkingMerged) {
      if (!this.items.has(rowId)) this.thinkingMerged.delete(blockId);
    }
    if (this.thinkingStreak !== null && !this.items.has(this.thinkingStreak)) {
      this.thinkingStreak = null;
    }

    this.structural = true;
    this.markPending();
  }

  /** Drop everything. Used when starting a new session. */
  reset(): void {
    this.ids = [];
    this.items = new Map();
    this.rowsSnapshot = EMPTY_IDS;
    this.groupMembers = new Map();
    this.groupOf = new Map();
    this.groupSnapshots = new Map();
    this.buffers = new Map();
    this.messageBlocks = new Map();
    this.thinkingStreak = null;
    this.thinkingMerged = new Map();
    this.unconfirmedUser = [];
    this.userClaims = new Map();
    this.streaming.clear();
    this.openTools.clear();
    this.dirty.clear();
    // The test itself survives a reset — it belongs to the pane, not to the
    // conversation in it — but every verdict was about items that are now gone.
    this.artifactVerdicts.clear();
    this.lastSeq = null;
    this.counter = 0;
    this.structural = true;
    this.markPending();
  }

  /**
   * Fold one normalized event into the transcript.
   *
   * Ordering assumptions come straight from the protocol: `session.started`
   * first, `run.end` last and always present, every `tool.start` eventually
   * paired with a `tool.end`. Where an assumption is violated the model
   * degrades rather than throwing — a UI that crashes on a malformed event
   * stream is worse than one that shows an orphaned card.
   */
  apply(event: AgentEvent): void {
    this.checkSequence(event.runId, event.seq);

    switch (event.type) {
      case 'session.started':
        /*
         * Run-level facts, not a transcript entry — the same call `usage` gets
         * below, and for a stronger reason: this one used to be a row.
         *
         * It read "Session d7ffb873… started in /path · model … · mode … ·
         * resumed d7ffb873-…", which is a sentence about the provider process,
         * printed where the conversation goes. "Started" is true of the run and
         * false of the thread — the event fires once per prompt, so on a resumed
         * session it landed mid-conversation announcing that the thing already on
         * screen above it had just begun. The `resumed` clause was the only part
         * that said otherwise, in the smaller text, after the contradiction.
         *
         * Nothing is lost by dropping it. Session id, model, mode and cwd are all
         * in the run info dialog, which is where a fact that does not change
         * during the run belongs; `handleAgentEvent` still folds the event into
         * the pane's run state, which is what puts them there.
         */
        break;

      case 'text.delta': {
        const id = this.blockId('a', event.messageId, event.blockIndex);
        if (!this.items.has(id)) {
          this.insert({
            id,
            ts: event.ts,
            kind: 'assistant',
            messageId: event.messageId,
            blockIndex: event.blockIndex,
            text: '',
            streaming: true,
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          });
          this.trackBlock(event.messageId, id);
        }
        this.append(id, event.text);
        break;
      }

      case 'text.complete': {
        if (event.role === 'user') {
          this.completeUserText(event.text, event.replay === true, event.synthetic === true, event.ts, event.messageId);
          break;
        }
        const id = this.resolveAssistantBlock(event.messageId, event.blockIndex);
        const existing = this.items.get(id);
        const base: AssistantItem = {
          id,
          ts: existing?.ts ?? event.ts,
          kind: 'assistant',
          messageId: event.messageId,
          blockIndex: event.blockIndex ?? (existing?.kind === 'assistant' ? existing.blockIndex : 0),
          text: event.text,
          streaming: false,
          ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
          ...(event.replay === undefined ? {} : { replay: event.replay }),
          ...(event.synthetic === undefined ? {} : { synthetic: event.synthetic }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        };
        // `text.complete` carries the whole block, so it wins over the buffer.
        this.buffers.set(id, event.text);
        if (existing) this.replace(id, base);
        else {
          this.insert(base);
          this.trackBlock(event.messageId, id);
        }
        break;
      }

      case 'thinking.delta': {
        const id = this.thinkingRow(event);
        if (id !== null) this.append(id, event.text);
        break;
      }

      case 'tool.start': {
        const id = `t:${event.toolCallId}`;
        this.insert({
          id,
          ts: event.ts,
          kind: 'tool',
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
          status: 'running',
          ...(event.title === undefined ? {} : { title: event.title }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(event.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: event.parentToolCallId }),
        });
        // A new tool call ends the assistant block that issued it.
        this.settleStreaming();
        break;
      }

      case 'tool.end': {
        const id = `t:${event.toolCallId}`;
        const existing = this.items.get(id);
        const merged: ToolItem = {
          id,
          ts: existing?.ts ?? event.ts,
          kind: 'tool',
          toolCallId: event.toolCallId,
          name: existing?.kind === 'tool' ? existing.name : (event.name ?? 'tool'),
          input: existing?.kind === 'tool' ? existing.input : {},
          status: event.status,
          ...(existing?.kind === 'tool' && existing.title !== undefined
            ? { title: existing.title }
            : {}),
          ...(event.result === undefined ? {} : { result: event.result }),
          ...(event.resultText === undefined ? {} : { resultText: event.resultText }),
          ...(event.error === undefined ? {} : { error: event.error }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(event.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: event.parentToolCallId }),
        };
        if (existing) this.replace(id, merged);
        else this.insert(merged);
        break;
      }

      case 'permission.request': {
        const id = `p:${event.requestId}`;
        this.insert({
          id,
          ts: event.ts,
          kind: 'permission',
          requestId: event.requestId,
          request: event.request,
          state: 'pending',
        });
        this.settleStreaming();
        break;
      }

      /*
       * The other half of the pair, and the reason a reload no longer re-asks.
       *
       * `resolvePermission` above is called by whoever *sent* the decision; this
       * is for everyone who did not — a second window, and this window after
       * ⌘R, replaying the run's retained events into an empty transcript.
       *
       * It settles a *pending* card only. The local caller knows strictly more
       * than the event does — it holds the scope the user picked and can tell
       * `answered` from `skipped` — so when both fire, the local record already
       * on the card wins and this is a no-op. An unknown id is also a no-op:
       * the retained history is bounded, so a long run can drop the request and
       * keep the resolution.
       */
      case 'permission.resolved': {
        const existing = this.items.get(`p:${event.requestId}`);
        if (!existing || existing.kind !== 'permission' || existing.state !== 'pending') break;
        this.resolvePermission(
          event.requestId,
          settledState(event.outcome, existing.request.question !== undefined, event.answers),
          event.note,
          event.answers,
        );
        break;
      }

      case 'usage':
        // Usage is a run-level readout, not a transcript entry; the app store
        // keeps it and the detail panel renders it live.
        break;

      case 'session.commands':
        // What the provider *can* be asked to do, which is a fact about the run
        // and not something that was said. `handleAgentEvent` folds it into the
        // pane's run state, where `session.started` already put the first list
        // and where the composer's menu reads it from.
        break;

      case 'run.end': {
        this.settleStreaming();
        this.failOpenToolCalls(event.reason);
        const id = `e:${++this.counter}`;
        const silent = !this.produced;
        this.produced = false;
        this.insert({
          id,
          ts: event.ts,
          kind: 'run-end',
          reason: event.reason,
          silent,
          ...(event.error === undefined ? {} : { error: event.error }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.numTurns === undefined ? {} : { numTurns: event.numTurns }),
          ...(event.result === undefined ? {} : { result: event.result }),
        });
        this.lastSeq = null;
        break;
      }

      case 'plan.limit':
        // The account's health, not something that was said. It is folded into
        // the plan-usage cache in the main process, and the meter and the
        // profile menu are its surfaces — a thread entry per verdict would be
        // a log of a gauge.
        break;

      case 'command.run': {
        const id = `c:${++this.counter}`;
        this.insert({
          id,
          ts: event.ts,
          kind: 'command',
          name: event.command.name,
          ...(event.command.args === undefined ? {} : { args: event.command.args }),
          ...(event.command.output === undefined ? {} : { output: event.command.output }),
          ...(event.command.failed === undefined ? {} : { failed: event.command.failed }),
        });
        break;
      }

      case 'message.delivered':
        /*
         * Not a transcript entry: the row it names has been on screen since the
         * words were typed, and this changes nothing about what they were. What
         * it changes is what the *pane* may say about the message — see the
         * store, which is where the queued set lives. A transcript that grew a
         * row here would be a record of a message being read, under a record of
         * it being sent, saying the same sentence twice.
         */
        break;

      case 'background.tasks':
        /*
         * Not a transcript entry, and not for the usual reason.
         *
         * Everything else dropped here is dropped because it says nothing a
         * reader wants; this one says something a reader very much wants — what
         * is still running after the turn ended — and there is nowhere in a
         * *thread* to put it. The set is replaced on every change, so a row for
         * it would either be rewritten in place as tasks come and go, or become
         * one row per change; the first is not what a transcript is, and the
         * second is a log of a list.
         *
         * It is carried across IPC for the main process's sake — it decides
         * whether a provider process still has work in it — and the surface that
         * shows it to a person is a dock pane of its own (#89), which is a list
         * and can be replaced wholesale the way the payload is.
         */
        break;

      default: {
        // Exhaustiveness without a throw: a provider that learns a new event
        // type should not be able to take the window down.
        const unhandled: never = event;
        void unhandled;
        break;
      }
    }

    this.markPending();
  }

  /** Apply every coalesced change and notify. Public for tests. */
  flush(): void {
    this.pending = false;
    const changed = this.dirty;
    if (changed.size > 0) {
      this.dirty = new Set();
      for (const id of changed) {
        const item = this.items.get(id);
        if (!item) continue;
        const buffered = this.buffers.get(id);
        if (buffered !== undefined && (item.kind === 'assistant' || item.kind === 'thinking')) {
          if (item.text !== buffered) this.items.set(id, { ...item, text: buffered });
        }
        const listeners = this.itemListeners.get(id);
        if (listeners) for (const listener of listeners) listener();
      }
    }

    // Membership before summaries: a structural change can move a tool into a
    // different group, and recomputing the old group's counts first would
    // notify a group that is about to stop existing.
    const restructured = this.structural;
    if (restructured) {
      this.structural = false;
      this.idsSnapshot = this.ids.length === 0 ? EMPTY_IDS : this.ids.slice();
      this.rebuildRows();
      for (const listener of this.listListeners) listener();
    }

    this.refreshGroups(changed, restructured);
  }

  /* ---- internals ------------------------------------------------------ */

  private insert(item: TranscriptItem): void {
    if (this.items.has(item.id)) {
      this.replace(item.id, item);
      return;
    }
    /*
     * The one place a stretch of reasoning ends, and the reason it is one place.
     *
     * Every row that stands in the thread — an answer, a prompt, a permission
     * card, a notice, a run-end — arrives through here, so "anything but
     * reasoning and tool calls breaks the streak" is a single line rather than a
     * clause repeated in six `apply` cases and forgotten in the seventh. Tool
     * calls are the exception because they do not stand in the thread: they sink
     * to the marker at the foot of the run, which leaves the blocks either side
     * of them adjacent on screen.
     */
    if (item.kind !== 'thinking' && item.kind !== 'tool') this.thinkingStreak = null;
    // Anything the *agent* put here counts as the run having produced
    // something; the person's own prompt and our local notices do not. Read
    // and cleared by the `run.end` that closes the run. See `RunEndItem.silent`.
    if (item.kind === 'assistant' || item.kind === 'thinking' || item.kind === 'tool' || item.kind === 'command') {
      this.produced = true;
    }
    this.items.set(item.id, item);
    this.ids.push(item.id);
    if (item.kind === 'assistant' || item.kind === 'thinking') this.buffers.set(item.id, item.text);
    this.index(item);
    this.structural = true;
    this.dirty.add(item.id);
    this.markPending();
  }

  private replace(id: string, item: TranscriptItem): void {
    // A tool call's artifact verdict is taken again here, because this is where
    // `tool.end` lands and a call that is still running is never an artifact.
    // A verdict that *changed* is a structural change — the row has to leave the
    // burst it was folded into — and `replace` does not otherwise set that flag,
    // so without this the tile would not surface until the next unrelated insert.
    const wasArtifact = this.isArtifact(id);
    if (item.kind === 'tool') this.artifactVerdicts.delete(id);

    this.items.set(id, item);
    if (item.kind === 'tool' && this.isArtifact(id) !== wasArtifact) this.structural = true;

    this.index(item);
    this.dirty.add(id);
    this.markPending();
  }

  /**
   * Recompute the row sequence, folding runs of machinery into groups.
   *
   * O(items), and called only where the `ids` snapshot is already being copied
   * — so this rides along with work the model was doing anyway rather than
   * adding a pass of its own. See {@link ActivityGroup} for why it cannot live
   * in the component, and why a run is thinking-and-tools rather than tools.
   *
   * A group is named for its first member, which makes the id stable as the
   * run grows: appending to an open burst extends the group rather than
   * renaming it, so an expanded marker does not collapse itself every time the
   * agent runs one more command.
   *
   * No row id changes under the reader as a run grows. A message keeps its own
   * id wherever it lands, and a call joins a marker named for the first call of
   * its run — so the marker at the foot extends rather than being renamed, and
   * an expanded one does not collapse itself every time the agent runs one more
   * command.
   */
  private rebuildRows(): void {
    const rows: string[] = [];
    const members = new Map<string, readonly string[]>();
    const groupOf = new Map<string, string>();

    /*
     * The calls sink to the foot of their run. Everything else stays put.
     * ------------------------------------------------------------------
     *
     * Calls used to be emitted where they happened, folded into a marker per
     * burst. That reads as the agent being interrupted: a paragraph, a `Ran 3
     * commands` bar, the rest of the paragraph — and the prose is what the
     * reader came for. The work is worth seeing and is not worth seeing *there*.
     *
     * So every tool call in a run collects into one marker beneath that run's
     * last message, growing as the run goes. The conversation reads as
     * conversation; the account of how it was done sits under it, in order, in
     * one place.
     *
     * Reasoning is not part of that account and never sinks. It is the model
     * working out what to say, which belongs against the saying of it — see
     * {@link ActivityGroup}. So a thinking block is an ordinary row here, in the
     * position it arrived in, and the marker below holds only calls.
     *
     * A run's boundary is its `run-end` row — or, in a session read back from
     * disk, the next thing the user said, because stored history has no
     * `run-end` in it at all. The tail after the last boundary is the run in
     * flight, which is why the flush happens on those rows and once at the end.
     */
    let machinery: string[] = [];
    let lifted: string[] = [];

    const flush = (): void => {
      const first = machinery[0];
      if (first !== undefined) {
        // Named for the first member, so appending to a live run extends the
        // marker rather than renaming it — an expanded marker must not collapse
        // itself every time the agent runs one more command.
        const groupId = `g:${first}`;
        for (const memberId of machinery) groupOf.set(memberId, groupId);
        members.set(groupId, machinery);
        rows.push(groupId);
      }
      // Below the marker: the tiles are the reason anyone opens this stretch,
      // so they come out under the one line that describes the work.
      for (const artifactId of lifted) rows.push(artifactId);
      machinery = [];
      lifted = [];
    };

    for (const id of this.ids) {
      if (id === undefined) continue;

      if (this.isMachinery(id)) {
        if (this.isArtifact(id)) lifted.push(id);
        else machinery.push(id);
        continue;
      }

      /*
       * A run ending closes the account of it — unless the reader ended it.
       *
       * The boundary is the *break*: the model stopped, said its piece, and is
       * waiting. Everything it did to get there belongs in one marker under
       * it, and the next thing asked starts a fresh one.
       *
       * An interruption is not that break. Stopping a run to redirect it is one
       * request being steered, not two: the calls before the interruption and
       * the calls after it are the same piece of work, and splitting them into
       * two markers would report the reader's impatience as a boundary in what
       * the agent did. So the run-end row goes out — it happened, and the
       * transcript is the record — and the accumulation carries across it into
       * the run that follows.
       *
       * The flush comes before the row for the same reason it always did: the
       * account of a run reads above the line that ends it.
       */
      const row = this.items.get(id);
      if (row?.kind === 'run-end') {
        if (row.reason !== 'interrupted') flush();
        rows.push(id);
        continue;
      }

      /*
       * The boundary a replay has instead of a `run.end`.
       *
       * Stored history is messages and nothing else — the provider's file
       * records what was said, not that Artemis considered a run over — so a
       * reopened conversation reaches here with no `run-end` row anywhere in
       * it. Without this the loop above never flushes until the very end, and
       * every call in the session collects into one marker parked beneath the
       * last message: a hundred tool cards under a single line, sitting below
       * the conversation instead of inside it, and named for the first call of
       * the session rather than the first call of its run. That last part is
       * what quietly broke `lib/foldMemory` — the ids a reload produced could
       * not match the ids the live run had written, so every marker opened at
       * its default again however the reader had left it.
       *
       * A turn the user started is the same boundary written in the provider's
       * own words: the work above it is finished, the work below belongs to
       * what they asked next. Flushing here puts each turn's marker under that
       * turn, which is where the live run drew it.
       *
       * Only a *replayed* user row. A live one mid-run is steering, and
       * splitting there would report the reader's redirection as a boundary in
       * what the agent did — the same thing the interrupt case above refuses to
       * do.
       */
      if (row?.kind === 'user' && row.replay === true) flush();

      rows.push(id);
    }

    flush();

    // Retire cached summaries whose group is gone or whose membership moved.
    // Everything else keeps its object identity, which is the point.
    for (const [groupId, snapshot] of this.groupSnapshots) {
      const next = members.get(groupId);
      if (next === undefined || !sameIds(next, snapshot.ids)) this.groupSnapshots.delete(groupId);
    }

    this.groupMembers = members;
    this.groupOf = groupOf;
    this.rowsSnapshot = rows.length === 0 ? EMPTY_IDS : rows.slice();
  }

  /**
   * Rebuild the summaries that could have changed, and notify only those.
   *
   * The comparison matters more than it looks, and more than it used to. A
   * `tool.end` marks one item dirty, and without the equality check every
   * marker on screen would be notified on every flush that touched any tool —
   * but a *thinking* member is dirty on every frame it streams, so this is now
   * what keeps a group silent while one of its blocks is being written. It can
   * be: the summary holds counters, never text, so the rebuilt snapshot
   * compares equal until something actually happens.
   */
  private refreshGroups(changed: ReadonlySet<string>, restructured: boolean): void {
    const touched = new Set<string>();
    if (restructured) for (const groupId of this.groupMembers.keys()) touched.add(groupId);
    for (const id of changed) {
      const groupId = this.groupOf.get(id);
      if (groupId !== undefined) touched.add(groupId);
    }
    if (touched.size === 0) return;

    for (const groupId of touched) {
      const next = this.buildGroup(groupId);
      if (!next) {
        this.groupSnapshots.delete(groupId);
        continue;
      }
      const previous = this.groupSnapshots.get(groupId);
      if (previous && sameGroup(previous, next)) continue;
      this.groupSnapshots.set(groupId, next);
      const listeners = this.groupListeners.get(groupId);
      if (listeners) for (const listener of listeners) listener();
    }
  }

  /** Count one group's members by category. O(members), not O(items). */
  private buildGroup(id: string): ActivityGroup | undefined {
    const ids = this.groupMembers.get(id);
    if (ids === undefined || ids.length === 0) return undefined;

    const counts: Partial<Record<ToolCategory, number>> = {};
    let running = 0;
    let failed = 0;
    let ts: number | undefined;

    for (const memberId of ids) {
      const item = this.items.get(memberId);
      if (item?.kind !== 'tool') continue;
      ts ??= item.ts;
      const category = classifyTool(item.name);
      counts[category] = (counts[category] ?? 0) + 1;
      if (item.status === 'running') running += 1;
      else if (item.status === 'error' || item.status === 'denied') failed += 1;
    }

    return { id, ids, ts: ts ?? 0, counts, running, failed };
  }

  /**
   * Whether a row is machinery — the thing the marker at the foot is made of.
   *
   * Tool calls, and only tool calls. Reasoning was in here once; it is content
   * now, and stands in the thread where the model wrote it whether or not the
   * reader has asked to see it expanded. See {@link ActivityGroup} for why the
   * two stopped being one category.
   */
  private isMachinery(id: string): boolean {
    return this.items.get(id)?.kind === 'tool';
  }

  /**
   * Whether this row is an artifact, and therefore not foldable.
   *
   * `false` whenever no test is installed, which is the state a bare
   * `new TranscriptModel()` is in — the model folds exactly as it always did
   * until a pane teaches it otherwise, so nothing here depends on the wiring
   * being present.
   */
  private isArtifact(id: string): boolean {
    const cached = this.artifactVerdicts.get(id);
    if (cached !== undefined) return cached;
    const test = this.artifactTest;
    if (test === null) return false;
    const item = this.items.get(id);
    if (item?.kind !== 'tool') return false;
    const verdict = test(item);
    this.artifactVerdicts.set(id, verdict);
    return verdict;
  }

  /** Keep the open-work indexes in step with an item's current state. */
  private index(item: TranscriptItem): void {
    if (item.kind === 'assistant' || item.kind === 'thinking') {
      if (item.streaming) this.streaming.add(item.id);
      else this.streaming.delete(item.id);
    } else if (item.kind === 'tool') {
      if (item.status === 'running') this.openTools.add(item.id);
      else this.openTools.delete(item.id);
    }
  }

  private append(id: string, chunk: string): void {
    if (chunk.length === 0) return;
    this.buffers.set(id, (this.buffers.get(id) ?? '') + chunk);
    this.dirty.add(id);
  }

  private markPending(): void {
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => this.flush());
  }

  private blockId(prefix: 'a' | 'k', messageId: string, blockIndex: number): string {
    return `${prefix}:${messageId}:${blockIndex}`;
  }

  private trackBlock(messageId: string, id: string): void {
    const blocks = this.messageBlocks.get(messageId);
    if (blocks) blocks.push(id);
    else this.messageBlocks.set(messageId, [id]);
  }

  /**
   * Which row a thinking delta is written into — a new one, or the stretch of
   * reasoning already open.
   *
   * `null` means the event earns no row at all. A thinking block earns one by
   * having something in it, and an event with neither text nor a redaction
   * notice would open a fold that says "thinking…" and never fills; the
   * providers emit a lot of those (see `ThinkingDeltaEvent`). The mappers drop
   * them at the source and this is the backstop, checked on *creation* rather
   * than by a later sweep: a block whose text arrives in a second delta is
   * created by the delta that carries it, so nothing has to decide when an
   * empty block has stayed empty long enough to retract.
   *
   * Everything else here is the merge. A block that has already been placed —
   * as a row of its own or into one — goes back where it went, so the per-token
   * path is one map lookup. A block arriving into an open stretch is appended to
   * it after a blank line, which is what makes two paragraphs read as two
   * paragraphs (and is what markdown needs to see to keep them apart).
   *
   * Redaction never merges, in either direction. "The provider withheld this
   * one" is a notice about a *block*, so it cannot be glued onto the end of
   * prose it is not about, and prose cannot be glued onto it — it ends the
   * stretch and the next block starts a fresh row.
   *
   * Neither does reasoning from a different agent. A row carries one `agentId`,
   * and a subagent's working-out appended to the main agent's would be two
   * minds in one paragraph attributed to whichever spoke first.
   */
  private thinkingRow(event: ThinkingDeltaEvent): string | null {
    const blockId = this.blockId('k', event.messageId, event.blockIndex);
    if (this.items.has(blockId)) return blockId;
    const merged = this.thinkingMerged.get(blockId);
    if (merged !== undefined) return merged;
    if (event.text === '' && event.redacted !== true) return null;

    const open = this.thinkingStreak === null ? undefined : this.items.get(this.thinkingStreak);
    if (
      event.redacted !== true &&
      open?.kind === 'thinking' &&
      !open.redacted &&
      open.agentId === event.agentId
    ) {
      this.thinkingMerged.set(blockId, open.id);
      this.append(open.id, '\n\n');
      // A tool call between the two settled the row (see `settleStreaming`), and
      // it is being written to again — so it is live again, or the pulse beside
      // it goes out for the rest of a turn that is still thinking.
      if (!open.streaming) this.replace(open.id, { ...open, streaming: true });
      return open.id;
    }

    this.insert({
      id: blockId,
      ts: event.ts,
      kind: 'thinking',
      messageId: event.messageId,
      blockIndex: event.blockIndex,
      text: '',
      streaming: true,
      redacted: event.redacted === true,
      ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    });
    this.thinkingStreak = event.redacted === true ? null : blockId;
    return blockId;
  }

  /**
   * Find the item a `text.complete` belongs to.
   *
   * With a `blockIndex` it is a direct hit. Without one — providers that do
   * not stream never send an index — it attaches to the last still-streaming
   * block of that message, or starts a new one.
   */
  private resolveAssistantBlock(messageId: string, blockIndex: number | undefined): string {
    if (blockIndex !== undefined) return this.blockId('a', messageId, blockIndex);
    const blocks = this.messageBlocks.get(messageId) ?? [];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const candidate = blocks[i];
      if (candidate === undefined) continue;
      const item = this.items.get(candidate);
      if (item?.kind === 'assistant' && item.streaming) return candidate;
    }
    return this.blockId('a', messageId, blocks.length);
  }

  /**
   * Reconcile a provider-echoed user message with the optimistic one already
   * on screen, so the user's own prompt does not appear twice.
   */
  private completeUserText(
    text: string,
    replay: boolean,
    synthetic: boolean,
    ts: number,
    messageId?: string,
  ): void {
    /*
     * Identity first, whichever door the event came through.
     *
     * A user event naming a message this transcript already holds is the same
     * message coming back — the registry's retained prompt re-applied by the
     * stall sweep, or the same replay delivered twice — and the only correct
     * number of rows for it is one. The merge keeps what only the optimistic
     * row has (its attachments, its place in the order) and takes the event's
     * word for the rest. Without this, the sweep's heal drew the prompt again
     * under the copy the user watched themselves type: the optimistic row has
     * a local id, the replayed prompt minted another, and nothing could ever
     * collapse the two.
     */
    if (messageId !== undefined) {
      const claimedId = this.userClaims.get(messageId);
      if (claimedId !== undefined) {
        const claimed = this.items.get(claimedId);
        if (claimed?.kind === 'user') {
          this.replace(claimedId, { ...claimed, text, pending: false, messageId });
          return;
        }
      }
    }
    if (!replay && !synthetic) {
      const pendingId = this.unconfirmedUser.shift();
      if (pendingId !== undefined) {
        const existing = this.items.get(pendingId);
        if (existing?.kind === 'user') {
          // The echo is where a locally-typed message learns its provider id —
          // the optimistic insert could not have known it. See
          // {@link UserItem.messageId} for what the id buys.
          if (messageId !== undefined) this.userClaims.set(messageId, pendingId);
          this.replace(pendingId, {
            ...existing,
            text,
            pending: false,
            ...(messageId === undefined ? {} : { messageId }),
          });
          return;
        }
      }
    }
    const id = `u:${++this.counter}`;
    if (messageId !== undefined) this.userClaims.set(messageId, id);
    this.insert({
      id,
      ts,
      kind: 'user',
      text,
      pending: false,
      ...(replay ? { replay } : {}),
      ...(messageId === undefined ? {} : { messageId }),
    });
  }

  /** Mark every streaming block finished. Called when the turn moves on. */
  private settleStreaming(): void {
    if (this.streaming.size === 0) return;
    for (const id of this.streaming) {
      const item = this.items.get(id);
      if (item?.kind === 'assistant' || item?.kind === 'thinking') {
        this.replace(id, { ...item, text: this.buffers.get(id) ?? item.text, streaming: false });
      }
    }
    this.streaming.clear();
  }

  /**
   * Close out tool calls the provider left open.
   *
   * The protocol says every `tool.start` gets a `tool.end`, including on
   * interrupt — but the UI must never be left with a spinner it cannot clear,
   * so a run that ends with calls still running gets them closed here.
   */
  private failOpenToolCalls(reason: RunEndReason): void {
    if (this.openTools.size === 0) return;
    const status: ToolStatus = reason === 'error' ? 'error' : 'cancelled';
    for (const id of this.openTools) {
      const item = this.items.get(id);
      if (item?.kind === 'tool' && item.status === 'running') this.replace(id, { ...item, status });
    }
    this.openTools.clear();
  }

  /**
   * `seq` is dense per run; a gap means the transport dropped something.
   *
   * Per run is the load-bearing part. The counter resets when the run it was
   * counting changes, because a run that never delivered its `run.end` — the
   * exact loss this check exists to notice — leaves `lastSeq` holding the old
   * run's position. Compared against the next run's dense-from-zero numbering
   * that is a counter ~N events ahead: every real gap in the newcomer's first
   * N events reads as "already seen" and the drop passes unremarked, in the
   * one conversation that has already demonstrated it drops things.
   */
  private checkSequence(runId: RunId, seq: number): void {
    if (runId !== this.lastSeqRun) {
      this.lastSeqRun = runId;
      this.lastSeq = null;
    }
    if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      const missing = seq - this.lastSeq - 1;
      this.note('warn', `${missing} event${missing === 1 ? '' : 's'} were dropped in transit`);
      // The note is for the reader; this is for the store, which has to ask
      // whether one of the missing events was the run's end. See the hook.
      onEventsDropped?.(runId);
    }
    if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
  }
}

/**
 * How a `permission.resolved` outcome reads on the card.
 *
 * The wire says what happened to the *request*; the card says what happened in
 * the *conversation*, and for a question those are different words. Answering
 * is not "allowing", and an interview nobody filled in was not "denied" — the
 * same distinction the store draws when it settles a card locally, kept in step
 * here so a replayed record does not read differently from a live one.
 *
 * `withdrawn` lands on `denied` because the tool did not run and there is no
 * fifth state worth adding for it. What separates the two is the note, which
 * says the provider took the choice away rather than the user making one.
 */
function settledState(
  outcome: 'allowed' | 'denied' | 'withdrawn',
  isQuestion: boolean,
  answers: readonly QuestionAnswer[] | undefined,
): Exclude<PermissionItem['state'], 'pending'> {
  if (outcome !== 'allowed') return 'denied';
  if (!isQuestion) return 'allowed';
  const answered = (answers ?? []).some(
    (a) => a.options.length > 0 || (a.notes?.trim().length ?? 0) > 0,
  );
  return answered ? 'answered' : 'skipped';
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether two summaries say the same thing.
 *
 * Field-by-field rather than a `JSON.stringify` compare: this runs on every
 * flush that touches a tool, and serialising both sides to decide "nothing
 * changed" would allocate two strings per group per tool call.
 */
function sameGroup(a: ActivityGroup, b: ActivityGroup): boolean {
  if (a.ts !== b.ts || a.running !== b.running || a.failed !== b.failed) return false;
  if (!sameIds(a.ids, b.ids)) return false;
  const keys = Object.keys(a.counts) as ToolCategory[];
  if (keys.length !== Object.keys(b.counts).length) return false;
  for (const key of keys) if (a.counts[key] !== b.counts[key]) return false;
  return true;
}
