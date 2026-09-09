/**
 * The Claude provider adapter — the seam's reference implementation.
 *
 * This file is the plumbing; `./mapper.ts` is the meaning. Everything here is
 * about driving `@anthropic-ai/claude-agent-sdk` correctly and tearing it down
 * without leaking a subprocess.
 *
 * ## Streaming input is not optional
 *
 * `query()` accepts either a `string` prompt or an `AsyncIterable<SDKUserMessage>`.
 * Artemis must always use the iterable form, for two reasons that are easy to miss
 * from the type signature alone:
 *
 *  1. **There is no `send()` on `Query`.** Multi-turn input works by pushing
 *     more `SDKUserMessage`s into the prompt iterable. So `Run.send()` is
 *     implemented as a push onto {@link AsyncQueue}, and the iterable must stay
 *     open across the turn — a naive generator that yields the prompt and
 *     returns would close the input stream and make steering impossible.
 *  2. **Every control method requires it.** `interrupt()`, `setModel()`,
 *     `setPermissionMode()` and friends are documented as "only available in
 *     streaming input mode". Using a string prompt would silently cost us the
 *     Stop button.
 *
 * ## What a run is
 *
 * One run is **one turn cycle**: a prompt, whatever the agent does about it,
 * and the `result` message that closes it. `run.end` fires there, and the
 * caller continues the conversation by starting a *new* run with
 * `resumeSessionId` set to the id `run.end` reported. `Run.send()` steers the
 * turn that is already in flight; it is not "send the next message".
 *
 * ## Configuration isolation
 *
 * `settingSources` defaults to `[]`. Artemis is a third-party desktop app, and
 * silently merging the user's `~/.claude` configuration would import their
 * hooks, MCP servers and permission rules into an app they never granted them
 * to. Callers opt in per run. `./env.ts` does the matching job for environment
 * variables: every credential variable Claude understands is stripped from the
 * inherited environment, so the profile — and only the profile — decides which
 * account authenticates and which one is billed. See {@link CLAUDE_CREDENTIALS}
 * for the two auth modes and why an inherited `ANTHROPIC_API_KEY` is the
 * dangerous case rather than a harmless one.
 */

import { randomUUID } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  deleteSession as sdkDeleteSession,
  tagSession as sdkTagSession,
  getSessionMessages as sdkGetSessionMessages,
  getSubagentMessages as sdkGetSubagentMessages,
  listSessions as sdkListSessions,
  query,
  renameSession as sdkRenameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  McpServerConfig,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  Settings,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
/*
 * The message-content types the SDK builds `SDKUserMessage.message` out of, but
 * does not re-export: it imports them from `@anthropic-ai/sdk/resources` and
 * keeps them internal. Reached for directly, therefore, and type-only — nothing
 * here survives compilation, and the package is already in the tree as the
 * Agent SDK's own dependency.
 */
import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources';

import type {
  AgentError,
  AgentEvent,
  Attachment,
  BackgroundTask,
  Capabilities,
  JsonObject,
  MessageId,
  PermissionDecision,
  PermissionMode,
  PermissionRequestId,
  PermissionResolvedEvent,
  PlanUsage,
  ProfileId,
  ProviderEffortOption,
  ProviderId,
  ProviderModelOption,
  QuestionAnswer,
  QuestionPrompt,
  RunEndReason,
  RunId,
  RunInput,
  RunStatus,
  RunSuggestion,
  SessionDelegatedWork,
  SessionId,
  SessionSummary,
  SystemPromptSpec,
} from '@rx-artemis/protocol';
import {
  isFileAttachment,
  isImageAttachment,
  isPdf,
  NO_CAPABILITIES,
  PDF_MEDIA_TYPE,
} from '@rx-artemis/protocol';

import {
  createStagingDirectory,
  describeStagedAttachments,
  removeStagingDirectory,
  stageAttachments,
  withAttachmentNote,
} from './attachments.js';
import type { StagedAttachment } from './attachments.js';

import { checkWorkingDirectory } from '../workspace/workdir.js';
import { CLAUDE_ENV_SCRUB_KEYS, composeProviderEnv, readEnv } from './env.js';
import {
  CLAUDE_PROVIDER_ID,
  DISPOSED_DENY_MESSAGE,
  WITHDRAWN_DENY_MESSAGE,
  buildPermissionRequest,
  createClaudeMapperState,
  finalizeRun,
  mapAggregatedSessionInfo,
  mapSdkMessage,
  mapSessionInfo,
  nextEventEnvelope,
  toPermissionResult,
} from './mapper.js';
import type { ClaudeMapperState } from './mapper.js';
import { recoverSessionCwds } from './claudeSessionCwd.js';
import { findScheduledSpawns } from './claudeSessionSpawn.js';
import { mergeQueuedCommands, replayStoredSession, resolveRewindPoint } from './history.js';
import type { RewindPoint, StoredMessage } from './history.js';
import { readPlanUsage } from './planUsage.js';
import { AsyncQueue, createDeferred } from './stream.js';
import type { Deferred } from './stream.js';
import { TaskLedger } from './taskLedger.js';
import {
  SESSION_TITLE_INSTRUCTIONS,
  buildTitlePrompt,
  cleanSessionTitle,
  isDeclinedTitle,
} from './titles.js';
import {
  adapterError,
  toAgentError,
  scrubSecrets,
} from './types.js';
import type {
  AdapterAvailability,
  AggregatedSessionList,
  AllSessionsQuery,
  CommandListQuery,
  ContinuationContext,
  EnvBundle,
  InterruptResult,
  LocalPlugin,
  ModelCatalogue,
  ModelListQuery,
  PlanUsageQuery,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionDeleteQuery,
  SessionTagQuery,
  SessionListPage,
  SessionListQuery,
  SessionListScope,
  SessionMessageCountQuery,
  SessionMessagesQuery,
  SessionTitleQuery,
  SessionTitleUpdate,
  SessionTranscript,
  SubagentMessagesQuery,
  SubagentTranscript,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the Claude provider can do.
 *
 * Built by spreading `NO_CAPABILITIES` so that a capability added to the
 * protocol later defaults to "unsupported" instead of breaking the build with a
 * missing property — and, more importantly, so it defaults to the *safe* answer
 * rather than an optimistic one.
 */
export const CLAUDE_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true, // `canUseTool`
  partialMessages: true, // `includePartialMessages` + `stream_event` messages
  midRunSteering: true, // the streaming-input prompt iterable
  forkSession: true, // `Options.forkSession`
  listSessions: true, // the SDK's `listSessions({ dir })`
  subagents: true, // `parent_tool_use_id` / `agentID`
  subagentTranscripts: true, // the SDK's `getSubagentMessages(session, agentId)`
  renameSession: true, // the SDK's `renameSession(id, title)`
  deleteSession: true, // the SDK's `deleteSession(id)` — unlinks the transcript
  tagSession: true, // the SDK's `tagSession(id, tag)` — read back as `SDKSessionInfo.tag`

  permissionModes: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
  resumeSession: true, // `Options.resume`
  rewind: true, // `Options.resumeSessionAt`, resolved from the stored chain
  usageReporting: true, // `result.usage` / `result.modelUsage`
  costReporting: true, // `total_cost_usd` / `ModelUsage.costUSD`
  contextReporting: true, // `ModelUsage.contextWindow`, and prompt size on the deltas
  planUsageReporting: true, // the SDK's structured `/usage` control request
  systemPromptAppend: true, // `{ type: 'preset', preset: 'claude_code', append }`
  imageInput: true, // base64 `image` blocks in the user message's content
  fileInput: true, // staged to a granted temp directory and named in the prompt
};

/** Env var selecting an isolated Claude config — and therefore session — directory. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Env vars that authenticate the Claude CLI *without* going through the config
 * directory — and therefore the exact set Artemis has to keep unset.
 *
 * Each of these outranks the credential the config directory holds. An
 * `ANTHROPIC_API_KEY` exported in the user's shell beats the subscription their
 * profile is signed into and bills metered API usage instead; that failure is
 * silent, arrives on the bill rather than on screen, and is indistinguishable
 * from "account switching does not work".
 *
 * Artemis sets none of them, in any circumstance, and strips all of them from
 * every run's inherited environment.
 */
export const CLAUDE_CREDENTIAL_ENVS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * How a Claude profile's environment is scoped, and how it gets signed in.
 *
 * This is Claude's vocabulary and it lives with Claude's adapter. Everything
 * here is read by the Claude CLI and nothing else — `CLAUDE_CONFIG_DIR`, the
 * credential variables that would override it, and the `claude auth …` argv.
 *
 * ## One directory, one account
 *
 * `CLAUDE_CONFIG_DIR` scopes the *credential*, not merely settings. Verified on
 * macOS, same machine, same moment:
 *
 *     CLAUDE_CONFIG_DIR=<temp>  →  { loggedIn: false, authMethod: 'none' }
 *     (ambient)                 →  { loggedIn: true,  subscriptionType: 'max' }
 *
 * So a login performed with it set belongs to that directory alone, which is
 * the entire isolation mechanism: one profile, one directory, one account, one
 * history. (The official docs describe macOS credentials as living in the
 * Keychain, which reads as though a config directory could not isolate them.
 * The observed behaviour above says otherwise, and it is what this is built on.)
 *
 * ## Why Artemis emits no credential
 *
 * It used to. A profile held a pasted API key or subscription token and this
 * spec named the variable to write it into. Two things were wrong with that,
 * and neither was fixable while Artemis held the credential: the secret sat in
 * Artemis's own store, and `ANTHROPIC_API_KEY` *overrides* a subscription login,
 * so a profile meant to bill a plan could silently bill API credit instead.
 *
 * Now the CLI's own per-profile login supplies the credential and Artemis emits
 * none of the three variables that could compete with it — it only strips them.
 * A stale value in the user's shell cannot beat a good login, because there is
 * no case in which one of these variables survives into a run.
 */
export const CLAUDE_CREDENTIALS: ProviderCredentialSpec = {
  configDirVar: CLAUDE_CONFIG_DIR_ENV,
  credentialEnvKeys: [...CLAUDE_CREDENTIAL_ENVS],
  signIn: {
    executable: 'claude',
    /*
      No `--claudeai` flag, though it exists and would be equivalent.

      Subscription is the CLI's own default, and this argv is rendered into a
      command the *user* reads and runs. A flag that only restates the default
      is one more thing to explain in a line that has to survive being pasted
      into a terminal.

      `--console` is deliberately not offered. Artemis supports plan-billed
      accounts, so a mode picker with one entry is a picker that only teaches
      the user there was a decision to get wrong.
    */
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'status', '--json'],
    logoutArgs: ['auth', 'logout'],
    howTo:
      'Run this in a terminal. It opens your browser, signs in to your Claude account, and writes the credential into this profile’s config directory — nothing passes through Artemis. Artemis watches that directory and continues on its own once you are done.',
  },
};

/**
 * Claude's families, smallest first, as {@link ProviderModelOption.tier}.
 *
 * This is the one place in Artemis that is allowed to know that `haiku` is
 * smaller than `opus`, and it is here for the reason every other model fact is:
 * a family name is the provider's vocabulary. The protocol carries an ordinal
 * and no opinion; the adapter supplies the opinion.
 *
 * Families rather than models, because the tier has to survive the live
 * catalogue. That list arrives with ids this build has never seen —
 * `claude-haiku-4-6`, a snapshot, a bracketed variant — and the family is the
 * part of the id that keeps meaning what it meant. A family missing from this
 * table gets **no tier at all** rather than a guessed one: `lowestTierModel`
 * treats unknown as "do not spend on this", which is the correct answer for a
 * model nobody here can place.
 */
const CLAUDE_FAMILY_TIERS = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
  fable: 3,
} as const satisfies Readonly<Record<string, number>>;

/**
 * The tier of a Claude model id, or `undefined` for a family we do not know.
 *
 * Reads the family off the wire id by the same rules {@link shortModelName}
 * uses — strip the vendor prefix, the dated snapshot suffix and the bracketed
 * variant — because those three decorations are exactly what stands between
 * `claude-haiku-4-5-20251001` and the word `haiku`.
 */
export function claudeModelTier(id: string | undefined): number | undefined {
  if (id === undefined) return undefined;
  const family = id
    .trim()
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .split('-')[0];
  if (family === undefined) return undefined;
  return (CLAUDE_FAMILY_TIERS as Readonly<Record<string, number>>)[family];
}

/**
 * Models the picker falls back to, in display order. First entry is the default.
 *
 * **This list is a fallback, not the catalogue.** The authoritative list comes
 * off the installed CLI at runtime via {@link fetchClaudeModels}, which asks
 * the SDK's `supportedModels()` and gets back the real lineup with the
 * provider's own display names, per-model effort levels and per-model fast-mode
 * support. That is the list the UI should show.
 *
 * This exists because the fetch can fail — no binary, no credential, an offline
 * machine — and a model picker that renders empty is worse than one that
 * renders slightly stale. Everything here is therefore deliberately
 * conservative: aliases rather than dated snapshots, and capability flags set
 * only where they are structural rather than guessed. Live data overwrites all
 * of it, field by field.
 *
 * **Aliases, not dated snapshot ids.** `sonnet` resolves to whatever the
 * installed CLI considers the current Sonnet; `claude-sonnet-4-5-20250929` is
 * frozen and goes stale in a way nobody notices until a run fails. A picker
 * that has to be edited on every model release is a picker that will be wrong —
 * which is the same reasoning that makes the live fetch the primary path.
 *
 * This list is what the UI *offers*. It is not an allow-list: `RunInput.model`
 * stays open, so a user or a future settings screen can still name a specific
 * snapshot and have it passed straight through — see {@link validateRunInput},
 * which deliberately does not check it.
 */
export const CLAUDE_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'fable',
    label: 'Fable 5',
    displayName: 'Claude Fable 5',
    resolvedModel: 'claude-fable-5',
    note: 'Highest reasoning ceiling. Takes every effort level, including max.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsUltracode: true,
    adaptiveThinking: true,
    tier: CLAUDE_FAMILY_TIERS.fable,
  },
  {
    id: 'opus',
    label: 'Opus 5',
    displayName: 'Claude Opus 5',
    resolvedModel: 'claude-opus-5',
    note: 'The most capable general model. Slowest and most expensive per token.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    supportsUltracode: true,
    adaptiveThinking: true,
    tier: CLAUDE_FAMILY_TIERS.opus,
  },
  {
    id: 'sonnet',
    label: 'Sonnet 5',
    displayName: 'Claude Sonnet 5',
    resolvedModel: 'claude-sonnet-5',
    note: 'The balanced default: strong on code, much cheaper than Opus.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsUltracode: true,
    adaptiveThinking: true,
    tier: CLAUDE_FAMILY_TIERS.sonnet,
  },
  {
    id: 'haiku',
    label: 'Haiku 4.5',
    displayName: 'Claude Haiku 4.5',
    resolvedModel: 'claude-haiku-4-5-20251001',
    note: 'Fastest and cheapest. Best for small, mechanical edits.',
    tier: CLAUDE_FAMILY_TIERS.haiku,
  },
];

/** How long {@link fetchClaudeModels} waits for the CLI before giving up. */
const MODEL_FETCH_TIMEOUT_MS = 15_000;

/** What {@link fetchClaudeModels} needs in order to reach the CLI. */
export interface ClaudeModelQuery {
  /** Profile environment. Decides which account the CLI answers as. */
  readonly env: EnvBundle;
  /** An absolute directory to run in. The CLI resolves config relative to it. */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
  /** See {@link ClaudeAdapterOptions.hostEnv}. */
  readonly hostEnv?: EnvBundle;
  /** See {@link ClaudeAdapterOptions.sdkExecutablePath}. */
  readonly sdkExecutablePath?: string;
  /** Override the default timeout. Mostly for tests. */
  readonly timeoutMs?: number;
}

/**
 * Ask the installed CLI what models it actually offers.
 *
 * This is the authoritative catalogue and {@link CLAUDE_MODELS} is the
 * fallback, not the other way round. The reasoning is the same one that made
 * the picker use aliases instead of dated snapshots, taken one step further: a
 * hard-coded list is wrong the day a model ships, and no amount of diligence
 * fixes that from inside this file. The CLI already knows the answer, including
 * the things Artemis cannot infer — the provider's own display names, which
 * effort levels each model really accepts, and which support fast mode.
 *
 * ## Why this opens a query it never prompts
 *
 * `supportedModels()` is a *control request*, and the SDK only serves control
 * requests over a streaming session — there is no one-shot "describe yourself"
 * call, and `startup()`'s `WarmQuery` exposes only `query()` and `close()`.
 * So the cheapest legal path is to open a query whose prompt stream never
 * yields, ask on the control channel, and tear it down. No turn is ever
 * started, nothing is billed, and the subprocess lives for the length of one
 * round-trip.
 *
 * ## It resolves rather than throws
 *
 * Every failure path returns {@link CLAUDE_MODELS} instead of rejecting. This
 * runs on the boot path of a desktop app whose model picker must render
 * *something*: a machine with no CLI installed, no credential, or no network is
 * a machine where the user still needs to see a list and change a setting. The
 * diagnostic sink is told what went wrong; the UI is handed a usable list.
 */
export async function fetchClaudeModels(
  request: ClaudeModelQuery,
  onDiagnostic?: (message: string, detail?: unknown) => void,
): Promise<ModelCatalogue> {
  const abort = new AbortController();

  /*
   * A prompt stream that yields nothing and never returns. Returning instead
   * would close the input channel and let the CLI decide the session is over
   * before the control request lands; this parks until `abort` tears it down.
   */
  const idlePrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) {
        resolve();
        return;
      }
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();

  let sdkQuery: Query | undefined;
  try {
    const env = composeProviderEnv(request.env, {
      inheritHostEnv: request.inheritHostEnv,
      hostEnv: request.hostEnv,
      scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
    });
    env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

    sdkQuery = query({
      prompt: idlePrompt,
      options: {
        ...(request.sdkExecutablePath === undefined
          ? {}
          : { pathToClaudeCodeExecutable: request.sdkExecutablePath }),
        cwd: request.cwd,
        env,
        abortController: abort,
        // Same isolation rule as a run: no filesystem settings are inherited.
        settingSources: [],
        // Nothing is going to be displayed, so do not pay for token streaming.
        includePartialMessages: false,
      },
    });

    const infos = await withTimeout(
      sdkQuery.supportedModels(),
      request.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS,
    );

    /*
     * The CLI's own list includes a "Default (recommended)" row — an alias that
     * points at whichever model it currently prefers rather than naming one.
     * It is dropped here for the same reason Artemis's picker no longer offers a
     * "provider default": a row that names no model cannot tell the user what
     * the next run will cost or how capable it will be, and it sits at the top
     * of the list collecting the clicks of people who have not decided yet.
     * Every row Artemis shows is a real, named model.
     */
    const mapped = infos
      .map(toModelOption)
      .filter((m) => m.id.length > 0 && !isDefaultAlias(m));
    if (mapped.length === 0) {
      onDiagnostic?.('The Claude CLI reported an empty model list; using the built-in list.');
      return { models: CLAUDE_MODELS, live: false };
    }
    return { models: mapped, live: true };
  } catch (error) {
    onDiagnostic?.(`Could not read the model list from the Claude CLI: ${describe(error)}`, error);
    return { models: CLAUDE_MODELS, live: false };
  } finally {
    abort.abort();
    // `interrupt`/`return` on a query that never ran a turn can itself throw;
    // this is best-effort cleanup and must not mask the result above.
    try {
      await sdkQuery?.return?.(undefined);
    } catch {
      /* the abort above is what actually reclaims the subprocess */
    }
  }
}

/** What {@link fetchClaudeCommands} needs in order to reach the CLI. */
export interface ClaudeCommandQuery extends ClaudeModelQuery {
  /** The plugins a run started here would load. See {@link CommandListQuery}. */
  readonly plugins?: readonly LocalPlugin[];
}

/**
 * Ask the CLI which slash commands a session here would offer.
 *
 * The same manoeuvre {@link fetchClaudeModels} makes, for the same reason:
 * `supportedCommands()` is a control request, the SDK serves control requests
 * only over a streaming session, and there is no one-shot way to ask. So a
 * query is opened whose prompt stream never yields, the question is asked on the
 * control channel, and the subprocess is torn down. **No turn is started and
 * nothing is billed** — which is what makes it affordable to run whenever a
 * column settles on an account or changes directory.
 *
 * ## Why the plugins have to be passed
 *
 * The whole point of doing this before the first message is to offer the user's
 * *own* commands, and those arrive as plugins — see `contentBridge.ts`. A query
 * without them enumerates the built-ins perfectly and misses everything the user
 * installed, which would put the menu's most-wanted rows in the one state that
 * looks like a bug rather than an absence. So this takes the same plugin list
 * the run would get, and `settingSources: []` stays empty here exactly as it is
 * on a run: the answer has to describe the session Artemis would actually start,
 * not a more permissive one.
 *
 * ## It resolves rather than throws
 *
 * Every failure path returns an empty list. A machine with no CLI, no credential
 * or no network is a machine where the menu simply does not open before the
 * first message — which is precisely the behaviour this function exists to
 * improve on, so failing back to it costs nothing that was not already lost.
 */
export async function fetchClaudeCommands(
  request: ClaudeCommandQuery,
  onDiagnostic?: (message: string, detail?: unknown) => void,
): Promise<readonly string[]> {
  const abort = new AbortController();

  // Parks until `abort` tears it down, for the reason `fetchClaudeModels` gives:
  // returning would close the input channel and let the CLI decide the session
  // is over before the control request lands.
  const idlePrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) {
        resolve();
        return;
      }
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();

  let sdkQuery: Query | undefined;
  try {
    const env = composeProviderEnv(request.env, {
      inheritHostEnv: request.inheritHostEnv,
      hostEnv: request.hostEnv,
      scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
    });
    env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

    sdkQuery = query({
      prompt: idlePrompt,
      options: {
        ...(request.sdkExecutablePath === undefined
          ? {}
          : { pathToClaudeCodeExecutable: request.sdkExecutablePath }),
        cwd: request.cwd,
        env,
        abortController: abort,
        // Same isolation rule as a run — see the note above on describing the
        // session Artemis would actually start.
        settingSources: [],
        // `undefined` rather than `[]` when there are none, matching
        // `buildClaudeOptions`: an empty array still initialises the SDK's
        // plugin machinery.
        ...(request.plugins?.length
          ? { plugins: request.plugins.map(({ path }) => ({ type: 'local' as const, path })) }
          : {}),
        includePartialMessages: false,
      },
    });

    const commands = await withTimeout(
      sdkQuery.supportedCommands(),
      request.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS,
    );

    // Names only. The push carries a description and an argument hint too, and
    // the menu has nowhere to put them — see the `commands_changed` note in
    // `mapper.ts`, which drops the same fields for the same reason and should
    // stop doing so at the same time this does.
    return commands.map((command) => command.name).filter((name) => name.length > 0);
  } catch (error) {
    onDiagnostic?.(
      `Could not read the slash-command list from the Claude CLI: ${describe(error)}`,
      error,
    );
    return [];
  } finally {
    abort.abort();
    // Best-effort, and must not mask the result above: `return` on a query that
    // never ran a turn can itself throw.
    try {
      await sdkQuery?.return?.(undefined);
    } catch {
      /* the abort above is what actually reclaims the subprocess */
    }
  }
}

/**
 * Translate one SDK `ModelInfo` into the descriptor the UI builds pickers from.
 *
 * Two derivations are worth naming:
 *
 *  - **`label` strips the "Claude " prefix.** Every row would otherwise start
 *    with the same eight characters, in a status-line segment that truncates at
 *    fifteen. The full name survives on `displayName`, which is what the
 *    settings catalogue shows.
 *  - **`supportsUltracode` is derived from `xhigh`,** because that is the
 *    provider's own stated precondition ("requires an xhigh-capable model")
 *    rather than a guess. There is no dedicated flag on `ModelInfo` to read.
 */
