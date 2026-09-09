/**
 * The local-server adapter.
 * ============================================================================
 *
 * One implementation, three providers. LM Studio, Ollama and llama.cpp's
 * `llama-server` are separate rows in the picker because a user chooses between
 * them and should see which one a profile is pointed at — but they speak the
 * same wire format, so they are the same adapter with a different flavour.
 *
 * ## What is different about this provider
 *
 * The other three wrap something that owns the agent loop. This one wraps an
 * inference server, which does not — so the loop is ours, and lives in
 * `loop.ts`. What this file adds around it is everything that loop needs from
 * the outside world: a streamed completion, an approval that parks the turn,
 * and a shell that the operating system confines.
 *
 * Because Artemis executes the tools rather than a vendor's process, the
 * defences are its own too, and they are not one thing. `sandbox.ts` confines
 * paths for the tools Artemis performs itself; `seatbelt.ts` confines the shell,
 * which no path check can reach. A command that cannot be confined is refused
 * rather than run, because a silent downgrade from sandboxed to not is exactly
 * the failure a boundary must not have.
 *
 * ## No credential, an endpoint instead
 *
 * The first provider with nothing to sign in to. A profile here is defined by a
 * URL, so `credentialEnvKeys` is empty — not because credentials are handled
 * elsewhere, but because there are none. What would be a sign-in flow for a
 * hosted provider is, here, a server either answering or not.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentError,
  AgentEvent,
  Capabilities,
  MessageId,
  PermissionDecision,
  PermissionRequestId,
  ProviderId,
  RunId,
  RunInput,
  RunStatus,
  SessionId,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import {
  defaultBaseUrlFor,
  LOCAL_API_KEY_ENV,
  LOCAL_BASE_URL_ENV,
  NO_CAPABILITIES,
} from '@rx-artemis/protocol';

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { composeProviderEnv } from '../env.js';
import { AsyncQueue, createDeferred } from '../stream.js';
import type { Deferred } from '../stream.js';

const execFileAsync = promisify(execFile);
import { AdapterError, adapterError } from '../types.js';
import type {
  AggregatedSessionList,
  AllSessionsQuery,
  InterruptResult,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionDeleteQuery,
  SessionListPage,
  SessionListQuery,
  SessionMessageCountQuery,
  SessionMessagesQuery,
  SessionTagQuery,
  SessionTitleUpdate,
  SessionTranscript,
} from '../types.js';
import * as sessionStore from './sessionStore.js';
import { LOCAL_PROFILE_DIR_ENV } from './sessionStore.js';
import type { StoredEvent, StoredTurnMessage } from './sessionStore.js';
import { parseLlamaServerModels, parseOllamaTags } from './catalogues.js';
import { parseNativeCatalogue, parseOpenAiCatalogue } from '../lmstudio/catalogue.js';
import { readEventLine, splitEvents, ToolCallAccumulator } from './stream.js';
import { runAgentLoop } from './loop.js';
import type { ChatMessage, CompletionResult } from './loop.js';
import { connectToolServers, mergeToolServers } from './mcp.js';
import type { ConnectedToolServers } from './mcp.js';
import { toolsForRisk, toWireTools } from './tools.js';
import type { ToolSpec } from './tools.js';
import { describeConfinement, resolveSandbox, wrapCommand } from './commandSandbox.js';
import type { ResolvedSandbox } from './commandSandbox.js';
import { sandboxEnv } from './sandbox.js';
import type { StreamUsage, ToolCall } from './stream.js';

/**
 * What one local server does differently: its name, its default port, and how
 * it answers when asked for models.
 */
export interface LocalFlavour {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultBaseUrl: string;
  /** Path appended to the base URL, and the parser for what comes back. */
  readonly cataloguePath: string;
  readonly parseCatalogue: (body: unknown) => readonly import('@rx-artemis/protocol').ProviderModelOption[];
  /** A second discovery attempt, for a server whose richer endpoint may be absent. */
  readonly fallback?: { readonly path: string; readonly parse: (body: unknown) => readonly import('@rx-artemis/protocol').ProviderModelOption[] };
}

export const LM_STUDIO: LocalFlavour = {
  id: 'lmstudio',
  label: 'LM Studio',
  defaultBaseUrl: defaultBaseUrlFor('lmstudio'),
  // Verified live: the native endpoint reports type and state, and the OpenAI
  // one under-reports. See `lmstudio/catalogue.ts`.
  cataloguePath: '/api/v0/models',
  parseCatalogue: parseNativeCatalogue,
  fallback: { path: '/v1/models', parse: parseOpenAiCatalogue },
};

export const OLLAMA: LocalFlavour = {
  id: 'ollama',
  label: 'Ollama',
  defaultBaseUrl: defaultBaseUrlFor('ollama'),
  cataloguePath: '/api/tags',
  parseCatalogue: parseOllamaTags,
  fallback: { path: '/v1/models', parse: parseOpenAiCatalogue },
};

export const LLAMA_CPP: LocalFlavour = {
  id: 'llamacpp',
  label: 'llama.cpp',
  defaultBaseUrl: defaultBaseUrlFor('llamacpp'),
  cataloguePath: '/v1/models',
  parseCatalogue: parseLlamaServerModels,
};

/**
 * Where a profile's endpoint is read from.
 *
 * Carried on the profile's `publicEnv` rather than a dedicated field, which is
 * the honest short-term answer: a URL is exactly what `publicEnv` is for, and it
 * survives the credential-routing filter because it names no vendor. A profile
 * whose identity *is* an endpoint arguably deserves its own field on `Profile`;
 * that is a protocol change and this is not, so it waits until the shape has
 * been used enough to know what it should look like.
 */
