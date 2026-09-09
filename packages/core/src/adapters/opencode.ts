/**
 * The OpenCode adapter.
 *
 * Third provider, and the first built on a *shared* transport: everything
 * protocol-shaped lives in `adapters/acp`, so this file is a credential spec, a
 * capability declaration, and the wiring between an {@link AcpClient} and the
 * normalized event stream. Kimi Code and Grok Build speak the same dialect, and
 * the intended shape of adding them is a second file this size — not a second
 * transport.
 *
 * Verified against `opencode acp` 1.18.18 on 2026-08-17, driven live through
 * `scripts/acp-probe.ts`.
 *
 * ## Why `XDG_DATA_HOME` is the isolation variable
 *
 * Every other provider names its own: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`.
 * OpenCode has `OPENCODE_CONFIG_DIR` and it is *the wrong variable* — driving
 * the binary showed it relocates configuration while credentials stay at
 * `~/.local/share/opencode/auth.json`. Two profiles set up that way would share
 * one account, which is precisely the failure `configDirVar` exists to prevent.
 * `XDG_DATA_HOME` is what actually moves the account, so that is what a profile
 * sets, and a profile's OpenCode state lives at `<profileDir>/opencode/`.
 *
 * The variable is generic rather than vendor-specific, which is worth stating
 * plainly: it is set on the environment of *this subprocess only*, composed per
 * run by `composeProviderEnv`, and never exported into the user's session. A
 * second provider in the same profile directory is unaffected — it reads its
 * own variable.
 *
 * ## Why the scrub list is so much longer than Claude's
 *
 * OpenCode is a multi-provider agent: it will authenticate to Anthropic,
 * OpenAI, xAI, Google and a dozen more from environment variables if they
 * happen to be set. Every one of those outranks the profile's own login the
 * same way `ANTHROPIC_API_KEY` outranks a Claude subscription — the billing
 * trap the seam was built to make structural. So the list below covers the
 * provider keys OpenCode reads, not just OpenCode's own.
 */

