/**
 * OpenAI's chat-completions dialect, as Artemis speaks it.
 * ============================================================================
 *
 * The goal is that a program written against the OpenAI API works against
 * Artemis unchanged. This file is the contract that makes that checkable: the
 * request and response shapes, and — the part that matters more — an explicit
 * ruling on **every parameter**, so nothing is ever accepted and quietly
 * dropped.
 *
 * ---------------------------------------------------------------------------
 * WHAT PARITY CAN AND CANNOT MEAN HERE
 * ---------------------------------------------------------------------------
 *
 * Artemis routes to *agents*, not to models. A turn through Claude Code or
 * Codex reads files, runs commands, edits a repository and may pause to ask
 * permission. Three consequences follow, and each is a place where pretending
 * to be OpenAI would be worse than being honest:
 *
 * **1. Tool calls are reported, never advertised.** OpenAI's `tool_calls`
 * contract is a request *to the client*: execute this, post the result back as
 * a `tool` message, and the turn resumes. Artemis's agents execute their own
 * tools internally — the `Bash` call is already running on the user's machine
 * before any client could see it. Emitting those as `tool_calls` would make
 * every conformant client try to fulfil a call it cannot perform and wait
 * forever for a turn that has already moved on. So agent activity travels as
 * {@link ArtemisActivity} on the Artemis namespace, and `tool_calls` stays
 * reserved for its real meaning: client-side tools, which a caller passes in
 * `tools` and which the agent may genuinely delegate back.
 *
 * **2. `messages` is a turn, not a transcript.** OpenAI is stateless, so
 * clients re-send the whole conversation each call. Artemis has server-side
 * sessions that already hold it. Replaying the array into a resumed session
 * would feed the agent its own history a second time. The rule is therefore:
 * the trailing user message is the turn, `system` messages become standing
 * instructions, and continuity comes from `artemis.sessionId` rather than from
 * the array. A caller that sends no session id gets a fresh session, which is
 * what a stateless client expects to happen anyway.
 *
 * **3. Sampling knobs mostly do not exist.** The Claude Agent SDK and the Codex
 * CLI do not expose `temperature`, `top_p`, `seed`, `logprobs` or `n`. Every
 * one of them is therefore ruled on in {@link PARAMETER_POLICY} rather than
 * silently ignored, because a client that sets `temperature: 0` expecting
 * determinism and is not told otherwise has been misled by this server.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 * Embeddings, images, audio, moderations, batches, fine-tuning and vector
 * stores. Artemis has no backend that can perform any of them, and a stub that
 * returns a plausible empty result is worse than a refusal — it is a lie a
 * caller will build on. Those paths answer `501` with a sentence saying so, and
 * that is the permanent answer rather than a to-do.
 */

import type { PermissionRequest } from './permissions.js';

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

/** One part of a multimodal message. */
export type OpenAiContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image_url';
      readonly image_url: { readonly url: string; readonly detail?: string };
    };

/**
 * A message in the request.
 *
 * `content` may be a string or an array of parts — both are OpenAI's, and a
 * client picks whichever it likes, so both must be read.
 */
export interface OpenAiChatMessage {
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  readonly content: string | readonly OpenAiContentPart[] | null;
  /** Present on a `tool` message: which call it answers. */
  readonly tool_call_id?: string;
  /** Present on an assistant message that requested client-side tools. */
  readonly tool_calls?: readonly OpenAiToolCall[];
  readonly name?: string;
}

export interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/* -------------------------------------------------------------------------- */
/* Request                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A chat-completions request, as it arrives.
 *
 * Every field OpenAI defines is *readable* here even when Artemis cannot honour
 * it, because the server has to be able to tell a caller which of the things
 * they sent were ignored — see {@link PARAMETER_POLICY}. A shape that omitted
 * the unsupported fields could not name them in its reply.
 */
export interface OpenAiChatRequest {
  /** The Artemis route: `work-max/opus`. */
  readonly model: string;
  readonly messages: readonly OpenAiChatMessage[];
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage?: boolean };
  /** Client-side tools the agent may delegate back. See the file comment. */
  readonly tools?: readonly unknown[];
  readonly tool_choice?: unknown;
  readonly response_format?: unknown;
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly n?: number;
  readonly stop?: string | readonly string[];
  readonly seed?: number;
  readonly logprobs?: boolean;
  readonly top_logprobs?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly logit_bias?: Record<string, number>;
  readonly user?: string;
  readonly reasoning_effort?: string;
  /** Artemis's own settings. See `ArtemisChatExtensions` in `server.ts`. */
  readonly artemis?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Parameter policy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What happens to a parameter that arrives on a request.
 *
 * - `honoured` — Artemis passes it through to the provider and it takes effect.
 * - `ignored` — read, reported back, and not applied. The provider has no such
 *   knob and never will; refusing the request instead would turn away every
 *   client that sets it reflexively, which is most of them.
 * - `rejected` — the request fails with a 400. Reserved for parameters where
 *   *silently not applying them changes the answer the caller receives*, so
 *   proceeding would hand back a result they would read as something it is not.
 */