export const BASE_URL_ENV = LOCAL_BASE_URL_ENV;

/**
 * The key for this profile's endpoint, when the server wants one.
 *
 * Set by `resolveEnv` from the encrypted store and by nothing else — see
 * `profiles/secrets.ts` for why Artemis holds this one secret when it holds
 * none of the others. Absent is the ordinary case: a `llama-server` started
 * without `--api-key` refuses nothing.
 */
export const API_KEY_ENV = LOCAL_API_KEY_ENV;

/**
 * Phase 1 capabilities.
 *
 * Read the `false` rows as *not yet* rather than *cannot*. Every one of them is
 * within reach precisely because nothing upstream imposes it — which is the
 * trade this provider makes: more work than wrapping a runtime, and no ceiling
 * set by somebody else's protocol.
 */
export const LOCAL_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  // The servers stream, and the parser handles both spellings of reasoning.
  partialMessages: true,
  // Every OpenAI-compatible response carries token counts.
  usageReporting: true,
  // Local inference has no price to report. Not a gap — there is no number.
  costReporting: false,
  // No plan, no limits, nothing to be near the end of.
  planUsageReporting: false,
  // We build the message array ourselves, so a system prompt is just its first
  // element. The cheapest `true` in the file.
  systemPromptAppend: true,
  // We own the loop, so we can park it — and must. Every tool call is offered
  // to the user before it runs, under the modes below.
  interactivePermissions: true,
  /*
   * The server stores no conversation, so Artemis stores it — see
   * `sessionStore.ts`. Everything below follows from owning the file rather
   * than asking a provider for it: history can be listed, reopened, renamed,
   * tagged and destroyed because those are all operations on a file this
   * adapter wrote.
   *
   * `rewind` and `forkSession` stay false, and that is a "not yet" of a
   * different kind from the others: both are within reach of an append-only
   * transcript — a fork is a copy up to a line, a rewind is a truncation — but
   * neither has a message identity to point at yet. `rewindToMessageId` names
   * a provider-assigned id, and nothing here assigns one.
   */
  listSessions: true,
  resumeSession: true,
  renameSession: true,
  deleteSession: true,
  tagSession: true,
  rewind: false,
  forkSession: false,
  /**
   * Enforced by our own loop rather than by a provider, which is why the list
   * is short: each of these has to mean something here, and inventing a rung
   * the loop does not honour would be worse than omitting it.
   *
   * `plan` withholds the tools that change anything, so the model can look and
   * propose without being able to act. `bypassPermissions` stops asking but
   * does *not* widen the sandbox — the OS boundary is a separate axis, and
   * conflating them is the mistake Codex's two flags exist to avoid.
   */
  permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
};

/**
 * What the host can hand this adapter that it could not build itself.
 *
 * One field, and it is the same field the Claude adapter has — see
 * {@link import('../claude.js').ClaudeAdapterOptions.agentToolServers}. The
 * asymmetry that used to exist here was not a decision: `packages/core` may not
 * import Electron, so the browser tools are built in `apps/desktop/main` and
 * injected, and only the Claude adapter had somewhere to inject them *into*.
 * Now that this provider has an MCP client of its own (`mcp.ts`), the same
 * factory serves both, and a run against a local model gets
 * `mcp__artemisBrowser__browser_read` under the name a Claude run knows it by.
 */
export interface LocalAdapterOptions {
  /**
   * Extra tool servers to give a run, built per run by the host.
   *
   * Per **run**, not per adapter, for the reason the Claude seam is: the
   * factory closes over the run id, so a tool acts on *this* conversation's
   * browser and the model has no way to name another. The run input rides
   * along because which servers a run should get is the input's to say.
   */
  readonly agentToolServers?: (
    runId: RunId,
    input: RunInput,
  ) => Record<string, McpServerConfig> | undefined;
}

/** No account to sign in to. See the module header. */
function localCredentials(): ProviderCredentialSpec {
  return {
    // Nothing is spawned, so nothing reads this from an environment — but the
    // field is required, an inert clearly-named variable is more honest than
    // borrowing a vendor's, and it is no longer unused: it is where this
    // profile's transcripts are kept. See `sessionStore.ts`.
    configDirVar: LOCAL_PROFILE_DIR_ENV,
    // Transcripts are files on this machine, so a history read gets the store
    // environment — the directory and nothing else. Nothing is decrypted to
    // read a conversation back.
    sessionStore: 'local',
    /*
     * Not a credential in the sense the other providers mean — nothing here
     * signs in to an account — but exactly a credential in the sense this list
     * governs: both names are set by Artemis from the profile, so both must be
     * removed from whatever the user happens to have exported. An ambient
     * `ARTEMIS_LOCAL_BASE_URL` would otherwise send a profile's key to a
     * different machine than the profile names.
     */
    credentialEnvKeys: [LOCAL_BASE_URL_ENV, LOCAL_API_KEY_ENV],
    signIn: {
      executable: 'true',
      loginArgs: [],
      statusArgs: [],
      logoutArgs: [],
      howTo:
        'Nothing to sign in to. Start the server on your own machine and point this profile at its address.',
      // A local server is signed in exactly when it answers, which the
      // availability probe already establishes.
      parseStatus: () => ({ loggedIn: true }),
    },
  };
}

