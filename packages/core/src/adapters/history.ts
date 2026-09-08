/**
 * Replaying a past session into the live event stream.
 *
 * Clicking a session in the sidebar used to resume it against an empty
 * transcript: the agent had the full conversation in its context, but the user
 * could not see any of it. The history was on disk the whole time — nothing
 * read it.
 *
 * The design decision here is that history produces **the same
 * {@link AgentEvent}s a live run produces**, rather than a second "historical
 * message" shape. One rendering path means a replayed tool call collapses,
 * expands and diffs exactly like a live one, and it means no component has to
 * know whether what it is drawing already happened.
 *
 * ## What is deliberately lost
 *
 * A transcript is a lossy record of a run, and pretending otherwise would be
 * worse than admitting it:
 *
 *  - **Sub-message timing is gone.** A stored record carries one timestamp for
 *    the whole message, so every block replayed out of it shares that time —
 *    the live stream's block-by-block arrival is not recoverable. The message
 *    time itself is real: it is read from the record (see
 *    {@link storedTimestamp}), and only a record that carries none falls back
 *    to the read time.
 *
 *    This used to say stored messages had no wall-clock time at all, and every
 *    replayed event was stamped with `now()` on that basis. They do carry one
 *    — the SDK returns `timestamp` on every user and assistant record — so the
 *    whole of a reopened conversation showed the moment it was reloaded,
 *    identically, on every line.
 *  - **Streaming is gone.** Text arrives as one `text.complete` per block, not
 *    as deltas. There is nothing to stream — it finished.
 *  - **Permission prompts are gone.** They were answered long ago, and
 *    replaying one would offer the user a decision that cannot be made.
 */

import type { AgentEvent, RunId, SessionId } from '@rx-artemis/protocol';

import { toJsonObject, toJsonValue } from './mapper.js';

/** A stored message, in the shape the provider hands back. */
export interface StoredMessage {
  /**
   * `attachment` is the CLI's own record of something it fed the model that
   * nobody typed as a turn — and one kind of it is exactly something somebody
   * typed: a message sent mid-turn. See {@link replayQueuedCommand}.
   */
  readonly type: 'user' | 'assistant' | 'system' | 'attachment';
  readonly uuid: string;
  readonly message?: unknown;
  /** The attachment body, on an `attachment` record. */
  readonly attachment?: unknown;
  /**
   * When the provider recorded it — an ISO 8601 string in every transcript
   * seen so far, tolerated as epoch milliseconds too.
   *
   * Optional because a record without one has to replay anyway: the fallback
   * is the read time, which is what every replayed event used to carry.
   */
  readonly timestamp?: unknown;
}

/** Envelope fields every replayed event needs. */
export interface ReplayContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  /**
   * Read time — the fallback for a record that carries no timestamp of its
   * own. See {@link storedTimestamp}.
   */
  readonly ts: number;
  /** Sequence counter, continuing from wherever the caller is. */
  next(): number;
}

/** Content blocks as the API writes them, narrowed only as far as we read them. */
interface ContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
}

