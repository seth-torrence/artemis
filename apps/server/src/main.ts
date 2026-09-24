#!/usr/bin/env node
/**
 * Headless Artemis.
 *
 * One binary, four verbs:
 *
 *   artemis-server serve                       — bind and answer until signalled
 *   artemis-server profile add <label> ...     — register a serving account
 *   artemis-server connection create ...       — mint a token (prints it once)
 *   artemis-server connection list|revoke ...  — inspect and retract grants
 *
 * and `artemis-server --version`, which prints the Artemis release this is —
 * the same number `/health` reports. See `version.ts`.
 *
 * Configuration is environment-first, because the process is built to live in
 * a container:
 *
 *   ARTEMIS_DATA_DIR       where profiles.json, server.json, the session
 *                          ledger and the profile config directories live.
 *                          Default: ~/.artemis-server
 *   ARTEMIS_BIND_HOST      interface to bind. Default 127.0.0.1; a container
 *                          sets 0.0.0.0 and lets its published port and the
 *                          network in front of it govern reachability.
 *   ARTEMIS_PORT           overrides server.json's port when set.
 *   ARTEMIS_ALLOWED_HOSTS  comma-separated Host-header names to answer to,
 *                          or `any`. Defaults to `any` when the bind host is
 *                          not loopback — the Host check is DNS-rebinding
 *                          protection for loopback binds, and a deliberately
 *                          reachable server is guarded by its bind + auth.
 *
 * Two more govern the runs a completions client detaches from — a laptop that
 * slept mid-turn — and both are ceilings rather than schedules. Neither applies
 * to a caller that did not ask for the behaviour; see `ArtemisRemoteOptions`.
 * Neither governs a *bridge*-started run either, which has its own sixty-second
 * grace in `server/guard.ts`.
 *
 *   ARTEMIS_DETACHED_RUN_TTL_MS   how long a run nobody has come back for is
 *                          kept before it is interrupted and disposed.
 *                          Default 6h. The clock restarts every time the
 *                          owning connection touches the run, so a client
 *                          that is polling is never reaped mid-read.
 *   ARTEMIS_PERMISSION_PARK_MS    how long a permission prompt waits for an
 *                          answer, while a client is attached, before it is
 *                          denied with the standing "nobody is here" message.
 *                          Off by default: a question waits for the person
 *                          it was asked of, bounded only by the run's own
 *                          deadline above. Set it for clients that ask for
 *                          prompts they will never answer.
 *
 * And one for deployments that cannot run this CLI interactively at all:
 *
 *   ARTEMIS_BOOTSTRAP_CONNECTIONS   a JSON array of connections to make sure
 *                          exist, merged into server.json at startup. For
 *                          orchestrated deploys — Swarm, Nomad, a PaaS — where
 *                          there is no shell to run `connection create` in and
 *                          therefore no way to mint the *first* token, leaving
 *                          the server reachable by nobody. Idempotent; the CLI
 *                          remains the interactive path and the file remains
 *                          the truth for every connection this does not name.
 *                          See `config.ts`.
 *   ARTEMIS_ALLOW_CHROME_BROWSER   `1` lets a served run be connected to a
 *                          Chrome (`artemis.chromeBrowser`). Off by default,
 *                          and worth a thought before it is on: the bridge
 *                          pairs by account, so the Chrome a run drives is the
 *                          one signed in as the *serving account*, and every
 *                          connection allowed that account can then act in its
 *                          owner's browser. Right for a server whose accounts
 *                          and connections are all one person's; on a shared
 *                          one it hands teammates each other's logins.
 *   ARTEMIS_ALLOW_CLIENT_BROWSER   `0` stops a served run driving the
 *                          *caller's own* browser (`artemis.extensionBrowser`).
 *                          **On by default**, which is the opposite of the
 *                          switch above and deliberately so. That one reaches
 *                          a Chrome on this machine, signed in as this
 *                          machine's account, which is somebody else's browser
 *                          and why a host says no until told otherwise. This
 *                          one reaches a browser paired with the client that
 *                          sent the request, over the connection it arrived
 *                          on: the caller is asking a run they started to use
 *                          a browser only their own client can reach, and no
 *                          other connection can see the verbs or answer them.
 *                          Set it to `0` for a server whose runs should touch
 *                          no browser at all.
 *   ARTEMIS_SIGNIN_TIMEOUT_MS   how long a sign-in driven from a client waits
 *                          for the person to finish before the login
 *                          subprocess is killed. Default 10m. See
 *                          `server/signin.ts` in core.
 *
 * ---------------------------------------------------------------------------
 * THE BROWSER BESIDE THE SERVER
 * ---------------------------------------------------------------------------
 *
 * A served run has no window, so an agent building a web app here could run the
 * tests and not look at the page. Point this process at a headless Chromium and
 * it gets the `artemisBrowser` tools — the same tool names the desktop's dock
 * browser answers to, over a browser that is signed in to nothing. Off unless
 * the first variable is set, and with it unset nothing else changes. The
 * browser runs in its own container: see `docker/docker-compose.yml`, which
 * ships the service commented out, and `docs/SERVER-BROWSER.md`.
 *
 *   ARTEMIS_BROWSER_CDP_URL   where that Chromium's DevTools port is, e.g.
 *                          `ws://browser:9222` or `http://browser:9222`. A
 *                          plain http or ws address is resolved through
 *                          `/json/version`; a full `ws://…/devtools/browser/…`
 *                          endpoint is used as it stands. The host name is
 *                          resolved to an address first, because Chromium
 *                          refuses a DevTools HTTP request whose Host header is
 *                          a name. Unset means no browser tools at all, which
 *                          is the default and is not an error.
 *   ARTEMIS_BROWSER_MAX_CONTEXTS   how many conversations may have a browser
 *                          open at once. Default 2. A third is refused with a
 *                          sentence it can act on, rather than queued. Each
 *                          context is an isolated profile: separate cookies and
 *                          storage, so two runs testing the same app do not
 *                          share a login.
 *   ARTEMIS_BROWSER_IDLE_MINUTES   minutes without a browser tool call before
 *                          a conversation's tab is closed and its memory given
 *                          back. Default 10. The run is told on its next call.
 *   ARTEMIS_BROWSER_TAB_MEMORY_MB   heap one tab may hold before the watchdog
 *                          closes it, least recently used first. Default 500.
 *                          The container's own memory limit is the backstop
 *                          behind this and should stay set.
 *   ARTEMIS_BROWSER_ALLOW_HOSTS   comma-separated internal hosts the agent may
 *                          open, on top of loopback and `artemis-server`. This
 *                          browser sits inside the operator's network, so the
 *                          public internet is open to it and everything
 *                          private is shut unless named here. Cloud metadata
 *                          addresses are refused whatever this says. Both
 *                          rules hold for every frame of a page, so a page
 *                          embedding an internal host is refused whole.
 *   ARTEMIS_BROWSER_IDLE_EXIT   `0` stops this process asking Chromium to exit
 *                          after five minutes with nothing open. On by
 *                          default, because a process that has exited holds no
 *                          memory and the recommended compose service restarts
 *                          it; turn it off only where nothing will. Turning it
 *                          off does not keep the pages — the contexts still
 *                          close — it only leaves the process up.
 *
 * Every request still authenticates with a connection token; nothing here
 * relaxes that. See the core ledger for how sessions are scoped per token.
 *
 * ---------------------------------------------------------------------------
 * SIGNING AN ACCOUNT IN, FROM SOMEWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * `profile add` registers an account and prints the login command to run
 * *inside this environment* — which assumes a shell inside this environment.
 * The same orchestrated deployments that cannot mint the first token cannot run
 * that command either, so a connection may be granted account administration
 * (`connection create --manage-profiles`, or `"manageProfiles": true` in
 * `ARTEMIS_BOOTSTRAP_CONNECTIONS`) and drive the login over HTTP from a desktop
 * Artemis instead. The grant is off unless asked for, and it is the only thing
 * that makes those routes visible — see `ServerConnection.manageProfiles`.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { DEFAULT_SERVER_PORT, isValidServerPort, summariseWorkspace } from '@rx-artemis/protocol';
import type { ServerConnection, ServerWorkspace } from '@rx-artemis/protocol';
import {
  createArtemisServer,
  createServerBrowser,
  limitsFromEnvironment,
  signInCommand,
  type ServerBrowser,
} from '@rx-artemis/core';

import type { HeadlessConfig } from './config.js';
import {
  loadConfig,
  mergeBootstrapConnections,
  saveConfig,
  newConnectionId,
  newConnectionToken,
} from './config.js';
import { createHeadlessHost } from './host.js';
import { serverVersion } from './version.js';

function dataDir(): string {
  const declared = process.env['ARTEMIS_DATA_DIR'];
  return resolve(declared !== undefined && declared.length > 0 ? declared : join(homedir(), '.artemis-server'));
}

function bindHost(): string {
  const declared = process.env['ARTEMIS_BIND_HOST'];
  return declared !== undefined && declared.length > 0 ? declared : '127.0.0.1';
}

function allowedHosts(): readonly string[] | 'any' | undefined {
  const declared = process.env['ARTEMIS_ALLOWED_HOSTS'];
  if (declared !== undefined && declared.length > 0) {
    return declared.trim() === 'any'
      ? 'any'
      : declared.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
  }
  const bind = bindHost();
  const loopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
  return loopback ? undefined : 'any';
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * How long a client-driven sign-in may stay open.
 *
 * Read here rather than inside core, so the ceiling is one an operator sets
 * beside every other ceiling this process has. An unusable value is ignored
 * rather than fatal: a typo in a timeout must not stop a server from starting.
 */
