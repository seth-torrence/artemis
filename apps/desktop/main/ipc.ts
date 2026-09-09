/**
 * The IPC layer.
 *
 * `@rx-artemis/protocol` defines the channels, the request and response types, and
 * the rule that handlers resolve an {@link IpcResult} instead of rejecting.
 * This file is the main-process half of that contract, and it adds three things
 * the type system cannot express:
 *
 *  1. **Sender verification.** Every message must come from Artemis's own
 *     top-level frame at an allowed URL. A nested frame cannot reach these
 *     handlers.
 *  2. **Validation.** Payloads arrive as `unknown` and are checked and rebuilt
 *     by `./validate.ts` before any of them reaches the engine.
 *  3. **A leak tripwire.** Every response is scanned by `./redact.ts` on its way
 *     out. A handler that returns a `Profile` where the contract says
 *     `ProfileMetadata` throws here rather than shipping a credential to the
 *     renderer.
 *
 * (3) is the reason this file exists as a chokepoint rather than as one
 * `ipcMain.handle` call per channel scattered through the bootstrap. There is
 * exactly one path from a handler's return value to the renderer, and the
 * assertion sits on it.
 *
 * ### One event channel, not one per run
 *
 * Agent events are pushed on the single {@link IPC_PUSH.agentEvent} channel
 * defined by the protocol, and the renderer demultiplexes on `event.runId`.
 * A channel per run would force the preload to build channel names out of
 * renderer-supplied strings, which is precisely the dynamic-channel pattern the
 * preload is forbidden to have. The protocol's `ArtemisBridge.runs.onEvent` is
 * likewise a single global subscription, so one channel is also what the
 * contract asks for.
 */

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';

import {
  IPC,
  IPC_CHANNELS,
  IPC_PUSH,
  ipcFail,
  ipcOk,
  sharedConfigDirs,
  type AgentEvent,
  type IpcChannel,
  type IpcHandlerResult,
  type IpcPushChannel,
  type IpcRequest,
  type IpcResponse,
  type RunSuggestion,
  type Unsubscribe,
  type WorkspacePickDirectoryRequest,
} from '@rx-artemis/protocol';

import { checkWorkingDirectory, createWorktree, describeWorkspace } from '@rx-artemis/core';

import {
  addMemoryBank,
  forgetMemoryBank,
  readMemoryBankMemories,
  readMemoryBanksPreflight,
  readMemoryBanksStatus,
  retireMemoryBankMemory,
  setMasterEnabled,
  setMemoryBankEnabled,
  syncMemoryBank,
  verifyMemoryBankRemote,
  promptBanks,
} from './memoryBanks.js';
import type { EngineHost } from './engine.js';
import {
  toIpcError,
  UntrustedSenderError,
  ValidationError,
  WorkspaceError,
} from './errors.js';
import { createLogger } from './log.js';
import { broadcastPlanUsageReading } from './planUsagePoll.js';
import { grantPreview } from './preview.js';
import type { BrowserHost } from './browser.js';
import { checkFiles, listDirectory, readTextFile } from './files.js';
import { readPullRequests } from './github.js';
import {
  assertNoSecrets,
  assertResponseSafe,
  EVENT_SCAN_POLICY,
  RESPONSE_SCAN_POLICY,
  TERMINAL_SCAN_POLICY,
} from './redact.js';
import {
  deleteSecretConnection,
  fetchServerCertificate,
  listSecretConnections,
  saveSecretConnection,
  testSecretRef,
  verifySecretConnection,
} from './secretManagers.js';
import { isTrustedFrame, type SecurityPolicy } from './security.js';
import { normalizeRemoteOrigin, type RemoteAccess } from './remoteAccess.js';
import type { ServerHost } from './server.js';
import type { RoutineHost } from './routines.js';
import { readSharedConfigStatus } from './sharedConfig.js';
import type { TerminalHost } from './terminal.js';
import type { Updater } from './updater.js';
import {
  validateProfilesCreate,
  validateProfilesDelete,
  validateProfilesList,
  validateProfilesUpdate,
  validateProvidersList,
  validateProvidersCommands,
  validateProvidersModels,
  validateRunsDispose,
  validateRunsInterrupt,
  validateRunsStopTask,
  validateRunsEvents,
  validateRunsList,
  validateRunsLiveWork,
  validateRunsRespondPermission,
  validateRunsSend,
  validateRunsStart,
  validateServerCatalogue,
  validateRemoteConfigure,
  validateRemoteStatus,
  validateRoutinesList,
  validateRoutinesCreate,
  validateRoutinesUpdate,
  validateRoutinesDelete,
  validateRoutinesRunNow,
  validateServerConfigure,
  validateServerCreateConnection,
  validateServerDeleteConnection,
  validateServerRenameConnection,
  validateServerStart,
  validateServerStatus,
  validateServerStop,
  validateSessionsList,
  validateSessionsDelete,
  validateSessionsTag,
  validateSessionsListAll,
  validateSessionsMessages,
  validateSessionsSubagentMessages,
  validateSessionsRename,
  validateSharedConfigStatus,
  validateProfilesSuggestDir,
  validatePreviewOpen,
  validateFilesList,
  validateFilesRead,
  validateFilesCheck,
  validateGithubPullRequests,
  validateBrowserOpen,
  validateBrowserNavigate,
  validateBrowserCommand,
  validateBrowserLayout,
  validateBrowserClose,
  validateBrowserList,
  validateTerminalClose,
  validateTerminalList,
  validateTerminalReplay,
  validateTerminalResize,
  validateTerminalStart,
  validateTerminalWrite,
  validateAuthSignOut,
  validateAuthStatus,
  validateServerAccounts,
  validateServerAccountsCreate,
  validateServerAccountsDelete,
  validateServerAccountsUpdate,
  validateServerAccountSignIn,
  validateServerAccountSubmitCode,
  validateAgentPromptsList,
  validateAgentPromptsSave,
  validateMemoryBankAdd,
  validateMemoryBankForget,
  validateMemoryBankMemories,
  validateMemoryBankRetire,
  validateMemoryBankSetEnabled,
  validateMemoryBankSync,
  validateMemoryBanksPreflight,
  validateMemoryBanksSetMasterEnabled,
  validateSecretsConnectionDelete,
  validateSecretsConnectionSave,
  validateSecretsConnectionVerify,
  validateSecretsConnectionsList,
  validateSecretsFetchServerCert,
  validateSecretsRefTest,
  validateMemoryBanksStatus,
  validateMemoryBanksVerifyRemote,
  validateUsagePlan,
  validateUpdatesCheck,
  validateUpdatesDismiss,
  validateUpdatesSetChannel,
  validateUpdatesInstall,
  validateUpdatesRestart,
  validateUpdatesState,
  validateWindowRequest,
  validateWorkspaceCreateWorktree,
  validateWorkspaceDescribe,
  validateWorkspacePickDirectory,
} from './validate.js';
import { readWindowState } from './window.js';
import { DIRECTORY_PICKER_PROPERTIES, readPickedDirectory } from './workspace.js';

const log = createLogger('ipc');