/** `message.content` is a string or a block array, depending on the message. */
function contentBlocks(message: unknown): readonly ContentBlock[] {
  if (message === null || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;

  // A bare string is shorthand for a single text block.
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => block !== null && typeof block === 'object');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Text the harness wrote into a user slot, recognised by its own frame.
 *
 * `role: "user"` is an addressing slot, not a claim of authorship — the CLI
 * writes its own prompts there too, and the live mapper drops those by reading
 * the message's `origin`. That field never reaches this module: the SDK's
 * stored-session read strips everything but the message body, and the one
 * harness turn it does not filter out on its own is the task notification —
 * `origin: { kind: 'task-notification' }` on disk, but *not* `isMeta`, so it
 * comes back looking exactly like something the person typed. Replayed as a
 * user row it dumps `<task-notification><task-id>…` into the transcript as
 * though the user had said it, which is the bug this exists to stop.
 *
 * So the check here is on the text itself, and deliberately narrow: the
 * notification's opening tag, and the interrupt markers the CLI records when a
 * turn is stopped. All three are the harness's own fixed frames, not shapes a
 * person's message could drift into by accident — a real message *quoting* one
 * would have to start with the tag character-for-character.
 */
function isHarnessNote(text: string): boolean {
  if (text.startsWith('<task-notification>')) return true;
  return text === '[Request interrupted by user]' || text === '[Request interrupted by user for tool use]';
}

/**
 * The provider's message id out of a stored record, when it has one.
 *
 * Deliberately narrow: only a non-empty string counts, so a malformed record
 * falls back to the envelope uuid rather than keying blocks on `undefined`.
 */
function storedMessageId(stored: StoredMessage): string | undefined {
  if (typeof stored.message !== 'object' || stored.message === null) return undefined;
  return asString((stored.message as { readonly id?: unknown }).id);
}

/**
 * When the provider says this message happened, in epoch milliseconds.
 *
 * `undefined` for a record that carries nothing usable, which is what makes
 * the read-time fallback the *exception* rather than the rule. Accepts the ISO
 * string the transcripts actually contain and a bare epoch number, and refuses
 * anything else — a `NaN` reaching the envelope would render as "Invalid
 * Date", which is a worse lie than the read time it replaced.
 */
export function storedTimestamp(stored: StoredMessage): number | undefined {
  const raw = stored.timestamp;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Turn one stored message into the events it would have emitted live.
 *
 * Returns an empty array for anything unrecognised rather than throwing: a
 * transcript written by a newer provider version must still render the parts
 * this build understands. Dropping one block beats failing the whole replay.
 */
export function replayStoredMessage(
  stored: StoredMessage,
  context: ReplayContext,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  // The message's own recorded time, so a reopened conversation reads as the
  // afternoon it happened rather than the moment it was reloaded. Every block
  // of one message shares it, which is what the live mapper does too.
  const ts = storedTimestamp(stored) ?? context.ts;
  const envelope = (): { runId: RunId; seq: number; ts: number } => ({
    runId: context.runId,
    seq: context.next(),
    ts,
  });

  // System messages are provider bookkeeping — compact boundaries, notices.
  // They were never shown live, so showing them now would be new noise.
  if (stored.type === 'system') return events;

  // A message the person sent mid-turn, stored the only way the CLI stores
  // one. Its own branch, because it has no `message` body to read blocks from.
  if (stored.type === 'attachment') {
    const queued = replayQueuedCommand(stored, ts, envelope);
    if (queued !== undefined) events.push(queued);
    return events;
  }

  // The provider's own message id, so replayed blocks from one message group
  // together exactly as live ones do.
  //
  // This has to be `message.id` and not the envelope's `uuid`, because the live
  // mapper keys blocks on `message.id`. Keying replay on `uuid` gave every
  // replayed turn an identity its live counterpart could never match, so a turn
  // that was both replayed and live rendered twice.
  const messageId = storedMessageId(stored) ?? stored.uuid;

  contentBlocks(stored.message).forEach((block, blockIndex) => {
    const type = asString(block.type);

    if (type === 'text') {
      const text = asString(block.text);
      if (text === undefined) return;
      // A harness note in a user slot is not the person talking. See
      // {@link isHarnessNote} for why this is a shape check rather than a flag.
      if (stored.type === 'user' && isHarnessNote(text)) return;
      events.push({
        ...envelope(),
        type: 'text.complete',
        messageId,
        role: stored.type === 'user' ? 'user' : 'assistant',
        text,
        blockIndex,
        // The protocol has a flag for precisely this, so the UI can tell
        // "already happened" from "just generated" without inferring it.
        replay: true,
      });
      return;
    }

    if (type === 'thinking') {
      const text = asString(block.thinking);
      // A stored thinking block is very often `thinking: ''` beside a full
      // signature — the provider kept the block and withheld its content. It
      // replays as nothing worth a row, so it does not get one.
      if (text === undefined || text === '') return;
      events.push({ ...envelope(), type: 'thinking.delta', messageId, blockIndex, text });
      return;
    }

    if (type === 'tool_use') {
      const id = asString(block.id);
      const name = asString(block.name);
      if (id === undefined || name === undefined) return;
      events.push({
        ...envelope(),
        type: 'tool.start',
        toolCallId: id,
        name,
        input: toJsonObject(block.input),
        messageId,
      });
      return;
    }

    if (type === 'tool_result') {
      const id = asString(block.tool_use_id);
      if (id === undefined) return;
      events.push({
        ...envelope(),
        type: 'tool.end',
        toolCallId: id,
        // A stored transcript records success or failure, never a denial or a
        // cancellation — those end a call before a result is written.
        status: block.is_error === true ? 'error' : 'ok',
        result: toJsonValue(block.content),
      });
      return;
    }
  });

  return events;
}

/**
 * A message sent while the agent was working, read back as the user row it was.
 *
 * The CLI never files a mid-turn message as a `user` turn. It queues it, and
 * when a tool batch finishes it feeds the words to the model as a
 * `queued_command` *attachment* — the model sees them inside the next tool
 * result — and writes that attachment record to the transcript, with the text
 * under `prompt`. On the live stream the adapter tails the file for exactly
 * this record to report the delivery (see `#watchDeliveries` in `claude.ts`).
 *
 * Replay used to skip the record, because it is not a `user` message and has
 * no `message` body. The effect was a conversation that read differently the
 * second time: the reply discussed a message that was nowhere above it, on
 * every reopen, reload and hand-off — while the live pane, which had drawn the
 * optimistic row when the words were typed, showed it fine. This puts the row
 * back where the CLI read it, which is where the live transcript had it too.
 *
 * Only `queued_command`. The CLI files other attachments — a file the model was
 * shown, an editor selection — and none of those is a person's sentence.
 */
function replayQueuedCommand(
  stored: StoredMessage,
  ts: number,
  envelope: () => { runId: RunId; seq: number; ts: number },
): AgentEvent | undefined {
  const attachment = stored.attachment;
  if (attachment === null || typeof attachment !== 'object') return undefined;
  const record = attachment as { readonly type?: unknown; readonly prompt?: unknown };
  if (record.type !== 'queued_command') return undefined;
  const text = asString(record.prompt);
  if (text === undefined) return undefined;
  void ts;
  return {
    ...envelope(),
    type: 'text.complete',
    messageId: stored.uuid,
    role: 'user',
    text,
    blockIndex: 0,
    replay: true,
  };
}

/**
 * Put the CLI's queued-command records back among the messages they sit between.
 *
 * The SDK's stored-session read returns `user` and `assistant` records only —
 * an `attachment` record never comes back from it — so the caller reads those
 * off the transcript file itself and hands them here to be merged by time,
 * which is the one ordering both kinds of record carry. Messages are the
 * page's, already cut to the caller's `limit` and `offset`; a record that
 * falls outside the page's span is another page's and is left out, so a
 * paged read never shows one twice or on the wrong page.
 *
 * `first` and `last` say whether the page has an edge on that side: a page
 * that begins the session keeps every record before its first message, and
 * one that ends it keeps every record after its last.
 */
export function mergeQueuedCommands(
  messages: readonly StoredMessage[],
  queued: readonly StoredMessage[],
  edges: { readonly first: boolean; readonly last: boolean },
): readonly StoredMessage[] {
  if (queued.length === 0) return messages;
  const at = (stored: StoredMessage): number | undefined => storedTimestamp(stored);
  const times = messages.map(at);
  const head = times.find((time) => time !== undefined);
  const tail = [...times].reverse().find((time) => time !== undefined);

  const out: StoredMessage[] = [];
  const pending = [...queued]
    .filter((record) => {
      const time = at(record);
      if (time === undefined) return false;
      if (!edges.first && head !== undefined && time < head) return false;
      if (!edges.last && tail !== undefined && time > tail) return false;
      return true;
    })
    .sort((a, b) => (at(a) ?? 0) - (at(b) ?? 0));

  for (const [index, message] of messages.entries()) {
    const time = times[index];
    while (pending.length > 0 && time !== undefined && (at(pending[0] as StoredMessage) ?? 0) <= time) {
      out.push(pending.shift() as StoredMessage);
    }
    out.push(message);
  }
  out.push(...pending);
  return out;
}

/**
 * Replay a whole stored session.
 *
 * Ordering is the provider's, preserved exactly: a transcript re-sorted by
 * anything other than its original sequence would interleave tool calls with
 * the wrong results.
 */
export function replayStoredSession(
  messages: readonly StoredMessage[],
  context: ReplayContext,
): readonly AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const message of messages) events.push(...replayStoredMessage(message, context));
  return events;
}