import type {
  AdapterAvailability,
  ModelCatalogue,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionListPage,
  InterruptResult,
} from './types.js';
import type {
  AgentError,
  AgentEvent,
  Capabilities,
  JsonObject,
  PermissionDecision,
  PermissionMode,
  PermissionRequestId,
  ProviderId,
  ProviderModelOption,
  RunStatus,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { connectAcpAgent, isAcpAuthRequiredError } from './acp/client.js';
import type { AcpClient, AcpClientOptions } from './acp/client.js';
import type {
  AcpPermissionOption,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionListEntry,
} from './acp/protocol.js';
import { composeProviderEnv } from './env.js';
import { buildPromptBlocks } from './opencode/blocks.js';
import {
  applyPromptUsage,
  createOpencodeMapperState,
  finishOpencodeRun,
  flushOpencodeToolCalls,
  mapOpencodeUpdate,
  mapStopReason,
  openSession,
  stampOpencodeEvent,
} from './opencode/mapper.js';
import type { OpencodeMapperState } from './opencode/mapper.js';
import { AsyncQueue, createDeferred } from './stream.js';
import type { Deferred } from './stream.js';
import { adapterError, toAgentError } from './types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const PROVIDER_ID: ProviderId = 'opencode';

/** Default executable name, resolved on `PATH`. */
const DEFAULT_EXECUTABLE = 'opencode';

/**
 * Variables that could authenticate a run without going through the profile's
 * own directory. All strip-only: Artemis writes none of them.
 */
const OPENCODE_ENV_SCRUB_KEYS: readonly string[] = [
  // OpenCode's own credential and configuration surface.
  'OPENCODE_API_KEY',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONSOLE_TOKEN',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  // Model-provider keys OpenCode will happily authenticate with. Each one is a
  // way to bill an account the profile did not choose.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  // The isolation variable itself: inherited, it would point every profile at
  // the same account.
  'XDG_DATA_HOME',
];

/** How a profile's OpenCode account is located and signed in. */
export const OPENCODE_CREDENTIALS: ProviderCredentialSpec = {
  // Not `OPENCODE_CONFIG_DIR` — see the module header.
  configDirVar: 'XDG_DATA_HOME',
  /**
   * OpenCode names no directory variable of its own — verified against
   * `opencode debug paths`, every path it uses comes from an `XDG_*` root, and
   * `OPENCODE_CONFIG_DIR` moves none of them; it only adds a config *file* to
   * read. So `XDG_DATA_HOME` above is doing the isolation, and it is a variable
   * the whole desktop shares.
   *
   * Both roots are therefore stood in for rather than overridden. Data carries
   * the credential and must be the profile's own; config carries the providers,
   * endpoints and model settings, which two profiles were sharing until this
   * existed. Everything else in either root — this machine has `claude` and
   * `uv` under data, and `gh`, `fish` and a set of mode-600 credential files
   * under config — is linked back where it belongs, so a tool the agent runs
   * still finds its real state.
   */
  xdgRoots: [
    {
      variable: 'XDG_DATA_HOME',
      defaultSubpath: '.local/share',
      ownedEntry: 'opencode',
      // The profile directory *is* the stand-in root, not a directory beneath
      // it. `configDirVar` already points `XDG_DATA_HOME` here and the account
      // already lives at `<profileDir>/opencode/`, so building the farm
      // anywhere else would move `auth.json` out from under existing profiles
      // and leave the sign-in command — which composes `configDirVar` directly
      // — pointing somewhere runs no longer read.
      farmSubpath: '.',
    },
    {
      variable: 'XDG_CONFIG_HOME',
      defaultSubpath: '.config',
      ownedEntry: 'opencode',
      // Config has no such constraint: nothing pointed at it before, so it can
      // live in a named subdirectory rather than sharing the profile root.
      farmSubpath: 'xdg-config',
    },
  ],
  credentialEnvKeys: OPENCODE_ENV_SCRUB_KEYS,
  signIn: {
    executable: DEFAULT_EXECUTABLE,
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'list'],
    logoutArgs: ['auth', 'logout'],
    howTo:
      'OpenCode opens a picker in your terminal to add a provider credential. Artemis never sees it — the credential is written into this profile’s own directory.',
    /**
     * `opencode auth list` prints a decorated summary rather than JSON, so the
     * shared parser cannot read it. The one fact needed is whether the isolated
     * directory holds any credential at all.
     *
     * Deliberately tolerant about *which* provider is signed in: OpenCode is
     * multi-provider, and a profile with a Google key is as signed in as one
     * with an Anthropic key. It also runs its own free models with no
     * credential at all — verified live — so a profile reporting zero
     * credentials is usable rather than broken, and the UI says so instead of
     * blocking.
     */
    parseStatus: (result) => {
      if (result.exitCode !== 0) {
        return {
          loggedIn: false,
          error:
            result.stderr.trim() === ''
              ? 'The OpenCode CLI could not read this profile’s credentials.'
              : result.stderr.trim().slice(0, 200),
        };
      }
      const text = `${result.stdout}\n${result.stderr}`;
      const match = /(\d+)\s+credentials?/i.exec(text);
      const count = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
      return count > 0 ? { loggedIn: true, authMethod: 'opencode' } : { loggedIn: false };
    },
  },
};

/**
 * What this adapter can do, as a constant.
 *
 * **Static by contract** — the renderer caches it and builds a stable UI from
 * it — which is why it is a literal here rather than a read of the ACP
 * handshake, even though the handshake reports the same territory per
 * connection.
 *
 * Everything below is set from behaviour driven live against the binary, not
 * from what the handshake advertises. The distinction earned its keep: the
 * handshake announces `close`, `fork`, `list` and `resume`, but only four of
 * those turned out to be methods that exist — `session/info`, `session/status`
 * and `session/message` all answer `METHOD_NOT_FOUND` despite appearing in the
 * binary's strings. A capability declared from an advertisement is an
 * affordance that fails in the user's hands.
 */