/**
 * One channel's implementation: how to check the request, and what to do with
 * it once checked.
 *
 * Written as a mapped type over {@link IpcChannel} so that the object literal
 * below is exhaustive by construction — adding a channel to the protocol breaks
 * this file's build until it is handled, which is the point.
 */
type ChannelHandlers = {
  readonly [C in IpcChannel]: {
    readonly validate: (raw: unknown) => IpcRequest<C>;
    readonly handle: (request: IpcRequest<C>, context: HandlerContext) => Promise<IpcResponse<C>>;
  };
};

/**
 * What a handler knows about *where* a request came from, beyond its payload.
 *
 * Deliberately not the `IpcMainInvokeEvent` itself. A handler with the raw
 * event can reach `event.sender` and from there most of Electron, which is a
 * much wider surface than any of these handlers needs — and the one thing they
 * do need is modest: a native dialog has to be parented to the window that
 * asked for it, or it opens detached from the app (and, on macOS, is not
 * sheeted to the window that will be blocked while it is open).
 */
export interface HandlerContext {
  /**
   * The window the request came from, or `null` when it has already been
   * destroyed — which is routine for an in-flight call during a reload or a
   * quit, and never worth failing over.
   */
  readonly window: BrowserWindow | null;
}

export interface IpcLayerOptions {
  readonly engine: EngineHost;
  readonly policy: SecurityPolicy;
  readonly updater: Updater;
  readonly terminals: TerminalHost;
  readonly browsers: BrowserHost;
  readonly server: ServerHost;
  readonly routines: RoutineHost;
  readonly remoteAccess: RemoteAccess;
}

/** Handle for tearing the IPC layer down again. */
export interface IpcLayer {
  dispose(): void;
}

/**
 * Register every channel in the protocol.
 *
 * Returns a disposer; `ipcMain.handle` throws if a channel is registered twice,
 * so a hot-reloaded main process has to be able to unregister.
 */
