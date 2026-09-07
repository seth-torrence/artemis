/**
 * The headless composition root: core's parts, assembled without a window.
 *
 * The desktop app's `engine.ts` wires the same parts and then keeps going —
 * terminals, browsers, updaters, session naming, a prompt library, an IPC
 * surface. None of that exists here, and the absence is the design: this
 * process serves HTTP turns and stored history, so it composes exactly the
 * six calls the server's `RunSource` and `SessionSource` make, plus the
 * catalogue those calls are routed by.
 *
 * What a headless deployment gives up, stated rather than implied:
 *
 *  - **No session naming.** The desktop titles new conversations with a model
 *    call; here a session lists under its first prompt. Cosmetic.
 *  - **No prompt library of its own.** A served run's standing instructions
 *    are the client's, carried on the wire; what this process adds is the
 *    memory-bank prompt for the banks *this* machine carries, composed from
 *    the CLI's registry under this process's home — see `runSource.startRun`.
 *  - **No plan-usage polling, no update checks, no notifications.** All
 *    window furniture.
 *  - **Permission prompts on the completions surface are auto-denied**, exactly
 *    as they are for the desktop-hosted server: an HTTP chat request has nobody
 *    behind it to ask. That is no longer the whole story. A *remote bridge*
 *    client (ADR 0004) is a person at another machine, and this process serves
 *    them the control routes — so a prompt raised by a bridge-started run is
 *    answered by whoever is holding that window, over the event stream. Serve
 *    profiles whose settings pre-authorize what their unattended work needs;
 *    attended work no longer has to.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PlanUsage, ProfileId, ProviderId, RunId } from '@rx-artemis/protocol';
import {
  RunError,
  checkAuthStatus,
  createCatalogue,
  createDefaultProviderRegistry,
  createPushFeed,
  createRemoteRunGuard,
  createSessionLedger,
  createWorkspaceResolver,
  joinSystemPromptAppends,
  machineBankPrompt,
  managedEnvKeys,
  DuplicateProfileLabelError,
  ProfileStore,
  resolveEnv,
  RunRegistry,
  SessionLifecycleLog,
  SESSION_LIFECYCLE_LOG_FILE,
  type Catalogue,
  type ProfileAdmin,
  type ProviderRegistry,
  type PushFeed,
  type RemoteAccessEvent,
  type RemoteRunGuard,
  type RunSource,
  type ServerProfileRecord,
  type SessionLedger,
  type SessionSource,
  type UsageSource,
  type WorkspaceResolver,
} from '@rx-artemis/core';

import { createFileProfileSecrets } from './secrets.js';

/**
 * The longest title a rename stores, matching the desktop's own cap so a
 * conversation renamed over the wire and one renamed locally obey the same
 * rule.
 */
const MAX_SESSION_TITLE = 200;

export interface HeadlessHost {
  readonly profiles: ProfileStore;
  readonly providers: ProviderRegistry;
  readonly runs: RunRegistry;
  readonly catalogue: Catalogue;
  readonly workspaces: WorkspaceResolver;
  readonly ledger: SessionLedger;
  readonly runSource: RunSource;
  readonly sessionSource: SessionSource;
  readonly usageSource: UsageSource;
  /** What the account-administration routes act through. See `signin.ts`. */
  readonly profileAdmin: ProfileAdmin;
  /** Every push the server can stream to a remote client. See `server/feed.ts`. */
  readonly feed: PushFeed;
  /** Interrupt-on-disconnect for bridge-started runs. See `server/guard.ts`. */
  readonly guard: RemoteRunGuard;
  /**
   * The attribution record: which token did what.
   *
   * The headless deployment is the one this matters most for. A desktop server
   * has a person in front of it who can watch a run appear; this process is
   * reached only over the wire, by tokens, and "which of these four started
   * that" has no other answer. Ids and event names only — see
   * `RemoteAccessEvent` — into the same append-only JSONL file the run
   * lifecycle goes into, beside the ledger in the data directory.
   */
  readonly recordAccess: (event: RemoteAccessEvent) => void;
  dispose(): Promise<void>;
}