export type ParameterSupport = 'honoured' | 'ignored' | 'rejected';

/**
 * The ruling on every parameter, in one place.
 *
 * The `ignored`/`rejected` split is the whole design of this table, and the
 * line is drawn at *whether the caller could be misled by the result*:
 *
 * `temperature: 0` is a request for determinism. Returning a sampled answer
 * without a word would let a caller build a cache, a test, or a diff on a
 * promise this server never kept — so it is rejected. `user`, by contrast, is a
 * tracking label; ignoring it changes nothing about the answer, so a request
 * carrying one still runs.
 *
 * A caller who wants the lenient reading of a rejected parameter can set
 * `artemis.ignoreUnsupported`, which downgrades every `rejected` to `ignored`.
 * That exists for the LangChain-shaped client that sets `temperature` on every
 * call from a default it never chose — the escape hatch is theirs to open
 * deliberately, rather than this server's to open on their behalf.
 */
export const PARAMETER_POLICY: Readonly<Record<string, ParameterSupport>> = {
  model: 'honoured',
  messages: 'honoured',
  stream: 'honoured',
  stream_options: 'honoured',
  max_tokens: 'honoured',
  max_completion_tokens: 'honoured',
  stop: 'honoured',
  tools: 'honoured',
  tool_choice: 'honoured',
  reasoning_effort: 'honoured',
  artemis: 'honoured',

  // Changes the *shape* of what comes back. A caller asking for JSON and given
  // prose has to parse it and fail; better to say no up front.
  response_format: 'rejected',
  // Determinism, breadth and scoring: each one is a property of the answer that
  // the caller would otherwise believe they had.
  temperature: 'rejected',
  top_p: 'rejected',
  seed: 'rejected',
  n: 'rejected',
  logprobs: 'rejected',
  top_logprobs: 'rejected',
  logit_bias: 'rejected',
  presence_penalty: 'rejected',
  frequency_penalty: 'rejected',

  // Labels and hints. Ignoring them cannot mislead anyone about the answer.
  user: 'ignored',
  metadata: 'ignored',
  store: 'ignored',
  service_tier: 'ignored',
  parallel_tool_calls: 'ignored',
};

/** What {@link reviewParameters} found. */
export interface ParameterReview {
  /** Present and unsupported, but harmless to ignore. Reported to the caller. */
  readonly ignored: readonly string[];
  /** Present and unsupported in a way that would mislead. The request must fail. */
  readonly rejected: readonly string[];
}

/**
 * Rule on the parameters actually present in a request.
 *
 * Unknown keys are ignored rather than rejected: OpenAI adds fields regularly,
 * and a server that refused every unrecognised one would break on the client's
 * next minor upgrade rather than on any real incompatibility.
 *
 * @param lenient downgrade every `rejected` to `ignored` — the caller's own
 *                `artemis.ignoreUnsupported`, never a default
 */
export function reviewParameters(
  body: unknown,
  options: { readonly lenient?: boolean } = {},
): ParameterReview {
  if (typeof body !== 'object' || body === null) return { ignored: [], rejected: [] };

  const ignored: string[] = [];
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    // Absent and explicitly-null are the same thing, and clients send both.
    if (value === undefined || value === null) continue;
    const support = PARAMETER_POLICY[key];
    if (support === undefined || support === 'honoured') continue;
    if (support === 'ignored' || options.lenient === true) ignored.push(key);
    else rejected.push(key);
  }

  return { ignored, rejected };
}

/* -------------------------------------------------------------------------- */
/* Response                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a turn stopped.
 *
 * OpenAI's set, and no additions — a client switches on these, and a value it
 * has never heard of is an unhandled branch in *their* code. An Artemis run
 * that ends for a reason with no OpenAI equivalent (interrupted, permission
 * denied, provider error) reports `stop` here and explains itself on the
 * Artemis namespace, where a client that cares can look and one that does not
 * is unharmed.
 */
export type OpenAiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface OpenAiUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/**
 * What the agent did, reported rather than requested.
 *
 * This is where a turn's real work goes: the files it read, the commands it
 * ran, the subagents it spawned. It rides on the Artemis namespace precisely so
 * that it *cannot* be mistaken for `tool_calls` — see the file comment. A
 * client that ignores it still gets a correct, complete answer; one that reads
 * it can show a user what happened.
 */
export interface ArtemisActivity {
  /** `read`, `write`, `bash`, `search`, … — the adapter's own name, lowercased. */
  readonly tool: string;
  /** One line naming the target, e.g. a path. Never the file's contents. */
  readonly summary?: string;
  /** Epoch ms when it started. */
  readonly at: number;
  /** Absent while the call is still running. */
  readonly ok?: boolean;
}