export function registerIpcHandlers(options: IpcLayerOptions): IpcLayer {
  const { engine, policy, updater, terminals, browsers, server, routines, remoteAccess } = options;

  /**
   * Drop the conversations a program started, leaving the person's own.
   *
   * `hasMore` is deliberately left as the engine reported it. It describes the
   * *provider's* pagination — whether more rows exist past this offset — and
   * that is still true after filtering. Recomputing it from the filtered length
   * would tell the sidebar "no more" while the next page still holds the user's
   * own conversations behind a few server ones.
   */
  const withoutServerSessions = <T extends { readonly id: string }>(
    sessions: readonly T[],
  ): readonly T[] => sessions.filter((session) => !server.isServerSession(session.id));

  const handlers: ChannelHandlers = {
    /* ---------------------------------------------------------------- */
    /* Profiles                                                         */
    /* ---------------------------------------------------------------- */

    [IPC.profilesList]: {
      validate: validateProfilesList,
      handle: async (request) => ({
        profiles: await engine.require().listProfiles({ providerId: request.providerId }),
      }),
    },

    /*
     * The three mutations drop the server's cached catalogue.
     *
     * That cache exists because assembling it spawns a provider CLI per account
     * (see `core/server/catalogue.ts`), and its TTL is tuned for the pace at
     * which providers ship models — not for the pace at which a user creates an
     * account and immediately looks for it. A profile added, renamed or deleted
     * changes the *routes*, and a route list that still names a deleted account
     * for five minutes is a client sending turns to an account that is gone.
     *
     * Invalidation and not a rebuild: the next request pays for the refresh, so
     * a user who creates three profiles in a row does not trigger three
     * catalogue builds nobody asked for.
     */
    [IPC.profilesCreate]: {
      validate: validateProfilesCreate,
      handle: async (request) => {
        const profile = await engine.require().createProfile(request.draft);
        server.invalidateCatalogue();
        return { profile };
      },
    },

    [IPC.profilesUpdate]: {
      validate: validateProfilesUpdate,
      handle: async (request) => {
        const profile = await engine.require().updateProfile(request.id, request.patch);
        server.invalidateCatalogue();
        return { profile };
      },
    },

    [IPC.profilesDelete]: {
      validate: validateProfilesDelete,
      handle: async (request) => {
        const result = await engine
          .require()
          .deleteProfile(request.id, { deleteConfigDir: request.deleteConfigDir });
        server.invalidateCatalogue();
        return result;
      },
    },

    [IPC.profilesSuggestDir]: {
      validate: validateProfilesSuggestDir,
      handle: async (request) => ({
        configDir: await engine.require().suggestConfigDir(request.label),
      }),
    },

    /* ---------------------------------------------------------------- */
    /* Providers                                                        */
    /* ---------------------------------------------------------------- */

    [IPC.providersList]: {
      validate: validateProvidersList,
      handle: async (request) => ({
        providers: await engine.require().listProviders({ refresh: request.refresh }),
      }),
    },

    /**
     * The one handler in this file that deliberately swallows its failure.
     *
     * Everywhere else, a fault becomes an `IpcFail` and the UI says so. Here
     * the UI cannot usefully say anything: the caller is a model picker, and
     * "Artemis could not read your model list" leaves the user staring at an
     * empty menu with no way to change a setting. The engine already resolves
     * the adapter's built-in list for every ordinary failure — no CLI, no
     * credential, no network — so the only thing left to catch is the engine
     * itself being down, and an empty list is the truthful answer to that.
     *
     * `live: false` is what keeps this from being a lie. It is the difference
     * between the renderer showing a catalogue and the renderer showing a
     * catalogue it knows the account never confirmed, which the settings
     * screen labels.
     */
    [IPC.providersModels]: {
      validate: validateProvidersModels,
      handle: async (request) => {
        try {
          return await engine.require().listProviderModels({
            providerId: request.providerId,
            profileId: request.profileId,
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          });
        } catch (error) {
          log.error(`Could not read the model list for provider "${request.providerId}"`, error);
          return { models: [], live: false };
        }
      },
    },

    /*
     * The slash commands a session here would offer, before there is one.
     *
     * Swallows like `providersModels` above and lands somewhere gentler: an
     * empty list is what the composer had before this channel existed, so a
     * provider that cannot be reached costs the menu nothing it was not already
     * missing. Logged rather than reported, for the same reason — there is no
     * user-facing failure to explain.
     */
    [IPC.providersCommands]: {
      validate: validateProvidersCommands,
      handle: async (request) => {
        try {
          return await engine.require().listProviderCommands({
            providerId: request.providerId,
            profileId: request.profileId,
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          });
        } catch (error) {
          log.error(`Could not read the command list for provider "${request.providerId}"`, error);
          return { commands: [] };
        }
      },
    },

    /* ---------------------------------------------------------------- */
    /* Runs                                                             */
    /* ---------------------------------------------------------------- */

    [IPC.runsStart]: {
      validate: validateRunsStart,
      handle: async (request) => ({ run: await engine.require().startRun(request.input) }),
    },

    [IPC.runsSend]: {
      validate: validateRunsSend,
      handle: async (request) => {
        const result = await engine
          .require()
          .sendToRun(request.runId, request.text, request.attachments);
        return { runId: request.runId, deliveredImmediately: result.deliveredImmediately };
      },
    },

    [IPC.runsInterrupt]: {
      validate: validateRunsInterrupt,
      handle: async (request) => {
        const result = await engine.require().interruptRun(request.runId);
        return result.stillQueued
          ? { runId: request.runId, stillQueued: result.stillQueued }
          : { runId: request.runId };
      },
    },

    [IPC.runsStopTask]: {
      validate: validateRunsStopTask,
      handle: async (request) => {
        await engine.require().stopTask(request.runId, request.taskId);
        return { runId: request.runId, taskId: request.taskId };
      },
    },

    [IPC.runsRespondPermission]: {
      validate: validateRunsRespondPermission,
      handle: async (request) => {
        await engine.require().respondToPermission(request.runId, request.requestId, request.decision);
        return { requestId: request.requestId };
      },
    },

    [IPC.runsDispose]: {
      validate: validateRunsDispose,
      handle: async (request) => {
        await engine.require().disposeRun(request.runId);
        return { runId: request.runId };
      },
    },

    [IPC.runsList]: {
      validate: validateRunsList,
      handle: async (request) => ({ runs: await engine.require().listRuns({ cwd: request.cwd }) }),
    },

    [IPC.runsLiveWork]: {
      validate: validateRunsLiveWork,
      handle: () => {
        const host = engine.require();
        return Promise.resolve({
          sessionIds: host.liveWorkSessions(),
          working: host.workingSessions(),
          delegated: host.delegatedWork(),
        });
      },
    },

    [IPC.runsEvents]: {
      validate: validateRunsEvents,
      handle: (request) => {
        const replay = engine.require().runEvents({
          runId: request.runId,
          ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
        });
        return Promise.resolve({ runId: request.runId, ...replay });
      },
    },

    /* ---------------------------------------------------------------- */
    /* Sessions                                                         */
    /* ---------------------------------------------------------------- */

    /*
     * Both listings hide conversations the *server* started.
     *
     * A turn that arrived over HTTP writes a transcript indistinguishable from
     * one the user typed — same provider, same directory — so without this a
     * script polling a summariser every minute would push a person's own work
     * off the top of their own sidebar within the hour.
     *
     * Filtered here rather than in the engine because this is where the
     * *sidebar's* question is asked. `listSessions` answers "what is in this
     * account's history", which is a different question with a truthful answer
     * that includes these; the app's history pane asks "what did I start", and
     * that is the one being answered at this boundary. Nothing is deleted — see
     * the core session ledger (`server/ledger.ts` in `@rx-artemis/core`).
     */
    [IPC.sessionsList]: {
      validate: validateSessionsList,
      handle: async (request) => {
        const page = await engine.require().listSessions({
          providerId: request.providerId,
          profileId: request.profileId,
          cwd: request.cwd,
          limit: request.limit,
          offset: request.offset,
        });
        return { ...page, sessions: withoutServerSessions(page.sessions) };
      },
    },

    [IPC.sessionsListAll]: {
      validate: validateSessionsListAll,
      handle: async (request) => {
        const page = await engine.require().listAllSessions({
          providerId: request.providerId,
          limit: request.limit,
          offset: request.offset,
        });
        return { ...page, sessions: withoutServerSessions(page.sessions) };
      },
    },

    /* ---------------------------------------------------------------- */
    /* Workspace                                                        */
    /* ---------------------------------------------------------------- */

    [IPC.workspacePickDirectory]: {
      validate: validateWorkspacePickDirectory,
      handle: async (request, context) => ({
        path: await pickDirectory(request, context.window),
      }),
    },

    /**
     * Name a directory for the sidebar's header.
     *
     * Does not go through the engine: it reads the filesystem and needs no
     * provider, no profile and no adapter, so routing it through the engine
     * would make a label depend on a booted engine for no reason.
     */
    [IPC.workspaceDescribe]: {
      validate: validateWorkspaceDescribe,
      handle: async (request) => describeWorkspace(request.path),
    },

    /**
     * Split a worktree off the repository a directory is in.
     *
     * The neighbour above is a read; this writes, and runs `git` to do it, so
     * a failure here is something the user has to be told about rather than a
     * label that quietly falls back to a directory name. `createWorktree`
     * answers rather than throws — see its own docs for why every failure a
     * user can cause is a sentence — and this turns that answer into the
     * channel's, so the renderer's one error path covers both.
     */
    [IPC.workspaceCreateWorktree]: {
      validate: validateWorkspaceCreateWorktree,
      handle: async (request) => {
        const result = await createWorktree(request.path, request.branch);
        if (!result.ok) throw new WorkspaceError(result.message);
        return { path: result.path, branch: result.branch };
      },
    },

    /* ---------------------------------------------------------------- */
    /* Shared Claude config                                             */
    /* ---------------------------------------------------------------- */

    /**
     * Is the shared `~/.claude` arrangement actually in place?
     *
     * The request is empty (see `validateSharedConfigStatus`), so the *handler*
     * is where the directories come from: the profile store, through the same
     * `sharedConfigDirs` the renderer feeds to the script generator. Two
     * consequences, both intended. The renderer cannot ask this to `lstat` a
     * path of its own choosing, and the reading covers exactly the directories
     * the script covers — which is what makes "the switch says yes and the disk
     * says no" a comparison rather than two unrelated lists.
     *
     * Goes through the engine only for the profile list. The reading itself is
     * `lstat` against `$HOME`, needs no provider and no adapter, and so does not
     * belong behind one.
     */
    [IPC.sharedConfigStatus]: {
      validate: validateSharedConfigStatus,
      handle: async () =>
        readSharedConfigStatus({
          dirs: sharedConfigDirs(await engine.require().listProfiles({})),
        }),
    },

    /* ---------------------------------------------------------------- */
    /* Memory banks                                                     */
    /* ---------------------------------------------------------------- */

    [IPC.memoryBanksStatus]: {
      validate: validateMemoryBanksStatus,
      handle: async () => readMemoryBanksStatus(),
    },

    [IPC.memoryBankMemories]: {
      validate: validateMemoryBankMemories,
      handle: async (request) => ({ memories: await readMemoryBankMemories(request.slug) }),
    },

    [IPC.memoryBanksPreflight]: {
      validate: validateMemoryBanksPreflight,
      handle: async () => readMemoryBanksPreflight(),
    },

    /*
     * The only bank channel that names a remote without joining it, and the
     * only one that may be handed a token the user has not committed to
     * storing. Nothing here writes: no clone, no registry entry, no secret on
     * disk — see `verifyMemoryBankRemote`.
     */
    [IPC.memoryBanksVerifyRemote]: {
      validate: validateMemoryBanksVerifyRemote,
      handle: async (request) => verifyMemoryBankRemote(request),
    },

    [IPC.memoryBankAdd]: {
      validate: validateMemoryBankAdd,
      handle: async (request) => addMemoryBank(request),
    },

    [IPC.memoryBankSync]: {
      validate: validateMemoryBankSync,
      handle: async (request) => syncMemoryBank(request),
    },

    [IPC.memoryBankRetire]: {
      validate: validateMemoryBankRetire,
      handle: async (request) => retireMemoryBankMemory(request),
    },

    [IPC.memoryBankSetEnabled]: {
      validate: validateMemoryBankSetEnabled,
      handle: async (request) => setMemoryBankEnabled(request),
    },

    [IPC.memoryBankForget]: {
      validate: validateMemoryBankForget,
      handle: async (request) => forgetMemoryBank(request),
    },

    [IPC.memoryBanksSetMasterEnabled]: {
      validate: validateMemoryBanksSetMasterEnabled,
      handle: async (request) => setMasterEnabled(request),
    },

    /* ---------------------------------------------------------------- */
    /* Key managers                                                     */
    /* ---------------------------------------------------------------- */

    /*
     * Six channels and one credential between them. `saveConnection` is the
     * only one carrying a secret and it carries it inbound; the five others
     * move configuration, and the strongest thing any of them returns is the
     * list of key *names* at a path. The leak tripwire below this table sees
     * every one of these responses like any other.
     */
    [IPC.secretsConnectionsList]: {
      validate: validateSecretsConnectionsList,
      handle: async () => listSecretConnections(),
    },

    [IPC.secretsConnectionSave]: {
      validate: validateSecretsConnectionSave,
      handle: async (request) => saveSecretConnection(request),
    },

    [IPC.secretsConnectionDelete]: {
      validate: validateSecretsConnectionDelete,
      handle: async (request) => deleteSecretConnection(request),
    },

    [IPC.secretsConnectionVerify]: {
      validate: validateSecretsConnectionVerify,
      handle: async (request) => verifySecretConnection(request),
    },

    /*
     * A TLS handshake and nothing else — see `fetchServerCertificate`. It is
     * the one place in the app that opens an unverified socket, and it is
     * acceptable there precisely because it sends nothing.
     */
    [IPC.secretsFetchServerCert]: {
      validate: validateSecretsFetchServerCert,
      handle: async (request) => ({ certificate: await fetchServerCertificate(request) }),
    },

    [IPC.secretsRefTest]: {
      validate: validateSecretsRefTest,
      handle: async (request) => testSecretRef(request),
    },

    /* ---------------------------------------------------------------- */
    /* Agent prompts                                                    */
    /* ---------------------------------------------------------------- */

    /*
     * Through the engine rather than through a store of this file's own, which
     * is the opposite of what Cerebro above does and is deliberate. Cerebro's
     * data lives in a repository nothing else reads; the prompt library is read
     * on the path of every run, so the one instance that `startRun` composes
     * from has to be the one the pane writes to — see `EngineHost`.
     */
    [IPC.agentPromptsList]: {
      validate: validateAgentPromptsList,
      // The banks ride along because only main can see them, and the pane's
      // preview of a built-in is wrong without them — see the response type.
      handle: async () => ({
        document: await engine.require().readAgentPrompts(),
        memoryBanks: promptBanks(),
      }),
    },

    [IPC.agentPromptsSave]: {
      validate: validateAgentPromptsSave,
      handle: async (request) => ({
        document: await engine.require().writeAgentPrompts(request.document),
      }),
    },

    /* ---------------------------------------------------------------- */
    /* Server                                                           */
    /* ---------------------------------------------------------------- */

    /**
     * Five channels onto one host, and every one of them answers with the whole
     * state — see the protocol's channel block for why.
     *
     * None of these reaches the engine directly. The host holds the engine and
     * assembles the catalogue from it, so there is no path from a renderer
     * request to "publish this profile": the server serves what the engine says
     * exists, and these decide only whether it is serving.
     */
    [IPC.serverStatus]: {
      validate: validateServerStatus,
      handle: async () => ({ state: server.state() }),
    },

    [IPC.serverStart]: {
      validate: validateServerStart,
      handle: async () => ({ state: await server.listen() }),
    },

    [IPC.serverStop]: {
      validate: validateServerStop,
      handle: async () => ({ state: await server.close() }),
    },

    [IPC.serverConfigure]: {
      validate: validateServerConfigure,
      handle: async (request) => ({ state: await server.configure(request) }),
    },

    [IPC.serverCreateConnection]: {
      validate: validateServerCreateConnection,
      handle: async (request) => ({
        state: await server.createConnection({
          label: request.label,
          workspace: request.workspace,
          ...(request.allow === undefined ? {} : { allow: request.allow }),
          ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
        }),
      }),
    },

    [IPC.serverRenameConnection]: {
      validate: validateServerRenameConnection,
      handle: async (request) => ({
        state: await server.renameConnection(request.id, request.label),
      }),
    },

    [IPC.serverDeleteConnection]: {
      validate: validateServerDeleteConnection,
      handle: async (request) => ({ state: await server.deleteConnection(request.id) }),
    },

    /**
     * The same catalogue the HTTP surface serves, off the same cache.
     *
     * Not the engine's `listProfiles` plus `listProviderModels` assembled here:
     * that would be a second implementation of the thing the server publishes,
     * and the pane's whole value is that it shows what clients actually get.
     */
    [IPC.serverCatalogue]: {
      validate: validateServerCatalogue,
      handle: async (request) => ({
        profiles: await server.catalogue({ refresh: request.refresh === true }),
      }),
    },

    /* ---------------------------------------------------------------- */
    /* Remote access                                                    */
    /* ---------------------------------------------------------------- */

    /*
     * The one remote-origin grant — see the channel comment in the protocol
     * and `remoteAccess.ts` for the design. `configure` refuses with a
     * sentence rather than storing a mangled value: the string ends up inside
     * a CSP directive, and "stored something adjacent to what you typed" is
     * the failure mode normalization exists to prevent.
     */
    [IPC.remoteStatus]: {
      validate: validateRemoteStatus,
      handle: async () => ({ origin: remoteAccess.origin() }),
    },

    [IPC.remoteConfigure]: {
      validate: validateRemoteConfigure,
      handle: async (request) => {
        if (request.origin !== null && normalizeRemoteOrigin(request.origin) === null) {
          throw new ValidationError(
            'origin',
            'must be an http(s) address, like http://kronos.tailnet-name.ts.net:6472',
          );
        }
        return { origin: await remoteAccess.configure(request.origin) };
      },
    },

    /* ---------------------------------------------------------------- */
    /* Routines                                                         */
    /* ---------------------------------------------------------------- */

    /*
     * Every routines channel answers with the whole state, exactly as the
     * server channels do and for the same reason: a firing moves the history,
     * the running flag and the next appointment at once.
     */
    [IPC.routinesList]: {
      validate: validateRoutinesList,
      handle: async () => ({ state: routines.state() }),
    },

    [IPC.routinesCreate]: {
      validate: validateRoutinesCreate,
      handle: async (request) => ({ state: await routines.create(request.draft) }),
    },

    [IPC.routinesUpdate]: {
      validate: validateRoutinesUpdate,
      handle: async (request) => ({ state: await routines.update(request.id, request.patch) }),
    },

    [IPC.routinesDelete]: {
      validate: validateRoutinesDelete,
      handle: async (request) => ({ state: await routines.remove(request.id) }),
    },

    [IPC.routinesRunNow]: {
      validate: validateRoutinesRunNow,
      handle: async (request) => ({ state: await routines.runNow(request.id) }),
    },

    /* ---------------------------------------------------------------- */
    /* Preview                                                          */
    /* ---------------------------------------------------------------- */

    /**
     * Make one file renderable.
     *
     * The path arriving here came from a tool call in a transcript, which is to
     * say from model output — so this is the one handler whose whole job is to
     * take an untrusted path and hand back something safe to frame. Everything
     * that makes it safe is in `preview.ts`; what matters at this layer is that
     * the renderer receives a `artemis-preview://` URL and never a `file:` one,
     * and so is never in a position to frame a path of its own choosing.
     */
    [IPC.previewOpen]: {
      validate: validatePreviewOpen,
      handle: async (request) => grantPreview(request.path),
    },

    /**
     * Read a file as text.
     *
     * The path arrives from the same untrusted place the preview's does — a
     * transcript, which is model output — and the answer is deliberately duller:
     * a string. There is no URL here, no scheme, and nothing the renderer could
     * frame, which is what allows this channel to accept the extensions the
     * preview refuses. `files.ts` holds every rule about what may be read and
     * how much of it.
     */
    [IPC.filesRead]: {
      validate: validateFilesRead,
      handle: async (request) => readTextFile(request.path),
    },

    /**
     * Which of these paths are files.
     *
     * The read above with the file left out, asked before anything is drawn so
     * that a path in an answer is only a link when there is something behind it.
     * It tells the renderer strictly less than {@link IPC.filesRead} already
     * does about the same paths, through the same boundary, which is why it adds
     * nothing to what `files.ts` records about its own reach.
     *
     * Never fails for a path's sake. A missing file is an answer here, not an
     * error — see `checkFiles`.
     */
    /**
     * List a directory.
     *
     * Same validator and same boundary as the read above, answering with
     * strictly less: names and kinds, never contents. `files.ts` holds the
     * ordering, the entry cap and what a symlink is reported as.
     */
    [IPC.filesList]: {
      validate: validateFilesList,
      handle: async (request) => listDirectory(request.path),
    },

    [IPC.filesCheck]: {
      validate: validateFilesCheck,
      handle: async (request) => checkFiles(request.paths),
    },

    /* ---------------------------------------------------------------- */
    /* GitHub                                                           */
    /* ---------------------------------------------------------------- */

    /**
     * Where a batch of pull requests stands.
     *
     * Reads only, and there is no companion channel that writes — see the
     * `github` namespace on `ArtemisBridge`. The URLs behind this come from
     * text an agent produced, so anything reachable from here is reachable
     * from a prompt injection, and "read the state of a public fact" is a
     * blast radius worth keeping at exactly that.
     *
     * Never fails for a pull request's sake. A missing `gh`, a signed-out one
     * and a PR nobody can see are answers rather than errors — the popover
     * says something different for each.
     */
    [IPC.githubPullRequests]: {
      validate: validateGithubPullRequests,
      handle: async (request) => ({ results: await readPullRequests(request.refs) }),
    },

    /* ---------------------------------------------------------------- */
    /* Browsers                                                         */
    /* ---------------------------------------------------------------- */

    /**
     * Open a page.
     *
     * The window comes from `context`, not from the request — the same rule the
     * window-chrome channels keep, and for the same reason: the renderer says
     * "a browser" and main decides which window that means, so a second Artemis
     * window cannot be handed a view by the first.
     *
     * A window that has already gone is an ordinary failure rather than a
     * crash; there is nothing to stack a view on.
     */
    [IPC.browserOpen]: {
      validate: validateBrowserOpen,
      handle: async (request, context) => {
        const window = context.window;
        if (window === null || window.isDestroyed()) {
          throw new WorkspaceError('There is no window to open a browser in.');
        }
        return { browser: browsers.open(window, request.query) };
      },
    },

    /**
     * Go somewhere.
     *
     * Note what this handler does *not* do: resolve the query. `browser.ts`
     * runs `browserUrlFor` and refuses anything that is not `http(s)`, so the
     * rule lives in one place and this layer cannot widen it — see
     * `validateBrowserOpen` for why that is deliberate rather than a gap.
     */
    [IPC.browserNavigate]: {
      validate: validateBrowserNavigate,
      handle: async (request) => ({
        id: request.id,
        url: browsers.navigate(request.id, request.query),
      }),
    },

    [IPC.browserCommand]: {
      validate: validateBrowserCommand,
      handle: async (request) => {
        browsers.command(request.id, request.command);
        return { id: request.id };
      },
    },

    /**
     * Where the page goes, and whether it is on screen.
     *
     * The only channel in the app that carries geometry, and the only one
     * called on every frame of a drag-resize. It stays a round trip rather than
     * a push because the renderer is the side that knows when it has moved, and
     * because a dropped layout leaves a page in the wrong place — which is
     * visible, unlike a dropped notification.
     */
    [IPC.browserLayout]: {
      validate: validateBrowserLayout,
      handle: async (request) => {
        browsers.layout(request.id, request.bounds, request.visible);
        return { id: request.id };
      },
    },

    /** The one thing that destroys a view. See `BrowserCloseRequest`. */
    [IPC.browserClose]: {
      validate: validateBrowserClose,
      handle: async (request) => {
        browsers.close(request.id);
        return { id: request.id };
      },
    },

    [IPC.browserList]: {
      validate: validateBrowserList,
      handle: async () => ({ browsers: browsers.list() }),
    },

    /* ---------------------------------------------------------------- */
    /* Terminals                                                        */
    /* ---------------------------------------------------------------- */

    /**
     * Open a shell.
     *
     * `checkWorkingDirectory` is the same gate a run start goes through, and it
     * is here for the same reason: a `cwd` that does not exist produces a
     * `posix_spawnp` failure with no useful message, and the renderer's copy of
     * a directory can be a moment out of date with the disk. Asking first turns
     * that into a sentence.
     *
     * Note what this handler does *not* forward: nothing from `request` reaches
     * the shell's argv or environment. It names a directory and a size, and
     * `terminal.ts` decides everything else.
     */
    [IPC.terminalStart]: {
      validate: validateTerminalStart,
      handle: async (request) => {
        const check = await checkWorkingDirectory(request.cwd);
        if (!check.ok) throw new WorkspaceError(check.message);
        return { terminal: await terminals.start(request) };
      },
    },

    [IPC.terminalWrite]: {
      validate: validateTerminalWrite,
      handle: async (request) => {
        terminals.write(request.id, request.data);
        return { id: request.id };
      },
    },

    [IPC.terminalResize]: {
      validate: validateTerminalResize,
      handle: async (request) => {
        terminals.resize(request.id, request.cols, request.rows);
        return { id: request.id };
      },
    },

    /** The one thing that kills a shell. See `TerminalCloseRequest`. */
    [IPC.terminalClose]: {
      validate: validateTerminalClose,
      handle: async (request) => {
        terminals.close(request.id);
        return { id: request.id };
      },
    },

    [IPC.terminalList]: {
      validate: validateTerminalList,
      handle: async () => ({ terminals: terminals.list() }),
    },

    [IPC.terminalReplay]: {
      validate: validateTerminalReplay,
      handle: async (request) => ({ id: request.id, ...terminals.replay(request.id) }),
    },

    [IPC.sessionsMessages]: {
      validate: validateSessionsMessages,
      handle: async (request) => engine.require().getSessionMessages(request),
    },

    /**
     * One subagent's own conversation. Read-only, and the reason a delegated
     * row can be opened rather than only watched: the parent transcript holds
     * the final report and none of the work.
     */
    [IPC.sessionsSubagentMessages]: {
      validate: validateSessionsSubagentMessages,
      handle: async (request) => engine.require().getSubagentMessages(request),
    },

    [IPC.sessionsRename]: {
      validate: validateSessionsRename,
      handle: async (request) =>
        engine.require().renameSession({
          profileId: request.profileId,
          sessionId: request.sessionId,
          title: request.title,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }),
    },

    /**
     * Destroys a transcript on disk. The confirmation that guards it lives in
     * the renderer, which is the only layer that can ask a person anything —
     * so by the time a request reaches here the decision has been made and
     * this does not second-guess it.
     */
    [IPC.sessionsDelete]: {
      validate: validateSessionsDelete,
      handle: async (request) =>
        engine.require().deleteSession({
          profileId: request.profileId,
          sessionId: request.sessionId,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }),
    },

    [IPC.sessionsTag]: {
      validate: validateSessionsTag,
      handle: async (request) =>
        engine.require().tagSession({
          profileId: request.profileId,
          sessionId: request.sessionId,
          tag: request.tag,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }),
    },

    /* ---------------------------------------------------------------- */
    /* Plan usage                                                       */
    /* ---------------------------------------------------------------- */

    /**
     * The cheap half of the pair: synchronous, no provider contact, may be
     * null. The renderer opens its popover on this and never waits.
     */
    [IPC.usagePlanCached]: {
      validate: validateUsagePlan,
      handle: async (request) => ({ usage: engine.require().cachedPlanUsage(request.profileId) }),
    },

    /**
     * The expensive half: spawns a provider subprocess. Costs no model tokens
     * — see the adapter's `fetchPlanUsage` — but takes a second or two, which
     * is exactly why it is a separate channel from the cached read.
     */
    [IPC.usagePlanRefresh]: {
      validate: validateUsagePlan,
      handle: async (request) => {
        /*
         * An Artemis Server profile is several accounts behind one id, and
         * its gauges travel the push channel keyed by served account — an
         * invoke reply can carry only one reading. A refresh against one
         * therefore fans out the poller's own read and answers `null`; the
         * readings land in the renderer's served-account map through the
         * same feed the poll fills.
         */
        const profile = (await engine.require().listProfiles({})).find(
          (candidate) => candidate.id === request.profileId,
        );
        if (profile?.providerId === 'artemis') {
          try {
            await broadcastPlanUsageReading(engine, request.profileId, profile.providerId);
          } catch (error) {
            // Routine, not exceptional: a server that predates /usage answers
            // 501, and an unreachable one refuses outright. The meter shows
            // whatever it last knew either way, so this is a debug fact — an
            // error-level line per popover open would be noise about a
            // version skew the next server deploy resolves.
            log.debug(`Could not read served plan usage for ${request.profileId}`, error);
          }
          return { usage: null };
        }
        return {
          usage: await engine.require().refreshPlanUsage({ profileId: request.profileId }),
        };
      },
    },

    /* ---------------------------------------------------------------- */

    /**
     * Auth. Note what is *absent*: no channel accepts a key, token or password,
     * and none performs a login. The user runs the provider's own command
     * against the profile's config directory; these two report what landed
     * there. A credential never crosses this boundary in either direction.
     *
     * `authStatus` is polled while the user signs in, so it has to stay cheap —
     * it spawns one short-lived status probe and nothing else.
     */
    [IPC.authStatus]: {
      validate: validateAuthStatus,
      handle: async (request) => engine.require().authStatus(request.profileId),
    },

    [IPC.authSignOut]: {
      validate: validateAuthSignOut,
      handle: async (request) => engine.require().signOut(request.profileId),
    },

    /* ---------------------------------------------------------------- */

    /**
     * Accounts on a *remote* Artemis, and the logins that fill them.
     *
     * The rule the block above states holds here too, and is worth restating
     * because the appearance is different: nothing on these six channels
     * accepts, returns or stores a credential. The provider's own CLI runs on
     * the serving machine and writes its own token into its own directory
     * there; what crosses this boundary is a URL that CLI printed and a code
     * the user typed into their own browser.
     *
     * Every one is a single authenticated HTTP request, refused by the server
     * with a 404 unless that connection token was granted account
     * administration — which `list` reports, so the UI can be absent rather
     * than refused.
     */
    [IPC.serverAccountsList]: {
      validate: validateServerAccounts,
      handle: async (request) => {
        // `profiles` on the wire, `accounts` here: the server calls them
        // profiles because that is what they are to it, and this bridge calls
        // them accounts because "profile" already means a local one in every
        // other channel — two things of one name in one renderer is the
        // confusion worth one rename.
        const remote = await engine.require().remoteAccounts(request.profileId);
        return { manageProfiles: remote.manageProfiles, accounts: remote.profiles };
      },
    },

    [IPC.serverAccountsCreate]: {
      validate: validateServerAccountsCreate,
      handle: async (request) => ({
        account: await engine.require().createRemoteAccount(request.profileId, {
          label: request.label,
          ...(request.provider === undefined ? {} : { provider: request.provider }),
        }),
      }),
    },

    [IPC.serverAccountsUpdate]: {
      validate: validateServerAccountsUpdate,
      handle: async (request) => ({
        account: await engine.require().updateRemoteAccount(request.profileId, request.accountId, {
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
          ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
        }),
      }),
    },

    [IPC.serverAccountsDelete]: {
      validate: validateServerAccountsDelete,
      handle: async (request) => ({
        removed: (await engine.require().deleteRemoteAccount(request.profileId, request.accountId))
          .removed,
      }),
    },

    [IPC.serverAccountsSignIn]: {
      validate: validateServerAccountSignIn,
      handle: async (request) => ({
        signIn: await engine.require().startRemoteSignIn(request.profileId, request.accountId),
      }),
    },

    [IPC.serverAccountsSignInStatus]: {
      validate: validateServerAccountSignIn,
      handle: async (request) => ({
        signIn: await engine.require().remoteSignInStatus(request.profileId, request.accountId),
      }),
    },

    [IPC.serverAccountsSubmitCode]: {
      validate: validateServerAccountSubmitCode,
      handle: async (request) => ({
        signIn: await engine
          .require()
          .submitRemoteSignInCode(request.profileId, request.accountId, request.code),
      }),
    },

    [IPC.serverAccountsCancelSignIn]: {
      validate: validateServerAccountSignIn,
      handle: async (request) => ({
        signIn: await engine.require().cancelRemoteSignIn(request.profileId, request.accountId),
      }),
    },

    /* ---------------------------------------------------------------- */
    /* Window chrome                                                    */
    /* ---------------------------------------------------------------- */

    /**
     * The four channels that exist because Artemis hides the native title bar.
     *
     * The only handlers in this file that touch neither the engine nor the
     * filesystem — they act on `context.window`, and on nothing else. That is
     * the whole security story here: the request carries no window id (see
     * `WindowRequest`), so a renderer can only ever minimize, zoom or close
     * *itself*, and a second Artemis window is unreachable from the first.
     *
     * Each answers with the resulting state so the header never has to assume
     * its command landed. A window that died mid-call answers with the
     * all-false state rather than failing; see `readWindowState`.
     */
    [IPC.windowMinimize]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => {
        // `minimize()` on a full-screen window is ignored by macOS and leaves
        // the user in full screen with a button that did nothing. Leave first.
        if (context.window?.isFullScreen() === true) context.window.setFullScreen(false);
        context.window?.minimize();
        return { state: readWindowState(context.window) };
      },
    },

    /**
     * One button, so one channel.
     *
     * On macOS the *native* green button toggles full screen rather than
     * maximizing, and this deliberately does not: it is the Windows and Linux
     * maximize control, and macOS reaches full screen through its own traffic
     * lights, which are still AppKit's.
     */
    [IPC.windowToggleMaximize]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => {
        const window = context.window;
        if (window !== null && !window.isDestroyed()) {
          if (window.isMaximized()) window.unmaximize();
          else window.maximize();
        }
        return { state: readWindowState(window) };
      },
    },

    /**
     * The reply is read off the window *before* it is asked to close, because
     * a moment later there may be no window to read. Nothing consumes it — see
     * `ArtemisBridge.window.close` — but returning the state of a destroyed
     * window as though it were the outcome would be a small lie in a response
     * whose whole contract is "here is what actually happened".
     */
    [IPC.windowClose]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => {
        const state = readWindowState(context.window);
        context.window?.close();
        return { state };
      },
    },

    [IPC.windowState]: {
      validate: validateWindowRequest,
      handle: async (_request, context) => ({ state: readWindowState(context.window) }),
    },

    /* ---------------------------------------------------------------- */
    /* Updates                                                          */
    /* ---------------------------------------------------------------- */

    /**
     * One shape of answer for all but one of these: the updater's state now, so
     * the banner never assumes a command landed — the same contract as the
     * window channels. Note what the requests *cannot* say: no URL, no path, no
     * version to install. The renderer can ask, consent to what main found, and
     * silence one version, and that is all.
     */
    [IPC.updatesState]: {
      validate: validateUpdatesState,
      handle: async () => ({ state: updater.state() }),
    },

    /**
     * The one update channel that answers with more than a state.
     *
     * `checkNow` swallows every failure into an outcome rather than throwing —
     * see `CheckOutcome` in `updater.ts` — so there is nothing to catch here and
     * no error for the dispatcher to scrub. The outcome is flattened to its
     * `kind`: the only payload the union carries is the offered version, and
     * that is already on the state this replies with, so sending both would be
     * two copies of one fact with no rule for which wins.
     *
     * The state is read *after* the check rather than taken from the outcome,
     * because a check that offers something has already written it.
     */
    [IPC.updatesCheck]: {
      validate: validateUpdatesCheck,
      handle: async () => {
        const outcome = await updater.checkNow();
        return { outcome: outcome.kind, state: updater.state() };
      },
    },

    [IPC.updatesInstall]: {
      validate: validateUpdatesInstall,
      handle: async () => ({ state: updater.install() }),
    },

    /**
     * The only way a restart happens. `install` parks at `ready` and stays
     * there — across hours, or forever — until this channel is invoked by the
     * user's own click. At any phase but `ready` it is a read.
     */
    [IPC.updatesRestart]: {
      validate: validateUpdatesRestart,
      handle: async () => ({ state: updater.restart() }),
    },

    [IPC.updatesDismiss]: {
      validate: validateUpdatesDismiss,
      handle: async (request) => ({ state: await updater.dismiss(request.version) }),
    },

    [IPC.updatesSetChannel]: {
      validate: validateUpdatesSetChannel,
      handle: async (request) => ({ state: updater.setChannel(request.channel) }),
    },
  };

  /**
   * Validate, run, scan, wrap.
   *
   * Generic in the channel so that `validate`'s output and `handle`'s input are
   * the same type — the map above is what proves they line up.
   */
  const dispatch = async <C extends IpcChannel>(
    channel: C,
    event: IpcMainInvokeEvent,
    raw: unknown,
  ): Promise<IpcHandlerResult<C>> => {
    try {
      assertTrustedSender(event, policy);

      const implementation = handlers[channel];
      const request = implementation.validate(raw);
      const value = await implementation.handle(request, {
        window: BrowserWindow.fromWebContents(event.sender),
      });

      // The tripwire. Everything above this line is "we believe the response is
      // renderer-safe"; this line is what makes it true. Strict by default, and
      // by the channel's own policy where the response carries provider or user
      // content — see `assertResponseSafe`.
      assertResponseSafe(value, channel);

      return ipcOk(toCloneable(value, channel));
    } catch (error) {
      // The full error — stack and all — stays here. What crosses is a code and
      // a scrubbed message.
      log.error(`Handler for ${channel} failed`, error);
      return ipcFail(toIpcError(error, channel));
    }
  };

  const register = <C extends IpcChannel>(channel: C): void => {
    ipcMain.handle(channel, (event, raw: unknown) => dispatch(channel, event, raw));
  };

  for (const channel of IPC_CHANNELS) register(channel);

  log.info(`Registered ${IPC_CHANNELS.length} IPC channels.`);

  return {
    dispose(): void {
      for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Directory picker                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ask the OS for a directory.
 *
 * Parented to the requesting window when there is one, so the dialog is modal
 * to Artemis rather than floating free (and, on macOS, sheets onto the window it
 * is blocking). A destroyed window falls back to an app-modal dialog instead of
 * failing: the user asked for a folder, and losing the parent is not a reason
 * to refuse.
 *
 * The result is validated twice, for two different failure modes:
 *
 *  1. {@link readPickedDirectory} — is this a path at all, or a cancel?
 *  2. `checkWorkingDirectory` — is it a directory that exists and can be
 *     entered *right now*? A picker makes that near-certain, but "near" is not
 *     "certain": the user can create a folder in the dialog on a volume that
 *     unmounts, or pick one over a network mount that has just dropped. The
 *     alternative is finding out at `spawn` time, where a bad cwd raises the
 *     same `ENOENT` as a missing binary and gets blamed on the binary.
 *
 * Cancelling resolves `null`, which is an ordinary success. Only a genuinely
 * unusable path is an error.
 */
async function pickDirectory(
  request: WorkspacePickDirectoryRequest,
  window: BrowserWindow | null,
): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose a working directory',
    buttonLabel: 'Use this folder',
    // Spread from the shared constant so the two properties that make this a
    // *directory* picker cannot drift.
    properties: [...DIRECTORY_PICKER_PROPERTIES],
    ...(request.defaultPath === undefined ? {} : { defaultPath: request.defaultPath }),
  };

  const outcome =
    window === null || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);

  const picked = readPickedDirectory(outcome);
  if (picked === null) return null;

  const check = await checkWorkingDirectory(picked);
  if (!check.ok) throw new WorkspaceError(check.message);
  return check.path;
}