/** The endpoint this run should talk to. */
function baseUrl(flavour: LocalFlavour, env: Readonly<Record<string, string | undefined>>): string {
  const declared = env[BASE_URL_ENV];
  const chosen = declared !== undefined && declared.trim() !== '' ? declared.trim() : flavour.defaultBaseUrl;
  return chosen.replace(/\/+$/, '');
}

/**
 * Headers for a request to that endpoint.
 *
 * `Bearer`, because that is what every one of these servers reads:
 * `llama-server --api-key` compares against `Authorization: Bearer`, and the
 * OpenAI-compatible surface the others expose is specified the same way. Sent
 * on the catalogue call as well as the chat call — a server started with a key
 * refuses `/v1/models` too, and a model picker that came back empty was one of
 * the ways this failed silently.
 *
 * No header at all when there is no key. An empty `Authorization` is not the
 * same as its absence: some proxies answer 401 to the former and pass the
 * latter straight through.
 */
function authHeaders(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const key = env[API_KEY_ENV];
  return key !== undefined && key.trim() !== '' ? { authorization: `Bearer ${key.trim()}` } : {};
}

/** Token counts in the shape the seam expects. */
function toUsage(usage: StreamUsage): UsageSnapshot {
  return {
    scope: 'final',
    tokens: {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    },
  };
}

/**
 * One turn against a local server.
 *
 * Streams until the server says it is done, then ends. `send` is refused rather
 * than queued: without `midRunSteering` the composer is already disabled, and a
 * silently queued message that arrives a turn later is worse than a refusal.
 *
 * The turn is one turn *of a conversation*, which is a claim this class has to
 * make good on by itself: the server it talks to is stateless, so continuity is
 * whatever `sessionStore.ts` holds and this run replays into the request.
 */
class LocalRun implements Run {
  readonly runId: RunId;
  readonly providerId: ProviderId;
  readonly capabilities = LOCAL_CAPABILITIES;

  /**
   * The conversation this turn is written into.
   *
   * Minted here rather than reported by the provider, because there is no
   * provider to report one — a session id is a filename this adapter chose, and
   * a resumed run keeps the one it was given so its turns land in the same file.
   */
  readonly #sessionId: SessionId;

  #status: RunStatus = 'running';
  #seq = 0;
  #messageSeq = 0;
  #storedSeq = 0;
  #permissionSeq = 0;
  /**
   * Writes to the transcript, chained.
   *
   * Serialised rather than fired off in parallel: two `appendFile` calls racing
   * would interleave a tool result before the assistant turn that asked for it,
   * and the next request would carry a message array the server rejects.
   */
  #writes: Promise<void> = Promise.resolve();
  /**
   * Set the first time a write fails, and never cleared.
   *
   * What it stops is a *half* turn reaching the file. The rest of this turn is
   * abandoned rather than attempted, because an assistant message holding tool
   * calls whose results never landed is not merely incomplete — every one of
   * these servers rejects that array, so a single failed append in the middle
   * of a turn would leave the conversation permanently unresumable. The reader
   * repairs what is already on disk (see `answeredCallsOnly`); this keeps the
   * damage from being written in the first place.
   */
  #writesFailed = false;
  /** What each tool call looked like live, keyed by the id its result carries. */
  readonly #toolEvents = new Map<string, StoredEvent[]>();
  #usage: UsageSnapshot | undefined;
  /** Approvals the loop is parked on, keyed by the id the renderer answers. */
  readonly #pending = new Map<PermissionRequestId, Deferred<'allow' | 'deny'>>();
  /** What this machine can enforce. Resolved once; see `#sandbox`. */
  #resolvedSandbox: ResolvedSandbox | undefined;
  /** The run's own writable scratch, made on first use and removed at the end. */
  #scratch: string | undefined;
  readonly #queue = new AsyncQueue<AgentEvent>();
  readonly #abort = new AbortController();
  readonly #input: ResolvedRunInput;
  readonly #flavour: LocalFlavour;
  readonly #options: LocalAdapterOptions;
  /**
   * The tool servers this run reached, once it has reached them.
   *
   * Opened once per run rather than per turn, exactly as the Claude adapter
   * builds its servers once per launch: the connections hold the handlers, and
   * a second set mid-conversation would be a second browser for one dock.
   */
  #servers: ConnectedToolServers | undefined;

  constructor(input: ResolvedRunInput, flavour: LocalFlavour, options: LocalAdapterOptions = {}) {
    this.runId = input.runId;
    this.providerId = flavour.id;
    this.#input = input;
    this.#flavour = flavour;
    this.#options = options;
    this.#sessionId = input.resumeSessionId ?? (randomUUID() as SessionId);
    /*
     * Stopping a run must not be able to leave it stopped *and* waiting.
     *
     * The loop parks inside `#approve` on a promise only an answer settles, so
     * aborting while a permission prompt was open cancelled the fetch nobody
     * was making and left the turn in `awaiting_permission` for good: no
     * `run.end`, no flushed transcript, a row the user could not clear. The
     * abort is the answer — every parked call is refused, the loop unwinds, and
     * the ordinary interrupted ending happens.
     */
    this.#abort.signal.addEventListener('abort', () => this.#refuseAllPending(), { once: true });
    void this.#drive();
  }

  /** Refuse every approval the loop is parked on. Safe to call twice. */
  #refuseAllPending(): void {
    for (const pending of this.#pending.values()) pending.resolve('deny');
    this.#pending.clear();
  }

  get status(): RunStatus {
    return this.#status;
  }

