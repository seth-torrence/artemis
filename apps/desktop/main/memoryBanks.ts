/**
 * Memory banks — Cerebro generalized, from the main process's side.
 *
 * A machine can carry several git-backed, agent-maintained banks: the team's
 * shared one, a personal local-only one, a client project's, one it only
 * reads. Everything here is a seam over the `cerebro` CLI — for each bank,
 * the copy embedded in the bank itself when it carries one (the CLI *updates
 * itself* with the bank, so Artemis always speaks that bank's current
 * dialect), else the copy Artemis ships for bootstrap. The first design
 * decision is unchanged from the single-bank era: the CLI is the contract
 * (agents call it from hooks, CI calls it on every PR), and a second
 * implementation of its logic in TypeScript would drift from the first the
 * week someone changed a bank.
 *
 * The second decision is that **main owns the locations**. The renderer never
 * names a binary or an arbitrary path; this module resolves banks from the
 * CLI's own registry (`~/.config/cerebro/config.json` — read through core's
 * `memorybanks/registry`, which the headless server reads too, and written
 * only through the CLI) and refuses to run anything that is not a `cerebro`
 * CLI it resolved itself. That is the same rule the terminal keeps ("main
 * chooses the shell"), applied to a subprocess that can write.
 *
 * Spawns here are user-clicked, settings-pane rare — never keystroke-adjacent
 * — and the per-run paths (`banksForRun`, `isMasterEnabled`) are synchronous
 * file reads, never spawns.
 *
 * Parsing is split from spawning, `shellPath.ts`-style: the `parse*` functions
 * are pure, take the CLI's `--json` output as text, and are the unit under
 * test in `memoryBanks.test.ts`. They rebuild rather than pass through — only
 * the fields the protocol names cross into a response, so a future CLI field
 * can never leak into the renderer unreviewed.
 *
 * The third decision is that **the environment is composed here, once**. The
 * CLI is a Python script, and on Windows a Python script is not something a
 * process can execute — so this module resolves an interpreter and spawns
 * `[python, cli, …args]` while other platforms keep the direct exec. It also
 * tells every spawn where Artemis keeps its own state (`ARTEMIS_ROOT`,
 * without which the CLI looks in a macOS-only location and reports every
 * machine as unready), forbids git from opening a terminal prompt behind a
 * window nobody is watching, and — for a private bank — supplies the git
 * credential through `gitCredentialEnv.ts`. All of it goes through the one
 * `runCli` choke point, because "every call except that one" is how an
 * environment invariant stops being one.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  banksOnDisk,
  describeBanksForPrompt,
  embeddedCli,
  isBank,
  LEGACY_BANK_SLUG,
  legacyBankRoot,
  readRegistry,
  type MemoryBankCredential,
  type MemoryBankSecrets,
  type RegistryBank,
  type ResolvedSecret,
} from '@rx-artemis/core';
import type {
  MemoryBankActionResponse,
  MemoryBankAddRequest,
  MemoryBankAuthInput,
  MemoryBankCheck,
  MemoryBankCredentialState,
  MemoryBankForgetRequest,
  MemoryBankInfo,
  MemoryBankMemory,
  MemoryBankPreflight,
  MemoryBankProfileState,
  MemoryBankPromptInfo,
  MemoryBankRetireRequest,
  MemoryBankSetEnabledRequest,
  MemoryBankSyncRequest,
  MemoryBankVerifyOutcome,
  MemoryBankVerifyRemoteRequest,
  MemoryBankVerifyRemoteResponse,
  MemoryBanksSetMasterEnabledRequest,
  MemoryBanksStatus,
  SecretRef,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import {
  credentialOrigin,
  DEFAULT_GIT_USERNAME,
  GIT_TOKEN_ENV,
  gitCredentialEnv,
  gitCredentialsEnv,
  type GitCredential,
  type GitCredentialEnv,
} from './gitCredentialEnv.js';
import { createLogger } from './log.js';
import { scrubSecrets } from './redact.js';

const execFileAsync = promisify(execFile);
const log = createLogger('memory-banks');

/** Output ceiling for a CLI call — a full `list --json` is ~kilobytes. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The slug whose installs predate multi-bank; the CLI treats it specially. */
const LEGACY_SLUG = LEGACY_BANK_SLUG;

/** The shape of a bank slug, as the CLI validates it. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Where the single-bank era put the team bank. Still honoured: a machine that
 * cloned it before banks were plural gets it registered on the first status
 * read, under the legacy slug, without anything moving on disk.
 */
export function legacyRoot(): string {
  return legacyBankRoot();
}

/*
 * The CLI's registry and each bank's own `cerebro.json` are read by core's
 * `memorybanks/registry` — the headless server composes the same prompt from
 * the same files, and one reader is how the two hosts stay in agreement about
 * what a bank is. Re-exported so this module keeps its public surface (the
 * tests read the registry parser from here) and so the rule stands: the files
 * are read here, and written only through the CLI.
 */
export { parseRegistry, registryPath } from '@rx-artemis/core';
export type { RegistryBank } from '@rx-artemis/core';

/* -------------------------------------------------------------------------- */
/* CLI resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The copy of the CLI Artemis ships, for machines with no bank-embedded one.
 *
 * Bootstrap only: it creates and joins banks that do not exist yet, and
 * drives content-only banks (a bank someone published without embedding the
 * CLI). The moment a bank carries its own copy, that copy wins for the bank's
 * operations — see {@link resolveCli}.
 */