/* -------------------------------------------------------------------------- */
/* Rewind                                                                     */
/* -------------------------------------------------------------------------- */

/** Where a truncating resume should re-enter the chain. */
export interface RewindPoint {
  /** The chain uuid of the last entry the resumed session keeps. */
  readonly resumeSessionAt: string;
  /**
   * The prompt uuid of the turn being discarded — present only when the
   * discarded range is that one turn, which is the only shape the provider's
   * `--resume-drops-turn` acknowledgement can vouch for. A deeper rewind omits
   * it and takes its chances with the provider's own guard.
   */
  readonly dropsTurn?: string;
}

/**
 * Whether a stored entry is something the user actually asked — the start of a
 * turn — as opposed to the other things that arrive in a user-typed envelope:
 * tool results, and the harness notes {@link isHarnessNote} names.
 */
function isPromptEntry(stored: StoredMessage): boolean {
  if (stored.type !== 'user') return false;
  const blocks = contentBlocks(stored.message);
  if (blocks.some((block) => block.type === 'tool_result')) return false;
  return blocks.some(
    (block) =>
      block.type === 'text' && typeof block.text === 'string' && !isHarnessNote(block.text),
  );
}

/**
 * Resolve "rewind to just before this prompt" against the stored chain.
 *
 * The renderer knows which prompt the user pointed at — its uuid rides the
 * transcript — but a truncating resume re-enters the chain at the entry
 * *before* it, and only the stored file knows what that was. `null` when the
 * uuid is not in the chain or has nothing before it; the caller turns that
 * into an error worth reading, because both mean the rewind cannot happen.
 */
export function resolveRewindPoint(
  messages: readonly StoredMessage[],
  promptUuid: string,
): RewindPoint | null {
  const at = messages.findIndex((stored) => stored.uuid === promptUuid);
  if (at <= 0) return null;

  const before = messages[at - 1];
  if (before === undefined) return null;

  // One turn, or more? The provider's drops-turn acknowledgement names a
  // single prompt, so a range holding a second prompt cannot be declared.
  const laterPrompts = messages
    .slice(at + 1)
    .some((stored) => isPromptEntry(stored));

  return {
    resumeSessionAt: before.uuid,
    ...(laterPrompts ? {} : { dropsTurn: promptUuid }),
  };
}
