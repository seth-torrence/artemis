/**
 * The terminal's composition root: core's parts, assembled for one person at
 * one keyboard.
 *
 * `apps/server/src/host.ts` assembles the same spine for an HTTP server and
 * `apps/desktop/main/engine.ts` for a window. This is the third assembly and
 * the smallest: a provider registry, the desktop's own profile store, the env
 * resolver that turns a profile into the environment a run executes with, and
 * the run registry that owns every live run. Plus the catalogue, because a
 * picker of accounts and models is the feature.
 *
 * What is *not* here, and why:
 *
 *  - **No HTTP seams.** `RunSource`, `SessionSource`, the push feed, the remote
 *    guard, the session ledger — all exist to narrow the engine for a wire.
 *    There is no wire; the UI holds the `RunRegistry` directly, as the desktop
 *    does.
 *  - **No prompt library, memory banks, session naming.** Window furniture,
 *    or out of the first slice. Each is plain Node and can be added later
 *    without changing this shape. Skills, commands and plugins *are* here —
 *    core's content bridge, the same one the desktop uses — because a session
 *    without the user's own skills is a different product.
 *  - **No secret managers, no encrypted key store.** The desktop's key file is
 *    readable for presence only — see `profileKeys.ts`.
 *
 * About sixty lines here mirror the server's host. That is assembly, not
 * policy: the two things that must never diverge — what environment a run
 * gets, and which credential variables are stripped from it — are one
 * implementation in core (`resolveEnv`, `managedEnvKeys`), and both hosts call
 * it. When a third headless consumer appears, this and the server's version
 * should become one function in core; until then the duplication is smaller
 * than the abstraction.
 */

import { randomUUID } from 'node:crypto';

