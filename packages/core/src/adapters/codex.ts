/**
 * The Codex adapter: a subprocess speaking JSON-RPC, normalized into the seam.
 *
 * `codexMapper.ts` is the meaning; this file is the plumbing — the app-server
 * process, the initialize handshake, the thread and turn lifecycle, the
 * approval deferreds, and disposal.
 *
 * ## Why one process per run
 *
 * `codex app-server` can hold many threads at once, so a single long-lived
 * process serving every run would save a spawn. It would also make one run's
 * crash everyone's crash, and put Artemis in the business of multiplexing
 * notifications by `threadId` — with the failure mode that a routing bug sends
 * one conversation's output into another's transcript.
 *
 * A run already owns a process boundary in the Claude adapter (the SDK spawns
 * one per query), the seam is built around per-run isolation, and a spawn costs
 * milliseconds against turns that take seconds. So: one process per run, torn
 * down with it. `listModels`, `listSessions` and `fetchPlanUsage` each open
 * their own short-lived one through {@link withAppServer}.
 *
 * ## Secrets
 *
 * `ResolvedRunInput.env` is the only channel a credential travels on, and this
 * file never reads one. It sets `CODEX_HOME` — which is what scopes a profile's
 * login *and* its history — and strips every variable that could authenticate
 * the CLI some other way. Artemis holds no Codex credential at all: `codex login`
 * writes one into the profile's own directory and this adapter reads a boolean
 * back.
 */

import type {
  AgentError,
  AgentEvent,
  Attachment,
  Capabilities,
  ImageAttachment,
  ImageMediaType,
  JsonObject,
  JsonValue,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRequestId,
  PermissionResolvedEvent,
  PlanUsage,
  PlanUsageWindow,
  PlanUsageWindowId,
  ProviderEffortOption,
  ProviderModelOption,
  RunStatus,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';
import { isFileAttachment, isImageAttachment, NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  createStagingDirectory,
  describeStagedAttachments,
  removeStagingDirectory,
  stageAttachments,
  withAttachmentNote,
} from './attachments.js';

import { composeProviderEnv, readEnv } from './env.js';
import { DISPOSED_DENY_MESSAGE, WITHDRAWN_DENY_MESSAGE } from './mapper.js';
import {
  CODEX_METHOD,
  CODEX_NOTIFICATION,
  CODEX_SERVER_REQUEST,
  asRecord,
  readNumber,
  readString,
} from './codexProtocol.js';
import type {
  CodexAskForApproval,
  CodexLocalImageInput,
  CodexReasoningEffort,
  CodexSandboxPolicy,
  CodexTextInput,
  CodexUserInput,
} from './codexProtocol.js';
import {
  CODEX_PROVIDER_ID,
  createCodexMapperState,
  finalizeCodexRun,
  flushCodexToolCalls,
  mapCodexNotification,
  nextCodexEventEnvelope,
  replayCodexItem,
} from './codexMapper.js';
import type { CodexMapperState } from './codexMapper.js';
import { JsonRpcError, spawnJsonRpcSubprocess } from './jsonrpc.js';
import type { IncomingRequest, JsonRpcSubprocess } from './jsonrpc.js';
import { AsyncQueue, createDeferred } from './stream.js';
import type { Deferred } from './stream.js';
import {
  SESSION_TITLE_INSTRUCTIONS,
  buildTitlePrompt,
  cleanSessionTitle,
  isDeclinedTitle,
} from './titles.js';
import { adapterError, toAgentError } from './types.js';
import type {
  AdapterAvailability,
  AggregatedSessionList,
  AllSessionsQuery,
  AuthStatus,
  EnvBundle,
  InterruptResult,
  ModelCatalogue,
  ModelListQuery,
  PlanUsageQuery,
  ProbeResult,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionDeleteQuery,
  SessionListPage,
  SessionListQuery,
  SessionMessagesQuery,
  SessionTitleQuery,
  SessionTitleUpdate,
  SessionTranscript,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The executable, resolved on `PATH`. */
export const CODEX_EXECUTABLE = 'codex';

/**
 * How long to wait for the initialize handshake before giving up.
 *
 * Generous, because a cold `codex` start also loads MCP servers — the probe
 * against a real install emitted six `mcpServer/startupStatus/updated`
 * notifications before the first turn could begin.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** How long a metadata probe (`model/list`, rate limits) may take. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * How long a naming turn may run once started, matching the Claude adapter's
 * budget for the same call. Bounded because the seam demands it: this is
 * chrome, and a naming call that hangs holds a subprocess nobody can see.
 */
const TITLE_TIMEOUT_MS = 30_000;

/** How long to wait for a turn to interrupt before forcing teardown. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/** How long to let the app server exit cleanly during dispose. */
const DISPOSE_GRACE_MS = 4_000;

/**
 * What the Codex adapter can do, measured against the real app server rather
 * than inferred from documentation.
 *
 * `subagents` is false because although Codex has collab agents, Artemis does
 * not map their items yet — advertising it would promise nesting the transcript
 * cannot render. `costReporting` is false because the protocol reports tokens
 * and rate-limit percentages but never a price.
 */
export const CODEX_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  renameSession: true, // `thread/name/set` — the field Codex's own UI renames
  deleteSession: true, // `thread/delete` — removes the rollout file, not a soft archive
  // The app-server protocol has no tag or label on a thread: `thread/delete` is
  // the only mutation it offers. Archiving therefore has nowhere provider-side
  // to live, and the control says so rather than writing a note Artemis alone
  // could read.
  tagSession: false,
  resumeSession: true,
  rewind: false,
  usageReporting: true,
  planUsageReporting: true,
  /**
   * No delegation concept exists anywhere in the app server. Established
   * 2026-08-18 against 0.147.0 rather than assumed: an unknown method makes the
   * server enumerate every valid one, and none of the ~100 concerns subagents,
   * tasks or delegation. `collaborationMode/list` sounds like it might and
   * answers `Plan` and `Default` — conversation modes, not delegates — and the
   * experimental surface behind `experimentalApi` lists nothing either.
   */
  subagents: false,
  /**
   * Codex reports tokens and never a price. `account/usage/read` answers with
   * `lifetimeTokens`, `peakDailyTokens` and daily buckets; `account/rateLimits/read`
   * adds plan windows and a credit balance. Neither carries a per-token cost,
   * and under a subscription there is no client-side price to compute one from.
   * Verified 2026-08-18.
   */
  costReporting: false,
  // Codex's only instruction lever is `baseInstructions`, which *replaces* the
  // coding-agent preset rather than adding to it — the adapter uses it exactly
  // once, for the ephemeral session-naming turn, where losing the preset is the
  // point. There is no append, so `RunInput.systemPrompt` is not read on the
  // run path and this stays false rather than approximating one with the other.
  systemPromptAppend: false,
  imageInput: true, // `localImage` input items, staged to temp files
  fileInput: true, // staged to a granted temp directory and named in the prompt
  permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
};

/**
 * The variable that scopes a profile.
 *
 * Codex keeps the credential (`auth.json`), the session history (`sessions/`)
 * and the config (`config.toml`) all under this one directory, so pointing it
 * at a per-profile path isolates all three at once — the same property that
 * makes `CLAUDE_CONFIG_DIR` load-bearing for the Claude adapter.
 *
 * **The directory must already exist.** Codex refuses to start otherwise,
 * with `Error loading configuration: CODEX_HOME points to "…", but that path
 * does not exist` — it will not create one. Artemis's profile store is
 * responsible for making it before the first run.
 */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/**
 * Credential and routing variables stripped from the inherited environment.
 *
 * Every one of these is a way to authenticate or redirect the CLI without going
 * through the profile's `CODEX_HOME`, and each outranks it. An `OPENAI_API_KEY`
 * exported in the user's shell would bill metered API usage against the
 * subscription the profile just signed into — the exact trap
 * `CLAUDE_ENV_SCRUB_KEYS` exists to prevent on the other side.
 *
 * Strip-only: Artemis sets none of them, so there is no case where one is
 * removed and then written back.
 */
export const CODEX_CREDENTIAL_ENVS: readonly string[] = [
  // credentials
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  // endpoint overrides that change which account or route is billed
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  // storage location — the thing that makes profiles isolated at all
  'CODEX_HOME',
];

/**
 * Read `codex login status`.
 *
 * The reason {@link ProviderSignInSpec.parseStatus} exists. Codex prints a
 * sentence rather than JSON and offers no `--json` flag, so the default reader —
 * which expects Claude's object — would report every signed-in Codex profile as
 * signed out and tell the user to run a login they had already run.
 *
 * Measured against `codex-cli 0.142.3`:
 *
 * ```
 * $ codex login status            → "Logged in using ChatGPT"   exit 0
 * $ CODEX_HOME=/fresh …           → "Not logged in"             exit 1
 * ```
 *
 * Two traps, both of which cost a wrong answer before being found:
 *
 *  - **The status goes to `stderr`, not `stdout`.** `codex login status 2>&1`
 *    hides this completely, which is exactly how it survived the first reading.
 *    Both streams are searched.
 *  - **The exit code is not the signal.** Signed-out exits `1`, and so does a
 *    genuine failure. Only the text distinguishes them.
 *
 * Anything unrecognised becomes an `error` rather than a confident "signed
 * out": a wrong "signed out" sends the user round a login they have already
 * completed, while a wrong error at least says what it saw.
 */
export function parseCodexAuthStatus(result: ProbeResult): AuthStatus {
  const text = `${result.stdout}\n${result.stderr}`;

  // Checked first: "Not logged in" contains "logged in".
  if (/\bnot logged in\b/i.test(text)) {
    return { loggedIn: false, authMethod: 'none' };
  }

  const match = /\blogged in(?:\s+using\s+(.+?))?\s*$/im.exec(text);
  if (match !== null) {
    const method = match[1]?.trim();
    return {
      loggedIn: true,
      // Normalised to the vocabulary `getAuthStatus` uses over the app server,
      // so the two paths cannot disagree about what the same account is.
      authMethod: method === undefined ? 'unknown' : normaliseAuthMethod(method),
    };
  }

  if (/CODEX_HOME points to/i.test(text)) {
    return {
      loggedIn: false,
      error: 'This profile’s Codex directory does not exist yet.',
    };
  }

  return {
    loggedIn: false,
    error:
      firstLine(text) === ''
        ? 'The Codex CLI did not report a sign-in status.'
        : `Unexpected sign-in status: ${firstLine(text)}`,
  };
}

function normaliseAuthMethod(method: string): string {
  const lowered = method.toLowerCase();
  if (lowered.includes('chatgpt')) return 'chatgpt';
  if (lowered.includes('api key')) return 'apikey';
  return lowered;
}

/**
 * How a Codex profile signs in.
 *
 * Artemis performs no login here either: `codex login`, run with `CODEX_HOME`
 * pointed at the profile's directory, writes a credential Artemis never sees.
 * Artemis sets one variable and reads a boolean back.
 */
export const CODEX_CREDENTIALS: ProviderCredentialSpec = {
  configDirVar: CODEX_HOME_ENV,
  credentialEnvKeys: CODEX_CREDENTIAL_ENVS,
  signIn: {
    executable: CODEX_EXECUTABLE,
    loginArgs: ['login'],
    // `codex login` serves its OAuth on localhost:1455 and prints that URL.
    // Declared so a serving Artemis can proxy the port and a client can
    // forward it — without this, the printed address only works inside the
    // machine (or container) running the CLI.
    loopbackPort: 1455,
    statusArgs: ['login', 'status'],
    logoutArgs: ['logout'],
    parseStatus: parseCodexAuthStatus,
    howTo:
      'Runs Codex’s own sign-in against this profile’s config directory. Your browser opens to authorise ChatGPT, and the credential is written into the profile — Artemis never sees it.',
  },
};

/**
 * The built-in model list.
 *
 * A *fallback*, superseded by {@link ProviderAdapter.listModels} the moment the
 * CLI answers. Kept short on purpose: the live catalogue is authoritative and
 * arrives within a second on any machine that can run a turn at all, so this
 * only has to cover the window before it lands and the case where the CLI
 * cannot be reached.
 *
 * Transcribed from a live `model/list` against `codex-cli 0.142.3`.
 */
export const CODEX_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    displayName: 'GPT-5.5',
    note: 'Frontier model for complex coding, research, and real-world work.',
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    tier: 1,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    displayName: 'GPT-5.4 mini',
    note: 'Faster and cheaper, for routine edits and quick questions.',
    effortLevels: ['low', 'medium', 'high'],
    // Ordinals within *this* catalogue and nothing more — see
    // `ProviderModelOption.tier`. "mini" is Codex's own word for the small one.
    tier: 0,
  },
];