export function createHeadlessHost(dataDir: string): HeadlessHost {
  const providers = createDefaultProviderRegistry({});
  const managed = [...new Set(providers.list().flatMap((adapter) => managedEnvKeys(adapter.credentials)))];

  const profiles = new ProfileStore({
    userDataDir: dataDir,
    managedEnvKeys: managed,
    secrets: createFileProfileSecrets(dataDir),
  });

  const credentialsFor = (providerId: ProviderId) => {
    const adapter = providers.get(providerId);
    if (adapter === undefined) throw new Error(`No adapter for provider "${providerId}".`);
    return adapter.credentials;
  };

  const envFor = async (profileId: ProfileId, providerId: ProviderId) => {
    const profile = await profiles.require(profileId);
    const apiKey = await profiles.readApiKey(profileId);
    return resolveEnv(profile, {
      credentials: credentialsFor(providerId),
      ...(apiKey === null ? {} : { apiKey }),
    });
  };

  const runs = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    resolveRun: async ({ profileId, providerId }) => ({ env: await envFor(profileId, providerId) }),
    /*
     * Far above the registry's default of a thousand, because here the tail
     * is not a courtesy to a window that reloaded: it is what a client that
     * slept through a served turn is replayed on `GET /api/v0/runs/{id}/stream`.
     * A turn streams a text delta per token, so a thousand events is a few
     * minutes of output; a laptop lid is closed for longer than that. Each
     * event is a small object, and the runs a headless server holds at once
     * are few, so the memory is cheap next to the reply it saves.
     */
    historyLimit: 50_000,
  });

  const catalogue = createCatalogue({
    source: {
      listProfiles: () => profiles.listMetadata(),
      // The registry's own describe(), which probes availability the same way
      // the desktop's engine does — a serving machine without a provider's
      // CLI reports it unavailable rather than publishing routes that 500.
      listProviders: () => providers.describe({ includeUnregistered: false }),
      listModels: async ({ providerId, profileId }) => {
        const adapter = providers.get(providerId);
        if (adapter?.listModels === undefined) {
          return { models: providers.get(providerId)?.models ?? [], live: false };
        }
        return adapter.listModels({
          env: await envFor(profileId, providerId),
          cwd: dataDir,
        });
      },
      // The same probe the sign-in director polls, so the listing and the
      // login agree about what "signed in" means. A serving account that was
      // created and never signed in is the case this exists for: its routes
      // are published, they 401 on the first token, and nothing anywhere said
      // so.
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

  const workspaces = createWorkspaceResolver();
  const ledger = createSessionLedger(dataDir);

  /**
   * Adding a serving account, and finding one to sign in.
   *
   * The one place `profile add` and `POST /api/v0/profiles` agree, which is
   * what stops the CLI and the API from producing subtly different accounts:
   * the same suggested directory, the same duplicate-label rule, the same
   * `mkdir`. A second implementation of any of those would be discovered by
   * whoever created an account one way and could not sign it in the other.
   */
  const profileAdmin: ProfileAdmin = {
    async create(draft) {
      const label = draft.label.trim();
      const existing = await profiles.list();
      /*
       * A label is not merely a name here: `assignProfileSlugs` derives a
       * route's left half from it, and two accounts called "work" become
       * `work` and `work-2` — an address that moves the day either is
       * renamed or deleted. The desktop tolerates duplicates because nothing
       * there is addressed by name; a server cannot.
       */
      if (existing.some((profile) => profile.label.trim().toLowerCase() === label.toLowerCase())) {
        throw new DuplicateProfileLabelError(label);
      }

      /*
       * A directory is *always* supplied, and that is a fix rather than a
       * convenience. `ProfileStore.create` requires one — a profile with no
       * directory has no account and no history — so `profile add --label work`
       * without `--config-dir` used to hand it `undefined` and die with
       * `"undefined" cannot be used as a config directory`, which is precisely
       * the invocation the deployment docs tell people to run.
       *
       * The store's own suggestion is `<dataDir>/profiles/<label>`, which is
       * the path the container documentation already names, and it is
       * *adopted* rather than reset when it already exists: a redeploy against
       * the same volume finds the credential the last one wrote and comes up
       * signed in.
       */
      const profile = await profiles.create({
        label,
        providerId: draft.providerId as ProviderId,
        configDir: draft.configDir ?? (await profiles.suggestConfigDir(label)),
      });

      const configDir = profiles.configDirFor(profile);
      // Made now rather than left to the CLI. The login is spawned with this
      // as its working directory, and a `spawn` into a directory that does not
      // exist fails with an `ENOENT` that names nothing a user could act on.
      await mkdir(configDir, { recursive: true });
      // The catalogue caches for minutes, and a client that has just added an
      // account will ask for it immediately.
      catalogue.invalidate();

      return describeProfile(profile.id, profile.providerId, profile.label, configDir);
    },

    async find(profileId) {
      const profile = await profiles.get(profileId as ProfileId);
      if (profile === undefined) return undefined;
      return describeProfile(
        profile.id,
        profile.providerId,
        profile.label,
        profiles.configDirFor(profile),
      );
    },

    async update(profileId, patch) {
      if (patch.label !== undefined) {
        const label = patch.label.trim();
        const existing = await profiles.list();
        // The create route's duplicate rule, applied to the rename that can
        // recreate the collision it exists to prevent: slugs are derived from
        // labels, and two accounts called "work" are two addresses that move.
        if (
          existing.some(
            (profile) =>
              profile.id !== (profileId as ProfileId) &&
              profile.label.trim().toLowerCase() === label.toLowerCase(),
          )
        ) {
          throw new DuplicateProfileLabelError(label);
        }
      }
      const updated = await profiles.update(profileId as ProfileId, {
        ...(patch.label === undefined ? {} : { label: patch.label.trim() }),
        ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
        ...(patch.apiKey === undefined ? {} : { apiKey: patch.apiKey }),
      });
      // A rename moves the account's route slug; a new address changes what
      // its models are. Either way the published catalogue is stale.
      catalogue.invalidate();
      return describeProfile(
        updated.id,
        updated.providerId,
        updated.label,
        profiles.configDirFor(updated),
      );
    },

    async delete(profileId) {
      // The record, its key, its routes. The config directory stays - see the
      // interface's contract for why the wire never removes files.
      await profiles.delete(profileId as ProfileId, { deleteConfigDir: false });
      catalogue.invalidate();
    },
  };

  function describeProfile(
    id: ProfileId,
    providerId: ProviderId,
    label: string,
    configDir: string,
  ): ServerProfileRecord {
    return { id, label, providerId, configDir, credentials: credentialsFor(providerId) };
  }

  /*
   * The push feed: every agent event, stamped with the account its run bills
   * so the routes can filter per connection. Subscribed once, here, because
   * the feed's sequence numbers are the remote client's replay cursor and a
   * second subscription would number every event twice. `runs.get` covers
   * live and recently-ended runs, so even a run's own `run.end` still finds
   * its profile.
   */
  const feed = createPushFeed();
  runs.subscribe((event) => {
    const profileId = runs.get(event.runId)?.profileId;
    feed.publish(
      'artemis:push:agent-event',
      event,
      profileId === undefined ? {} : { profileId: String(profileId) },
    );
  });

  /**
   * A requested permission mode, kept only when the serving provider really
   * has it. Dropping rather than erroring is the wire's own convention — an
   * unsupported mode leaves the run in the serving user's setting, which is
   * exactly what every request got before modes could travel.
   */
  const clampMode = (providerId: ProviderId, mode: string | undefined): string | undefined => {
    if (mode === undefined) return undefined;
    const capabilities = providers.get(providerId)?.capabilities;
    return capabilities?.permissionModes.includes(mode as never) === true ? mode : undefined;
  };

  /**
   * The gauges, read where the accounts are and cached where they are read.
   *
   * A reading is a CLI control call per account, so one is allowed to be a
   * minute old — the same tolerance the desktop's own poller extends to an
   * idle profile. Failures cache too, briefly, so an account whose CLI is
   * wedged does not get probed on every request.
   */
  const USAGE_CACHE_MS = 60_000;
  const usageCache = new Map<string, { at: number; row: { profileId: string; label: string; usage: PlanUsage } }>();
  const usageSource: UsageSource = {
    read: async (query) => {
      const rows: { profileId: string; label: string; usage: PlanUsage }[] = [];
      for (const profileId of query.profileIds) {
        const cached = usageCache.get(profileId);
        if (cached !== undefined && Date.now() - cached.at < USAGE_CACHE_MS) {
          rows.push(cached.row);
          continue;
        }
        try {
          const profile = await profiles.require(profileId as ProfileId);
          const adapter = providers.get(profile.providerId);
          if (adapter?.fetchPlanUsage === undefined) continue;
          const usage = await adapter.fetchPlanUsage({
            profileId: profile.id,
            env: await envFor(profile.id, profile.providerId),
          } as never);
          const row = { profileId, label: profile.label, usage };
          usageCache.set(profileId, { at: Date.now(), row });
          rows.push(row);
        } catch {
          // An unreadable gauge is a row that does not appear; the account
          // itself is untouched, and the next request past the cache retries.
        }
      }
      return rows;
    },
  };

  const runSource: RunSource = {
    startRun: (input) => {
      const permissionMode = clampMode(input.providerId as ProviderId, input.permissionMode);
      /*
       * What the run is told, on top of the serving provider's preset: the
       * client's own standing instructions (the route has already set the
       * field aside for a provider that cannot append), then this machine's
       * memory-bank prompt, composed here from this machine's own registry.
       *
       * Here and not on the client, because the prompt is about the machine
       * the run executes on — the banks *this* container carries, at the paths
       * they have here, driven by the CLI on this PATH. The client's rendering
       * would name its own slugs and a path on a laptop; the desktop keeps
       * that built-in off the wire for exactly this reason. Consent is the
       * CLI's own: a bank is described only if `cerebro enable` left it
       * enabled in the registry and it is present on disk.
       *
       * The wire and the adapter both refuse a replacement, so an append is
       * the only shape that reaches here.
       */
      const canAppend =
        providers.get(input.providerId as ProviderId)?.capabilities.systemPromptAppend === true;
      const instructions = canAppend
        ? joinSystemPromptAppends(input.systemPrompt, machineBankPrompt())
        : undefined;
      return runs.start({
        providerId: input.providerId as ProviderId,
        profileId: input.profileId as ProfileId,
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
        ...(input.ultracode === undefined ? {} : { ultracode: input.ultracode }),
        ...(input.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: input.resumeSessionId as never }),
        ...(permissionMode === undefined ? {} : { permissionMode: permissionMode as never }),
        ...(instructions === undefined
          ? {}
          : { systemPrompt: { kind: 'append', text: instructions } as const }),
      } as never);
    },
    subscribe: (listener) => runs.subscribe(listener),
    interrupt: async (runId) => {
      await runs.interrupt(runId as RunId);
    },
    respondToPermission: async (runId, requestId, decision) => {
      await runs.respondToPermission(runId as RunId, requestId as never, decision as never);
    },
    disposeRun: async (runId) => {
      await runs.dispose(runId as RunId);
    },

    // The observation surface (ADR 0004). No `liveWork`: the headless host
    // keeps no background-work ledger, and the route's contract makes the
    // empty answer it degrades to an honest one.
    listRuns: async (query) => runs.list(query.cwd),
    getRun: async (runId) => runs.get(runId as RunId),
    runEvents: async (query) => {
      const after = query.afterSeq ?? -1;
      const events = runs.eventsSince(query.runId as RunId, after);
      // The buffer drops from the front, so a first event that is not the one
      // immediately after `after` is the only evidence that something was
      // lost — the same derivation the desktop's engine makes.
      const first = events[0];
      return { events, truncated: first !== undefined && first.seq > after + 1 };
    },

    // The control surface. `startUserRun` takes the whole RunInput — the
    // routes have already enforced the token's scope, and the registry
    // enforces capabilities exactly as it does for a window.
    startUserRun: (input) => runs.start(input),
    send: async (runId, text, attachments) => {
      const outcome = await runs.send(runId as RunId, text, attachments);
      return { deliveredImmediately: outcome.deliveredImmediately };
    },
    interruptRun: (runId) => runs.interrupt(runId as RunId),
    stopTask: (runId, taskId) => runs.stopTask(runId as RunId, taskId),
  };

  /*
   * Interrupt-on-disconnect, and the attribution record in one wiring: a
   * bridge run whose client stays gone past the grace is interrupted, and the
   * session it announced is written into the ledger against the connection
   * that started it — `origin: 'bridge'`, so it is reachable from the whole
   * connection family later without ever being mistaken for a program's.
   */
  const guard = createRemoteRunGuard({
    interrupt: (runId) => runs.interrupt(runId as RunId),
    feed,
    onSession: (run, sessionId) => {
      ledger.record({
        sessionId,
        connectionId: run.connectionId,
        profileId: run.profileId,
        workspaceKey: run.workspaceKey,
        cwd: run.cwd,
        origin: 'bridge',
      });
    },
  });

  /*
   * The attribution log, on the same file the run lifecycle writes to.
   *
   * One story, one file: a bridge token started a run, the registry adopted
   * it, something ended it. Splitting the remote half into a log of its own
   * would mean correlating two files by timestamp to answer a question that is
   * one sentence long. Ids only — the log's `RECORDED_KEYS` allowlist is what
   * enforces that, rather than the caller remembering to.
   */
  const accessLog = new SessionLifecycleLog({
    file: join(dataDir, SESSION_LIFECYCLE_LOG_FILE),
    onError: (error) =>
      process.stderr.write(
        `could not append to the session-lifecycle log: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      ),
  });

  const sessionSource: SessionSource = {
    list: async (query) => {
      const adapter = providers.get(query.providerId as ProviderId);
      if (adapter?.listSessions === undefined) return { sessions: [], hasMore: false };
      return adapter.listSessions({
        profileId: query.profileId as ProfileId,
        cwd: query.cwd,
        env: await envFor(query.profileId as ProfileId, query.providerId as ProviderId),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
    messages: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.getSessionMessages === undefined) return { events: [], hasMore: false };
      return adapter.getSessionMessages({
        profileId: query.profileId as ProfileId,
        sessionId: query.sessionId as never,
        runId: query.runId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },
    /*
     * The three writes, each present on the wire only insofar as the serving
     * adapter really has the method — the route answers 501 for the rest.
     * Normalisation lives here, not in the route: the reply shows the caller
     * what the store now says, and that answer has to be produced by whoever
     * does the storing (the same reasoning the desktop's rename handler
     * gives, with the same cap).
     */
    rename: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.setSessionTitle === undefined) {
        throw new RunError('invalid_request', `${profile.providerId} cannot rename a stored session.`);
      }
      const title = query.title.trim().slice(0, MAX_SESSION_TITLE);
      if (title.length === 0) throw new RunError('invalid_request', 'A session title cannot be empty.');
      await adapter.setSessionTitle({
        sessionId: query.sessionId as never,
        title,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { title };
    },
    delete: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.deleteSession === undefined) {
        throw new RunError('invalid_request', `${profile.providerId} cannot delete a stored session.`);
      }
      return adapter.deleteSession({
        sessionId: query.sessionId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },
    tag: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.tagSession === undefined) {
        throw new RunError('invalid_request', `${profile.providerId} cannot tag a stored session.`);
      }
      return adapter.tagSession({
        sessionId: query.sessionId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        tag: query.tag,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },
  };

  return {
    profiles,
    providers,
    runs,
    catalogue,
    workspaces,
    ledger,
    runSource,
    sessionSource,
    usageSource,
    profileAdmin,
    feed,
    guard,
    recordAccess: (event) => accessLog.record(event),
    dispose: async () => {
      guard.dispose();
      await runs.disposeAll();
      await ledger.flush();
      await workspaces.disposeAll();
    },
  };
}
