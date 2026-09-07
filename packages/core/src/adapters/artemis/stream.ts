/**
 * Reading another Artemis's chat-completions stream.
 * ============================================================================
 *
 * The wire is the same OpenAI-shaped SSE the local servers speak — see
 * `../local/stream.ts`, whose framing helper this reuses — plus the `artemis`
 * namespace the Artemis server adds to its chunks: the session id, the
 * activity report, and the true end reason. The local reader deliberately
 * ignores fields it does not know, so this one exists to read them.
 *
 * Forgiving for the same reason the local reader is: one malformed chunk must
 * not kill a reply that is otherwise arriving. The exception is an explicit
 * `error` object, which is the server saying the generation failed.
 */

import type { ArtemisActivity, ArtemisPermissionNotice, PermissionRequest } from '@rx-artemis/protocol';

/** The Artemis namespace, as much of it as a chunk carried. */
export interface ServerExtensionsDelta {
  readonly sessionId?: string;
  readonly resolvedModel?: string;
  readonly activity?: readonly ArtemisActivity[];
  readonly endReason?: string;
  /**
   * The server's own run id, announced once and early on a turn that opted into
   * a remote feature. Distinct from the adapter's local run id — this is the
   * address every native `/api/v0/runs/{id}` route takes, so it is learned off
   * the stream and kept, exactly the way the session id is.
   */
  readonly runId?: string;
  /**
   * The resume cursor: the sequence number of the run event this chunk came
   * from. Remembered by the adapter, and handed back on
   * `GET /api/v0/runs/{id}/stream?after=N` when the stream has to be picked
   * back up. Absent on the chunks that came from no event.
   */
  readonly seq?: number;
  /**
   * On a resumed stream: the server no longer holds everything after the
   * cursor. What follows starts at `firstSeq`.
   */
  readonly gap?: { readonly afterSeq: number; readonly firstSeq: number };
  /**
   * A permission prompt the run parked on, or the news that it no longer is.
   * Only present when the request opted into remote permissions; on any other
   * turn the server denies prompts on the spot and none of this crosses the
   * wire.
   */
  readonly permission?: ArtemisPermissionNotice;
  /**
   * Why the run failed, when {@link endReason} is `error`.
   *
   * Distinct from {@link ServerStreamDelta.error}, which is the server saying
   * the *stream* failed. This one says the run did, and it is the sentence the
   * serving machine would have put in a 502 had the caller not asked for a
   * stream.
   */
  readonly error?: string;
}

/** One delta lifted out of a stream chunk. */
export interface ServerStreamDelta {
  /** Visible assistant text. */
  readonly text?: string;
  /** Model reasoning, when the server reports it under any known name. */
  readonly thinking?: string;
  /** Why generation stopped, on the final chunk that carries one. */
  readonly finishReason?: string;
  /** Token counts, which arrive only on the final chunk. */
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
  /** The server reporting a failed generation. */
  readonly error?: string;
  /** The Artemis namespace, when the chunk carried one. */
  readonly artemis?: ServerExtensionsDelta;
}

/** Terminator every OpenAI-shaped stream sends. Not JSON, so matched literally. */
const DONE = '[DONE]';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a permission notice off a chunk.
 *
 * Two states, and each is validated down to the one field the adapter cannot
 * do without: a `requested` notice becomes a card the user must answer, so a
 * request with no `id` — nothing to answer *with* — is dropped rather than
 * drawn, and a `resolved` notice that clears a card needs the id it clears.
 * The request itself is passed through verbatim: it is a full
 * {@link PermissionRequest} the renderer draws from, and re-validating each of
 * its fields here would be a second, staler copy of the protocol's own shape.
 */
function readPermissionNotice(value: unknown): ArtemisPermissionNotice | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const status = asString(record['status']);
  if (status === 'requested') {
    const request = asRecord(record['request']);
    if (request === undefined || asString(request['id']) === undefined) return undefined;
    return { status: 'requested', request: request as unknown as PermissionRequest };
  }
  if (status === 'resolved') {
    const requestId = asString(record['requestId']);
    const outcome = asString(record['outcome']);
    if (requestId === undefined || outcome === undefined) return undefined;
    const note = asString(record['note']);
    return { status: 'resolved', requestId, outcome, ...(note === undefined ? {} : { note }) };
  }
  return undefined;
}