/** Reasoning-effort levels, least to most. Codex calls these `reasoningEffort`. */
export const CODEX_EFFORT_LEVELS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Fast responses with lighter reasoning.' },
  { id: 'medium', label: 'Medium', note: 'Balances speed and reasoning depth for everyday tasks.' },
  { id: 'high', label: 'High', note: 'Greater reasoning depth for complex problems.' },
  { id: 'xhigh', label: 'Extra high', note: 'Maximum reasoning depth. Slowest.' },
];

const EFFORT_IDS = new Set(CODEX_EFFORT_LEVELS.map((level) => level.id));

/* -------------------------------------------------------------------------- */
/* Permission mapping                                                         */
/* -------------------------------------------------------------------------- */

/** Codex's two axes, recovered from one Artemis permission mode. */
export interface CodexPermissions {
  readonly approvalPolicy: CodexAskForApproval;
  readonly sandboxPolicy: CodexSandboxPolicy;
}

/**
 * Collapse Artemis's single permission axis onto Codex's two.
 *
 * ## The mismatch
 *
 * Artemis's `PermissionMode` came from the Claude SDK, which folds "must it ask
 * first?" and "what may it touch?" into one knob. Codex separates them:
 * `AskForApproval` decides when to prompt, `SandboxPolicy` decides what is
 * reachable at all. Every Artemis mode therefore picks a *pair*.
 *
 * ## Why `dontAsk` and `auto` are not offered
 *
 * `CODEX_CAPABILITIES.permissionModes` advertises four of the six modes, and
 * the two omissions are the interesting part.
 *
 * `dontAsk` is documented as "never prompt; **denies** instead of asking".
 * Codex's nearest neighbour is `never`, which never prompts and **proceeds**
 * within the sandbox. Those are opposites at exactly the moment they matter, and
 * mapping one to the other would make Artemis silently more permissive than the
 * user asked for — the specific failure `ProviderAdapter.createRun` is required
 * to reject rather than degrade into.
 *
 * `auto` describes a provider-side risk classifier. Codex has no equivalent, and
 * `on-failure` (prompt only once a sandboxed command has already failed) is a
 * different idea wearing similar clothes.
 *
 * A mode outside the advertised list is rejected by {@link validateRunInput},
 * not quietly substituted.
 *
 * Re-checked against 0.147.0 on 2026-08-18 and both omissions still hold. There
 * is a second reason to leave `auto` out that is worth recording: Codex's
 * `on-request` is already what `acceptEdits` maps to, so offering `auto` as
 * well would be two names for one behaviour — a choice that is not a choice.
 * `permissionProfile/list` answers `:read-only`, `:workspace` and
 * `:danger-full-access`, which are sandbox profiles rather than approval
 * policies, so they add no mode either.
 */