function signInTimeoutMs(): number | undefined {
  const declared = Number(process.env['ARTEMIS_SIGNIN_TIMEOUT_MS']);
  return Number.isFinite(declared) && declared > 0 ? declared : undefined;
}

/**
 * The headless browser beside this server, when one is configured.
 *
 * Nothing is dialled here and nothing is started: the object holds an address
 * and its limits, and the first `browser_open` of the first run is what opens a
 * socket. So a server whose runs never touch a browser pays for this exactly
 * what a server with the variable unset pays — which is what makes it safe to
 * build on a variable rather than on a probe.
 */
function serverBrowser(): ServerBrowser | undefined {
  const url = process.env['ARTEMIS_BROWSER_CDP_URL'];
  if (url === undefined || url.trim().length === 0) return undefined;
  return createServerBrowser({
    endpoint: url.trim(),
    limits: limitsFromEnvironment(process.env),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

async function serve(): Promise<void> {
  // Served runs share this process's PID namespace, and an agent cleaning up a
  // test server it started (`pkill -f 'main.js serve'`, a /proc cmdline loop)
  // matched `node /app/dist/main.js serve` too, SIGTERMed PID 1 and ended every
  // live run on the machine. The title replaces the command line other
  // processes see, so a pattern aimed at some other `main.js serve` misses us.
  // It avoids the words such cleanups reach for - artemis, server, node, serve
  // - so `pkill -f artemis` from an agent working on this repo misses us too.
  // The port is added once bound, so two servers on one box differ as well.
  // Node's bootstrap still shows the old command line for a moment first.
  process.title = 'run-host';
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  let config = await loadConfig(dir);
  config = await bootstrapFromEnvironment(dir, config);

  const declaredPort = process.env['ARTEMIS_PORT'];
  const port =
    declaredPort !== undefined && declaredPort.length > 0 ? Number(declaredPort) : config.port;
  if (!Number.isInteger(port) || !isValidServerPort(port)) {
    fail(`"${String(port)}" is not a usable port.`);
  }

  if (config.connections.length === 0) {
    process.stderr.write(
      'No connections are configured — this server is reachable by nobody.\n' +
        'Mint one first:  artemis-server connection create --label laptop --directory /work/repo\n',
    );
  }

  // Read fresh per request so a revocation lands without a restart — the CLI
  // writes server.json, and this re-read is what makes that matter. Cached for
  // a beat so a busy server is not hitting the disk per request. Built once and
  // shared: the router authorises against it, and a routine firing looks its
  // own connection up through the same live view.
  const readConnections = connectionReader(dir, config.connections);
  const browser = serverBrowser();
  const host = createHeadlessHost(dir, readConnections, browser);
  await Promise.all([host.ledger.load(), host.routines.load()]);

  const server = createArtemisServer({
    port,
    host: bindHost(),
    connections: readConnections,
    // The Artemis release this is, so `/health` and the index answer "which
    // version is the server on" without a trip to the host. See `version.ts`.
    version: serverVersion(),
    catalogue: host.catalogue,
    runs: host.runSource,
    workspaces: host.workspaces,
    ledger: host.ledger,
    sessions: host.sessionSource,
    routines: host.routines,
    usage: host.usageSource,
    commands: host.commandSource,
    feed: host.feed,
    guard: host.guard,
    onRemoteAccess: host.recordAccess,
    // Present unconditionally: the surface it enables is gated per connection,
    // not per deployment, so a build that wired it and a connection that was
    // never granted it produce the same 404 — which is the point.
    profileAdmin: host.profileAdmin,
    // Likewise per connection, not per deployment: a server with no banks
    // answers an administrator with an empty list rather than a 501, which is
    // the truthful answer — the registry is there, and it is empty.
    memoryBanks: host.memoryBankAdmin,
    skills: host.skillsAdmin,
    ...(signInTimeoutMs() === undefined ? {} : { signInTimeoutMs: signInTimeoutMs() as number }),
    // No `terminals`: this process has no PTY surface — see the file header on
    // what a headless deployment gives up — so the terminal routes answer 501
    // and a remote window's dock shows no shells rather than an error.
    ...(allowedHosts() === undefined ? {} : { allowedHosts: allowedHosts() as never }),
    ...(process.env['ARTEMIS_ALLOW_CHROME_BROWSER'] === '1' ? { allowChromeBrowser: true } : {}),
    // An *off* switch, so only the explicit `0` is read. Anything else —
    // unset, `1`, a typo — leaves it on, which is the documented default and
    // the one a caller asking for their own browser expects.
    ...(process.env['ARTEMIS_ALLOW_CLIENT_BROWSER'] === '0' ? { allowClientBrowser: false } : {}),
    // The relay that carries a served run's browser verbs back to the client
    // that started it. Present unconditionally: what it can reach is decided
    // per request, by the flag above and by whether the run asked.
    browserRelay: host.browserRelay,
    // A capability line, not a switch: it tells a client this machine can look
    // at a page. What actually gives a run the tools is `host.ts`.
    ...(browser === undefined ? {} : { serverBrowser: true }),
    onError: (error) => {
      process.stderr.write(`server error: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });

  const bound = await server.listen();
  // Begin the schedule only once the port is bound — a routine that fires
  // during a boot that then fails to listen would have run for nothing. The
  // start pass makes up at most one appointment per routine missed while the
  // server was down.
  host.routines.start();
  // Linux caps the title at the original argv's length: 28 bytes for the
  // container's `node /app/dist/main.js serve`, which this fits.
  process.title = `run-host :${String(bound)}`;
  process.stdout.write(`Artemis server listening on ${bindHost()}:${String(bound)} (data: ${dir})\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    process.stdout.write('Shutting down…\n');
    void Promise.allSettled([server.close(), host.dispose()]).then(() => process.exit(0));
    // A wedged provider must not make the container unkillable.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Take on the connections the deployment declared, and say what happened.
 *
 * Written to disk rather than held in memory, so the result is
 * indistinguishable from a connection minted by the CLI: `connection list`
 * shows it, `connection revoke` deletes it, and the next boot needs no
 * environment at all. See {@link mergeBootstrapConnections} for the rules.
 *
 * The log line is deliberately loud and deliberately partial. Loud, because a
 * token appearing out of the environment is a grant of authority and the
 * operator should see it happen; partial, because the whole token would then be
 * in the container's logs, in whatever ships them, and in every place those are
 * kept — which is a worse leak than the one the variable already is. Eight
 * characters is enough to match against the value they configured and useless
 * to anyone who has only the log.
 */
async function bootstrapFromEnvironment(
  dir: string,
  config: HeadlessConfig,
): Promise<HeadlessConfig> {
  const declared = process.env['ARTEMIS_BOOTSTRAP_CONNECTIONS'];
  if (declared === undefined || declared.trim().length === 0) return config;

  const merged = mergeBootstrapConnections(config.connections, declared);
  if (merged.ignored > 0) {
    process.stderr.write(
      `ARTEMIS_BOOTSTRAP_CONNECTIONS: ${String(merged.ignored)} entr${merged.ignored === 1 ? 'y was' : 'ies were'} not usable and ${merged.ignored === 1 ? 'was' : 'were'} ignored.\n` +
        'Each needs a label, a workspace, and a token of at least 32 characters.\n',
    );
  }
  if (merged.added.length === 0 && merged.updated.length === 0) return config;

  const next: HeadlessConfig = { ...config, connections: merged.connections };
  await saveConfig(dir, next);
  for (const connection of merged.added) {
    process.stdout.write(
      `Bootstrapped connection "${connection.label}" (${connection.id}) — ` +
        `${describeGrant(connection)} — token ${connection.token.slice(0, 8)}…\n`,
    );
  }
  // Said separately, because it is a different piece of news: an existing
  // grant changed under a token that clients are already configured with.
  for (const connection of merged.updated) {
    process.stdout.write(
      `Updated connection "${connection.label}" (${connection.id}) from the environment — ` +
        `${describeGrant(connection)}\n`,
    );
  }
  return next;
}

/**
 * One line naming everything a connection may do.
 *
 * Expiry is on it because it is the one part of a grant that changes without
 * anyone touching the file, and an operator reading `connection list` to decide
 * what to revoke should not have to open `server.json` to find out that half
 * these rows stopped working last week.
 */
function describeGrant(connection: ServerConnection): string {
  const parts = [summariseWorkspace(connection.workspace)];
  if (connection.manageProfiles === true) parts.push('may add and sign in accounts');
  if (connection.expiresAt !== undefined) {
    parts.push(
      connection.expiresAt <= Date.now()
        ? `expired ${new Date(connection.expiresAt).toISOString()}`
        : `expires ${new Date(connection.expiresAt).toISOString()}`,
    );
  }
  return parts.join(', ');
}

/**
 * Connections, re-read from disk at most every two seconds.
 *
 * The desktop host holds its config in memory and its UI writes through it;
 * here the CLI is a *separate process* writing server.json, and this is the
 * seam that makes `connection revoke` take effect on a running server.
 */
function connectionReader(
  dir: string,
  initial: readonly ServerConnection[],
): () => readonly ServerConnection[] {
  let cached = initial;
  let readAt = Date.now();
  let refreshing = false;
  return () => {
    if (Date.now() - readAt > 2_000 && !refreshing) {
      refreshing = true;
      void loadConfig(dir)
        .then((config) => {
          cached = config.connections;
          readAt = Date.now();
        })
        .finally(() => {
          refreshing = false;
        });
    }
    return cached;
  };
}

/* -------------------------------------------------------------------------- */
/* CLI verbs                                                                  */
/* -------------------------------------------------------------------------- */

function argOf(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

async function profileAdd(args: readonly string[]): Promise<void> {
  const label = argOf(args, 'label');
  const provider = argOf(args, 'provider') ?? 'claude';
  if (label === undefined) fail('profile add needs --label <name> [--provider claude] [--config-dir <path>]');

  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const host = createHeadlessHost(dir);
  const configDir = argOf(args, 'config-dir');

  /*
   * Through the same seam the HTTP route uses.
   *
   * One implementation, so that an account added here and an account added
   * from a client are the same kind of thing: same duplicate-label rule, same
   * suggested directory when none is named, same `mkdir`. It also fixes the
   * invocation the deployment notes actually tell people to run — see
   * `host.ts`, where omitting `--config-dir` used to reach the store as
   * `undefined` and fail.
   */
  const created = await host.profileAdmin.create({
    label,
    providerId: provider,
    ...(configDir === undefined ? {} : { configDir: resolve(configDir) }),
  });

  /*
   * The provider's own line, composed rather than written out here.
   *
   * The hand-written version said `claude login`, which the CLI renamed to
   * `claude auth login`; it had been wrong for as long as it took anyone to
   * paste it. `signInCommand` builds the line from the same
   * `ProviderCredentialSpec` the adapter uses to *run* the login, so the
   * instruction cannot drift from the thing it instructs — and it quotes the
   * config directory, which the hand-written line did not and which any path
   * with a space in it needed.
   */
  const adapter = host.providers.get(created.providerId as never);
  const command =
    adapter === undefined
      ? undefined
      : signInCommand({ credentials: adapter.credentials, configDir: created.configDir });

  process.stdout.write(
    `Profile "${label}" (${created.id}) added.\n` +
      `Config directory: ${created.configDir}\n` +
      (command === undefined
        ? "Sign the account in from inside this environment with the provider's own login command.\n"
        : `Sign the account in from inside this environment:\n  ${command}\n` +
          'Or sign it in from a desktop Artemis, against a connection created with --manage-profiles.\n'),
  );
}

async function profileList(): Promise<void> {
  const host = createHeadlessHost(dataDir());
  const rows = await host.profiles.listMetadata();
  if (rows.length === 0) {
    process.stdout.write('No profiles. Add one: artemis-server profile add --label work\n');
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${row.id}  ${row.providerId}  ${row.label}\n`);
  }
}

function readWorkspaceArgs(args: readonly string[]): ServerWorkspace {
  const directory = argOf(args, 'directory');
  if (directory !== undefined) return { kind: 'directory', path: resolve(directory) };
  if (args.includes('--ephemeral')) return { kind: 'ephemeral', perSession: true };
  return { kind: 'none' };
}

async function connectionCreate(args: readonly string[]): Promise<void> {
  const label = argOf(args, 'label');
  if (label === undefined) {
    fail('connection create needs --label <name> and one of --directory <path> | --ephemeral');
  }
  const workspace = readWorkspaceArgs(args);
  if (workspace.kind === 'none') {
    process.stderr.write(
      'No workspace given — this connection will browse the catalogue but cannot run turns.\n',
    );
  }
  /*
   * Administration is a flag rather than a default, and the warning is not
   * decoration. This token can add accounts to the server and drive their
   * logins, which is the one authority here that is not bounded by a directory
   * or an allowance — so it belongs on the operator's own connection and on no
   * other.
   */
  const manageProfiles = args.includes('--manage-profiles');
  if (manageProfiles) {
    process.stderr.write(
      'This connection may add accounts to the server and sign them in. Keep the token to yourself — an editor or a script does not need it.\n',
    );
  }

  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const config = await loadConfig(dir);
  const connection: ServerConnection = {
    id: newConnectionId(),
    label,
    workspace,
    ...(manageProfiles ? { manageProfiles: true } : {}),
    token: newConnectionToken(),
    createdAt: Date.now(),
  };
  await saveConfig(dir, { ...config, connections: [...config.connections, connection] });

  process.stdout.write(
    `Connection "${label}" (${connection.id}) — ${describeGrant(connection)}\n` +
      `Token (shown once; paste it into the profile's API-key field on the client):\n` +
      `${connection.token}\n`,
  );
}

async function connectionList(): Promise<void> {
  const config = await loadConfig(dataDir());
  if (config.connections.length === 0) {
    process.stdout.write('No connections.\n');
    return;
  }
  for (const connection of config.connections) {
    process.stdout.write(`${connection.id}  ${connection.label}  ${describeGrant(connection)}\n`);
  }
}

async function connectionRevoke(args: readonly string[]): Promise<void> {
  const id = args[0];
  if (id === undefined) fail('connection revoke needs the connection id (see: connection list)');
  const dir = dataDir();
  const config = await loadConfig(dir);
  const remaining = config.connections.filter((connection) => connection.id !== id);
  if (remaining.length === config.connections.length) fail(`No connection with id "${id}".`);
  await saveConfig(dir, { ...config, connections: remaining });
  process.stdout.write(`Connection ${id} revoked. A running server stops honouring it within seconds.\n`);
}

async function main(): Promise<void> {
  const [, , verb, noun, ...rest] = process.argv;
  if (verb === '--version' || verb === 'version') {
    process.stdout.write(`${serverVersion()}\n`);
    return;
  }
  if (verb === undefined || verb === 'serve') return serve();
  if (verb === 'profile' && noun === 'add') return profileAdd(rest);
  if (verb === 'profile' && noun === 'list') return profileList();
  if (verb === 'connection' && noun === 'create') return connectionCreate(rest);
  if (verb === 'connection' && noun === 'list') return connectionList();
  if (verb === 'connection' && noun === 'revoke') return connectionRevoke(rest);
  fail(
    'Usage: artemis-server [serve] | profile add|list | connection create|list|revoke | --version\n' +
      '  connection create --label <name> [--directory <path> | --ephemeral] [--manage-profiles]\n' +
      `Data directory: ${dataDir()} (set ARTEMIS_DATA_DIR to move it)`,
  );
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