export const OPENCODE_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  // Verified: `session/request_permission` parks the turn until answered.
  interactivePermissions: true,
  // Verified: message and thought chunks stream token by token.
  partialMessages: true,
  // ACP has no steering method — a turn is one `session/prompt` request.
  midRunSteering: false,
  // Verified: `session/fork` branches a conversation and returns the new id.
  forkSession: true,
  // Verified: `session/list` answers with id, cwd, title and updatedAt.
  listSessions: true,
  // Verified: `session/load` replays the stored conversation as updates.
  resumeSession: true,
  rewind: false,
  // Verified: real token counts on the `session/prompt` result, context
  // occupancy and cost on the `usage_update` notification.
  usageReporting: true,
  costReporting: true,
  // Verified: the same `usage_update` carries the window and how much of it the
  // conversation is holding.
  contextReporting: true,
  // Metered credits, not a subscription with rate-limit windows.
  planUsageReporting: false,
  // Advertised as `promptCapabilities.image`, and — since 2026-08-18 — actually
  // sent. It was declared true while `createRun` passed only a text block, so an
  // attached image vanished and the model answered about a picture it had never
  // seen. See `opencode/blocks.ts`.
  imageInput: true,
  /**
   * False despite the agent advertising it, which is the unusual case and the
   * reason it is written out.
   *
   * `opencode acp` 1.18.18 answers the handshake with
   * `promptCapabilities.embeddedContext: true`, so a `resource` block carrying
   * inline content should be legal. Sending one **hangs the turn**: the same
   * prompt with no attachment completes in seconds, with an `image` block
   * completes, and with a `resource` block produced nothing in seven minutes.
   * Driven 2026-08-18 through `pnpm opencode:attach`.
   *
   * So the advertisement is real and the delivery is not, which is the exact
   * failure this adapter's header warns about — and it was nearly shipped as
   * `true` on the strength of the handshake alone. Whether the block shape is
   * wrong or OpenCode's handling of it is, is unresolved; either way a user
   * whose run never returns is worse served than one told files are not
   * supported.
   *
   * Reopen this when a `resource` block completes a turn.
   */
  fileInput: false,
  // ACP exposes no system-prompt append; OpenCode owns its own instructions.
  systemPromptAppend: false,
  /**
   * Verified: `session/set_mode` accepts OpenCode's two modes, and `plan`
   * "disallows all edit tools" — which is what Artemis means by plan mode.
   * `build` is Artemis's `default`. The more permissive rungs have no
   * equivalent and are deliberately absent rather than mapped onto `build`,
   * since silently granting `bypassPermissions` is the exact failure the strict
   * check in `createRun` exists to prevent.
   */
  permissionModes: ['plan', 'default'],
};

/** Artemis's permission modes in OpenCode's vocabulary. */
const OPENCODE_MODE_IDS: Partial<Record<PermissionMode, string>> = {
  plan: 'plan',
  default: 'build',
};

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link createOpencodeAdapter}. */
export interface OpencodeAdapterOptions {
  /** Override the executable, for tests and unusual installs. */
  readonly executable?: string;
  /** Arguments that put the CLI in ACP mode. Defaults to `['acp']`. */
  readonly acpArgs?: readonly string[];
  /** Injected clock, for deterministic tests. */
  readonly now?: () => number;
  /** The environment to inherit from. Defaults to `process.env`. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /**
   * Launch the ACP transport. Defaults to spawning a real subprocess.
   *
   * Forwarded to {@link connectAcpAgent} so the adapter's own decisions — which
   * session call a resume makes, how a permission verdict becomes an option id,
   * which cwd a listing reports — are testable without a binary. Production
   * code never passes it.
   */
  readonly spawn?: AcpClientOptions['spawn'];
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** One parked approval, waiting for the user. */
interface ParkedPermission {
  readonly deferred: Deferred<AcpRequestPermissionResponse>;
  readonly options: readonly AcpPermissionOption[];
}

/**
 * One OpenCode turn.
 *
 * Owns its ACP client: unlike the Claude adapter, which keeps a process alive
 * across turns for background work, an OpenCode run is a process that exists
 * for the length of the turn. There is no `release` override, so the registry
 * disposes when a run ends, which is correct here.
 */
class OpencodeRun implements Run {
  readonly runId: string;
  readonly providerId = PROVIDER_ID;
  readonly capabilities = OPENCODE_CAPABILITIES;

  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #state: OpencodeMapperState;
  readonly #permissions = new Map<PermissionRequestId, ParkedPermission>();
  readonly #startedAt: number;

  #client: AcpClient | undefined;
  #status: RunStatus = 'starting';
  #disposing: Promise<void> | undefined;
  #nextPermissionId = 0;

  constructor(runId: string, state: OpencodeMapperState, startedAt: number) {
    this.runId = runId;
    this.#state = state;
    this.#startedAt = startedAt;
  }

  get status(): RunStatus {
    return this.#status;
  }

