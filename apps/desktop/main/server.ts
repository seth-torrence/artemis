/**
 * Who owns the local server, and where its settings live.
 * ============================================================================
 *
 * `@rx-artemis/core` knows how to answer HTTP and how to assemble a catalogue;
 * it does not know when to start, what port the user chose, or who to tell when
 * something changes. That is this file: one host, created at boot, holding the
 * server's configuration, its lifecycle and the single {@link ServerState} that
 * every window renders.
 *
 * ---------------------------------------------------------------------------
 * ONE SERVER, MANY WINDOWS
 * ---------------------------------------------------------------------------
 *
 * There is exactly one listener per Artemis process, not one per window, and
 * that is not an optimisation — two windows cannot bind the same port, and a
 * second window that tried would show its user an `EADDRINUSE` caused by their
 * own app. So the host is app-scoped, every change is broadcast, and a window
 * that was not looking gets the news anyway.
 *
 * ---------------------------------------------------------------------------
 * THE CONFIG FILE, AND WHY IT IS NOT `prefs.json`
 * ---------------------------------------------------------------------------
 *
 * `prefs.json` is the renderer's blob: main writes it without reading it, by
 * design. This file has to be read *before any window exists* — autostart means
 * binding a port during boot — and it holds a token main must know to check
 * against. Those are the two things `prefs.json` is specifically arranged not
 * to be, so this gets its own file beside it, owner-only, parsed here.
 *
 * ---------------------------------------------------------------------------
 * CONNECTIONS, AND THE TOKENS THAT ARE THEM
 * ---------------------------------------------------------------------------
 *
 * There is no server-wide credential. Each *connection* is 32 bytes from
 * `randomBytes`, base64url, issued when a person creates it in the Server tab
 * and bound at that moment to a workspace — a folder they picked, a scratch
 * directory, or nothing at all. A token authenticates that connection and
 * nothing else, and deleting one revokes exactly one program's access.
 *
 * A fresh install therefore has **no connections and is reachable by nobody**,
 * which is the correct starting state rather than an unfinished one: there is
 * no ambient credential to leak, and the first token exists only because
 * someone chose where it may work.
 *
 * These do travel to the renderer, the one deliberate exception to the rule
 * that credentials do not: the pane's entire job is to show a string the user
 * will paste into another program. `redact.ts` does not object — `token` is not
 * a forbidden key and a random string matches none of the credential patterns —
 * and that is correct rather than a hole, because the value came from
 * `randomBytes` here and unlocks no account.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  DEFAULT_SERVER_PORT,
  SERVER_HOST,
  isValidServerPort,
  normalizeWorkspace,
  serverUrl,
  type ProfileId,
  type ServerAllowance,
  type ServerConnection,
  type ServerFault,
  type ServerProfile,
  type ServerState,
  type ServerTraffic,
  type ServerWorkspace,
} from '@rx-artemis/protocol';
import {
  createArtemisServer,
  createCatalogue,
  createPushFeed,
  createRemoteRunGuard,
  createRemoteTerminals,
  createWorkspaceResolver,
  sweepStaleWorkspaces,
  SessionLifecycleLog,
  SESSION_LIFECYCLE_LOG_FILE,
  type ArtemisServer,
  type Catalogue,
  type RemoteTerminals,
  type RunSource,
  type WorkspaceResolver,
} from '@rx-artemis/core';

import type { EngineHost } from './engine.js';
import type { TerminalHost } from './terminal.js';
import { createLogger } from './log.js';
import { looksLikeSecretValue } from './redact.js';
import { createSessionLedger } from '@rx-artemis/core';

const log = createLogger('server');

/** Beside `profiles.json` and `prefs.json`, and named the way they are. */
export const SERVER_CONFIG_FILE = 'server.json';

/** What persists across launches. Everything else about the server is live state. */
interface StoredConfig {
  readonly port: number;
  readonly autoStart: boolean;
  readonly connections: readonly ServerConnection[];
}