/**
 * Reduce a response to plain, structured-cloneable data.
 *
 * Electron clones every IPC payload anyway, so this changes nothing the
 * renderer sees. What it changes is *where a mistake surfaces*: if a handler
 * returns a class instance, a `Map`, or an object carrying a method, Electron's
 * own clone fails inside `invoke` and the renderer receives an opaque
 * `An object could not be cloned` rejection with no indication of which channel
 * or field caused it. Doing it here names the channel and keeps the diagnosis
 * in the main process.
 *
 * It is also a second, structural scrub: a getter that would have recomputed a
 * secret cannot survive a clone.
 */
function toCloneable<T>(value: T, channel: IpcChannel): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(
      `The handler for ${channel} returned a value that cannot cross IPC. ` +
        'Responses must be plain JSON-like data — no class instances, Maps, Sets or functions. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Reject anything that is not Artemis's own top-level frame.
 *
 * `senderFrame` can be null when the frame died between sending and being
 * handled, and reading `.url` on a destroyed frame throws — both are treated as
 * untrusted, because there is nothing useful to do with a message whose origin
 * cannot be established.
 */
function assertTrustedSender(event: IpcMainInvokeEvent, policy: SecurityPolicy): void {
  const frame = event.senderFrame;
  if (!frame) throw new UntrustedSenderError('the sending frame no longer exists');

  let isMainFrame = false;
  let url: string | undefined;
  try {
    isMainFrame = frame === event.sender.mainFrame;
    url = frame.url;
  } catch {
    throw new UntrustedSenderError('the sending frame could not be inspected');
  }

  if (!isTrustedFrame(url, isMainFrame, policy)) {
    throw new UntrustedSenderError(isMainFrame ? 'the frame is at an unexpected URL' : 'the sender is a subframe');
  }
}

/* -------------------------------------------------------------------------- */
/* Event forwarding                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deliver one payload to every open window.
 *
 * Deliberately dumb: it does not scan, because the two callers scan under
 * *different* policies and which one applies is a property of the payload
 * rather than of the delivery. Callers scan first, then hand the result here.
 *
 * A window closing mid-send is routine — a user quitting while a run streams —
 * so a failed delivery is logged at debug and the remaining windows still get
 * theirs.
 */
export function broadcast(channel: IpcPushChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const contents: WebContents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch (error) {
      log.debug(`Failed to deliver a ${channel} payload to a window`, error);
    }
  }
}