/**
 * A permission prompt, or its settlement, as it travels to a remote client.
 *
 * Two states rather than two fields, because a consumer's job is different in
 * each and a card that is drawn on one and cleared on the other should not have
 * to guess which it is holding. `requested` is a question the client owes an
 * answer to; `resolved` says the question is closed — by this client, by
 * another one attached to the same run, by the park deadline, or by the
 * provider withdrawing it.
 *
 * Only ever emitted for a run whose caller set `artemis.remote.permissions`.
 * Everything else still gets the standing denial and never sees either state,
 * which is what keeps a client that cannot render a prompt from being sent one.
 */
export type ArtemisPermissionNotice =
  | { readonly status: 'requested'; readonly request: PermissionRequest }
  | {
      readonly status: 'resolved';
      readonly requestId: string;
      /** `allowed`, `denied`, or `withdrawn` — the run's own vocabulary. */
      readonly outcome: string;
      /** One sentence for the record: the denial's reason, or why it lapsed. */
      readonly note?: string;
    };

/** Artemis's additions to a response, namespaced for the reason requests are. */
export interface ArtemisResponseExtensions {
  /** The session this turn ran in. Pass it back to continue the conversation. */
  readonly sessionId?: string;
  /**
   * The run this turn is, announced once and early.
   *
   * The address every route under `/api/v0/runs` takes, and the only place a
   * completions caller can learn it: a run id is minted when the turn starts
   * and no other response carries one. A client that means to steer, approve,
   * interrupt or reattach has to hold this from the first chunk, because the
   * moment it needs it is usually the moment the stream has already broken.
   */
  readonly runId?: string;
  /** The concrete model that ran, when the route named an alias. */
  readonly resolvedModel?: string;
  /** Parameters that were accepted and not applied. See {@link PARAMETER_POLICY}. */
  readonly ignored?: readonly string[];
  /** What the agent did. See {@link ArtemisActivity}. */
  readonly activity?: readonly ArtemisActivity[];
  /** A prompt the run is parked on, or the news that it no longer is. */
  readonly permission?: ArtemisPermissionNotice;
  /** The true reason the run ended, when `finish_reason` had to flatten it. */
  readonly endReason?: string;
  /**
   * Why the run failed, when {@link endReason} is `error`.
   *
   * The streaming path had no way to say this. A failed turn ended with
   * `finish_reason: "stop"` and `endReason: "error"` on an empty delta, and the
   * server's own account of the failure — which it had, and which the
   * non-streaming path returns as a 502 body — was dropped on the floor. Every
   * streaming client was therefore left to invent a sentence, and the one
   * Artemis invented ("the server reported the detail in the reply text, when
   * it had one") was wrong: there was no detail in the text, because a run that
   * fails before it generates has no text.
   *
   * Present only on the final chunk, and only on failure. Already scrubbed to
   * the same standard as any other reply: it is the provider's own message, not
   * an exception trace, and it names no path or credential.
   */
  readonly error?: string;
}

export interface OpenAiChatChoice {
  readonly index: number;
  readonly message: {
    readonly role: 'assistant';
    readonly content: string | null;
    /**
     * The model's reasoning, when the run produced any. See the same field on
     * {@link OpenAiChatChunkChoice} for why it travels under this name and
     * never inside `content`.
     */
    readonly reasoning_content?: string;
    readonly tool_calls?: readonly OpenAiToolCall[];
  };
  readonly finish_reason: OpenAiFinishReason;
}

export interface OpenAiChatResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  /** The route that ran. */
  readonly model: string;
  readonly choices: readonly OpenAiChatChoice[];
  readonly usage?: OpenAiUsage;
  readonly artemis?: ArtemisResponseExtensions;
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

export interface OpenAiChatChunkChoice {
  readonly index: number;
  readonly delta: {
    readonly role?: 'assistant';
    readonly content?: string;
    /**
     * A fragment of the model's reasoning.
     *
     * Not an OpenAI field, and deliberately not folded into `content`: a
     * client reading the answer must never receive the model's private
     * working-out as though it were the reply. It rides under the name the
     * reasoning-capable OpenAI-compatible servers already use (`vllm`,
     * `llama.cpp`, DeepSeek), so a client that knows the field shows the
     * reasoning and one that does not ignores it, exactly as it ignores the
     * `artemis` namespace. Only ever the agent's own reasoning — a subagent's
     * is reported as activity, not relayed.
     */
    readonly reasoning_content?: string;
    readonly tool_calls?: readonly unknown[];
  };
  readonly finish_reason: OpenAiFinishReason | null;
}

export interface OpenAiChatChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAiChatChunkChoice[];
  /** Only on the final chunk, and only when the caller asked for it. */
  readonly usage?: OpenAiUsage;
  readonly artemis?: ArtemisResponseExtensions;
}

/**
 * The sentinel that closes an OpenAI stream.
 *
 * Not optional and not cosmetic: the OpenAI SDKs treat the stream as ended when
 * they read it, and a server that closes the socket without sending it leaves
 * some clients waiting until a timeout.
 */
export const SSE_DONE = '[DONE]';

/**
 * Frame one value as a Server-Sent Event.
 *
 * The blank line is the event separator and the single most common thing to get
 * wrong: without the *second* newline a client buffers the event forever,
 * waiting for a terminator that never comes.
 */
export function sseEvent(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}