export interface ServerHostOptions {
  readonly engine: EngineHost;
  /** Artemis's data directory — where {@link SERVER_CONFIG_FILE} lives. */
  readonly userDataDir: string;
  /** Artemis's version, reported by `/health`. */
  readonly appVersion: string;
  /** Push a new state to every window. */
  readonly broadcast: (state: ServerState) => void;
  /**
   * This machine's shells, so a remote window can open one (ADR 0004).
   *
   * The *same* host the local window uses, deliberately: the containment
   * rules that make a terminal safe — main picks the program, main owns the
   * ids, main owns the lifetime, and the environment is stripped of the
   * config-directory variables — are properties of that file, and a second
   * spawner for remote clients would be a second place to get them wrong.
   * What the remote surface adds is visibility scoping, which lives in the
   * core's `terminals.ts` and cannot see a shell this window opened.
   *
   * Omitted by tests that do not care, in which case the terminal routes
   * answer `501` exactly as the headless server's do.
   */
  readonly terminals?: TerminalHost;
}

export interface ServerHost {
  /**
   * Read config from disk and, if autostart is on, bind.
   *
   * Never throws: a server that cannot start is a state to render, not a reason
   * to fail Artemis's boot. The one thing a caller must not do is skip this —
   * before it runs, {@link state} reports a stopped server with a placeholder
   * token, which is true but useless.
   */
  start(): Promise<void>;
  /** The state right now. Cheap; the pane polls it for traffic. */
  state(): ServerState;
  listen(): Promise<ServerState>;
  close(): Promise<ServerState>;
  configure(change: { readonly port?: number; readonly autoStart?: boolean }): Promise<ServerState>;
  /**
   * Issue a connection: a token, and the workspace it is forever bound to.
   *
   * The workspace is fixed here and nowhere else — see {@link ServerConnection}
   * on why a token's authority must not widen after it has been handed out.
   */
  createConnection(draft: {
    readonly label: string;
    readonly workspace: ServerWorkspace;
    /** Accounts and models this token may reach. Omit for everything. */
    readonly allow?: readonly ServerAllowance[];
    /** Epoch ms it stops working. Omit for a token that never expires. */
    readonly expiresAt?: number;
  }): Promise<ServerState>;
  /** Rename one. The label grants nothing, so it is the only editable field. */
  renameConnection(id: string, label: string): Promise<ServerState>;
  /** Revoke one. It stops working on the next request, with no restart. */
  deleteConnection(id: string): Promise<ServerState>;
  /**
   * What the server publishes, off the same cache the HTTP surface reads.
   *
   * Shared rather than duplicated so the settings pane and a client cannot
   * disagree about what is being served — and so a pane that opens just after a
   * client polled costs nothing.
   */
  catalogue(options?: { readonly refresh?: boolean }): Promise<readonly ServerProfile[]>;
  /**
   * Where turns run, for the completions surface to resolve against.
   *
   * Held here rather than created per request because scratch directories are
   * *kept* across a conversation — the resolver is the thing that remembers
   * which session owns which directory, and a fresh one per request would hand
   * every turn an empty folder.
   */
  readonly workspaces: WorkspaceResolver;
  /**
   * Drop the cached catalogue.
   *
   * Called when profiles change, because the catalogue's five-minute TTL is
   * tuned for "a provider shipped a model", not for "the user just created an
   * account and is looking at the pane to see it appear".
   */
  invalidateCatalogue(): void;
  /**
   * Was this conversation started by a program through the server?
   *
   * Read by the sessions list, which hides them: the sidebar is a list of
   * conversations *the user* started, and a script polling every minute would
   * otherwise bury their own work. See the core session ledger (`@rx-artemis/core`, `server/ledger.ts`).
   */
  isServerSession(sessionId: string): boolean;
  /** Stop listening, for app shutdown. Safe to call when never started. */
  dispose(): Promise<void>;
}