import { ARCHIVED_TAG } from '@rx-artemis/protocol';
import type {
  AgentEvent,
  Capabilities,
  PlanUsage,
  ProfileId,
  ProviderId,
  ProviderModelOption,
  RunId,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';
import {
  ProfileStore,
  RunRegistry,
  buildContentBridge,
  checkAuthStatus,
  discoverMarketplacePlugins,
  linkSkillsIntoCodexHome,
  createCatalogue,
  createDefaultProviderRegistry,
  managedEnvKeys,
  resolveEnv,
  resolveStoreEnv,
  type Catalogue,
  type ProviderRegistry,
} from '@rx-artemis/core';

import { createReadOnlyProfileKeys } from './profileKeys.js';

export interface TuiHost {
  readonly dataDir: string;
  readonly profiles: ProfileStore;
  readonly providers: ProviderRegistry;
  readonly runs: RunRegistry;
  /**
   * Accounts, their models and their sign-in state, in one read.
   *
   * Every read that misses the cache spawns the provider CLI once per profile
   * for the model list and once more for the auth probe, so this is for the
   * `/profile` picker and a background warm-up — never for the launch path,
   * which lists accounts from `profiles.listMetadata()` and touches nothing.
   */
  readonly catalogue: Catalogue;
  /** What a provider can do, from its adapter — before any run has said. */
  capabilitiesFor(providerId: ProviderId): Capabilities | undefined;
  /**
   * The models one account can run, asked of the account.
   *
   * The desktop's `listProviderModels`, without the memory: a live answer is
   * preferred, the adapter's built-in list is the fallback, and `live` says
   * which one this is so the picker can mark a list the account did not
   * confirm. Spawns the provider CLI once; call it when the picker opens.
   */
  listModels(profileId: ProfileId, providerId: ProviderId): Promise<ModelListing>;
  /**
   * Stored conversations for one account in one directory, newest first.
   * Read with the *store* environment — the config directory and no
   * credential — because opening files must not decrypt a key; a provider
   * whose history lives on a server gets the run environment instead.
   */
  listSessions(profileId: ProfileId, providerId: ProviderId, cwd: string, limit?: number): Promise<readonly SessionSummary[]>;
  /**
   * Every stored conversation for one account, across every directory it has
   * worked in, newest first.
   */
  listAllSessions(profileId: ProfileId, providerId: ProviderId): Promise<readonly SessionSummary[]>;
  /**
   * Every stored conversation for *every* account given, newest first — the
   * desktop's sidebar, which does not make a person remember which account a
   * conversation ran under. Each row carries its `profileId`. An account
   * whose store cannot be read is left out rather than failing the rest.
   */
  listSessionsAcross(accounts: readonly { readonly id: ProfileId; readonly providerId: ProviderId }[]): Promise<readonly SessionSummary[]>;
  /** The events of one stored conversation, already flagged `replay`. */
  sessionMessages(profileId: ProfileId, providerId: ProviderId, sessionId: SessionId, cwd: string): Promise<readonly AgentEvent[]>;
  /** What a delegated agent did, by the task id the background-tasks list carries. */
  subagentMessages(
    profileId: ProfileId,
    providerId: ProviderId,
    sessionId: SessionId,
    agentId: string,
    cwd: string,
  ): Promise<readonly AgentEvent[]>;
  /**
   * Archive a stored conversation, or take it back out — a tag written into
   * the provider's own store, which is how the desktop archives too, so the
   * two agree without either owning a list of the other's rows.
   */
  archiveSession(
    profileId: ProfileId,
    providerId: ProviderId,
    sessionId: SessionId,
    cwd: string,
    archived: boolean,
  ): Promise<boolean>;
  /** Destroy a stored conversation. The transcript file goes; nothing here can undo it. */
  deleteSession(profileId: ProfileId, providerId: ProviderId, sessionId: SessionId, cwd: string): Promise<boolean>;
  /**
   * The provider's own slash commands, before a run exists to report them.
   *
   * A live run announces its commands and the composer uses those; until the
   * first message there is no run, and without this the menu offered only the
   * TUI's own handful — with the user's skills and bridged commands, the rows
   * they were actually reaching for, missing until after they had sent
   * something. Costs one CLI call, so it is asked for off the launch path.
   */
  listCommands(profileId: ProfileId, providerId: ProviderId, cwd: string): Promise<readonly string[]>;
  /** The account's plan windows, or `null` when the provider reports none. One CLI call. */
  fetchPlanUsage(profileId: ProfileId, providerId: ProviderId): Promise<PlanUsage | null>;
  dispose(): Promise<void>;
}

export interface ModelListing {
  readonly models: readonly ProviderModelOption[];
  readonly live: boolean;
}

export interface TuiHostOptions {
  /** Working directory the model listing is asked in. Defaults to `dataDir`. */
  readonly cwd?: string;
  /** Where a run's own failure should be reported. Defaults to stderr. */
  readonly onError?: (error: unknown, context: { readonly runId: string; readonly phase: string }) => void;
}

export function createTuiHost(dataDir: string, options: TuiHostOptions = {}): TuiHost {
  const providers = createDefaultProviderRegistry({});
  const managed = [...new Set(providers.list().flatMap((adapter) => managedEnvKeys(adapter.credentials)))];

  const profiles = new ProfileStore({
    userDataDir: dataDir,
    managedEnvKeys: managed,
    secrets: createReadOnlyProfileKeys(dataDir),
  });

  const credentialsFor = (providerId: ProviderId) => {
    const adapter = providers.get(providerId);
    if (adapter === undefined) throw new Error(`No adapter for provider "${providerId}".`);
    return adapter.credentials;
  };

  /*
   * The one seam between an account and a run. `readApiKey` is here for shape
   * parity with the other hosts and always answers `null` — see
   * `profileKeys.ts` — so a profile that needs a key is refused by the picker
   * before this is ever reached for it.
   */
  const envFor = async (profileId: ProfileId, providerId: ProviderId) => {
    const profile = await profiles.require(profileId);
    const apiKey = await profiles.readApiKey(profileId);
    return resolveEnv(profile, {
      credentials: credentialsFor(providerId),
      ...(apiKey === null ? {} : { apiKey }),
    });
  };

  const storeEnvFor = async (profileId: ProfileId, providerId: ProviderId) =>
    resolveStoreEnv(await profiles.require(profileId), { credentials: credentialsFor(providerId) });

  const historyEnvFor = async (profileId: ProfileId, providerId: ProviderId) =>
    credentialsFor(providerId).sessionStore === 'remote'
      ? envFor(profileId, providerId)
      : storeEnvFor(profileId, providerId);

  /**
   * The user's own skills, slash commands and marketplace plugins, delivered
   * to the run — the desktop's `contentPluginsFor`, through the same core
   * seam. Resolved per run so something installed while the app is open works
   * on the next message. A bridge that cannot be built is a warning on stderr
   * and a run without it, never a run that does not start.
   */
  const onWarning = (message: string, error: unknown): void => {
    process.stderr.write(`${message}: ${error instanceof Error ? error.message : String(error)}\n`);
  };
  const contentPluginsFor = async (profileId: ProfileId, providerId: ProviderId) => {
    if (providerId !== 'claude' && providerId !== 'codex') return [];
    const configDir = profiles.configDirFor(await profiles.require(profileId));
    if (providerId === 'codex') {
      await linkSkillsIntoCodexHome({ configDir, onWarning });
      return [];
    }
    const [bridged, marketplace] = await Promise.all([
      buildContentBridge({ configDir, dataDir, onWarning }),
      discoverMarketplacePlugins({ configDir, onWarning }),
    ]);
    return [...bridged, ...marketplace];
  };

  const runs = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    resolveRun: async ({ profileId, providerId }) => {
      const [env, plugins] = await Promise.all([envFor(profileId, providerId), contentPluginsFor(profileId, providerId)]);
      return { env, plugins };
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const catalogue = createCatalogue({
    source: {
      listProfiles: () => profiles.listMetadata(),
      listProviders: () => providers.describe({ includeUnregistered: false }),
      listModels: async ({ providerId, profileId }) => {
        const adapter = providers.get(providerId);
        if (adapter?.listModels === undefined) {
          return { models: providers.get(providerId)?.models ?? [], live: false };
        }
        return adapter.listModels({
          env: await envFor(profileId, providerId),
          cwd: options.cwd ?? dataDir,
        });
      },
      checkAuth: async ({ providerId, profileId }) => {
        const profile = (await profiles.list()).find((candidate) => candidate.id === profileId);
        if (profile === undefined) {
          return { loggedIn: false, error: 'This account is no longer configured.' };
        }
        return checkAuthStatus({
          credentials: credentialsFor(providerId),
          configDir: profiles.configDirFor(profile),
        });
      },
    },
  });

  return {
    dataDir,
    profiles,
    providers,
    runs,
    catalogue,
    capabilitiesFor: (providerId) => providers.get(providerId)?.capabilities,
    listModels: async (profileId, providerId) => {
      const adapter = providers.get(providerId);
      if (adapter === undefined) return { models: [], live: false };
      if (adapter.listModels === undefined) return { models: adapter.models ?? [], live: false };
      try {
        const listing = await adapter.listModels({
          env: await envFor(profileId, providerId),
          cwd: options.cwd ?? dataDir,
        });
        return listing.models.length > 0 ? listing : { models: adapter.models ?? [], live: false };
      } catch {
        return { models: adapter.models ?? [], live: false };
      }
    },
    listSessions: async (profileId, providerId, cwd, limit = 60) => {
      const adapter = providers.get(providerId);
      if (adapter?.listSessions === undefined) return [];
      const page = await adapter.listSessions({ profileId, cwd, env: await historyEnvFor(profileId, providerId), limit });
      return [...page.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    listAllSessions: async (profileId, providerId) => {
      const adapter = providers.get(providerId);
      const env = await historyEnvFor(profileId, providerId);
      if (adapter?.listAllSessions !== undefined) {
        const all = await adapter.listAllSessions({ profiles: [{ profileId, env }] });
        return [...all.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      }
      if (adapter?.listSessions === undefined) return [];
      const page = await adapter.listSessions({ profileId, cwd: options.cwd ?? dataDir, env, limit: 200 });
      return [...page.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    listSessionsAcross: async (accounts) => {
      const byProvider = new Map<ProviderId, { readonly id: ProfileId }[]>();
      for (const account of accounts) byProvider.set(account.providerId, [...(byProvider.get(account.providerId) ?? []), account]);
      const lists = await Promise.all(
        [...byProvider.entries()].map(async ([providerId, group]) => {
          const adapter = providers.get(providerId);
          try {
            const scopes = await Promise.all(
              group.map(async (account) => ({ profileId: account.id, env: await historyEnvFor(account.id, providerId) })),
            );
            if (adapter?.listAllSessions !== undefined) return (await adapter.listAllSessions({ profiles: scopes })).sessions;
            const listSessions = adapter?.listSessions?.bind(adapter);
            if (listSessions === undefined) return [];
            const pages = await Promise.all(
              scopes.map((scope) => listSessions({ ...scope, cwd: options.cwd ?? dataDir, limit: 200 })),
            );
            return pages.flatMap((page) => page.sessions);
          } catch {
            return [];
          }
        }),
      );
      return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
    },
    sessionMessages: async (profileId, providerId, sessionId, cwd) => {
      const adapter = providers.get(providerId);
      if (adapter?.getSessionMessages === undefined) return [];
      const page = await adapter.getSessionMessages({
        profileId,
        sessionId,
        cwd,
        env: await historyEnvFor(profileId, providerId),
        // Stamps the replayed events; nothing here correlates by it.
        runId: randomUUID() as RunId,
      });
      return page.events;
    },
    subagentMessages: async (profileId, providerId, sessionId, agentId, cwd) => {
      const adapter = providers.get(providerId);
      if (adapter?.getSubagentMessages === undefined) return [];
      const page = await adapter.getSubagentMessages({
        profileId,
        sessionId,
        agentId,
        cwd,
        env: await historyEnvFor(profileId, providerId),
        runId: randomUUID() as RunId,
      });
      return page.events;
    },
    listCommands: async (profileId, providerId, cwd) => {
      const adapter = providers.get(providerId);
      const listCommands = adapter?.listCommands?.bind(adapter);
      if (listCommands === undefined) return [];
      try {
        // The same plugins a run here would load, which is the whole point:
        // the user's skills and commands arrive on that channel, and a list
        // without them is missing exactly the rows they are reaching for.
        const [env, plugins] = await Promise.all([
          envFor(profileId, providerId),
          contentPluginsFor(profileId, providerId),
        ]);
        return await listCommands({ env, cwd, plugins });
      } catch {
        // A menu that cannot be filled is a menu with the built-ins in it.
        return [];
      }
    },
    archiveSession: async (profileId, providerId, sessionId, cwd, archived) => {
      const adapter = providers.get(providerId);
      if (adapter?.tagSession === undefined) return false;
      return adapter.tagSession({
        sessionId,
        cwd,
        env: await historyEnvFor(profileId, providerId),
        tag: archived ? ARCHIVED_TAG : null,
      });
    },
    deleteSession: async (profileId, providerId, sessionId, cwd) => {
      const adapter = providers.get(providerId);
      if (adapter?.deleteSession === undefined) return false;
      return adapter.deleteSession({ sessionId, cwd, env: await historyEnvFor(profileId, providerId) });
    },
    fetchPlanUsage: async (profileId, providerId) => {
      const adapter = providers.get(providerId);
      if (adapter?.fetchPlanUsage === undefined) return null;
      return adapter.fetchPlanUsage({ profileId, env: await envFor(profileId, providerId), cwd: options.cwd ?? dataDir });
    },
    dispose: async () => {
      await runs.disposeAll();
    },
  };
}