/**
 * Read the `artemis` namespace off one chunk.
 *
 * Activity entries are rebuilt rather than trusted: each becomes an event the
 * renderer will draw a row from, so a malformed entry is dropped here instead
 * of becoming a row with no name.
 */
function readExtensions(value: unknown): ServerExtensionsDelta | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const out: { -readonly [K in keyof ServerExtensionsDelta]: ServerExtensionsDelta[K] } = {};

  const sessionId = asString(record['sessionId']);
  if (sessionId !== undefined) out.sessionId = sessionId;
  const resolvedModel = asString(record['resolvedModel']);
  if (resolvedModel !== undefined) out.resolvedModel = resolvedModel;
  const endReason = asString(record['endReason']);
  if (endReason !== undefined) out.endReason = endReason;
  const runId = asString(record['runId']);
  if (runId !== undefined) out.runId = runId;
  const error = asString(record['error']);
  if (error !== undefined) out.error = error;
  if (typeof record['seq'] === 'number' && Number.isInteger(record['seq'])) out.seq = record['seq'];
  const gap = asRecord(record['gap']);
  if (gap !== undefined && typeof gap['afterSeq'] === 'number' && typeof gap['firstSeq'] === 'number') {
    out.gap = { afterSeq: gap['afterSeq'], firstSeq: gap['firstSeq'] };
  }

  const permission = readPermissionNotice(record['permission']);
  if (permission !== undefined) out.permission = permission;

  const activity = record['activity'];
  if (Array.isArray(activity)) {
    const entries: ArtemisActivity[] = [];
    for (const raw of activity) {
      const entry = asRecord(raw);
      const tool = entry === undefined ? undefined : asString(entry['tool']);
      if (entry === undefined || tool === undefined) continue;
      entries.push({
        tool,
        at: typeof entry['at'] === 'number' ? entry['at'] : 0,
        ...(asString(entry['summary']) === undefined
          ? {}
          : { summary: asString(entry['summary']) as string }),
        ...(typeof entry['ok'] === 'boolean' ? { ok: entry['ok'] } : {}),
      });
    }
    if (entries.length > 0) out.activity = entries;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Pull the interesting parts out of one parsed chunk. */
export function readServerChunk(chunk: unknown): ServerStreamDelta | undefined {
  const record = asRecord(chunk);
  if (record === undefined) return undefined;

  // An error object anywhere in the chunk means the generation failed. Checked
  // first: a chunk carrying both an error and a partial delta is a failure.
  const error = asRecord(record['error']);
  if (error !== undefined) {
    return { error: asString(error['message']) ?? 'The server reported an error.' };
  }

  const delta: { -readonly [K in keyof ServerStreamDelta]: ServerStreamDelta[K] } = {};

  const extensions = readExtensions(record['artemis']);
  if (extensions !== undefined) delta.artemis = extensions;

  const usage = asRecord(record['usage']);
  if (usage !== undefined) {
    const prompt = usage['prompt_tokens'];
    const completion = usage['completion_tokens'];
    if (typeof prompt === 'number' || typeof completion === 'number') {
      delta.usage = {
        promptTokens: typeof prompt === 'number' ? prompt : 0,
        completionTokens: typeof completion === 'number' ? completion : 0,
      };
    }
  }

  const choices = record['choices'];
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  if (choice !== undefined) {
    const finish = asString(choice['finish_reason']);
    if (finish !== undefined) delta.finishReason = finish;

    const body = asRecord(choice['delta']) ?? asRecord(choice['message']);
    if (body !== undefined) {
      const text = asString(body['content']);
      if (text !== undefined) delta.text = text;
      // Two spellings, both in the wild — same rule as the local reader.
      const thinking = asString(body['reasoning_content']) ?? asString(body['reasoning']);
      if (thinking !== undefined) delta.thinking = thinking;
    }
  }

  return Object.keys(delta).length > 0 ? delta : undefined;
}

/**
 * Turn one SSE line into a delta.
 *
 * `null` means "nothing to emit, keep going"; `'done'` means the server said
 * the stream is finished. Comments, blank lines and non-`data:` fields are all
 * "keep going" — part of the format, not errors.
 */
export function readServerLine(line: string): ServerStreamDelta | null | 'done' {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice('data:'.length).trim();
  if (payload === DONE) return 'done';

  try {
    return readServerChunk(JSON.parse(payload)) ?? null;
  } catch {
    // A malformed chunk must not kill a reply that is otherwise arriving.
    return null;
  }
}
