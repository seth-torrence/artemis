/**
 * The composition root: where Electron's resources meet `@rx-artemis/core`.
 *
 * Core is deliberately incapable of doing this itself. It must never import
 * `electron` — it has to run in a plain Node process and under vitest — so
 * everything Electron-shaped is injected: the `safeStorage`-backed credential
 * store, the `userData` directory, a logger. Core supplies the parts
 * (`ProfileStore`, `RunRegistry`, the provider registry, the Claude adapter);
 * this file wires them together and presents the result as one interface the
 * IPC layer can call.
 *
 * ### Why the imports are static
 *
 * An earlier revision resolved core's exports dynamically by name, so that a
 * broken core build would degrade instead of crashing. That traded a loud
 * compile error for a silent runtime one, and it cost us three real defects
 * that the compiler would have caught immediately: the provider registry was
 * built with no adapters registered, `RunRegistry` was constructed without its
 * two required options, and every constructor was handed an options bag that
 * did not match its signature. The seam between main and core is exactly where
 * type checking earns its keep, so it is checked.
 *
 * The "a failed engine must not stop Artemis from launching" property is
 * preserved where it actually belongs — in {@link EngineHost.start}, which
 * catches construction failures and reports them through
 * {@link EngineHost.failureMessage}.
 *
 * ### The secret boundary, restated
 *
 * `ProfileStore.create()` and `.update()` return a full `Profile` — which
 * carries `secretRef`, `configDirName` and `publicEnv`. None of that may reach
 * the renderer, so this file never returns what those methods return: it takes
 * the id and asks the store to `describe()` it, which yields `ProfileMetadata`.
 * The IPC layer's leak scanner would catch a mistake here, but the correct
 * shape is produced deliberately rather than left to the tripwire.
 *
 * Credentials reach a provider through exactly one path: {@link RunRegistry}'s
 * `resolveRun` callback below. It calls `resolveEnv` and hands the bundle
 * straight to an adapter; neither this file nor the registry retains it.
 * Session listing looks similar but is deliberately *not* on that path — it
 * uses `resolveStoreEnv`, which yields the profile's config directory and no
 * credential at all, because a read has no business decrypting a key.
 */

import type {
  AgentEvent,
  Attachment,
  PermissionDecision,
  PermissionRequestId,
  Profile,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderDescriptor,
  ProviderId,
  ProviderModelOption,
  RunHandle,
  RunId,
  RunSuggestion,
  SessionDelegatedWork,
  SessionId,
  RunInput,
  SessionSummary,
  Unsubscribe,
  PlanUsage,
  PlanUsagePush,
  AuthStatusResponse,
  AgentPromptsDocument,
  BuiltInPromptId,
  ServerProfileCreatedBody,
  ServerSignInStatus,
} from '@rx-artemis/protocol';

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import path from 'node:path';

import {
  ARTEMIS_PROVIDER_ID,
  attributeSession,
  cancelRemoteSignIn,
  checkAuthStatus,
  createDefaultProviderRegistry,
  createRemoteAccount,
  deleteRemoteAccount,
  updateRemoteAccount,
  managedEnvKeys,
  ProfileStore,
  profileConfigDir,
  readRemoteAccounts,
  readRemoteUsage,
  readRemoteSignIn,
  resolveEnv,
  resolveStoreEnv,
  RunRegistry,
  SESSION_LIFECYCLE_LOG_FILE,
  SessionLifecycleLog,
  SessionNamer,
  SessionOwners,
  setClaudeConfigDirQueueReporter,
  signInCommand,
  signOut as cliSignOut,
  startRemoteSignIn,
  submitRemoteSignInCode,
  type EnvBundle,
  type RemoteAccounts,
  type LocalPlugin,
  type ProviderCredentialSpec,
  type ProviderRegistry,
  type SessionListScope,
  type SessionNamingPlan,
  type SignInShell,
  buildContentBridge,
  discoverMarketplacePlugins,
  linkSkillsIntoCodexHome,
} from '@rx-artemis/core';
import { applyPlanLimit, composeAgentPrompts, lowestTierModel } from '@rx-artemis/protocol';

import { AgentPromptStore } from './agentPrompts.js';
import { anyBankAvailable, banksForRun, configureMemoryBanks, isMasterEnabled, promptBanks, syncMemoryBanksInBackground } from './memoryBanks.js';
import { EngineUnavailableError, ValidationError } from './errors.js';
import { createLogger } from './log.js';
import { ensureSignInForwarder, stopSignInForwarder } from './signInLoopback.js';
import { createMemoryBankSecrets } from './memoryBankSecrets.js';
import { createProfileSecrets } from './profileSecrets.js';
import { configureSecretManagers, resolveSecretRef } from './secretManagers.js';
import { createSecretManagerCredentials } from './secretManagerSecrets.js';

const log = createLogger('engine');

/**
 * Longest session title Artemis will store.
 *
 * A cap rather than a rejection: someone pasting a paragraph into the rename
 * field wants a name, and truncating gives them one, whereas an error over a
 * character count they cannot see is a puzzle. Generous enough that no title a
 * person would type reaches it, small enough that the value stays a *label* —
 * it is appended to the transcript and read back into a one-line row.
 */
const MAX_SESSION_TITLE = 200;

/**
 * Fold the prompt library's text into whatever `systemPrompt` a run already
 * carries.
 *
 * Exported and pure so the three cases can be tested without standing up an
 * engine. Each of them is a decision rather than a fallthrough:
 *
 *  - **Absent, or `default`.** The ordinary path — every run the renderer
 *    starts. Becomes an `append`. Note that absent is *not* the same as
 *    `{ kind: 'default' }` downstream (see `mapSystemPrompt`), but both mean
 *    "the provider's own preset, untouched", which is exactly what an append
 *    adds to.
 *  - **Already an `append`.** Concatenated, with the caller's text first.
 *    Nothing in the renderer sends one today, but the field is part of
 *    `RunInput`; a caller that set one meant it, and dropping either side would
 *    be this function picking a winner between two things that were both asked
 *    for.
 *  - **`replace`.** Left alone. `replace` means "the provider's preset should
 *    not be there", and the library's prompts are written to sit after a preset
 *    that has already described the tools. Appending to a replacement would
 *    silently change what the user's own text is being added *to*.
 *
 * `text` being `undefined` — nothing in the library applies to this run — hands
 * the input back untouched, which is what keeps an empty library from putting
 * an `append` carrying nothing on every run.
 */
export function withSystemPromptAppended(input: RunInput, text: string | undefined): RunInput {
  if (text === undefined || text.length === 0) return input;

  const existing = input.systemPrompt;
  if (existing === undefined || existing.kind === 'default') {
    return { ...input, systemPrompt: { kind: 'append', text } };
  }
  if (existing.kind === 'append') {
    return { ...input, systemPrompt: { kind: 'append', text: `${existing.text}\n\n${text}` } };
  }
  return input;
}

/**
 * Fold the enabled memory banks into a run's `additionalDirectories`.
 *
 * A bank lives *outside* the working directory — the common case is a clone in
 * `~/Documents/cortex`, which is exactly the folder a local model cannot reach
 * because the tool sandbox is rooted at cwd. A session that cannot read the
 * bank cannot use the standing knowledge the bank exists to hold, so every run
 * on a machine with banks switched on is handed those directories to read.
 *
 * Exported and pure so the merge can be tested without an engine. Three rules,
 * each a decision rather than a fallthrough:
 *
 *  - **Off, or nothing configured.** `masterEnabled` false, or no bank paths —
 *    which is every machine that has not opted in. The input's own directories
 *    are returned *by reference*, `undefined` included, so a run that carried
 *    none still carries none and the caller can detect a no-op by identity.
 *  - **The user's own directories are never dropped**, and they come first: a
 *    folder the user attached to this run is the more deliberate request.
 *  - **Order-stable and idempotent.** Bank paths follow in registry order, a
 *    path already present on either side appears once, so re-running an input
 *    that already carries its banks — a resume — does not double them.
 */
export function mergeAdditionalDirectories(
  userDirs: readonly string[] | undefined,
  bankPaths: readonly string[],
  masterEnabled: boolean,
): readonly string[] | undefined {
  if (!masterEnabled || bankPaths.length === 0) return userDirs;

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...(userDirs ?? []), ...bankPaths]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  // Every bank path was already present (a resumed run carrying them): hand the
  // original reference back so the caller sees an untouched input, matching how
  // the prompt merge above leaves a no-op run identical.
  if (userDirs !== undefined && merged.length === userDirs.length) return userDirs;
  return merged;
}

/* -------------------------------------------------------------------------- */
/* The interface the IPC layer calls                                          */
/* -------------------------------------------------------------------------- */