export function vendoredCliPath(): string | null {
  const override = process.env['ARTEMIS_VENDORED_CEREBRO'];
  const candidates = [
    ...(override !== undefined && override.length > 0 ? [override] : []),
    ...(typeof process.resourcesPath === 'string'
      ? [join(process.resourcesPath, 'cerebro')]
      : []),
    // Development: apps/desktop/resources/cerebro relative to the built main.
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'cerebro'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'cerebro'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The CLI to drive a bank (or the machine) with.
 *
 * Preference order is about staying current: a bank's embedded CLI updates
 * with the bank, so it speaks that bank's dialect; the default bank's CLI is
 * the machine's own convention (it owns the PATH shim and the hook); the
 * vendored copy is the bootstrap floor. Throws only when there is nothing at
 * all — which after vendoring means a broken install.
 */
function resolveCli(bankPath?: string): string {
  if (bankPath !== undefined) {
    const own = embeddedCli(bankPath);
    if (own !== null) return own;
  }
  const { banks, defaultSlug } = readRegistry();
  const chosen = banks.find((bank) => bank.slug === defaultSlug) ?? banks[0];
  if (chosen !== undefined) {
    const own = embeddedCli(chosen.path);
    if (own !== null) return own;
  }
  const legacy = embeddedCli(legacyRoot());
  if (legacy !== null) return legacy;
  const vendored = vendoredCliPath();
  if (vendored !== null) return vendored;
  throw new WorkspaceError(
    'No memory-bank CLI is available on this machine — reinstall Artemis, or clone a bank that embeds one.',
  );
}

/* -------------------------------------------------------------------------- */
/* Spawning a Python script on a platform that cannot execute one             */
/* -------------------------------------------------------------------------- */

/**
 * An interpreter, as a command plus the arguments that select a version.
 *
 * `py -3` is two words rather than one command because the Windows launcher is
 * a *dispatcher*: bare `py` runs whatever version the machine considers
 * default, which on a machine with Python 2 still installed is the one that
 * cannot run the CLI.
 */
export interface PythonCandidate {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * What to try, in order.
 *
 * The launcher first, because it is the one entry that is *installed with*
 * Python on Windows rather than being whatever a PATH mutation left behind,
 * and it resolves a real interpreter even when the app-execution aliases are
 * in the way. Then the version-qualified name, then the bare one — the order a
 * person would try them in, for the same reasons.
 */
export const PYTHON_CANDIDATES: readonly PythonCandidate[] = [
  { command: 'py', args: ['-3'] },
  { command: 'python3', args: [] },
  { command: 'python', args: [] },
];

/** What running `<candidate> --version` came to. */
export interface PythonProbe {
  /** Did it exit zero? */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Is this probe a real Python 3?
 *
 * Two rejections matter and one of them is not obvious. The obvious one is a
 * non-zero exit, or an answer that is not a Python 3 version.
 *
 * The other is **the Windows Store stub**. Windows ships `python.exe` and
 * `python3.exe` under `WindowsApps` as app-execution aliases that exist purely
 * to open the Store. Run with `--version` they print nothing at all and exit —
 * so a probe that only checked the exit code would accept the stub, and every
 * later spawn would either open the Store or fail with an error that says
 * nothing about Python. Empty output is therefore a rejection in its own
 * right: a real interpreter always says which one it is.
 */
export function acceptsAsPython3(probe: PythonProbe): boolean {
  if (!probe.ok) return false;
  // `--version` went to stderr on Python 3.3 and earlier and to stdout since;
  // both are read so the check does not depend on which.
  const said = `${probe.stdout} ${probe.stderr}`.trim();
  if (said.length === 0) return false;
  const version = /Python (\d+)\.(\d+)/.exec(said);
  if (version === null) return false;
  return Number(version[1]) >= 3;
}

/** The first candidate whose probe passed, or `null`. Pure; the unit under test. */
export function selectPython(
  probes: readonly { readonly candidate: PythonCandidate; readonly probe: PythonProbe }[],
): PythonCandidate | null {
  return probes.find(({ probe }) => acceptsAsPython3(probe))?.candidate ?? null;
}

/**
 * Does this CLI need an interpreter in front of it on this platform?
 *
 * The bundled CLI is an extension-less file whose first line is a shebang.
 * That is executable on macOS and Linux and is *nothing* on Windows, which
 * has no shebang support and matches executables by `PATHEXT`: `execFile`
 * fails before the script's first line runs, which is why every bank operation
 * used to throw on Windows with an error about a file not being an
 * application.
 *
 * Asked of the path rather than assumed, because the same resolution finds a
 * bank's *embedded* copy — and a bank is free to ship a `.exe`.
 */
export function needsPythonInterpreter(cliPath: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const extension = extname(cliPath).toLowerCase();
  return extension !== '.exe' && extension !== '.cmd' && extension !== '.bat' && extension !== '.com';
}

/**
 * The resolved interpreter, or `null` when the machine has none.
 *
 * Cached for the process's life: this is three spawns of `--version`, and the
 * answer does not change while the app is open. `undefined` means "not yet
 * asked", `null` means "asked, and there is none" — the distinction is what
 * keeps a machine without Python from re-probing on every status read.
 */
let cachedPython: PythonCandidate | null | undefined;

async function probePython(candidate: PythonCandidate): Promise<PythonProbe> {
  try {
    const { stdout, stderr } = await execFileAsync(
      candidate.command,
      [...candidate.args, '--version'],
      { timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1024 },
    );
    return { ok: true, stdout, stderr };
  } catch (error) {
    const raw = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
      stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    };
  }
}

async function resolvePython(): Promise<PythonCandidate | null> {
  if (cachedPython !== undefined) return cachedPython;
  const probes = [];
  for (const candidate of PYTHON_CANDIDATES) {
    // Sequentially, and stopping at the first that answers: the common case is
    // that the first candidate works, and probing all three in parallel would
    // spawn two processes nobody needs on every machine that has Python.
    const probe = await probePython(candidate);
    probes.push({ candidate, probe });
    if (acceptsAsPython3(probe)) break;
  }
  cachedPython = selectPython(probes);
  if (cachedPython !== null) {
    log.info(`Driving the memory-bank CLI with ${[cachedPython.command, ...cachedPython.args].join(' ')}`);
  }
  return cachedPython;
}

/** The error a machine with no interpreter gets, worded so it can be acted on. */
function noPythonError(): WorkspaceError {
  return new WorkspaceError(
    'Python 3 is required for the team memory bank CLI, and this machine has none that answers ' +
      '`--version` (the Microsoft Store stub does not count). Install it from python.org/downloads ' +
      'or with `winget install Python.Python.3.13`, then re-check.',
  );
}

/**
 * How to spawn this CLI: the executable, and whatever has to precede its
 * arguments.
 */
async function spawnPlan(cli: string): Promise<{ command: string; prefix: readonly string[] }> {
  if (!needsPythonInterpreter(cli, process.platform)) return { command: cli, prefix: [] };
  const python = await resolvePython();
  if (python === null) throw noPythonError();
  return { command: python.command, prefix: [...python.args, cli] };
}

/* -------------------------------------------------------------------------- */
/* The one spawn                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What every CLI spawn is told, before anything specific to the call.
 *
 * `ARTEMIS_ROOT` because the CLI's own default is
 * `~/Library/Application Support/Artemis` — the right answer on the machine it
 * was written on and nowhere else. Without it the CLI finds no `profiles.json`
 * off macOS, `doctor` reports "no Artemis profiles" forever, and the pane
 * blocks onboarding on a requirement the user cannot possibly satisfy.
 *
 * `GIT_TERMINAL_PROMPT=0` because everything here runs unattended behind a
 * settings pane. Git's prompt would be written to a console nobody is
 * watching and would hang the spawn until its timeout, turning "this remote
 * needs credentials" — a sentence the pane can act on — into "the CLI did not
 * respond".
 *
 * Exported for the same reason the `parse*` functions are: it is the pure half
 * of a spawn, and asserting that both variables are present is what stops a
 * later edit from quietly dropping the one that un-bricks `doctor`.
 */
export function baseCliEnv(): Record<string, string> {
  return {
    ...(artemisRoot !== null ? { ARTEMIS_ROOT: artemisRoot } : {}),
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Run the CLI and hand back stdout.
 *
 * A non-zero exit becomes a {@link WorkspaceError} carrying the CLI's own
 * words: the bank's validator writes messages meant for people ("possible
 * secret (GitHub token) — memories must never contain credentials"), and a
 * pane that replaced them with "command failed" would be discarding the only
 * part the user needs.
 *
 * `env` is merged over {@link baseCliEnv} and over the inherited environment,
 * and is where a private bank's git credential arrives. It is a parameter of
 * *this* function rather than of each caller's spawn because there is only one
 * spawn: a second one would be a second place for the credential rules to be
 * got right.
 */
async function runCli(
  cli: string,
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { command, prefix } = await spawnPlan(cli);
  try {
    const { stdout } = await execFileAsync(command, [...prefix, ...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, ...baseCliEnv(), ...env },
    });
    return stdout;
  } catch (error) {
    throw toCliError(error, args.find((arg) => !arg.startsWith('-')) ?? 'cerebro', tokensIn(env));
  }
}

/**
 * The literal secrets an environment block carries, so they can be scrubbed
 * back out of anything the child said.
 *
 * Derived from the variable *names* rather than tracked separately, which is
 * what keeps this honest: `gitCredentialEnv` puts the token in
 * `ARTEMIS_GIT_TOKEN[_n]` and nowhere else, so anything matching that name is
 * exactly the set of strings that must not reach the renderer. A future
 * variable carrying a secret has to be named to be spawned, and naming it here
 * is one line.
 */
function tokensIn(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(env)
    .filter(([name, value]) => name.startsWith(GIT_TOKEN_ENV) && value.length > 0)
    .map(([, value]) => value);
}

/**
 * Fold a failed spawn into a message meant for a person.
 *
 * `secrets` are removed from that message before it exists. Git does not print
 * a password it was handed — but this text is assembled from a child process's
 * whole stderr, on a path where the caller has just put a token into that
 * child's environment, and "git is careful" is a property of git rather than
 * of this boundary. The scrub is the boundary's own.
 */
/**
 * What the CLI printed to stdout before it exited non-zero, carried on the
 * error so a caller can still read it.
 *
 * A non-zero exit does not always mean nothing useful was said. `doctor` exits
 * 1 whenever it finds a problem — that is its whole job — and prints its report
 * on stdout on the way out. Without this the report is discarded on exactly the
 * runs it exists to explain, and the pane shows "Memory bank doctor failed" over a
 * perfectly good list of what is wrong.
 */
export const CLI_STDOUT = Symbol('cerebro.stdout');

function toCliError(error: unknown, verb: string, secrets: readonly string[] = []): WorkspaceError {
  const raw = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stdout = typeof raw.stdout === 'string' ? withoutSecrets(raw.stdout, secrets) : null;
  const said = withoutSecrets(
    [raw.stderr, raw.stdout]
      .filter((chunk): chunk is string => typeof chunk === 'string')
      .join('\n')
      .trim(),
    secrets,
  );

  const failure =
    said.length > 0
      ? // The tail, not the head: the CLI states its conclusion last.
        new WorkspaceError(
          `Memory bank ${verb} failed: ${said
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .slice(-3)
            .join(' · ')}`,
        )
      : new WorkspaceError(
          `Memory bank ${verb} failed: ${
            typeof raw.message === 'string'
              ? withoutSecrets(raw.message, secrets)
              : 'the CLI did not respond'
          }`,
        );

  if (stdout !== null) Object.defineProperty(failure, CLI_STDOUT, { value: stdout, enumerable: false });
  return failure;
}

/** The CLI's stdout from a failed run, when it said anything. @see CLI_STDOUT */
export function cliStdoutOf(error: unknown): string | null {
  const carried = (error as Record<symbol, unknown>)?.[CLI_STDOUT];
  return typeof carried === 'string' ? carried : null;
}

/**
 * Replace each known secret with a placeholder, then run the shape-based
 * scrub over what is left.
 *
 * Both halves, because they catch different things: the exact-value pass knows
 * this run's token and nothing else, and `scrubSecrets` knows the shapes of
 * credentials Artemis never held but a git host might have quoted back.
 */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('[redacted]');
  }
  return scrubSecrets(out);
}

/* -------------------------------------------------------------------------- */
/* Pure parsing — the unit under test                                         */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError(`The memory-bank CLI returned unexpected JSON: ${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceError('The memory-bank CLI returned output that is not JSON');
  }
}

/**
 * `status --json` → the protocol's {@link MemoryBanksStatus}.
 *
 * `masterEnabled` is passed in rather than read from the CLI's output because
 * it is not the CLI's to answer: it is Artemis's own record of whether this
 * machine spends run context on the banks. Keeping it a parameter is also
 * what keeps this function pure, which is what makes it the unit under test.
 */
export function parseBanksStatus(
  text: string,
  masterEnabled: boolean,
  cliAvailable: boolean,
): MemoryBanksStatus {
  const data = asRecord(parseJson(text), 'status');
  const rawBanks = Array.isArray(data['banks']) ? data['banks'] : [];
  const rawProfiles = Array.isArray(data['profiles']) ? data['profiles'] : [];

  // Installed-project counts come from the profile scan: entries stamped with
  // a `bank` belong to that slug, unstamped ones to the legacy dir.
  const projectCounts = new Map<string, number>();
  const profiles: MemoryBankProfileState[] = [];
  for (const entry of rawProfiles) {
    const profile = asRecord(entry, 'status.profiles[]');
    const perBank: Record<string, boolean> = {};
    const rawPerBank = profile['banks'];
    if (typeof rawPerBank === 'object' && rawPerBank !== null && !Array.isArray(rawPerBank)) {
      for (const [slug, on] of Object.entries(rawPerBank as Record<string, unknown>)) {
        if (SLUG_PATTERN.test(slug)) perBank[slug] = on === true;
      }
    }
    profiles.push({
      name: stringOr(profile['name'], 'unknown'),
      label: stringOr(profile['label'], ''),
      hook: profile['hook'] === true,
      banks: perBank,
    });
    const installed = profile['projects'];
    if (Array.isArray(installed)) {
      for (const project of installed) {
        if (typeof project !== 'object' || project === null) continue;
        const slug = stringOr((project as Record<string, unknown>)['bank'], LEGACY_SLUG);
        projectCounts.set(slug, (projectCounts.get(slug) ?? 0) + 1);
      }
    }
  }

  const banks: MemoryBankInfo[] = [];
  for (const entry of rawBanks) {
    const bank = asRecord(entry, 'status.banks[]');
    const slug = stringOr(bank['slug'], '');
    if (!SLUG_PATTERN.test(slug)) continue;
    const health = asRecord(bank['bank'] ?? {}, 'status.banks[].bank');
    banks.push({
      slug,
      path: stringOr(bank['path'], ''),
      remote: stringOrNull(bank['remote']),
      role: bank['role'] === 'readonly' ? 'readonly' : 'readwrite',
      enabled: bank['enabled'] === true,
      isDefault: bank['default'] === true,
      exists: bank['exists'] === true,
      source: stringOrNull(bank['source']),
      memories: numberOr(health['memories'], 0),
      mirrored: numberOr(health['mirrored'], 0),
      validationErrors: numberOr(health['errors'], 0),
      projects: projectCounts.get(slug) ?? 0,
    });
  }

  return { cliAvailable, masterEnabled, banks, profiles };
}

/** `list --json` → the protocol's {@link MemoryBankMemory} list, unparseable entries dropped. */
export function parseMemories(text: string): MemoryBankMemory[] {
  const data = parseJson(text);
  if (!Array.isArray(data)) {
    throw new WorkspaceError('The memory-bank CLI returned unexpected JSON: list is not an array');
  }
  const memories: MemoryBankMemory[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    // A file the bank itself could not parse comes back name-less; the pane
    // has nothing to render for it, and `status` already counts it as an error.
    if (typeof item['name'] !== 'string') continue;
    const metadata = asRecord(item['metadata'] ?? {}, 'list[].metadata');
    memories.push({
      name: item['name'],
      type: stringOr(metadata['type'], 'unknown'),
      description: stringOr(item['description'], ''),
      body: stringOr(item['body'], ''),
      added: stringOrNull(metadata['added']),
      author: stringOrNull(metadata['author']),
      org: stringOrNull(item['org']),
      project: stringOrNull(item['project']),
      readonly: item['readonly'] === true,
      file: stringOrNull(item['file']),
    });
  }
  return memories;
}

/**
 * `doctor --json` → the protocol's {@link MemoryBankPreflight}.
 *
 * Rebuilds each check rather than trusting the CLI's shape, and drops an entry
 * whose `state` is not one the protocol names — a future CLI state must not
 * arrive in the renderer as an unhandled string.
 */
export function parseDoctor(text: string): MemoryBankPreflight {
  const data = asRecord(parseJson(text), 'doctor');
  const raw = Array.isArray(data['checks']) ? data['checks'] : [];
  const checks: MemoryBankCheck[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const state = item['state'];
    if (state !== 'ok' && state !== 'warn' && state !== 'fail') continue;
    checks.push({
      id: stringOr(item['id'], 'unknown'),
      label: stringOr(item['label'], 'Check'),
      state,
      detail: stringOr(item['detail'], ''),
      remedy: stringOrNull(item['remedy']),
    });
  }
  return { ready: data['ready'] === true, checks };
}

/* -------------------------------------------------------------------------- */
/* The master switch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Artemis's own answer to "does this machine spend run context on the banks",
 * under `userData`. The file keeps its historical name — it is the same
 * switch, carried over: a machine that said yes to Cerebro has said yes to
 * the banks it registered.
 */
const SWITCH_FILE = 'cerebro.json';

let switchFile: string | null = null;
let cachedEnabled: boolean | null = null;

/**
 * What every spawn is told `ARTEMIS_ROOT` is — Electron's `userData`, which is
 * where `profiles.json` actually lives on this platform. `null` until
 * configured, in which case the variable is simply not set and the CLI falls
 * back to its own default.
 */
let artemisRoot: string | null = null;

/**
 * Where a private bank's git credential is kept.
 *
 * Injected rather than constructed here, for the reason every Electron-shaped
 * thing in Artemis is: `memoryBankSecrets.ts` imports `safeStorage`, and this
 * module is unit-tested in a plain Node process. `null` is a complete state,
 * not a degraded one — a machine whose banks are public or reached over ssh
 * never needs one, and every path below treats an absent store exactly as it
 * treats a bank with no stored token.
 */
let bankSecrets: MemoryBankSecrets | null = null;

/**
 * How to turn a {@link SecretRef} into the token it names.
 *
 * A function rather than an import of `secretManagers.ts`, for
 * {@link bankSecrets}'s reason and one more: that module reads a registry off
 * disk and opens sockets, and this one is unit-tested against canned CLI
 * output in a plain Node process. Injecting the capability keeps the tests
 * honest and keeps the dependency pointing one way.
 *
 * `null` is a complete state. A machine with no key manager configured has no
 * bank on the `ref` variant either, so nothing ever asks.
 */
export type SecretRefResolver = (ref: SecretRef) => Promise<ResolvedSecret>;

let refResolver: SecretRefResolver | null = null;

/**
 * Why each bank's reference last failed to resolve, if it did.
 *
 * Deliberately in memory and deliberately not persisted: this is a *condition*
 * — the vault was sealed, the network was down — and a condition read back
 * from disk at startup would be reported as current when it is history. It is
 * cleared by the next successful resolution and surfaced by
 * {@link readMemoryBanksStatus}, which is where a person looks when a bank has
 * stopped syncing.
 */
const refProblems = new Map<string, string>();

/**
 * Tell this module where Artemis keeps its own state. Called once, at startup.
 *
 * Four facts, one call, because they all come from the same place and are all
 * unknowable to a module that may not import `electron`: where the master
 * switch is written, what the CLI should be told `ARTEMIS_ROOT` is, where to
 * find a bank's stored git credential, and how to resolve one that is held in
 * a key manager instead.
 */
export function configureMemoryBanks(
  userDataDir: string,
  secrets?: MemoryBankSecrets,
  resolveRef?: SecretRefResolver,
): void {
  switchFile = join(userDataDir, SWITCH_FILE);
  artemisRoot = userDataDir;
  bankSecrets = secrets ?? null;
  refResolver = resolveRef ?? null;
  cachedEnabled = null;
}

/**
 * Has the user switched the banks on for Artemis?
 *
 * **Off unless told otherwise**, and that default is the whole point: banks
 * being configured is not consent to spending every run's context describing
 * them. Read on the path of every run, so it is synchronous and cached; the
 * cache is dropped by the one writer below.
 */
export function isMasterEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  if (switchFile === null) return false;

  let enabled = false;
  try {
    const parsed = JSON.parse(readFileSync(switchFile, 'utf8')) as unknown;
    enabled =
      typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['enabled'] === true;
  } catch (error) {
    // ENOENT is the ordinary case — nobody has thrown the switch yet. Anything
    // else is a file we cannot read, which reads as off for the same reason the
    // unconfigured case does.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${switchFile}; treating memory banks as off`, error);
    }
  }
  cachedEnabled = enabled;
  return enabled;
}