export function createServerHost(options: ServerHostOptions): ServerHost {
  const configPath = join(options.userDataDir, SERVER_CONFIG_FILE);

  let config: StoredConfig = { port: DEFAULT_SERVER_PORT, autoStart: false, connections: [] };
  let phase: ServerState['phase'] = 'stopped';
  let server: ArtemisServer | null = null;
  let boundPort: number | null = null;
  let startedAt: number | null = null;
  let lastError: ServerFault | null = null;
  let traffic: ServerTraffic = { total: 0, rejected: 0 };

  const workspaces: WorkspaceResolver = createWorkspaceResolver();

  /**
   * The engine, reduced to what running one HTTP turn needs.
   *
   * Narrow on purpose. `RunInput` can carry a permission mode, a system prompt
   * and a tool set; none of them is offered here, because those are the *user's*
   * settings and an HTTP caller is not the user. What a caller may influence is
   * exactly what `ArtemisChatExtensions` allows — which model, how hard to
   * think, and which conversation to continue.
   */
  /*
   * Which runs this server started, so their sessions can be recognised.
   *
   * A run started here writes a transcript indistinguishable from one the user
   * typed — same provider, same directory — so the only moment the difference
   * is knowable is now, as it starts. Recorded here and read by the sessions
   * list; see the core session ledger for why the record lives beside the app's
   * data rather than as a tag on the provider's own file.
   */
  const ledger = createSessionLedger(options.userDataDir);

  /**
   * The engine's session store, reduced to the two reads the server's routes
   * make. Authorisation is not here — the routes consult the ledger before
   * either call — this only answers with what the provider stored.
   */
  const sessionSource = {
    list: async (query: {
      readonly providerId: string;
      readonly profileId: string;
      readonly cwd: string;
      readonly limit?: number;
    }) =>
      options.engine.require().listSessions({
        providerId: query.providerId as never,
        profileId: query.profileId as never,
        cwd: query.cwd,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    messages: async (query: {
      readonly profileId: string;
      readonly sessionId: string;
      readonly runId: string;
      readonly cwd?: string;
    }) =>
      options.engine.require().getSessionMessages({
        profileId: query.profileId as never,
        sessionId: query.sessionId as never,
        runId: query.runId as never,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      }),
    // The three writes, delegated to the same engine handlers the sidebar
    // uses, so a rename over the wire and a rename from the window are one
    // code path — same trim, same cap, same store.
    rename: async (query: {
      readonly profileId: string;
      readonly sessionId: string;
      readonly title: string;
      readonly cwd?: string;
    }) =>
      options.engine.require().renameSession({
        profileId: query.profileId as never,
        sessionId: query.sessionId as never,
        title: query.title,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      }),
    delete: async (query: {
      readonly profileId: string;
      readonly sessionId: string;
      readonly cwd?: string;
    }) =>
      (
        await options.engine.require().deleteSession({
          profileId: query.profileId as never,
          sessionId: query.sessionId as never,
          ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        })
      ).deleted,
    tag: async (query: {
      readonly profileId: string;
      readonly sessionId: string;
      readonly tag: string | null;
      readonly cwd?: string;
    }) =>
      (
        await options.engine.require().tagSession({
          profileId: query.profileId as never,
          sessionId: query.sessionId as never,
          tag: query.tag,
          ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        })
      ).tagged,
  };

  /**
   * The gauges for a desktop that serves. The engine's own cache answers —
   * the same numbers this machine's windows read — with a refresh for a
   * profile nobody local has looked at lately.
   */
  const usageSource = {
    read: async (query: { readonly profileIds: readonly string[] }) => {
      const rows = [];
      // One listing for the labels, not one describe per row: the engine has
      // no single-profile read on this surface, and the list is what the
      // sidebar already pays for.
      const labels = new Map(
        (await options.engine.require().listProfiles({})).map((profile) => [
          String(profile.id),
          profile.label,
        ]),
      );
      for (const profileId of query.profileIds) {
        try {
          const usage = await options.engine.require().refreshPlanUsage({ profileId: profileId as never });
          rows.push({ profileId, label: labels.get(profileId) ?? profileId, usage });
        } catch {
          // Unreadable gauge: no row, account untouched.
        }
      }
      return rows;
    },
  };

  const runs: RunSource = {
    startRun: async (input) => {
      return options.engine.require().startRun({
        providerId: input.providerId as ServerConnection['id'] as never,
        profileId: input.profileId as never,
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        ...(input.effort === undefined ? {} : { effort: input.effort as never }),
        ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
        ...(input.ultracode === undefined ? {} : { ultracode: input.ultracode }),
        ...(input.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: input.resumeSessionId as never }),
        ...(input.permissionMode === undefined
          ? {}
          : { permissionMode: input.permissionMode as never }),
        // The client composed these on its own machine; apply them as an append
        // on top of this profile's preset. `engine.startRun` also merges this
        // machine's own library, and `withSystemPromptAppended` concatenates the
        // two — a desktop that serves a client both of which have standing
        // instructions sends both, which is additive rather than a conflict.
        ...(input.systemPrompt === undefined
          ? {}
          : { systemPrompt: { kind: 'append', text: input.systemPrompt } as const }),
      } as never);
    },
    subscribe: (listener) => options.engine.require().subscribe(listener),
    interrupt: async (runId) => {
      await options.engine.require().interruptRun(runId);
    },
    respondToPermission: async (runId, requestId, decision) => {
      await options.engine
        .require()
        .respondToPermission(runId, requestId as never, decision as never);
    },
    disposeRun: async (runId) => {
      await options.engine.require().disposeRun(runId);
    },

    // The observation surface (ADR 0004): the same reads `runs:list` and
    // `runs:events` answer for a window, exposed so a remote bridge can draw
    // this machine. Thin passthroughs — visibility filtering happens in the
    // routes, against the connection that asked.
    listRuns: (query) => options.engine.require().listRuns(query),
    getRun: async (runId) => options.engine.require().getRun(runId as never),
    runEvents: async (query) =>
      options.engine.require().runEvents({
        runId: query.runId as never,
        ...(query.afterSeq === undefined ? {} : { afterSeq: query.afterSeq }),
      }),
    liveWork: async () => {
      const engine = options.engine.require();
      return {
        sessionIds: engine.liveWorkSessions(),
        working: engine.workingSessions(),
        delegated: engine.delegatedWork(),
      };
    },

    // The control surface: the same engine verbs a window's IPC handlers
    // call, which is the point — a remote answer to a permission prompt takes
    // exactly the path a local click takes once it clears the routes' scope
    // checks. `startUserRun` goes through `engine.startRun`, so bridge runs
    // get the user's standing instructions and settings like any other.
    startUserRun: (input) => options.engine.require().startRun(input),
    send: (runId, text, attachments) =>
      options.engine.require().sendToRun(runId as never, text, attachments),
    interruptRun: (runId) => options.engine.require().interruptRun(runId as never),
    stopTask: (runId, taskId) => options.engine.require().stopTask(runId as never, taskId),
  };

  /**
   * The push feed the event stream serves, wired to the engine on first bind.
   *
   * Lazily, because the engine does not exist yet when this host is created —
   * and once, because the feed's sequence numbers are the stream's replay
   * cursor and a re-subscribe per bind would double every event. Each agent
   * event is stamped with the account its run bills, which is what lets the
   * routes keep an allowance-restricted token from hearing other accounts'
   * work.
   */
  const feed = createPushFeed({
    onError: (error) => log.debug('A feed listener threw', error),
  });
  let feedWired = false;
  const wireFeed = (): void => {
    if (feedWired) return;
    feedWired = true;
    options.engine.require().subscribe((event) => {
      const profileId = options.engine.require().getRun(event.runId)?.profileId;
      feed.publish(
        'artemis:push:agent-event',
        event,
        profileId === undefined ? {} : { profileId },
      );
    });
  };

  /*
   * Interrupt-on-disconnect for bridge-started runs, plus the attribution
   * record: a session a remote window starts is written into the ledger as
   * `origin: 'bridge'` — reachable by its connection family, never hidden
   * from this machine's own sidebar. See the core guard for the grace-window
   * reasoning.
   */
  const guard = createRemoteRunGuard({
    interrupt: async (runId) => {
      await options.engine.require().interruptRun(runId as never);
    },
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
    onError: (error) => log.debug('The remote run guard reported a failure', error),
  });

  /*
   * The attribution record: which token did what.
   *
   * A second writer onto the *same* file the engine's run lifecycle goes into,
   * rather than a log of its own, and that is the point rather than a
   * shortcut. The question this exists to answer — "what happened overnight?"
   * — is never only about the remote half: a bridge token started a run, the
   * registry adopted it, something ended it, and reading that story out of two
   * files with two clocks is how a five-minute answer becomes an afternoon.
   * The format is one flushed line per transition precisely so it can take
   * more than one writer; `appendFileSync` opens with `O_APPEND` each time, so
   * lines this short interleave without tearing.
   *
   * Ids only, enforced at the door by the log's own allowlist. See
   * `RemoteAccessEvent` for what is recorded and, more importantly, what is
   * deliberately not: reads. A remote window listing runs and holding the
   * event stream open is how it draws a frame, and a line per frame would bury
   * the four lines a year that matter.
   */
  const accessLog = new SessionLifecycleLog({
    file: join(options.userDataDir, SESSION_LIFECYCLE_LOG_FILE),
    onError: (error) => log.warn('Could not append to the session-lifecycle log', error),
  });

  /*
   * Shells over the wire, scoped by the connection family.
   *
   * Wired to the window's own terminal host — see {@link ServerHostOptions} on
   * why there is not a second spawner — and subscribed *unconditionally*, so
   * that events for the local window's shells reach `observe` and are dropped
   * there for want of an owner. Filtering at the subscription instead would
   * put the "which shells cross the wire" decision in two places.
   */
  const remoteTerminals: RemoteTerminals | undefined =
    options.terminals === undefined
      ? undefined
      : createRemoteTerminals({
          source: {
            start: (request) => options.terminals!.start(request),
            write: (id, data) => options.terminals!.write(id as never, data),
            resize: (id, cols, rows) => options.terminals!.resize(id as never, cols, rows),
            close: (id) => options.terminals!.close(id as never),
            replay: (id) => options.terminals!.replay(id as never),
            has: (id) => options.terminals!.has(id as never),
          },
          feed,
          onAccess: (event) => accessLog.record(event),
        });
  const unsubscribeTerminals =
    options.terminals === undefined || remoteTerminals === undefined
      ? undefined
      : options.terminals.subscribe((event) => remoteTerminals.observe(event));

  const catalogue: Catalogue = createCatalogue({
    source: {
      listProfiles: () => options.engine.require().listProfiles({}),
      listProviders: () => options.engine.require().listProviders({}),
      listModels: (query) =>
        options.engine.require().listProviderModels({
          providerId: query.providerId,
          profileId: query.profileId,
        }),
      // The engine's own probe — the same one the profile screen polls in this
      // window — so a remote client is told what a local one would see rather
      // than having to infer it from the catalogue.
      checkAuth: async (query) =>
        (await options.engine.require().authStatus(query.profileId)).status,
    },
  });

  function snapshot(): ServerState {
    return {
      phase,
      host: SERVER_HOST,
      port: config.port,
      ...(boundPort === null ? {} : { boundPort }),
      ...(boundPort === null ? {} : { url: serverUrl(SERVER_HOST, boundPort) }),
      autoStart: config.autoStart,
      connections: config.connections,
      ...(startedAt === null ? {} : { startedAt }),
      traffic,
      ...(lastError === null ? {} : { lastError }),
    };
  }

  /** Publish, and answer with what was published. */
  function publish(): ServerState {
    const state = snapshot();
    options.broadcast(state);
    return state;
  }

  /** When `lastUsedAt` was last written to disk, so the writes stay rare. */
  let lastTouchPersistedAt = 0;

  /**
   * Record that a connection was just used.
   *
   * In memory immediately, so the pane is accurate the moment it reads. On disk
   * at most once a minute, because the alternative is an atomic file write per
   * HTTP request — and a client that polls the catalogue would rewrite this file
   * every few seconds, forever, to move a timestamp nobody reads that precisely.
   */
  function touchConnection(id: string): void {
    const at = Date.now();
    config = {
      ...config,
      connections: config.connections.map((connection) =>
        connection.id === id ? { ...connection, lastUsedAt: at } : connection,
      ),
    };
    if (at - lastTouchPersistedAt < 60_000) return;
    lastTouchPersistedAt = at;
    void persist();
  }

  async function persist(): Promise<void> {
    const temp = `${configPath}.tmp`;
    try {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      // Owner-only, and this one genuinely matters: the file holds the token
      // that stands between any process on this machine and the user's accounts.
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temp, configPath);
    } catch (error) {
      // Logged, not thrown. Losing the port across a restart is a nuisance;
      // failing the user's click on Start because a write failed is worse.
      log.error('Could not persist the server configuration', error);
    }
  }

  async function load(): Promise<void> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      // Absent on first run, and unreadable is recoverable: the defaults below
      // are a working configuration, and a fresh token is safer than refusing
      // to start with a corrupt one.
      stored = null;
    }

    const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    const port = record['port'];
    const autoStart = record['autoStart'];

    const connections = readConnections(record['connections']);

    /*
     * A config written before connections existed held one `token` string.
     *
     * It is carried forward as a connection rather than dropped, because
     * something may already be configured with it — and it gets the `none`
     * workspace, which is the only honest choice: the old token never had a
     * directory, so promoting it to one would grant write access nobody asked
     * for. The user re-scopes it by issuing a new connection and deleting this.
     */
    const legacy = record['token'];
    if (connections.length === 0 && typeof legacy === 'string' && legacy.length >= 32) {
      connections.push({
        id: newId(),
        label: 'Existing token',
        workspace: { kind: 'none' },
        token: legacy,
        createdAt: Date.now(),
      });
    }

    config = {
      port: typeof port === 'number' && isValidServerPort(port) ? port : DEFAULT_SERVER_PORT,
      autoStart: autoStart === true,
      connections,
    };

    // Rewrite when the migration changed the shape, so the legacy key does not
    // linger and resurrect itself if connections are later all deleted.
    if (legacy !== undefined) await persist();
  }

  /**
   * Read stored connections, dropping anything malformed.
   *
   * Dropped rather than repaired: a connection is a credential plus a grant, and
   * a half-parsed one would be Artemis inventing an authority the user never
   * granted. A row without a usable token or a recognisable workspace is not a
   * connection at all.
   */
  function readConnections(value: unknown): ServerConnection[] {
    if (!Array.isArray(value)) return [];
    const connections: ServerConnection[] = [];

    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const token = row['token'];
      const id = row['id'];
      const label = row['label'];
      if (typeof token !== 'string' || token.length < 32) continue;
      if (typeof id !== 'string' || id.length === 0) continue;

      const workspace = readWorkspace(row['workspace']);
      if (workspace === null) continue;

      const allow = readAllowance(row['allow']);

      connections.push({
        id,
        label: typeof label === 'string' && label.length > 0 ? label : 'Connection',
        workspace,
        token,
        createdAt: typeof row['createdAt'] === 'number' ? (row['createdAt'] as number) : Date.now(),
        ...(typeof row['lastUsedAt'] === 'number'
          ? { lastUsedAt: row['lastUsedAt'] as number }
          : {}),
        // An unparseable expiry is dropped, which reads as "never expires".
        // The opposite default would be worse in the same way a corrupt
        // allowlist reading as a lockout is: a token that stopped working for
        // a reason nobody could see in the file that describes it.
        ...(typeof row['expiresAt'] === 'number' && Number.isFinite(row['expiresAt'])
          ? { expiresAt: row['expiresAt'] as number }
          : {}),
        ...(allow === undefined || allow.length === 0 ? {} : { allow }),
      });
    }

    return connections;
  }

  /**
   * A stored allowance, dropping entries that name no account.
   *
   * `undefined` for anything unparseable, which reads as "unrestricted" — the
   * same rule `connectionAllowsProfile` applies, and the only safe direction for
   * a *narrowing* to fail: a corrupt allowlist that silently became a total
   * lockout would look like a broken token nobody could diagnose.
   */
  function readAllowance(value: unknown): ServerAllowance[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const entries: ServerAllowance[] = [];
    for (const raw of value) {
      if (typeof raw !== 'object' || raw === null) continue;
      const row = raw as Record<string, unknown>;
      const profileId = row['profileId'];
      if (typeof profileId !== 'string' || profileId.length === 0) continue;
      const modelIds = Array.isArray(row['modelIds'])
        ? row['modelIds'].filter((id): id is string => typeof id === 'string' && id.length > 0)
        : undefined;
      entries.push({
        profileId: profileId as ProfileId,
        ...(modelIds === undefined || modelIds.length === 0 ? {} : { modelIds }),
      });
    }
    return entries;
  }

  /** A stored workspace, or `null` when it is not one. */
  function readWorkspace(value: unknown): ServerWorkspace | null {
    if (typeof value !== 'object' || value === null) return null;
    const row = value as Record<string, unknown>;
    switch (row['kind']) {
      case 'directory':
        // An absolute path or nothing: a relative one would resolve against
        // whatever directory the app happened to be launched from.
        return typeof row['path'] === 'string' && row['path'].startsWith('/')
          ? { kind: 'directory', path: row['path'] }
          : null;
      case 'ephemeral':
        return normalizeWorkspace({
          kind: 'ephemeral',
          perSession: row['perSession'] !== false,
        });
      case 'none':
        return { kind: 'none' };
      default:
        return null;
    }
  }

  async function bind(): Promise<ServerState> {
    if (server !== null) return snapshot();

    phase = 'starting';
    lastError = null;
    options.broadcast(snapshot());

    wireFeed();
    const instance = createArtemisServer({
      feed,
      guard,
      ...(remoteTerminals === undefined ? {} : { terminals: remoteTerminals }),
      onRemoteAccess: (event) => accessLog.record(event),
      port: config.port,
      // Read on every request, so a revoked token stops working immediately
      // rather than at the next restart. See `ArtemisServerOptions.connections`.
      connections: () => config.connections,
      version: options.appVersion,
      catalogue,
      // The two halves of running a turn. Present together or not at all — a
      // server with one and not the other would accept a completion and then
      // have nowhere to run it.
      runs,
      workspaces,
      // Ownership and history. The router records into the ledger as sessions
      // announce themselves and reads back through the source — see the core's
      // `describeScopedSessions` and the resume gate.
      ledger,
      sessions: sessionSource,
      usage: usageSource,
      onRequest: ({ rejected, connectionId }) => {
        // Counters only, never a log of what was asked — see `ServerTraffic`.
        traffic = {
          total: traffic.total + 1,
          rejected: traffic.rejected + (rejected ? 1 : 0),
          lastAt: Date.now(),
        };
        if (connectionId !== undefined) touchConnection(connectionId);
      },
      onError: (error) => log.debug('Server request failed', error),
    });

    try {
      boundPort = await instance.listen();
      server = instance;
      startedAt = Date.now();
      phase = 'running';
      log.info(`Serving Artemis profiles at ${serverUrl(SERVER_HOST, boundPort)}`);
    } catch (error) {
      // The instance may hold a half-open handle even when `listen` rejected.
      await instance.close().catch(() => undefined);
      server = null;
      boundPort = null;
      startedAt = null;
      phase = 'error';
      lastError = describeFault(error);
      log.error('Could not start the server', error);
    }

    return publish();
  }

  async function unbind(): Promise<ServerState> {
    const instance = server;
    if (instance === null) {
      // Idempotent, and it clears the error: a user who pressed Stop has
      // resolved the situation the failure was describing.
      phase = 'stopped';
      lastError = null;
      return publish();
    }

    phase = 'stopping';
    options.broadcast(snapshot());

    try {
      await instance.close();
    } catch (error) {
      log.debug('The server did not close cleanly', error);
    }

    server = null;
    boundPort = null;
    startedAt = null;
    phase = 'stopped';
    lastError = null;
    return publish();
  }

  return {
    workspaces,

    async start() {
      await Promise.all([load(), ledger.load()]);

      /*
       * Clear out what a previous life left behind.
       *
       * A process that is killed releases no scratch directories, and `/tmp`
       * outlives it until the machine reboots — so without this every hard quit
       * leaks one. Not awaited: it is filesystem housekeeping, and nothing about
       * starting Artemis should wait on it.
       */
      void sweepStaleWorkspaces().then(
        (removed) => {
          if (removed > 0) log.debug(`Swept ${removed} stale server workspace(s)`);
        },
        (error: unknown) => log.debug('Could not sweep stale server workspaces', error),
      );
      if (config.autoStart) await bind();
      else publish();
    },

    state: snapshot,
    listen: bind,
    close: unbind,

    /*
     * `lastUsedAt`, on a timer rather than on every request.
     *
     * The value answers one question — is anything still using this token? — and
     * answering it to the second would mean an atomic file write per HTTP
     * request, which for a polling client is a write every few seconds forever.
     * A minute's resolution is plenty for "can I delete this?", and the pending
     * value is still in memory for the pane to render immediately.
     */
    async configure(change) {
      const port =
        change.port !== undefined && isValidServerPort(change.port) ? change.port : config.port;
      const autoStart = change.autoStart ?? config.autoStart;
      const portChanged = port !== config.port;

      config = { ...config, port, autoStart };
      await persist();

      // A port change on a running server rebinds it. See the channel comment:
      // a field that disagrees with the URL printed above it is worse than a
      // moment of downtime the user asked for.
      if (portChanged && server !== null) {
        await unbind();
        return bind();
      }

      return publish();
    },

    async createConnection(draft) {
      const label = draft.label.trim();
      const connection: ServerConnection = {
        id: newId(),
        label: label.length > 0 ? label : 'Connection',
        // Normalised here so a connection created in memory and the same one
        // read back from disk are the same value — see `normalizeWorkspace`.
        workspace: normalizeWorkspace(draft.workspace),
        token: newServerToken(),
        createdAt: Date.now(),
        ...(draft.allow === undefined || draft.allow.length === 0
          ? {}
          : { allow: draft.allow }),
        // An expiry already in the past is dropped rather than stored: it
        // would mint a token that has never worked, which is a bug report
        // rather than a grant. The renderer computes the instant, and clocks
        // that disagree should not be able to produce one.
        ...(draft.expiresAt === undefined ||
        !Number.isFinite(draft.expiresAt) ||
        draft.expiresAt <= Date.now()
          ? {}
          : { expiresAt: draft.expiresAt }),
      };
      config = { ...config, connections: [...config.connections, connection] };
      await persist();
      return publish();
    },

    async renameConnection(id, label) {
      const trimmed = label.trim();
      if (trimmed.length === 0) return snapshot();
      config = {
        ...config,
        connections: config.connections.map((connection) =>
          connection.id === id ? { ...connection, label: trimmed } : connection,
        ),
      };
      await persist();
      return publish();
    },

    async deleteConnection(id) {
      // No restart: the server reads `config.connections` per request, so the
      // token stops working on the very next one.
      config = {
        ...config,
        connections: config.connections.filter((connection) => connection.id !== id),
      };
      await persist();
      return publish();
    },

    catalogue: (readOptions) =>
      catalogue.read(readOptions?.refresh === true ? { refresh: true } : {}),

    // `isProgramSession`, not `has`: a bridge-started conversation is in the
    // ledger (that is what makes it reachable from the user's other machines)
    // and still the person's own work — the sidebar must not bury it.
    isServerSession: (sessionId) => ledger.isProgramSession(sessionId),

    invalidateCatalogue() {
      catalogue.invalidate();
    },

    async dispose() {
      const instance = server;
      server = null;
      phase = 'stopped';
      boundPort = null;
      startedAt = null;
      guard.dispose();
      // The subscription and the visibility map, not the shells: stopping the
      // server must not kill a `pnpm dev` the local window is also showing.
      unsubscribeTerminals?.();
      remoteTerminals?.dispose();
      if (instance !== null) await instance.close().catch(() => undefined);
      // After the socket closes, so nothing is still writing into a directory
      // as it is removed.
      await workspaces.disposeAll();
    },
  };
}