/** What Electron injects into core. */
export interface EngineOptions {
  /**
   * Electron's per-app user data directory.
   *
   * Profile records live here, and so do the config directories Artemis
   * *suggests* (`<userData>/profiles/<name>`). A profile's actual `configDir`
   * is an absolute path the user chose and need not be under this one at all —
   * pointing a profile at `~/.claude` is a supported and common thing to do.
   */
  readonly userDataDir: string;
  /** Artemis's version, for any provider that wants a user-agent string. */
  readonly appVersion: string;
  /**
   * Real-filesystem path to the Claude Agent SDK's bundled CLI binary, when
   * the host had to resolve it around a virtual filesystem.
   *
   * Packaged Electron is that host: the SDK's own sibling-package resolution
   * yields an `app.asar/...` path, and spawning through the archive file
   * fails with `ENOTDIR`. `index.ts` resolves the `app.asar.unpacked` twin
   * and passes it here; in dev it stays unset and the SDK resolves itself.
   */
  readonly sdkExecutablePath?: string;
  /**
   * Tools that need Electron, built per run.
   *
   * The seam that lets an agent drive the browser in the dock. `packages/core`
   * cannot import Electron — `no-electron.test.ts` enforces it — so a tool that
   * touches a `WebContentsView` cannot be defined there. It is defined in
   * `browserTools.ts`, which is Electron's side of the wall, and injected here.
   *
   * Optional so that a smoke script or a test gets an engine with no such
   * tools, and every other capability unchanged.
   */
  readonly agentToolServers?: (
    runId: RunId,
    input: RunInput,
  ) => Record<string, McpServerConfig> | undefined;
}

/**
 * The engine as the main process uses it.
 *
 * Every method takes and returns renderer-safe protocol types, because each one
 * is a single step from an IPC response. Nothing here returns a `Profile`.
 */
export interface ArtemisEngine {
  listProviders(options: { readonly refresh?: boolean }): Promise<readonly ProviderDescriptor[]>;