  /**
   * The conversation, which is known before the first byte arrives.
   *
   * Every other adapter waits for the provider to name a session. Here the id
   * is Artemis's own from the start — which is why it is safe to return it
   * immediately, and why it used to be `undefined`: there was nothing to name
   * until there was somewhere to keep it.
   */
  get sessionId(): SessionId | undefined {
    return this.#sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#queue;
  }

  #emit(event: Omit<AgentEvent, 'runId' | 'seq' | 'ts'>): void {
    this.#queue.push({
      ...event,
      runId: this.runId,
      seq: this.#seq++,
      // A monotonic counter would be safer, but the seam's other adapters stamp
      // wall-clock here and the renderer orders on `seq`.
      ts: Date.now(),
    } as AgentEvent);
  }

  /**
   * Which tools this run may offer, from its permission mode.
   *
   * `plan` is the interesting one: it withholds every tool that changes
   * something, so the model can read, search and propose but cannot act. That
   * is enforced by not *offering* the tools rather than by refusing them later
   * — a model that is never told about `write_file` does not spend a turn
   * trying it and being denied.
   */
  #toolsForMode(): readonly ToolSpec[] {
    const mode = this.#input.permissionMode ?? 'default';
    /*
     * The servers' tools go through the same filter as Artemis's own.
     *
     * A tool server's tools are tools, so `plan` withholds the ones that change
     * something there too — which for a server means everything that did not
     * declare `readOnlyHint`. That is the conservative reading and the right
     * one: plan mode's promise is that nothing happened, and a promise that
     * covered only the four tools in this package would be a promise about the
     * wrong thing the moment a GitHub server was configured.
     */
    const built = mode === 'plan' ? toolsForRisk(false, false) : toolsForRisk(true, true);
    const fromServers = (this.#servers?.tools ?? []).filter(
      (tool) => mode !== 'plan' || tool.risk === 'read',
    );
    return [...built, ...fromServers];
  }

  /**
   * Ask the user about one call — or answer for them when the mode says to.
   *
   * `acceptEdits` and `bypassPermissions` skip the prompt. Neither widens the
   * OS sandbox: approval and confinement are separate axes, and a mode that
   * quietly did both would make "stop asking me" mean "and also let it out".
   *
   * `acceptEdits` does not cover a tool server, and that is deliberate. The
   * mode's bargain is that the edits it stops asking about are edits to this
   * working directory, which the user is looking at and git can undo. A server
   * acts somewhere else — a repository, a vault, a live page — so its calls
   * keep asking, and only `bypassPermissions` silences them. See
   * {@link ToolSpec.server}.
   */
  async #approve(call: ToolCall, tool: ToolSpec): Promise<'allow' | 'deny'> {
    // Nothing more is run once the user has stopped the turn, and nothing more
    // is asked either: a prompt raised after the abort would park the loop on a
    // deferred that the abort listener has already been and gone past.
    if (this.#abort.signal.aborted) return 'deny';

    const mode = this.#input.permissionMode ?? 'default';
    if (mode === 'bypassPermissions') return 'allow';
    if (mode === 'acceptEdits' && tool.risk !== 'execute' && tool.server === undefined) return 'allow';

    const requestId = `${this.runId}-perm-${this.#permissionSeq++}` as PermissionRequestId;
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.argumentsJson);
      if (typeof parsed === 'object' && parsed !== null) input = parsed as Record<string, unknown>;
    } catch {
      /* the loop reports the parse failure; the prompt shows what it can */
    }

    const decided = createDeferred<'allow' | 'deny'>();
    this.#pending.set(requestId, decided);
    this.#status = 'awaiting_permission';
    this.#emit({
      type: 'permission.request',
      requestId,
      request: {
        id: requestId,
        runId: this.runId,
        toolName: tool.name,
        input,
        toolCallId: call.id,
        title: tool.description,
      },
    } as never);

    const decision = await decided.promise;
    this.#status = 'running';
    return decision;
  }

  /**
   * What this machine can enforce, resolved once per run.
   *
   * Once rather than per command, because it cannot change mid-run and because
   * the answer is what `session.started` tells the user — they should learn
   * that commands will be refused before the model tries one, not after.
   */
  async #sandbox(): Promise<ResolvedSandbox> {
    this.#resolvedSandbox ??= await resolveSandbox(process.platform, hasBinary);
    return this.#resolvedSandbox;
  }

  /** Run a shell command, or refuse when nothing on this machine can confine it. */
  async #shell(command: string, signal: AbortSignal): Promise<{ output: string; failed?: boolean }> {
    const sandbox = await this.#sandbox();
    // A scratch directory of the run's own, because the profile no longer
    // opens the system temp area — see `seatbeltProfile` for what that granted.
    this.#scratch ??= await mkdtemp(path.join(tmpdir(), 'artemis-run-'));
    const argv = await wrapCommand(sandbox, command, this.#input.cwd, this.#scratch);

    // `null` means nothing confined it. Refused rather than run: the
    // alternative is a silent downgrade from sandboxed to not, on whichever
    // platform is least able to notice.
    if (argv === null) {
      return { output: `Refused: ${describeConfinement(sandbox)}`, failed: true };
    }

    try {
      const { stdout, stderr } = await execFileAsync(argv[0] as string, argv.slice(1), {
        cwd: this.#input.cwd,
        // Pointed at the run's own scratch, so a toolchain writing "to /tmp"
        // lands somewhere the sandbox actually permits.
        env: { ...sandboxEnv(this.#input.env, []), TMPDIR: this.#scratch, TMP: this.#scratch, TEMP: this.#scratch },
        signal,
        maxBuffer: 4_000_000,
      });
      const output = `${stdout}${stderr}`.trim();
      return { output: output === '' ? '(no output)' : output };
    } catch (error) {
      // A non-zero exit is information the model needs, not a run-ending fault:
      // a failing test suite is the normal case for a coding agent.
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const detail = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
      return { output: detail === '' ? (failure.message ?? 'The command failed.') : detail, failed: true };
    }
  }

  /** One streamed completion, in the shape the loop asks for. */
  async #complete(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): Promise<CompletionResult> {
    const url = `${baseUrl(this.#flavour, this.#input.env)}/v1/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.#input.env) },
      signal: this.#abort.signal,
      body: JSON.stringify({
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length === 0 ? {} : { tools: toWireTools(tools) }),
      }),
    });

    if (!response.ok || response.body === null) {
      throw adapterError(
        'provider_unavailable',
        `The ${this.#flavour.label} server answered ${response.status}. Is it running, and is a model loaded?`,
      );
    }

    const messageId = `${this.runId}-${this.#messageSeq}` as MessageId;
    const calls = new ToolCallAccumulator();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason: string | undefined;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const { lines, rest } = splitEvents(buffer);
      buffer = rest;

      for (const line of lines) {
        const delta = readEventLine(line);
        if (delta === null) continue;
        if (delta === 'done') break;

        if (delta.error !== undefined) throw adapterError('provider_unavailable', delta.error);
        if (delta.usage !== undefined) this.#usage = toUsage(delta.usage);
        if (delta.finishReason !== undefined) finishReason = delta.finishReason;
        if (delta.toolCalls !== undefined) calls.add(delta.toolCalls);
        if (delta.thinking !== undefined) {
          this.#emit({ type: 'thinking.delta', messageId, blockIndex: 0, text: delta.thinking } as never);
        }
        if (delta.text !== undefined) {
          text += delta.text;
          this.#emit({ type: 'text.delta', messageId, blockIndex: 0, text: delta.text } as never);
        }
      }
    }

    if (text !== '') {
      this.#emit({ type: 'text.complete', messageId, role: 'assistant', text } as never);
    }
    this.#messageSeq += 1;
    return { text, toolCalls: calls.take(), ...(finishReason === undefined ? {} : { finishReason }) };
  }

  /**
   * Add messages to this session's transcript.
   *
   * Queued rather than awaited: the loop is synchronous about appending and a
   * turn must not wait on a disk write between tool calls. A failed write is
   * swallowed — losing the transcript is bad, and failing a run the user is
   * watching because its history could not be saved is worse.
   */
  #persist(messages: readonly StoredTurnMessage[]): void {
    this.#writes = this.#writes
      .then(() => {
        if (this.#writesFailed) return undefined;
        return sessionStore.appendTurn({
          env: this.#input.env,
          sessionId: this.#sessionId,
          cwd: this.#input.cwd,
          providerId: this.#flavour.id,
          ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
          messages,
        });
      })
      .catch((error: unknown) => {
        this.#writesFailed = true;
        /*
         * Said out loud, once.
         *
         * The run itself is fine and finishes normally — but the user is about
         * to keep talking to a conversation that has stopped recording, and
         * finding that out on the next turn, when the model has forgotten
         * everything since, is far worse than being told now. There is no
         * notice event in the protocol, so it goes where an adapter's own
         * words go: a synthetic assistant block, which the transcript renders
         * and nothing mistakes for the model's.
         */
        this.#emit({
          type: 'text.complete',
          messageId: `${this.runId}-store-error` as MessageId,
          role: 'assistant',
          text: `This turn could not be saved to the conversation history: ${
            error instanceof Error ? error.message : String(error)
          }`,
          synthetic: true,
        } as never);
      });
  }

  /**
   * How one message looked while it was happening.
   *
   * The transcript cannot be rebuilt from the messages alone: a tool result
   * reads the same whether the command succeeded or failed, and the assistant
   * turn that asked for it carries no rendering of its own. So the events are
   * captured as they are emitted and stored beside the message they belong to.
   */
  #storedEvents(message: ChatMessage): readonly StoredEvent[] {
    if (message.role === 'tool') {
      if (message.tool_call_id === undefined) return [];
      const captured = this.#toolEvents.get(message.tool_call_id) ?? [];
      // Consumed, not kept: a long agentic turn makes hundreds of calls, and
      // holding every one of their events for the life of the run is a leak
      // that grows with exactly the runs that can least afford it.
      this.#toolEvents.delete(message.tool_call_id);
      return captured;
    }
    if (message.content === '') return [];
    return [
      {
        type: 'text.complete',
        messageId: `${this.runId}-stored-${this.#storedSeq++}` as MessageId,
        role: message.role === 'user' ? 'user' : 'assistant',
        text: message.content,
      } as StoredEvent,
    ];
  }

  /**
   * Artemis's own words in the transcript, marked as Artemis's.
   *
   * There is no notice event in the protocol, so it goes where an adapter's own
   * words go: a synthetic assistant block, which the transcript renders and
   * nothing mistakes for the model's. Not persisted — this is news about *this*
   * run's setup, and a replayed transcript claiming a server was unreachable
   * six weeks ago would be worse than saying nothing.
   */
  #notice(text: string): void {
    this.#emit({
      type: 'text.complete',
      messageId: `${this.runId}-notice-${this.#messageSeq++}` as MessageId,
      role: 'assistant',
      text,
      synthetic: true,
    } as never);
  }

  /**
   * Open this run's tool servers, if it was given any.
   *
   * Before `session.started`, because that event names the run's tools and a
   * list that grew afterwards would be a list the user could not trust. Bounded
   * by the connect timeout in `mcp.ts`, and never fatal: a server that will not
   * start is said out loud and the run continues with the tools it does have.
   */
  async #openToolServers(): Promise<void> {
    // Two sources, one list: what the host built for this run, and what the
    // profile records. See `mergeToolServers` for who wins a name.
    const merged = mergeToolServers(
      this.#options.agentToolServers?.(this.runId, this.#input),
      this.#input.toolServers,
    );
    for (const problem of merged.problems) {
      this.#notice(`The "${problem.server}" tool server was not used: ${problem.detail}`);
    }
    if (Object.keys(merged.servers).length === 0) return;

    const connected = await connectToolServers(merged.servers, {
      /*
       * The host environment under the profile's, unscrubbed.
       *
       * Not the environment `shell` gets, and the difference is the point. The
       * shell's is stripped of anything credential-shaped because the *model*
       * writes the command that reads it. A tool server is named by the user in
       * settings and spawned by Artemis; the model never sees its environment
       * and cannot influence what it does with one. Stripping it here would
       * mean a GitHub server could never hold a token, which is the whole
       * reason for configuring one.
       *
       * It is also why the docs say to name only servers you would run
       * yourself: this is the user's own environment, handed to the user's own
       * choice of program.
       */
      env: composeProviderEnv(this.#input.env, {
        ...(this.#input.inheritHostEnv === undefined
          ? {}
          : { inheritHostEnv: this.#input.inheritHostEnv }),
      }),
      cwd: this.#input.cwd,
      signal: this.#abort.signal,
    });
    this.#servers = connected;

    for (const problem of connected.problems) {
      this.#notice(`The "${problem.server}" tool server is not available: ${problem.detail}`);
    }
  }

  async #drive(): Promise<void> {
    try {
      // Before the session is announced, and inside the try: a failure here is
      // an ordinary run-ending error with an ordinary `run.end`, not a promise
      // rejection escaping a fire-and-forget call in the constructor.
      await this.#openToolServers();

      this.#emit({
        type: 'session.started',
        sessionId: this.#sessionId,
        providerId: this.#flavour.id,
        cwd: this.#input.cwd,
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
        tools: this.#toolsForMode().map((tool) => tool.name),
        ...(this.#input.permissionMode === undefined ? {} : { permissionMode: this.#input.permissionMode }),
        ...(this.#input.resumeSessionId === undefined
          ? {}
          : { resumedFrom: this.#input.resumeSessionId }),
      } as never);

      const initial: ChatMessage[] = [];
      const system = this.#input.systemPrompt;
      if (system !== undefined && system.kind !== 'default' && system.text !== '') {
        initial.push({ role: 'system', content: system.text });
      }
      /*
       * What the model already said, read back from disk.
       *
       * This is the difference between a conversation and a series of
       * unrelated questions. The server holds nothing between requests, so a
       * resumed turn that sent only the new message produced a model with no
       * memory of the last one — asked "what did I just ask you?", it guessed.
       * The system prompt stays first, and the new message stays last.
       */
      if (this.#input.resumeSessionId !== undefined) {
        initial.push(
          ...(await sessionStore.readMessages({
            env: this.#input.env,
            sessionId: this.#input.resumeSessionId,
            cwd: this.#input.cwd,
          })),
        );
      }
      const user: ChatMessage = { role: 'user', content: this.#input.prompt };
      initial.push(user);
      // Stored before the first completion, so an unanswered question is still
      // part of the conversation when the user comes back to it.
      this.#persist([{ message: user, events: this.#storedEvents(user) }]);

      await runAgentLoop({
        initialMessages: initial,
        tools: this.#toolsForMode(),
        complete: (request) => this.#complete(request.messages, request.tools),
        context: {
          root: this.#input.cwd,
          // The extra directories a run was given ride along read-only: the
          // file-reading tools may reach a team memory bank kept outside cwd
          // (see the engine's bank merge), a write still has to land in cwd,
          // and the shell stays confined to cwd whatever this list holds — the
          // safe reading of "let the model read Cortex". Omitted entirely when
          // empty, so the ordinary single-root run is untouched.
          ...(this.#input.additionalDirectories === undefined ||
          this.#input.additionalDirectories.length === 0
            ? {}
            : {
                additionalRoots: this.#input.additionalDirectories.map((dir) => ({
                  path: dir,
                  writable: false as const,
                })),
              }),
          env: sandboxEnv(this.#input.env, []),
          signal: this.#abort.signal,
          shell: (command, signal) => this.#shell(command, signal),
          // Only when there is something to call. Absent, `executeTool` keeps
          // answering "no tool called that exists", which on a run with no
          // servers is exactly true.
          ...(this.#servers === undefined
            ? {}
            : {
                callServerTool: (name, args, signal) =>
                  (this.#servers as ConnectedToolServers).call(name, args, signal),
              }),
        },
        approve: (call, tool) => this.#approve(call, tool),
        onToolStart: (call) => {
          let input: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(call.argumentsJson);
            if (typeof parsed === 'object' && parsed !== null) input = parsed as Record<string, unknown>;
          } catch {
            /* reported to the model by executeTool; the row shows the raw text */
          }
          const started = { type: 'tool.start', toolCallId: call.id, name: call.name, input };
          this.#emit(started as never);
          this.#toolEvents.set(call.id, [started as StoredEvent]);
        },
        onToolEnd: (call, output, failed) => {
          const ended = {
            type: 'tool.end',
            toolCallId: call.id,
            name: call.name,
            status: failed ? 'error' : 'ok',
            resultText: output,
          };
          this.#emit(ended as never);
          // Beside its `tool.start`, so the pair replays as one collapsed row
          // rather than as a call with no outcome.
          this.#toolEvents.get(call.id)?.push(ended as StoredEvent);
        },
        onAppend: (message) => {
          this.#persist([{ message, events: this.#storedEvents(message) }]);
        },
      });

      // The transcript is on disk before the turn is declared over, so a
      // caller that resumes the moment it sees `run.end` reads a complete
      // conversation rather than one still being written.
      await this.#writes;

      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: 'completed',
        sessionId: this.#sessionId,
        ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      } as never);
    } catch (error) {
      const aborted = this.#abort.signal.aborted;
      // An interrupted turn keeps the part of itself that happened — the
      // queued writes are already what the model was told, so flushing them is
      // what makes "stop" different from "undo".
      await this.#writes;
      this.#status = 'ended';
      this.#emit({
        type: 'run.end',
        reason: aborted ? 'interrupted' : 'error',
        sessionId: this.#sessionId,
        ...(aborted ? {} : { error: toError(error, this.#flavour) }),
      } as never);
    } finally {
      // Every parked approval is released, or a disposed run leaves the loop
      // waiting on a promise nobody will ever settle. Ordinarily the abort
      // listener has already done this; a run that ended some other way with a
      // prompt still open has not.
      this.#refuseAllPending();
      // Every connection this run opened, closed with it. A stdio server is a
      // child process: leaving one behind would leak one per run, and the run
      // that leaked it is the one that can name it.
      if (this.#servers !== undefined) await this.#servers.close();
      if (this.#scratch !== undefined) void rm(this.#scratch, { recursive: true, force: true });
      this.#queue.close();
    }
  }

  send(): Promise<SendResult> {
    // Refused rather than queued: `midRunSteering` is false, so the composer is
    // already disabled, and a message silently delivered a turn later is worse
    // than one that was plainly not accepted.
    return Promise.reject(
      adapterError('invalid_request', `${this.#flavour.label} cannot take a message mid-turn.`),
    );
  }

  interrupt(): Promise<InterruptResult> {
    this.#abort.abort();
    return Promise.resolve({ stillQueued: [] });
  }

  respondToPermission(id: PermissionRequestId, decision: PermissionDecision): Promise<void> {
    const pending = this.#pending.get(id);
    // An unknown id is not an error: a request already settled by a dispose, or
    // answered twice by an impatient click, has nothing left to decide.
    if (pending === undefined) return Promise.resolve();
    this.#pending.delete(id);
    pending.resolve(decision.behavior === 'allow' ? 'allow' : 'deny');
    this.#emit({ type: 'permission.resolved', requestId: id, decision } as never);
    return Promise.resolve();
  }


  dispose(): Promise<void> {
    this.#abort.abort();
    this.#queue.close();
    return Promise.resolve();
  }
}

/**
 * Normalise a thrown value into the error a `run.end` carries.
 *
 * `AdapterError` already holds a scrubbed `AgentError`, so it is unwrapped
 * rather than rebuilt — rewrapping would discard the code the thrower chose.
 */
function toError(error: unknown, flavour: LocalFlavour): AgentError {
  if (error instanceof AdapterError) return error.agentError;
  if (error instanceof Error && error.name === 'AbortError') {
    return adapterError('cancelled', 'The run was stopped.').agentError;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return adapterError(
    'provider_unavailable',
    `Could not reach the ${flavour.label} server. ${detail}`,
  ).agentError;
}

/**
 * Whether a binary is here — the probe both the run and the descriptor use.
 *
 * Shared rather than written twice, because two copies of "can this machine
 * confine a command" would be two chances to answer differently, and the whole
 * value of showing the confinement is that it is the same answer the shell tool
 * will act on.
 */
async function hasBinary(binary: string): Promise<boolean> {
  if (binary.startsWith('/')) return existsSync(binary);
  // A bare name has to be found on PATH, which is what `which` is for.
  try {
    await execFileAsync('which', [binary]);
    return true;
  } catch {
    return false;
  }
}

/** Build the adapter for one local server. */
export function createLocalAdapter(
  flavour: LocalFlavour,
  options?: LocalAdapterOptions,
): ProviderAdapter {
  return {
    id: flavour.id,
    label: flavour.label,
    credentials: localCredentials(),
    capabilities: LOCAL_CAPABILITIES,

    /**
     * A local provider is available when its server answers, not when a binary
     * is on `PATH` — the server may be an app, a container or a machine on the
     * desk. Asking the endpoint is the only honest probe.
     */
    /**
     * What is confining this provider's shell commands on this machine.
     *
     * Only the local providers implement this, and that asymmetry is the point:
     * Artemis builds the shell tool here, so Artemis is what confines it. See
     * `ProviderAdapter.describeSandbox`.
     */
    async describeSandbox() {
      const resolved = await resolveSandbox(process.platform, hasBinary);
      return {
        ...(resolved.backend === undefined ? {} : { backend: resolved.backend.name }),
        confinement: resolved.confinement,
        verification: resolved.backend?.verification ?? ('unverified' as const),
        detail: describeConfinement(resolved),
      };
    },

    /*
     * Probes the address the *profile* names, not the flavour's default.
     *
     * Reading the default here was the defect that made a configured profile
     * unusable: a server on any other port reported that nothing was answering
     * at 127.0.0.1:8080 while `listModels` — which did honour the profile —
     * happily listed its models. Two answers to one question, and the wrong
     * one was the one on screen.
     *
     * The query is optional because the probe runs before any profile is
     * chosen, in `providers:list`. With nothing to go on the default is still
     * the right guess; what matters is that a profile's address is used when
     * there is one.
     */
    async checkAvailability(query) {
      const root = baseUrl(flavour, query?.env ?? {});
      try {
        const response = await fetch(`${root}/v1/models`, {
          headers: authHeaders(query?.env ?? {}),
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return { available: true as const };
        // 401 and 403 are the server working correctly and refusing *us*,
        // which is a different problem from a server that is not there — and
        // the one a user with `--api-key` set hits. Saying "start the server"
        // to someone whose server is running is how they end up restarting it
        // instead of filling in the key field.
        const reason =
          response.status === 401 || response.status === 403
            ? `${flavour.label} at ${root} refused the request (${response.status}). Check this profile's API key.`
            : `The ${flavour.label} server at ${root} answered ${response.status}.`;
        // `unavailableReason`, as the seam spells it — this was `reason` once,
        // which the descriptor path reads right past, so every one of these
        // sentences reached the screen as a bare "Unavailable."
        return { available: false as const, unavailableReason: reason };
      } catch {
        return {
          available: false as const,
          unavailableReason: `Nothing is answering at ${root}. Start ${flavour.label} and try again.`,
        };
      }
    },

    /**
     * Ask the server what it can run.
     *
     * Never rejects: an unreachable server is an ordinary state of a desktop,
     * and emptying the picker would be a worse answer than saying nothing was
     * confirmed. The richer endpoint is tried first and the OpenAI one second,
     * for the reasons in each flavour's catalogue module.
     */
    async listModels(query) {
      const root = baseUrl(flavour, query.env ?? {});
      const attempts = [
        { path: flavour.cataloguePath, parse: flavour.parseCatalogue },
        ...(flavour.fallback === undefined ? [] : [flavour.fallback]),
      ];

      for (const attempt of attempts) {
        try {
          const response = await fetch(`${root}${attempt.path}`, {
            headers: authHeaders(query.env ?? {}),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) continue;
          const models = attempt.parse(await response.json());
          if (models.length > 0) return { models, live: true };
        } catch {
          continue;
        }
      }
      return { models: [], live: false };
    },

    /**
     * This project's conversations, from the profile's own store.
     *
     * Every one of these is a file operation rather than a request: the server
     * has no history to ask for, so what is listed is what Artemis wrote. That
     * also means an empty answer is a real answer — a store with nothing in it
     * is a profile that has not run yet, not a provider that could not be
     * reached — which is why none of these reject on a missing directory.
     */
    listSessions(query: SessionListQuery): Promise<SessionListPage> {
      return sessionStore.list(query, flavour.id);
    },

    listAllSessions(query: AllSessionsQuery): Promise<AggregatedSessionList> {
      return sessionStore.listAll(query, flavour.id);
    },

    getSessionMessages(query: SessionMessagesQuery): Promise<SessionTranscript> {
      return sessionStore.readEvents({
        env: query.env,
        sessionId: query.sessionId,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        runId: query.runId,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    /**
     * The seam between this conversation and the run about to join it.
     *
     * Counted in stored messages, which is the unit `getSessionMessages` pages
     * in — the whole value of the number is that `limit: historyOffset` stops
     * exactly where the live replay begins. Answers `0` for a session with no
     * file, which here is the truth rather than a guess: this adapter owns the
     * store, so "no file" means "nothing was ever written".
     */
    countSessionMessages(query: SessionMessageCountQuery): Promise<number> {
      return sessionStore.count({
        env: query.env,
        sessionId: query.sessionId,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },

    async setSessionTitle(update: SessionTitleUpdate): Promise<void> {
      const named = await sessionStore.setTitle(
        {
          env: update.env,
          sessionId: update.sessionId,
          ...(update.cwd === undefined ? {} : { cwd: update.cwd }),
        },
        update.title,
      );
      // Rejecting rather than answering quietly: a rename that found nothing to
      // rename has failed, and the caller is a menu item the user just clicked.
      if (!named) {
        throw adapterError('invalid_request', 'There is no such conversation in this profile.');
      }
    },

    deleteSession(query: SessionDeleteQuery): Promise<boolean> {
      return sessionStore.remove({
        env: query.env,
        sessionId: query.sessionId,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },

    tagSession(query: SessionTagQuery): Promise<boolean> {
      return sessionStore.tag(
        {
          env: query.env,
          sessionId: query.sessionId,
          ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        },
        query.tag,
      );
    },

    createRun(input: ResolvedRunInput): Promise<Run> {
      // Refused rather than approximated, the same rule the other adapters
      // follow: the store is append-only and has no message identity to point
      // at, so neither control can be honoured. See `LOCAL_CAPABILITIES`.
      if (input.forkSession === true || input.rewindToMessageId !== undefined) {
        return Promise.reject(
          adapterError(
            'invalid_request',
            `${flavour.label} conversations cannot be forked or rewound yet.`,
          ),
        );
      }
      return Promise.resolve(new LocalRun(input, flavour, options ?? {}));
    },
  } as ProviderAdapter;
}