function writeSwitch(enabled: boolean): void {
  if (switchFile === null) {
    throw new WorkspaceError('Memory banks are not configured in this process.');
  }
  const body = `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`;
  const tmp = `${switchFile}.tmp`;
  mkdirSync(dirname(switchFile), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, switchFile);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename is what mattered; a stray temp file is not worth a second error.
    }
    throw new WorkspaceError(
      `Could not write ${switchFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  cachedEnabled = enabled;
}

/* -------------------------------------------------------------------------- */
/* Cheap per-run reads — never a spawn                                        */
/* -------------------------------------------------------------------------- */

/**
 * The banks a run should know about: registered, enabled, present on disk.
 *
 * Registry first; a machine with no registry but the legacy clone gets that
 * clone, so pre-multi-bank machines keep working before the one-time
 * registration in {@link readMemoryBanksStatus} has run.
 */
export function banksForRun(): RegistryBank[] {
  return banksOnDisk({ registry: readRegistry(), legacyRoot: legacyRoot() });
}

/** The precondition for `builtin:cerebro`: something to describe, and a CLI to teach. */
export function anyBankAvailable(): boolean {
  if (banksForRun().length === 0) return false;
  try {
    resolveCli();
    return true;
  } catch {
    return false;
  }
}

/**
 * The facts the prompt renderer needs, in composition's pure vocabulary —
 * each bank's slug, role and CLI, and what its own `cerebro.json` says about
 * how it is filed. The vendored CLI is the fallback for a bank that embeds
 * none; core's reader does the rest, so the desktop and the headless server
 * describe a bank identically.
 */
export function promptBanks(): MemoryBankPromptInfo[] {
  return describeBanksForPrompt({
    registry: readRegistry(),
    legacyRoot: legacyRoot(),
    fallbackCli: safeResolveCli(),
  });
}

function safeResolveCli(): string | null {
  try {
    return resolveCli();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

let migrated = false;

/**
 * A pre-multi-bank machine has the clone and the switch but no registry.
 * Register it once, under the legacy slug — a change of description, not of
 * disk: the CLI's legacy slug keeps the exact install namespace those
 * machines already have. `--mode local` on purpose: the clone's origin stays
 * whatever it is, and registration must not touch the network.
 */
async function migrateLegacyBank(): Promise<void> {
  if (migrated) return;
  migrated = true;
  const { banks } = readRegistry();
  if (banks.length > 0) return;
  const root = legacyRoot();
  const cli = embeddedCli(root);
  if (cli === null || !isBank(root)) return;
  try {
    await runCli(cli, ['setup', '--mode', 'local', '--path', root, '--slug', LEGACY_SLUG], 60_000);
    log.info(`Registered the pre-existing bank at ${root} as '${LEGACY_SLUG}'`);
  } catch (error) {
    migrated = false; // Try again next read; registration is idempotent.
    log.warn('Could not register the legacy bank; the pane will show none', error);
  }
}

/** Every bank's condition. `banks: []` is a complete answer, not a fault. */
export async function readMemoryBanksStatus(): Promise<MemoryBanksStatus> {
  await migrateLegacyBank();
  const cliAvailable = safeResolveCli() !== null;
  const { banks } = readRegistry();
  if (banks.length === 0) {
    return { cliAvailable, masterEnabled: isMasterEnabled(), banks: [], profiles: [] };
  }
  const text = await runCli(resolveCli(), ['status', '--json'], 30_000);
  return withCredentialState(parseBanksStatus(text, isMasterEnabled(), cliAvailable));
}

/**
 * Decorate the CLI's answer with what Artemis knows about each bank's
 * credential.
 *
 * Decoration rather than a field `parseBanksStatus` fills in, because that
 * function is pure and is the unit under test: it takes the CLI's JSON as text
 * and answers from it alone. Where a bank's credential comes from is not in
 * that JSON and never will be — the CLI knows nothing about any of this.
 *
 * Never decrypts. `has` answers whether a token is stored, and the *kind* of
 * credential comes from the record's own discriminator, which a reference-held
 * bank carries in clear because a reference is not a secret.
 */
async function withCredentialState(status: MemoryBanksStatus): Promise<MemoryBanksStatus> {
  if (bankSecrets === null) return status;
  const store = bankSecrets;
  const banks: MemoryBankInfo[] = [];
  for (const bank of status.banks) {
    const stored = (await store.has(bank.slug)) ? await store.read(bank.slug) : null;
    const problem = refProblems.get(bank.slug);
    const credential: MemoryBankCredentialState =
      stored === null
        ? { kind: 'none' }
        : stored.kind === 'token'
          ? { kind: 'stored' }
          : { kind: 'ref', ...(problem === undefined ? {} : { problem }) };
    banks.push({ ...bank, credential });
  }
  return { ...status, banks };
}

export async function readMemoryBankMemories(slug: string): Promise<MemoryBankMemory[]> {
  return parseMemories(await runCli(resolveCli(), ['--bank', slug, 'list', '--json'], 15_000));
}

/**
 * What this machine is missing, with the fix for each.
 *
 * `--offline` when no bank is registered yet: the CLI's network probe checks
 * the addressed bank's remote, and with no bank that falls back to the team
 * repository — a check an outside user can only fail. Reachability of a
 * remote they actually join is checked by the join itself.
 */
export async function readMemoryBanksPreflight(): Promise<MemoryBankPreflight> {
  const cli = safeResolveCli();
  if (cli === null) {
    return {
      ready: false,
      checks: [
        {
          id: 'cli',
          label: 'Bank CLI',
          state: 'fail',
          detail: 'no CLI is available on this machine',
          remedy: 'Reinstall Artemis — the CLI ships with it',
        },
      ],
    };
  }
  const { banks } = readRegistry();
  const args = ['doctor', '--json', ...(banks.length === 0 ? ['--offline'] : [])];
  try {
    return parseDoctor(await runCli(cli, args, 60_000));
  } catch (error) {
    /*
     * `doctor` exits 1 whenever it finds a problem, which is the ordinary case
     * on a machine that has not set a bank up yet — so this path is the norm
     * rather than the exception, and the report it carries is exactly what the
     * pane needs to render. It is read off the error rather than the raw
     * execFile rejection because `runCli` has already turned that into a
     * `WorkspaceError`; `CLI_STDOUT` is what survives the wrapping.
     */
    const stdout = cliStdoutOf(error);
    if (stdout !== null && stdout.trim().startsWith('{')) {
      try {
        return parseDoctor(stdout);
      } catch {
        log.warn('cerebro doctor returned output that could not be parsed');
      }
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Credentials for a private bank                                             */
/* -------------------------------------------------------------------------- */

/**
 * A clone's `origin` URL, out of its own `.git/config`.
 *
 * Read rather than asked for, because `git remote get-url` would be a spawn on
 * a path that must not have one — this is called from the background sync,
 * which fires at every run start. Parsed as its own function so the awkward
 * half (git's config grammar) is testable without a repository.
 *
 * A hand-rolled parse of a format git owns, so it is deliberately narrow: the
 * first `url` under `[remote "origin"]`, and nothing else. Anything it fails
 * to understand reads as "no origin", and a bank with no origin is one that
 * syncs without a credential — the same as today.
 */
export function parseGitOrigin(configText: string): string | null {
  let inOrigin = false;
  for (const raw of configText.split('\n')) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section !== null) {
      inOrigin = /^remote\s+"origin"$/.test((section[1] ?? '').trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (url !== null) return url[1]?.trim() ?? null;
  }
  return null;
}

function bankRemote(bankPath: string): string | null {
  try {
    return parseGitOrigin(readFileSync(join(bankPath, '.git', 'config'), 'utf8'));
  } catch {
    // Not a clone, or not readable. Either way there is no remote to scope a
    // credential to.
    return null;
  }
}

/**
 * The git credential for one registered bank, or `null`.
 *
 * The registry and the remote are consulted *before* the store, so a bank
 * whose credential could not be used anyway — unregistered, no origin, an ssh
 * origin — is never decrypted. Cheap questions first is the ordinary way to
 * write this; here it is also the rule that keeps a secret out of memory when
 * nothing was going to use it.
 */
async function credentialFor(slug: string): Promise<ResolvedCredential | null> {
  if (bankSecrets === null) return null;
  const bank = readRegistry().banks.find((entry) => entry.slug === slug);
  if (bank === undefined) return null;
  const remote = bankRemote(bank.path);
  if (remote === null) return null;
  const origin = credentialOrigin(remote);
  if (origin === null) return null;
  const stored = await bankSecrets.read(slug);
  if (stored === null) return null;

  if (stored.kind === 'token') {
    refProblems.delete(slug);
    return {
      credential: { origin, token: stored.token, username: stored.username },
      dispose: () => undefined,
    };
  }
  return resolveBankRef(slug, origin, stored.ref, stored.username);
}

/**
 * Turn a bank's secret reference into a usable git credential — or degrade.
 *
 * **Never throws, and never blocks.** A bank whose manager is unreachable,
 * sealed, or refusing is a bank that does not sync this time round; it is not
 * a failed run, not a dialog, and not something to retry in a loop (the sync
 * throttle stands, and every terminal problem is terminal). The run that
 * happened to trigger the sync has nothing to do with the vault being down.
 *
 * And there is **no fallback to a cached value**. Keeping the last resolved
 * token to use "just this once" would reintroduce exactly the thing a key
 * manager removes: a credential this machine holds after the manager has
 * stopped vouching for it. A bank that cannot resolve is a bank with no
 * credential, which for a private remote means the sync fails and says so.
 *
 * What survives is the *sentence*, recorded per slug, so the pane can tell the
 * three failures apart when a person eventually looks.
 */
async function resolveBankRef(
  slug: string,
  origin: string,
  ref: SecretRef,
  username: string,
): Promise<ResolvedCredential | null> {
  if (refResolver === null) {
    refProblems.set(slug, 'This machine has no key manager configured, so its reference cannot be resolved.');
    return null;
  }
  try {
    const resolved = await refResolver(ref);
    refProblems.delete(slug);
    return {
      credential: { origin, token: resolved.value, username },
      dispose: () => resolved.dispose(),
    };
  } catch (error) {
    const said = scrubSecrets(error instanceof Error ? error.message : String(error));
    refProblems.set(slug, said);
    log.warn(`'${slug}' could not resolve its key-manager reference; it will not sync. ${said}`);
    return null;
  }
}

/**
 * A credential and the end of holding it.
 *
 * The `dispose` half is new with references: a resolved value is registered
 * with the literal-secret scrub for as long as it is live, and the spawn it
 * was resolved for is the whole of that lifetime. A stored token's `dispose`
 * is a no-op, which is the honest answer — it was already on disk.
 */
interface ResolvedCredential {
  readonly credential: GitCredential;
  dispose(): void;
}

/**
 * The environment for a spawn that addresses one bank, or every bank, and the
 * end of the secrets in it.
 *
 * The every-bank case is the background sync's: one CLI pass covers all of
 * them, so all of their origins have to be configured up front. `list()` is
 * asked first and never decrypts, so a machine whose banks are all public
 * pays one file read and no decryption at all.
 *
 * Callers must `dispose` when the spawn is done. That is what ends the scrub
 * registration for anything resolved out of a key manager — see
 * `secretManagers.ts` — and it is why this returns a pair rather than a bare
 * environment block.
 */
async function bankCredentialEnv(slug?: string): Promise<BankEnvironment> {
  const nothing: BankEnvironment = { env: {}, dispose: () => undefined };
  if (bankSecrets === null) return nothing;

  const resolved: ResolvedCredential[] = [];
  if (slug !== undefined) {
    const one = await credentialFor(slug);
    if (one !== null) resolved.push(one);
  } else {
    for (const stored of await bankSecrets.list()) {
      const one = await credentialFor(stored);
      if (one !== null) resolved.push(one);
    }
  }
  if (resolved.length === 0) return nothing;

  return {
    env: gitCredentialsEnv(resolved.map((entry) => entry.credential)),
    dispose: () => {
      for (const entry of resolved) entry.dispose();
    },
  };
}

/** An environment block and the end of the secrets in it. @see bankCredentialEnv */
interface BankEnvironment {
  readonly env: GitCredentialEnv;
  dispose(): void;
}

/**
 * The credential a join was asked to use, before the bank it belongs to exists.
 *
 * The one place the origin cannot come from a clone's config, because there is
 * no clone yet — it comes from the URL the user typed, which is also the URL
 * about to be cloned.
 *
 * A token offered for a remote that cannot carry one is refused rather than
 * dropped. Silently ignoring it would produce the worst version of this
 * failure: a clone that prompts for an ssh key it does not have, while the
 * pane shows a token the user is sure they supplied.
 *
 * A *reference* is resolved here and now, and its failure **is** fatal to the
 * join — the opposite of {@link resolveBankRef}'s rule, and deliberately so. A
 * join is a person pressing a button and watching; a sync is a background pass
 * nobody asked for. Degrading in front of the watching person would clone a
 * private repository with no credential and report git's own confusion instead
 * of "your vault is sealed".
 */
async function requestedCredential(request: MemoryBankAddRequest): Promise<ResolvedCredential | null> {
  const auth = request.auth;
  if (auth === undefined) return null;
  if (auth.ref === undefined && (auth.token === undefined || auth.token.length === 0)) return null;

  const remote = request.remote ?? '';
  const origin = credentialOrigin(remote);
  if (origin === null) {
    throw new WorkspaceError(
      'An access token can only be used with an https:// remote. This remote is reached another ' +
        'way (ssh, for instance), which authenticates with a key rather than a token — join it ' +
        'without a token, or use the repository’s https:// URL.',
    );
  }
  const username = auth.username ?? DEFAULT_GIT_USERNAME;
  if (auth.ref !== undefined) {
    if (refResolver === null) {
      throw new WorkspaceError(
        'This process cannot reach the key managers, so a stored reference cannot be resolved. ' +
          'Report this — it means the secret managers were not configured at startup.',
      );
    }
    const resolved = await refResolver(auth.ref);
    return {
      credential: { origin, token: resolved.value, username },
      dispose: () => resolved.dispose(),
    };
  }
  return {
    credential: { origin, token: auth.token ?? '', username },
    dispose: () => undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Verifying a remote, before anything is cloned                              */
/* -------------------------------------------------------------------------- */

/** How long a reachability probe is worth waiting for, with a person watching. */
const VERIFY_TIMEOUT_MS = 15_000;

/** What running `git ls-remote` came to, before it is interpreted. */
export interface LsRemoteResult {
  /** `null` when the process was killed rather than exiting on its own. */
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Patterns, in the order they are asked.
 *
 * Order is the whole design here. GitHub answers an unreadable private
 * repository with `The requested URL returned error: 403`, which matches both
 * "unable to access" and an authentication shape; Forgejo answers a wrong
 * token with `unable to access … Authentication failed`. Asking "is this
 * about credentials?" before "is this about the network?" is what keeps a
 * missing token from being reported as an outage — the failure that sends a
 * user to check their wifi while the pane holds the remedy.
 */
const VERIFY_PATTERNS: readonly { readonly outcome: MemoryBankVerifyOutcome; readonly pattern: RegExp }[] = [
  { outcome: 'auth-required', pattern: /authentication failed/i },
  { outcome: 'auth-required', pattern: /could not read (username|password)/i },
  { outcome: 'auth-required', pattern: /terminal prompts disabled/i },
  { outcome: 'auth-required', pattern: /\b(401|403)\b/ },
  { outcome: 'auth-required', pattern: /unauthorized|access denied|permission denied/i },
  { outcome: 'auth-required', pattern: /invalid (username or )?(password|token|credentials)/i },
  { outcome: 'not-found', pattern: /repository not found/i },
  { outcome: 'not-found', pattern: /\b404\b/ },
  { outcome: 'not-found', pattern: /not found|does not exist/i },
  { outcome: 'not-found', pattern: /does not appear to be a git repository/i },
  { outcome: 'unreachable', pattern: /could not resolve (host|proxy)/i },
  { outcome: 'unreachable', pattern: /couldn'?t connect|failed to connect|connection (refused|timed out|reset)/i },
  { outcome: 'unreachable', pattern: /network is unreachable|operation timed out|no route to host/i },
  { outcome: 'unreachable', pattern: /ssl|certificate/i },
];

/**
 * Turn one `git ls-remote` into an answer the pane can render.
 *
 * Pure, and the unit under test against canned stderr from the hosts this
 * actually meets. The interesting case is the one that looks like a failure
 * and is not: `--exit-code` makes git exit 2 when no ref matched, which for
 * `HEAD` means **the repository is readable and empty**. That is a perfectly
 * good bank to join — it is what a team's second machine sees on the day the
 * bank is created — and reporting it as an error would block the join with an
 * accurate-sounding sentence about a repository that is fine.
 */
export function categorizeLsRemote(result: LsRemoteResult): MemoryBankVerifyRemoteResponse {
  if (result.timedOut) {
    return {
      outcome: 'unreachable',
      headPresent: false,
      detail: `the remote did not answer within ${VERIFY_TIMEOUT_MS / 1000} seconds`,
    };
  }

  const said = `${result.stderr}\n${result.stdout}`;
  const fatal = /^fatal:|^error:/im.test(result.stderr);

  if (result.code === 0) {
    const head = /^([0-9a-f]{7,40})\s+HEAD/im.exec(result.stdout);
    return {
      outcome: 'ok',
      headPresent: head !== null,
      detail: head === null ? 'the remote answered' : `HEAD is ${(head[1] ?? '').slice(0, 8)}`,
    };
  }

  // Exit 2 with nothing fatal on stderr: git read the remote and found no
  // matching ref. See the doc comment — an empty repository, not a failure.
  if (result.code === 2 && !fatal) {
    return {
      outcome: 'ok',
      headPresent: false,
      detail: 'readable, and empty — joining it starts the bank',
    };
  }

  const detail = lastLine(result.stderr) || lastLine(result.stdout) || 'git gave no reason';
  for (const { outcome, pattern } of VERIFY_PATTERNS) {
    if (pattern.test(said)) return { outcome, headPresent: false, detail };
  }
  // Anything git failed at that names none of the shapes above. `unreachable`
  // rather than a sixth category, because the remedy the pane offers for it —
  // read what git said, and try again — is the right one for an unknown
  // failure too.
  return { outcome: 'unreachable', headPresent: false, detail };
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return (lines.at(-1) ?? '').trim().slice(0, 240);
}

/**
 * Can this machine read that remote, with those credentials?
 *
 * One `git ls-remote`, spawned directly rather than through the banks' CLI:
 * see `IPC.memoryBanksVerifyRemote` for why a question asked before any bank
 * exists should not depend on a Python interpreter.
 *
 * The token supplied for the probe is not stored. Verifying is a question,
 * and a question that quietly wrote a credential to disk would be a different
 * feature; the token is stored when a bank is actually joined with it.
 *
 * A *reference* is resolved for the probe and disposed the moment it is over —
 * which is the honest version of the same rule: the value is borrowed for one
 * `ls-remote` and this machine keeps neither the value nor a note that it
 * worked. A resolution that fails is reported as an `auth-required` outcome
 * rather than thrown, because from the user's side that is what it is: the
 * remote needs a credential and this one could not be produced.
 */
export async function verifyMemoryBankRemote(
  request: MemoryBankVerifyRemoteRequest,
): Promise<MemoryBankVerifyRemoteResponse> {
  const remote = request.remote.trim();
  const auth = request.auth;
  let env: GitCredentialEnv = {};
  let release: () => void = () => undefined;

  if (auth !== undefined && (auth.ref !== undefined || (auth.token ?? '').length > 0)) {
    const origin = credentialOrigin(remote);
    if (origin === null) {
      return {
        outcome: 'invalid-url',
        headPresent: false,
        detail:
          'an access token needs an https:// URL — this one is reached another way, which ' +
          'authenticates with a key instead',
      };
    }
    const username = auth.username ?? DEFAULT_GIT_USERNAME;
    if (auth.ref !== undefined) {
      if (refResolver === null) {
        return {
          outcome: 'auth-required',
          headPresent: false,
          detail: 'this process cannot reach the key managers, so the reference could not be resolved',
        };
      }
      try {
        const resolved = await refResolver(auth.ref);
        release = () => resolved.dispose();
        env = gitCredentialEnv({ origin, token: resolved.value, username });
      } catch (error) {
        return {
          outcome: 'auth-required',
          headPresent: false,
          detail: scrubSecrets(error instanceof Error ? error.message : String(error)),
        };
      }
    } else {
      env = gitCredentialEnv({ origin, token: auth.token ?? '', username });
    }
  }

  const secrets = tokensIn(env);
  try {
    return await probeRemote(remote, env, secrets);
  } finally {
    // The borrowed value's lifetime ends with the probe, whichever way the
    // probe went. See this function's comment.
    release();
  }
}

/**
 * One `git ls-remote`, categorised.
 *
 * Split out of {@link verifyMemoryBankRemote} so that its caller's `finally`
 * has one statement to guard rather than a forty-line body — the disposal is
 * the thing that must not be skipped, and burying it under the error mapping
 * is how it stops happening on the path nobody tests.
 */
async function probeRemote(
  remote: string,
  env: GitCredentialEnv,
  secrets: readonly string[],
): Promise<MemoryBankVerifyRemoteResponse> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['ls-remote', '--exit-code', remote, 'HEAD'], {
      timeout: VERIFY_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return scrubVerify(categorizeLsRemote({ code: 0, timedOut: false, stdout, stderr }), secrets);
  } catch (error) {
    const raw = error as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    // `code` is the exit status for a process that ran, and an errno string
    // (`ENOENT`) for one that never started. The second means git is not
    // installed, which is a machine fact rather than a fact about the remote.
    if (typeof raw.code === 'string') {
      return {
        outcome: 'unreachable',
        headPresent: false,
        detail:
          raw.code === 'ENOENT'
            ? 'git is not installed on this machine, so no remote can be checked'
            : `git could not be run: ${raw.code}`,
      };
    }
    return scrubVerify(
      categorizeLsRemote({
        code: typeof raw.code === 'number' ? raw.code : null,
        timedOut: raw.killed === true || typeof raw.signal === 'string',
        stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
        stderr:
          typeof raw.stderr === 'string' && raw.stderr.length > 0
            ? raw.stderr
            : typeof raw.message === 'string'
              ? raw.message
              : '',
      }),
      secrets,
    );
  }
}

/**
 * The last gate before a verify result becomes a response.
 *
 * `detail` is assembled from a child's stderr on the one path in Artemis where
 * a token was just put into that child's environment. Nothing observed says
 * git echoes it — and this scrub is what makes that a claim the boundary does
 * not have to rely on.
 */
function scrubVerify(
  response: MemoryBankVerifyRemoteResponse,
  secrets: readonly string[],
): MemoryBankVerifyRemoteResponse {
  return { ...response, detail: withoutSecrets(response.detail, secrets) };
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Join, create, or adopt a bank — then wire it and sync it once.
 *
 * Adding the first bank also throws the master switch: onboarding *is* the
 * yes, exactly as single-bank setup was. Adding a later bank leaves the
 * master alone — its state is a decision the user already made.
 */
export async function addMemoryBank(request: MemoryBankAddRequest): Promise<MemoryBankActionResponse> {
  const path = request.path ?? join(homedir(), 'Documents', request.slug);
  if (request.mode === 'adopt' && !isBank(path)) {
    throw new WorkspaceError(
      `${path} is not a bank — it has no memories/ directory and declares no projects layout in a cerebro.json. Use "create" to start one there.`,
    );
  }
  if (request.mode === 'join' && (request.remote === undefined || request.remote.length === 0)) {
    throw new WorkspaceError('Joining a bank needs its remote URL.');
  }

  const hadBanks = readRegistry().banks.length > 0;
  const steps: string[] = [];
  const setupArgs =
    request.mode === 'join'
      ? ['setup', '--mode', 'remote', '--remote', request.remote ?? '', '--path', path]
      : ['setup', '--mode', 'local', '--path', path];
  setupArgs.push('--slug', request.slug, '--role', request.role);

  // Composed once and used by all three spawns below. `enable` and the first
  // `sync` reach the remote too — a bank whose credential arrived only in time
  // for the clone would join successfully and then fail on its own first sync,
  // which is the confusing half of a two-step failure.
  //
  // Disposed in a `finally`, because a value resolved out of a key manager is
  // registered with the literal-secret scrub until it is: a join that threw
  // partway through would otherwise leave this process scrubbing a string
  // nothing is using any more.
  const resolved = await requestedCredential(request);
  const credentialEnv = resolved === null ? {} : gitCredentialEnv(resolved.credential);
  try {
    // The bootstrap CLI does the registration; the bank's own copy (cloned or
    // freshly embedded) takes over from the next call on.
    await runCli(resolveCli(), setupArgs, request.mode === 'join' ? 300_000 : 60_000, credentialEnv);
    steps.push(
      request.mode === 'join'
        ? `Joined ${request.remote ?? ''} at ${path} as '${request.slug}'.`
        : request.mode === 'create'
          ? `Created a bank at ${path} as '${request.slug}'.`
          : `Adopted the bank at ${path} as '${request.slug}'.`,
    );

    // Stored here rather than at the end, because *this* is the step that
    // proved the credential works. A wiring or sync failure after a successful
    // clone leaves a real bank on disk that the user will retry; one that had
    // forgotten its credential would retry into an authentication error.
    //
    // What is stored is the *request's* answer, not the resolved value: a bank
    // joined with a reference records the reference, so nothing secret lands
    // on this machine at all and every later sync asks the manager afresh.
    if (request.auth !== undefined && resolved !== null) {
      await storeCredential(
        request.slug,
        request.auth,
        resolved.credential.username ?? DEFAULT_GIT_USERNAME,
      );
      steps.push(
        request.auth.ref === undefined
          ? 'Its access token is stored encrypted, so background syncs keep working.'
          : 'It remembers where the token lives rather than the token, so rotating it in the key manager is enough.',
      );
    }

    await runCli(resolveCli(path), ['--bank', request.slug, 'enable'], 60_000, credentialEnv);
    steps.push('Wired every profile (managed block, /cerebro command, session-start sync hook).');

    const synced = (
      await runCli(resolveCli(path), ['--bank', request.slug, 'sync', '--force'], 180_000, credentialEnv)
    ).trim();
    steps.push(synced.length > 0 ? synced : 'Installed into project memory.');
  } finally {
    resolved?.dispose();
  }

  if (!hadBanks && !isMasterEnabled()) {
    writeSwitch(true);
    steps.push('Memory banks are on for Artemis.');
  }
  return { message: steps.join(' ') };
}

/**
 * Store one bank's credential, failing the whole action if it cannot be
 * stored.
 *
 * Loud rather than best-effort, following `profileSecrets.ts`: a join that
 * reported success while quietly discarding the token would leave the user
 * with a bank that works exactly once — until the window closes and the next
 * background sync meets a private remote with nothing to present.
 */
async function storeCredential(
  slug: string,
  auth: MemoryBankAuthInput,
  username: string,
): Promise<void> {
  if (bankSecrets === null) {
    throw new WorkspaceError(
      'This process cannot store an access token, so the bank would stop syncing when Artemis ' +
        'restarts. Join it without a token, or report this — it means memory banks were not ' +
        'configured at startup.',
    );
  }
  // The *request's* answer, not the resolved value. A bank joined with a
  // reference stores the reference and nothing else — which is the whole
  // arrangement: no secret lands on this machine, and a token rotated in the
  // manager is picked up by the next sync without anyone touching Artemis.
  //
  // The username is resolved rather than carried through as optional: what is
  // stored is what git will be presented with on every later sync, and
  // "whatever the default was on the day it was joined" is not a thing to
  // record.
  const record: MemoryBankCredential =
    auth.ref === undefined
      ? { kind: 'token', token: auth.token ?? '', username }
      : { kind: 'ref', ref: auth.ref, username };
  try {
    await bankSecrets.write(slug, record);
  } catch (error) {
    throw new WorkspaceError(
      `The bank was set up, but its access token could not be stored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Wire one bank on or off — the CLI records the flag and moves the blocks. */
export async function setMemoryBankEnabled(
  request: MemoryBankSetEnabledRequest,
): Promise<MemoryBankActionResponse> {
  if (request.enabled) {
    const credentials = await bankCredentialEnv(request.slug);
    try {
      await runCli(resolveCli(), ['--bank', request.slug, 'enable'], 60_000, credentials.env);
      const synced = (
        await runCli(resolveCli(), ['--bank', request.slug, 'sync', '--force'], 180_000, credentials.env)
      ).trim();
      return {
        message: `'${request.slug}' is on. ${synced.length > 0 ? synced : 'Installed into project memory.'}`,
      };
    } finally {
      credentials.dispose();
    }
  }
  await runCli(resolveCli(), ['--bank', request.slug, 'disable'], 60_000);
  return {
    message: `'${request.slug}' is off — its profile block is out, and syncs skip it. Its installed memories stay until you forget the bank.`,
  };
}

/** Artemis's gate alone: no CLI call, no machine rewiring. */
export function setMasterEnabled(
  request: MemoryBanksSetMasterEnabledRequest,
): MemoryBankActionResponse {
  writeSwitch(request.enabled);
  if (request.enabled) {
    syncMemoryBanksInBackground();
    return {
      message:
        'Memory banks are on for Artemis: runs sync them at start and agents are briefed about them. Per-bank wiring is unchanged.',
    };
  }
  return {
    message:
      'Memory banks are off for Artemis: no run-start syncs, no prompt. The machine wiring (hooks, blocks) stays as the per-bank switches left it.',
  };
}

export async function syncMemoryBank(request: MemoryBankSyncRequest): Promise<MemoryBankActionResponse> {
  const args = request.slug !== undefined ? ['--bank', request.slug] : [];
  const credentials = await bankCredentialEnv(request.slug);
  try {
    const output = (
      await runCli(resolveCli(), [...args, 'sync', '--force'], 180_000, credentials.env)
    ).trim();
    return { message: output.length > 0 ? output : 'Already up to date.' };
  } finally {
    credentials.dispose();
  }
}

/**
 * Retirement reaches the remote — with a remote configured it opens a pull
 * request — so it carries the bank's credential like any other write.
 */
export async function retireMemoryBankMemory(
  request: MemoryBankRetireRequest,
): Promise<MemoryBankActionResponse> {
  const args = ['--bank', request.slug, 'retire', request.name];
  if (request.reason !== undefined) args.push('--reason', request.reason);
  const credentials = await bankCredentialEnv(request.slug);
  try {
    const output = (await runCli(resolveCli(), args, 120_000, credentials.env)).trim();
    return { message: output.length > 0 ? output : `Retired ${request.name}.` };
  } finally {
    credentials.dispose();
  }
}

/**
 * Unwire, uninstall, forget — in that order, because the middle step needs
 * the registry entry the last one removes. The repository stays on disk:
 * deleting a git repo is not something this channel can be aimed at.
 */
export async function forgetMemoryBank(request: MemoryBankForgetRequest): Promise<MemoryBankActionResponse> {
  const cli = resolveCli();
  const steps: string[] = [];
  // Resolved before the registry entry goes, because that entry is how the
  // bank's origin is found — and after `forget` there is nothing left to scope
  // a credential to.
  const credentials = await bankCredentialEnv(request.slug);
  try {
    await runCli(cli, ['--bank', request.slug, 'disable'], 60_000, credentials.env);
  } finally {
    credentials.dispose();
  }
  steps.push(`Unwired '${request.slug}' from every profile.`);
  try {
    await runCli(cli, ['--bank', request.slug, 'uninstall', '--all-projects'], 120_000);
    steps.push('Removed its installed memories from project memory.');
  } catch (error) {
    // Uninstall failing (a project dir gone read-only, say) should not leave
    // the bank half-forgotten and still registered.
    log.warn(`uninstall for '${request.slug}' did not complete`, error);
    steps.push('Some installed copies may remain; they are inert without the registry entry.');
  }
  const output = (await runCli(cli, ['forget', request.slug], 30_000)).trim();
  steps.push(output.length > 0 ? output.split('\n')[0]! : `Forgot '${request.slug}'.`);

  // The credential last, and unconditionally: a bank Artemis no longer knows
  // about must not leave an encrypted token behind for a slug nothing will
  // ever resolve again. Best-effort on purpose — the bank *is* forgotten by
  // this point, and failing the action now would report the opposite.
  if (bankSecrets !== null) {
    try {
      await bankSecrets.clear(request.slug);
    } catch (error) {
      log.warn(`Could not delete the stored access token for '${request.slug}'`, error);
    }
  }
  return { message: steps.join(' ') };
}

/* -------------------------------------------------------------------------- */
/* Keeping the banks turning                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How long a sync stands for. The CLI throttles the expensive half itself (a
 * lock directory per bank, a fifteen-minute fetch stamp, and a no-op when
 * `HEAD` has not moved), so this exists only to keep a burst of runs from
 * paying the process spawn several times over.
 */
const SYNC_THROTTLE_MS = 60_000;

let lastSyncAt = 0;
/** The working directory the last sync was told about. See {@link syncDue}. */
let lastSyncCwd: string | undefined;
let syncInFlight = false;
/** A directory that asked while a sync was running, owed a sync of its own. */
let pendingCwd: string | undefined;

/**
 * Is a sync worth spawning for this run?
 *
 * The throttle exists to stop a burst of runs paying the spawn several times
 * over — and a burst is usually several runs in the *same* project. A run in a
 * project the last sync did not know about is the case the throttle must not
 * swallow: its first session is exactly when the bank has to be installed for
 * it, and waiting a minute means starting without the team's memory. So the
 * throttle is per directory: the same directory within the window is skipped,
 * a different one goes through.
 *
 * Pure, so the rule is the unit under test rather than the timers around it.
 */
export function syncDue(
  state: { readonly lastSyncAt: number; readonly lastSyncCwd?: string },
  cwd: string | undefined,
  now: number,
): boolean {
  if (now - state.lastSyncAt >= SYNC_THROTTLE_MS) return true;
  return cwd !== undefined && cwd !== state.lastSyncCwd;
}

/**
 * Run the banks' own sync cycle, in the background, at most once a minute.
 *
 * ## Why the main process does this
 *
 * `enable` installs a `SessionStart` hook into each profile's `settings.json`,
 * and on a stock Claude Code that is the whole mechanism. Under Artemis that
 * hook never fires: every query runs with `settingSources: []` — the
 * deliberate isolation described in the Claude adapter — and a hook Artemis
 * never loads is a hook that never runs. So the sync moves to the side of the
 * boundary that provisioned it: Artemis wires the banks and shows the pane;
 * running the cycle is its own housekeeping, not an instruction for the model
 * to carry. One spawn covers every enabled bank — the CLI iterates them.
 *
 * ## Why a run is the trigger
 *
 * A run start is Artemis's nearest thing to the `SessionStart` the banks were
 * written against, and it is the moment freshness actually matters: a sync
 * promotes what the last session drafted and pulls what teammates landed, and
 * both are only interesting to a session that is about to begin.
 *
 * Fire-and-forget, and silent unless it fails. A run must never wait on a
 * memory bank, and must never fail because of one.
 *
 * ## Why the run's directory goes along
 *
 * The CLI's cycle has a cheap path for a bank whose `HEAD` has not moved: it
 * checks that *the current project* has the bank installed and installs it
 * there if not. "The current project" was the CLI's own working directory —
 * which, spawned from here, is the app's install folder — so a project opened
 * for the first time got nothing until the next bank commit happened to
 * trigger the every-project install. `CEREBRO_PROJECT` names the run's
 * directory instead. An environment variable rather than a flag on purpose: a
 * bank's embedded CLI may predate this build, and an unknown flag would fail
 * every sync on that machine, where an unknown variable is simply ignored.
 */
export function syncMemoryBanksInBackground(cwd?: string): void {
  if (syncInFlight) {
    // Owed, not dropped: a project that opened while another's sync was
    // running still needs its install, and the throttle below would otherwise
    // hold it for a minute. Runs once more when the current sync ends.
    if (cwd !== undefined && cwd !== lastSyncCwd) pendingCwd = cwd;
    return;
  }
  // The switch before the disk checks, because it is the cheaper question and
  // the more important one: a machine that has banks configured but has not
  // said yes must not have drafts promoted or remotes written to by the mere
  // act of starting a run.
  if (!isMasterEnabled()) return;
  if (banksForRun().length === 0) return;
  const cli = safeResolveCli();
  if (cli === null) return;

  const now = Date.now();
  if (!syncDue({ lastSyncAt, lastSyncCwd }, cwd, now)) return;
  lastSyncAt = now;
  lastSyncCwd = cwd;
  syncInFlight = true;

  // 180s: a sync that has to fetch is bounded by the network once per bank,
  // and the CLI's own locks mean a slow one cannot overlap the next.
  //
  // Every private bank's credential goes in, because one spawn covers every
  // enabled bank — see `bankCredentialEnv`. A machine with none composes an
  // empty block and spawns exactly what it spawned before any of this existed.
  //
  // A bank whose key-manager reference will not resolve is simply not in the
  // block: `credentialFor` degrades rather than throws, so the other banks
  // still sync and the one that could not says why in the pane. There is no
  // retry here beyond the throttle above — a sealed vault does not become
  // unsealed by being asked twice in a minute.
  void bankCredentialEnv()
    .then(async (credentials) => {
      try {
        return await runCli(cli, ['sync', '--quiet'], 180_000, {
          ...credentials.env,
          ...(cwd === undefined ? {} : { CEREBRO_PROJECT: cwd }),
        });
      } finally {
        credentials.dispose();
      }
    })
    .then((output) => {
      const said = output.trim();
      if (said.length > 0) log.info(`memory-banks sync: ${said}`);
    })
    .catch((error: unknown) => {
      // Warn rather than throw. A bank that cannot sync — no network, a clone
      // mid-rebase, a validator refusing a queued draft — is a degraded
      // enhancement, and the run it rode in on has nothing to do with it.
      log.warn('memory-banks sync did not complete; a bank may be stale', error);
    })
    .finally(() => {
      syncInFlight = false;
      const next = pendingCwd;
      pendingCwd = undefined;
      if (next !== undefined && next !== lastSyncCwd) syncMemoryBanksInBackground(next);
    });
}