/**
 * Push the engine's event stream at every open window.
 *
 * Events are scanned before they are sent, with the looser
 * {@link EVENT_SCAN_POLICY}: model output and tool results are content and are
 * exempt from the credential patterns, but no profile field may appear on an
 * event at any depth.
 *
 * A failing event is dropped rather than thrown, and the failure is logged.
 * Dropping one event degrades a transcript; letting a credential-bearing event
 * through does not degrade anything, it just leaks.
 */
export function forwardAgentEvents(engine: EngineHost): Unsubscribe {
  if (!engine.ready) return () => undefined;

  const send = (event: AgentEvent): void => {
    try {
      assertNoSecrets(event, IPC_PUSH.agentEvent, EVENT_SCAN_POLICY);
    } catch (error) {
      log.error(`Dropped a ${event.type} event that failed its credential-safety check`, error);
      return;
    }

    broadcast(IPC_PUSH.agentEvent, event);
  };

  return engine.require().subscribe(send);
}

/**
 * Push predicted next prompts at every open window.
 *
 * The same shape and failure rule as {@link forwardAgentEvents} — scan, then
 * broadcast, dropping anything that fails rather than throwing — under the
 * strict response policy with `suggestion` on its content exemptions: the
 * text is model prose bound for a composer, exactly the kind of field the
 * content exemption exists for, while every other key on the payload is an
 * id and stays fully scanned.
 */