/**
 * 32 bytes, base64url — URL-safe, header-safe, and no padding to lose in a copy.
 *
 * ## Why it asks the credential scanner for permission
 *
 * base64url's alphabet includes `-`, so a random token can contain the literal
 * `sk-` followed by twenty more valid characters — which is precisely the
 * Anthropic-key pattern `redact.ts` refuses to let cross into the renderer.
 * Measured, not guessed: about one token in eleven thousand.
 *
 * The consequence was total and undebuggable. Connections travel to the pane on
 * every `server:*` response, `assertResponseSafe` scans them, and an unlucky
 * token would make *every one of those responses throw* — the Server tab dead
 * for that user, for good, with an error about a credential leak that never
 * happened.
 *
 * So the generator consults the same predicate the scanner uses. One extra
 * draw, one in eleven thousand times, and the two can never disagree — which is
 * the property that matters, since `SECRET_VALUE_RULES` will grow.
 *
 * Exported for its test: the invariant is statistical, so proving it needs more
 * draws than any test that went through `createConnection` — and its atomic
 * write per call — could afford.
 */
export function newServerToken(): string {
  for (;;) {
    const token = randomBytes(32).toString('base64url');
    if (!looksLikeSecretValue(token)) return token;
  }
}


/** A short opaque id for a connection. Not a secret; it appears in the UI. */
function newId(): string {
  return randomBytes(8).toString('base64url');
}

/**
 * Turn a bind failure into something the pane can act on.
 *
 * Two codes are picked out because each has a *different* fix and the user can
 * perform both: a taken port needs a different number, and a refused low port
 * needs one above 1024. Everything else is `unknown` with the system's own
 * message, which is more useful than a category we invented.
 */
function describeFault(error: unknown): ServerFault {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'EADDRINUSE') {
    return {
      code: 'port_in_use',
      message: 'Another program is already using that port. Choose a different one.',
    };
  }
  if (code === 'EACCES') {
    return {
      code: 'permission_denied',
      message: 'This port needs elevated permissions. Choose one above 1024.',
    };
  }
  return { code: 'unknown', message };
}