/**
 * A short, versioned name for the picker: "Opus 5", "Sonnet 5", "Haiku 4.5".
 *
 * Derived from the wire id rather than from `displayName`, because the CLI's
 * display names are written for its own picker and are not what this one needs.
 * In practice it reports "Opus (1M context)", "Sonnet", "Haiku" — a parenthetical
 * about a context window that is now standard on every current model, and no
 * version numbers at all, so two Sonnet generations would be indistinguishable.
 * The wire id always carries the version: `claude-opus-5`, `claude-haiku-4-5`.
 *
 * Falls back to the display name when a provider publishes no resolution, since
 * a name from the provider beats one this function invented.
 */
export function shortModelName(info: ModelInfo): string {
  const wire = info.resolvedModel;
  if (wire !== undefined) {
    const parts = wire
      .replace(/^claude-/i, '')
      // Dated snapshot suffix — `claude-haiku-4-5-20251001`. It is not part of
      // the version a human says out loud.
      .replace(/-\d{8}$/, '')
      // Variant suffix — `claude-opus-5[1m]`. It marks the 1M-context variant,
      // which is the only context every current model has, so it distinguishes
      // nothing and reads as noise on a row this narrow.
      .replace(/\[[^\]]*\]$/, '')
      .split('-');
    const [family, ...version] = parts;
    if (family !== undefined && family.length > 0) {
      const named = family.charAt(0).toUpperCase() + family.slice(1);
      return version.length > 0 ? `${named} ${version.join('.')}` : named;
    }
  }
  return info.displayName.replace(/^Claude\s+/i, '').trim() || info.value;
}

/**
 * Is this row a pointer at "whatever the CLI prefers" rather than a model?
 *
 * Matched on the alias rather than the display text, because the text is the
 * CLI's to reword and `default` is the id it has to keep — anything sending
 * `model: "default"` depends on it. The display check is a second net for a
 * provider that names the concept differently without using that alias.
 */
export function isDefaultAlias(model: ProviderModelOption): boolean {
  return model.id === 'default' || /^default\b/i.test(model.displayName ?? '');
}

function toModelOption(info: ModelInfo): ProviderModelOption {
  const levels = info.supportedEffortLevels;
  return {
    id: info.value,
    label: shortModelName(info),
    displayName: info.displayName,
    resolvedModel: info.resolvedModel,
    note: info.description,
    // The resolution first: `value` may be an alias the CLI invented, while
    // `resolvedModel` always names a real model and therefore a real family.
    tier: claudeModelTier(info.resolvedModel ?? info.value),
    // `supportsEffort: false` means "takes no effort setting", which is an
    // empty array here — distinct from `undefined`, which means "every level".
    effortLevels: info.supportsEffort === false ? [] : levels ? [...levels] : undefined,
    supportsFastMode: info.supportsFastMode ?? false,
    supportsUltracode: levels?.includes('xhigh') ?? false,
    adaptiveThinking: info.supportsAdaptiveThinking ?? false,
  };
}

/**
 * Reasoning-effort levels, least to most.
 *
 * Mirrors the SDK's `EffortLevel` union, which is the authoritative list —
 * these ids go straight onto `Options.effort`.
 *
 * **No per-model `effortLevels` are declared**, and that is a decision rather
 * than an omission. Not every model accepts every level, but the provider
 * resolves that itself: the SDK documents that the active level is the one
 * chosen "after any silent downgrade for the selected model". So a level this
 * model cannot do degrades rather than failing, and inventing a per-model table
 * here would mean maintaining a second, less accurate copy of a fact the
 * provider already knows. `ProviderModelOption.effortLevels` exists for a
 * provider that rejects instead of downgrading.
 */
export const CLAUDE_EFFORT_LEVELS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Minimal thinking. Fastest, cheapest, least reliable.' },
  { id: 'medium', label: 'Medium', note: 'Moderate thinking for routine work.' },
  { id: 'high', label: 'High', note: 'Deep reasoning. The provider’s own default.' },
  { id: 'xhigh', label: 'Extra high', note: 'More thinking again, on models that offer it.' },
  { id: 'max', label: 'Max', note: 'Maximum effort. Select models only; others downgrade.' },
];

const CLAUDE_EFFORT_IDS: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS.map((e) => e.id));

/** `platform-arch` pairs the SDK ships a runtime binary for. */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

/** How long `dispose()` waits for a graceful shutdown before forcing an abort. */
const DISPOSE_GRACE_MS = 4_000;

/** How long `interrupt()` waits for the control channel before forcing an abort. */
const INTERRUPT_TIMEOUT_MS = 8_000;

/** Lines of provider stderr kept for diagnosing a failed run. */
const STDERR_TAIL_LINES = 20;

/**
 * How long a naming call gets before it is abandoned.
 *
 * Generous for what it is — the smallest model answering six words takes a
 * second or two — because the cost of waiting is nothing (it runs beside a real
 * run, and nothing is blocked on it) while the cost of a premature give-up is a
 * session that stays unnamed. It exists so a wedged subprocess cannot sit there
 * forever, not to keep the feature snappy.
 */
const TITLE_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link createClaudeAdapter}. */
export interface ClaudeAdapterOptions {
  /** Injectable clock, used for every `ts` and every duration. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The environment to inherit from. Defaults to `process.env`. Injectable so a
   * test can prove the scrub list works without touching the real environment.
   */
  readonly hostEnv?: EnvBundle;
  /**
   * Sink for things worth knowing but not worth surfacing to the user: a
   * message the mapper choked on, a permission update that could not be
   * forwarded. Never called with a secret — everything is scrubbed first.
   */
  readonly onDiagnostic?: (message: string, detail?: unknown) => void;
  /**
   * Real-filesystem path to the SDK's bundled CLI binary, when the host knows
   * the SDK's own resolution would be wrong.
   *
   * The one host that knows is Electron: modules packed into `app.asar` see
   * virtual `__dirname`s, and `child_process.spawn` is deliberately not
   * patched to translate them — so the SDK computing a sibling-package path
   * for its binary produces `spawn ENOTDIR` against the archive file. The
   * composition root that lives in Electron resolves the `app.asar.unpacked`
   * path and injects it here; every other host leaves this unset and the SDK
   * resolves itself.
   */
  readonly sdkExecutablePath?: string;
  /**
   * A turn started that nobody asked for — adopt it, or it goes unseen.
   *
   * The provider takes a turn of its own when background work settles, and a
   * subagent left running can park on a permission prompt whose own turn ended
   * long ago. Both arrive with no run to carry them.
   *
   * The host is what can register a run: ids and the event fan-out belong to the
   * registry. Wire this to it and the turn appears in the conversation it came
   * from; leave it out and the process still keeps the work alive but has nowhere
   * to report it, which is what a smoke script or a test wants and is also why a
   * permission prompt in that state is denied rather than parked — see
   * `ClaudeProcess.#ensureTurn`.
   */
  readonly onContinuation?: (run: Run, context: ContinuationContext) => void;
  /** Ids for those turns. Defaults to `randomUUID`; injected by tests. */
  readonly newRunId?: () => RunId;
  /**
   * Extra MCP servers to give a run's agent, built per run by the host.
   *
   * The seam that lets Artemis hand the agent tools it could not define here.
   * `packages/core` must never import `electron` — see `no-electron.test.ts` —
   * so a tool that drives a `WebContentsView` cannot live in this package at
   * all. What lives here is the shape of the hole: the composition root in
   * `apps/desktop/main` builds an in-process MCP server whose handlers close
   * over the browser host, and this forwards it into the SDK's `mcpServers`.
   *
   * Per **run**, not per adapter, because that is what makes an agent's tools
   * act on *its own* conversation's browser rather than on whichever page
   * happened to be open. The factory closes over the run id; nothing about the
   * targeting travels through the model.
   *
   * The run input rides along because *which* tools a run should get is the
   * input's to say: a run browsing with the user's own Chrome
   * ({@link RunInput.chromeBrowser}) must not also carry the embedded browser,
   * and one that prefers the user's browser ({@link RunInput.externalBrowser})
   * gets an open-only surface. The factory decides; this only delivers the
   * facts it decides with.
   *
   * Absent — the default, and what a smoke script or a test gets — means the
   * agent has no such tools, and every other capability is unchanged.
   */
  readonly agentToolServers?: (
    runId: RunId,
    input: RunInput,
  ) => Record<string, McpServerConfig> | undefined;
  /**
   * The provider's predicted next user prompt, for the turn that just ended.
   *
   * A callback rather than an event because of when it exists: the SDK
   * generates the prediction *after* the turn's `result`, and by then the
   * run's stream has already carried its `run.end` and closed. Wiring this is
   * also the opt-in — when it is absent the SDK is never asked to predict and
   * the process is released at the turn boundary exactly as before.
   *
   * At most one call per turn, and none at all for turns the provider skips
   * (the first turn of a fresh conversation, plan mode, error endings). The
   * text is the prediction verbatim: prose for a composer, never a command to
   * execute.
   */
  readonly onSuggestion?: (suggestion: RunSuggestion) => void;
}

/**
 * Create the Claude adapter.
 *
 * The adapter holds one thing now: the processes that outlived the turn that
 * spawned them, by conversation. Everything else per-run still lives on the
 * {@link Run} objects it returns.
 */