export function toCodexPermissions(
  mode: PermissionMode | undefined,
  options: { readonly cwd: string; readonly additionalDirectories?: readonly string[] },
): CodexPermissions {
  const writableRoots = [options.cwd, ...(options.additionalDirectories ?? [])];
  const workspaceWrite: CodexSandboxPolicy = {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };

  switch (mode) {
    case 'plan':
      // Research and propose only. `readOnly` is what actually enforces it —
      // `never` alone would let the agent run mutating commands unprompted.
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } };

    case 'acceptEdits':
      // Edits land without a prompt because the sandbox already permits them;
      // anything needing to escape the sandbox still asks.
      return { approvalPolicy: 'on-request', sandboxPolicy: workspaceWrite };

    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };

    case 'default':
    case undefined:
      // `untrusted` prompts for anything not already on Codex's trusted list,
      // which is the closest match to "prompt for anything not already allowed".
      return { approvalPolicy: 'untrusted', sandboxPolicy: workspaceWrite };

    default:
      return { approvalPolicy: 'untrusted', sandboxPolicy: workspaceWrite };
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link createCodexAdapter}. */
export interface CodexAdapterOptions {
  /** Injectable clock, used for every `ts` and every duration. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The environment to inherit from. Defaults to `process.env`. Injectable for tests. */
  readonly hostEnv?: EnvBundle;
  /** Override the executable. Defaults to `codex` on `PATH`. */
  readonly executable?: string;
  /** Sink for things worth knowing but not worth surfacing. Never called with a secret. */
  readonly onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * Create the Codex adapter.
 *
 * Stateless with respect to runs: one instance serves every run, and all
 * per-run state lives on the {@link Run} objects it returns.
 */
export function createCodexAdapter(options?: CodexAdapterOptions): ProviderAdapter {
  const now = options?.now ?? Date.now;
  const hostEnv = options?.hostEnv;
  const executable = options?.executable ?? CODEX_EXECUTABLE;
  const diagnostic = options?.onDiagnostic;

  const deps: CodexRunDeps = {
    now,
    executable,
    ...(hostEnv === undefined ? {} : { hostEnv }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };

  return {
    id: CODEX_PROVIDER_ID,
    label: 'Codex',
    capabilities: CODEX_CAPABILITIES,
    credentials: CODEX_CREDENTIALS,
    models: CODEX_MODELS,
    effortLevels: CODEX_EFFORT_LEVELS,

    /*
     * Meets the two obligations on `ProviderAdapter.listModels`: `model/list` is
     * a control-channel call that never samples the model, and every failure
     * path resolves with the built-in list rather than rejecting — a machine
     * with no CLI, no credential or no network is an ordinary state of a desktop
     * and must not empty the model picker.
     */
    async listModels(query: ModelListQuery): Promise<ModelCatalogue> {
      try {
        const response = await withAppServer(
          {
            deps,
            env: query.env,
            cwd: query.cwd,
            ...(query.inheritHostEnv === undefined ? {} : { inheritHostEnv: query.inheritHostEnv }),
          },
          async (session) => session.request(CODEX_METHOD.modelList, {}),
        );

        const models = parseModelList(response);
        if (models.length === 0) {
          diagnostic?.('Codex returned an empty model list; using the built-in one.');
          return { models: CODEX_MODELS, live: false };
        }
        return { models, live: true };
      } catch (error) {
        diagnostic?.('Could not read the Codex model catalogue.', describe(error));
        return { models: CODEX_MODELS, live: false };
      }
    },

    async createRun(input: ResolvedRunInput): Promise<Run> {
      validateCodexRunInput(input);

      // Created for every run, attachments or not, and granted before the first
      // turn: the sandbox policy is built once from `additionalDirectories`, so
      // a directory created later — when the user attaches to a mid-run steer —
      // would be outside the roots the turn was started with.
      const directory = await createStagingDirectory();

      try {
        const run = new CodexRun(
          {
            ...input,
            additionalDirectories: [...(input.additionalDirectories ?? []), directory],
          },
          deps,
          directory,
        );
        run.start();
        return run;
      } catch (error) {
        // Nothing owns the directory yet — the run that would have removed it
        // was never constructed.
        await removeStagingDirectory(directory);
        throw error;
      }
    },

    async listSessions(request: SessionListQuery): Promise<SessionListPage> {
      const limit = request.limit;
      const offset = request.offset ?? 0;

      const response = await withAppServer(
        { deps, env: request.env, cwd: request.cwd },
        async (session) =>
          session.request(CODEX_METHOD.threadList, {
            cwd: request.cwd,
            // Over-fetch so `hasMore` is a fact rather than a guess, and so the
            // offset can be applied client-side: the protocol paginates by
            // cursor, which cannot express "skip n".
            ...(limit === undefined ? {} : { limit: offset + limit + 1 }),
          }),
      ).catch((error: unknown) => {
        throw adapterError('unknown', `Could not read Codex session history: ${describe(error)}`, {
          cause: error,
        });
      });

      const all = parseThreadList(response, request.profileId, request.cwd);
      const window = all.slice(offset);
      const hasMore = limit !== undefined && window.length > limit;

      return {
        sessions: limit === undefined ? window : window.slice(0, limit),
        hasMore,
      };
    },

    /**
     * Every session in every project, for every profile asked about.
     *
     * Straightforward here in a way it is not for Claude: `thread/list` returns
     * each thread's `cwd` as a real field, so there is no lossy directory-name
     * encoding to decode and no session that has to be dropped for want of a
     * recoverable working directory.
     *
     * One bad profile must not fail the query — a profile whose `CODEX_HOME` was
     * deleted contributes nothing and is named in `unreadableProfiles`.
     */
    async listAllSessions(request: AllSessionsQuery): Promise<AggregatedSessionList> {
      const sessions: SessionSummary[] = [];
      const unreadableProfiles: SessionSummary['profileId'][] = [];

      await Promise.all(
        request.profiles.map(async (scope) => {
          const configDir = readEnv(scope.env, CODEX_HOME_ENV);
          try {
            const response = await withAppServer(
              // No project scope, so the probe needs *a* directory to start in.
              // The profile's own config directory is guaranteed to exist —
              // Codex refuses to start otherwise — which is more than can be
              // said for any workspace path we might guess at.
              { deps, env: scope.env, cwd: configDir ?? process.cwd() },
              async (session) => session.request(CODEX_METHOD.threadList, {}),
            );
            sessions.push(...parseThreadList(response, scope.profileId, undefined));
          } catch (error) {
            diagnostic?.(
              `Could not read Codex history for profile ${scope.profileId}.`,
              describe(error),
            );
            unreadableProfiles.push(scope.profileId);
          }
        }),
      );

      sessions.sort(byNewestThenId);
      return { sessions, unreadableProfiles };
    },

    async getSessionMessages(query: SessionMessagesQuery): Promise<SessionTranscript> {
      const state = createCodexMapperState(query.runId, { now });

      const response = await withAppServer(
        { deps, env: query.env, cwd: query.cwd ?? process.cwd() },
        async (session) =>
          session.request(CODEX_METHOD.threadRead, {
            threadId: query.sessionId,
            includeTurns: true,
          }),
      ).catch((error: unknown) => {
        throw adapterError('unknown', `Could not read the Codex session: ${describe(error)}`, {
          cause: error,
        });
      });

      const thread = asRecord(asRecord(response)['thread']);
      const turns = Array.isArray(thread['turns']) ? (thread['turns'] as unknown[]) : [];

      const events: AgentEvent[] = [];
      for (const turn of turns) {
        const items = Array.isArray(asRecord(turn)['items'])
          ? (asRecord(turn)['items'] as unknown[])
          : [];
        for (const item of items) {
          events.push(...replayCodexItem(item as never, state));
        }
      }

      const offset = query.offset ?? 0;
      const limit = query.limit;
      const window = events.slice(offset);

      return {
        events: limit === undefined ? window : window.slice(0, limit),
        hasMore: limit !== undefined && window.length > limit,
      };
    },

    /**
     * Name a session by running one bounded turn in an **ephemeral** thread.
     *
     * The seam's first obligation is "it is not a run", and `ephemeral: true`
     * is how Codex expresses it: an ephemeral thread writes no rollout file
     * and never appears in `thread/list` — verified against 0.147, because a
     * naming call that left a phantom row in the very list it labels would be
     * worse than no name at all.
     *
     * The other obligations map onto the turn itself:
     *
     *  - **Replacing `baseInstructions`** displaces the coding-agent preset,
     *    for the same reason the Claude adapter sends a bare `systemPrompt` —
     *    the preset spends more tokens describing tools than the title costs.
     *  - **Plan-mode permissions** (`never` + `readOnly`) are the closest
     *    Codex gets to "no tools": nothing can prompt, nothing can write. A
     *    server-initiated approval should therefore be unreachable, and the
     *    `onRequest` fallback declines rather than parks — a naming call must
     *    never sit waiting on a question nobody is being shown.
     *  - **`low` effort**, because this is chrome and is billed like chrome.
     *
     * Resolves `null` on every failure, per the seam's contract: no CLI, no
     * credential, a model the account cannot use — the session just keeps the
     * name it would have had.
     */
    async suggestSessionTitle(request: SessionTitleQuery): Promise<string | null> {
      if (request.abortSignal?.aborted === true) return null;

      let answerText: string | undefined;
      let session: AppServerSession | undefined;
      const outcome = createDeferred<{ ok: boolean; reason?: string }>();
      // Killing the subprocess is what actually reclaims an aborted call —
      // resolving the outcome alone would leave a request in flight until the
      // server got around to answering it. `dispose` is memoised, so the
      // `finally` below disposing again is a no-op rather than a race.
      const onAbort = (): void => {
        outcome.resolve({ ok: false, reason: 'aborted' });
        void session?.process.dispose();
      };
      request.abortSignal?.addEventListener('abort', onAbort, { once: true });
      try {
        session = await openAppServer({
          deps,
          env: request.env,
          cwd: request.cwd,
          ...(request.inheritHostEnv === undefined
            ? {}
            : { inheritHostEnv: request.inheritHostEnv }),
          onNotification: (method, params) => {
            const payload = asRecord(params);
            if (method === CODEX_NOTIFICATION.itemCompleted) {
              const item = asRecord(payload['item']);
              // Last one wins, deliberately: reasoning items are not
              // `agentMessage`s, and a model that answers twice has said the
              // title it means second.
              if (readString(item, 'type') === 'agentMessage') {
                answerText = readString(item, 'text');
              }
            } else if (method === CODEX_NOTIFICATION.turnCompleted) {
              outcome.resolve({ ok: true });
            } else if (method === CODEX_NOTIFICATION.error) {
              outcome.resolve({
                ok: false,
                reason: readString(payload, 'message') ?? 'the app server reported an error',
              });
            }
          },
          onRequest: async (incoming: IncomingRequest) =>
            toApprovalResponse(incoming.method, { behavior: 'deny' }),
          onExit: (reason) => {
            outcome.resolve({ ok: false, reason });
          },
        });

        if (outcome.settled) return null;

        const permissions = toCodexPermissions('plan', { cwd: request.cwd });
        const started = await session.request(
          CODEX_METHOD.threadStart,
          wireParams({
            cwd: request.cwd,
            ephemeral: true,
            baseInstructions: SESSION_TITLE_INSTRUCTIONS,
            model: request.model,
          }),
        );

        await session.request(
          CODEX_METHOD.turnStart,
          wireParams({
            threadId: requireThreadId(started),
            input: [textInput(buildTitlePrompt(request.prompt))],
            cwd: request.cwd,
            approvalPolicy: permissions.approvalPolicy,
            sandboxPolicy: permissions.sandboxPolicy,
            model: request.model,
            effort: 'low' satisfies CodexReasoningEffort,
          }),
        );

        const ended = await withTimeout(
          outcome.promise,
          TITLE_TIMEOUT_MS,
          'The naming turn did not finish in time.',
        );
        if (!ended.ok) {
          diagnostic?.(`Could not name the session: ${ended.reason ?? 'unknown'}`);
          return null;
        }

        const title = cleanSessionTitle(answerText);
        if (title === null && answerText !== undefined && !isDeclinedTitle(answerText)) {
          // Worth a line — a model that keeps answering with prose is a prompt
          // problem, and this is the only place that would show it. A declined
          // answer is excluded: that is the prompt working. See the Claude
          // adapter, which draws the same distinction.
          diagnostic?.(
            `Discarded an unusable session title: ${JSON.stringify(answerText.slice(0, 120))}`,
          );
        }
        return title;
      } catch (error) {
        diagnostic?.(`Could not name the session: ${describe(error)}`, error);
        return null;
      } finally {
        request.abortSignal?.removeEventListener('abort', onAbort);
        // Disposing the subprocess is what discards the ephemeral thread —
        // there is nothing to clean up server-side, which is the point.
        await session?.process.dispose();
      }
    },

    /**
     * `thread/name/set` — the same field Codex's own UI renames, so a title
     * written here survives in the provider's tooling and is read straight
     * back by `parseThreadList` as `titleIsCustom`.
     *
     * Started in the profile's config directory for the reason `deleteSession`
     * documents: the thread id alone locates the rollout, and the session's
     * own cwd may no longer exist.
     *
     * Unlike the delete, a missing rollout **rejects** rather than resolving —
     * the contract says a failed write is worth a log line, and `SessionNamer`
     * depends on the rejection: its one retry exists for the race where a
     * brand-new session's file has not been written yet, and a swallowed
     * "not found" would turn that race into a title that silently never lands.
     */
    async setSessionTitle(update: SessionTitleUpdate): Promise<void> {
      const configDir = readEnv(update.env, CODEX_HOME_ENV);

      try {
        await withAppServer(
          { deps, env: update.env, cwd: configDir ?? process.cwd() },
          async (session) =>
            session.request(CODEX_METHOD.threadNameSet, {
              threadId: update.sessionId,
              name: update.title,
            }),
        );
      } catch (error) {
        throw adapterError('unknown', `Could not rename the Codex session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    /**
     * `thread/delete`, which removes the rollout file itself — verified, not
     * assumed: the capability's contract is a real deletion, and Codex also
     * offers `thread/archive`, which merely relocates the file and would break
     * the promise the confirm dialog makes. Archive is deliberately not what
     * this calls.
     *
     * The app server needs *a* directory to start in, and the profile's config
     * directory is the one guaranteed to exist — the session's own cwd is not,
     * and a workspace deleted since the run is exactly when a user reaches for
     * delete. The thread id alone locates the rollout within `CODEX_HOME`, so
     * the cwd narrows nothing here.
     *
     * "Already gone" resolves `false`, not an error: whether the file was
     * removed out from under Artemis or the id was stale, the user's intent —
     * that this session stop existing — is already satisfied. Only the one
     * wording Codex uses for that case is forgiven; anything else still
     * throws, because a delete that quietly failed is the worst outcome this
     * method can have.
     */
    async deleteSession(query: SessionDeleteQuery): Promise<boolean> {
      const configDir = readEnv(query.env, CODEX_HOME_ENV);

      try {
        await withAppServer(
          { deps, env: query.env, cwd: configDir ?? process.cwd() },
          async (session) =>
            session.request(CODEX_METHOD.threadDelete, { threadId: query.sessionId }),
        );
        return true;
      } catch (error) {
        if (isMissingRollout(error)) return false;
        throw adapterError('unknown', `Could not delete that session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async checkAvailability(): Promise<AdapterAvailability> {
      try {
        const version = await readCodexVersion(executable, hostEnv);
        if (version === undefined) {
          return {
            available: false,
            unavailableReason:
              'The Codex CLI was not found on your PATH. Install it, then reopen this window.',
          };
        }
        return { available: true };
      } catch (error) {
        return {
          available: false,
          unavailableReason: `Could not run the Codex CLI: ${describe(error)}`,
        };
      }
    },

    /**
     * How much of the plan is gone.
     *
     * Meets all three obligations on `ProviderAdapter.fetchPlanUsage`:
     * `account/rateLimits/read` is a control-channel call that never samples the
     * model; a profile on metered API billing reports `available: false` rather
     * than throwing; and a protocol that stops answering degrades to unavailable
     * instead of breaking the caller.
     *
     * Notably sturdier than the Claude equivalent, which has to reach an
     * experimental SDK method through a tolerant name lookup — this one is a
     * first-class method with a stable name.
     */
    async fetchPlanUsage(input: PlanUsageQuery): Promise<PlanUsage> {
      const fetchedAt = now();
      try {
        const response = await withAppServer(
          { deps, env: input.env, cwd: input.cwd },
          async (session) => session.request(CODEX_METHOD.accountRateLimitsRead, {}),
        );

        const limits = asRecord(asRecord(response)['rateLimits']);
        if (Object.keys(limits).length === 0) {
          return {
            available: false,
            unavailableReason: 'This account does not report plan limits.',
            windows: [],
            fetchedAt,
          };
        }

        const windows = parseRateLimitWindows(limits);
        const planType = readString(limits, 'planType');

        if (windows.length === 0) {
          return {
            available: false,
            unavailableReason:
              planType === undefined
                ? 'This account does not report plan limits.'
                : `Usage on the ${planType} plan is metered rather than capped.`,
            ...(planType === undefined ? {} : { subscriptionType: planType }),
            windows: [],
            fetchedAt,
          };
        }

        return {
          available: true,
          ...(planType === undefined ? {} : { subscriptionType: planType }),
          windows,
          fetchedAt,
        };
      } catch (error) {
        diagnostic?.('Could not read Codex plan usage.', describe(error));
        return {
          available: false,
          unavailableReason: 'Codex did not report plan limits for this profile.',
          windows: [],
          fetchedAt,
        };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reject anything the adapter cannot honour, before a process is spawned.
 *
 * Exported for testing: every check here is meant to fire *ahead* of any side
 * effect, and the only way to prove that is to call it without one.
 */
export function validateCodexRunInput(input: ResolvedRunInput): void {
  if (!isAbsolutePath(input.cwd)) {
    throw adapterError('invalid_request', `cwd must be an absolute path, got "${input.cwd}".`);
  }

  if (
    input.permissionMode !== undefined &&
    !CODEX_CAPABILITIES.permissionModes.includes(input.permissionMode)
  ) {
    // Deliberately not downgraded to the nearest supported mode: see
    // `toCodexPermissions` for why `dontAsk` in particular must not be
    // approximated.
    throw adapterError(
      'invalid_request',
      `Codex does not support the "${input.permissionMode}" permission mode. Supported modes: ${CODEX_CAPABILITIES.permissionModes.join(', ')}.`,
    );
  }

  if (input.resumeSessionId !== undefined && !CODEX_CAPABILITIES.resumeSession) {
    throw adapterError('invalid_request', 'Codex cannot resume sessions.');
  }

  if (input.forkSession === true && !CODEX_CAPABILITIES.forkSession) {
    throw adapterError('invalid_request', 'Codex cannot fork sessions.');
  }

  if (input.effort !== undefined && !EFFORT_IDS.has(input.effort)) {
    throw adapterError(
      'invalid_request',
      `Codex does not offer the "${input.effort}" effort level. Supported levels: ${[...EFFORT_IDS].join(', ')}.`,
    );
  }
}

/**
 * Absolute-path test that does not depend on the host platform.
 *
 * `node:path`'s `isAbsolute` answers for whichever platform it is running on,
 * so a Windows path checked on a macOS test runner reads as relative. Both
 * shapes are accepted here because the *provider* is what will reject a bad
 * one, and this check exists to catch the obvious mistake, not to second-guess
 * the filesystem.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/* -------------------------------------------------------------------------- */
/* App-server session                                                         */
/* -------------------------------------------------------------------------- */

interface CodexRunDeps {
  readonly now: () => number;
  readonly executable: string;
  readonly hostEnv?: EnvBundle;
  readonly diagnostic?: (message: string, detail?: unknown) => void;
}

/** A connected, initialized app server. */
interface AppServerSession {
  request(method: string, params?: JsonValue): Promise<JsonValue>;
  notify(method: string, params?: JsonValue): void;
  readonly process: JsonRpcSubprocess;
}

interface OpenAppServerOptions {
  readonly deps: CodexRunDeps;
  readonly env: EnvBundle;
  readonly cwd: string;
  readonly inheritHostEnv?: boolean;
  readonly onNotification?: (method: string, params: JsonValue | undefined) => void;
  readonly onRequest?: (request: IncomingRequest) => Promise<JsonValue>;
  readonly onExit?: (reason: string) => void;
}

/**
 * Spawn `codex app-server` and complete its handshake.
 *
 * The handshake is mandatory and ordered: a single `initialize` request, then an
 * `initialized` notification, before any other method. The server rejects
 * anything sent ahead of it.
 */
async function openAppServer(options: OpenAppServerOptions): Promise<AppServerSession> {
  const env = composeProviderEnv(options.env, {
    ...(options.inheritHostEnv === undefined ? {} : { inheritHostEnv: options.inheritHostEnv }),
    ...(options.deps.hostEnv === undefined ? {} : { hostEnv: options.deps.hostEnv }),
    scrubKeys: CODEX_CREDENTIAL_ENVS,
  });

  const child = spawnJsonRpcSubprocess({
    executable: options.deps.executable,
    /*
     * Reasoning summaries are requested explicitly, because the CLI's model
     * catalog defaults `model_reasoning_summary` to `none` for every current
     * model. Without the override a reasoning item opens and closes with no
     * `item/reasoning/summaryTextDelta` between — observed against the real
     * app server, and the reason Codex turns showed no thinking at all. `-c`
     * rather than the profile's config.toml so a user's own config cannot
     * silently blank the thinking pane, and `auto` rather than a fixed
     * verbosity so the choice stays with the model catalog.
     */
    args: ['app-server', '-c', 'model_reasoning_summary=auto'],
    cwd: options.cwd,
    env,
    ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    ...(options.deps.diagnostic === undefined ? {} : { onDiagnostic: options.deps.diagnostic }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });

  const session: AppServerSession = {
    request: (method, params) => child.connection.request(method, params),
    notify: (method, params) => {
      child.connection.notify(method, params);
    },
    process: child,
  };

  try {
    await withTimeout(
      child.connection.request(CODEX_METHOD.initialize, {
        clientInfo: { name: 'artemis', title: 'Artemis', version: '0.1.0' },
        // No `experimentalApi`: opting in would let a CLI upgrade change the
        // shape of methods a shipped Artemis build depends on.
        capabilities: {},
      }),
      HANDSHAKE_TIMEOUT_MS,
      'The Codex app server did not answer the initialize handshake.',
    );
    session.notify('initialized', {});
  } catch (error) {
    await child.dispose();
    throw enrichLaunchFailure(error, child.stderrTail(), options.deps.executable);
  }

  return session;
}

/** Open an app server, run one thing against it, and always tear it down. */
async function withAppServer<T>(
  options: Omit<OpenAppServerOptions, 'onNotification' | 'onRequest' | 'onExit'>,
  fn: (session: AppServerSession) => Promise<T>,
): Promise<T> {
  const session = await openAppServer(options);
  try {
    return await withTimeout(fn(session), PROBE_TIMEOUT_MS, 'The Codex app server did not answer.');
  } finally {
    await session.process.dispose();
  }
}

/**
 * Turn a failed launch into something a user can act on.
 *
 * `spawn` reports `ENOENT` for a missing executable and for a missing working
 * directory alike, and Codex's own refusal to start on a non-existent
 * `CODEX_HOME` arrives on stderr rather than as an exit code worth reading. The
 * underlying error is wrapped, never swallowed: if the diagnosis is wrong, the
 * original message is the only way anyone will find out.
 */
function enrichLaunchFailure(error: unknown, stderr: string, executable: string): Error {
  const base = error instanceof Error ? error.message : String(error);

  if (/CODEX_HOME points to/i.test(stderr)) {
    return new Error(
      `This profile's Codex directory does not exist, so the CLI refused to start. Create it, or point the profile somewhere else. Codex reported: ${firstLine(stderr)}`,
    );
  }

  if (/ENOENT|not found|not recognized/i.test(base)) {
    return new Error(
      `The "${executable}" CLI could not be started. Check that it is installed and on your PATH. (${base})`,
    );
  }

  return new Error(stderr === '' ? base : `${base} ${firstLine(stderr)}`);
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** One outstanding approval, keyed by the id the UI answers with. */
interface PendingApproval {
  readonly deferred: Deferred<JsonValue>;
  /** Which server request this was, so the answer uses the right vocabulary. */
  readonly method: string;
  readonly toolName: string;
  /**
   * What a permissions request asked for, verbatim off the wire.
   *
   * Kept so an allow can echo it back as the granted set. The answer to
   * `item/permissions/requestApproval` is a *list of grants*, not a decision —
   * answering an approval with `{ permissions: [] }` grants nothing, which
   * turns the user's Allow click into a refusal. See {@link toApprovalResponse}.
   */
  readonly requestedPermissions?: JsonValue;
}

/**
 * One Codex run: a process, a thread, and one turn on it.
 *
 * A run is one turn cycle, per the seam's definition. The thread outlives it —
 * that is what `resumeSessionId` is for — but the process does not.
 */
class CodexRun implements Run {
  readonly runId: string;
  readonly providerId = CODEX_PROVIDER_ID;
  readonly capabilities = CODEX_CAPABILITIES;

  readonly #input: ResolvedRunInput;
  readonly #deps: CodexRunDeps;
  readonly #state: CodexMapperState;
  readonly #eventQueue: AsyncQueue<AgentEvent>;
  readonly #pending = new Map<PermissionRequestId, PendingApproval>();

  #session: AppServerSession | undefined;
  #bootstrap: Promise<void> = Promise.resolve();
  #disposing: Promise<void> | undefined;
  /** Where this run's attachments live, and how many it has written. */
  readonly #stagingDir: string;
  #stagedCount = 0;
  #approvalCounter = 0;
  #detachAbortSignal: (() => void) | undefined;
  #startedAt = 0;

  constructor(input: ResolvedRunInput, deps: CodexRunDeps, stagingDir: string) {
    this.#input = input;
    this.#deps = deps;
    this.runId = input.runId;
    this.#stagingDir = stagingDir;

    this.#state = createCodexMapperState(input.runId, {
      now: deps.now,
      ...(input.resumeSessionId === undefined ? {} : { resumedFrom: input.resumeSessionId }),
      forked: input.forkSession === true,
    });

    this.#eventQueue = new AsyncQueue<AgentEvent>({
      onAbandoned: () => {
        this.#deps.diagnostic?.(`Run ${this.runId}: event stream abandoned by its consumer.`);
      },
    });
  }

  /**
   * Begin the run.
   *
   * Synchronous by design, so the run object is fully constructed before
   * `createRun` returns and a caller can subscribe to `events` before anything
   * is emitted. The connection work is asynchronous and runs as a tracked
   * promise; the event queue buffers, so a consumer cannot tell the difference.
   */
  start(): void {
    this.#startedAt = this.#deps.now();

    const external = this.#input.abortSignal;
    if (external !== undefined) {
      if (external.aborted) {
        void this.dispose();
        return;
      }
      const onAbort = (): void => {
        void this.dispose();
      };
      external.addEventListener('abort', onAbort, { once: true });
      this.#detachAbortSignal = () => {
        external.removeEventListener('abort', onAbort);
      };
    }

    this.#bootstrap = this.#connect();
  }

  get status(): RunStatus {
    if (this.#state.ended) return 'ended';
    if (this.#pending.size > 0) return 'awaiting_permission';
    if (this.#state.sessionStarted) return 'running';
    return 'starting';
  }

  get sessionId(): SessionId | undefined {
    return this.#state.sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#eventQueue;
  }

  /* -------------------------------- control -------------------------------- */

  /**
   * Steer the turn already in flight.
   *
   * Unlike the Claude adapter — which can only queue text and report
   * `deliveredImmediately: false`, because the CLI decides at a tool boundary
   * whether to fold it in — `turn/steer` is acknowledged or rejected by the
   * server. A resolved steer really did land in the running turn, so `true` here
   * is a fact rather than a hope.
   *
   * `expectedTurnId` is what makes that true: the server refuses a steer naming
   * a turn that is no longer live, rather than silently applying it to the next
   * one.
   */
  async send(text: string, attachments?: readonly Attachment[]): Promise<SendResult> {
    if (this.#state.ended) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} has already ended; start a new run with resumeSessionId to continue.`,
      );
    }
    if (this.#disposing !== undefined) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} is shutting down and cannot accept more input.`,
      );
    }

    // The turn id arrives on `turn/started`, which can trail the `turn/start`
    // response. Waiting on the bootstrap is what makes an immediate send work.
    await this.#bootstrap;

    const session = this.#session;
    const threadId = this.#state.sessionId;
    const turnId = this.#state.turnId;
    if (session === undefined || threadId === undefined || turnId === undefined) {
      throw adapterError('invalid_request', `Run ${this.runId} has no live turn to steer.`);
    }

    // Staged before the request and outside its `try`, so a staging failure
    // surfaces as itself rather than as "could not steer the Codex turn".
    const { items, note } = await this.#turnInputs(attachments);

    try {
      await session.request(
        CODEX_METHOD.turnSteer,
        wireParams({
          threadId,
          expectedTurnId: turnId,
          input: [...items, textInput(withAttachmentNote(text, note))],
        }),
      );
      return { deliveredImmediately: true };
    } catch (error) {
      throw adapterError('transport', `Could not steer the Codex turn: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  async interrupt(): Promise<InterruptResult> {
    // "Stop" is idempotent by nature; a run that already stopped is not an error.
    if (this.#state.ended) return { stillQueued: [] };

    this.#state.interruptRequested = true;

    const session = this.#session;
    const threadId = this.#state.sessionId;
    if (session === undefined || threadId === undefined) {
      await this.dispose();
      return { stillQueued: [] };
    }

    // An interrupt with prompts still open would deadlock: the turn cannot wind
    // down while it is parked waiting for an answer nobody is going to give.
    this.#denyAllPending(WITHDRAWN_DENY_MESSAGE);

    try {
      await withTimeout(
        session.request(CODEX_METHOD.turnInterrupt, { threadId }),
        INTERRUPT_TIMEOUT_MS,
        'The Codex app server did not acknowledge the interrupt.',
      );
      // The run does not end here: the server still emits `turn/completed` with
      // `status: "interrupted"`, and that is what produces `run.end`.
      return { stillQueued: [] };
    } catch (error) {
      // Do not leave the user holding a Stop button that did nothing.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: interrupt did not complete, forcing teardown.`,
        describe(error),
      );
      await this.dispose();
      return { stillQueued: [] };
    }
  }

  async respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) {
      // Answering an unknown or already-answered id almost always means the UI
      // has lost track of which prompt it is showing. Failing loudly beats
      // pretending it landed.
      throw adapterError(
        'invalid_request',
        `No outstanding permission request "${requestId}" on run ${this.runId}.`,
      );
    }
    this.#pending.delete(requestId);

    if (decision.behavior === 'deny' && decision.interrupt === true) {
      this.#state.permissionDenyInterrupted = true;
    }

    entry.deferred.resolve(toApprovalResponse(entry.method, decision, entry.requestedPermissions));
    // The stream has to say how the request ended — an answer is an IPC call,
    // invisible to any consumer that was not the caller, and a replayed history
    // without this line shows a prompt still open forever. See
    // `PermissionResolvedEvent`.
    this.#emitResolved(
      requestId,
      decision.behavior === 'allow' ? 'allowed' : 'denied',
      decision.behavior === 'deny' ? decision.message : undefined,
    );
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#teardown();
    return this.#disposing;
  }

  /* -------------------------------- internals ------------------------------ */

  /**
   * Write a turn's attachments to disk and say what the turn should carry.
   *
   * ## Everything is staged, images included
   *
   * Codex has no content-block equivalent for either kind. An image goes on the
   * wire as `localImage` — a **path** — and there is no document variant at all,
   * so a PDF or a CSV can only reach the agent as a file it opens itself. Both
   * therefore get written; what differs is what comes back:
   *
   *  - images become `localImage` input items, so the model sees them;
   *  - files become a line in the prompt naming their path, so the agent can
   *    read them. See `describeStagedAttachments`.
   *
   * Artemis holds bytes rather than paths for both — a pasted screenshot never
   * had a path, and see the note atop `protocol/attachment.ts` for why a
   * renderer-supplied path is not something to read on request.
   *
   * ## Why deleting them at dispose is safe
   *
   * An image is read once, at submission: Codex encodes it into a
   * `data:image/…;base64,…` URL, and it is *that* — not the path — which lands
   * in the rollout as the turn's `input_image` content, so a resumed thread
   * still has the picture after the file is gone. (Confirmed against the app
   * server's generated bindings rather than inferred from the docs.)
   *
   * A staged **file** is different and worth being straight about: it is read
   * only if the agent chooses to, and a resumed thread that reaches for one
   * after dispose gets "no such file". That is the honest outcome — the file
   * belonged to a conversation that has ended — and it beats leaving a
   * directory per run on disk forever.
   */
  async #turnInputs(
    attachments: readonly Attachment[] | undefined,
  ): Promise<{ readonly items: readonly CodexUserInput[]; readonly note: string }> {
    const all = attachments ?? [];
    if (all.length === 0) return { items: [], note: '' };

    const staged = await stageAttachments(this.#stagingDir, all, this.#stagedCount);
    this.#stagedCount += all.length;

    const items = staged
      .filter(({ attachment }) => isImageAttachment(attachment))
      .map(({ path }): CodexUserInput => ({ type: 'localImage', path }));

    // Only the files get named. An image is already an input item; pointing the
    // agent at a staged copy would invite a tool call to open a picture the
    // model can already see.
    const note = describeStagedAttachments(
      staged.filter(({ attachment }) => isFileAttachment(attachment)),
    );

    return { items, note };
  }

  async #connect(): Promise<void> {
    let session: AppServerSession;
    try {
      session = await openAppServer({
        deps: this.#deps,
        env: this.#input.env,
        cwd: this.#input.cwd,
        ...(this.#input.inheritHostEnv === undefined
          ? {}
          : { inheritHostEnv: this.#input.inheritHostEnv }),
        onNotification: (method, params) => {
          this.#onNotification(method, params);
        },
        onRequest: (request) => this.#onServerRequest(request),
        onExit: (reason) => {
          this.#onProcessExit(reason);
        },
      });
    } catch (error) {
      this.#failToLaunch(error);
      return;
    }

    this.#session = session;

    // A dispose that landed while the handshake was in flight has already run
    // its teardown against a session that did not exist yet.
    if (this.#disposing !== undefined || this.#state.ended) {
      await session.process.dispose();
      return;
    }

    try {
      const threadId = await this.#openThread(session);
      await this.#startTurn(session, threadId);
    } catch (error) {
      this.#fail(toAgentError(error, 'transport'));
    }
  }

  /** Start a new thread, resume one, or fork one, per the run's input. */
  async #openThread(session: AppServerSession): Promise<string> {
    const resume = this.#input.resumeSessionId;

    if (resume === undefined) {
      const response = await session.request(CODEX_METHOD.threadStart, { cwd: this.#input.cwd });
      return requireThreadId(response);
    }

    try {
      const response =
        this.#input.forkSession === true
          ? await session.request(CODEX_METHOD.threadFork, {
              threadId: resume,
              cwd: this.#input.cwd,
            })
          : await session.request(CODEX_METHOD.threadResume, {
              threadId: resume,
              cwd: this.#input.cwd,
            });
      const threadId = requireThreadId(response);
      /*
       * Announce the session ourselves. `thread/started` fires for *new*
       * threads only — verified against 0.147, which answers `thread/resume`
       * with the thread object and announces nothing — so a run that waited
       * for the notification never emitted `session.started`, never recorded
       * a session id, and left `send()` with no thread to name: every
       * follow-up message failed. The response is the same `{ thread }`
       * payload the notification carries, so it maps directly; on a server
       * that announces both, `mapThreadStarted` deduplicates.
       */
      this.#onNotification(CODEX_NOTIFICATION.threadStarted, response);
      return threadId;
    } catch (error) {
      /*
       * "No rollout found" is the server saying the thread's history file no
       * longer exists — deleted, or never persisted in the first place. Left
       * to `#connect`'s generic catch it surfaced as a `transport` error
       * naming the wire method and a JSON-RPC code, which told the user
       * trying to send a follow-up message nothing actionable. This is a
       * fact about the request rather than the transport, and the only way
       * forward is a fresh thread — so say exactly that.
       */
      if (isMissingRollout(error)) {
        throw adapterError(
          'invalid_request',
          `Codex has no stored history for session ${resume} — its rollout file is gone, so this conversation cannot be continued. Start a new conversation.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #startTurn(session: AppServerSession, threadId: string): Promise<void> {
    const permissions = toCodexPermissions(this.#input.permissionMode, {
      cwd: this.#input.cwd,
      ...(this.#input.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: this.#input.additionalDirectories }),
    });

    if (this.#input.model !== undefined) this.#state.model = this.#input.model;

    // Images before the text, matching the Claude adapter and Codex's own
    // client: a question asked before its screenshot is answered worse.
    const { items, note } = await this.#turnInputs(this.#input.attachments);

    const response = await session.request(
      CODEX_METHOD.turnStart,
      wireParams({
        threadId,
        input: [...items, textInput(withAttachmentNote(this.#input.prompt, note))],
        cwd: this.#input.cwd,
        approvalPolicy: permissions.approvalPolicy,
        sandboxPolicy: permissions.sandboxPolicy,
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
        ...(this.#input.effort === undefined
          ? {}
          : { effort: this.#input.effort as CodexReasoningEffort }),
      }),
    );

    // `turn/started` normally supplies this, but the response carries it too and
    // arrives first often enough to matter for an immediate `send()`.
    const turnId = readString(asRecord(asRecord(response)['turn']), 'id');
    if (turnId !== undefined) this.#state.turnId ??= turnId;
  }

  #onNotification(method: string, params: JsonValue | undefined): void {
    let events: readonly AgentEvent[] = [];
    try {
      events = mapCodexNotification(method, params, this.#state);
    } catch (error) {
      // A mapping bug must degrade to a missing event, never to a dead
      // transcript. The run keeps going.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: failed to map the "${method}" notification.`,
        describe(error),
      );
      return;
    }
    for (const event of events) this.#emit(event);
  }

  /**
   * Turn a server-initiated approval request into a `permission.request`.
   *
   * The returned promise is what parks the provider: it is handed straight back
   * to the JSON-RPC layer, which does not answer the request until it settles.
   * There is no deadline, by design — an unanswered prompt parks the run until
   * the user decides, is interrupted, or is disposed. Both of the latter settle
   * every outstanding deferred, so the provider is never left waiting on a
   * promise nobody will resolve.
   */
  async #onServerRequest(request: IncomingRequest): Promise<JsonValue> {
    const kind = approvalKind(request.method);
    if (kind === undefined) {
      // Not an approval — a dynamic tool call, an MCP elicitation, something
      // newer. Declining is the only safe answer: Artemis has no UI for it, and
      // parking would hang the turn forever.
      this.#deps.diagnostic?.(`Run ${this.runId}: declining unsupported request "${request.method}".`);
      return { decision: 'decline' };
    }

    if (this.#state.ended || this.#disposing !== undefined) {
      return { decision: 'decline' };
    }

    this.#approvalCounter += 1;
    const requestId: PermissionRequestId = `${this.runId}:perm:${String(this.#approvalCounter)}`;
    const deferred = createDeferred<JsonValue>();

    const params = asRecord(request.params);
    const permissionRequest = toPermissionRequest(requestId, this.runId, kind, params, this.#deps.now());

    // A permissions request names what it wants in `params.permissions`, and
    // the eventual allow has to hand exactly that back — the UI shows the user
    // this set, so echoing it is what makes the grant match the click.
    const requestedPermissions =
      kind === 'permissions' ? (params['permissions'] as JsonValue | undefined) : undefined;

    this.#pending.set(requestId, {
      deferred,
      method: request.method,
      toolName: permissionRequest.toolName,
      ...(requestedPermissions === undefined ? {} : { requestedPermissions }),
    });

    this.#emit({
      type: 'permission.request',
      ...nextCodexEventEnvelope(this.#state),
      requestId,
      request: permissionRequest,
    });

    return deferred.promise;
  }

  /**
   * The process died.
   *
   * Distinguishes a death we caused from one we did not: during dispose the
   * teardown path owns the terminal event, so this must not race it.
   */
  #onProcessExit(reason: string): void {
    if (this.#state.ended || this.#disposing !== undefined) return;
    this.#fail({ code: 'transport', message: reason, retryable: false });
  }

  #failToLaunch(error: unknown): void {
    this.#fail(toAgentError(error, 'provider_not_found'));
  }

  /** End the run with an error, honouring the reason precedence rules. */
  #fail(error: AgentError): void {
    if (this.#state.ended) return;
    this.#denyAllPending(WITHDRAWN_DENY_MESSAGE);
    for (const event of finalizeCodexRun(this.#state, 'error', { error })) this.#emit(event);
    this.#eventQueue.close();
  }

  async #teardown(): Promise<void> {
    this.#state.disposeRequested = true;
    this.#detachAbortSignal?.();

    // 1. Unblock the provider first. A parked approval holds the turn open, and
    //    the app server will not shut down while it is waiting on one.
    this.#denyAllPending(DISPOSED_DENY_MESSAGE);

    // 2. Let the bootstrap finish so it cannot resurrect a session underneath
    //    the teardown. It swallows its own errors, so this cannot reject.
    await settleWithin(this.#bootstrap, DISPOSE_GRACE_MS);

    // 3. Ask the turn to stop, so the server can flush a clean `turn/completed`
    //    rather than being killed mid-write.
    const session = this.#session;
    const threadId = this.#state.sessionId;
    if (session !== undefined && threadId !== undefined && !this.#state.ended) {
      try {
        await withTimeout(
          session.request(CODEX_METHOD.turnInterrupt, { threadId }),
          INTERRUPT_TIMEOUT_MS,
          'interrupt timed out',
        );
      } catch {
        // Best effort. The process is coming down either way.
      }
    }

    // 4. Take the process down.
    if (session !== undefined) await session.process.dispose(DISPOSE_GRACE_MS);

    // 5. Drop the staged attachments, now that the process that read them is
    //    gone. After the process, so a turn still winding down cannot lose a
    //    file out from under itself; best-effort, because a temp directory that
    //    outlives its run is a smaller problem than a dispose that throws.
    await removeStagingDirectory(this.#stagingDir, (message) => {
      this.#deps.diagnostic?.(`Run ${this.runId}: ${message}`);
    });

    // 6. Guarantee the contract even if the server never came back at all:
    //    every open tool call closed, exactly one `run.end`, stream terminated.
    for (const event of flushCodexToolCalls(this.#state)) this.#emit(event);
    for (const event of finalizeCodexRun(this.#state, 'disposed')) this.#emit(event);
    this.#eventQueue.close();
    this.#denyAllPending(DISPOSED_DENY_MESSAGE);
  }

  /**
   * Settle every outstanding approval as a denial.
   *
   * Called from teardown, interrupt and failure. Idempotent by construction —
   * `Deferred` settles once — so overlapping paths are harmless.
   *
   * Each one is announced as `withdrawn`, not `denied`: the user was never
   * given the choice, and a transcript that recorded this as their refusal
   * would be lying about who decided. `note` says why nobody could answer.
   */
  #denyAllPending(note: string): void {
    if (this.#pending.size === 0) return;
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [requestId, entry] of entries) {
      entry.deferred.resolve(toApprovalResponse(entry.method, { behavior: 'deny' }));
      this.#emitResolved(requestId, 'withdrawn', note);
    }
  }

  /**
   * Say on the stream that a parked request is no longer parked.
   *
   * Every path that settles one goes through here — the user's answer, an
   * interrupt, a failure, dispose — because the alternative, remembering to
   * emit at each site, is the bug `PermissionResolvedEvent` exists to fix one
   * level down. Emitting after `run.end` is a no-op: `#emit` drops onto a
   * closed queue, which is the right answer for the second `#denyAllPending`
   * in `#teardown`.
   */
  #emitResolved(
    requestId: PermissionRequestId,
    outcome: PermissionResolvedEvent['outcome'],
    note?: string,
  ): void {
    this.#emit({
      type: 'permission.resolved',
      ...nextCodexEventEnvelope(this.#state),
      requestId,
      outcome,
      ...(note === undefined ? {} : { note }),
    });
  }

  #emit(event: AgentEvent): void {
    if (this.#eventQueue.closed) return;
    this.#eventQueue.push(event);
    // Nothing follows `run.end`: the stream terminates with it, which is what
    // lets a consumer's `for await` finish on its own.
    if (event.type === 'run.end') this.#eventQueue.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

type ApprovalKind = 'command' | 'fileChange' | 'permissions';

function approvalKind(method: string): ApprovalKind | undefined {
  switch (method) {
    case CODEX_SERVER_REQUEST.commandExecutionApproval:
      return 'command';
    case CODEX_SERVER_REQUEST.fileChangeApproval:
      return 'fileChange';
    case CODEX_SERVER_REQUEST.permissionsApproval:
      return 'permissions';
    default:
      return undefined;
  }
}

/** Build the prompt the UI renders, in the vocabulary of whichever request arrived. */
function toPermissionRequest(
  id: PermissionRequestId,
  runId: string,
  kind: ApprovalKind,
  params: Record<string, unknown>,
  requestedAt: number,
): PermissionRequest {
  const reason = readString(params, 'reason');
  const itemId = readString(params, 'itemId');

  const common = {
    id,
    runId,
    requestedAt,
    ...(itemId === undefined ? {} : { toolCallId: itemId as PermissionRequest['toolCallId'] }),
    ...(reason === undefined ? {} : { reason }),
  };

  if (kind === 'command') {
    const command = readString(params, 'command') ?? '';
    const cwd = readString(params, 'cwd');
    return {
      ...common,
      toolName: 'Shell',
      input: { command, ...(cwd === undefined ? {} : { cwd }) },
      displayName: 'Run command',
      title: command === '' ? 'Codex wants to run a command' : `Codex wants to run: ${command}`,
      ...(cwd === undefined ? {} : { description: `Working directory: ${cwd}` }),
    };
  }

  if (kind === 'fileChange') {
    const grantRoot = readString(params, 'grantRoot');
    return {
      ...common,
      toolName: 'ApplyPatch',
      input: grantRoot === undefined ? {} : { grantRoot },
      displayName: 'Edit files',
      title:
        grantRoot === undefined
          ? 'Codex wants to change files'
          : `Codex wants to write under ${grantRoot}`,
      ...(grantRoot === undefined ? {} : { blockedPath: grantRoot }),
    };
  }

  const permissions = params['permissions'];
  return {
    ...common,
    toolName: 'Permissions',
    input: (typeof permissions === 'object' && permissions !== null && !Array.isArray(permissions)
      ? (permissions as JsonObject)
      : {}),
    displayName: 'Grant access',
    title: 'Codex is requesting additional access',
  };
}

/**
 * Translate one Artemis decision into the vocabulary of one server request.
 *
 * The three approval requests take three *different* decision types on the
 * wire. They happen to share the `accept` / `acceptForSession` / `decline` /
 * `cancel` spelling, but command execution also accepts two structured
 * variants, and the permissions request answers with a granted subset plus a
 * scope instead of a bare decision. Assuming one shape fits all is the kind of
 * thing that works right up until the day it silently grants more than the user
 * clicked.
 *
 * `scope: 'session'` is the mapping for Artemis's `scope: 'session'` — the
 * "always allow" affordance. Anything else stays scoped to this one call.
 *
 * `requestedPermissions` is what the permissions request carried in its
 * params, verbatim. It is required to make an allow *mean* allow: the answer
 * to `item/permissions/requestApproval` is the granted set, so an allow that
 * omitted it would grant the empty set — the user clicks Allow, the server is
 * told "you may have none of it", and the denial wears the transcript's
 * approval. Artemis's prompt is all-or-nothing, so an allow grants exactly
 * what was asked and shown.
 */
export function toApprovalResponse(
  method: string,
  decision: PermissionDecision,
  requestedPermissions?: JsonValue,
): JsonValue {
  const persist =
    decision.behavior === 'allow' &&
    (decision.scope === 'session' || (decision.updatedPermissions?.length ?? 0) > 0);

  if (method === CODEX_SERVER_REQUEST.permissionsApproval) {
    // A denial grants the empty set rather than refusing to answer: the tool
    // asked which permissions it may have, and "none" is a valid answer.
    return decision.behavior === 'allow'
      ? { permissions: requestedPermissions ?? [], scope: persist ? 'session' : 'turn' }
      : { permissions: [] };
  }

  if (decision.behavior === 'deny') return { decision: 'decline' };
  return { decision: persist ? 'acceptForSession' : 'accept' };
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                           */
/* -------------------------------------------------------------------------- */

function requireThreadId(response: JsonValue): string {
  const thread = asRecord(asRecord(response)['thread']);
  const id = readString(thread, 'id') ?? readString(asRecord(response), 'threadId');
  if (id === undefined) {
    throw adapterError('transport', 'Codex did not return a thread id.');
  }
  return id;
}

/** Read `model/list` into picker options, dropping models Codex marks hidden. */
export function parseModelList(response: JsonValue): readonly ProviderModelOption[] {
  const data = asRecord(response)['data'];
  if (!Array.isArray(data)) return [];

  const models: ProviderModelOption[] = [];
  for (const raw of data) {
    const entry = asRecord(raw);
    if (entry['hidden'] === true) continue;

    const id = readString(entry, 'id') ?? readString(entry, 'model');
    if (id === undefined) continue;

    const displayName = readString(entry, 'displayName');
    const efforts = Array.isArray(entry['supportedReasoningEfforts'])
      ? (entry['supportedReasoningEfforts'] as unknown[])
          .map((level) => readString(asRecord(level), 'reasoningEffort'))
          .filter((level): level is string => level !== undefined && EFFORT_IDS.has(level))
      : undefined;

    const option: ProviderModelOption = {
      id,
      label: displayName ?? id,
      ...(displayName === undefined ? {} : { displayName }),
      note: readString(entry, 'description') ?? '',
      ...(efforts === undefined || efforts.length === 0 ? {} : { effortLevels: efforts }),
    };

    // The provider's own default leads the list — `ProviderDescriptor.models`
    // documents the first entry as what a run gets when `model` is omitted, so
    // ordering here is a contract rather than a presentation choice.
    if (entry['isDefault'] === true) models.unshift(option);
    else models.push(option);
  }

  return models;
}

/** Read `thread/list` into session summaries. */
export function parseThreadList(
  response: JsonValue,
  profileId: SessionSummary['profileId'],
  fallbackCwd: string | undefined,
): SessionSummary[] {
  const data = asRecord(response)['data'];
  if (!Array.isArray(data)) return [];

  const sessions: SessionSummary[] = [];
  for (const raw of data) {
    const thread = asRecord(raw);
    const id = readString(thread, 'id');
    if (id === undefined) continue;

    // `cwd` comes from the thread record, never from the storage path — the
    // obligation `ProviderAdapter.listAllSessions` documents. A thread with no
    // recoverable directory cannot be grouped or resumed, so it is dropped
    // rather than guessed at.
    const cwd = readString(thread, 'cwd') ?? fallbackCwd;
    if (cwd === undefined) continue;

    const name = readString(thread, 'name');
    const preview = readString(thread, 'preview');

    // Codex records the branch a thread was opened on and reports it here as
    // `gitInfo.branch` — verified live against 0.147, beside `sha` and
    // `originUrl`. The sidebar's second line reads it off the summary the same
    // way it does for Claude, so a Codex row that omits it is not a row without
    // a branch: it is a row whose branch was never asked for.
    const branch = readString(asRecord(thread['gitInfo']), 'branch');

    // Codex timestamps threads in Unix *seconds*; every Artemis timestamp is
    // milliseconds.
    const createdAt = readNumber(thread, 'createdAt');
    const updatedAt = readNumber(thread, 'updatedAt') ?? createdAt ?? 0;

    sessions.push({
      id: id as SessionId,
      providerId: CODEX_PROVIDER_ID,
      profileId,
      cwd,
      title: name ?? preview ?? 'Untitled session',
      ...(name === undefined ? {} : { titleIsCustom: true }),
      ...(preview === undefined ? {} : { firstPrompt: preview }),
      ...(branch === undefined ? {} : { gitBranch: branch }),
      updatedAt: updatedAt * 1000,
      ...(createdAt === undefined ? {} : { createdAt: createdAt * 1000 }),
    });
  }

  return sessions;
}

/**
 * Read the rate-limit windows.
 *
 * Codex reports up to two anonymous windows described by their duration rather
 * than by a name, so the label is derived from `windowDurationMins` — 43200
 * minutes is the monthly window a free plan reported during testing.
 *
 * A window five hours long *is* the 5-hour limit and one a week long *is* the
 * weekly, whatever the provider calls them, so those two take the shared ids
 * (`five_hour`, `seven_day`) and every readout draws them under the same names
 * it draws Claude's. Any other duration keeps Artemis's own `primary` /
 * `secondary`; `PlanUsageWindowId` is deliberately open-ended for that.
 */
export function parseRateLimitWindows(limits: Record<string, unknown>): PlanUsageWindow[] {
  const windows: PlanUsageWindow[] = [];

  for (const [key, id] of [
    ['primary', 'primary'],
    ['secondary', 'secondary'],
  ] as const) {
    const raw = asRecord(limits[key]);
    if (Object.keys(raw).length === 0) continue;

    const usedPercent = readNumber(raw, 'usedPercent');
    const durationMins = readNumber(raw, 'windowDurationMins');
    const resetsAt = readNumber(raw, 'resetsAt');

    windows.push({
      id: sharedWindowId(durationMins) ?? id,
      label: durationLabel(durationMins),
      utilization: usedPercent ?? null,
      // Unix seconds here, unlike the `*AtMs` fields elsewhere in the protocol.
      resetsAt: resetsAt === undefined ? null : resetsAt * 1000,
    });
  }

  return windows;
}

/** The shared id for a duration every plan meters, or `undefined` for one only Codex does. */
function sharedWindowId(minutes: number | undefined): PlanUsageWindowId | undefined {
  if (minutes === 5 * 60) return 'five_hour';
  if (minutes === 7 * 24 * 60) return 'seven_day';
  return undefined;
}

function durationLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'Plan limit';
  if (minutes % (60 * 24 * 30) === 0) {
    const months = minutes / (60 * 24 * 30);
    return months === 1 ? '30 days' : `${String(months * 30)} days`;
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? '24 hours' : `${String(days)} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  }
  return `${String(minutes)} minutes`;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

/** What the app server says about a config directory's credential. */
export interface CodexAuthStatus {
  readonly loggedIn: boolean;
  /** `chatgpt` for a subscription, `apikey` for metered billing. */
  readonly authMethod?: string;
  readonly error?: string;
}

/**
 * Ask the app server whether this profile is signed in.
 *
 * The structured alternative to `codex login status`, which prints prose — see
 * the note on {@link CODEX_CREDENTIALS}. Never throws: every caller is UI that
 * has to render something either way.
 */
export async function checkCodexAuth(options: {
  readonly env: EnvBundle;
  readonly cwd: string;
  readonly deps: CodexRunDeps;
}): Promise<CodexAuthStatus> {
  try {
    const response = await withAppServer(
      { deps: options.deps, env: options.env, cwd: options.cwd },
      async (session) => session.request(CODEX_METHOD.getAuthStatus, {}),
    );
    const status = asRecord(response);
    const authMethod = readString(status, 'authMethod');
    return {
      loggedIn: authMethod !== undefined,
      ...(authMethod === undefined ? {} : { authMethod }),
    };
  } catch (error) {
    return { loggedIn: false, error: describe(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Wrap a string as the one input shape `turn/start` and `turn/steer` accept. */
function textInput(text: string): CodexTextInput {
  // `text_elements` is required and snake_case; omitting it fails the request
  // with an error naming `type`. See the note on `CodexTextInput`.
  return { type: 'text', text, text_elements: [] };
}

/**
 * Hand a typed params object to the wire.
 *
 * `JsonValue` is defined with a `readonly [key: string]: JsonValue` index
 * signature, and a declared `interface` never satisfies one structurally —
 * TypeScript cannot prove a named type has no extra non-JSON members. Every
 * params type in `codexProtocol.ts` is JSON by construction, so the cast is
 * safe; it lives here, named and explained, rather than being sprinkled as
 * `as unknown as JsonValue` at each call site.
 */
function wireParams(value: object): JsonValue {
  return value as unknown as JsonValue;
}

/** Read `codex --version`, or `undefined` when the binary is not there. */
async function readCodexVersion(
  executable: string,
  hostEnv: EnvBundle | undefined,
): Promise<string | undefined> {
  const { spawn } = await import('node:child_process');

  return new Promise<string | undefined>((resolve) => {
    const child = spawn(executable, ['--version'], {
      env: composeProviderEnv({}, {
        ...(hostEnv === undefined ? {} : { hostEnv }),
        scrubKeys: CODEX_CREDENTIAL_ENVS,
      }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined);
    });
  });
}

function byNewestThenId(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id.localeCompare(b.id);
}

/**
 * Does this failure mean "that session does not exist"?
 *
 * Codex answers `thread/delete` for an unknown id with a generic
 * `-32600 Invalid Request` — an error code shared with genuinely malformed
 * requests, so the code alone cannot distinguish "already gone" from "broken".
 * The message can: `no rollout found for thread id …` is the server's one
 * wording for absence (verified against 0.147). Deliberately narrow — a match
 * broad enough to catch a future rephrasing would also be broad enough to
 * mislabel a real failure as a success, and of the two mistakes, a spurious
 * error message is the recoverable one.
 */
export function isMissingRollout(error: unknown): boolean {
  return /no rollout found/i.test(describe(error));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(adapterError('transport', message));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Await a promise, but give up waiting after `ms`. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof JsonRpcError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