  get sessionId(): SessionId | undefined {
    return this.#state.sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  /** @internal Wire the client in once it has connected. */
  attach(client: AcpClient): void {
    this.#client = client;
    this.#status = 'running';
  }

  /** @internal Push mapper output onto the stream. */
  emit(events: readonly AgentEvent[]): void {
    for (const event of events) this.#events.push(event);
  }

  /** @internal Park an approval and announce it. */
  requestPermission(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    const id: PermissionRequestId = `perm-${this.runId}-${String(this.#nextPermissionId++)}`;
    const deferred = createDeferred<AcpRequestPermissionResponse>();
    this.#permissions.set(id, { deferred, options: request.options });

    const toolName = request.toolCall.title ?? 'tool';
    this.emit([
      stampOpencodeEvent(this.#state, {
        type: 'permission.request',
        requestId: id,
        request: {
          id,
          runId: this.runId,
          toolName,
          input: (request.toolCall.rawInput ?? {}) as JsonObject,
          ...(request.toolCall.toolCallId === undefined
            ? {}
            : { toolCallId: request.toolCall.toolCallId }),
          ...(request.toolCall.title === undefined || request.toolCall.title === null
            ? {}
            : { title: request.toolCall.title }),
        },
      }),
    ]);

    return deferred.promise;
  }

  async send(): Promise<SendResult> {
    // ACP models a turn as one request with no steering channel, so there is
    // nothing honest to do with mid-run text. Rejecting is the contract's
    // alternative to silently dropping it.
    throw adapterError(
      'invalid_request',
      'OpenCode cannot take more input while a turn is running.',
    );
  }

  async interrupt(): Promise<InterruptResult> {
    if (this.#state.ended) return { stillQueued: [] };
    this.#state.interruptRequested = true;
    this.#client?.cancel();
    // The turn ends when the agent answers `session/prompt` with `cancelled`;
    // `run.end` is emitted there, not here.
    return { stillQueued: [] };
  }

  async respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    const parked = this.#permissions.get(requestId);
    if (parked === undefined) {
      // A double answer usually means the UI lost track of which prompt it is
      // showing, which is worth surfacing rather than absorbing.
      throw adapterError(
        'invalid_request',
        `No permission request "${requestId}" is waiting for an answer.`,
      );
    }
    this.#permissions.delete(requestId);

    const optionId = chooseOption(parked.options, decision.behavior === 'allow');
    parked.deferred.resolve(
      optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } },
    );

    this.emit([
      stampOpencodeEvent(this.#state, {
        type: 'permission.resolved',
        requestId,
        behavior: decision.behavior,
      }),
    ]);
  }

  /** @internal End the run, settling everything it holds. */
  finish(reason: Parameters<typeof finishOpencodeRun>[1]): void {
    if (this.#state.ended) return;
    this.#denyOutstanding();
    this.emit(
      finishOpencodeRun(this.#state, {
        ...reason,
        durationMs: reason.durationMs ?? Math.max(0, this.#state.now() - this.#startedAt),
      }),
    );
    this.#status = 'ended';
    this.#events.close();
  }

  dispose(): Promise<void> {
    this.#disposing ??= (async () => {
      this.#state.disposeRequested = true;
      this.finish({ reason: this.#state.ended ? 'completed' : 'disposed' });
      await this.#client?.dispose();
    })();
    return this.#disposing;
  }

  /**
   * Cancel every parked approval.
   *
   * `cancelled` rather than a denial, on the same reasoning as the ACP client:
   * the user never answered, and telling the agent they said no would teach it
   * something untrue.
   */
  #denyOutstanding(): void {
    for (const [, parked] of this.#permissions) {
      parked.deferred.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.#permissions.clear();
  }
}

/**
 * Pick the option matching the user's verdict.
 *
 * ACP option ids are opaque and agent-defined, so the mapping goes through
 * `kind` rather than guessing at a string. The "once" variants are chosen over
 * the "always" ones deliberately: Artemis owns durable permission rules in its
 * own vocabulary, and letting the agent persist a rule Artemis did not record
 * would put the two out of step.
 */