export function createClaudeAdapter(options?: ClaudeAdapterOptions): ProviderAdapter {
  const now = options?.now ?? Date.now;
  const hostEnv = options?.hostEnv;
  const diagnostic = options?.onDiagnostic;
  // Spread at every `query()` call: absent entirely unless the host injected
  // a path, so the SDK's own resolution stays untouched everywhere else.
  const sdkExecutable =
    options?.sdkExecutablePath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.sdkExecutablePath };

  /*
   * Sign-in reaches the same binary the runs do.
   *
   * `CLAUDE_CREDENTIALS` names the executable `claude`, which is right for a
   * developer running from source and wrong for every packaged install: runs
   * go through the SDK's bundled CLI, so Artemis works perfectly well on a
   * machine that has no `claude` on `PATH` — right up until the profile screen
   * hands the user a command naming one, and polls for a binary that is not
   * there. The login is then unrunnable *and* undetectable, and the sign-in
   * step waits forever on a login the user may already have completed.
   *
   * Injecting the resolved path into the spec fixes both halves at once, since
   * `signInCommand` and `checkAuthStatus` read the executable from here. It is
   * also the stronger guarantee: the credential is written by the very binary
   * that will later be asked to use it, so the two can never disagree about
   * the format they are writing and reading.
   *
   * Unset in dev, where the SDK resolves itself and `claude` on `PATH` is both
   * correct and what a developer expects to see in the generated line.
   */
  const credentials =
    options?.sdkExecutablePath === undefined
      ? CLAUDE_CREDENTIALS
      : {
          ...CLAUDE_CREDENTIALS,
          signIn: { ...CLAUDE_CREDENTIALS.signIn, executable: options.sdkExecutablePath },
        };

  /**
   * Processes that outlived the turn that spawned them, by the conversation they
   * are writing to.
   *
   * Keyed on the session id alone, with the store and directory checked by
   * `canServe` before anything is served: a session id is already unique across
   * both — it is minted per conversation and resolves under exactly one config
   * directory — so keying on a composite would be spelling out a uniqueness the
   * id already has, and would need the id anyway to look anything up.
   *
   * Bounded by the retention rule rather than by a cap: an entry exists only
   * while its process holds live work or a registered schedule, and disappears
   * the moment the transport goes — see `onClosed`. A conversation the user drops
   * disposes its run, which closes the process, which empties the entry.
   */
  const live = new Map<SessionId, ClaudeProcess>();

  /**
   * Which sessions are scheduler firings, learned once per session.
   *
   * A verdict is a fact about a transcript's opening record, which is written
   * once and never rewritten — so this never invalidates, and the first
   * listing after launch is the only one that reads a whole store. Keyed on
   * the session id alone for the same reason {@link live} is: the id is minted
   * per conversation, and the one way a second store can hold the same id is a
   * copied transcript, whose head — and therefore verdict — is identical.
   */
  const scheduledSpawnVerdicts = new Map<string, boolean>();

  /**
   * Stamp `spawnedBy` onto every summary whose transcript the scheduler
   * opened. In place, index by index, because both listings have already
   * pushed their summaries into an accumulating array by the time the whole
   * batch is known.
   */
  const stampScheduledSpawns = async (
    summaries: SessionSummary[],
    configDir: string | undefined,
    from = 0,
  ): Promise<void> => {
    const candidates = summaries.slice(from);
    if (candidates.length === 0) return;
    const spawned = await findScheduledSpawns({
      configDir,
      sessions: candidates.map((summary) => ({ id: summary.id, cwd: summary.cwd })),
      cache: scheduledSpawnVerdicts,
    });
    if (spawned.size === 0) return;
    for (let index = from; index < summaries.length; index += 1) {
      const summary = summaries[index];
      if (summary !== undefined && spawned.has(summary.id)) {
        summaries[index] = { ...summary, spawnedBy: 'scheduled-task' };
      }
    }
  };

  return {
    id: CLAUDE_PROVIDER_ID,
    label: 'Claude',
    capabilities: CLAUDE_CAPABILITIES,
    credentials,
    models: CLAUDE_MODELS,
    effortLevels: CLAUDE_EFFORT_LEVELS,

    /*
     * The live counterpart to `models` above. Present because Claude *can*
     * enumerate itself; see `fetchClaudeModels` for why it opens a query it
     * never prompts, and `ProviderAdapter.listModels` for the two obligations
     * it is meeting (no model tokens, and resolve rather than reject).
     *
     * The adapter's own diagnostic sink is passed through, so a machine that
     * cannot reach the CLI leaves a trace explaining why the picker is showing
     * the built-in list — without that, a silent fallback is indistinguishable
     * from a working fetch that happens to agree with it.
     */
    async listModels(query: ModelListQuery): Promise<ModelCatalogue> {
      return fetchClaudeModels(
        {
          env: query.env,
          cwd: query.cwd,
          inheritHostEnv: query.inheritHostEnv,
          hostEnv,
          ...(options?.sdkExecutablePath === undefined
            ? {}
            : { sdkExecutablePath: options.sdkExecutablePath }),
        },
        diagnostic,
      );
    },

    /*
     * What the composer's menu offers before there is a run to ask.
     *
     * Same shape as `listModels` above and the same two obligations; see
     * `fetchClaudeCommands` for why it opens a query it never prompts, and why
     * it has to be handed the plugins rather than working them out.
     */
    async listCommands(query: CommandListQuery): Promise<readonly string[]> {
      return fetchClaudeCommands(
        {
          env: query.env,
          cwd: query.cwd,
          inheritHostEnv: query.inheritHostEnv,
          hostEnv,
          ...(query.plugins === undefined ? {} : { plugins: query.plugins }),
          ...(options?.sdkExecutablePath === undefined
            ? {}
            : { sdkExecutablePath: options.sdkExecutablePath }),
        },
        diagnostic,
      );
    },

    /**
     * Which conversations still have background work in them, right now.
     *
     * Read straight off the process pool, which is the only place the answer
     * exists: a process is kept past its turn precisely when it is holding a
     * backgrounded subagent, a workflow or a registered schedule, and
     * {@link ClaudeProcess.holdsWork} is that decision.
     *
     * Why a window needs to be told rather than working it out: `background.tasks`
     * is run-scoped and is not emitted once the turn has ended, so a window's
     * delegated rows stop being updated at exactly the moment the work outlives
     * the turn that launched it. Everything a window then decides from those rows
     * — whether the sidebar marks the session, whether the column may be
     * destroyed — is a guess about the interval it cannot see into. This closes
     * that interval.
     *
     * Synchronous and allocation-light: it walks a map that holds one entry per
     * conversation with a live process, and it is polled.
     */
    sessionsHoldingWork(): readonly SessionId[] {
      const holding: SessionId[] = [];
      for (const [sessionId, process] of live) {
        if (!process.closed && process.holdsWork) holding.push(sessionId);
      }
      return holding;
    },

    /**
     * The narrower set: conversations with something running *now*.
     *
     * `holdsWork` includes the registered-schedule bit, which is set forever —
     * the adapter cannot know when a wakeup fires, so retention keeps the
     * process on the honest reading of "we do not know". Reporting that same
     * bit as *working* put a permanent spinner on every conversation that ever
     * ran a `/loop`, however idle it sat between wakeups. This reads the
     * process's actual activity instead: an open turn, live tasks, or the
     * settle beat.
     */
    sessionsWorking(): readonly SessionId[] {
      const working: SessionId[] = [];
      for (const [sessionId, process] of live) {
        if (!process.closed && process.working) working.push(sessionId);
      }
      return working;
    },

    /**
     * The same pool, read for its rows rather than its verdict.
     *
     * Conversations with no rows are left out entirely rather than reported
     * empty. An empty array on the wire is a claim — "this conversation has
     * delegated nothing" — and the caller uses these to *restore* rows a reload
     * destroyed, so a claim it cannot support would clear a list rather than
     * decline to refill it.
     */
    delegatedWork(): readonly SessionDelegatedWork[] {
      const work: SessionDelegatedWork[] = [];
      for (const [sessionId, process] of live) {
        if (process.closed) continue;
        const tasks = process.tasks;
        if (tasks.length > 0) work.push({ sessionId, tasks });
      }
      return work;
    },

    async createRun(input: ResolvedRunInput): Promise<Run> {
      validateRunInput(input);

      /*
       * Is a process for this conversation already running?
       *
       * It is whenever the previous turn left work behind — a backgrounded
       * subagent, a workflow, a registered schedule — because the pump now keeps
       * the transport for exactly that case. Attaching is not an optimisation
       * here; it is what stops there being *two* CLIs on one conversation, both
       * appending to the same `projects/…/<id>.jsonl` with the second resuming a
       * file the first is still writing.
       *
       * It is also the better outcome by a distance: the conversation is already
       * in the process's context, so nothing re-reads a transcript that only
       * grows, and the model's own prompt cache is still warm.
       */
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);
      let alive = input.resumeSessionId === undefined ? undefined : live.get(input.resumeSessionId);

      /*
       * A rewind never attaches, and never coexists with a live process.
       *
       * Attaching would hand the truncation request to a CLI whose context
       * already contains the turns being wound back — silently ignored at
       * best. And starting a *second* CLI against a file the first is still
       * appending to is the exact clobber the pool exists to prevent.
       *
       * But "there is a process" is not "there is work". The pool retains a
       * process for grace windows too — a settling task's follow-up turn, a
       * prediction still being generated — and a conversation in one of those
       * is idle in every sense the user can see. Refusing those made the
       * control fail for the length of a timer nobody knew was running. So:
       * work in flight refuses and says why; a merely-retained process is
       * closed and the rewind spawns fresh against a file no one is writing.
       */
      let rewind: RewindPoint | undefined;
      if (input.rewindToMessageId !== undefined && input.resumeSessionId !== undefined) {
        if (alive !== undefined) {
          if (alive.busyWithWork) {
            throw adapterError(
              'invalid_request',
              'This conversation still has work running — stop it before rewinding.',
            );
          }
          alive.release();
          // Not attachable from here on, whatever `canServe` would say — the
          // transport is going down, and its pump may not have noticed yet.
          alive = undefined;
        }
        let stored;
        try {
          stored = await withClaudeConfigDir(
            configDir,
            () => sdkGetSessionMessages(input.resumeSessionId as string, { dir: input.cwd }),
            'rewind read',
          );
        } catch (error) {
          throw adapterError('unknown', `Could not read the session to rewind it: ${describe(error)}`, {
            cause: error,
          });
        }
        const point = resolveRewindPoint(stored as unknown as readonly StoredMessage[], input.rewindToMessageId);
        if (point === null) {
          throw adapterError(
            'invalid_request',
            'That message is not in the stored conversation, or nothing comes before it — a rewind to the very beginning is a new session.',
          );
        }
        rewind = point;
      }

      /*
       * A hand-off resume — same conversation, different store — never
       * attaches: `canServe` refuses the config-dir mismatch below and the
       * fresh spawn resumes the transcript under the new account. But the
       * *source* process is still holding that transcript, and left alive it
       * would go on appending — a settling task's follow-up turn, a scheduled
       * wakeup — underneath the CLI that now owns the file. Two writers, one
       * JSONL: the exact clobber the pool exists to prevent, arriving through
       * the other door.
       *
       * The rewind above is the precedent, applied one notch more cautiously:
       * an open turn or real work refuses and says why — the caller stops it
       * first, which is what the renderer's hand-off gate already enforces —
       * while a merely-retained process (grace timers, a prediction still
       * cooking) is released, and the resume spawns fresh against a file
       * nobody is writing.
       */
      if (
        alive !== undefined &&
        input.resumeSessionId !== undefined &&
        !alive.sharesStore(configDir)
      ) {
        if (alive.midTurn || alive.busyWithWork) {
          throw adapterError(
            'invalid_request',
            'This conversation still has work running under the account it started on — stop that work before handing it off.',
          );
        }
        alive.release();
        // Not attachable from here on, whatever `canServe` would say — the
        // transport is going down, and its pump may not have noticed yet.
        alive = undefined;
      }

      /*
       * The same release, for the other turn a live process cannot take: one
       * asking for `bypassPermissions` of a process spawned without the opt-in.
       * `canServe` would refuse it and the fresh spawn would resume the file
       * — but the retained process would still be holding it, exactly the
       * two-writers state the block above exists to prevent, reached through a
       * third door. So it is released first, on the same terms: a process
       * merely retained goes quietly; one mid-turn or holding work refuses and
       * says why, because a release there destroys what retention protects.
       */
      if (alive !== undefined && alive.needsFreshSpawnFor(input)) {
        if (alive.midTurn || alive.busyWithWork) {
          throw adapterError(
            'invalid_request',
            'This conversation still has work running — stop it before switching it to bypass permissions, which needs a fresh process.',
          );
        }
        alive.release();
        alive = undefined;
      }

      if (alive !== undefined && alive.canServe(input, configDir)) {
        diagnostic?.(
          `Run ${input.runId}: continuing on the process already serving session ${input.resumeSessionId ?? '—'}.`,
        );
        return alive.continueWith(input);
      }

      /*
       * The staging directory is created for *every* run, attachments or not.
       *
       * It has to exist before `start()`, because the only way to tell the SDK
       * a directory is readable is `Options.additionalDirectories`, and options
       * are built once when the query opens. A directory created later — when
       * the user attaches a file to a mid-run steer — would be one the agent is
       * not allowed to open, and the failure would be the agent reporting that
       * a file the user can see in the transcript does not exist.
       *
       * So it is created up front and granted up front. An empty temp directory
       * that Artemis owns widens nothing, and one `mkdtemp` is not a cost worth
       * making a mid-run attachment fail over.
       */
      const directory = await createStagingDirectory();

      try {
        const staged = await stageAttachments(
          directory,
          (input.attachments ?? []).filter(isFileAttachment),
        );

        const granted: ResolvedRunInput = {
          ...input,
          additionalDirectories: [...(input.additionalDirectories ?? []), directory],
        };

        const agent = new ClaudeProcess(
          granted,
          {
            now,
            hostEnv,
            diagnostic,
            ...(rewind === undefined ? {} : { rewind }),
            ...(options?.sdkExecutablePath === undefined
              ? {}
              : { sdkExecutablePath: options.sdkExecutablePath }),
            ...(options?.agentToolServers === undefined
              ? {}
              : { agentToolServers: options.agentToolServers }),
            // The pool is keyed on the one fact the process discovers rather
            // than is given. A stale entry is worse than none — it would attach
            // the next message to a CLI that has stopped reading — so the
            // removal is unconditional and the entry is only replaced by
            // identity.
            ...(options?.onContinuation === undefined
              ? {}
              : { onContinuation: options.onContinuation }),
            ...(options?.onSuggestion === undefined
              ? {}
              : { onSuggestion: options.onSuggestion }),
            newRunId: options?.newRunId ?? (() => randomUUID() as RunId),
            onSession: (sessionId, process) => live.set(sessionId, process),
            onClosed: (process) => {
              const sessionId = process.sessionId;
              if (sessionId !== undefined && live.get(sessionId) === process) {
                live.delete(sessionId);
              }
            },
          },
          { directory, staged },
        );
        // The turn before the transport: `canUseTool` and the pump both read the
        // active turn, and `start()` is what lets either of them run.
        const turn = agent.beginTurn(granted);
        agent.start();
        return turn;
      } catch (error) {
        // Nothing owns the directory yet — the run that would have removed it
        // was never constructed.
        await removeStagingDirectory(directory);
        throw error;
      }
    },

    async listSessions(request: SessionListQuery): Promise<SessionListPage> {
      const offset = request.offset ?? 0;
      const limit = request.limit;
      const configDir = readEnv(request.env, CLAUDE_CONFIG_DIR_ENV);

      let infos;
      try {
        infos = await withClaudeConfigDir(
          configDir,
          () =>
            sdkListSessions({
              dir: request.cwd,
              // Over-fetch by one so `hasMore` is a fact rather than a guess: the
              // SDK returns a bare array with no total.
              limit: limit === undefined ? undefined : limit + 1,
              offset,
            }),
          'listSessions',
        );
      } catch (error) {
        throw adapterError('unknown', `Could not read Claude session history: ${describe(error)}`, {
          cause: error,
        });
      }

      const hasMore = limit !== undefined && infos.length > limit;
      const page = limit === undefined ? infos : infos.slice(0, limit);

      const sessions = page.map((info) =>
        mapSessionInfo(info, { profileId: request.profileId, fallbackCwd: request.cwd }),
      );
      await stampScheduledSpawns(sessions, configDir);

      return { sessions, hasMore };
    },

    /**
     * Every session in every project, for every profile asked about.
     *
     * ## How this is only one SDK call per profile
     *
     * `listSessions({ dir })` scopes to one project. Omitting `dir` makes the
     * SDK walk `$CLAUDE_CONFIG_DIR/projects/*` itself and return everything —
     * which is exactly the enumeration this needs, and it reads each session's
     * `cwd` out of the transcript rather than from the directory name. That
     * matters: the directory name is a lossy encoding of the path (every
     * non-alphanumeric character becomes `-`), so reconstructing a cwd from it
     * would be a guess. One such call per *store* covers the whole
     * (profile × project) space.
     *
     * ## Per store, not per profile
     *
     * This read used to be per profile, on the reasoning that a profile's
     * config directory is its own store, so a session's profile falls out of
     * which directory it was found in and no bookkeeping is needed anywhere.
     * That holds right up until two profiles resolve to one store — two naming
     * the same `configDir`, or a `projects/` symlinked between them to share
     * history across accounts — and then it fails in the most visible way
     * available: each profile enumerates the same transcripts, every
     * conversation comes back once per profile, and the sidebar lists it that
     * many times under that many account labels.
     *
     * So scopes are grouped by the store they actually read — `realpath` of the
     * directory the SDK walks — and each store is read once. The first profile
     * in a group owns the resulting summaries and the rest ride along in
     * `alsoInProfiles`, which is what lets a caller resume under an account the
     * user is already using instead of switching them to whichever profile
     * happened to sort first.
     *
     * Reading once per store rather than once per profile is also simply less
     * work; the correctness is the reason, but the saving is real.
     *
     * ## Read-only, and credential-free
     *
     * Only `CLAUDE_CONFIG_DIR` is read out of each scope's env. Callers build
     * those with `resolveStoreEnv`, which emits that one variable and no
     * secret, so a profile that has never had a key stored still lists its
     * history.
     *
     * ## One bad profile cannot blank the sidebar
     *
     * Each profile is read inside its own `try`. A missing, unreadable or empty
     * config directory contributes nothing and is reported in
     * `unreadableProfiles`; the rest of the profiles still answer.
     */
    async listAllSessions(request: AllSessionsQuery): Promise<AggregatedSessionList> {
      const sessions: SessionSummary[] = [];
      const unreadableProfiles: ProfileId[] = [];
      let droppedWithoutCwd = 0;
      let recoveredWithoutCwd = 0;

      for (const group of await groupByStore(request.profiles)) {
        const owner = group.scopes[0];
        if (owner === undefined) continue;

        let infos;
        try {
          // No `dir`, no `limit`, no `offset`: everything this store has.
          // Pagination belongs to whoever merges across profiles — slicing here
          // would drop one profile's older sessions in favour of another's
          // newer ones before they were ever compared.
          infos = await withClaudeConfigDir(
            group.configDir,
            () => sdkListSessions({}),
            'listAllSessions',
          );
        } catch (error) {
          // Every profile in the group, not just the first: they were grouped
          // because they read one store, so one store failing fails all of
          // them, and reporting only the owner would leave the others looking
          // like they had simply contributed nothing.
          for (const scope of group.scopes) unreadableProfiles.push(scope.profileId);
          diagnostic?.(
            `Could not read session history for ${group.scopes.length === 1 ? `profile ${owner.profileId}` : `profiles ${group.scopes.map((s) => s.profileId).join(', ')}`}.`,
            describe(error),
          );
          continue;
        }

        const alsoInProfiles = group.scopes.slice(1).map((scope) => scope.profileId);
        /*
         * Both fields are omitted rather than set empty or false in the
         * ordinary case, so "shared" is legible in a payload at a glance and
         * every existing consumer sees exactly the shape it saw before.
         *
         * `profileIsUnknown` travels with `alsoInProfiles` because it is the
         * same fact stated from the reader's side. The owner is `scopes[0]`: a
         * pick made so that repeated reads agree, carrying no claim about who
         * ran anything. Nothing in this store can turn it into a claim — the
         * transcript records no account — so the adapter says so rather than
         * letting a sidebar render the pick as an answer and label every shared
         * row with the same arbitrary profile. Only the host's own ledger of
         * runs it started can settle it, and the host clears this when it does.
         */
        const own = (summary: SessionSummary): SessionSummary =>
          alsoInProfiles.length === 0
            ? summary
            : { ...summary, alsoInProfiles, profileIsUnknown: true };

        const withoutCwd: SDKSessionInfo[] = [];
        // Where this store's summaries begin, for the classification pass
        // below — everything pushed from here on belongs to this group.
        const groupStart = sessions.length;

        for (const info of infos) {
          const summary = mapAggregatedSessionInfo(info, { profileId: owner.profileId });
          if (summary === null) {
            withoutCwd.push(info);
            continue;
          }
          sessions.push(own(summary));
        }

        /*
         * The sessions the SDK could not name a directory for.
         *
         * Dropping them is what made a conversation disappear from the sidebar
         * with its transcript intact on disk — the worst available outcome,
         * because it reads as data loss. The directory is in the file; see
         * `claudeSessionCwd.ts` for which sessions the SDK loses it for and why
         * reading it back is authoritative rather than a guess.
         *
         * A second pass, so the ordinary path is untouched: a store whose
         * sessions all report a cwd never opens a file here.
         */
        if (withoutCwd.length > 0) {
          const recovered = await recoverSessionCwds({
            configDir: group.configDir,
            sessionIds: withoutCwd.map((info) => info.sessionId),
          });

          for (const info of withoutCwd) {
            const cwd = recovered.get(info.sessionId);
            if (cwd === undefined) {
              droppedWithoutCwd += 1;
              continue;
            }
            // The recovered directory plays exactly the role a scoped listing's
            // `dir` plays, which is why this is the per-project mapper rather
            // than a third code path.
            sessions.push(own(mapSessionInfo(info, { profileId: owner.profileId, fallbackCwd: cwd })));
            recoveredWithoutCwd += 1;
          }
        }

        /*
         * Third pass: which of this store's sessions did the scheduler open?
         *
         * After the recovery pass so that recovered rows are classified too,
         * and per group rather than at the end so the read uses the config
         * directory the sessions actually came from. The first listing after
         * launch reads every transcript's head once; every listing after that
         * touches only sessions the cache has not met — see
         * `claudeSessionSpawn.ts` for why a verdict never goes stale.
         */
        await stampScheduledSpawns(sessions, group.configDir, groupStart);
      }

      if (recoveredWithoutCwd > 0) {
        diagnostic?.(
          `Read the working directory out of the transcript for ${String(recoveredWithoutCwd)} session(s) the provider reported without one.`,
        );
      }
      if (droppedWithoutCwd > 0) {
        diagnostic?.(
          `Skipped ${String(droppedWithoutCwd)} session(s) whose working directory could not be read from the transcript.`,
        );
      }

      sessions.sort(byNewestThenId);
      return { sessions, unreadableProfiles };
    },

    async checkAvailability(): Promise<AdapterAvailability> {
      const key = `${process.platform}-${process.arch}`;
      if (!SUPPORTED_PLATFORMS.has(key)) {
        return {
          available: false,
          unavailableReason: `Claude does not ship a runtime for ${key}.`,
        };
      }
      return { available: true };
    },

    /**
     * Count without mapping.
     *
     * The same read `getSessionMessages` does — the SDK gives no cheaper way to
     * ask "how many?" — but it stops at `.length` instead of turning every
     * stored record into events, which is where the cost of the read actually
     * is. Runs on the path of starting a resumed run, so what it skips matters:
     * a long conversation is a file read and a JSON parse, not a transcript
     * rebuild.
     *
     * Throws on a failed read rather than answering `0`, because the caller
     * has to be able to tell "this session is empty" from "I could not look".
     * A zero it invented would make a reloading window replay the whole
     * conversation twice.
     */
    async countSessionMessages(input: SessionMessageCountQuery): Promise<number> {
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);
      try {
        const stored = await withClaudeConfigDir(
          configDir,
          () =>
            sdkGetSessionMessages(input.sessionId, {
              ...(input.cwd === undefined ? {} : { dir: input.cwd }),
            }),
          'countSessionMessages',
        );
        return stored.length;
      } catch (error) {
        throw adapterError('unknown', `Could not read that session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async getSessionMessages(input: SessionMessagesQuery): Promise<SessionTranscript> {
      /*
        `limit + 1` is how "is there more?" gets answered without a second
        call: the SDK reports no total, so the only way to know a page is not
        the last one is to ask for one row past it and throw that row away.
      */
      const limit = input.limit;

      /*
        The SDK reads `CLAUDE_CONFIG_DIR` from `process.env` — it takes no env
        option — so the profile's store is selected by swapping that variable
        around the call, exactly as `listSessions` does. `withClaudeConfigDir`
        serialises those swaps; without it two profiles read each other's
        history.
      */
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);

      let stored;
      try {
        stored = await withClaudeConfigDir(
          configDir,
          () =>
            sdkGetSessionMessages(input.sessionId, {
              ...(input.cwd === undefined ? {} : { dir: input.cwd }),
              ...(limit === undefined ? {} : { limit: limit + 1 }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
            }),
          'getSessionMessages',
        );
      } catch (error) {
        throw adapterError('unknown', `Could not read that session: ${describe(error)}`, {
          cause: error,
        });
      }

      const hasMore = limit !== undefined && stored.length > limit;
      const page = hasMore ? stored.slice(0, limit) : stored;

      /*
       * The messages the person sent mid-turn, which the SDK's read leaves
       * out: the CLI files each as a `queued_command` attachment record, not
       * as a user turn, and `getSessionMessages` returns user and assistant
       * records only. Read off the transcript file and merged by time. Best
       * effort — a transcript that cannot be found replays as it always did,
       * without them.
       */
      const queued = await readQueuedCommands(configDir, input.cwd, input.sessionId).catch(
        () => [] as StoredMessage[],
      );
      const merged = mergeQueuedCommands(page as unknown as readonly StoredMessage[], queued, {
        first: (input.offset ?? 0) === 0,
        last: !hasMore,
      });

      let seq = 0;
      const events = replayStoredSession(merged, {
        runId: input.runId,
        sessionId: input.sessionId,
        ts: now(),
        next: () => seq++,
      });

      return { events, hasMore };
    },

    /**
     * Read one subagent's own conversation.
     *
     * The same three moves as `getSessionMessages` — swap the config directory
     * around the call, page with `limit + 1`, replay the page through the
     * shared mapper — against a different file. The SDK resolves that file from
     * the agent id alone, including the nested
     * `subagents/workflows/<run>/agent-<id>.jsonl` a workflow's agents write
     * to, so a workflow agent and a plain `Agent` call are one code path here.
     *
     * **An empty read is not an error.** A subagent that has been spawned but
     * has not yet written its first message has no file, and the SDK answers
     * with an empty array rather than throwing. That is the ordinary state of a
     * row the user clicked the instant it appeared, and it has to render as an
     * empty conversation that fills in — which is what the poll behind it is
     * for — rather than as a failure.
     */
    async getSubagentMessages(input: SubagentMessagesQuery): Promise<SubagentTranscript> {
      const limit = input.limit;
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);

      let stored;
      try {
        stored = await withClaudeConfigDir(
          configDir,
          () =>
            sdkGetSubagentMessages(input.sessionId, input.agentId, {
              ...(input.cwd === undefined ? {} : { dir: input.cwd }),
              ...(limit === undefined ? {} : { limit: limit + 1 }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
            }),
          'getSubagentMessages',
        );
      } catch (error) {
        throw adapterError('unknown', `Could not read that agent: ${describe(error)}`, {
          cause: error,
        });
      }

      const hasMore = limit !== undefined && stored.length > limit;
      const page = hasMore ? stored.slice(0, limit) : stored;

      let seq = 0;
      const events = replayStoredSession(page as unknown as readonly StoredMessage[], {
        runId: input.runId,
        sessionId: input.sessionId,
        ts: now(),
        next: () => seq++,
      });

      // Counted in stored messages, not events — see `SubagentTranscript`.
      return { events, hasMore, consumed: page.length };
    },

    /**
     * Name a conversation from its opening message.
     *
     * A one-shot completion with everything a run has switched off, and each
     * switch is load-bearing rather than tidy:
     *
     *  - **`persistSession: false`** — without it this call writes a session
     *      file of its own, and a feature whose entire job is to label the
     *      history pane would put a junk row in it on every new conversation.
     *      This is the option the whole approach depends on.
     *  - **`tools: []`** — the restriction knob (see `buildOptions` for why it
     *      is `tools` and not `allowedTools`). A naming call that could reach
     *      Bash is a naming call that can be talked into using it by the very
     *      text it was asked to summarise.
     *  - **`maxTurns: 1`** — one answer, no agentic loop. With no tools there
     *      is nothing to loop over, so this is the second lock on the same door.
     *  - **`settingSources: []`** — the same isolation every other path here
     *      gets: no hooks, no MCP servers, no `CLAUDE.md` pulled in to pad a
     *      six-word answer.
     *  - **A replacing `systemPrompt`** — a bare string, which is the *only*
     *      form that displaces the coding-agent preset (see `mapSystemPrompt`).
     *      Keeping the preset would spend far more tokens describing tools this
     *      call cannot use than it spends on the title.
     *
     * Resolves `null` on every failure, per the seam's contract. A machine with
     * no CLI, an account that cannot use the model it was handed, or a model
     * that answered with a paragraph all mean the same thing to the caller:
     * this session keeps the name it would otherwise have had.
     */
    async suggestSessionTitle(request: SessionTitleQuery): Promise<string | null> {
      // Aborting the controller is what actually reclaims the subprocess, so
      // the caller's signal is bridged onto it rather than checked in a loop.
      const abort = new AbortController();
      const forwardAbort = (): void => {
        abort.abort();
      };
      if (request.abortSignal?.aborted === true) return null;
      request.abortSignal?.addEventListener('abort', forwardAbort, { once: true });

      let sdkQuery: Query | undefined;
      try {
        const env = composeProviderEnv(request.env, {
          inheritHostEnv: request.inheritHostEnv,
          hostEnv,
          scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
        });
        env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

        sdkQuery = query({
          prompt: buildTitlePrompt(request.prompt),
          options: {
        ...sdkExecutable,
            cwd: request.cwd,
            env,
            model: request.model,
            abortController: abort,
            settingSources: [],
            persistSession: false,
            includePartialMessages: false,
            maxTurns: 1,
            tools: [],
            systemPrompt: SESSION_TITLE_INSTRUCTIONS,
          },
        });

        const answer = await withTimeout(readTitleAnswer(sdkQuery), TITLE_TIMEOUT_MS);
        if (!answer.ok) {
          diagnostic?.(`Could not name the session: ${answer.reason}`);
          return null;
        }

        const title = cleanSessionTitle(answer.text);
        if (title === null && !isDeclinedTitle(answer.text)) {
          // Worth a line: a model that keeps answering with prose is a prompt
          // problem, and this is the only place that would ever show it. A
          // model that *declined* is excluded — that is the prompt working, and
          // logging it made "hey" look like a fault on every new session.
          diagnostic?.(
            `Discarded an unusable session title: ${JSON.stringify(answer.text.slice(0, 120))}`,
          );
        }
        return title;
      } catch (error) {
        diagnostic?.(`Could not name the session: ${describe(error)}`, error);
        return null;
      } finally {
        request.abortSignal?.removeEventListener('abort', forwardAbort);
        abort.abort();
        try {
          await sdkQuery?.return?.(undefined);
        } catch {
          /* the abort above is what actually reclaims the subprocess */
        }
      }
    },

    /**
     * Write a title onto a stored session.
     *
     * `renameSession` appends a custom-title entry to the session's JSONL,
     * which is the same thing the CLI's own `/rename` writes — so the name
     * Artemis generated is read straight back by `listSessions` as
     * `customTitle`, and the user's own `claude` sees it too.
     *
     * The config-directory swap is the same one listing and history use, and
     * for the same reason: the SDK's standalone session functions take no
     * environment and resolve the store from `process.env`. `dir` narrows the
     * search to one project, which matters here more than it does for a read —
     * without it the SDK walks every project directory looking for the id.
     */
    async setSessionTitle(update: SessionTitleUpdate): Promise<void> {
      const configDir = readEnv(update.env, CLAUDE_CONFIG_DIR_ENV);
      try {
        await withClaudeConfigDir(
          configDir,
          () =>
            sdkRenameSession(
              update.sessionId,
              update.title,
              update.cwd === undefined ? undefined : { dir: update.cwd },
            ),
          'setSessionTitle',
        );
      } catch (error) {
        throw adapterError('unknown', `Could not rename the Claude session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    /**
     * Delete a session's transcript from disk, along with its subagent
     * transcripts. There is no undo.
     *
     * The counterpart to {@link setSessionTitle} rather than a sibling of it:
     * both are writes to the same store, reached by the same config-directory
     * swap and narrowed by the same `dir`.
     *
     * Returns false rather than throwing when the transcript is already gone.
     * The SDK throws for a missing session, and that case is routine here in a
     * way it is not for a read: a second click, or a transcript removed in a
     * terminal since the sidebar last listed it, both arrive as "not found",
     * and the user's intent — that this session stop existing — is already
     * satisfied. Every other failure still throws; only absence is forgiven,
     * which is why this inspects the error rather than swallowing all of them.
     */
    async deleteSession(input: SessionDeleteQuery): Promise<boolean> {
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);

      try {
        await withClaudeConfigDir(
          configDir,
          () =>
            sdkDeleteSession(input.sessionId, {
              ...(input.cwd === undefined ? {} : { dir: input.cwd }),
            }),
          'deleteSession',
        );
        return true;
      } catch (error) {
        if (isMissingSession(error)) return false;
        throw adapterError('unknown', `Could not delete that session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    /**
     * Write the SDK's own tag onto a stored session.
     *
     * Deliberately the same shape as `deleteSession` above — the config
     * directory locates the store, `dir` narrows the search, a missing session
     * is `false` rather than a throw — because they are the same kind of
     * operation: a mutation of the provider's record, performed by the
     * provider, which is what makes the result true wherever that record is
     * read from.
     */
    async tagSession(input: SessionTagQuery): Promise<boolean> {
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);

      try {
        await withClaudeConfigDir(
          configDir,
          () =>
            sdkTagSession(input.sessionId, input.tag, {
              ...(input.cwd === undefined ? {} : { dir: input.cwd }),
            }),
          'tagSession',
        );
        return true;
      } catch (error) {
        if (isMissingSession(error)) return false;
        throw adapterError('unknown', `Could not tag that session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async fetchPlanUsage(input: PlanUsageQuery): Promise<PlanUsage> {
      /*
        A control-plane read, deliberately never a turn.

        The prompt is an async iterable that yields nothing and never settles.
        `query()` therefore starts the CLI and opens its control channel, but
        the model is never sampled — so this costs one subprocess spawn and
        zero tokens. Pushing even an empty user message here would bill the
        user for opening a gauge.

        `settingSources: []` for the same reason it is set on runs: a
        distributed app must not silently inherit the user's personal
        configuration, and a usage probe has even less business doing so.
      */
      const idlePrompt = (async function* (): AsyncGenerator<never> {
        await new Promise<never>(() => {});
      })();

      let sdkQuery: ReturnType<typeof query> | undefined;
      try {
        sdkQuery = query({
          prompt: idlePrompt,
          options: {
        ...sdkExecutable,
            cwd: input.cwd,
            /*
              The SAME composition a real run uses, and it has to be.

              Passing `input.env` raw hands the subprocess only the profile's
              own variables — no `HOME`, no `PATH`. Claude resolves its config
              directory and its Keychain credentials through `HOME`, so without
              it the CLI cannot see the subscription at all and reports
              `rate_limits_available: false` — which reads as "this is an API
              account" when it actually means "I could not find your account".
            */
            env: composeProviderEnv(input.env, {
              ...(hostEnv === undefined ? {} : { hostEnv }),
              scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
            }) as Record<string, string>,
            settingSources: [],
          },
        });
        return await readPlanUsage(sdkQuery, now());
      } catch (cause) {
        // Spawning the CLI can fail for all the ordinary reasons — a bad cwd, a
        // missing runtime. None of them justify breaking the caller, which is a
        // status-line widget.
        return {
          available: false,
          unavailableReason: `Could not read plan usage: ${cause instanceof Error ? cause.message : String(cause)}`,
          windows: [],
          fetchedAt: now(),
        };
      } finally {
        // The idle prompt never completes, so without this the subprocess
        // outlives the call. `close()` is the only thing that ends it.
        try {
          sdkQuery?.close();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/**
 * Newest first, then by id.
 *
 * The id tiebreak is not cosmetic: two sessions written in the same
 * millisecond would otherwise order differently between calls, and a history
 * list that reshuffles on refresh looks broken.
 */
function byNewestThenId(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Profiles that read one store, and the config directory to read it through. */
interface StoreGroup {
  /**
   * The first scope's config directory. Any of the group's would do.
   *
   * `undefined` carries the same meaning it has in {@link withClaudeConfigDir}
   * — read whatever the ambient environment points at — rather than "no store".
   */
  readonly configDir: string | undefined;
  /** In the order the caller supplied. The first owns the summaries. */
  readonly scopes: SessionListScope[];
}

/**
 * Group key for a scope that names no config directory.
 *
 * A NUL byte cannot appear in a path, so this can never collide with a real
 * `realpath` result. Every such scope reads the one ambient store, so they do
 * belong together — `resolveStoreEnv` always emits the variable, which is why
 * this is a contract detail rather than a case Artemis reaches.
 */
const AMBIENT_STORE = '\0ambient';

/**
 * The directory the SDK actually walks for a given config directory.
 *
 * `listSessions({})` with no `dir` enumerates `$CLAUDE_CONFIG_DIR/projects/*`,
 * so `projects` — resolved through symlinks — is the store's identity. Resolving
 * the *config* directory instead would miss the case this exists for: sharing
 * history across accounts is done by linking `projects` between profiles
 * precisely because linking the config directory itself would share the
 * credential and collapse the accounts into one.
 */
async function sessionStoreIdentity(configDir: string | undefined): Promise<string> {
  if (configDir === undefined) return AMBIENT_STORE;
  try {
    return await realpath(join(configDir, 'projects'));
  } catch {
    /*
     * No store on disk yet, or one that cannot be resolved.
     *
     * Falls back to the config directory's own resolved path rather than to a
     * shared constant, so profiles that merely have *no history* stay in
     * separate groups. Collapsing them would be wrong in the one direction that
     * matters: a session written by one of them a moment later would come back
     * attributed to another.
     */
    return resolve(configDir);
  }
}

/**
 * Group scopes by the store they read, preserving the caller's order.
 *
 * Order matters twice over — the first scope in a group owns its summaries, and
 * the groups themselves come back in first-appearance order — because a history
 * list that reshuffles between identical reads looks broken. Both fall out of
 * `Map` preserving insertion order.
 */
async function groupByStore(scopes: readonly SessionListScope[]): Promise<StoreGroup[]> {
  const groups = new Map<string, StoreGroup>();

  for (const scope of scopes) {
    const configDir = readEnv(scope.env, CLAUDE_CONFIG_DIR_ENV);
    const key = await sessionStoreIdentity(configDir);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { configDir, scopes: [scope] });
    else existing.scopes.push(scope);
  }

  return [...groups.values()];
}

function validateRunInput(input: ResolvedRunInput): void {
  if (!isAbsolute(input.cwd)) {
    throw adapterError('invalid_request', `Working directory must be an absolute path: ${input.cwd}`);
  }

  if (input.permissionMode !== undefined) {
    // Reject rather than downgrade. Silently falling back to a different mode is
    // how a run ends up more permissive than the user asked for.
    if (!CLAUDE_CAPABILITIES.permissionModes.includes(input.permissionMode)) {
      throw adapterError(
        'invalid_request',
        `Claude does not support the permission mode "${input.permissionMode}".`,
      );
    }
  }

  if (input.effort !== undefined && !CLAUDE_EFFORT_IDS.has(input.effort)) {
    // Rejected, not dropped. `model` is deliberately open because the provider
    // accepts ids beyond the ones worth listing, but `effort` is a closed union
    // in the SDK: an unrecognised value would be forwarded and either error deep
    // inside the CLI or be ignored, and a silently ignored effort setting is the
    // kind of failure the user only notices on the invoice.
    throw adapterError(
      'invalid_request',
      `Claude does not support the reasoning effort "${input.effort}". Expected one of: ${CLAUDE_EFFORT_LEVELS.map((e) => e.id).join(', ')}.`,
    );
  }

  if (input.forkSession === true && input.resumeSessionId === undefined) {
    throw adapterError(
      'invalid_request',
      'forkSession requires resumeSessionId — there is nothing to fork from.',
    );
  }

  if (input.rewindToMessageId !== undefined && input.resumeSessionId === undefined) {
    throw adapterError(
      'invalid_request',
      'rewindToMessageId requires resumeSessionId — there is nothing to rewind.',
    );
  }

  for (const plugin of input.plugins ?? []) {
    // The SDK accepts a relative plugin path and resolves it against the run's
    // `cwd`, so the same value would name a different directory in every
    // repository — and would silently find nothing in most of them. Rejected
    // here because a skill that is quietly absent is the failure this whole
    // channel exists to end.
    if (!isAbsolute(plugin.path)) {
      throw adapterError('invalid_request', `Plugin path must be absolute: ${plugin.path}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Options construction                                                       */
/* -------------------------------------------------------------------------- */

/** Everything {@link buildClaudeOptions} needs beyond the run input. */
export interface BuildClaudeOptionsContext {
  readonly canUseTool: CanUseTool;
  readonly abortController: AbortController;
  readonly stderr: (data: string) => void;
  readonly hostEnv?: EnvBundle;
  /** See {@link ClaudeAdapterOptions.sdkExecutablePath}. */
  readonly sdkExecutablePath?: string;
  /**
   * Host-supplied MCP servers for this run. See
   * {@link ClaudeAdapterOptions.agentToolServers} — already resolved for the
   * run by the time it reaches here, so this function stays pure.
   */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /**
   * The resolved truncation point for a rewinding resume. Resolved from the
   * stored chain in `createRun` for the same reason `mcpServers` is: this
   * function stays pure.
   */
  readonly rewind?: RewindPoint;
  /**
   * Ask the SDK to predict the user's next prompt after each turn.
   *
   * Set exactly when someone is wired to receive it — see
   * {@link ClaudeRunDeps.onSuggestion}. Off by default so a headless caller's
   * process is byte-identical to one from before this option existed.
   */
  readonly promptSuggestions?: boolean;
}

/**
 * Translate a {@link ResolvedRunInput} into the SDK's `Options`.
 *
 * Exported because this is where a mistake is expensive and invisible: an
 * unmapped `settingSources`, a `forkSession` without `resume`, a permission
 * mode that quietly did not apply. Keeping it a pure function makes each of
 * those assertable.
 */
export function buildClaudeOptions(
  input: ResolvedRunInput,
  context: BuildClaudeOptionsContext,
): Options {
  const env = composeProviderEnv(input.env, {
    inheritHostEnv: input.inheritHostEnv,
    hostEnv: context.hostEnv,
    scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
  });

  // Identify Artemis in the provider's User-Agent, unless the profile already
  // chose an identifier.
  env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

  const permissionMode = input.permissionMode;

  return {
    ...(context.sdkExecutablePath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: context.sdkExecutablePath }),
    cwd: input.cwd,
    env,
    abortController: context.abortController,
    canUseTool: context.canUseTool,
    stderr: context.stderr,

    // Isolation. `[]` means "load no filesystem settings" — see the file header.
    settingSources: [...(input.settingSources ?? [])] as SettingSource[],

    /*
     * Skills, and only skills.
     *
     * Plugin discovery does not go through `settingSources`, which is what makes
     * this the one way to hand a session the user's skills without also handing
     * it their hooks, MCP servers and permission rules. Verified rather than
     * assumed: `skills: 'all'` looks like the same switch and is not — it filters
     * skills that were *already* discovered, so under `settingSources: []` it
     * filters an empty set and changes nothing.
     *
     * `undefined` rather than `[]` when there are none, because an empty array
     * still initialises the SDK's plugin machinery, and a run with no skills
     * should be byte-identical to one from before this option existed.
     */
    plugins: input.plugins?.length
      ? input.plugins.map(({ path }) => ({ type: 'local' as const, path }))
      : undefined,

    includePartialMessages: input.includePartialMessages !== false,

    // Only when a listener exists — the flag makes the CLI spend a (cheap,
    // cache-riding) model call after every turn, which a run nobody is
    // watching should not pay for. The CLI still applies its own suppressions
    // on top: first turn, plan mode, error endings, the user's settings.json.
    ...(context.promptSuggestions === true ? { promptSuggestions: true } : {}),

    model: input.model,
    fallbackModel: input.fallbackModel,
    // `validateRunInput` has already rejected anything outside the declared
    // levels, so this cast narrows a checked value rather than asserting an
    // unchecked one.
    effort: input.effort as Options['effort'],
    // Fast mode and ultracode are *settings*, not top-level options, so they
    // ride the flag-settings layer. Absent when neither was asked for: an empty
    // object here is not inert — it is a flag-settings layer that exists, and
    // the layer has the highest priority among user-controlled settings.
    settings: buildFlagSettings(input),
    /*
     * Two CLI flags with no SDK options of their own, riding `extraArgs`,
     * which exists for exactly this.
     *
     * `thinking-display` is always sent, because the CLI's own default is the
     * one thing it must not be here. The CLI infers whether anyone will read
     * the reasoning from how it is being driven: interactive sessions default
     * the display to `summarized`, SDK-driven ones to `omitted` — and
     * `omitted` still returns every thinking block, as a signature beside
     * empty text. The mapper rightly refuses to put an empty fold in the
     * transcript, so without this flag a Claude run shows no reasoning at
     * all, for every model and every credential. Artemis *is* somebody
     * watching, and this is where it says so. Verified against the bundled
     * CLI rather than assumed: the same turn yields zero thinking characters
     * without the flag and the real text with it.
     *
     * `chrome` is passed only when asked for: the flag loads the whole
     * `claude-in-chrome` tool set into context on every turn, which is a real
     * cost a run that never browses should not pay, and the CLI treats an
     * absent flag as off, so there is nothing to negate.
     *
     * Requests, not guarantees — the CLI keeps the Chrome integration off for
     * API-key credentials and when the extension is not connected, and a
     * model that returns no reasoning still returns none. Deliberately not
     * pre-checked here: the CLI owns those decisions and its rules move with
     * its releases, so second-guessing them would only age badly.
     */
    extraArgs: {
      'thinking-display': 'summarized',
      ...(input.chromeBrowser === true ? { chrome: null } : {}),
    },
    permissionMode,
    // The SDK gates `bypassPermissions` behind an explicit opt-in. Passing it
    // only when the user picked that mode keeps the dangerous flag tied to a
    // deliberate choice instead of becoming an ambient default.
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' ? true : undefined,

    resume: input.resumeSessionId,
    // Only meaningful alongside `resume`; `validateRunInput` has already
    // rejected the combination that is not.
    forkSession: input.resumeSessionId !== undefined ? input.forkSession : undefined,
    // A truncating resume. The uuid pair comes resolved from the stored chain
    // — the SDK wants the last entry *kept*, the renderer knows the first one
    // *dropped*, and `resolveRewindPoint` is the translation between them.
    resumeSessionAt: context.rewind?.resumeSessionAt,
    resumeDropsTurn: context.rewind?.dropsTurn,

    // `RunInput.allowedTools` is an allow-*list*: it narrows which tools exist.
    // The SDK's `Options.allowedTools` is a different knob with a confusingly
    // similar name — it auto-approves tools without prompting, and leaves the
    // full default tool set in place. Mapping onto it would make a run strictly
    // *more* permissive than asked: Bash/Edit/Write would remain available, and
    // the named tools would additionally bypass `canUseTool` entirely (the SDK
    // warns about that shadowing under `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`).
    // `Options.tools` is the restriction knob, so that is what this maps to.
    tools: input.allowedTools === undefined ? undefined : [...input.allowedTools],
    disallowedTools: input.disallowedTools === undefined ? undefined : [...input.disallowedTools],
    additionalDirectories:
      input.additionalDirectories === undefined ? undefined : [...input.additionalDirectories],

    /*
     * Host tools, when the host supplied any. Spread as `undefined` otherwise
     * rather than as `{}`: an empty `mcpServers` still establishes the MCP
     * plumbing in the SDK, and a run that asked for no tools should be
     * byte-identical to one from before this option existed.
     */
    mcpServers: context.mcpServers,

    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    systemPrompt: mapSystemPrompt(input.systemPrompt),
    title: input.title,
  };
}

/**
 * Assemble the flag-settings layer from the run's speed/depth knobs.
 *
 * `fastMode` and `ultracode` are not top-level `Options` fields — they live in
 * `Settings`, which `Options.settings` loads into the flag layer (the same one
 * the CLI's `--settings` flag feeds, and the highest-priority user-controlled
 * tier). Both are session-scoped by design: the SDK documents that interactive
 * ultracode toggles never persist, which matches Artemis's model exactly, since
 * every run is configured from the status line rather than from a config file.
 *
 * Returns `undefined` rather than `{}` when neither is set. Passing an empty
 * object would still *establish* a flag-settings layer, and a layer that exists
 * but says nothing is not the same as no layer at all — this keeps a run that
 * asked for neither knob byte-identical to one from before they existed.
 *
 * Nothing here checks whether the selected model supports either flag. That is
 * the UI's job (it has the model descriptor and can disable the control with a
 * reason) and the provider's job (it resolves entitlement, cooldown and model
 * eligibility server-side). Duplicating the check here would mean maintaining a
 * third, staler copy of a fact the other two already own — the same argument
 * that keeps per-model effort tables out of this file.
 */
export function buildFlagSettings(input: ResolvedRunInput): Settings | undefined {
  const settings: Settings = {};
  if (input.fastMode === true) settings.fastMode = true;
  if (input.ultracode === true) settings.ultracode = true;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Map protocol's {@link SystemPromptSpec} onto the SDK's `systemPrompt`.
 *
 * `append` keeps the provider's own preset and adds to it, which is the only
 * safe way to add project conventions: the preset is what describes the tools
 * to the model, so `replace` reliably degrades tool use.
 *
 * ## Absent is not "leave it to the SDK"
 *
 * `RunInput.systemPrompt` is optional, and the obvious reading — omit the
 * option and the CLI uses its own prompt — is wrong. The SDK normalises an
 * omitted `systemPrompt` to the empty *string* (`if (s === undefined) d = ""`)
 * and forwards it on the `initialize` control request as `[""]`, which the CLI
 * treats as an explicit custom prompt and uses **instead of** its preset. Only
 * the object form leaves the field absent and lets the preset through.
 *
 * So the absent case is mapped to `kind: 'default'` rather than to `undefined`.
 * Getting this wrong is invisible and total: every default run would lose the
 * whole Claude Code behavioural prompt — tool guidance, context sections,
 * coding-agent conventions — which is exactly the `replace` degradation this
 * function exists to avoid. The unknown-kind fallback goes the same way, on the
 * same reasoning: a spec this function does not understand must not silently
 * become "no system prompt at all".
 */
export function mapSystemPrompt(spec: SystemPromptSpec | undefined): Options['systemPrompt'] {
  if (spec === undefined) return { type: 'preset', preset: 'claude_code' };
  switch (spec.kind) {
    case 'default':
      return { type: 'preset', preset: 'claude_code' };
    case 'append':
      return { type: 'preset', preset: 'claude_code', append: spec.text };
    case 'replace':
      return spec.text;
    default:
      return { type: 'preset', preset: 'claude_code' };
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

interface PendingPermission {
  readonly deferred: Deferred<PermissionResult>;
  readonly toolName: string;
  readonly toolUseID: string | undefined;
  /**
   * The arguments the call was parked on, and the questions decoded from them.
   *
   * Kept only so an answer can be written back into the tool's own input shape
   * — see {@link ToPermissionResultOptions.question}. Both are undefined for
   * every request that is an ordinary approval, which is nearly all of them.
   */
  readonly input: JsonObject;
  readonly question: QuestionPrompt | undefined;
}

/**
 * Tools that leave a job inside the process rather than doing something and
 * returning.
 *
 * A process that has called one of these has a timer in it that only fires
 * while it is idle, so closing it at the next turn boundary is the difference
 * between a scheduled job running and never running. Named explicitly — see
 * {@link ClaudeProcess.#observeToolCall} on why this is not a pattern.
 */
const SCHEDULING_TOOLS = new Set(['CronCreate', 'ScheduleWakeup', 'CronUpdate']);

/**
 * How long a settled task holds the process, waiting for the turn about it.
 *
 * Measured at about a tenth of a second between the empty task set and the
 * provider's own `init`. Two seconds is an order of magnitude of headroom for a
 * loaded machine, and it is the *upper* bound on a process outliving its work by
 * nothing useful — the turn itself clears it the moment it starts.
 */
const SETTLE_GRACE_MS = 2_000;

/**
 * How long a finished turn's process waits for the provider's predicted next
 * prompt before being released. The prediction is a model call — cheap and
 * cache-riding, but a real network round-trip — so this is minutes-scale
 * generous compared to {@link SETTLE_GRACE_MS} while still bounding the idle
 * process. Expiry costs nothing visible: the turn's `run.end` shipped long
 * before this clock started.
 */
const SUGGESTION_GRACE_MS = 10_000;

/**
 * How long an ended turn's process waits for the queued turn a mid-turn steer
 * became, before concluding the steer was folded into the turn that just
 * finished.
 *
 * The CLI folds a steer in only at a tool-batch boundary; one that misses every
 * boundary sits in the CLI's queue and runs as the *next* turn — whose `init`
 * the drain loop emits within milliseconds of the previous `result`. So the
 * wait this bounds is drain-loop latency, not a network round-trip, and five
 * seconds is orders of magnitude of headroom. Expiry means the message was
 * consumed mid-turn (the fold, which is invisible from here) and the process
 * is released exactly as if nothing had been pending.
 */
const QUEUED_TURN_GRACE_MS = 5_000;

/**
 * How often an outstanding queued message checks the transcript for its fold.
 *
 * The CLI reads a queued message without saying so on its stream: the fold
 * arrives to the model inside the next tool result, and the only record is the
 * `queue-operation` row it appends to the session's own `.jsonl`. So while a
 * named message is unread, the process tails that file. The poll only exists
 * in that state — no queued message, no timer — and each pass reads just the
 * bytes appended since the last, so the steady cost is one `stat` per tick on
 * a file the CLI has open anyway.
 */
const DELIVERY_POLL_MS = 800;

/**
 * How much of the transcript's tail the first delivery poll is willing to read.
 *
 * The watch starts at send time and the fold strictly follows it, so anything
 * relevant is at the end of the file. A resumed conversation can be megabytes;
 * scanning all of it to find a row that cannot be there yet is pure waste.
 */
const DELIVERY_FIRST_READ_BYTES = 256 * 1024;

/**
 * Clock slack when matching a transcript row to the message it delivers.
 *
 * Both timestamps come from this machine — the entry's from Artemis at send,
 * the row's from the CLI at fold — but they are stamped by different processes
 * and a row must never lose its match to scheduling jitter.
 */
const DELIVERY_TIMESTAMP_SLACK_MS = 2_000;

/**
 * Does this message open a turn?
 *
 * `init` does, once per turn — the CLI emits one at the head of every turn in
 * streaming-input mode, which is what makes an unprompted turn detectable from
 * the outside at all. Measured rather than assumed: three streamed turns on one
 * process produced three `init`s carrying one session id.
 */
function startsTurn(message: SDKMessage): boolean {
  return (
    message.type === 'system' &&
    (message as unknown as { subtype?: unknown }).subtype === 'init'
  );
}

/**
 * The prose of an echoed user turn, for recognising a message by its words.
 *
 * Only text is joined: images and documents were dropped on the way out of the
 * union and there is nothing to compare them against. A message that was
 * nothing but attachments therefore comes back as an empty string and matches
 * nothing, which is the right answer — it has no words to be recognised by.
 */
function echoedText(message: { readonly message: { readonly content: unknown } }): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

interface ClaudeRunDeps {
  readonly now: () => number;
  readonly hostEnv?: EnvBundle;
  /**
   * Where a truncating resume re-enters the chain, when this run is one.
   *
   * Resolved by `createRun` against the stored session *before* the process is
   * constructed, because the resolution is a file read and everything from
   * here down is synchronous by design. See {@link resolveRewindPoint}.
   */
  readonly rewind?: RewindPoint;
  readonly diagnostic?: (message: string, detail?: unknown) => void;
  /** See {@link ClaudeAdapterOptions.sdkExecutablePath}. */
  readonly sdkExecutablePath?: string;
  /** See {@link ClaudeAdapterOptions.agentToolServers}. */
  readonly agentToolServers?: (
    runId: RunId,
    input: RunInput,
  ) => Record<string, McpServerConfig> | undefined;
  /**
   * Called the first time the process learns which provider session it is
   * writing to, and again when it goes away.
   *
   * The adapter keeps the pool; the process is what discovers the one fact the
   * pool is keyed on. A process cannot be pooled at construction because its
   * session id arrives on the first `init` — for a resumed conversation it is
   * the id that was resumed, and for a fresh one it is minted by the CLI.
   */
  readonly onSession?: (sessionId: SessionId, process: ClaudeProcess) => void;
  readonly onClosed?: (process: ClaudeProcess) => void;
  /**
   * A turn nobody asked for has started, and here is the run for it.
   *
   * The provider takes a turn of its own when background work settles — it is
   * told the task finished and answers — and it can also park on a permission
   * prompt for a subagent whose own turn ended long ago. Both produce events
   * with no run to carry them, and dropping them would leave what is on screen
   * quietly out of step with what the provider has written to its own transcript.
   *
   * The adapter cannot register a run itself: ids and the fan-out belong to the
   * registry. So it builds the run and hands it up.
   */
  readonly onContinuation?: (run: Run, context: ContinuationContext) => void;
  /** See {@link ClaudeAdapterOptions.onSuggestion}. Also the opt-in. */
  readonly onSuggestion?: (suggestion: RunSuggestion) => void;
  /** Ids for those turns. Injected so tests do not depend on `randomUUID`. */
  readonly newRunId?: () => RunId;
}

/**
 * What a turn asks of the process serving it, beyond the prompt.
 *
 * Every one of these has a mid-session setter, which is what makes attaching to
 * a live process sound rather than a silent downgrade: a turn that asks for a
 * different model gets `setModel` called before its prompt is pushed. Compared
 * against what the process last applied so that an unchanged turn sends no
 * control requests at all.
 */
interface TurnSettings {
  readonly model: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly effort: string | undefined;
  readonly fastMode: boolean | undefined;
  readonly ultracode: boolean | undefined;
}

function turnSettings(input: ResolvedRunInput): TurnSettings {
  return {
    model: input.model,
    permissionMode: input.permissionMode,
    effort: input.effort,
    fastMode: input.fastMode,
    ultracode: input.ultracode,
  };
}

/** A turn built and not yet served. See `ClaudeProcess.#prepareTurn`. */
interface PreparedTurn {
  readonly state: ClaudeMapperState;
  readonly events: AsyncQueue<AgentEvent>;
  readonly turn: ClaudeTurn;
}

/** A prepared turn whose prompt is queued at the CLI. See `ClaudeProcess.#pendingTurn`. */
interface PendingTurn extends PreparedTurn {
  /** The uuid the prompt was stamped with, which its echo carries back. */
  readonly uuid: string;
  /** The prompt's words, the fallback for an echo minted under another id. */
  readonly text: string;
}

/**
 * The provider process, and the turns it serves.
 * ----------------------------------------------------------------------------
 *
 * A `Run` is one turn. A process is not: it is the transport, and it can serve
 * several turns before it goes away. Those were the same object until now,
 * which is why closing a finished turn took the process — and everything it was
 * holding — down with it.
 *
 * The split is along the line the SDK itself draws. `query()` takes the prompt
 * iterable *once* and returns one `Query`, so the input stream, the transport,
 * the abort controller, the staging directory and the `canUseTool` callback are
 * all fixed at spawn and belong to the process. What belongs to a turn is
 * exactly what {@link ClaudeMapperState} holds — a run id, a dense `seq`, the
 * tool calls opened in it, whether it has ended — plus the event queue the
 * caller iterates.
 *
 * ## The active turn
 *
 * `#state` and `#eventQueue` are the *current* turn's, and they are reassigned
 * by {@link beginTurn}. Every method below that reads them means "the turn this
 * process is serving now", which is well-defined because the CLI serves turns
 * strictly one at a time: a `result` closes one before the next `init` opens
 * another. That is what lets the mapping, the permission callback and the pump
 * stay exactly as they were rather than being threaded with a turn argument.
 *
 * The `Run` handed to the caller is {@link ClaudeTurn}, which captures its own
 * state and queue. So a consumer still iterating turn one's stream is
 * unaffected by turn two starting, and a control call arriving late is refused
 * rather than silently applied to whatever turn is running now.
 */
class ClaudeProcess {
  readonly providerId = CLAUDE_PROVIDER_ID;
  readonly capabilities = CLAUDE_CAPABILITIES;

  readonly #input: ResolvedRunInput;
  readonly #deps: ClaudeRunDeps;
  /** The active turn's mapping state. Reassigned by {@link beginTurn}. */
  #state!: ClaudeMapperState;
  /** The active turn's event stream. Reassigned by {@link beginTurn}. */
  #eventQueue!: AsyncQueue<AgentEvent>;
  readonly #promptQueue: AsyncQueue<SDKUserMessage>;
  readonly #pending = new Map<PermissionRequestId, PendingPermission>();
  readonly #abort = new AbortController();
  readonly #stderrTail: string[] = [];

  #query: Query | undefined;
  #pumpDone: Promise<void> = Promise.resolve();
  #disposing: Promise<void> | undefined;
  #permissionCounter = 0;
  #detachAbortSignal: (() => void) | undefined;

  /**
   * What the process is holding that a turn boundary must not kill.
   *
   * Descriptions rather than the tasks themselves: the only use is deciding
   * whether to keep the process and naming what kept it in a diagnostic. See
   * {@link #holdsWork}.
   */
  #liveTasks: readonly string[] = [];

  /**
   * Every task this process has delegated, for the pane that shows them.
   *
   * Per process and never carried across one, which is the SDK's own instruction
   * for the level underneath it: nothing is emitted at startup, so a row brought
   * forward would be a claim about work inside a CLI that no longer exists.
   */
  readonly #tasks = new TaskLedger(() => this.#deps.now());
  /** One-way, and {@link #holdsWork} explains why it cannot be counted down. */
  #registeredSchedule = false;

  /** The conversation this process writes to, learned from its first `init`. */
  #sessionId: SessionId | undefined;
  /** True once the transport is gone, so the pool can never hand it out again. */
  #closed = false;
  /** What was last applied to the live process, so a turn only sends what differs. */
  #settings: TurnSettings;
  /** Fallback numbering for continuation ids when no minter was injected. */
  #continuations = 0;
  /** A task settled and the turn about it has not arrived yet. See `#awaitSettleTurn`. */
  #settling = false;
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The turn ended and its predicted next prompt has not arrived yet. See `#awaitSuggestion`. */
  #awaitingSuggestion = false;
  #suggestionTimer: ReturnType<typeof setTimeout> | undefined;
  /** Steers pushed at a turn that no later turn has yet consumed. See `#awaitQueuedTurn`. */
  #pendingSteers = 0;
  /**
   * Sends that have been accepted but have not reached the queue yet.
   *
   * Counted from the first line of {@link send}, before it stages the message's
   * files, because the pump's decision to keep or drop the process is taken on
   * whatever these counters say at the instant a turn ends — and a message the
   * user has already been told was sent must weigh on that decision from the
   * moment it was accepted, not from the moment its last file finished copying.
   */
  #sendsInFlight = 0;
  /**
   * The provider's own word that a message survives the interrupt.
   *
   * `still_queued` on the interrupt receipt names messages the CLI will run
   * regardless, and it is authoritative where {@link #pendingSteers} is only a
   * local guess: the count is zeroed whenever a turn opens, it cannot see a
   * message the CLI enqueued for itself, and a fold leaves it counting a steer
   * that has already been read. When the two disagree, this one is the fact.
   */
  #providerQueued = false;
  /** The turn ended with steers pending and their queued turn has not opened yet. */
  #awaitingQueuedTurn = false;
  #queuedTurnTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * A turn opened by {@link continueWith} whose prompt the CLI has not started.
   *
   * A prompt handed to a live process used to become the active turn on the
   * spot, and every message the CLI sent next was mapped onto it — including
   * the turn the CLI runs *of its own accord* first. A process is kept alive
   * past its turn precisely when it holds background work, and when that work
   * settles the CLI queues a task notification and answers it as a turn of its
   * own: `init`, the notification in a user slot, a sentence about the task,
   * `result`. With a prompt pushed a moment before, that sentence streamed as
   * the answer to the prompt and the `result` ended the run — and the prompt
   * itself ran afterwards, on a turn nobody was watching. From the user's side:
   * the conversation woke for a second, said something about a subagent, and
   * stopped; the second message worked (reproduced 2026-09-08 on a served
   * session, and the same code serves a desktop one).
   *
   * So the turn is held here until the CLI says whose turn it has opened, which
   * it does with the user message it echoes: ours carries the uuid the prompt
   * was stamped with (or its words), the harness's carries a notification. The
   * messages of a turn whose owner is not yet known wait in {@link #undecided};
   * see {@link #defer} for the decision and where each side's messages go.
   */
  #pendingTurn: PendingTurn | undefined;
  /** Messages of a CLI turn whose owner is not yet known. See {@link #pendingTurn}. */
  readonly #undecided: SDKMessage[] = [];

  /**
   * Messages pushed at the CLI that it has not been seen to read yet.
   *
   * In send order, which is delivery order — the CLI's queue is FIFO — and keyed
   * two ways because the correlation has two independent halves and either one
   * alone has a hole in it.
   *
   * `uuid` is the identity this adapter stamps on the outgoing message. The
   * CLI's queue is keyed on it: `still_queued` on an interrupt receipt lists
   * *uuid-stamped* messages and, per the SDK's own note, "a message enqueued
   * without a uuid still runs but is never listed". Artemis sent none until
   * now, which quietly made {@link #providerQueued} unreachable for the app's
   * own steers — the flag existed to catch a message the interrupt spared and
   * could only ever have been set by the CLI's internal traffic.
   *
   * `text` is the fallback, because the uuid round-trip is the CLI's business
   * rather than a contract: the echo is written from the transcript, and if it
   * ever arrives re-minted, matching the exact words of the oldest unread
   * message still identifies it. Both are checked; neither is trusted alone.
   *
   * Lives on the *process*, not the turn. A steer that misses every tool
   * boundary is read by the next turn, so an entry routinely outlives the turn
   * it was sent into — which is also why the entry carries the `messageId` it
   * was filed under rather than trusting position: the id names the run the
   * user typed into, and that run may already be over by the time it is read.
   */
  readonly #unread: {
    readonly uuid: string;
    readonly messageId: MessageId;
    readonly text: string;
    readonly sentAt: number;
  }[] = [];

  /**
   * The transcript tail, read because the stream says nothing.
   *
   * A fold used to be observable: the CLI echoed every user turn back on its
   * own stream, and {@link #observeDelivery} watched for the echo. It no longer
   * does — a queued message is consumed as a `queued_command` attachment, the
   * model sees it inside the next tool result, and the stream carries no user
   * message at all. What the CLI *does* write is a `queue-operation` row with
   * `operation: "remove"` and the message's exact text, into the session's own
   * `.jsonl`, at the moment the message leaves its queue. That file is the one
   * place the fold is visible, so while a named message is unread this process
   * tails it. {@link #observeDelivery} stays: an echo, should any version emit
   * one again, still wins the race and costs nothing.
   */
  #deliveryTimer: ReturnType<typeof setInterval> | undefined;
  /** How far into the transcript the delivery poll has read. */
  #deliveryOffset = -1;
  /** A partial trailing line carried between delivery reads. */
  #deliveryRemainder = '';
  /** The transcript path once found, so the candidate walk runs once. */
  #deliveryFile: string | undefined;
  /**
   * Deliveries noticed while no turn could carry them.
   *
   * The same contract as {@link #observeDelivery}: nothing may be emitted onto
   * a finished turn. A fold read from the file after its turn ended parks the
   * id here, and the poll flushes it the moment a live turn exists.
   */
  readonly #deliveredPendingEmit: MessageId[] = [];

  /** Where this run's files live, and how many it has written. */
  readonly #stagingDir: string;
  #stagedCount: number;
  /** The opening prompt's files, held until `start()` builds its message. */
  #openingStaged: readonly StagedAttachment[];

  constructor(
    input: ResolvedRunInput,
    deps: ClaudeRunDeps,
    staging: { readonly directory: string; readonly staged: readonly StagedAttachment[] },
  ) {
    this.#input = input;
    this.#deps = deps;
    this.#stagingDir = staging.directory;
    this.#openingStaged = staging.staged;
    this.#stagedCount = staging.staged.length;
    this.#promptQueue = new AsyncQueue<SDKUserMessage>();
    // What the spawn is about to apply, so the first attached turn compares
    // against what is actually in force rather than against nothing.
    this.#settings = turnSettings(input);
  }

  /** The turn this process is serving, for the diagnostics that name one. */
  get runId(): string {
    return this.#state.runId;
  }

  /**
   * Open a turn on this process, and hand back the `Run` for it.
   *
   * Called once per turn: by `createRun` for a prompt the user sent, and — once
   * a process can outlive a turn — by the pump for a turn the provider starts on
   * its own when background work settles.
   *
   * The state is fresh every time, which is the whole contract a run has: `seq`
   * restarts at 0, dense, and `ended` is false. Nothing conversation-scoped
   * lives in it, so there is nothing to carry across — the session id arrives
   * again on this turn's own `init`, because the CLI emits one per turn in
   * streaming mode.
   */
  beginTurn(input: ResolvedRunInput): ClaudeTurn {
    const prepared = this.#prepareTurn(input);
    this.#install(prepared);
    return prepared.turn;
  }

  /** Build a turn's state and stream without making it the one being served. */
  #prepareTurn(input: ResolvedRunInput): PreparedTurn {
    const state = createClaudeMapperState(input.runId, {
      now: this.#deps.now,
      resumedFrom: input.resumeSessionId,
      forked: input.forkSession === true,
    });

    // Abandoning the event stream does not tear the run down — dispose() is the
    // explicit way to do that — but it does mean nobody is listening, which is
    // worth recording.
    const events = new AsyncQueue<AgentEvent>({
      onAbandoned: () => {
        this.#deps.diagnostic?.(`Run ${input.runId}: event stream abandoned by its consumer.`);
      },
    });

    return { state, events, turn: new ClaudeTurn(this, state, events) };
  }

  /** Make a prepared turn the one the pump maps onto. */
  #install(turn: PreparedTurn): void {
    this.#state = turn.state;
    this.#eventQueue = turn.events;
  }

  /** Is this the turn the process is serving right now? */
  isActive(state: ClaudeMapperState): boolean {
    return this.#state === state;
  }

  /**
   * Is this turn one the process will still carry — being served, or waiting
   * for the CLI to open it? What a steer typed straight after a prompt needs
   * to know: the prompt is queued and the steer queues behind it, exactly as
   * it would had the CLI already begun.
   */
  isOpen(state: ClaudeMapperState): boolean {
    return this.#state === state || this.#pendingTurn?.state === state;
  }

  /**
   * Make sure there is a turn to put events on, opening one if there is not.
   *
   * Called from the two places a provider can speak without being asked: the
   * pump, when an `init` arrives after the last turn ended, and the permission
   * callback, when a subagent parks on a tool long after the turn that launched
   * it finished. Both used to be impossible — an ended run had no transport — and
   * both are now ordinary consequences of a process outliving its turns.
   *
   * What it must not do is reopen the turn that ended. `run.end` fired, its queue
   * closed, and a consumer's `for await` has already finished; pushing more onto
   * it would be events after a terminal event, on a stream nobody is reading. So
   * this is a *new* run, with its own id and its own dense `seq`, announced
   * upward so something adopts it.
   *
   * Refuses when nothing is listening, and that is load-bearing rather than
   * defensive. An adapter with no `onContinuation` — a test, a smoke script — has
   * nowhere to report the turn, so a permission prompt opened on one would park
   * on a promise no one can resolve and the subagent would wait for ever. The
   * work still finishes and the process is still kept; what is refused is
   * pretending there is a turn somebody can see. The caller decides what that
   * means: the pump drops the events, the permission callback denies.
   *
   * @returns whether there is now a turn that something will receive.
   */
  #ensureTurn(): boolean {
    // Whatever opens a turn is what the settle grace was holding the process for.
    this.#settling = false;
    clearTimeout(this.#settleTimer);
    // And a new turn makes the old one's prediction moot: the user has already
    // said their next thing. Stop waiting; if the prediction still arrives it
    // is delivered and the renderer decides whether it is stale.
    this.#awaitingSuggestion = false;
    clearTimeout(this.#suggestionTimer);
    // A turn opening consumes the CLI's whole queued batch — every pending
    // steer is coalesced into it, and whatever the interrupt receipt promised
    // is what this turn is. This is the arrival `#awaitQueuedTurn` was holding
    // the process for.
    this.#pendingSteers = 0;
    this.#providerQueued = false;
    this.#awaitingQueuedTurn = false;
    clearTimeout(this.#queuedTurnTimer);

    if (!this.#state.ended) return true;
    if (this.#deps.onContinuation === undefined) return false;

    const runId = this.#deps.newRunId?.() ?? `run_c_${String(++this.#continuations)}`;
    const turn = this.beginTurn({
      ...this.#input,
      runId: runId as ResolvedRunInput['runId'],
      prompt: '',
      // Not a resume and not a fork: this turn is *inside* the session the
      // process is already on, so echoing either onto its `session.started`
      // would describe a continuation as a re-entry.
      resumeSessionId: undefined,
      forkSession: false,
      attachments: undefined,
    });

    this.#deps.diagnostic?.(
      `Run ${runId}: the provider started a turn of its own on session ${this.#sessionId ?? '—'}.`,
    );
    this.#deps.onContinuation(turn, {
      providerId: CLAUDE_PROVIDER_ID,
      profileId: this.#input.profileId,
      cwd: this.#input.cwd,
      sessionId: this.#sessionId,
    });
    return true;
  }

  /* -------------------------------- attaching ------------------------------ */

  /** The conversation this process is writing to, once its first `init` said so. */
  get sessionId(): SessionId | undefined {
    return this.#sessionId;
  }

  /**
   * Is this process holding work a turn boundary must not kill?
   *
   * The public reading of {@link #holdsWork}, and the only thing outside this
   * class that can answer it. It exists because the renderer cannot: the rows a
   * window draws come from `background.tasks`, which is run-scoped and which
   * {@link #flushTasks} refuses to emit once the turn has ended — while this
   * stays true for exactly the work those rows describe. Between one turn
   * ending and the next opening, a window's list is a snapshot and this is the
   * fact.
   *
   * Reported rather than acted on: the adapter publishes it through
   * `sessionsHoldingWork` so a window can be told which conversations are still
   * working, and nothing about retention changes on the strength of who asked.
   */
  get holdsWork(): boolean {
    return this.#holdsWork();
  }

  /**
   * Is something actually happening on this conversation right now?
   *
   * An open turn, a live background task, or a settled task's grace beat —
   * and deliberately **not** the registered-schedule bit, which is the one
   * component of {@link holdsWork} that never clears. The split mirrors
   * {@link busyWithWork}'s reason for existing: retention and rewind each
   * needed their own reading of the same state, and so does the working
   * marker. A conversation waiting on a schedule is retained and rewindable
   * questions aside, *idle* — and must read as idle.
   *
   * The open-turn check (`!#state.ended`) is what lets a window mark a
   * conversation whose turn was started by something other than that window —
   * a scheduled wakeup firing between reloads — which its own pane state
   * cannot know about.
   */
  get working(): boolean {
    return !this.#state.ended || this.#liveTasks.length > 0 || this.#settling;
  }

  /**
   * Whether the conversation has *real* work in flight — a running task or a
   * registered schedule — as opposed to merely being retained through a grace
   * window (a settling task's follow-up turn, a prediction still being
   * generated). {@link holdsWork} answers "should the pool keep this process";
   * this answers "is there something a rewind would destroy". The two differ
   * exactly on the grace windows, where the honest answer to a rewind is to
   * let go, not to refuse for the length of a timer nobody can see.
   */
  get busyWithWork(): boolean {
    return this.#liveTasks.length > 0 || this.#registeredSchedule;
  }

  /**
   * Take the transport down because a caller needs this conversation fresh.
   *
   * For the rewind path: an idle process is only being *retained* — a grace
   * timer waiting on a turn or a prediction — and handing a truncating resume
   * to a context that already holds the turns being cut is not a thing the
   * CLI can do. Closing is safe exactly because the turn has ended: the
   * pump's `finally` runs, the pool entry goes with it, and the fresh spawn
   * resumes a file nobody is writing. Callers must not attach to this process
   * afterwards — the pump may not have noticed the closure yet.
   */
  release(): void {
    try {
      this.#query?.close();
    } catch {
      // Already gone.
    }
  }

  /**
   * The ledger's current rows, for a caller that missed the event carrying them.
   *
   * The companion to {@link holdsWork} and the answer to the question that one
   * deliberately does not answer: not *whether* there is work, but *what*. Both
   * exist because {@link #flushTasks} has nowhere to put an event between turns,
   * and this one additionally because a window that reloaded has no memory of the
   * events that were emitted while it was alive.
   *
   * A copy, so a caller cannot hold a reference to the ledger's interior and
   * watch it change underneath a render — and `peek` rather than `snapshot`,
   * because a reader must not be able to mark the ledger clean and strand the
   * event a pending change is owed.
   */
  get tasks(): readonly BackgroundTask[] {
    return this.#tasks.peek();
  }

  /** True once the transport is gone. A closed process must never be attached to. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Does this process read and write the store `configDir` names?
   *
   * The store is fixed at spawn — it is the config directory the CLI inherited
   * — so this is an identity fact, not a state one. Split out of
   * {@link canServe} because a cross-profile resume needs the answer on its
   * own: a config-dir mismatch there is not merely "cannot attach", it is
   * "this process must let go of the transcript first". See `createRun`.
   */
  sharesStore(configDir: string | undefined): boolean {
    return configDir === readEnv(this.#input.env, CLAUDE_CONFIG_DIR_ENV);
  }

  /**
   * Is a turn open on this process right now?
   *
   * Narrower than {@link working}, which also counts live tasks and the settle
   * grace; narrower than {@link busyWithWork}, which counts a registered
   * schedule. This is only "is the CLI actively producing a turn" — the one
   * state in which closing the transport destroys words mid-sentence.
   */
  get midTurn(): boolean {
    return !this.#state.ended;
  }

  /**
   * Must this turn be served by a fresh spawn, whatever else `canServe` says?
   *
   * True for exactly one turn: one asking for `bypassPermissions` of a process
   * that was spawned without the opt-in. Public rather than folded into
   * `canServe` because the pool has to act on the same fact *before* it asks
   * — releasing this process, the way it releases one a hand-off leaves behind
   * — and two copies of the predicate would be two things to keep in step.
   */
  needsFreshSpawnFor(input: ResolvedRunInput): boolean {
    return (
      input.permissionMode === 'bypassPermissions' &&
      this.#input.permissionMode !== 'bypassPermissions'
    );
  }

  /**
   * Can this process serve the turn described by `input`?
   *
   * The identity checks are the same three facts a session id resolves under —
   * store, directory, conversation — and every one of them is fixed at spawn.
   * A mismatch is not a downgrade to be reconciled; it is a different
   * conversation, and #98 is what guarantees the store cannot change under one.
   *
   * A fork is deliberately refused. `forkSession` means "branch this into a new
   * conversation", so serving it on the process that owns the original would
   * write the branch into the trunk.
   */
  canServe(input: ResolvedRunInput, configDir: string | undefined): boolean {
    if (this.#closed || this.#disposing !== undefined) return false;
    // A process mid-turn is not attachable. `beginTurn` replaces the active
    // state and queue outright — the invariant `#ensureTurn` documents is that
    // a turn only opens after the last one's `run.end` — so attaching here
    // would strand the first turn's consumer on a queue nobody closes and map
    // its remaining messages with the second turn's state. Refusing sends the
    // caller down the fresh-spawn path with `--resume`, which is safe: the
    // provider serialises the two CLIs on its own transcript.
    if (!this.#state.ended) return false;
    // A prompt is already queued and waiting for the CLI to open its turn. A
    // second one behind it would be answered in an order nobody can predict;
    // the fresh-spawn path serialises the two on the provider's transcript.
    if (this.#pendingTurn !== undefined) return false;
    if (input.forkSession === true) return false;
    /*
     * `bypassPermissions` needs an opt-in this process may not have.
     *
     * The SDK requires `allowDangerouslySkipPermissions: true` alongside that
     * mode, and it is a *spawn-time* option: `setPermissionMode` takes a mode and
     * nothing else, so there is no way to supply the opt-in to a process that is
     * already running. `buildClaudeOptions` sets it from the turn that spawned the
     * process, which means a conversation begun on any other mode has a CLI that
     * will refuse the switch for as long as it lives.
     *
     * It refused quietly. `#applySettings` reports a failed setter to the
     * diagnostic channel and swallows it — right for a speed knob, wrong here —
     * so the chip changed to bypassPermissions, the process stayed on the old
     * mode, and every tool call kept asking. The mode looked broken rather than
     * unapplied, and sending another message did not help, because the same
     * warm process served that turn too.
     *
     * Refusing to serve sends the turn down the fresh-spawn path with
     * `--resume`, which spawns *with* the opt-in and genuinely enters the mode.
     * The reverse never needs this: leaving bypass for a stricter mode is what
     * `setPermissionMode` is for, and tightening asks no permission of anyone.
     */
    if (this.needsFreshSpawnFor(input)) return false;
    if (this.#sessionId === undefined) return false;
    if (input.resumeSessionId !== this.#sessionId) return false;
    if (input.cwd !== this.#input.cwd) return false;
    return this.sharesStore(configDir);
  }

  /**
   * Open the next turn on a process that is already running.
   *
   * The counterpart to `start()`, and the difference between them is the whole
   * point of this work: `start()` spawns a CLI and hands it a prompt, this hands
   * a prompt to one that is already sitting there — with the conversation still
   * in its context, its subagents still running, and its scheduled jobs still
   * registered.
   *
   * Settings are reconciled before the prompt is pushed, never after: a turn
   * that asked for a different model must not have its first token generated by
   * the old one.
   */
  async continueWith(input: ResolvedRunInput): Promise<ClaudeTurn> {
    const prepared = this.#prepareTurn(input);
    await this.#applySettings(turnSettings(input));
    const staged = await this.#stage(input.attachments);
    /*
     * Re-checked after the awaits above, not just at `canServe`: the process
     * can close while settings are being applied to it — that is precisely
     * what a control request to a dying CLI looks like — and `push` on a
     * closed queue is a documented no-op. Without this, the turn would be
     * handed back as started, its prompt silently discarded, and its `run.end`
     * owed by a pump that has already exited: a spinner over a message that
     * went nowhere. `send` carries the same guard for the same window.
     */
    if (this.#closed || this.#disposing !== undefined || this.#promptQueue.closed) {
      throw adapterError(
        'transport',
        'The process serving this conversation closed while the turn was being prepared. Send again to start fresh.',
      );
    }
    /*
     * Not installed as the active turn yet — see {@link #pendingTurn}. The
     * uuid is what lets the CLI's echo be recognised as this prompt rather
     * than as a turn the CLI started for itself; the words are the fallback,
     * as they are for a steer.
     */
    const uuid = randomUUID();
    this.#pendingTurn = { ...prepared, uuid, text: input.prompt };
    this.#promptQueue.push(this.#userMessage(input.prompt, input.attachments, staged, uuid));
    return prepared.turn;
  }

  /**
   * Move the live process onto this turn's settings.
   *
   * Only what differs, so an unchanged turn costs no control requests. Each
   * failure is reported and swallowed rather than failing the turn: the setters
   * are best-effort by nature — a model the account cannot use is refused by the
   * provider either way — and a turn that refused to start because a *speed*
   * knob could not be applied would be worse than one that runs slightly wrong
   * and says so.
   */
  async #applySettings(next: TurnSettings): Promise<void> {
    const query = this.#query;
    if (query === undefined) return;
    const last = this.#settings;
    this.#settings = next;

    const attempt = async (what: string, apply: () => Promise<unknown>): Promise<void> => {
      try {
        await apply();
      } catch (error) {
        this.#deps.diagnostic?.(
          `Run ${this.runId}: could not apply ${what} to the running process.`,
          describe(error),
        );
      }
    };

    if (next.model !== last.model) {
      await attempt('the model', () => query.setModel(next.model));
    }
    if (next.permissionMode !== last.permissionMode && next.permissionMode !== undefined) {
      await attempt('the permission mode', () =>
        query.setPermissionMode(next.permissionMode as PermissionMode),
      );
    }

    /*
     * The flag layer, which mid-session is the only route for all three of
     * these — including effort, which at spawn is a *top-level option* and has
     * no setter of its own. `buildFlagSettings` is deliberately not reused: it
     * composes the spawn-time shape, where effort does not belong.
     *
     * `null` rather than omission for anything that is off. Successive calls
     * shallow-merge top-level keys and `undefined` is dropped by JSON, so
     * omitting a flag leaves the previous turn's value in force — which would
     * make turning fast mode *off* between turns do nothing at all.
     */
    const flags = {
      fastMode: next.fastMode === true ? true : null,
      ultracode: next.ultracode === true ? true : null,
      effortLevel: (next.effort ?? null) as EffortLevel | null,
    };
    const changed =
      next.fastMode !== last.fastMode ||
      next.ultracode !== last.ultracode ||
      next.effort !== last.effort;
    if (changed) {
      await attempt('the thinking and speed settings', () => query.applyFlagSettings(flags));
    }
  }

  /* ------------------------------ retention ------------------------------- */

  /**
   * Does this process still hold something that would die with it?
   *
   * Two answers, and they are different kinds of fact.
   *
   * **Live tasks** are authoritative and current. `background.tasks` carries the
   * whole live set on every change, so an empty one is the provider saying
   * "nothing is running" rather than the absence of news, and the count below is
   * only ever as stale as the last message.
   *
   * **A registered schedule** is neither. `CronCreate`, `ScheduleWakeup` and
   * `/loop` put a job *inside* the process and fire it while the REPL is idle —
   * which is precisely the window a per-turn process never has — and there is no
   * control request that asks a CLI what schedules it holds. `CronList` is a
   * tool the model calls, not something this side can ask. So it is inferred
   * from the one place it is visible: the tool call that registered it, on the
   * stream this pump is already reading.
   *
   * Inferring it is a one-way latch on purpose. Deletion is visible too
   * (`CronDelete`), but counting registrations against deletions would be this
   * module keeping a shadow copy of state it cannot read back, and the failure
   * mode of getting that wrong is a `/loop` silently killed at a turn boundary —
   * the exact defect being fixed. A process that has ever registered one is kept
   * until its conversation is dropped, which is a bounded cost with an obvious
   * upper bound, and it is the honest reading of "we do not know".
   */
  #holdsWork(): boolean {
    return this.#liveTasks.length > 0 || this.#registeredSchedule || this.#settling;
  }

  /** What is being held, for the diagnostic that says why a process stayed. */
  #describeHeld(): string {
    const parts: string[] = [];
    if (this.#liveTasks.length > 0) {
      parts.push(
        this.#liveTasks.length === 1
          ? `1 background task (${this.#liveTasks[0] ?? 'unnamed'})`
          : `${String(this.#liveTasks.length)} background tasks`,
      );
    }
    if (this.#registeredSchedule) parts.push('a registered schedule');
    return parts.join(' and ');
  }

  /**
   * Read what a provider message says about the process, before any turn sees it.
   *
   * Two readers, and keeping them apart is load-bearing rather than tidy. The
   * **live set** below decides whether this process may be closed, and it is read
   * from the raw level and nothing else. The **ledger** is what the delegated-work
   * pane is drawn from, and it merges five different messages into a row each.
   *
   * Letting the ledger answer the retention question would be the tempting
   * simplification and would be wrong: it holds rows for foreground subagents
   * too, which are not outstanding work in the sense retention means, so a
   * process would be pinned open by a task that finished inside its own turn.
   *
   * Structurally checked rather than cast: this runs on every message on the hot
   * path, and a payload the SDK reshapes should degrade to "no news" rather than
   * throw inside the pump.
   */
  #observeMessage(message: SDKMessage): void {
    if (message.type !== 'system') return;
    this.#tasks.observe(message as unknown as { type?: unknown; subtype?: unknown });

    const record = message as unknown as { subtype?: unknown; tasks?: unknown };
    if (record.subtype !== 'background_tasks_changed') return;
    if (!Array.isArray(record.tasks)) return;

    const had = this.#liveTasks.length > 0;
    // Replace, not merge — the payload is the whole live set after the change,
    // which is what makes an empty one authoritative. See `BackgroundTasksEvent`.
    this.#liveTasks = record.tasks.map((task: unknown) =>
      String((task as { description?: unknown }).description ?? 'unnamed task'),
    );

    /*
     * The last task just settled — so do not release the process yet.
     *
     * Measured ordering, and it is the whole reason this exists: the empty set
     * arrives about a tenth of a second *before* the provider's own turn about
     * the work that finished. Releasing on the empty set alone closed the
     * transport underneath that turn, which is to say it killed the one piece of
     * output the user was waiting for.
     *
     * So a settle holds the process for a beat. The turn that follows clears it,
     * and the timer is what guarantees the process is still released if no turn
     * ever comes — a task that settles in silence must not pin a CLI open for the
     * rest of the session.
     */
    if (had && this.#liveTasks.length === 0) this.#awaitSettleTurn();
  }

  /**
   * Put the current row set onto the turn being served, if it changed.
   *
   * The event is run-scoped because every event is, and that has one consequence
   * worth stating plainly: between turns there is nowhere to put it. A task that
   * makes progress while no turn is open updates the ledger and is not announced
   * until something opens one — so a pane's token counts can lag behind the work
   * by the length of that gap, while its own elapsed clock keeps running.
   *
   * In practice the gap closes itself at the moment it matters. A settling task
   * is followed within about a tenth of a second by the provider's own turn about
   * it, which `#ensureTurn` opens and adopts, and the first thing that turn
   * carries is this — so the row settles on screen a beat after it settles in the
   * CLI. What is genuinely lost is mid-flight progress during a long silence, and
   * a row that says "24.1k tokens, as of a minute ago" is a smaller lie than a
   * second event channel would be a cost.
   */
  #flushTasks(): void {
    if (!this.#tasks.dirty || this.#state.ended) return;
    this.#emit({
      type: 'background.tasks',
      // The turn's own envelope, so this takes its place in the same dense `seq`
      // as everything else on the stream rather than beside it.
      ...nextEventEnvelope(this.#state),
      tasks: this.#tasks.snapshot(),
    });
  }

  /**
   * Hold the process briefly for the prediction that follows a finished turn.
   *
   * The SDK generates it *after* the turn's `result` — see
   * {@link ClaudeRunDeps.onSuggestion} — so a pump that left at the turn
   * boundary would close the transport before the one message this feature
   * exists for could arrive. Same shape as {@link #awaitSettleTurn}: a flag the
   * pump's exit condition respects, and a timer that releases the process when
   * nothing comes. Longer grace than the settle turn's, because this wait is an
   * API round-trip rather than a local bookkeeping beat.
   *
   * Armed only for turns that could produce one: somebody listening, and not
   * plan mode — the CLI never predicts after a plan turn, so waiting on one
   * would be ten seconds of nothing after every plan. The CLI's other
   * suppressions (a conversation's first turn, the user's own settings) are
   * invisible from here; the timer absorbs them.
   */
  #awaitSuggestion(): void {
    if (this.#deps.onSuggestion === undefined) return;
    if (this.#settings.permissionMode === 'plan') return;
    this.#awaitingSuggestion = true;
    clearTimeout(this.#suggestionTimer);
    this.#suggestionTimer = setTimeout(() => {
      this.#awaitingSuggestion = false;
      // Nothing came. Release the way the settle grace does — unless a queued
      // turn is still owed, whose own timer will do this.
      if (
        this.#state.ended &&
        this.#pendingTurn === undefined &&
        !this.#holdsWork() &&
        !this.#awaitingQueuedTurn
      ) {
        this.#deps.diagnostic?.(
          `Run ${this.runId}: no predicted prompt arrived; releasing the process.`,
        );
        try {
          this.#query?.close();
        } catch {
          // Already gone.
        }
      }
    }, SUGGESTION_GRACE_MS);
    // Never a reason to keep a Node process alive on its own.
    this.#suggestionTimer.unref?.();
  }

  /**
   * A prediction arrived — stop waiting and hand it up.
   *
   * Trusted as far as prose can be: it is model output bound for a composer,
   * so the only handling here is a trim and a refusal to deliver emptiness.
   * The listener runs inside the pump, so its failures are contained the same
   * way the mapper's are.
   */
  #deliverSuggestion(suggestion: string): void {
    this.#awaitingSuggestion = false;
    clearTimeout(this.#suggestionTimer);
    const onSuggestion = this.#deps.onSuggestion;
    const text = suggestion.trim();
    if (onSuggestion === undefined || text.length === 0) return;
    const sessionId = this.#sessionId;
    try {
      onSuggestion({
        kind: 'run-suggestion',
        runId: this.#state.runId,
        ...(sessionId === undefined ? {} : { sessionId }),
        suggestion: text,
      });
    } catch (error) {
      this.#deps.diagnostic?.(
        `Run ${this.#state.runId}: a suggestion listener threw.`,
        describe(error),
      );
    }
  }

  /**
   * Hold the process for the queued turn a mid-turn steer became.
   *
   * The one delivery mechanism a steer that misses every tool boundary has:
   * the CLI parks it as the next turn, and the drain loop opens that turn the
   * moment the current `result` lands. A pump that left at the turn boundary
   * closed the transport over the parked message — the user's words, rendered
   * as sent, destroyed on the way out ("my message vanished", 2026-08-24).
   * Same shape as {@link #awaitSuggestion}: a flag the pump's exit condition
   * respects, and a timer that releases the process when nothing comes —
   * which here means the steer was folded into the turn that just ended and
   * there is nothing left to wait for.
   *
   * Armed for *every* ending with steers pending, not just successful ones:
   * an interrupted turn is precisely how "stop what you're doing and read my
   * message" is expressed, and the CLI keeps the queue across an interrupt.
   */
  #awaitQueuedTurn(): void {
    this.#awaitingQueuedTurn = true;
    clearTimeout(this.#queuedTurnTimer);
    this.#queuedTurnTimer = setTimeout(() => {
      /*
       * A message accepted but still being staged has nowhere to go if this
       * releases now, so the grace is re-armed instead of expiring. Bounded
       * rather than open-ended: staging always settles, and the `finally` in
       * `send` decrements even when it throws, so at worst this waits one more
       * grace than it needed to.
       */
      if (this.#sendsInFlight > 0) {
        this.#awaitQueuedTurn();
        return;
      }
      this.#awaitingQueuedTurn = false;
      this.#pendingSteers = 0;
      this.#providerQueued = false;
      /*
       * Forgotten along with the count, and for the same reason: this is the
       * adapter concluding that everything queued has been consumed. Anything
       * still listed was read without the echo being recognised, and keeping
       * it would leave a stale entry for a later message with the same words
       * to be matched against — an old sentence stealing a new one's delivery.
       */
      this.#unread.length = 0;
      // Nothing came — the steer was consumed by the fold. Release the way the
      // settle grace does, unless another hold is still on.
      if (
        this.#state.ended &&
        this.#pendingTurn === undefined &&
        !this.#holdsWork() &&
        !this.#awaitingSuggestion
      ) {
        this.#deps.diagnostic?.(
          `Run ${this.runId}: no queued turn arrived; the steer folded in. Releasing the process.`,
        );
        try {
          this.#query?.close();
        } catch {
          // Already gone.
        }
      }
    }, QUEUED_TURN_GRACE_MS);
    // Never a reason to keep a Node process alive on its own.
    this.#queuedTurnTimer.unref?.();
  }

  /** Hold the process briefly for a turn about work that just finished. */
  #awaitSettleTurn(): void {
    this.#settling = true;
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settling = false;
      // Nothing came. Release the way a turn boundary would have, by taking the
      // transport down — the pump's own `finally` does the rest. Unless the
      // suggestion grace or a pending queued turn is still holding: their own
      // timers will do this.
      if (
        this.#state.ended &&
        this.#pendingTurn === undefined &&
        !this.#holdsWork() &&
        !this.#awaitingSuggestion &&
        !this.#awaitingQueuedTurn
      ) {
        this.#deps.diagnostic?.(
          `Run ${this.runId}: background work settled with no turn about it; releasing the process.`,
        );
        try {
          this.#query?.close();
        } catch {
          // Already gone.
        }
      }
    }, SETTLE_GRACE_MS);
    // Never a reason to keep a Node process alive on its own.
    this.#settleTimer.unref?.();
  }

  /**
   * Notice a tool call that leaves something behind in the process.
   *
   * Matched on the tool's name, which is the only handle there is. The set is
   * small and explicit rather than a pattern: a pattern over "does this name
   * look schedule-ish" would eventually match a tool that schedules nothing and
   * pin a process open for the rest of the conversation.
   */
  #observeToolCall(name: string): void {
    if (SCHEDULING_TOOLS.has(name)) this.#registeredSchedule = true;
  }

  /* ------------------------------ lifecycle ------------------------------- */

  /**
   * Kick the SDK off.
   *
   * Separate from the constructor so the run object exists — and therefore
   * `canUseTool` can reach it — before the first message is consumed.
   */
  start(): void {
    // Seed the input pump before the SDK starts pulling, so the first turn has
    // its prompt waiting rather than racing for it.
    this.#promptQueue.push(
      this.#userMessage(this.#input.prompt, this.#input.attachments, this.#openingStaged),
    );
    // Released once consumed: the payloads are large, and the run has no reason
    // to keep the opening turn's attachments alive for its whole lifetime.
    this.#openingStaged = [];

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

    // Resolved once per launch rather than per turn: the server instance holds
    // the handlers, and rebuilding it mid-conversation would hand the SDK a
    // different tool set for the same run.
    const hostServers = this.#deps.agentToolServers?.(this.#state.runId, this.#input);

    let sdkQuery: Query;
    try {
      sdkQuery = query({
        prompt: this.#promptQueue,
        options: buildClaudeOptions(this.#input, {
          canUseTool: this.#canUseTool,
          abortController: this.#abort,
          stderr: (data) => this.#captureStderr(data),
          hostEnv: this.#deps.hostEnv,
          ...(this.#deps.onSuggestion === undefined ? {} : { promptSuggestions: true }),
          ...(this.#deps.rewind === undefined ? {} : { rewind: this.#deps.rewind }),
          ...(this.#deps.sdkExecutablePath === undefined
            ? {}
            : { sdkExecutablePath: this.#deps.sdkExecutablePath }),
          ...(hostServers === undefined ? {} : { mcpServers: hostServers }),
        }),
      });
    } catch (error) {
      // `query()` itself failed — usually a missing runtime, sometimes a bad
      // cwd wearing a missing runtime's clothes. The run still has to produce a
      // terminal event; a rejected promise from `createRun` would leave a
      // caller that already subscribed with a stream that never ends.
      //
      // Not awaited: `start()` is synchronous by design so the run object is
      // fully constructed before `createRun` returns. The event queue buffers,
      // so a terminal event one tick later is indistinguishable to a consumer
      // iterating `events`.
      void this.#failToLaunch(error);
      return;
    }

    this.#query = sdkQuery;
    this.#pumpDone = this.#pump(sdkQuery);
  }

  /**
   * How one turn is doing.
   *
   * Takes the turn rather than reading the active one, because the caller
   * holding a `Run` is asking about *its* turn — and `awaiting_permission` is
   * the reason that distinction matters: the pending map is the process's, so a
   * prompt parked by a later turn must not make an earlier, finished one report
   * that it is waiting for an answer.
   */
  statusOf(state: ClaudeMapperState): RunStatus {
    if (state.ended) return 'ended';
    if (this.isActive(state) && this.#pending.size > 0) return 'awaiting_permission';
    if (state.sessionStarted) return 'running';
    return 'starting';
  }

  /* -------------------------------- control -------------------------------- */

  /**
   * Push more text at the running turn.
   *
   * ## Why this reports `deliveredImmediately: false`
   *
   * The text does reach the CLI immediately — it is written to the subprocess
   * the moment it is pushed. What the adapter cannot know is whether it *takes
   * effect* in the turn that is running. The CLI only folds a mid-turn message
   * in at a tool-batch boundary; a turn that is composing its final, tool-free
   * response has no boundary left, so the message instead becomes a separate
   * queued turn — which the pump now stays alive to serve (see
   * {@link #awaitQueuedTurn}): the queued turn opens as a continuation of this
   * conversation instead of dying with the transport, which is what used to
   * happen and read as "my message vanished".
   *
   * Of the three honest answers the seam allows — steer, queue and report
   * `false`, or reject — only "queue and report `false`" is true in both cases.
   * Returning `true` would be a guarantee this layer has no way to make.
   * `midRunSteering` stays `true` because the fold genuinely works and is the
   * common case; this is about not overstating it.
   *
   * The refusals carry `details.reason: 'run_ended'` because the renderer's
   * steer path branches on exactly that — `isEndedRunError` — to carry the
   * user's words into a fresh run instead of stranding them under a red
   * banner. Both windows here *are* that race: the run ended (or began
   * shutting down) between the keystroke and the call landing.
   */
  async send(
    text: string,
    attachments?: readonly Attachment[],
    messageId?: MessageId,
  ): Promise<SendResult> {
    // A turn waiting for the CLI to open it is live for this purpose: the
    // steer queues behind its prompt, as it would had the CLI already begun.
    // See `#pendingTurn`.
    if (this.#state.ended && this.#pendingTurn === undefined) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} has already ended; start a new run with resumeSessionId to continue.`,
        { details: { reason: 'run_ended', runId: this.runId } },
      );
    }

    // Teardown closes the prompt queue at step 2 but only marks the run ended
    // at step 6, with up to two 4s grace waits in between — and `push` on a
    // closed queue is a documented no-op. Without this guard a send landing in
    // that window is discarded and still reports success.
    if (this.#disposing !== undefined || this.#promptQueue.closed) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} is shutting down and cannot accept more input.`,
        { details: { reason: 'run_ended', runId: this.runId } },
      );
    }

    /*
     * Counted before the staging below, and this is the whole of the fix for
     * "the interrupt stops the session instead of reading my message"
     * (2026-08-27).
     *
     * Staging is real filesystem work, and the turn is free to end during it —
     * an interrupt is *when* a user types the correction, so it is the ending
     * most likely to land here. Every fact the pump reads to decide whether to
     * keep the process used to be written on the far side of that await, so it
     * found nothing holding, left the loop, and its `finally` closed the prompt
     * queue. The push that landed a moment later was a documented no-op on a
     * closed queue: a message reported as sent, rendered as sent, delivered to
     * nobody, and the transport it was addressed to gone with it.
     *
     * Held in a `finally` rather than cleared on the happy path, because a
     * staging failure must not pin the process open for the rest of the
     * conversation.
     */
    this.#sendsInFlight += 1;
    let staged: readonly StagedAttachment[];
    try {
      // Staged outside any queue guard, so a staging failure surfaces as itself
      // rather than as a message that silently lost its files.
      staged = await this.#stage(attachments);
    } finally {
      this.#sendsInFlight -= 1;
    }

    /*
     * Re-checked after the await, the way `continueWith` already does for the
     * same window. The hold above keeps the process across an ordinary send,
     * but it is bounded by `QUEUED_TURN_GRACE_MS` — staging that outlasts the
     * grace arrives at a queue that is genuinely closed, and the honest answer
     * then is a refusal the renderer can act on. `run_ended` is what
     * `isEndedRunError` branches on to carry the user's words into a fresh run
     * instead of stranding them under a red banner.
     */
    if (this.#disposing !== undefined || this.#promptQueue.closed) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} ended while this message was being prepared; it was not delivered.`,
        { details: { reason: 'run_ended', runId: this.runId } },
      );
    }

    /*
     * The identity the CLI will know this message by.
     *
     * Minted here rather than derived from `messageId`, because the field is
     * typed `UUID` on the wire and Artemis's own ids are not shaped like one.
     * The pairing is remembered instead — see {@link #unread} — which is all
     * that is needed to answer in the caller's id space later.
     */
    const uuid = randomUUID();
    this.#promptQueue.push(this.#userMessage(text, attachments, staged, uuid));
    /*
     * Recorded only when the caller named the message. A caller that did not
     * want to hear about delivery is not made to: nothing is tracked, no
     * `message.delivered` is emitted, and the behaviour is exactly what it was
     * before this existed.
     */
    if (messageId !== undefined) {
      this.#unread.push({ uuid, messageId, text, sentAt: Date.now() });
      this.#watchDeliveries();
    }
    // Counted *after* the push it describes: this is what keeps the pump alive
    // past the next `result` if no tool boundary folds the message in first.
    this.#pendingSteers += 1;
    return { deliveredImmediately: false };
  }

  /**
   * Notice the CLI reading a message this process is still waiting on.
   *
   * The one observable moment a fold has. The CLI echoes every user turn back
   * on its own stream as it writes it to the transcript — including the ones
   * Artemis itself sent, which `mapUserMessage` drops on sight so a window does
   * not show someone their own words twice. That drop is right for the
   * transcript and wrong for everything else: the echo is the *only* news that
   * a queued message has been read, and throwing it away left a queued
   * indicator with nothing to clear it but the end of the run. It went on
   * saying "1 message queued" while the agent was plainly acting on the
   * message, which is the bug this exists to fix.
   *
   * Read here rather than in the mapper on purpose. The mapper turns provider
   * messages into transcript meaning, and this is not a row — it is a fact
   * about timing that only the side holding the send bookkeeping can resolve.
   *
   * Replays are skipped: a resumed conversation reads its whole history back,
   * and an old turn arriving as history is not this turn's message being taken
   * up. So are synthesised turns, which the harness wrote rather than the user.
   */
  #observeDelivery(message: SDKMessage): readonly AgentEvent[] {
    if (this.#unread.length === 0) return [];
    /*
     * Nothing may be emitted onto a finished turn, and an echo that lands
     * between one turn's `result` and the next turn's `init` would be exactly
     * that. The entry is deliberately left in place rather than consumed: the
     * turn about to open is the one reading the message, and it will echo it
     * again on a state that can carry the news.
     */
    if (this.#state.ended) return [];
    if (message.type !== 'user') return [];
    if ('isReplay' in message && message.isReplay === true) return [];
    if (message.isSynthetic === true) return [];

    const uuid = message.uuid;
    const byId = this.#unread.findIndex((entry) => entry.uuid === uuid);
    /*
     * The fallback: the words, oldest first. Reached whenever the echo does not
     * carry the id it was sent with, which is the ordinary case for a fold —
     * the CLI takes a queued message as a `queued_command` attachment that
     * keeps the original only as `source_uuid` and is minted under an id of its
     * own. The uuid path alone would read every fold as "never delivered",
     * which is the original bug with extra steps.
     *
     * Containment rather than equality, because the words arrive wrapped at
     * both ends. A folded message is framed for the model — "The user sent a
     * new message while you were working:" — and a message carrying files is
     * sent with a line about them appended (`describeStagedAttachments`). What
     * survives both is the user's own sentence, in the middle.
     *
     * Loose only in isolation: the candidates are the handful of messages this
     * process sent and has not been told were read, so the question is which of
     * those the echo is, not whether it is one of them.
     */
    const echo = echoedText(message);
    const matched =
      byId >= 0
        ? byId
        : this.#unread.findIndex((entry) => entry.text !== '' && echo.includes(entry.text));
    if (matched < 0) return [];

    const [entry] = this.#unread.splice(matched, 1);
    if (entry === undefined) return [];
    return [
      {
        type: 'message.delivered',
        ...nextEventEnvelope(this.#state),
        messageId: entry.messageId,
      },
    ];
  }

  /**
   * Start tailing the transcript for folds, if nothing is tailing it already.
   *
   * `unref` so an outstanding message never holds the process open on its own:
   * the poll is an observer of work, not work.
   */
  #watchDeliveries(): void {
    if (this.#deliveryTimer !== undefined || this.#closed) return;
    const timer = setInterval(() => {
      void this.#pollDeliveries();
    }, DELIVERY_POLL_MS);
    timer.unref?.();
    this.#deliveryTimer = timer;
  }

  #stopDeliveryWatch(): void {
    if (this.#deliveryTimer !== undefined) clearInterval(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
  }

  /**
   * Where the CLI writes this conversation.
   *
   * `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric turned into
   * a dash>/<sessionId>.jsonl`. The CLI munges its *resolved* working
   * directory, which on macOS differs from the one Artemis passed whenever a
   * symlink is involved (`/tmp` is really `/private/tmp`) — so both spellings
   * are candidates and whichever exists wins. Cached on first hit; until the
   * CLI's first write there is nothing to find and the next poll retries.
   */
  async #deliveryPath(): Promise<string | undefined> {
    if (this.#deliveryFile !== undefined) return this.#deliveryFile;
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return undefined;

    const configDir = readEnv(this.#input.env, CLAUDE_CONFIG_DIR_ENV) ?? join(homedir(), '.claude');
    const cwd = this.#input.cwd;
    const candidates = [cwd, await realpath(cwd).catch(() => cwd)];
    for (const dir of new Set(candidates)) {
      const file = join(configDir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
      const found = await stat(file)
        .then((info) => info.isFile())
        .catch(() => false);
      if (found) {
        this.#deliveryFile = file;
        return file;
      }
    }
    return undefined;
  }

  /**
   * One tail read: the bytes appended since last time, scanned for removes.
   *
   * Every failure path declines quietly and leaves the entry in place — a
   * transcript that cannot be read costs the fold's timeliness, not the
   * message, because {@link #ensureTurn} still clears the queue when the next
   * turn consumes it.
   */
  async #pollDeliveries(): Promise<void> {
    if (this.#closed) {
      this.#stopDeliveryWatch();
      return;
    }
    // A live turn can carry what an ended one could not.
    if (this.#deliveredPendingEmit.length > 0 && !this.#state.ended) {
      for (const messageId of this.#deliveredPendingEmit.splice(0)) {
        this.#emit({ type: 'message.delivered', ...nextEventEnvelope(this.#state), messageId });
      }
    }
    if (this.#unread.length === 0 && this.#deliveredPendingEmit.length === 0) {
      this.#stopDeliveryWatch();
      return;
    }
    if (this.#unread.length === 0) return;

    const file = await this.#deliveryPath();
    if (file === undefined) return;

    let handle;
    try {
      handle = await open(file, 'r');
    } catch {
      return;
    }
    try {
      const size = (await handle.stat()).size;
      if (this.#deliveryOffset < 0) {
        // First read: start near the tail — the watch began at send time and
        // the fold strictly follows it. From a line boundary's perspective the
        // window may open mid-row; the remainder logic below discards that
        // fragment as unparseable, which is correct: a row it cannot read in
        // full is a row from before the watch existed.
        this.#deliveryOffset = Math.max(0, size - DELIVERY_FIRST_READ_BYTES);
      }
      if (size < this.#deliveryOffset) {
        // Truncated or replaced under the watch. Start over at the beginning:
        // stale matches are fenced by each entry's own send time.
        this.#deliveryOffset = 0;
        this.#deliveryRemainder = '';
      }
      if (size === this.#deliveryOffset) return;

      const length = Math.min(size - this.#deliveryOffset, DELIVERY_FIRST_READ_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.#deliveryOffset);
      if (bytesRead <= 0) return;
      this.#deliveryOffset += bytesRead;

      const chunk = this.#deliveryRemainder + buffer.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n');
      this.#deliveryRemainder = lines.pop() ?? '';
      for (const line of lines) this.#noticeDeliveryRow(line);
    } catch {
      // Next tick retries from the same offset.
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Read one transcript row for the fact that a queued message was consumed.
   *
   * Two row shapes say so — `queue-operation`/`remove` carries the exact text,
   * and the `queued_command` attachment carries the same text as `prompt` —
   * and either is accepted, first match wins. The `enqueue` operation carries
   * identical text and means the opposite, so the operation is checked, not
   * just the shape. A row older than the entry is someone else's: the same
   * words sent twice must not let the first send's row deliver the second.
   */
  #noticeDeliveryRow(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    let text: string | undefined;
    if (row['type'] === 'queue-operation' && row['operation'] === 'remove') {
      if (typeof row['content'] === 'string') text = row['content'];
    } else if (row['type'] === 'attachment') {
      const attachment = row['attachment'] as Record<string, unknown> | undefined;
      if (
        attachment !== undefined &&
        attachment['type'] === 'queued_command' &&
        typeof attachment['prompt'] === 'string'
      ) {
        text = attachment['prompt'];
      }
    }
    if (text === undefined) return;

    const rowAt = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : Number.NaN;
    const matched = this.#unread.findIndex(
      (entry) =>
        entry.text === text &&
        (Number.isNaN(rowAt) || rowAt >= entry.sentAt - DELIVERY_TIMESTAMP_SLACK_MS),
    );
    if (matched < 0) return;

    const [entry] = this.#unread.splice(matched, 1);
    if (entry === undefined) return;
    if (this.#state.ended) {
      this.#deliveredPendingEmit.push(entry.messageId);
      return;
    }
    this.#emit({
      type: 'message.delivered',
      ...nextEventEnvelope(this.#state),
      messageId: entry.messageId,
    });
  }

  /**
   * Ask the provider to stop one delegated task.
   *
   * Deliberately says nothing about turns. A task outliving its turn is the
   * ordinary case here, and the process is what holds the control channel; a
   * gate on the active turn would refuse precisely the stops worth making.
   *
   * The task is not stopped when this resolves — it is stopped when the provider
   * says so, which arrives as a `task_notification` with status `stopped` and
   * settles the row through the same path a natural finish takes. Failures are
   * reported and swallowed: an id that has already settled is not a mistake, and
   * a control channel that will not answer is not something a person clicking a
   * row can do anything about.
   */
  async stopTask(taskId: string): Promise<void> {
    const sdkQuery = this.#query;
    if (sdkQuery === undefined || this.#closed) return;
    try {
      await sdkQuery.stopTask(taskId);
    } catch (error) {
      this.#deps.diagnostic?.(`Could not stop task ${taskId}.`, describe(error));
    }
  }

  async interrupt(): Promise<InterruptResult> {
    // "Stop" is idempotent by nature; a run that already stopped is not an error.
    if (this.#state.ended) return { stillQueued: [] };

    this.#state.interruptRequested = true;

    const sdkQuery = this.#query;
    if (sdkQuery === undefined) {
      await this.dispose();
      return { stillQueued: [] };
    }

    try {
      const response = await withTimeout(sdkQuery.interrupt(), INTERRUPT_TIMEOUT_MS);
      const stillQueued = response?.still_queued ?? [];
      /*
       * Recorded rather than acted on here, because the turn has not ended yet
       * — the receipt is written *before* the interrupted turn's result, which
       * is the whole reason it can be trusted at this point. Arming the grace
       * from here would start a timer against a turn that is still running and
       * zero the steer count underneath it; the pump reads this at the
       * boundary instead, where the decision actually belongs.
       *
       * One-way for the life of the process, cleared only by the turn that
       * consumes the queue (`#ensureTurn`) or by the grace expiring. A stale
       * `true` costs a five-second hold on a process that was going to be
       * released; a missed `true` costs the user's message.
       */
      if (stillQueued.length > 0) this.#providerQueued = true;
      /*
       * Answered in the caller's id space, which it can only be now that the
       * outgoing message carries an id at all: the receipt lists uuid-stamped
       * messages, Artemis stamped none until `send` began doing so, and the
       * list was therefore never able to name one of this app's own steers.
       *
       * Unknown uuids are dropped rather than passed through, on the SDK's own
       * advice — the list may carry ids this client never sent (cron triggers,
       * auto-resume continuations), and a caller matching them against its rows
       * would find nothing and could not tell that from a bug. The count is
       * still honest for what it names: these are the messages that survive.
       */
      const survived = stillQueued.flatMap((uuid) => {
        const entry = this.#unread.find((one) => one.uuid === uuid);
        return entry === undefined ? [] : [entry.messageId as string];
      });
      return { stillQueued: survived };
    } catch (error) {
      // The control channel did not answer. Do not leave the user holding a
      // Stop button that did nothing: force the transport down and let the pump
      // emit `run.end` with reason 'interrupted'.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: interrupt did not complete, forcing teardown.`,
        describe(error),
      );
      this.#abort.abort();
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

    const { result, droppedUpdates } = toPermissionResult(decision, {
      toolUseID: entry.toolUseID,
      toolName: entry.toolName,
      question: entry.question,
      input: entry.input,
    });

    if (droppedUpdates.length > 0) {
      // The SDK's deny branch has no `updatedPermissions` field, so a "never
      // allow this" rule attached to a denial cannot be forwarded.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: ${String(droppedUpdates.length)} permission update(s) could not be persisted with a denial.`,
      );
    }

    entry.deferred.resolve(result);
    this.#emitResolved(
      requestId,
      decision.behavior === 'allow' ? 'allowed' : 'denied',
      decision.behavior === 'deny' ? decision.message : undefined,
      decision.behavior === 'allow' ? decision.answers : undefined,
    );
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#teardown();
    return this.#disposing;
  }

  /* -------------------------------- internals ------------------------------ */

  async #teardown(): Promise<void> {
    this.#state.disposeRequested = true;
    this.#detachAbortSignal?.();

    // 1. Unblock the provider first. `canUseTool` is parked on a promise; if
    //    nobody settles it, the SDK never returns and neither does close().
    this.#denyAllPending(DISPOSED_DENY_MESSAGE);

    // 2. End the input stream so the SDK's prompt iterable completes.
    this.#promptQueue.close();

    // 3. Ask the SDK to shut its transport down. `close()` is synchronous and
    //    returns void — there is no `dispose()` on Query.
    try {
      this.#query?.close();
    } catch {
      // Already gone. Nothing to do, and nothing worth reporting.
    }

    // 4. Give the pump a chance to emit `run.end` from the SDK's own result.
    await settleWithin(this.#pumpDone, DISPOSE_GRACE_MS);

    // 5. Still alive? Abort hard.
    if (!this.#state.ended) {
      this.#abort.abort();
      await settleWithin(this.#pumpDone, DISPOSE_GRACE_MS);
    }

    // 6. Drop the staged attachments, now that the process that could read them
    //    is gone. After the process, so a turn still winding down cannot lose a
    //    file out from under itself.
    //
    //    Safe to delete: the model has already been sent whatever it was going
    //    to be sent, and a resumed session replays the provider's own stored
    //    transcript — which holds the text of the turn, including the paths. A
    //    resumed run that tries to re-open one gets a plain "no such file",
    //    which is the honest answer: the file was the user's, and it was
    //    attached to a conversation that has since ended.
    await removeStagingDirectory(this.#stagingDir, (message) => {
      this.#deps.diagnostic?.(`Run ${this.runId}: ${message}`);
    });

    // 7. Guarantee the contract even if the SDK never came back at all: exactly
    //    one `run.end`, and a stream that terminates.
    this.#finalize('disposed');
    this.#eventQueue.close();
    this.#abandonPending('disposed');
    this.#denyAllPending(DISPOSED_DENY_MESSAGE);
  }

  /**
   * Whose turn is the CLI on? Decide from the messages, then route them.
   *
   * While {@link #pendingTurn} is set and the served turn has ended, every
   * message is held in {@link #undecided} until one says who the turn belongs
   * to: a user message that is the pending prompt's echo — its uuid, or its
   * words — means the CLI has opened *our* turn, which is installed and given
   * the held messages in order; any other user message, or a `result` before
   * one, means the CLI is running a turn of its own first, which becomes a
   * continuation exactly as it would have had nothing been waiting, and our
   * prompt stays queued behind it for the next decision.
   *
   * `'pass'` when nothing is pending: the caller handles the message itself.
   */
  #defer(message: SDKMessage): 'pass' | 'deferred' | 'handled' | 'exit' {
    const pending = this.#pendingTurn;
    if (pending === undefined || !this.#state.ended) return 'pass';

    if (message.type === 'user') {
      const echo = message as SDKUserMessage;
      const mine =
        echo.uuid === pending.uuid ||
        (pending.text !== '' && echoedText(echo).includes(pending.text));
      return this.#decide(mine ? 'mine' : 'foreign', message);
    }
    /*
     * A turn that ended without echoing any user message is read as ours.
     *
     * The CLI echoes every user turn it opens — the prompt, or the harness's
     * own notification — so a turn with no echo at all is one the SDK's
     * wire has simply not narrated, and the only honest attribution is the
     * one every turn had before this decision existed: the prompt that was
     * queued. Reading it as foreign instead would strand the prompt on a
     * turn that never opens.
     */
    if (message.type === 'result') return this.#decide('mine', message);

    this.#undecided.push(message);
    return 'deferred';
  }

  #decide(owner: 'mine' | 'foreign', message: SDKMessage): 'handled' | 'exit' {
    const pending = this.#pendingTurn as PendingTurn;
    if (owner === 'mine') {
      this.#pendingTurn = undefined;
      this.#install(pending);
      this.#deps.diagnostic?.(`Run ${pending.state.runId}: the CLI opened the turn for its prompt.`);
    } else {
      this.#deps.diagnostic?.(
        `Run ${pending.state.runId}: the CLI is running a turn of its own first; the prompt stays queued behind it.`,
      );
      // Nobody to report the CLI's own turn to: its messages are dropped, as
      // the pump drops any events that have no turn. Ours is still waiting.
      if (!this.#ensureTurn()) {
        this.#undecided.length = 0;
        return 'handled';
      }
    }

    const batch = [...this.#undecided.splice(0), message];
    let exit = false;
    for (const one of batch) {
      if (this.#handle(one)) exit = true;
    }
    return exit ? 'exit' : 'handled';
  }

  /**
   * One provider message, onto the turn being served.
   *
   * The body of the pump's loop, and the reason it is a method: a message
   * whose turn was not known when it arrived is handled later, from
   * {@link #decide}, by exactly this. Returns whether the pump should leave
   * its loop — the turn ended and nothing holds the process.
   */
  #handle(message: SDKMessage): boolean {
    /*
     * Before mapping, and deliberately not from the mapped events.
     *
     * `mapSdkMessage` returns nothing once a turn's state is `ended` — it is
     * a per-turn mapper and that is the right rule for a transcript. But the
     * message that releases this process arrives *after* a turn has ended, by
     * definition: it is the provider saying the work that outlived the turn
     * has finished. Reading retention off the mapped stream meant never
     * seeing it, and a process kept alive for work that had already settled.
     */
    this.#observeMessage(message);

    // An `init` after the last turn ended is the provider starting one of its
    // own — it emits one per turn in streaming mode, which is what makes this
    // detectable at all. Before mapping, so the `init` itself lands on the new
    // turn and becomes its `session.started` rather than being dropped by a
    // mapper that is finished with the old state.
    if (startsTurn(message)) this.#ensureTurn();

    /*
     * After `#ensureTurn`, so a steer the CLI parked and is now running as
     * a turn of its own reports its delivery on *that* turn's stream rather
     * than on the closed state of the one it was typed into. Before the
     * mapping below, so "your message was read" arrives ahead of the work
     * the agent did about it.
     */
    for (const event of this.#observeDelivery(message)) this.#emit(event);

    let events: readonly AgentEvent[] = [];
    try {
      events = mapSdkMessage(message, this.#state);
    } catch (error) {
      // A mapping bug must degrade to a missing event, never to a dead
      // transcript. The run keeps going.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: failed to map a provider message.`,
        describe(error),
      );
    }

    for (const event of events) {
      // A schedule is only ever visible as the call that registered it, and
      // a call only happens inside a turn — so this one is read off the
      // mapped stream, where the tool's name has already been dug out of the
      // assistant message's content blocks.
      if (event.type === 'tool.start') this.#observeToolCall(event.name);
      this.#emit(event);
    }

    // After the turn's own events, so a row set describing what a tool call
    // just launched arrives after the call that launched it.
    this.#flushTasks();

    // Announced from here rather than from `beginTurn`, because this is where
    // it becomes true: the id arrives on the turn's own `init`, and for a
    // fresh conversation the CLI is what mints it. Once, on the first turn to
    // learn it — every later turn on this process reports the same one.
    if (this.#sessionId === undefined && this.#state.sessionId !== undefined) {
      this.#sessionId = this.#state.sessionId;
      this.#deps.onSession?.(this.#state.sessionId, this);
    }

    /*
     * The turn is over. Whether the *process* is over is a different
     * question, and this is where the two used to be the same one.
     *
     * Leaving the loop closes the transport in the `finally` below, which is
     * right when nothing is left running and wrong when something is: the
     * `Agent` tool backgrounds by default and `Workflow` is always async, so
     * work routinely outlives the turn that launched it and used to be
     * killed here. Staying in the loop keeps the process, its subagents and
     * its scheduled jobs alive, and leaves the pump reading a stream that
     * still has things to say — the provider takes a turn of its own when a
     * task settles.
     *
     * The turn itself ended properly either way: `run.end` was emitted above
     * and its queue is closed, so a caller's `for await` has already
     * finished. What continues is the process, with no active turn until
     * something opens one.
     */
    if (this.#state.ended) {
      // A successful ending is the one kind the provider predicts after —
      // it skips errors and interruptions itself, so waiting on those
      // would hold a process for a message that is not coming.
      if (message.type === 'result' && message.subtype === 'success' && !message.is_error) {
        this.#awaitSuggestion();
      }
      /*
       * Steers the turn never folded in are parked in the CLI's queue as
       * the next turn, and this boundary is the moment that used to
       * destroy them: leaving the loop closes the transport in the
       * `finally`, queue and all. Held for every ending kind — an
       * interrupt is exactly how "stop and read my message" is said, and
       * the queue survives it by design.
       *
       * Three sources, because no one of them sees the whole picture. The
       * count is what this adapter pushed. A send in flight is a message
       * the user has already been told was accepted but that is still
       * being staged — see {@link send}. And the interrupt receipt is the
       * provider's own promise to run something, which is the only
       * evidence there is for a message the CLI queued for itself.
       */
      if (this.#pendingSteers > 0 || this.#sendsInFlight > 0 || this.#providerQueued) {
        this.#awaitQueuedTurn();
      }
      if (
        this.#pendingTurn === undefined &&
        !this.#holdsWork() &&
        !this.#awaitingSuggestion &&
        !this.#awaitingQueuedTurn
      ) {
        return true;
      }
      if (this.#holdsWork()) {
        this.#deps.diagnostic?.(
          `Run ${this.runId}: turn ended with ${this.#describeHeld()} still live; keeping the process.`,
        );
      }
    }
    return false;
  }

  async #pump(sdkQuery: Query): Promise<void> {
    try {
      for await (const message of sdkQuery) {
        /*
         * Before everything, because it belongs to no turn: the prediction is
         * generated after the turn it follows has ended, and the mapper would
         * rightly drop it as events on a closed state. Handled, then the exit
         * the arrival un-blocks is taken here rather than waiting for a next
         * message that may never come.
         */
        if (message.type === 'prompt_suggestion') {
          this.#deliverSuggestion(message.suggestion);
          if (
            this.#state.ended &&
            this.#pendingTurn === undefined &&
            !this.#holdsWork() &&
            !this.#awaitingQueuedTurn
          ) {
            break;
          }
          continue;
        }

        // A turn is waiting for the CLI to say it has begun. Until it does,
        // nothing can be mapped, because nothing is known to be its.
        const verdict = this.#defer(message);
        if (verdict === 'deferred' || verdict === 'handled') continue;
        if (verdict === 'exit') break;

        if (this.#handle(message)) break;
      }

      if (!this.#state.ended) {
        // The stream ended without a `result` message — the transport closed
        // cleanly but early.
        this.#finalize(this.#exitReason('completed'));
      }
    } catch (error) {
      if (!this.#state.ended) {
        const agentError = toAgentError(error, 'transport');
        if (agentError.code === 'cancelled') {
          this.#finalize(this.#exitReason('interrupted'));
        } else {
          this.#finalize('error', this.#withStderr(await this.#explainLaunchFailure(agentError)));
        }
      }
    } finally {
      // Before anything else: the pool must not hand out a process whose
      // transport is on its way down, or the next message attaches to a CLI that
      // is about to stop reading it and waits for a turn that never starts.
      this.#closed = true;
      this.#abandonPending();
      this.#settling = false;
      clearTimeout(this.#settleTimer);
      this.#awaitingSuggestion = false;
      clearTimeout(this.#suggestionTimer);
      this.#awaitingQueuedTurn = false;
      clearTimeout(this.#queuedTurnTimer);
      this.#stopDeliveryWatch();
      this.#deps.onClosed?.(this);

      try {
        sdkQuery.close();
      } catch {
        // Already closed.
      }
      this.#denyAllPending(DISPOSED_DENY_MESSAGE);
      this.#promptQueue.close();
      this.#eventQueue.close();
      this.#detachAbortSignal?.();

      // The transport is gone, so nothing can read the staged files any more —
      // and for a run that ends naturally this is the only place that hears
      // about it: `release()` is a no-op on purpose, and dispose() never runs.
      // Left behind, these are copies of the user's own files sitting in /tmp
      // after the conversation ended. Harmless to repeat under `#teardown`,
      // which also removes it: removal is best-effort and force-recursive.
      await removeStagingDirectory(this.#stagingDir, (message) => {
        this.#deps.diagnostic?.(`Run ${this.runId}: ${message}`);
      });
    }
  }

  /**
   * End a run that never started, with a message that names the real cause.
   *
   * Split out of `start()` because the diagnosis is asynchronous — it stats the
   * working directory — and `start()` must not be.
   */
  async #failToLaunch(error: unknown): Promise<void> {
    const explained = await this.#explainLaunchFailure(toAgentError(error, 'provider_not_found'));
    this.#finalize('error', this.#withStderr(explained));
    this.#eventQueue.close();
    // No process ever opened, so no pump `finally` will ever run — without this
    // the staged copies of the user's files would outlive a run that never
    // started at all.
    await removeStagingDirectory(this.#stagingDir, (message) => {
      this.#deps.diagnostic?.(`Run ${this.runId}: ${message}`);
    });
  }

  /**
   * Re-attribute a launch failure that is really a bad working directory.
   *
   * ## The bug this exists for
   *
   * `spawn` raises `ENOENT` for a missing *executable* **and** for a missing
   * *cwd*, and the two are indistinguishable from the errno. The Agent SDK
   * guesses the first, and guesses confidently: point a run at a directory that
   * does not exist and it reports that the native binary "exists but failed to
   * launch", most likely because it "does not match this system's libc" — a
   * glibc-versus-musl theory, on macOS, about a folder that is not there. A
   * user reading that has no path to the actual fix.
   *
   * So on any failure that looks like a launch failure, the directory is
   * checked. If it is genuinely unusable, that becomes the headline and the
   * provider's own words are kept underneath: the underlying error is
   * **wrapped, never swallowed**, because if the diagnosis is ever wrong the
   * original message is the only way anyone will find out. If the directory is
   * fine, the cwd is still appended — the next time this happens, the message
   * names the directory instead of leaving it to be guessed at.
   */
  async #explainLaunchFailure(error: AgentError): Promise<AgentError> {
    if (!looksLikeLaunchFailure(error)) return error;

    let check;
    try {
      check = await checkWorkingDirectory(this.#input.cwd);
    } catch {
      // The diagnosis is a courtesy. Never let it replace the real failure.
      return error;
    }

    if (check.ok) {
      return {
        ...error,
        message: `${error.message} (working directory: ${this.#input.cwd})`,
      };
    }

    return {
      ...error,
      code: 'invalid_request',
      retryable: false,
      message:
        `${check.message} Claude could not be started because its working directory cannot be used. ` +
        `The provider reported: ${error.message}`,
    };
  }

  /** Artemis's own intent outranks whatever the transport reports. */
  #exitReason(fallback: RunEndReason): RunEndReason {
    if (this.#state.disposeRequested) return 'disposed';
    if (this.#state.interruptRequested) return 'interrupted';
    if (this.#state.permissionDenyInterrupted) return 'permission_denied';
    return fallback;
  }

  #finalize(reason: RunEndReason, error?: AgentError): void {
    for (const event of finalizeRun(this.#state, reason, { error })) this.#emit(event);
  }

  /**
   * End a turn the CLI never opened.
   *
   * The process is going — its transport closed, or it was disposed — with a
   * prompt still queued for a turn that will now never start. The turn's
   * consumer is waiting on its stream, and the contract is one `run.end` and
   * a stream that terminates; the caller's cure is the one `continueWith`
   * names for the same window.
   */
  #abandonPending(reason: RunEndReason = 'error'): void {
    const pending = this.#pendingTurn;
    if (pending === undefined) return;
    this.#pendingTurn = undefined;
    this.#undecided.length = 0;
    this.#install(pending);
    this.#finalize(
      reason,
      reason === 'error'
        ? {
            code: 'transport',
            message:
              'The process serving this conversation closed before it could start this turn. Send again to start fresh.',
          }
        : undefined,
    );
    this.#eventQueue.close();
  }

  #emit(event: AgentEvent): void {
    if (this.#eventQueue.closed) return;
    this.#eventQueue.push(event);
    // Nothing follows `run.end`: the stream terminates with it, which is what
    // lets a consumer's `for await` finish on its own.
    if (event.type === 'run.end') this.#eventQueue.close();
  }

  /**
   * One user turn, as the SDK's streaming input wants it.
   *
   * Three things can end up in it, and they arrive by three different routes:
   *
   *  - **Images** become `image` blocks. There is no other way for the model to
   *    see a picture — no tool it has can look at one.
   *  - **PDFs** become `document` blocks *as well as* staged files. The block is
   *    what gives the model vision over the rendered pages — layout, tables,
   *    charts, scanned text that is not text at all — which reading the file
   *    with a tool does not recover. The staged copy is still worth having, so
   *    the agent can run something over it.
   *  - **Every other file** appears only as a path in the text, because the
   *    agent reading it beats inlining it. See `describeStagedAttachments`.
   *
   * With none of them the content stays a plain string rather than a
   * one-element block array. The two are equivalent to the API, but the string
   * is what the SDK's own examples send and what every transcript reader in the
   * ecosystem expects to find in the `.jsonl` — including Artemis's own history
   * reader, which would otherwise need a second shape for prompts it wrote.
   *
   * Blocks come *before* the text. Anthropic's guidance is explicit that a
   * question placed before its image is answered worse, and the ordering is
   * free to get right here.
   */
  #userMessage(
    text: string,
    attachments?: readonly Attachment[],
    staged: readonly StagedAttachment[] = [],
    uuid?: string,
  ): SDKUserMessage {
    const all = attachments ?? [];
    const images = all.filter(isImageAttachment);
    const pdfs = all.filter(isPdf);

    // Only the files that are *not* already in the message get named. A PDF
    // rides in as a document block, so pointing the agent at a staged copy
    // would invite a tool call to re-read something it can already see.
    const note = describeStagedAttachments(staged.filter(({ attachment }) => !isPdf(attachment)));
    const body = withAttachmentNote(text, note);

    const blocks: ContentBlockParam[] = [
      ...images.map(
        (image): ImageBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        }),
      ),
      ...pdfs.map(
        (pdf): DocumentBlockParam => ({
          type: 'document',
          source: { type: 'base64', media_type: PDF_MEDIA_TYPE, data: pdf.data },
          // The filename, so the model can refer to it the way the user does
          // and so several attached PDFs are tellable apart.
          title: pdf.name,
        }),
      ),
    ];

    const content: MessageParam['content'] =
      blocks.length === 0
        ? body
        : [
            ...blocks,
            // An empty text block is a 400 from the Messages API, so a prompt
            // that is *only* attachments sends its blocks alone. The composer
            // does not allow that today — Send needs text — but this is a wire
            // format, and "the UI prevents it" is not a reason for the wire to
            // be malformed if it ever stops preventing it.
            ...(body.length === 0 ? [] : [{ type: 'text' as const, text: body }]),
          ];

    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      /*
       * Stamped only where a caller asked to hear about delivery, which in
       * practice means every mid-turn send. It is what puts the message in the
       * CLI's *named* queue: an interrupt receipt lists uuid-stamped messages
       * and, in the SDK's words, "a message enqueued without a uuid still runs
       * but is never listed" — so an unstamped steer was invisible to the one
       * signal that reports what an interrupt spared.
       */
      ...(uuid === undefined ? {} : { uuid: uuid as SDKUserMessage['uuid'] }),
    };
  }

  /** Write a turn's files to this run's directory, continuing its numbering. */
  async #stage(attachments?: readonly Attachment[]): Promise<readonly StagedAttachment[]> {
    const files = (attachments ?? []).filter(isFileAttachment);
    if (files.length === 0) return [];
    const staged = await stageAttachments(this.#stagingDir, files, this.#stagedCount);
    this.#stagedCount += files.length;
    return staged;
  }

  /**
   * The permission callback.
   *
   * **This must never return `null`.** The SDK documents `null` as fail-closed:
   * no control response is written, and the tool stays blocked indefinitely
   * because permission prompts have no park deadline. Every path here resolves
   * to an allow or a deny.
   */
  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (this.#disposing !== undefined) {
      return this.#denyResult(DISPOSED_DENY_MESSAGE, options.toolUseID);
    }

    /*
     * A prompt can now arrive with no turn to put it on.
     *
     * A subagent left running past its turn asks for a tool like any other
     * caller, and the turn that launched it ended minutes ago. Denying — which
     * is what the old `state.ended` check did, correctly, when an ended run
     * meant a dead transport — would stop the work this whole change exists to
     * keep alive, at the one point where the user could simply have said yes.
     *
     * So a turn is opened for it, and the prompt lands in the conversation it
     * came from as an ordinary permission request. That is also the only honest
     * place for it: the answer decides whether a subagent of *this* conversation
     * continues.
     */
    if (!this.#ensureTurn()) {
      return this.#denyResult(DISPOSED_DENY_MESSAGE, options.toolUseID);
    }

    this.#permissionCounter += 1;
    const requestId: PermissionRequestId = `${this.runId}:perm:${String(this.#permissionCounter)}`;
    const deferred = createDeferred<PermissionResult>();

    const request = buildPermissionRequest({
      id: requestId,
      runId: this.runId,
      toolName,
      input,
      info: options,
      requestedAt: this.#deps.now(),
    });

    this.#pending.set(requestId, {
      deferred,
      toolName,
      toolUseID: options.toolUseID,
      // The request's own coerced copy, not the raw SDK object: it is what the
      // renderer was shown, and an answer has to be written back into the same
      // arguments the user was answering.
      input: request.input,
      question: request.question,
    });

    // The provider can withdraw the request (the turn was interrupted, the tool
    // became moot). Settle rather than leak the deferred.
    const onAbort = (): void => {
      this.#pending.delete(requestId);
      deferred.resolve(
        this.#denyResult(WITHDRAWN_DENY_MESSAGE, options.toolUseID),
      );
      // Nobody answered this one, and nobody will. Without saying so on the
      // stream the request stays open everywhere downstream — the registry goes
      // on advertising a prompt that can never be answered, and the card stays
      // on screen over a decision that has already been made elsewhere.
      this.#emitResolved(requestId, 'withdrawn', WITHDRAWN_DENY_MESSAGE);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    this.#emit({
      type: 'permission.request',
      ...nextEventEnvelope(this.#state),
      requestId,
      request,
    });

    try {
      return await deferred.promise;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      this.#pending.delete(requestId);
    }
  };

  #denyResult(message: string, toolUseID: string | undefined): PermissionResult {
    return {
      behavior: 'deny',
      message,
      toolUseID,
      decisionClassification: 'user_reject',
    };
  }

  /**
   * Say on the stream that a parked request is no longer parked.
   *
   * Every path that settles one goes through here, because the alternative —
   * remembering to emit at each of the three — is the bug this event exists to
   * fix, one level down. See `PermissionResolvedEvent`.
   *
   * Emitting after `run.end` is a no-op: `#emit` drops onto a closed queue. That
   * is the right answer for the second `#denyAllPending` in `#teardown`, which
   * runs after the stream has already terminated and has nobody left to tell.
   */
  #emitResolved(
    requestId: PermissionRequestId,
    outcome: PermissionResolvedEvent['outcome'],
    note?: string,
    answers?: readonly QuestionAnswer[],
  ): void {
    this.#emit({
      type: 'permission.resolved',
      ...nextEventEnvelope(this.#state),
      requestId,
      outcome,
      ...(note === undefined ? {} : { note }),
      ...(answers === undefined ? {} : { answers }),
    });
  }

  #denyAllPending(message: string): void {
    if (this.#pending.size === 0) return;
    for (const [requestId, entry] of [...this.#pending]) {
      this.#pending.delete(requestId);
      entry.deferred.resolve(this.#denyResult(message, entry.toolUseID));
      // `withdrawn`, not `denied`: the user was never given the choice, and a
      // transcript that recorded this as their refusal would be lying about who
      // decided.
      this.#emitResolved(requestId, 'withdrawn', message);
    }
  }

  #captureStderr(data: string): void {
    for (const line of data.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.#stderrTail.push(scrubSecrets(trimmed));
      if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
    }
  }

  /** Attach the provider's last words to a transport failure, already scrubbed. */
  #withStderr(error: AgentError): AgentError {
    if (this.#stderrTail.length === 0) return error;
    return { ...error, details: { stderr: [...this.#stderrTail] } };
  }
}

/**
 * One turn, as the caller holds it.
 *
 * Thin on purpose: everything that does work lives on the process, and this is
 * the {@link Run} contract wrapped around one turn of it. What it adds is the
 * identity — its own state, its own event queue, and the check that a control
 * call is aimed at the turn that is actually running.
 *
 * That check is the reason this is an object rather than the process itself.
 * `send` on a turn that has ended used to be impossible to get wrong, because
 * the run *was* the process and an ended run had no transport left. Once a
 * process outlives its turns, a stale handle is reachable — a renderer that
 * kept one across a `run.end` it had not yet applied — and pushing that text
 * into whatever turn is running now would deliver a message to the wrong point
 * in the conversation. It is refused with the same error an ended run always
 * gave.
 */
class ClaudeTurn implements Run {
  readonly providerId = CLAUDE_PROVIDER_ID;
  readonly capabilities = CLAUDE_CAPABILITIES;

  readonly #process: ClaudeProcess;
  readonly #state: ClaudeMapperState;
  readonly #events: AsyncQueue<AgentEvent>;

  constructor(process: ClaudeProcess, state: ClaudeMapperState, events: AsyncQueue<AgentEvent>) {
    this.#process = process;
    this.#state = state;
    this.#events = events;
  }

  get runId(): string {
    return this.#state.runId;
  }

  get status(): RunStatus {
    return this.#process.statusOf(this.#state);
  }

  get sessionId(): SessionId | undefined {
    return this.#state.sessionId;
  }

  /**
   * This turn's own stream, not the process's current one.
   *
   * Captured at construction so a consumer still draining turn one is
   * unaffected by turn two opening — the queues are separate objects and each
   * terminates on its own `run.end`.
   */
  get events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  async send(
    text: string,
    attachments?: readonly Attachment[],
    messageId?: MessageId,
  ): Promise<SendResult> {
    this.#requireActive();
    return this.#process.send(text, attachments, messageId);
  }

  async interrupt(): Promise<InterruptResult> {
    // Not gated on being active: "Stop" on a turn that has already finished is
    // idempotent by nature, and the process answers it that way.
    return this.#process.interrupt();
  }

  /**
   * Not gated either, and here that is the entire feature rather than a
   * courtesy: the tasks worth stopping are the ones that outlived the turn that
   * launched them, so the run this arrives through has almost always ended.
   */
  async stopTask(taskId: string): Promise<void> {
    return this.#process.stopTask(taskId);
  }

  async respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    return this.#process.respondToPermission(requestId, decision);
  }

  dispose(): Promise<void> {
    return this.#process.dispose();
  }

  /**
   * Nobody is reading this turn any more. The process is not this turn's to end.
   *
   * A no-op, and deliberately: by the time anything releases a turn its `run.end`
   * has already been emitted, and the pump decided *there* whether the process
   * lives on — it stays only while it holds live tasks or a registered schedule,
   * and closes its own transport otherwise. Anything done here would be a second,
   * later opinion on a question that has already been answered correctly.
   *
   * It exists to stop the registry reaching for {@link dispose} at the end of
   * every turn, which is the one call that overrules retention on purpose.
   */
  release(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Refuse a control call aimed at a turn the process has moved on from.
   *
   * With `details.reason: 'run_ended'`, because the caller most likely to land
   * here is a steer racing the turn's own end — the renderer branches on
   * `isEndedRunError` to carry the message into a fresh run rather than
   * stranding it, and a detail-less refusal used to read as a real failure.
   */
  #requireActive(): void {
    if (this.#state.ended || !this.#process.isOpen(this.#state)) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} has already ended; start a new run with resumeSessionId to continue.`,
        { details: { reason: 'run_ended', runId: this.runId } },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Session listing plumbing                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the CLI wrote a conversation, or `undefined` when it is not there.
 *
 * `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric turned into
 * a dash>/<sessionId>.jsonl`, exactly as `#deliveryPath` resolves it for the
 * fold watch — the CLI munges its *resolved* directory, so the real path is a
 * candidate too. Without a directory to derive the key from, the project
 * folders are scanned for the file: a history read is allowed to cost a
 * `readdir`, which the fold watch's per-second poll is not.
 */
async function findSessionTranscript(
  configDir: string | undefined,
  cwd: string | undefined,
  sessionId: string,
): Promise<string | undefined> {
  const root = join(configDir ?? join(homedir(), '.claude'), 'projects');
  const isFile = (file: string): Promise<boolean> =>
    stat(file)
      .then((info) => info.isFile())
      .catch(() => false);

  if (cwd !== undefined) {
    const candidates = [cwd, await realpath(cwd).catch(() => cwd)];
    for (const dir of new Set(candidates)) {
      const file = join(root, dir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
      if (await isFile(file)) return file;
    }
    return undefined;
  }

  const projects = await readdir(root).catch(() => [] as string[]);
  for (const project of projects) {
    const file = join(root, project, `${sessionId}.jsonl`);
    if (await isFile(file)) return file;
  }
  return undefined;
}

/**
 * The `queued_command` attachment records in a transcript, as stored messages.
 *
 * Read line by line rather than whole, because a long session's file is tens
 * of megabytes and the rows wanted are a handful. Every failure — no file, a
 * row that is not JSON — costs the rows it hides and nothing else; the caller
 * replays without them, which is what it did before this existed.
 */
async function readQueuedCommands(
  configDir: string | undefined,
  cwd: string | undefined,
  sessionId: string,
): Promise<StoredMessage[]> {
  const file = await findSessionTranscript(configDir, cwd, sessionId);
  if (file === undefined) return [];

  const out: StoredMessage[] = [];
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Cheap pre-filter: the rows wanted name their kind in the first bytes.
    if (!line.includes('"attachment"') || !line.includes('queued_command')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== 'object' || row === null) continue;
    const record = row as { type?: unknown; uuid?: unknown; attachment?: unknown; timestamp?: unknown };
    if (record.type !== 'attachment' || typeof record.uuid !== 'string') continue;
    out.push({
      type: 'attachment',
      uuid: record.uuid,
      attachment: record.attachment,
      ...(record.timestamp === undefined ? {} : { timestamp: record.timestamp }),
    });
  }
  return out;
}

/**
 * Serialises access to `process.env.CLAUDE_CONFIG_DIR`.
 *
 * The SDK's standalone `listSessions()` takes no config-directory option — it
 * resolves the store from the ambient `process.env.CLAUDE_CONFIG_DIR` (falling
 * back to `~/.claude`). Artemis's whole per-profile isolation model depends on
 * pointing it somewhere else, so the variable has to be swapped around the
 * call and restored afterwards.
 *
 * Two concurrent listings for two different profiles would otherwise read each
 * other's history, so calls are queued rather than interleaved. The SDK's own
 * path resolution is memoised *keyed on this variable*, so the swap does take
 * effect rather than being cached away.
 */
let configDirLock: Promise<unknown> = Promise.resolve();

/**
 * Queue-depth instrumentation for the lock above — observation only.
 *
 * The lock is one process-wide chain, so reads for *different* profiles queue
 * behind each other, and one slow read stalls every history surface at once:
 * the sidebar's poll, a pane's subagent re-read, the message count on the path
 * of a resumed run. When that happens today it looks like Artemis "being
 * slow"; these few lines make it a log line instead.
 *
 * `configDirPending` counts calls that have entered {@link withClaudeConfigDir}
 * and not yet finished — the holder plus everything queued. Each arrival that
 * pushes it past {@link CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD} is reported with
 * what just joined and what was holding the lock at that moment. The threshold
 * sits above the app's steady-state concurrency (the pollers overlapping is
 * three-deep at most), so an ordinary tick reports nothing.
 *
 * A reporter must never break a read: failures are swallowed here, and the
 * reporter is a seam so core stays free of any logging dependency — the main
 * process points it at the session-lifecycle log.
 */
export const CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD = 3;

/** What {@link setClaudeConfigDirQueueReporter}'s reporter is told. */
export interface ClaudeConfigDirQueueReport {
  /** Calls pending on the lock, the new arrival included. */
  readonly depth: number;
  /** The operation that just joined the queue. */
  readonly waiting: string;
  /** The operation holding the lock, once any call has started executing. */
  readonly holding?: string;
}

let configDirPending = 0;
let configDirHolder: string | undefined;
let configDirQueueReporter: ((report: ClaudeConfigDirQueueReport) => void) | undefined;

/**
 * Hear about the lock's queue getting deep. One reporter per process, matching
 * the lock itself; pass `undefined` to unhook (tests do).
 */
export function setClaudeConfigDirQueueReporter(
  reporter: ((report: ClaudeConfigDirQueueReport) => void) | undefined,
): void {
  configDirQueueReporter = reporter;
}

/**
 * Exported for the queue-depth tests, which drive the lock directly rather
 * than mocking the SDK behind ten adapter methods. `waiting` names the
 * operation for the queue report; it appears in no other output.
 */
export function withClaudeConfigDir<T>(
  configDir: string | undefined,
  fn: () => Promise<T>,
  waiting = 'unnamed',
): Promise<T> {
  configDirPending += 1;
  if (configDirPending > CLAUDE_CONFIG_DIR_QUEUE_THRESHOLD && configDirQueueReporter !== undefined) {
    try {
      configDirQueueReporter({
        depth: configDirPending,
        waiting,
        ...(configDirHolder === undefined ? {} : { holding: configDirHolder }),
      });
    } catch {
      // Instrumentation must never cost a read.
    }
  }

  const run = configDirLock.then(async () => {
    configDirHolder = waiting;
    const previous = process.env[CLAUDE_CONFIG_DIR_ENV];
    if (configDir === undefined) {
      delete process.env[CLAUDE_CONFIG_DIR_ENV];
    } else {
      process.env[CLAUDE_CONFIG_DIR_ENV] = configDir;
    }
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env[CLAUDE_CONFIG_DIR_ENV];
      } else {
        process.env[CLAUDE_CONFIG_DIR_ENV] = previous;
      }
      configDirPending -= 1;
    }
  });

  // Keep the chain alive even when this call fails, or one bad listing would
  // wedge every later one.
  configDirLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* -------------------------------------------------------------------------- */
/* Session titles                                                             */
/* -------------------------------------------------------------------------- */

/** What a naming query came to: an answer, or why there is not one. */
type TitleAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Drain a naming query down to the one string it produced.
 *
 * The `result` message is what this reads, rather than the assistant text
 * blocks: it is the SDK's own answer for "what did that query come to", it
 * arrives exactly once, and reading it means a model that thought out loud
 * before answering does not have its thinking concatenated onto the title.
 *
 * ## `subtype: 'success'` does not mean it succeeded
 *
 * This is the trap, and it is not hypothetical — it is what an unauthenticated
 * config directory produces, observed verbatim:
 *
 * ```json
 * { "type": "result", "subtype": "success", "is_error": true,
 *   "result": "Not logged in · Please run /login", "terminal_reason": "api_error" }
 * ```
 *
 * A failure arrives wearing the success subtype with `is_error` set beside it,
 * and `result` holds the *error text* in the same field a title would occupy.
 * Reading the subtype alone would have named the user's session
 * `Not logged in · Please run /login` — a string that passes every check in
 * `cleanSessionTitle`, because it is a short, well-formed, capitalised phrase.
 * Both fields are therefore required to agree before the text is believed.
 *
 * Failures are reported rather than swallowed. Returning a bare `null` for all
 * of them is what made a wholly unauthenticated profile look identical to a
 * model that declined to answer: sessions silently stopped being named and
 * nothing anywhere said why.
 */
async function readTitleAnswer(sdkQuery: Query): Promise<TitleAnswer> {
  for await (const message of sdkQuery) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success' || message.is_error) {
      // `result` carries the provider's own explanation on the error path, and
      // it is the only description of the failure anyone will get: the SDK
      // throws on the *next* pull, which a caller that stops here never makes.
      const detail = message.subtype === 'success' ? message.result : message.subtype;
      return { ok: false, reason: detail || 'the provider reported an error' };
    }
    return { ok: true, text: message.result };
  }
  return { ok: false, reason: 'the provider produced no result' };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Reject if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${String(ms)}ms.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wait for `promise`, but give up after `ms`. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

/** A short, scrubbed description of anything thrown. For diagnostics only. */
function describe(error: unknown): string {
  return toAgentError(error).message;
}

/**
 * Does this failure mean "there is no such session" rather than "the delete
 * went wrong"?
 *
 * Only `deleteSession` asks, and only so that deleting something already gone
 * can succeed quietly — see the note there. The test is deliberately narrow in
 * the opposite direction from {@link looksLikeLaunchFailure}: a false positive
 * here reports a *successful* deletion for a transcript that is in fact still
 * on disk, which is the one outcome this feature must never produce. So a
 * permission error, a locked file or a malformed store all fall through to the
 * caller and surface as failures.
 *
 * `ENOENT` is the honest signal and is matched first; the SDK's own wording is
 * matched alongside it because the SDK raises a plain `Error` for a session it
 * cannot locate, with no errno to key on.
 */
function isMissingSession(error: unknown): boolean {
  const code: unknown = (error as { readonly code?: unknown } | null)?.code;
  if (code === 'ENOENT') return true;
  return /\bENOENT\b|session not found|no such session|not found/i.test(describe(error));
}

/**
 * Does this failure look like "the provider process never started"?
 *
 * Deliberately generous. A false positive costs one `stat` and, at worst, an
 * accurate cwd appended to a message that did not need it. A false negative
 * costs the user the libc red herring this whole path exists to replace — so
 * the SDK's own wording (`… exists but failed to launch`) is matched
 * explicitly alongside the errno.
 */
function looksLikeLaunchFailure(error: AgentError): boolean {
  if (error.code === 'provider_not_found') return true;
  return /\bENOENT\b|failed to launch|failed to spawn|\bspawn\b|could not be started|command not found/i.test(
    error.message,
  );
}