  /**
   * One provider's model catalogue, read from the installed CLI where it can
   * be, from the adapter's static list where it cannot.
   *
   * Separate from {@link listProviders} because it spawns a subprocess and
   * takes a credential, exactly like {@link refreshPlanUsage} is separate from
   * {@link cachedPlanUsage}. Descriptors must stay instant; this one is allowed
   * to be slow.
   *
   * Takes both ids for the same reason {@link listSessions} does: the provider
   * decides *which* adapter answers, and the profile decides *as whom*. Never
   * throws for a provider that cannot enumerate models — that is an answer
   * (`live: false`), not a fault.
   */
  listProviderModels(options: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
    readonly cwd?: string;
  }): Promise<{ readonly models: readonly ProviderModelOption[]; readonly live: boolean }>;

  /**
   * The slash commands a session started here would offer.
   *
   * Separate from {@link listProviders} on the same grounds as
   * {@link listProviderModels}, and slower than it looks worth being: this
   * spawns a provider subprocess to ask a question about a run nobody has
   * started. It buys the composer's menu the ability to open on the *first*
   * message of a conversation, which is where a slash command is most often
   * wanted and was the one place the menu was reliably shut.
   *
   * Takes `cwd` and means it: commands are discovered relative to a working
   * directory, so this is not merely allowed to differ per project, it does.
   *
   * Never throws. A provider with no command surface answers with an empty
   * list, which is the same thing the composer did before this existed.
   */
  listProviderCommands(options: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
    readonly cwd?: string;
  }): Promise<{ readonly commands: readonly string[] }>;

  listProfiles(options: { readonly providerId?: ProviderId }): Promise<readonly ProfileMetadata[]>;
  createProfile(draft: ProfileDraft): Promise<ProfileMetadata>;
  updateProfile(id: ProfileId, patch: ProfilePatch): Promise<ProfileMetadata>;
  deleteProfile(
    id: ProfileId,
    options: { readonly deleteConfigDir?: boolean },
  ): Promise<{ readonly id: ProfileId; readonly configDirDeleted: boolean }>;
  /** A config-directory path to prefill the create form with. Creates nothing. */
  suggestConfigDir(label: string): Promise<string>;

  /**
   * The standing-instruction library, as stored.
   *
   * On the host rather than instantiated in `ipc.ts` — which is where the
   * memory banks and the shared-config probe live — because this is the one settings surface
   * whose data is also read on the path of a run. Two owners would mean two
   * caches, and the pane's save would land in the copy `startRun` is not
   * reading.
   */
  readAgentPrompts(): Promise<AgentPromptsDocument>;
  /** Replace the library. Answers with what was actually stored. */
  writeAgentPrompts(document: AgentPromptsDocument): Promise<AgentPromptsDocument>;

  startRun(input: RunInput): Promise<RunHandle>;
  sendToRun(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<{ readonly deliveredImmediately: boolean }>;
  interruptRun(runId: RunId): Promise<{ readonly stillQueued?: readonly string[] }>;
  /** Stop one delegated task, leaving the run and its other tasks alone. */
  stopTask(runId: RunId, taskId: string): Promise<void>;
  respondToPermission(
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;
  disposeRun(runId: RunId): Promise<void>;
  listRuns(options: { readonly cwd?: string }): Promise<readonly RunHandle[]>;

  /**
   * One run's handle — live or recently finished — or undefined.
   *
   * Synchronous, like {@link runEvents} and for the same reason: it reads the
   * registry's in-memory index, and the server's event-feed publisher calls it
   * per event to stamp which account a push concerns — an await there would
   * let pushes reorder behind the lookup.
   */
  getRun(runId: RunId): RunHandle | undefined;

  /**
   * Conversations still holding background work, across every provider.
   *
   * The union of live registry runs and work that outlives the run that started
   * it — a workflow, a backgrounded subagent, a registered schedule. Keeping
   * both here gives a reloaded renderer one recovery source even when an adapter
   * has no background-work ledger of its own.
   *
   * Synchronous, like {@link runEvents} and for the same reason: it reads
   * in-memory pools and sits on a poll.
   */
  liveWorkSessions(): readonly SessionId[];
  /** Sessions with an open registry turn, live tasks, or a settling beat. */
  workingSessions(): readonly SessionId[];

  /**
   * What those conversations have delegated, for a window rebuilding its rows.
   *
   * The other half of {@link liveWorkSessions}, and the half a reloaded window
   * cannot get anywhere else: delegated rows arrive on `background.tasks`, which
   * is run-scoped, so a window with no memory and a continuation run to attach to
   * has nothing to replay. Conversations holding no rows are omitted rather than
   * reported empty — see the adapter contract.
   *
   * Synchronous, on the same poll, for the same reason.
   */
  delegatedWork(): readonly SessionDelegatedWork[];

  /**
   * A run's retained events, for a window that reloaded out from under it.
   *
   * Synchronous in the registry and kept synchronous here: it is a read of an
   * in-memory buffer, and the reload path calls it once per live run before the
   * first paint. `truncated` is computed rather than inferred by the caller —
   * only the registry knows whether the events it dropped were ones this caller
   * asked for.
   */
  runEvents(options: {
    readonly runId: RunId;
    readonly afterSeq?: number;
  }): { readonly events: readonly AgentEvent[]; readonly truncated: boolean };

  /**
   * Last-known plan usage, or null if never fetched. Synchronous and free.
   *
   * Paired with {@link refreshPlanUsage} so the UI can render instantly from
   * cache and swap in fresh data when it lands, instead of blocking a popover
   * on a subprocess spawn.
   */
  cachedPlanUsage(profileId: ProfileId): PlanUsage | null;

  /**
   * Fetch plan usage from the provider and cache it. Costs no model tokens.
   *
   * Takes only a profile id: a profile already names its provider, and making
   * the caller supply both invites the two disagreeing.
   */
  refreshPlanUsage(options: { readonly profileId: ProfileId }): Promise<PlanUsage>;

  /**
   * Per-profile authentication, delegated entirely to the provider's own CLI.
   *
   * This is the only way a profile is authenticated, and there is deliberately
   * no method here that accepts a key or a token — nor one that *performs* a
   * login. The user runs the provider's command themselves against the
   * profile's config directory; Artemis reads the result back. No credential is
   * ever handled by, stored by, or reachable from Artemis, and the config
   * directory *is* the account boundary, which is what makes multiple accounts
   * work.
   */
  authStatus(profileId: ProfileId): Promise<AuthStatusResponse>;
  signOut(profileId: ProfileId): Promise<AuthStatusResponse>;

  /**
   * The accounts on the Artemis *server* an artemis profile points at, and
   * whether this connection may add to them.
   *
   * The paragraph above is about accounts on **this** machine, in a config
   * directory on this disk. This is the other kind: an account on the serving
   * machine, entered through the server's own admin routes. The rule is
   * unchanged and is the reason both can exist — Artemis performs no login and
   * holds no credential. What travels here is a URL the server's CLI printed
   * and a code the user typed; the credential is written by that CLI, in that
   * container, and is never readable from this side.
   *
   * Every method takes the local profile id — the Artemis-Server profile whose
   * address and token say which server — and the ones that name an account take
   * the *server's* id for it as well.
   */
  remoteAccounts(profileId: ProfileId): Promise<RemoteAccounts>;
  createRemoteAccount(
    profileId: ProfileId,
    request: { readonly label: string; readonly provider?: string },
  ): Promise<ServerProfileCreatedBody>;
  updateRemoteAccount(
    profileId: ProfileId,
    accountId: string,
    patch: { readonly label?: string; readonly baseUrl?: string; readonly apiKey?: string },
  ): Promise<ServerProfileCreatedBody>;
  deleteRemoteAccount(profileId: ProfileId, accountId: string): Promise<{ readonly removed: boolean }>;
  /** The server's gauges, one row per visible account with a plan to read. */
  readRemotePlanUsage(
    profileId: ProfileId,
  ): Promise<readonly { readonly profileId: string; readonly label: string; readonly usage: PlanUsage }[]>;
  startRemoteSignIn(profileId: ProfileId, accountId: string): Promise<ServerSignInStatus>;
  remoteSignInStatus(profileId: ProfileId, accountId: string): Promise<ServerSignInStatus | null>;
  submitRemoteSignInCode(
    profileId: ProfileId,
    accountId: string,
    code: string,
  ): Promise<ServerSignInStatus>;
  cancelRemoteSignIn(profileId: ProfileId, accountId: string): Promise<ServerSignInStatus | null>;

  listSessions(options: {
    readonly providerId: ProviderId;
    readonly profileId: ProfileId;
    readonly cwd: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{ readonly sessions: readonly SessionSummary[]; readonly hasMore: boolean }>;

  /**
   * One session's stored messages, replayed as events.
   *
   * Returns the same `AgentEvent`s a live run emits, stamped with `runId`, so
   * the renderer feeds them through the transcript it already has rather than
   * growing a second path for history.
   */
  getSessionMessages(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly runId: RunId;
    readonly cwd?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{ readonly events: readonly AgentEvent[]; readonly hasMore: boolean }>;

  /**
   * One subagent's stored messages, replayed as events.
   *
   * The parent session names the conversation that delegated; `agentId` — which
   * is the task id — names the work. `consumed` counts stored messages rather
   * than events, so a caller following a running agent can page from where it
   * left off; see the protocol's `SessionsSubagentMessagesResponse`.
   */
  getSubagentMessages(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly agentId: string;
    readonly runId: RunId;
    readonly cwd?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly hasMore: boolean;
    readonly consumed: number;
  }>;

  /**
   * Every profile's history, across every project.
   *
   * Same read as {@link listSessions} with both of its scopes removed. Returns
   * entries carrying `cwd` and `profileId`, which is what a sidebar needs to
   * group by project and label by profile.
   */
  listAllSessions(options: {
    readonly providerId?: ProviderId;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<{ readonly sessions: readonly SessionSummary[]; readonly hasMore: boolean }>;

  /**
   * Give a stored session a user-chosen title, in the provider's own store.
   *
   * Resolves to the title as written, so the caller renders what was stored
   * rather than what it hoped would be.
   */
  renameSession(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly cwd?: string;
    readonly title: string;
  }): Promise<{ readonly title: string }>;

  /**
   * Destroy a stored session's transcript. Irreversible.
   *
   * Resolves `false` when there was nothing left to delete, which is a success
   * — see the protocol's `SessionsDeleteResponse`.
   */
  deleteSession(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly cwd?: string;
  }): Promise<{ readonly deleted: boolean }>;

  /**
   * Write the provider's own tag onto a stored session, or clear it.
   *
   * Resolves `false` when there was no such session, on the same rule
   * `deleteSession` follows.
   */
  tagSession(options: {
    readonly profileId: ProfileId;
    readonly sessionId: SessionId;
    readonly cwd?: string;
    readonly tag: string | null;
  }): Promise<{ readonly tagged: boolean }>;

  /**
   * Subscribe to every run's events.
   *
   * One firehose rather than a subscription per run: the renderer multiplexes
   * on `event.runId`, and a per-run channel would mean building channel names
   * out of renderer-supplied strings in the preload — exactly the dynamic
   * channel pattern the preload is forbidden to have.
   */
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe;

  /**
   * Subscribe to predicted next prompts — one per finished turn, at most.
   *
   * A second stream rather than more {@link subscribe} events because a
   * suggestion is generated *after* the turn's `run.end`, and the event
   * contract keeps `run.end` last on a run's stream. See
   * {@link IPC_PUSH.runSuggestion} for the renderer's half.
   */
  subscribeSuggestions(listener: (suggestion: RunSuggestion) => void): Unsubscribe;

  /**
   * Subscribe to plan-usage readings the engine learns *between* polls.
   *
   * A third stream for the same reason suggestions are one: these are not run
   * events. A live run's `plan.limit` events are folded into the engine's
   * plan-usage cache as they arrive — see the fold beside the namer's
   * subscription — and each merge that changes anything comes out here, keyed
   * by the profile it describes. `planUsagePoll.ts` forwards them onto the
   * same scanned push channel as the poll's own readings, which is what makes
   * the meter live during a run instead of thirty seconds behind it.
   */
  subscribePlanUsage(listener: (push: PlanUsagePush) => void): Unsubscribe;

  /** Tear down every live run. Called on quit. */
  dispose(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every model this account has offered, not merely the ones it offered *this
 * time*.
 *
 * A provider's catalogue is not the constant it looks like. While a model is
 * rolling out, two consecutive asks — same binary, same account, same minute —
 * come back with different lineups, because the answer is served and the
 * backends disagree for as long as the rollout runs. Observed directly on
 * 2026-09-01: four asks in a row returned `claude-fable-5`, then
 * `claude-fable-5-1` three times.
 *
 * Replacing the remembered list with the newest answer means the picker is a
 * coin flip. A user who asked at the wrong moment does not see the new model
 * at all, and — worse — a user who *had* it watches it disappear when
 * something incidental triggers another fetch, which reads as Artemis losing
 * a model rather than the provider being mid-rollout.
 *
 * So a live answer adds and never subtracts. The fresh list keeps its own
 * order, since that is the provider's opinion of what to show first; models
 * remembered from earlier answers and missing from this one are carried on the
 * end rather than dropped. Both are real models the account has offered and
 * either can be run.
 *
 * The memory is the process's, so it is not a cache that can go permanently
 * stale: a model genuinely withdrawn is gone at the next launch, which is the
 * right lifetime for a fact this provisional. Identity is the option's `id` —
 * the provider's own value for the row — so the same model arriving twice
 * merges rather than doubling.
 */
export function rememberModels(
  remembered: readonly ProviderModelOption[] | undefined,
  fresh: readonly ProviderModelOption[],
): readonly ProviderModelOption[] {
  if (remembered === undefined || remembered.length === 0) return fresh;
  const offered = new Set(fresh.map((model) => model.id));
  const carried = remembered.filter((model) => !offered.has(model.id));
  return carried.length === 0 ? fresh : [...fresh, ...carried];
}

/**
 * Build the engine.
 *
 * @throws {EngineUnavailableError} — but only through {@link EngineHost.start},
 *         which is the sole caller and catches everything.
 */
function createEngine(options: EngineOptions): ArtemisEngine {
  const { userDataDir } = options;

  /**
   * The session-lifecycle log — the observability half of OVERHAUL-PREP §9.
   *
   * One append-only JSONL file under `userData`, beside `sessionOwners.json`:
   * run started/session/adopted/ended/released lines from the registry,
   * engine started/stopped brackets from here, and the config-dir lock's
   * queue-depth reports. Ids and event names only — the redaction rule lives
   * in {@link SessionLifecycleLog.record} — and every line is flushed as it is
   * written, because the lines that matter are the ones a crash would eat.
   *
   * Failures are logged and never thrown: the log observes runs, it must not
   * participate in them.
   */
  const lifecycle = new SessionLifecycleLog({
    file: path.join(userDataDir, SESSION_LIFECYCLE_LOG_FILE),
    onError: (error) => log.warn('Could not append to the session-lifecycle log', error),
  });
  lifecycle.record({ kind: 'engine.started' });
  // The lock is process-wide, so its reporter is too. Depth reports land in
  // the same file as the run lifecycle: a stalled history read and a lost
  // run.end are halves of the same incident more often than not.
  setClaudeConfigDirQueueReporter((report) =>
    lifecycle.record({ kind: 'history.lock.queued', ...report }),
  );

  /**
   * Whoever asked to hear predictions. Declared before the registry because
   * the adapter option below closes over it; the set is what makes wiring
   * order irrelevant — the adapter can speak before anyone subscribes and it
   * costs one no-op loop.
   */
  const suggestionListeners = new Set<(suggestion: RunSuggestion) => void>();

  // `createDefaultProviderRegistry` — not `createProviderRegistry` — is what
  // actually registers the Claude adapter. An empty registry typechecks
  // perfectly and then reports every provider as unavailable at runtime.
  const providers: ProviderRegistry = createDefaultProviderRegistry({
    claude: {
      /*
       * Fan a prediction out to the windows. Wiring this is also the opt-in:
       * the adapter only asks the SDK to predict when someone is listening —
       * see `ClaudeAdapterOptions.onSuggestion` — and this callback exists,
       * so Artemis always asks. Failures are contained per listener; this is
       * called from inside the adapter's own event pump, where a throw would
       * take down a live stream to complain about a garnish.
       */
      onSuggestion: (suggestion) => {
        for (const listener of suggestionListeners) {
          try {
            listener(suggestion);
          } catch (error) {
            log.error('A suggestion subscriber threw', error);
          }
        }
      },
      ...(options.sdkExecutablePath === undefined
        ? {}
        : { sdkExecutablePath: options.sdkExecutablePath }),
      ...(options.agentToolServers === undefined
        ? {}
        : { agentToolServers: options.agentToolServers }),
      /*
       * The provider started a turn nobody asked for — register it.
       *
       * It does that when background work settles (it is told the task finished
       * and answers), and a subagent that outlived its own turn can park on a
       * permission prompt the same way. The adapter builds the run because only
       * it can; the registry is what gives that run an id, a replay buffer and
       * an audience, so this line is the whole of the connection between them.
       *
       * `runs` is declared below and captured, not called, until a process is
       * live — which is necessarily long after both exist.
       *
       * Failures are logged and swallowed. This is called from inside the
       * adapter's own event pump: throwing would take down the stream carrying
       * the very work being rescued, to complain that it could not be displayed.
       * The turn still runs and the provider still writes it to the session
       * file, so the cost of the refusal is a live transcript that catches up
       * when the conversation is reopened.
       */
      onContinuation: (run, context) => {
        try {
          runs.adopt(run, context);
        } catch (error) {
          log.error(`Could not adopt the provider's own turn on run ${run.runId}`, error);
        }
      },
    },
  });

  /**
   * Every variable any registered provider sets for itself.
   *
   * The store uses this as a denylist for `publicEnv`, so a union across
   * providers is the right shape: over-rejecting a name costs a user nothing,
   * under-rejecting one silently breaks account isolation. Built from the
   * adapters rather than written out here, so a new provider's variables are
   * covered the moment it is registered.
   */
  const managed = [
    ...new Set(providers.list().flatMap((adapter) => managedEnvKeys(adapter.credentials))),
  ];

  /*
   * The one secret Artemis stores again — a local server's API key. See
   * `core/profiles/secrets.ts` for why this one is different from the
   * credential store that was deleted, and `profileSecrets.ts` for the
   * encryption. Injected here for the reason everything Electron-shaped is:
   * core must never import `electron`.
   */
  const secrets = createProfileSecrets(userDataDir);
  const profiles = new ProfileStore({ userDataDir, managedEnvKeys: managed, secrets });

  const agentPrompts = new AgentPromptStore({ userDataDir });

  /*
   * The key managers, before the memory banks — because a bank may hold a
   * *reference* into one rather than a token of its own, and the resolver
   * below is how it cashes that reference in. See
   * `core/secrets/credentials.ts`: the manager's own credential is the one
   * Artemis stores so that per-bank git tokens do not have to be.
   */
  configureSecretManagers(userDataDir, createSecretManagerCredentials(userDataDir));

  // Where the memory banks' master switch is kept, what the banks' CLI should
  // be told `ARTEMIS_ROOT` is, where a private bank's git token lives, and how
  // to resolve one that lives in a key manager instead. Told once, here,
  // because this is the only place that knows `userData`; until it is told,
  // the switch reads as off and no bank has a credential.
  configureMemoryBanks(userDataDir, createMemoryBankSecrets(userDataDir), resolveSecretRef);

  /**
   * Which built-in prompts have the thing they talk about.
   *
   * Read per run rather than cached at startup, because the precondition can
   * change while the app is open — adding a bank is a button in the settings
   * dialog, and a user who clicks it should not have to restart before the
   * prompt that describes it starts arriving. Both halves are cheap at that
   * rate: a cached file read and a registry read with a few `existsSync`s. The
   * full status probe, which spawns the CLI, is not.
   *
   * Configured **and** switched on. Banks being registered is not consent to
   * spending every run's context describing them, so a machine that has them
   * but has not said yes gets the prompt withheld however enabled its row is —
   * which is exactly what `BuiltInAgentPrompt.requires` exists to explain.
   */
  const availableBuiltIns = (): ReadonlySet<BuiltInPromptId> => {
    const available = new Set<BuiltInPromptId>();
    if (isMasterEnabled() && anyBankAvailable()) available.add('builtin:cerebro');
    return available;
  };

  /**
   * Attach the library's standing instructions to a run.
   *
   * Two things this deliberately does not do:
   *
   *  - **It does not send to a provider that cannot take it.** See
   *    `Capabilities.systemPromptAppend`: an adapter without an append honours
   *    the run and ignores the prompt, which would leave the pane claiming an
   *    instruction the model never read.
   *  - **It does not fail a run.** A library that cannot be read is logged and
   *    treated as empty. Starting the agent is the app's job; standing
   *    instructions are an enhancement to it, and one should never cost the
   *    other.
   *
   * The merge itself is {@link withSystemPromptAppended}, which is pure and
   * tested — this half is the I/O around it.
   */
  const withAgentPrompts = async (input: RunInput): Promise<RunInput> => {
    let capabilities;
    try {
      capabilities = providers.require(input.providerId).capabilities;
    } catch {
      // An unknown provider is `runs.start`'s error to report, in its own
      // words. Handing the input back unchanged lets it get there.
      return input;
    }
    if (!capabilities.systemPromptAppend) return input;

    try {
      const { prompts } = await agentPrompts.read();
      const available = availableBuiltIns();
      const text = composeAgentPrompts(prompts, {
        profileId: input.profileId,
        availableBuiltIns: available,
        // The banks by name, so the composed prompt teaches this machine's
        // slugs and read-only rules instead of the generic preview.
        ...(available.has('builtin:cerebro') ? { memoryBanks: promptBanks() } : {}),
      });
      return withSystemPromptAppended(input, text);
    } catch (error) {
      log.warn('Could not compose the agent prompt library; starting without it', error);
      return input;
    }
  };

  /** The credential vocabulary of the provider a request names. */
  const credentialsFor = (providerId: ProviderId): ProviderCredentialSpec =>
    providers.require(providerId).credentials;

  /**
   * Profile → the environment a provider executes with.
   *
   * `baseEnv` is deliberately left at its default (`{}`): this bundle carries
   * only profile-owned variables — `CLAUDE_CONFIG_DIR` and the profile's
   * `publicEnv`. The adapter is what merges the host environment in, and it
   * scrubs inherited credential variables while doing so, so a key in the
   * launching shell can never contaminate a profile. Pre-spreading
   * `process.env` here would duplicate that work against a second, separately
   * maintained list of managed keys.
   */
  const envFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> => {
    const profile = await profiles.require(profileId);
    // Read here rather than inside `resolveEnv`, which is core's and cannot
    // decrypt. This is the single path a credential takes to a provider, and
    // the endpoint key travels it like everything else.
    const apiKey = await profiles.readApiKey(profileId);
    return resolveEnv(profile, {
      credentials: credentialsFor(providerId),
      ...(apiKey === null ? {} : { apiKey }),
    });
  };

  /**
   * The address and connection token of the Artemis server a profile names.
   *
   * The same bundle a *run* against that profile is given — `envFor`, key and
   * all — because a profile that can run a turn on a server is exactly the
   * profile that may administer it, and resolving the address a second way here
   * would be a second place for it to be wrong.
   *
   * Refused for any other provider rather than answered with an empty bundle: a
   * Claude profile has no server behind it, and a request that reached here
   * with one would otherwise be sent to the default loopback address — a
   * different machine's Artemis, on the strength of a mismatched id.
   */
  const remoteEnvFor = async (profileId: ProfileId): Promise<EnvBundle> => {
    const profile = await profiles.require(profileId);
    if (profile.providerId !== ARTEMIS_PROVIDER_ID) {
      throw new ValidationError(
        'profileId',
        'must name an Artemis Server profile — only those have a server to administer',
      );
    }
    return envFor(profileId, profile.providerId);
  };

  /**
   * Profile → just enough environment to *find* its history.
   *
   * Listing is a read. It needs the config directory and nothing else, and it
   * must not create that directory on a path that only reads — which is the
   * one behaviour that separates it from `envFor`.
   */
  const storeEnvFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> =>
    resolveStoreEnv(await profiles.require(profileId), {
      credentials: credentialsFor(providerId),
    });

  /**
   * The environment a *history read* gets, chosen by where the history lives.
   *
   * Local stores read with `storeEnvFor` — the config directory and no
   * credential, because opening files must not decrypt a key. A provider that
   * declares `sessionStore: 'remote'` has no files: its history is on the
   * other end of an authenticated request, so the read carries the same
   * credential a run would. See `ProviderCredentialSpec.sessionStore`.
   */
  const historyEnvFor = async (profileId: ProfileId, providerId: ProviderId): Promise<EnvBundle> =>
    credentialsFor(providerId).sessionStore === 'remote'
      ? envFor(profileId, providerId)
      : storeEnvFor(profileId, providerId);

  /**
   * Everything the sign-in helpers need about one profile.
   *
   * Both the status probe and the generated command are built from the same
   * pair — the provider's vocabulary and the profile's directory — so they are
   * resolved once. Reading the status against one directory while telling the
   * user to sign a different one in is the failure this shape rules out.
   */
  /*
   * Which shell the copyable sign-in line has to satisfy.
   *
   * The host's call, not the core's: `signIn.ts` can compose either spelling
   * but has no business deciding which terminal the user is about to paste
   * into. Picked once, from the platform, because that is the whole of what
   * the decision depends on.
   */
  const signInShell: SignInShell = process.platform === 'win32' ? 'powershell' : 'posix';

  const authOptionsFor = async (
    profileId: ProfileId,
  ): Promise<{ readonly credentials: ProviderCredentialSpec; readonly configDir: string; readonly hostEnv: NodeJS.ProcessEnv }> => {
    const profile = await profiles.require(profileId);
    return {
      credentials: credentialsFor(profile.providerId),
      configDir: profileConfigDir(profile),
      hostEnv: process.env,
    };
  };

  /**
   * Make this profile's own skills and commands reachable, and say how if the
   * run needs to know.
   *
   * Both providers are handled, and only one of them has anything to hand back:
   *
   *  - **Claude** gates discovery behind `settingSources`, which Artemis keeps
   *    empty, so its skills and slash commands arrive as a plugin directory —
   *    the one channel that reaches a session past that gate. The run has to be
   *    told about it, hence the return value. A plugin the user installed from a
   *    marketplace is behind the same gate for a different reason — its
   *    enablement is a settings key — and rides the same channel, passed through
   *    whole rather than bridged.
   *  - **Codex** reads `$CODEX_HOME/skills` itself. Nothing needs passing to the
   *    run; the work is putting the links there, and the run picks them up
   *    because Artemis already points `CODEX_HOME` at the profile. It has no
   *    user-authored command surface at all, so there is no command half to
   *    mirror — see core's `content/bridge.ts`.
   *
   * Core's `content/bridge.ts` documents why each is shaped the way it is. Resolved per
   * run rather than once at startup, because that is what makes something
   * installed while the app is open work on the next message instead of the next
   * launch.
   */
  const contentPluginsFor = async (
    profileId: ProfileId,
    providerId: ProviderId,
  ): Promise<readonly LocalPlugin[]> => {
    if (providerId !== 'claude' && providerId !== 'codex') return [];
    const configDir = profileConfigDir(await profiles.require(profileId));

    if (providerId === 'codex') {
      await linkSkillsIntoCodexHome({ configDir, onWarning: (message, error) => log.warn(message, error) });
      return [];
    }

    // Concurrent, and independent: one assembles a directory, the other only
    // reads two files to find directories that already exist.
    const [bridged, marketplace] = await Promise.all([
      buildContentBridge({ configDir, dataDir: options.userDataDir, onWarning: (message, error) => log.warn(message, error) }),
      discoverMarketplacePlugins({ configDir, onWarning: (message, error) => log.warn(message, error) }),
    ]);
    return [...bridged, ...marketplace];
  };

  /**
   * Keep the local end of a loopback sign-in in step with the flow.
   *
   * Reads the same status object the card renders: a live flow that names a
   * port gets a forwarder, and a settled or portless one gets any forwarder
   * torn down. Driven from both the start call and the status poll, because
   * either can be the first to see the port — or the settle.
   */
  const syncSignInForwarder = (
    accountId: string,
    status: { readonly state?: string; readonly loopbackPort?: number } | null,
    env: EnvBundle,
  ): void => {
    const port = status?.loopbackPort;
    const settled =
      status === null ||
      status.state === 'done' ||
      status.state === 'failed' ||
      status.state === 'cancelled' ||
      status.state === 'expired';
    if (port !== undefined && !settled) ensureSignInForwarder({ accountId, port, env });
    else stopSignInForwarder(accountId);
  };

  const runs = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    // The only path a credential takes into a run. `providerId` is read, not
    // discarded: it selects which variable names the credential is written
    // into, so a non-Claude provider receives its own vocabulary rather than
    // an Anthropic-shaped bundle.
    resolveRun: async ({ profileId, providerId }) => {
      // Concurrent because they share only the profile record, which the store
      // caches: the credential decryption and the content scan have no reason to
      // wait for each other on the path of a run that is starting.
      const [env, plugins] = await Promise.all([
        envFor(profileId, providerId),
        contentPluginsFor(profileId, providerId),
      ]);
      return { env, plugins };
    },
    onError: (error, context) => {
      log.error(`Run ${context.runId} reported a swallowed error during ${context.phase}`, error);
    },
    onLifecycle: (event) => lifecycle.record(event),
  });

  /** Last plan-usage reading per profile. In-memory by design — see below. */
  const planUsageCache = new Map<ProfileId, PlanUsage>();

  /**
   * The last *live* model catalogue read for a (provider, profile) pair.
   *
   * Written by `listProviderModels` when the account confirmed the list, and
   * read by the session namer, which needs to know which model is the smallest
   * one this account actually has. Only live answers are stored: a fallback
   * list cached here would be indistinguishable from a confirmed one the next
   * time it was read, which is the exact confusion `ModelCatalogue.live` exists
   * to prevent.
   *
   * In-memory, and never fetched on demand. The renderer already reads this on
   * boot and on every profile switch, so by the time anyone sends a first
   * message the entry is almost always there — and when it is not, the namer
   * falls back to the adapter's static list rather than spawning a subprocess
   * on the path of a run that is starting.
   */
  /**
   * The command list per (provider, profile, directory), promise and all.
   *
   * Promises rather than values so that concurrent asks share one subprocess
   * — see `listProviderCommands`, which is where the reasoning lives.
   */
  const commandLists = new Map<string, Promise<{ readonly commands: readonly string[] }>>();

  const modelCatalogues = new Map<string, readonly ProviderModelOption[]>();
  const catalogueKey = (providerId: ProviderId, profileId: ProfileId): string =>
    `${providerId}:${profileId}`;

  /**
   * Names each new session from its opening message.
   *
   * Wired as a subscriber rather than folded into `startRun`, so that naming
   * cannot delay, fail or otherwise touch the run it is named after. See
   * `SessionNamer` for what it costs and when it declines.
   */
  const namer = new SessionNamer({
    resolveAdapter: (id) => providers.get(id),

    /**
     * Which model names the session, and with which environments.
     *
     * The catalogue read is live-first, static-fallback, and it never fetches:
     * the answer is "the smallest model this account has" where that is known,
     * and "the smallest model this provider ships" where it is not. A provider
     * whose models declare no tier yields `null` and nothing is named — see
     * `lowestTierModel` for why that is better than guessing.
     *
     * Two environments, because the two halves of naming need different
     * things. The completion is billed to the account, so it takes the
     * credential-bearing bundle a run gets. The rename only locates a file, so
     * it takes the store bundle a listing gets and decrypts nothing.
     */
    plan: async ({ profileId, providerId }): Promise<SessionNamingPlan | null> => {
      const adapter = providers.get(providerId);
      if (adapter === undefined) return null;

      const model =
        lowestTierModel(modelCatalogues.get(catalogueKey(providerId, profileId))) ??
        lowestTierModel(adapter.models);
      if (model === undefined) return null;

      return {
        model: model.id,
        env: await envFor(profileId, providerId),
        storeEnv: await storeEnvFor(profileId, providerId),
      };
    },

    onError: (error, context) => {
      // Deliberately a warning. Every failure here costs a nicer label and
      // nothing else — the session still exists, still resumes, and still
      // lists under the title it would have had before this feature.
      log.warn(`Could not name the session for run ${context.runId}`, error);
    },
  });

  /**
   * Remembers which account each session ran under.
   *
   * The second subscriber, wired exactly like the namer and for the same
   * reason: it must never delay, fail or touch the run it learns from.
   *
   * It exists because of the shared-config feature. Once `projects/` is
   * symlinked across profiles, every profile enumerates one store and the
   * directory a transcript was found in stops identifying an account — the
   * adapter then has to pick one, and says so with
   * `SessionSummary.profileIsUnknown`. Nothing on disk can settle it: the
   * transcript records a session, a directory and a branch, and no account. The
   * only component that ever knows is this process, at the moment it starts a
   * run, which is the moment this writes it down. See `SessionOwners`.
   */
  const owners = new SessionOwners({
    userDataDir,
    onError: (error, context) => {
      // A warning, like the namer's, and for a smaller cost still: every
      // failure here loses a label on a sidebar row. The session exists,
      // resumes and lists exactly as it did before this feature.
      log.warn(`Session ownership ledger failed during ${context.stage}`, error);
    },
  });

  /**
   * Who hears about a live plan-usage merge. Fed by the fold below, drained by
   * `planUsagePoll.ts`, which owns the broadcast (and its credential scan).
   */
  const planUsageListeners = new Set<(push: PlanUsagePush) => void>();

  /**
   * Fold a run's `plan.limit` events into the plan-usage cache.
   *
   * The third subscriber, held to the same rule as the namer and the owners
   * ledger: it must never delay, fail or touch the run it learns from.
   *
   * This is the live half of the cache. The poll reads an account every two
   * minutes (thirty seconds with a run on it), which is how a meter reads 97%
   * on an account already refusing requests — the refusal is in this event,
   * on this machine, seconds after the server decided it, and used to be
   * dropped. `applyPlanLimit` decides what counts as news; anything that is
   * none returns `null` and nothing is pushed, which is what keeps a chatty
   * event stream from becoming a chatty push channel.
   */
  const foldPlanLimit = (event: AgentEvent): void => {
    if (event.type !== 'plan.limit') return;
    // Live or recently finished — either way the handle knows the profile the
    // run was spending, which the event alone does not carry.
    const run = runs.get(event.runId);
    if (run === undefined) return;

    const merged = applyPlanLimit(planUsageCache.get(run.profileId) ?? null, event.limit, Date.now());
    if (merged === null) return;

    planUsageCache.set(run.profileId, merged);
    const push: PlanUsagePush = { profileId: run.profileId, usage: merged };
    // Copied before iterating: a listener may unsubscribe itself mid-call.
    for (const listener of [...planUsageListeners]) {
      try {
        listener(push);
      } catch (error) {
        log.error(`A plan-usage listener failed on profile ${run.profileId}`, error);
      }
    }
  };

  runs.subscribe((event) => {
    namer.handleEvent(event);
    owners.handleEvent(event);
    foldPlanLimit(event);
  });

  return {
    listProviders: (query) =>
      providers.describe({
        refresh: query.refresh,
        /*
         * Probes a local provider at the address one of its profiles names.
         * Any profile of that provider will do — the question is whether the
         * *provider* is usable, and a user with two llama.cpp profiles has two
         * addresses either of which answering means yes. The first enabled one
         * is the one a fresh session would pick anyway.
         *
         * Costs nothing for the other providers: they ignore the argument, and
         * a provider with no profiles resolves to `undefined` without touching
         * the filesystem.
         */
        envFor: async (id) => {
          const candidates = await profiles.list(id);
          const chosen = candidates.find((p) => p.disabled !== true) ?? candidates[0];
          if (chosen === undefined) return undefined;
          try {
            return await envFor(chosen.id, id);
          } catch {
            // A profile with an unusable config directory is the profile
            // screen's problem to report, not a reason to fail the whole
            // provider list.
            return undefined;
          }
        },
      }),

    /**
     * Ask a provider what models this account really has.
     *
     * The credential-bearing `envFor` — the same resolution a run gets — is
     * deliberate and not interchangeable with `storeEnvFor`. A catalogue is a
     * property of the account, so a bundle with no key in it would either be
     * refused or would answer for whatever account the CLI finds on its own,
     * which is precisely the cross-profile leak the isolated config directory
     * exists to prevent.
     *
     * Every branch resolves. A provider Artemis cannot drive, an adapter that
     * cannot enumerate, or a fetch that failed are all "here is the built-in
     * list, and no, the account did not confirm it" — the caller renders a
     * picker either way and labels it from `live`.
     */
    listProviderModels: async (query) => {
      const adapter = providers.get(query.providerId);
      // Not registered at all: there is no static list to fall back *to*, so
      // the honest answer is nothing rather than another provider's models.
      if (adapter === undefined) return { models: [], live: false };

      const fallback = adapter.models ?? [];
      if (adapter.listModels === undefined) return { models: fallback, live: false };

      try {
        // `live` comes back from the adapter rather than being inferred here.
        // `listModels` resolves on failure by contract, so a fallback is
        // indistinguishable from a real answer by inspection — the adapter is
        // the only party that knows which it returned, so it is the only party
        // that can say. See `ProviderAdapter.listModels`.
        const catalogue = await adapter.listModels({
          env: await envFor(query.profileId, query.providerId),
          // The query has to start somewhere that exists. userData always does;
          // the user's chosen workspace may not be set yet.
          cwd: query.cwd ?? userDataDir,
        });
        // Only the confirmed list is worth remembering; see `modelCatalogues`.
        if (!catalogue.live) return catalogue;
        const key = catalogueKey(query.providerId, query.profileId);
        const models = rememberModels(modelCatalogues.get(key), catalogue.models);
        modelCatalogues.set(key, models);
        return { ...catalogue, models };
      } catch (error) {
        // The contract says it should not reject; if one does, that is a bug in
        // the adapter and not a reason to leave the picker empty.
        log.error(`Provider "${query.providerId}" threw while listing models`, error);
        return { models: fallback, live: false };
      }
    },

    /*
     * The command list, asked of the provider and remembered for a moment.
     *
     * The cache is the load-bearing part. A column settling on an account asks
     * for this, and so does the composer the first time a `/` is typed with
     * nothing loaded — so two columns on one account, or one column asked twice
     * in the same second, would otherwise each spawn a CLI to be told the same
     * thing. In flight requests are shared rather than merely their results,
     * because the overlap that matters is the one that happens while the first
     * answer is still coming back.
     *
     * Keyed by directory as well as account: commands are discovered relative to
     * a working directory, so two projects on one profile are two questions.
     *
     * Deliberately never invalidated on a timer. It is dropped when the process
     * is, which is the same lifetime `modelCatalogues` has; a plugin installed
     * mid-session is a case the renderer handles by asking again on the next
     * settle, and one installed with Artemis closed is a new launch anyway.
     */
    listProviderCommands: async (query) => {
      const adapter = providers.get(query.providerId);
      // Bound here rather than called through `adapter` below: the narrowing
      // does not survive into the async closure, and re-reading the property
      // there would be a second lookup that could in principle differ.
      const listCommands = adapter?.listCommands?.bind(adapter);
      if (listCommands === undefined) return { commands: [] };

      // The query has to start somewhere that exists — the same substitution
      // `listProviderModels` makes, and for the same reason.
      const cwd = query.cwd ?? userDataDir;
      const key = `${query.providerId}:${query.profileId}:${cwd}`;
      const cached = commandLists.get(key);
      if (cached !== undefined) return cached;

      const pending = (async (): Promise<{ readonly commands: readonly string[] }> => {
        // The same plugins a run here would load, which is the whole point: the
        // user's own commands arrive on that channel, and a list without them
        // would be missing exactly the rows they are reaching for. See
        // `contentPluginsFor`.
        const [env, plugins] = await Promise.all([
          envFor(query.profileId, query.providerId),
          contentPluginsFor(query.profileId, query.providerId),
        ]);
        const commands = await listCommands({ env, cwd, plugins });
        return { commands };
      })().catch((error: unknown) => {
        // The contract says it should not reject; if one does, that is a bug in
        // the adapter and not a reason to wedge the menu shut forever — so the
        // failure is dropped from the cache and the next ask tries again.
        log.error(`Provider "${query.providerId}" threw while listing commands`, error);
        commandLists.delete(key);
        return { commands: [] as readonly string[] };
      });

      commandLists.set(key, pending);
      return pending;
    },

    listProfiles: (query) => profiles.listMetadata(query.providerId),

    // `create` resolves a full `Profile`. Narrowing it to its id here means the
    // secret-bearing fields are not even visible to the rest of this function;
    // the renderer-safe projection comes from `describe`.
    createProfile: async (draft) => {
      const created: { readonly id: ProfileId } = await profiles.create(draft);
      return profiles.describe(created.id);
    },
    updateProfile: async (id, patch) => {
      const updated: { readonly id: ProfileId } = await profiles.update(id, patch);
      return profiles.describe(updated.id);
    },
    deleteProfile: async (id, query) => {
      const result = await profiles.delete(id, { deleteConfigDir: query.deleteConfigDir });
      // The ledger's claims for a deleted account are dropped rather than left
      // to rot. Harmless on their own — nothing resolves these ids back into
      // accounts except by matching against profiles that exist — but a config
      // directory reused by a new profile would otherwise inherit them.
      // Awaited only for its errors, which `SessionOwners` reports rather than
      // throws, so this cannot fail a deletion that already happened.
      await owners.forget([id]);
      return result;
    },

    /**
     * Start a run, and — if it opens a new session — have that session named
     * and its account recorded.
     *
     * Both subscribers are told the registry's id rather than the input's,
     * because `RunInput.runId` is optional and core mints one when it is
     * absent. Both return immediately and start nothing; each is triggered by
     * the `session.started` event they are subscribed to above.
     *
     * `owners.noteRun` is called for every run and `namer.noteRun` is not —
     * the namer filters resumes and forks out because they are not first
     * messages, whereas a resume is precisely when a session whose account was
     * never recorded acquires one. Each filters at its own call site rather
     * than here, so neither rule has to be restated in the composition root.
     */
    readAgentPrompts: () => agentPrompts.read(),
    writeAgentPrompts: (document) => agentPrompts.write(document),

    startRun: async (input) => {
      // The banks' own `SessionStart` hook cannot run under `settingSources:
      // []`, so Artemis runs the sync cycle itself — one spawn, every enabled
      // bank. Started before the run and never awaited: it promotes what the
      // last session drafted and pulls what teammates landed, neither of which
      // this run may wait on.
      syncMemoryBanksInBackground();

      // Every enabled bank is attached to the run as a directory it may read.
      // A bank lives outside cwd — a clone in `~/Documents`, typically — so a
      // local model, whose tool sandbox is rooted at cwd, otherwise cannot open
      // the very knowledge base the bank exists to hold. Gated on the master
      // switch, and a no-op merge returns the input by reference, so a machine
      // with banks off or none configured starts exactly the run it would have.
      const bankDirs = mergeAdditionalDirectories(
        input.additionalDirectories,
        isMasterEnabled() ? banksForRun().map((bank) => bank.path) : [],
        isMasterEnabled(),
      );
      const withBanks =
        bankDirs === input.additionalDirectories ? input : { ...input, additionalDirectories: bankDirs };

      // The library is attached here and not in the renderer, so that every
      // path that will ever start a run gets it without having to remember to.
      // `namer` and `owners` are told about the *original* input on purpose:
      // they record what the user asked for — the prompt to name the session
      // by, the account to attribute it to — and neither is a fact about the
      // system prompt or the bank directories the run happened to carry.
      const handle = await runs.start(await withAgentPrompts(withBanks));
      namer.noteRun(input, handle.runId);
      owners.noteRun(input, handle.runId);
      return handle;
    },
    sendToRun: (runId, text, attachments) => runs.send(runId, text, attachments),
    interruptRun: (runId) => runs.interrupt(runId),
    stopTask: (runId, taskId) => runs.stopTask(runId, taskId),
    respondToPermission: async (runId, requestId, decision) => {
      await runs.respondToPermission(runId, requestId, decision);
    },
    disposeRun: async (runId) => {
      await runs.dispose(runId);
    },
    listRuns: (query) => Promise.resolve(runs.list(query.cwd)),
    getRun: (runId) => runs.get(runId),
    liveWorkSessions: () => {
      // Deduplicated across providers: one conversation belongs to exactly one
      // adapter, but nothing in the registry enforces that, and a session named
      // twice would make a window's "keep this" set quietly depend on ordering.
      const holding = new Set<SessionId>();
      // A live run is work too, including for adapters such as Codex whose
      // process has no longer-lived background-work ledger of its own. Usually
      // the renderer already knows about these through its pane. This copy is
      // the recovery truth for the case where that pane lost its run binding:
      // without it the sidebar says idle while the registry and provider are
      // still advancing the conversation.
      for (const handle of runs.list()) {
        if (handle.status !== 'ended' && handle.sessionId !== undefined) {
          holding.add(handle.sessionId);
        }
      }
      for (const adapter of providers.list()) {
        for (const sessionId of adapter.sessionsHoldingWork?.() ?? []) holding.add(sessionId);
      }
      return [...holding];
    },

    workingSessions: () => {
      const working = new Set<SessionId>();
      // The registry is authoritative for open turns. Adapters contribute the
      // work that can outlive one below; neither source subsumes the other.
      // Including registry runs is especially important for Codex, which has
      // no sessionsWorking hook: a stale renderer must still be told that its
      // session is active so it can recover instead of starting a rival turn.
      for (const handle of runs.list()) {
        if (handle.status !== 'ended' && handle.sessionId !== undefined) {
          working.add(handle.sessionId);
        }
      }
      for (const adapter of providers.list()) {
        // An adapter without the split falls back to its retention set — for
        // one that cannot distinguish, "retained" is the conservative reading
        // of "working", which errs the way the old single set did.
        for (const sessionId of adapter.sessionsWorking?.() ??
          adapter.sessionsHoldingWork?.() ??
          []) {
          working.add(sessionId);
        }
      }
      return [...working];
    },

    delegatedWork: () => {
      // Deduplicated by session for the reason above, and first-writer-wins
      // rather than last: with one conversation per adapter the case cannot
      // arise, and if it somehow does, silently merging two providers' rows into
      // one list would be a worse answer than taking one of them whole.
      const bySession = new Map<SessionId, SessionDelegatedWork>();
      for (const adapter of providers.list()) {
        for (const entry of adapter.delegatedWork?.() ?? []) {
          if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, entry);
        }
      }
      return [...bySession.values()];
    },

    runEvents: (query) => {
      const afterSeq = query.afterSeq ?? -1;
      const events = runs.eventsSince(query.runId, afterSeq);
      // The buffer drops from the front, so a first event that is not the one
      // immediately after `afterSeq` is the only evidence that something was
      // lost. Derived here because `eventsSince` returns a plain slice and the
      // renderer has no way to tell a short run from a trimmed one.
      const first = events[0];
      return { events, truncated: first !== undefined && first.seq > afterSeq + 1 };
    },

    /**
     * Read a profile's session history.
     *
     * This does not go through the run registry. Listing needs a resolved
     * environment (for Claude, the profile's isolated `CLAUDE_CONFIG_DIR` is
     * what locates `projects/<encoded-cwd>/*.jsonl`) but it starts no run, so
     * routing it through the registry would mean the registry resolving
     * credentials for a query it otherwise has no part in.
     *
     * Providers without `capabilities.listSessions` simply do not implement the
     * method; that is reported as a plain failure rather than an empty list, so
     * the UI can say "this provider has no session history" instead of showing
     * a history pane that is silently always empty.
     */
    /**
     * Last-known plan usage, served without touching the provider.
     *
     * Deliberately a plain in-memory map rather than a persisted cache. A
     * utilization percentage is only meaningful for minutes, and a figure
     * restored from disk after a week would be actively misleading — worse
     * than showing nothing, because it looks authoritative. Losing it on quit
     * is the correct behaviour, not a limitation.
     */
    cachedPlanUsage: (profileId) => planUsageCache.get(profileId) ?? null,

    refreshPlanUsage: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.fetchPlanUsage === undefined) {
        // Capability-off is an answer, not a fault: the picker still opens and
        // explains itself rather than erroring at the user.
        return {
          available: false,
          unavailableReason: `${adapter.label} does not report plan usage.`,
          windows: [],
          fetchedAt: Date.now(),
        };
      }

      const usage = await adapter.fetchPlanUsage({
        profileId: query.profileId,
        // A credential-bearing environment: unlike history, this read is
        // *about* the account, so it needs the account's credential.
        env: await envFor(query.profileId, profile.providerId),
        // The probe has to start somewhere that exists. userData always does,
        // and the user's chosen workspace may not be set yet.
        cwd: userDataDir,
      });

      /*
        Never let the cache go backwards.

        Two reads of one account overlap routinely — the poll's sweep and the
        targeted read a run's end asks for — and each takes as long as a CLI
        spawn, so the one that started first can finish last. Storing whichever
        answered most recently would leave `cachedPlanUsage` describing an
        earlier moment than the reading it replaced, which is then what every
        newly-opened window seeds itself from.

        The caller still gets what *this* read learned; it is only the shared
        cache that insists on moving forward.
      */
      const previous = planUsageCache.get(query.profileId);
      if (previous === undefined || usage.fetchedAt >= previous.fetchedAt) {
        planUsageCache.set(query.profileId, usage);
      }
      return usage;
    },

    suggestConfigDir: (label) => profiles.suggestConfigDir(label),

    authStatus: async (profileId) => {
      const options = await authOptionsFor(profileId);
      return {
        status: await checkAuthStatus(options),
        signInCommand: signInCommand({ ...options, shell: signInShell }),
      };
    },

    signOut: async (profileId) => {
      const options = await authOptionsFor(profileId);
      // `signOut` re-reads the directory afterwards rather than assuming the
      // logout took: a failed sign-out rendered as signed-out would leave the
      // real credential in place while the UI claimed otherwise.
      return {
        status: await cliSignOut(options),
        signInCommand: signInCommand({ ...options, shell: signInShell }),
      };
    },

    /*
     * The remote half. Each of these is one authenticated request to the server
     * the profile names, and the environment they are built from is the same
     * one a *run* against that profile gets — address and connection token,
     * resolved through `envFor`. A separate resolution here would be a second
     * place for the address to be wrong.
     */
    remoteAccounts: async (profileId) => readRemoteAccounts(await remoteEnvFor(profileId)),

    createRemoteAccount: async (profileId, request) =>
      createRemoteAccount(await remoteEnvFor(profileId), request),
    updateRemoteAccount: async (profileId, accountId, patch) =>
      updateRemoteAccount(await remoteEnvFor(profileId), accountId, patch),
    deleteRemoteAccount: async (profileId, accountId) =>
      deleteRemoteAccount(await remoteEnvFor(profileId), accountId),
    readRemotePlanUsage: async (profileId) =>
      (await readRemoteUsage(await remoteEnvFor(profileId))).accounts,

    startRemoteSignIn: async (profileId, accountId) => {
      const env = await remoteEnvFor(profileId);
      const status = await startRemoteSignIn(env, accountId);
      syncSignInForwarder(accountId, status, env);
      return status;
    },

    remoteSignInStatus: async (profileId, accountId) => {
      const env = await remoteEnvFor(profileId);
      const status = await readRemoteSignIn(env, accountId);
      syncSignInForwarder(accountId, status, env);
      return status;
    },

    submitRemoteSignInCode: async (profileId, accountId, code) =>
      submitRemoteSignInCode(await remoteEnvFor(profileId), accountId, code),

    cancelRemoteSignIn: async (profileId, accountId) => {
      stopSignInForwarder(accountId);
      return cancelRemoteSignIn(await remoteEnvFor(profileId), accountId);
    },

    getSessionMessages: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.getSessionMessages === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot open a stored session.`);
      }
      // Read-only, like listing: a local store's environment is the config
      // directory and no credential. A remote store's read is an authenticated
      // request and carries the credential — see `historyEnvFor`.
      return adapter.getSessionMessages({
        profileId: query.profileId,
        sessionId: query.sessionId,
        runId: query.runId,
        env: await historyEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    getSubagentMessages: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.getSubagentMessages === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot open a subagent's transcript.`);
      }
      // Read-only, exactly as `getSessionMessages` is: the store environment
      // carries the config directory and no credential.
      return adapter.getSubagentMessages({
        profileId: query.profileId,
        sessionId: query.sessionId,
        agentId: query.agentId,
        runId: query.runId,
        env: await storeEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },

    renameSession: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      /*
       * The same adapter method `SessionNamer` uses to store a generated name.
       *
       * Deliberately not a second one. A user-typed title and a model-written
       * one are the same fact about a session — its own name, as opposed to a
       * summary the provider derived — and they belong in the same field. Two
       * write paths into one store would eventually disagree about which of
       * them `titleIsCustom` describes.
       */
      if (adapter.setSessionTitle === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot rename a stored session.`);
      }

      /*
       * Normalised here rather than at the edge, because the caller is told
       * what was *stored* and that answer has to be produced by whoever does
       * the storing. Trimming at the IPC boundary and returning the untrimmed
       * string would leave the sidebar showing a title with whitespace the
       * transcript does not have.
       */
      const title = query.title.trim().slice(0, MAX_SESSION_TITLE);
      if (title.length === 0) {
        // A title that trims to nothing is a bad request, not a broken engine:
        // `EngineUnavailableError` maps to `provider_not_found`, which reached
        // the user as "Artemis's engine is unavailable: A session title cannot
        // be empty" — a sentence about the wrong thing entirely.
        throw new ValidationError('title', 'cannot be empty');
      }

      await adapter.setSessionTitle({
        sessionId: query.sessionId,
        title,
        // `historyEnvFor`, not `storeEnvFor`: a provider whose sessions live on
        // the other end of an authenticated request (`sessionStore: 'remote'`)
        // renames with the same credential a listing already carries. Local
        // stores still get the no-decrypt bundle.
        env: await historyEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { title };
    },

    deleteSession: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.deleteSession === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot delete a stored session.`);
      }

      const deleted = await adapter.deleteSession({
        sessionId: query.sessionId,
        // See `renameSession` for why this is the history bundle.
        env: await historyEnvFor(query.profileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { deleted };
    },

    tagSession: async (query) => {
      const profile = await profiles.require(query.profileId);
      const adapter = providers.get(profile.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(
          `No adapter is registered for provider "${profile.providerId}".`,
        );
      }
      if (adapter.tagSession === undefined) {
        throw new EngineUnavailableError(`${adapter.label} cannot tag a stored session.`);
      }

      const tagged = await adapter.tagSession({
        sessionId: query.sessionId,
        // See `renameSession` for why this is the history bundle.
        env: await historyEnvFor(query.profileId, profile.providerId),
        tag: query.tag,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { tagged };
    },

    listSessions: async (query) => {
      const adapter = providers.get(query.providerId);
      if (adapter === undefined) {
        throw new EngineUnavailableError(`No adapter is registered for provider "${query.providerId}".`);
      }
      if (adapter.listSessions === undefined) {
        throw new EngineUnavailableError(`${adapter.label} does not support listing session history.`);
      }
      return adapter.listSessions({
        profileId: query.profileId,
        cwd: query.cwd,
        env: await historyEnvFor(query.profileId, query.providerId),
        limit: query.limit,
        offset: query.offset,
      });
    },

    /**
     * Read every profile's history, across every project.
     *
     * Three properties are load-bearing here, and each one is a bug that was
     * easy to write instead:
     *
     *  1. **Read-only.** Environments come from `resolveStoreEnv`, which emits
     *     the config-directory variable and no credential. A history pane must
     *     not decrypt a key, and profiles with no key stored — a state the
     *     protocol models deliberately — must still list their transcripts.
     *  2. **Partial success.** A profile whose config directory is missing or
     *     unreadable, or whose environment cannot even be resolved (a
     *     hand-edited `configDirName`, say), contributes nothing and is logged.
     *     One broken profile blanking the whole sidebar would be a far worse
     *     failure than one profile's history being absent.
     *  3. **Merge, then slice.** Every provider and profile is read in full
     *     before the sort, because an ordering across the whole set does not
     *     exist until every partition has answered. Paginating per profile
     *     would drop one profile's older sessions in favour of another's newer
     *     ones before the two were ever compared.
     */
    listAllSessions: async (query) => {
      const records = await profiles.list(query.providerId);

      // Group by provider so each adapter is asked once, with all of its
      // profiles. `providerId` is read from the profile rather than assumed,
      // so a future Codex profile is routed to the Codex adapter.
      const byProvider = new Map<ProviderId, Profile[]>();
      for (const profile of records) {
        const group = byProvider.get(profile.providerId);
        if (group === undefined) byProvider.set(profile.providerId, [profile]);
        else group.push(profile);
      }

      const collected: SessionSummary[] = [];

      for (const [providerId, group] of byProvider) {
        const adapter = providers.get(providerId);
        // A provider that is not registered, or that cannot enumerate history,
        // simply has none to contribute. Unlike `listSessions` this is not
        // reported as an error: the caller asked for "everything", and
        // everything legitimately excludes providers that cannot answer.
        if (adapter?.listAllSessions === undefined) continue;

        const scopes: SessionListScope[] = [];
        for (const profile of group) {
          try {
            scopes.push({
              profileId: profile.id,
              env: await historyEnvFor(profile.id, providerId),
            });
          } catch (error) {
            log.warn(`Skipping profile ${profile.id} while listing all sessions`, error);
          }
        }
        if (scopes.length === 0) continue;

        try {
          const page = await adapter.listAllSessions({ profiles: scopes });
          if (page.unreadableProfiles.length > 0) {
            log.warn(
              `${String(page.unreadableProfiles.length)} ${providerId} profile(s) had no readable session store: ${page.unreadableProfiles.join(', ')}`,
            );
          }
          collected.push(...page.sessions);
        } catch (error) {
          // The adapter is contracted to degrade per profile rather than
          // throw, but a bug there must still not take the sidebar down.
          log.error(`Provider ${providerId} failed to list all sessions`, error);
        }
      }

      /*
       * Put the real account back on the rows an adapter could only pick one for.
       *
       * `profileIsUnknown` marks a session in a store several profiles reach —
       * the shared-config arrangement, where `projects/` is symlinked into
       * every profile — and on those rows `profileId` is the first sharer
       * rather than an answer. Left alone, every shared row in the sidebar
       * carries the same arbitrary account label, which is the one question the
       * label exists to answer, answered wrongly and confidently.
       *
       * The ledger settles it for every session this install started or
       * resumed. A session it has never seen keeps the flag and the pick, and
       * the sidebar shows no account for it rather than inventing one.
       *
       * Done here rather than in the adapter because the adapter is the wrong
       * component to know it: it reads a provider's store, and this is Artemis's
       * own bookkeeping about runs it drove. The ledger is only opened when a
       * row actually needs it, so an install with no shared store never touches
       * the file.
       */
      if (collected.some((summary) => summary.profileIsUnknown === true)) {
        const recorded = await owners.all();
        for (const [index, summary] of collected.entries()) {
          collected[index] = attributeSession(summary, recorded);
        }
      }

      collected.sort((a, b) =>
        a.updatedAt !== b.updatedAt
          ? b.updatedAt - a.updatedAt
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );

      const offset = query.offset ?? 0;
      const limit = query.limit;
      const sessions =
        limit === undefined ? collected.slice(offset) : collected.slice(offset, offset + limit);
      const hasMore = limit === undefined ? false : collected.length > offset + limit;

      return { sessions, hasMore };
    },

    subscribe: (listener) => runs.subscribe(listener),

    subscribeSuggestions: (listener) => {
      suggestionListeners.add(listener);
      return () => suggestionListeners.delete(listener);
    },

    subscribePlanUsage: (listener) => {
      planUsageListeners.add(listener);
      return () => planUsageListeners.delete(listener);
    },

    // All three, and in parallel: a half-written title is not worth delaying
    // quit for, and `SessionNamer.dispose` aborts rather than waits.
    //
    // `owners.flush` is the one that genuinely waits, and it is cheap — a write
    // already in flight, or nothing. Skipping it would drop the account for
    // whichever session was started last, which is exactly the session the user
    // will look for first when they reopen.
    dispose: async () => {
      // Written before the teardown is awaited, so the line exists even if the
      // teardown hangs past Electron's patience. Its absence is the signal: a
      // log that ends without `engine.stopped` ends in a crash.
      lifecycle.record({ kind: 'engine.stopped' });
      await Promise.all([runs.disposeAll(), namer.dispose(), owners.flush()]);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Host                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A handle to the engine that is safe to hold before — and after — it fails.
 *
 * IPC handlers call {@link require}, which either returns a live engine or
 * throws {@link EngineUnavailableError}. That is normalized into a
 * `provider_not_found` result, so the UI can say "Artemis's engine failed to
 * start" instead of waiting on a promise that never settles.
 */
export class EngineHost {
  #engine: ArtemisEngine | null = null;
  #failure: EngineUnavailableError | null = null;

  /** The live engine, or a descriptive throw. */
  require(): ArtemisEngine {
    if (this.#engine) return this.#engine;
    throw this.#failure ?? new EngineUnavailableError('the engine has not been started yet.');
  }

  /** True when the engine is running. */
  get ready(): boolean {
    return this.#engine !== null;
  }

  /** Why the engine is not running, for the startup dialog. */
  get failureMessage(): string | null {
    return this.#failure?.message ?? null;
  }

  /**
   * Assemble the engine.
   *
   * Never throws: a failure is recorded and reported through {@link require} so
   * that window creation and the rest of startup carry on. An app that refuses
   * to launch cannot explain itself.
   */
  async start(options: EngineOptions): Promise<void> {
    try {
      this.#engine = await Promise.resolve(createEngine(options));
      this.#failure = null;
      log.info('Engine started.');
    } catch (error) {
      const failure =
        error instanceof EngineUnavailableError
          ? error
          : new EngineUnavailableError(error instanceof Error ? error.message : String(error));
      this.#engine = null;
      this.#failure = failure;
      log.error('Engine failed to start', failure);
    }
  }

  /** Tear the engine down. Safe to call when it never started. */
  async stop(): Promise<void> {
    const engine = this.#engine;
    this.#engine = null;
    if (!engine) return;
    try {
      await engine.dispose();
    } catch (error) {
      log.error('Engine disposal failed', error);
    }
  }
}