export function forwardRunSuggestions(engine: EngineHost): Unsubscribe {
  if (!engine.ready) return () => undefined;

  const send = (suggestion: RunSuggestion): void => {
    try {
      assertNoSecrets(suggestion, IPC_PUSH.runSuggestion, RESPONSE_SCAN_POLICY);
    } catch (error) {
      log.error('Dropped a predicted prompt that failed its credential-safety check', error);
      return;
    }

    broadcast(IPC_PUSH.runSuggestion, suggestion);
  };

  return engine.require().subscribeSuggestions(send);
}

/**
 * Push terminal output and exits at every open window.
 *
 * The same shape as {@link forwardAgentEvents} and the same failure rule —
 * scan, then broadcast, dropping anything that fails rather than throwing —
 * under {@link TERMINAL_SCAN_POLICY}, which exempts the byte stream itself from
 * the credential patterns for the reasons written out there.
 *
 * Broadcast to every window, like everything else on a push channel. A second
 * window has not been handed any of these ids, so it routes them to nothing;
 * that is the same way `agentEvent` behaves for a run it did not start, and it
 * keeps the preload's rule that a channel name is never built from a target.
 */
/**
 * Push navigation and death at every open window.
 *
 * The same shape as {@link forwardTerminalEvents}, under the *strict* response
 * policy rather than a loosened one — and that difference is worth stating,
 * because a browser event carries page-authored text (a title) and a URL, which
 * sounds like exactly the content the terminal's policy is relaxed for.
 *
 * It is not. A title is a short string a page chose, and nothing in it is a
 * credential Artemis holds; the reason `TERMINAL_SCAN_POLICY` exists is that a
 * shell's output is *the user's own screen* and redacting it would corrupt the
 * output of a program Artemis did not run. There is no equivalent here, so the
 * default applies — and if a page ever does title itself `sk-ant-…`, having the
 * event dropped and logged is a better outcome than establishing a precedent
 * that page-authored text is exempt from the scanner.
 */
export function forwardBrowserEvents(browsers: BrowserHost): Unsubscribe {
  return browsers.subscribe((event) => {
    try {
      assertNoSecrets(event, IPC_PUSH.browserEvent);
    } catch (error) {
      log.error(`Dropped a browser ${event.type} event that failed its safety check`, error);
      return;
    }

    broadcast(IPC_PUSH.browserEvent, event);
  });
}

export function forwardTerminalEvents(terminals: TerminalHost): Unsubscribe {
  return terminals.subscribe((event) => {
    try {
      assertNoSecrets(event, IPC_PUSH.terminalEvent, TERMINAL_SCAN_POLICY);
    } catch (error) {
      log.error(`Dropped a terminal ${event.type} event that failed its safety check`, error);
      return;
    }

    broadcast(IPC_PUSH.terminalEvent, event);
  });
}