function chooseOption(
  options: readonly AcpPermissionOption[],
  allow: boolean,
): string | undefined {
  const wanted = allow ? 'allow_once' : 'reject_once';
  const fallback = allow ? 'allow_always' : 'reject_always';
  return (
    options.find((option) => option.kind === wanted)?.optionId ??
    options.find((option) => option.kind === fallback)?.optionId
  );
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Create the OpenCode adapter. */
export function createOpencodeAdapter(options?: OpencodeAdapterOptions): ProviderAdapter {
  const executable = options?.executable ?? DEFAULT_EXECUTABLE;
  const acpArgs = options?.acpArgs ?? ['acp'];
  const now = options?.now ?? Date.now;
  const hostEnv = options?.hostEnv ?? process.env;
  const spawn = options?.spawn;

  return {
    id: PROVIDER_ID,
    label: 'OpenCode',
    credentials: OPENCODE_CREDENTIALS,
    capabilities: OPENCODE_CAPABILITIES,

    async checkAvailability(): Promise<AdapterAvailability> {
      const found = await which(executable, hostEnv);
      return found
        ? { available: true }
        : {
            available: false,
            unavailableReason:
              'The OpenCode CLI was not found on your PATH. Install it, then reopen this window.',
          };
    },

    /**
     * The account's model list, read from the CLI rather than the transport.
     *
     * `session/new` answers with the same catalogue in its `configOptions`, and
     * using it would mean creating a throwaway conversation every time the
     * settings screen refreshes — junk in the user's history as a side effect
     * of looking at a list. `opencode models` prints one id per line, costs no
     * tokens, and leaves nothing behind.
     *
     * Resolves rather than rejects, per the seam's contract: a machine with no
     * CLI answers with the built-in list marked `live: false`, and the settings
     * screen says so instead of rendering empty.
     */
    async listModels(query): Promise<ModelCatalogue> {
      const env = composeProviderEnv(query.env, {
        inheritHostEnv: query.inheritHostEnv !== false,
        hostEnv,
        scrubKeys: OPENCODE_ENV_SCRUB_KEYS,
      });

      try {
        const { stdout } = await runCommand(executable, ['models'], query.cwd, env);
        const models = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '' && !line.startsWith('┌') && line.includes('/'))
          .map(toModelOption);

        return models.length === 0
          ? { models: OPENCODE_FALLBACK_MODELS, live: false }
          : { models, live: true };
      } catch {
        return { models: OPENCODE_FALLBACK_MODELS, live: false };
      }
    },

    /**
     * Stored conversations for one profile and working directory.
     *
     * Opens a short-lived ACP connection, asks, and tears it down — the same
     * shape as any other control-channel read, and the reason it costs no
     * tokens. `session/list` reports every conversation the account can see, so
     * the cwd filter is applied here rather than asked for: the agent has no
     * per-directory query.
     *
     * The `cwd` on each entry comes from the session's own record, which is what
     * the seam requires. Nothing decodes a directory name.
     */
    async listSessions(query): Promise<SessionListPage> {
      const entries = await readSessions(
        executable,
        acpArgs,
        query.cwd,
        composeProviderEnv(query.env, { hostEnv, scrubKeys: OPENCODE_ENV_SCRUB_KEYS }),
        spawn,
      );

      const matching = entries.filter((entry) => entry.cwd === undefined || sameDir(entry.cwd, query.cwd));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? matching.length;
      const page = matching.slice(offset, offset + limit);

      return {
        sessions: page.map((entry) => toSessionSummary(entry, query.profileId, query.cwd)),
        hasMore: offset + page.length < matching.length,
      };
    },

    async createRun(input: ResolvedRunInput): Promise<Run> {
      if (!input.cwd.startsWith('/')) {
        throw adapterError('invalid_request', 'The working directory must be an absolute path.');
      }

      // OpenCode is reached over ACP, whose `session/new` carries a cwd and a
      // set of MCP servers and nothing else — there is no field for directories
      // beyond the working one. So a run's `additionalDirectories`, including
      // any team memory bank the engine merged in, cannot be granted here the
      // way Claude, Codex and the local sandbox grant them. Rather than drop
      // that on the floor in silence — which would leave a model unable to read
      // a folder the user was told every session gets — it is said out loud
      // once. Supporting it means an ACP extension upstream, not a change here.
      if (input.additionalDirectories !== undefined && input.additionalDirectories.length > 0) {
        console.warn(
          `OpenCode run ${input.runId}: ACP has no seam for additional directories, so these were not attached: ${input.additionalDirectories.join(', ')}`,
        );
      }
      const modeId =
        input.permissionMode === undefined ? undefined : OPENCODE_MODE_IDS[input.permissionMode];
      if (input.permissionMode !== undefined && modeId === undefined) {
        // Silently downgrading a permission mode is how a run ends up more
        // permissive than the user asked for.
        throw adapterError(
          'invalid_request',
          `OpenCode does not support the "${input.permissionMode}" permission mode.`,
        );
      }

      const state = createOpencodeMapperState(input.runId, {
        now,
        ...(input.resumeSessionId === undefined ? {} : { resumedFrom: input.resumeSessionId }),
        ...(input.forkSession === true ? { forked: true } : {}),
      });
      const run = new OpencodeRun(input.runId, state, now());

      const env = composeProviderEnv(input.env, {
        inheritHostEnv: input.inheritHostEnv !== false,
        hostEnv,
        scrubKeys: OPENCODE_ENV_SCRUB_KEYS,
      });

      let client: AcpClient;
      try {
        client = await connectAcpAgent({
          executable,
          args: acpArgs,
          cwd: input.cwd,
          env,
          onUpdate: (notification) => {
            run.emit(mapOpencodeUpdate(state, notification));
          },
          onPermissionRequest: (request) => run.requestPermission(request),
          ...(spawn === undefined ? {} : { spawn }),
          onExit: (reason) => {
            // The process dying mid-turn is the one path where nothing else
            // will emit `run.end`.
            if (state.ended) return;
            run.emit(flushOpencodeToolCalls(state, 'cancelled'));
            run.finish({
              reason: state.interruptRequested ? 'interrupted' : 'error',
              ...(state.interruptRequested
                ? {}
                : { error: { code: 'transport', message: reason } satisfies AgentError }),
            });
          },
        });
      } catch (error) {
        throw asAdapterFailure(error);
      }

      run.attach(client);

      let sessionId: string;
      try {
        if (input.resumeSessionId === undefined) {
          sessionId = await client.newSession(input.cwd);
        } else if (input.forkSession === true) {
          // Branch first, then work in the branch: the original conversation is
          // left exactly as it was, which is the whole point of forking.
          sessionId = await client.forkSession(input.resumeSessionId, input.cwd);
        } else {
          // Loading replays the stored conversation as `session/update`
          // notifications, so the transcript arrives before the new turn does.
          await client.loadSession(input.resumeSessionId, input.cwd);
          sessionId = input.resumeSessionId;
        }

        if (modeId !== undefined) {
          // After the session exists and before the turn starts — the only
          // window in which the mode governs everything this run does.
          await client.setMode(modeId);
        }
        if (input.model !== undefined) {
          await client.setModel(input.model);
        }
      } catch (error) {
        await client.dispose();
        throw asAdapterFailure(error);
      }

      run.emit(
        openSession(state, {
          sessionId,
          cwd: input.cwd,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(client.handshake.agentVersion === undefined
            ? {}
            : { providerVersion: client.handshake.agentVersion }),
        }),
      );

      // The turn runs in the background: `createRun` resolves as soon as the
      // session exists, and events flow until `run.end`. Resolving does not
      // mean the provider has finished — the seam says so explicitly.
      void (async () => {
        try {
          const response = await client.prompt(
            buildPromptBlocks(input.prompt, input.attachments, {
              image: client.handshake.acceptsImages,
              // Deliberately not `client.handshake.acceptsEmbeddedContext`.
              // The agent advertises it and hangs when sent one — see
              // `fileInput` above. Passing false here takes the refusal path,
              // which names the file in the prompt so the model can say it did
              // not receive it, rather than leaving the user waiting forever.
              embeddedContext: false,
            }),
          );
          // The authoritative token reading arrives here, on the turn's result,
          // rather than in the stream. Emitted before `run.end` so the run's
          // totals are the ones the agent actually billed.
          run.emit(applyPromptUsage(state, response.usage));
          run.finish({ reason: mapStopReason(response.stopReason) });
        } catch (error) {
          if (state.ended) return;
          run.emit(flushOpencodeToolCalls(state, 'cancelled'));
          run.finish({
            reason: state.interruptRequested ? 'interrupted' : 'error',
            ...(state.interruptRequested ? {} : { error: toAgentError(error, 'transport') }),
          });
        } finally {
          await client.dispose();
        }
      })();

      return run;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn a connect-time failure into the error the seam expects.
 *
 * An agent that refuses for want of a login is not a broken agent: it is the
 * profile screen's question answered over the transport, and it must reach the
 * user as "sign in", never as "the provider crashed".
 */
function asAdapterFailure(error: unknown): unknown {
  if (isAcpAuthRequiredError(error)) {
    const how = error.authMethods[0]?.description;
    return adapterError(
      'auth',
      how === undefined
        ? 'This OpenCode profile is not signed in.'
        : `This OpenCode profile is not signed in. ${how}`,
    );
  }
  return error;
}

/**
 * The catalogue used when the CLI cannot be reached.
 *
 * Deliberately short and generic: OpenCode's real lineup depends on which
 * providers the profile has credentials for, so a long hard-coded list would be
 * wrong for almost every account. These are the ids OpenCode Zen serves without
 * any credential at all, verified live, which makes them the only models a
 * fresh profile is guaranteed to have.
 */
const OPENCODE_FALLBACK_MODELS: readonly ProviderModelOption[] = [
  toModelOption('opencode/big-pickle'),
  toModelOption('opencode/deepseek-v4-flash-free'),
  toModelOption('opencode/hy3-free'),
];

/**
 * Describe a model from its id alone.
 *
 * `opencode models` prints ids and nothing else, so the label and the note are
 * derived rather than reported. That is a deliberate limit: inventing a
 * capability summary ("best for reasoning") from a string would be a guess
 * presented as a fact, so the note says only what the id genuinely tells us —
 * who serves it, and whether it is free.
 */
function toModelOption(id: string): ProviderModelOption {
  const slash = id.lastIndexOf('/');
  const vendor = slash === -1 ? 'opencode' : id.slice(0, slash);
  const tail = id.slice(slash + 1);
  const free = tail.endsWith('-free');

  const label = tail
    .replace(/-free$/, '')
    .split('-')
    .map((word) => (/^v?\d/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');

  return {
    id,
    label,
    note: free ? `Served free by ${vendor}.` : `Served by ${vendor}.`,
  };
}

/** Run a one-shot CLI command and capture its output. */
async function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return await promisify(execFile)(executable, [...args], {
    cwd,
    env,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Open a short-lived ACP connection purely to read the session list. */
async function readSessions(
  executable: string,
  acpArgs: readonly string[],
  cwd: string,
  env: Record<string, string>,
  spawn: AcpClientOptions['spawn'],
): Promise<readonly AcpSessionListEntry[]> {
  const client = await connectAcpAgent({
    executable,
    args: acpArgs,
    cwd,
    env,
    // Nothing streams during a listing, and nothing may be approved by a read.
    onUpdate: () => {},
    ...(spawn === undefined ? {} : { spawn }),
  });
  try {
    return client.handshake.canList ? await client.listSessions() : [];
  } finally {
    await client.dispose();
  }
}

/** Compare two directories without tripping over a trailing slash. */
function sameDir(a: string, b: string): boolean {
  const trim = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);
  // macOS hands back `/private/var/…` for `/var/…`; treat one as the other so a
  // session listed under the resolved path still matches the requested one.
  const normalize = (value: string): string => trim(value).replace(/^\/private\//, '/');
  return normalize(a) === normalize(b);
}

/**
 * Turn a listing entry into the summary the sidebar renders.
 *
 * The cwd comes from the session's own record, per the seam's rule — with one
 * narrowing. macOS resolves `/var` to `/private/var`, so a session started in
 * the directory the caller just asked about comes back spelled differently.
 * Passing that spelling through would give the sidebar two project groups for
 * one directory, so when the two denote the same place the *caller's* spelling
 * wins. This is not decoding a path out of storage layout: both strings are
 * real, and the choice is only which of two names for one directory to show.
 */
function toSessionSummary(
  entry: AcpSessionListEntry,
  profileId: string,
  requestedCwd: string,
): SessionSummary {
  const updatedAt = Date.parse(entry.updatedAt ?? '');
  const createdAt = Date.parse(entry.createdAt ?? '');
  const cwd =
    entry.cwd === undefined || sameDir(entry.cwd, requestedCwd) ? requestedCwd : entry.cwd;

  return {
    id: entry.sessionId,
    providerId: PROVIDER_ID,
    profileId,
    cwd,
    title: entry.title ?? 'Untitled session',
    updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
    ...(Number.isNaN(createdAt) ? {} : { createdAt }),
  };
}

/** Is the executable on `PATH`? */
async function which(executable: string, hostEnv: NodeJS.ProcessEnv): Promise<boolean> {
  // An absolute path is its own answer.
  if (executable.includes('/')) {
    const { access } = await import('node:fs/promises');
    try {
      await access(executable);
      return true;
    } catch {
      return false;
    }
  }

  const path = hostEnv['PATH'];
  if (path === undefined || path === '') return false;

  const { access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    try {
      await access(join(dir, executable));
      return true;
    } catch {
      // Next directory.
    }
  }
  return false;
}
