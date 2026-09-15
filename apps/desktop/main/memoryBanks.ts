/**
 * Memory banks, from the main process's side.
 *
 * A machine can carry several git-backed, agent-maintained banks: the team's
 * shared one, a personal local-only one, a client project's, one it only
 * reads. What changed is who reads them. **Core does.** `readBankAt` knows all
 * three formats, `installBank` writes a project's copies and the block in its
 * memory file, `describeBanksForRun` says what a run is told, and none of it
 * spawns — so status, the memory browser, the prompt and the run-start install
 * are file reads on a machine that need not have Python at all. This module is
 * the host around that: it owns the locations, composes the environment, and
 * turns each channel into a call on core.
 *
 * The `cerebro` CLI is no longer the contract. It is still resolved and still
 * driven, for the three things core does not do yet: retiring a memory,
 * promoting a legacy bank's queued drafts, and stripping stock Claude Code's
 * own wiring when a bank is forgotten. Each of those is best-effort and named
 * as such; none of them is on the path of a run.
 *
 * Three decisions carry over unchanged.
 *
 * **Main owns the locations.** The renderer never names a binary or an
 * arbitrary path. Banks come from Artemis's own registry —
 * `<userData>/memory-banks.json`, through core's `registryV2`, which keeps the
 * CLI's `~/.config/cerebro/config.json` mirrored in both directions so a
 * machine that also runs stock Claude Code keeps working — and nothing runs
 * that is not a `cerebro` CLI this module resolved itself. That is the rule the
 * terminal keeps ("main chooses the shell"), applied to a subprocess that can
 * write.
 *
 * **The pure half is split from the spawning half**, `shellPath.ts`-style: the
 * decisions here (what a bank's condition is, whether a profile carries a
 * hook, whether a pull is due) are functions over values and are the unit under
 * test in `memoryBanks.test.ts`. They rebuild rather than pass through — only
 * the fields the protocol names cross into a response.
 *
 * **The environment is composed here, once.** There are exactly two spawn
 * choke points — `runCli` and `runGit` — and each composes the whole
 * environment for its child, because "every call except that one" is how an
 * environment invariant stops being one. Both forbid git from opening a
 * terminal prompt behind a window nobody is watching, both take a private
 * bank's credential through `gitCredentialEnv.ts`, and both scrub whatever the
 * child said of the tokens they handed it. `runCli` adds the CLI's own needs:
 * `ARTEMIS_ROOT`, and an interpreter in front of the script, because the CLI
 * is a Python file with a shebang and on Windows that is not something a
 * process can execute.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  BANK_MANIFEST_FILE,
  bankManifestTemplate,
  beginMarker,
  describeBanksForRun,
  detectBankFormat,
  embeddedCli,
  isInstalled,
  LEGACY_BANK_SLUG,
  legacyBankRoot,
  profileProjectKeys,
  projectMemoryDir,
  pullBank,
  readBankAt,
  readProfileDirs,
  readRegistryV2,
  reconcileBankInstalls,
  registryPath,
  scopeCoversProfile,
  sharedIndexBudget,
  sourceStamp,
  uninstallBankEverywhere,
  withBank,
  withoutBank,
  writeRegistryV2,
  type ArtemisProfileDir,
  type Bank,
  type BankRecord,
  type BankRegistryV2,
  type InstallEverywhereReport,
  type MemoryBankCredential,
  type MemoryBankSecrets,
  type ReadRegistryV2Options,
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
  MemoryBankSetProfilesRequest,
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

/**
 * Where the single-bank era put the team bank. Still honoured: a machine that
 * cloned it before banks were plural gets it registered on the first status
 * read, under the legacy slug, without anything moving on disk.
 */
export function legacyRoot(): string {
  return legacyBankRoot();
}

/*
 * Artemis's registry and each bank's own files are read by core — the headless
 * server reads the same shapes the same way, and one reader is how the two
 * hosts stay in agreement about what a bank is. Re-exported so this module
 * keeps its public surface: the CLI's registry parser and its location are
 * still part of it, because the CLI's file is still mirrored on every write
 * and is still what a hand-run `cerebro setup` edits.
 */
export { parseRegistry, registryPath } from '@rx-artemis/core';
export type { BankRecord, RegistryBank } from '@rx-artemis/core';

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
 * all — which is now an ordinary state rather than a broken install: every
 * path that reads, installs or describes a bank goes through core, and the
 * three callers that still need the CLI ask through {@link safeResolveCli} and
 * degrade when it answers `null`.
 */
function resolveCli(bankPath?: string): string {
  if (bankPath !== undefined) {
    const own = embeddedCli(bankPath);
    if (own !== null) return own;
  }
  const { banks, defaultSlug } = readBanks();
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
/* The CLI spawn, for the three things core does not do                       */
/* -------------------------------------------------------------------------- */

/**
 * What every CLI spawn is told, before anything specific to the call.
 *
 * `ARTEMIS_ROOT` because the CLI's own default is
 * `~/Library/Application Support/Artemis` — the right answer on the machine it
 * was written on and nowhere else. Without it the CLI finds no `profiles.json`
 * off macOS and every verb that touches a profile silently addresses a
 * directory that does not exist.
 *
 * `GIT_TERMINAL_PROMPT=0` because everything here runs unattended behind a
 * settings pane. Git's prompt would be written to a console nobody is
 * watching and would hang the spawn until its timeout, turning "this remote
 * needs credentials" — a sentence the pane can act on — into "the CLI did not
 * respond".
 *
 * Exported because it is the pure half of a spawn, and asserting that both
 * variables are present is what stops a later edit from quietly dropping one.
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
function toCliError(error: unknown, verb: string, secrets: readonly string[] = []): WorkspaceError {
  const raw = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const said = withoutSecrets(
    [raw.stderr, raw.stdout]
      .filter((chunk): chunk is string => typeof chunk === 'string')
      .join('\n')
      .trim(),
    secrets,
  );

  return said.length > 0
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
/* Pure decisions — the unit under test                                       */
/* -------------------------------------------------------------------------- */

/**
 * How many of a bank's problems reach the pane.
 *
 * A bank whose every file fails one rule would otherwise hand the renderer a
 * list as long as the bank. The count is already exact in
 * {@link MemoryBankInfo.validationErrors}; these are the examples that make it
 * actionable.
 */
const MAX_REPORTED_PROBLEMS = 12;

/**
 * One bank's condition, from Artemis's record of it and core's reading of the
 * directory.
 *
 * Pure — everything that touched the disk (the read, the origin, the install
 * scan) is a parameter — which is what makes the interesting cases testable:
 * a path that is no longer a bank (`format: null`, `exists: false`, and a
 * registry entry that still names it), and a bank whose files carry problems.
 *
 * `mirrored` is zero and stays zero. It counted a cortex-era mirror tree the
 * CLI reported separately; core's reader has no such concept — a bank declares
 * its memory globs and everything they match is a memory — and the field
 * remains only because the protocol names it.
 */
export function bankInfoFrom(
  record: BankRecord,
  bank: Bank | null,
  facts: {
    readonly isDefault: boolean;
    readonly remote: string | null;
    readonly source: string | null;
    readonly projects: number;
  },
): MemoryBankInfo {
  const entries = bank?.entries ?? [];
  const problems = [
    ...(bank?.problems ?? []),
    ...entries.flatMap((entry) => entry.problems.map((problem) => `${entry.file}: ${problem}`)),
  ];
  return {
    slug: record.slug,
    name: bank?.name ?? record.slug,
    description: bank?.description ?? null,
    format: bank?.format ?? null,
    profiles: record.profiles,
    problems: problems.slice(0, MAX_REPORTED_PROBLEMS),
    path: record.path,
    remote: facts.remote,
    role: record.role,
    enabled: record.enabled,
    isDefault: facts.isDefault,
    exists: bank !== null,
    source: facts.source,
    memories: entries.length,
    mirrored: 0,
    validationErrors: entries.filter((entry) => entry.problems.length > 0).length,
    projects: facts.projects,
  };
}

/**
 * Does this profile's `settings.json` carry the banks' session-start hook?
 *
 * Stock Claude Code's own path: `cerebro enable` writes a `SessionStart` hook
 * that runs a sync, and a profile that has it keeps syncing when it is driven
 * outside Artemis. Artemis never fires it (every run uses `settingSources: []`
 * — see `syncMemoryBanksInBackground`), so this is reported rather than relied
 * on.
 *
 * Read by shape rather than by path: the hook's command has been a shim, an
 * absolute path to a bank's own copy, and `python … bin/cerebro` on Windows,
 * and all three are the same hook. Anything that names the CLI and syncs
 * counts; the settings file's own grammar (matchers, nested `hooks` arrays) is
 * walked rather than assumed.
 */
export function hasSessionStartSyncHook(settingsText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText.replace(/^﻿/, ''));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const hooks = (parsed as Record<string, unknown>)['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return false;
  const sessionStart = (hooks as Record<string, unknown>)['SessionStart'];
  return commandsIn(sessionStart).some((command) => /cerebro/i.test(command) && command.includes(' sync'));
}

/** Every `command` string anywhere under a hook entry, however it is nested. */
function commandsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => commandsIn(entry));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const command = record['command'];
  return [
    ...(typeof command === 'string' ? [command] : []),
    ...commandsIn(record['hooks']),
  ];
}

/**
 * Is one bank's managed block in this profile's `CLAUDE.md`?
 *
 * The begin marker alone, not the pair: a block whose end marker was lost to a
 * hand edit is still a block the profile carries, and reporting it as absent
 * would invite a second one to be written under it.
 */
export function hasBankBlock(claudeMarkdown: string, slug: string): boolean {
  return claudeMarkdown.includes(beginMarker(slug));
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
 * disk and opens sockets, and this one is unit-tested in a plain Node process.
 * Injecting the capability keeps the tests honest and keeps the dependency
 * pointing one way.
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
 * Five facts, one call, because they all come from the same place and are all
 * unknowable to a module that may not import `electron`: where the registry
 * lives, where the master switch is written, where the profiles are (which is
 * the same directory, and is what an install has to find), what the legacy CLI
 * should be told `ARTEMIS_ROOT` is, and where a bank's git credential comes
 * from — a stored one, or a reference into a key manager.
 *
 * Until it is called there is no registry, no switch and no bank: every read
 * answers empty rather than guessing at a location.
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
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/** The empty answer for a process that has not been told where `userData` is. */
const NO_BANKS: BankRegistryV2 = { version: 2, banks: [], defaultSlug: null };

/**
 * Where the two registry files are: Artemis's own, and the CLI's mirror.
 *
 * `null` before {@link configureMemoryBanks} has run, which is a complete
 * state rather than an error — a process that does not know `userData` has no
 * registry to read and no business writing the CLI's.
 */
function registryOptions(): ReadRegistryV2Options | null {
  return artemisRoot === null ? null : { dataDir: artemisRoot, cliRegistryPath: registryPath() };
}

/**
 * The machine's banks.
 *
 * Read on the path of every run start, so it is synchronous and small: one
 * JSON file, plus the CLI's when that one is newer. A read that folded the
 * CLI's file in writes the result straight back — the mirror is only useful if
 * it is re-established, and leaving it dirty would re-do the reconciliation on
 * every read for the life of the process.
 */
function readBanks(): BankRegistryV2 {
  const options = registryOptions();
  if (options === null) return NO_BANKS;
  const { registry, dirty } = readRegistryV2(options);
  const adopted = adoptLegacyClone(registry);
  if (!dirty && adopted === registry) return registry;
  try {
    writeRegistryV2(options, adopted);
  } catch (error) {
    // The read stands either way; the next write will try again.
    log.warn('Could not write the memory-bank registry', error);
  }
  return adopted;
}

/**
 * A machine that cloned the team bank before banks were plural, and never ran
 * the CLI's `setup`, has the clone and no registry naming it.
 *
 * Registered here, once, under the legacy slug — a change of description, not
 * of disk: the legacy slug keeps the exact install namespace those machines
 * already have. This used to be a `cerebro setup --mode local` spawn on the
 * status path; it is the same registration, written directly, on a machine
 * that may have no Python.
 */
let adoptedLegacy = false;

function adoptLegacyClone(registry: BankRegistryV2): BankRegistryV2 {
  if (adoptedLegacy || registry.banks.length > 0) return registry;
  adoptedLegacy = true;
  const root = legacyRoot();
  if (detectBankFormat(root) === null) return registry;
  log.info(`Registering the pre-existing bank at ${root} as '${LEGACY_SLUG}'`);
  return withBank(registry, {
    slug: LEGACY_SLUG,
    path: root,
    role: 'readwrite',
    enabled: true,
    profiles: { kind: 'all' },
  });
}

/** One bank's record, or the error naming the slug the renderer asked for. */
function requireBank(slug: string): { registry: BankRegistryV2; record: BankRecord } {
  const registry = readBanks();
  const record = registry.banks.find((bank) => bank.slug === slug);
  if (record === undefined) {
    throw new WorkspaceError(`No memory bank called '${slug}' is registered on this machine.`);
  }
  return { registry, record };
}

/** Write the registry, and mirror the CLI's. Throws rather than losing a change. */
function saveBanks(registry: BankRegistryV2): void {
  const options = registryOptions();
  if (options === null) {
    throw new WorkspaceError('Memory banks are not configured in this process.');
  }
  writeRegistryV2(options, registry);
}

/**
 * Install one bank into every project it reaches — and remove it from the
 * ones it no longer does.
 *
 * The budget is the reason this is a function rather than a call: a project's
 * memory file has one allowance for bank indexes altogether, so every bank
 * that reaches a project has to be installed against the *shared* budget
 * divided by how many there are. Installing one bank at a time with a fixed
 * budget cut cortex's index to 54 of 145 entries the day a second bank
 * appeared.
 */
function installBankNow(
  registry: BankRegistryV2,
  record: BankRecord,
  cwd?: string,
): InstallEverywhereReport | null {
  if (artemisRoot === null) return null;
  const sharing = registry.banks.filter((bank) => bank.enabled).length;
  return reconcileBankInstalls(record, artemisRoot, cwd, sharedIndexBudget(sharing));
}

/* -------------------------------------------------------------------------- */
/* Cheap per-run reads — never a spawn                                        */
/* -------------------------------------------------------------------------- */

/**
 * The banks a run on this profile should know about: enabled, in the profile's
 * scope, and a bank on disk.
 *
 * `detectBankFormat` rather than a full read, because this answers on the path
 * of every run start and the question is only "is there a bank there" — a
 * couple of `stat`s per bank against reading and validating every file in it.
 */
export function banksForRun(profileId?: string): BankRecord[] {
  return enabledBanksIn(readBanks()).filter((bank) => scopeCoversProfile(bank.profiles, profileId));
}

/**
 * Every enabled bank on disk, whatever profile it is scoped to — which is the
 * set the background sync works over, because installing is per profile and
 * `reconcileBankInstalls` applies each bank's scope itself.
 */
function enabledBanksIn(registry: BankRegistryV2): BankRecord[] {
  return registry.banks.filter((bank) => bank.enabled && detectBankFormat(bank.path) !== null);
}

/**
 * The precondition for `builtin:cerebro`: a bank this profile carries.
 *
 * No longer "and a CLI to teach". The prompt describes what a bank holds and
 * where its memories are installed, which is true with or without Python; only
 * the drafting half names the CLI, and a bank that embeds one supplies it.
 */
export function anyBankAvailable(profileId?: string): boolean {
  return banksForRun(profileId).length > 0;
}

/**
 * The facts the prompt renderer needs, in composition's pure vocabulary: each
 * bank's name, description, format, filing and index, scoped to the run's
 * profile and the project it starts in.
 *
 * The index is budgeted exactly as the installed one is — the same allowance,
 * divided between the same banks — so a provider that reads the prompt's copy
 * and one that reads the project's file are told the same entries. Naming no
 * profile describes only the banks attached to every profile, which is the
 * right answer for the pane's preview: it is a preview of what any account
 * would be told.
 *
 * `toolsAvailable: false` until the memory tools land — the prompt must not
 * teach a tool nothing serves. The vendored CLI is the fallback for a legacy
 * bank that embeds none; core's reader does the rest, so the desktop and the
 * headless server describe a bank identically.
 */
export function promptBanks(profileId?: string, cwd?: string): MemoryBankPromptInfo[] {
  const registry = readBanks();
  return describeBanksForRun({
    registry,
    ...(profileId === undefined ? {} : { profileId }),
    ...(cwd === undefined ? {} : { cwd }),
    budget: sharedIndexBudget(registry.banks.filter((bank) => bank.enabled).length),
    toolsAvailable: false,
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

/**
 * Every bank's condition. `banks: []` is a complete answer, not a fault.
 *
 * Nothing spawns. Each bank is read where it sits — name, description, format,
 * entries and their problems — and each profile is asked two questions about
 * its own files. A machine with no Python, or with a bank whose CLI is gone,
 * still gets a full pane.
 */
export async function readMemoryBanksStatus(): Promise<MemoryBanksStatus> {
  const registry = readBanks();
  const profiles = artemisRoot === null ? [] : readProfileDirs(artemisRoot);
  const banks = registry.banks.map((record) => {
    const bank = readBankAt(record.path, { slug: record.slug });
    return bankInfoFrom(record, bank, {
      isDefault: record.slug === registry.defaultSlug,
      remote: bankRemote(record.path),
      source: bank === null ? null : sourceStamp(record.path),
      projects: installedProjects(record.slug, profiles),
    });
  });
  return withCredentialState({
    cliAvailable: safeResolveCli() !== null,
    masterEnabled: isMasterEnabled(),
    banks,
    profiles: profiles.map((profile) => profileState(profile, registry)),
  });
}

/**
 * How many project memory directories currently carry one bank's install.
 *
 * Counted by directory rather than by profile, because two profiles may share
 * one projects store through a symlink — the same install seen twice, which
 * the pane would render as twice the reach.
 */
function installedProjects(slug: string, profiles: readonly ArtemisProfileDir[]): number {
  const asked = new Set<string>();
  const carrying = new Set<string>();
  for (const profile of profiles) {
    for (const key of profileProjectKeys(profile.configDir)) {
      const memoryDir = projectMemoryDir(profile.configDir, key);
      if (asked.has(memoryDir)) continue;
      asked.add(memoryDir);
      if (isInstalled(slug, memoryDir)) carrying.add(memoryDir);
    }
  }
  return carrying.size;
}

/**
 * What one profile carries of the banks, for stock Claude Code's sake.
 *
 * Both answers are about the *other* path: Artemis runs with
 * `settingSources: []` and injects the prompt itself, so neither the hook nor
 * the block does anything under Artemis. They are reported because a user who
 * also opens that profile in stock Claude Code has a second setup to keep
 * true, and because "the pane said it was wired" should mean the files say so.
 */
function profileState(profile: ArtemisProfileDir, registry: BankRegistryV2): MemoryBankProfileState {
  const claudeMarkdown = readTextOr(join(profile.configDir, 'CLAUDE.md'), '');
  const settings = readTextOr(join(profile.configDir, 'settings.json'), '');
  const banks: Record<string, boolean> = {};
  for (const bank of registry.banks) banks[bank.slug] = hasBankBlock(claudeMarkdown, bank.slug);
  return {
    name: profile.id.length > 0 ? profile.id : basename(profile.configDir),
    label: profile.label,
    hook: hasSessionStartSyncHook(settings),
    banks,
  };
}

function readTextOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
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

/**
 * One bank's memories, read where they sit.
 *
 * Every entry the bank declares, including the ones that failed validation:
 * a memory with problems is browsable here precisely so the person who can fix
 * it can see what is wrong with it. `readonly` is `false` for all of them —
 * the flag meant an entry from a mirror tree the old CLI reported separately,
 * and core's reader has no such notion. Writability is the *bank's* property
 * now, and the pane has it in {@link MemoryBankInfo.role}.
 */
export async function readMemoryBankMemories(slug: string): Promise<MemoryBankMemory[]> {
  const { record } = requireBank(slug);
  const bank = readBankAt(record.path, { slug });
  if (bank === null) {
    throw new WorkspaceError(
      `${record.path} no longer holds a bank — it may have been moved or deleted. Forget '${slug}' and add it again from its new location.`,
    );
  }
  return bank.entries.map((entry) => ({
    name: entry.name,
    title: entry.title,
    type: entry.type ?? 'unknown',
    description: entry.description,
    body: entry.body,
    added: entry.added,
    author: entry.author,
    org: entry.scope['org'] ?? null,
    project: entry.scope['project'] ?? null,
    scope: entry.scope,
    readonly: false,
    file: entry.file,
    problems: entry.problems,
  }));
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What this machine is missing, with the fix for each.
 *
 * Asked before there is a bank, which is why it is not a read of one. It used
 * to be `cerebro doctor --json`, which meant the answer to "can this machine
 * carry a bank" depended on the thing a machine may no longer have. The four
 * check ids are the CLI's own, so the pane's per-id rendering is unchanged —
 * but two of them have stopped blocking:
 *
 *  - `git` and `git-identity` **fail**. A bank is a git repository; joining one
 *    needs git, and creating one needs an identity to commit under.
 *  - `python` and `cli` **warn**. Reading, installing and describing a bank is
 *    core's work now. Python is needed only by the legacy CLI, and the CLI
 *    itself only for retiring a memory and for a legacy bank's drafts.
 */
export async function readMemoryBanksPreflight(): Promise<MemoryBankPreflight> {
  const checks: MemoryBankCheck[] = [];

  const version = await probeCommand('git', ['--version']);
  checks.push({
    id: 'git',
    label: 'git',
    state: version.ok ? 'ok' : 'fail',
    detail: version.ok ? firstLine(version.stdout) : 'git is not installed, or is not on this process’s PATH',
    remedy: version.ok ? null : 'Install git from git-scm.com/downloads, then check again.',
  });

  const name = await probeCommand('git', ['config', '--get', 'user.name']);
  const email = await probeCommand('git', ['config', '--get', 'user.email']);
  const identified = name.ok && email.ok && firstLine(name.stdout).length > 0 && firstLine(email.stdout).length > 0;
  checks.push({
    id: 'git-identity',
    label: 'git identity',
    state: identified ? 'ok' : 'fail',
    detail: identified
      ? `${firstLine(name.stdout)} <${firstLine(email.stdout)}>`
      : 'git has no name and email to commit a memory under',
    remedy: identified
      ? null
      : 'Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.',
  });

  const python = await resolvePython();
  checks.push({
    id: 'python',
    label: 'Python 3',
    state: python === null ? 'warn' : 'ok',
    detail:
      python === null
        ? 'no Python 3 on this machine — needed only for the legacy cerebro CLI, not to read, install or describe a bank'
        : `driving the legacy CLI with ${[python.command, ...python.args].join(' ')}`,
    remedy:
      python === null
        ? 'Only if you need the legacy CLI: install it from python.org/downloads, or with `winget install Python.Python.3.13`.'
        : null,
  });

  const cli = safeResolveCli();
  checks.push({
    id: 'cli',
    label: 'Bank CLI',
    state: cli === null ? 'warn' : 'ok',
    detail:
      cli === null
        ? 'no cerebro CLI resolves on this machine — legacy banks can still be read; drafting through the CLI is unavailable'
        : cli,
    remedy: cli === null ? 'Join a bank that embeds its own copy, or reinstall Artemis, if you need it.' : null,
  });

  return { ready: checks.every((check) => check.state !== 'fail'), checks };
}

/** Run a command for its exit status. Never throws; a spawn that fails is `ok: false`. */
async function probeCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
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

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

/* -------------------------------------------------------------------------- */
/* Credentials for a private bank                                             */
/* -------------------------------------------------------------------------- */

/**
 * A clone's `origin` URL, out of its own `.git/config`.
 *
 * Read rather than asked for, because `git remote get-url` would be a spawn on
 * paths that must not have one — the status read, and the credential lookup
 * behind a sync that fires at every run start. Parsed as its own function so
 * the awkward half (git's config grammar) is testable without a repository.
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
  const bank = readBanks().banks.find((entry) => entry.slug === slug);
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
/* git, which is the only thing a bank actually needs                         */
/* -------------------------------------------------------------------------- */

/** How long a clone is worth waiting for, with a person watching. */
const CLONE_TIMEOUT_MS = 300_000;

/** How long a local git call (init, add, commit) may take before it is stuck. */
const LOCAL_GIT_TIMEOUT_MS = 60_000;

/**
 * Run git and hand back stdout.
 *
 * The second spawn choke point, and it keeps `runCli`'s rules: the terminal
 * prompt is forbidden, a private remote's credential arrives through `env`
 * and never on the command line, and everything the child said is scrubbed of
 * the tokens that environment carried before it can become an error message.
 */
async function runGit(
  args: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return stdout;
  } catch (error) {
    throw toGitError(error, gitVerb(args), tokensIn(env));
  }
}

/**
 * The subcommand in an argument list, for the sentence a failure becomes.
 *
 * Past a leading `-C <path>`, because that path is the bank's directory and
 * "git C:\Users\me\Documents\cortex failed" names the wrong thing entirely.
 */
function gitVerb(args: readonly string[]): string {
  const rest = args[0] === '-C' ? args.slice(2) : args;
  return rest.find((arg) => !arg.startsWith('-')) ?? 'command';
}

/** A failed git spawn, as a sentence with git's own last words in it. */
function toGitError(error: unknown, verb: string, secrets: readonly string[]): WorkspaceError {
  const raw = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };
  if (raw.code === 'ENOENT') {
    return new WorkspaceError(
      'git is not installed on this machine, so a bank cannot be cloned or created. Install it from git-scm.com/downloads.',
    );
  }
  const said = withoutSecrets(
    [raw.stderr, raw.stdout]
      .filter((chunk): chunk is string => typeof chunk === 'string')
      .join('\n')
      .trim(),
    secrets,
  );
  const tail = said
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-3)
    .join(' · ');
  return new WorkspaceError(
    `git ${verb} failed: ${tail.length > 0 ? tail : typeof raw.message === 'string' ? withoutSecrets(raw.message, secrets) : 'git gave no reason'}`,
  );
}

/** Has this checkout a commit yet? `false` for a clone of an empty remote. */
async function hasCommits(path: string): Promise<boolean> {
  return (await probeCommand('git', ['-C', path, 'rev-parse', '--verify', 'HEAD'])).ok;
}

/**
 * The smallest thing that is a bank: a manifest that describes it, and the
 * directory its memories go in.
 *
 * Writes only what is missing. A `create` aimed at a directory that already
 * holds a `BANK.md` is somebody pointing Artemis at their own work, and
 * overwriting the file they wrote to describe it would be the worst possible
 * reading of the request.
 */
function writeBankSkeleton(path: string, slug: string): string[] {
  const written: string[] = [];
  const manifest = join(path, BANK_MANIFEST_FILE);
  if (!existsSync(manifest)) {
    writeFileSync(manifest, bankManifestTemplate(slug, 'A team memory bank'), 'utf8');
    written.push(BANK_MANIFEST_FILE);
  }
  const memories = join(path, 'memories');
  if (!existsSync(memories)) {
    mkdirSync(memories, { recursive: true });
    // Git does not track a directory, and a bank whose `memories/` vanished on
    // the first push is a bank the next machine does not recognise.
    writeFileSync(join(memories, '.gitkeep'), '', 'utf8');
    written.push('memories/');
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Join, create, or adopt a bank — then register it and install it once.
 *
 * All three are git and file writes now. The CLI's `setup` used to do the
 * clone, the registration and the wiring in one spawn; doing it here is what
 * lets a machine with no Python join a bank, and what lets the registry record
 * the profile scope the CLI has no room for.
 *
 * Adding the first bank also throws the master switch: onboarding *is* the
 * yes, exactly as single-bank setup was. Adding a later bank leaves the master
 * alone — its state is a decision the user already made.
 */
export async function addMemoryBank(request: MemoryBankAddRequest): Promise<MemoryBankActionResponse> {
  const path = request.path ?? join(homedir(), 'Documents', request.slug);
  if (request.mode === 'adopt' && detectBankFormat(path) === null) {
    throw new WorkspaceError(
      `${path} is not a bank — it has no BANK.md, no memories/ directory and declares no projects layout in a cerebro.json. Use "create" to start one there.`,
    );
  }
  if (request.mode === 'join' && (request.remote === undefined || request.remote.length === 0)) {
    throw new WorkspaceError('Joining a bank needs its remote URL.');
  }

  const registry = readBanks();
  // The CLI's own refusal, kept: a slug is an install namespace
  // (`memory/banks/<slug>/`) and a prompt the agents are taught, and quietly
  // re-pointing one at a different repository would leave every project
  // carrying the old bank's copies under the new bank's name.
  const taken = registry.banks.find((bank) => bank.slug === request.slug);
  if (taken !== undefined && taken.path !== path) {
    throw new WorkspaceError(
      `'${request.slug}' already names the bank at ${taken.path} on this machine. Choose another name, or forget that one first.`,
    );
  }
  const hadBanks = registry.banks.length > 0;
  const steps: string[] = [];

  // Composed once and used by every git call below: the clone, and the first
  // push when the remote turns out to be empty.
  //
  // Disposed in a `finally`, because a value resolved out of a key manager is
  // registered with the literal-secret scrub until it is: a join that threw
  // partway through would otherwise leave this process scrubbing a string
  // nothing is using any more.
  const resolved = await requestedCredential(request);
  const credentialEnv = resolved === null ? {} : gitCredentialEnv(resolved.credential);
  try {
    steps.push(
      request.mode === 'join'
        ? await joinBank(request, path, credentialEnv)
        : request.mode === 'create'
          ? await createBank(request.slug, path)
          : `Adopted the bank at ${path} as '${request.slug}'.`,
    );

    // Stored here rather than at the end, because *this* is the step that
    // proved the credential works. A registration failure after a successful
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
  } finally {
    resolved?.dispose();
  }

  // Every profile, until somebody says otherwise: a bank added on this machine
  // is for this machine, and narrowing it is a decision made in the pane with
  // the profiles in front of you — not a default that silently hides a bank
  // from the account you happen not to have been using.
  const record: BankRecord = {
    slug: request.slug,
    path,
    role: request.role,
    enabled: true,
    profiles: { kind: 'all' },
  };
  const next = withBank(registry, record);
  saveBanks(next);
  steps.push('Registered for every profile.');
  steps.push(installSaid(installBankNow(next, record)));

  if (!hadBanks && !isMasterEnabled()) {
    writeSwitch(true);
    steps.push('Memory banks are on for Artemis.');
  }
  return { message: steps.join(' ') };
}

/**
 * Clone a bank, and start one if the remote is empty.
 *
 * The empty remote is the ordinary first day of a team bank: somebody creates
 * the repository on the forge and the first person to join is the one who
 * fills it. Refusing that would leave them creating a bank locally and pushing
 * it by hand, which is the same work with a worse error message.
 *
 * A clone that has content but is not a bank is removed again — but only if
 * this call is what created the directory. Cleaning up after a clone is
 * tidying; deleting a directory the user already had is not something this
 * channel may do.
 */
async function joinBank(
  request: MemoryBankAddRequest,
  path: string,
  credentialEnv: Readonly<Record<string, string>>,
): Promise<string> {
  const remote = request.remote ?? '';
  const created = !existsSync(path);
  await runGit(['clone', remote, path], CLONE_TIMEOUT_MS, credentialEnv);

  if (detectBankFormat(path) !== null) {
    return `Joined ${remote} at ${path} as '${request.slug}'.`;
  }
  if (await hasCommits(path)) {
    if (created) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        log.warn(`Could not remove the clone at ${path} after it turned out not to be a bank`, error);
      }
    }
    throw new WorkspaceError(
      `${remote} is not a memory bank: it has content, but no BANK.md, no memories/ directory and no projects layout. ` +
        'Join the right repository, or create a bank and push it there.',
    );
  }

  const written = writeBankSkeleton(path, request.slug);
  await runGit(['-C', path, 'add', '-A'], LOCAL_GIT_TIMEOUT_MS);
  await runGit(['-C', path, 'commit', '-m', `Start the ${request.slug} memory bank`], LOCAL_GIT_TIMEOUT_MS);
  await runGit(['-C', path, 'push', '-u', 'origin', 'HEAD'], CLONE_TIMEOUT_MS, credentialEnv);
  return `Joined ${remote} at ${path} as '${request.slug}' — the remote was empty, so ${written.join(' and ')} are its first commit.`;
}

/** Start a bank in a directory of one's own: a git repository with a manifest in it. */
async function createBank(slug: string, path: string): Promise<string> {
  mkdirSync(path, { recursive: true });
  await runGit(['init', path], LOCAL_GIT_TIMEOUT_MS);
  const written = writeBankSkeleton(path, slug);
  // Asked before the add, so `status` sees untracked files too: a `create`
  // aimed at a directory whose bank is already committed has nothing to do,
  // and `git commit` with nothing staged fails rather than shrugging.
  const pending = (await probeCommand('git', ['-C', path, 'status', '--porcelain'])).stdout.trim();
  if (pending.length > 0) {
    await runGit(['-C', path, 'add', '-A'], LOCAL_GIT_TIMEOUT_MS);
    await runGit(['-C', path, 'commit', '-m', `Start the ${slug} memory bank`], LOCAL_GIT_TIMEOUT_MS);
  }
  return `Created a bank at ${path} as '${slug}'${written.length > 0 ? ` with ${written.join(' and ')}` : ''}.`;
}

/** `3 projects`, `1 project` — the counts in these receipts are all small. */
function count(amount: number, one: string, many = `${one}s`): string {
  return `${String(amount)} ${amount === 1 ? one : many}`;
}

/** What an install pass came to, as a sentence for a receipt. */
function installSaid(report: InstallEverywhereReport | null): string {
  if (report === null) return 'Nothing was installed into project memory.';
  if (report.refused !== null) return `Nothing was installed: ${report.refused}`;
  return `Installed ${count(report.installed, 'memory', 'memories')} into ${count(report.projects, 'project')} across ${count(report.profiles, 'profile')}.`;
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

/**
 * Switch one bank on or off.
 *
 * The flag is Artemis's record and the CLI's alike — the registry is mirrored
 * on every write, so a machine that also runs stock Claude Code sees the same
 * answer. What follows the flag is the installs: on means the bank's copies
 * appear in every project it reaches, off means they go. Off used to leave
 * them behind "until you forget the bank", which is how a switched-off bank
 * kept turning up in sessions.
 */
export async function setMemoryBankEnabled(
  request: MemoryBankSetEnabledRequest,
): Promise<MemoryBankActionResponse> {
  const { registry, record } = requireBank(request.slug);
  const next: BankRecord = { ...record, enabled: request.enabled };
  const updated = withBank(registry, next);
  saveBanks(updated);

  if (request.enabled) {
    return { message: `'${request.slug}' is on. ${installSaid(installBankNow(updated, next))}` };
  }
  if (artemisRoot !== null) uninstallBankEverywhere(request.slug, artemisRoot);
  return {
    message: `'${request.slug}' is off — its memories are out of project memory and runs are no longer told about it. The repository stays on disk.`,
  };
}

/**
 * Which profiles one bank reaches.
 *
 * Artemis's own record, in Artemis's own registry: the CLI's config has no
 * room for it and does not need any. The installs follow immediately, because
 * scope is only a claim until the profile that lost the bank stops having it
 * in its projects — and a person who has just narrowed a bank to one account
 * is entitled to expect the others to be clean before their next run starts.
 */
export async function setMemoryBankProfiles(
  request: MemoryBankSetProfilesRequest,
): Promise<MemoryBankActionResponse> {
  const { registry, record } = requireBank(request.slug);
  const next: BankRecord = { ...record, profiles: request.profiles };
  const updated = withBank(registry, next);
  saveBanks(updated);

  const reach =
    request.profiles.kind === 'all'
      ? 'every profile'
      : request.profiles.profileIds.length === 0
        ? 'no profile'
        : count(request.profiles.profileIds.length, 'profile');
  return {
    message: `'${request.slug}' now reaches ${reach}. ${installSaid(installBankNow(updated, next))}`,
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

/**
 * Bring one bank — or every enabled one — up to date, and re-install it.
 *
 * A pull and a write, in that order, per bank. The CLI's `sync` did the same
 * two things plus a promote of whatever the last session drafted into the
 * bank's `inbox/`; that half is still the CLI's until the memory tools land,
 * so it runs first, best-effort, and only for a legacy bank that carries both
 * an inbox and a CLI to empty it with. A machine with no Python simply does
 * not promote, which is the honest outcome — its drafts wait.
 */
export async function syncMemoryBank(request: MemoryBankSyncRequest): Promise<MemoryBankActionResponse> {
  const registry = readBanks();
  const wanted =
    request.slug === undefined
      ? registry.banks.filter((bank) => bank.enabled)
      : [requireBank(request.slug).record];
  if (wanted.length === 0) return { message: 'No enabled bank to sync.' };

  const steps: string[] = [];
  for (const record of wanted) {
    const credentials = await bankCredentialEnv(record.slug);
    try {
      await promoteLegacyDrafts(record);
      const pulled = await pullBank(record.path, credentials.env, 180_000);
      steps.push(`'${record.slug}': ${pulled.detail}.`);
    } finally {
      credentials.dispose();
    }
    steps.push(installSaid(installBankNow(registry, record)));
  }
  return { message: steps.join(' ') };
}

/**
 * Empty a legacy bank's drafting inbox through its own CLI, if it has both.
 *
 * Best-effort and silent about the ordinary case. An agent on this machine
 * writes a draft by running the bank's CLI — that is still the only way to
 * write until the memory tools exist — and what it produces is a file in
 * `inbox/` that only the CLI knows how to validate and land. Nothing here
 * fails a sync: a bank with no inbox, no CLI, or no Python has nothing to
 * promote, and a promote that is refused is the validator doing its job.
 */
async function promoteLegacyDrafts(record: BankRecord): Promise<void> {
  const cli = embeddedCli(record.path);
  if (cli === null) return;
  if (!existsSync(join(record.path, 'inbox'))) return;
  try {
    await runCli(cli, ['--bank', record.slug, 'promote', '--quiet'], 120_000);
  } catch (error) {
    log.warn(`Could not promote queued drafts for '${record.slug}'`, error);
  }
}

/**
 * Retirement reaches the remote — with a remote configured it opens a pull
 * request — so it carries the bank's credential like any other write.
 *
 * The one channel that still *requires* the CLI. Retiring is a write into a
 * repository other people read, through that repository's own review path,
 * and reimplementing the landing half here would mean two implementations of
 * it until the memory tools arrive. A machine that cannot run the CLI is told
 * so rather than shown a button that fails.
 */
export async function retireMemoryBankMemory(
  request: MemoryBankRetireRequest,
): Promise<MemoryBankActionResponse> {
  const { record } = requireBank(request.slug);
  const cli = embeddedCli(record.path) ?? safeResolveCli();
  if (cli === null) {
    throw new WorkspaceError(
      "Retiring needs the bank's CLI until the memory tools land, and none is available on this machine. " +
        'Retire the memory in the bank repository instead, or install Python and a bank that embeds its CLI.',
    );
  }
  const args = ['--bank', request.slug, 'retire', request.name];
  if (request.reason !== undefined) args.push('--reason', request.reason);
  const credentials = await bankCredentialEnv(request.slug);
  try {
    const output = (await runCli(cli, args, 120_000, credentials.env)).trim();
    return { message: output.length > 0 ? output : `Retired ${request.name}.` };
  } finally {
    credentials.dispose();
  }
}

/**
 * Uninstall, forget, clear the credential — and, for a machine that also runs
 * stock Claude Code, unwire the bank there too.
 *
 * The repository stays on disk: deleting a git repo is not something this
 * channel can be aimed at.
 *
 * The CLI's `disable` is the one call that still matters here and it is
 * best-effort: it strips the managed block, the `/cerebro` command and the
 * session-start hook from every profile — wiring Artemis never uses but a
 * user's own `claude` does. A machine without the CLI keeps those files as
 * they are, which is inert rather than wrong, and the reason is logged rather
 * than reported: the bank *is* forgotten by then, and failing the action would
 * say the opposite.
 */
export async function forgetMemoryBank(request: MemoryBankForgetRequest): Promise<MemoryBankActionResponse> {
  const { registry, record } = requireBank(request.slug);
  const steps: string[] = [];

  if (artemisRoot !== null) {
    uninstallBankEverywhere(request.slug, artemisRoot);
    steps.push(`Removed '${request.slug}' from every project's memory.`);
  }
  saveBanks(withoutBank(registry, request.slug));
  steps.push('Forgot it; the repository is untouched on disk.');

  // After the registry write, and with the CLI resolved from the bank's own
  // copy: `disable` only edits profile files, so its failure cannot leave the
  // registry half-written.
  const cli = embeddedCli(record.path) ?? safeResolveCli();
  if (cli !== null) {
    try {
      await runCli(cli, ['--bank', request.slug, 'disable'], 60_000);
      steps.push('Unwired it from stock Claude Code (managed block, /cerebro command, session-start hook).');
    } catch (error) {
      log.warn(`Could not unwire '${request.slug}' from the profiles' Claude Code settings`, error);
    }
  }

  // The credential last, and unconditionally: a bank Artemis no longer knows
  // about must not leave an encrypted token behind for a slug nothing will
  // ever resolve again. Best-effort for `disable`'s reason.
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
 * How long a sync pass stands for: one a minute per directory is enough to
 * keep a burst of runs from doing the same work several times over.
 */
const SYNC_THROTTLE_MS = 60_000;

/**
 * How long one bank's pull stands for.
 *
 * The expensive half, and the only part that touches the network. Fifteen
 * minutes is the CLI's own fetch stamp, kept: a bank is a repository people
 * commit to a few times a day, and a run that starts four minutes after the
 * last one has nothing to gain from asking the forge again.
 */
const PULL_THROTTLE_MS = 15 * 60_000;

/** When each bank last pulled. Per slug, in memory — see {@link pullDue}. */
const lastPullAt = new Map<string, number>();

let lastSyncAt = 0;
/** The working directory the last sync was told about. See {@link syncDue}. */
let lastSyncCwd: string | undefined;
let syncInFlight = false;
/** A directory that asked while a sync was running, owed a sync of its own. */
let pendingCwd: string | undefined;

/**
 * Is a sync pass worth doing for this run?
 *
 * The throttle exists to stop a burst of runs doing the same work several
 * times over — and a burst is usually several runs in the *same* project. A run
 * in a project the last sync did not know about is the case the throttle must
 * not swallow: its first session is exactly when the bank has to be installed
 * for it, and waiting a minute means starting without the team's memory. So the
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
 * Is this bank's pull due?
 *
 * A second throttle inside the first, and per bank rather than per pass,
 * because the two halves of a sync cost entirely different things. Installing
 * is a few file writes and happens on every pass — it is what makes a project
 * opened for the first time carry the bank. Pulling is the network, and a bank
 * that pulled twelve minutes ago is as fresh as one that pulls now.
 *
 * Pure, so the rule is the unit under test rather than the clock around it.
 */
export function pullDue(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= PULL_THROTTLE_MS;
}

/**
 * Keep the banks fresh and installed, around a run that must not wait for it.
 *
 * ## Why the main process does this
 *
 * `cerebro enable` installs a `SessionStart` hook into each profile's
 * `settings.json`, and on a stock Claude Code that is the whole mechanism.
 * Under Artemis that hook never fires: every query runs with
 * `settingSources: []` — the deliberate isolation described in the Claude
 * adapter — and a hook Artemis never loads is a hook that never runs. So the
 * work moves to the side of the boundary that provisioned it: Artemis wires
 * the banks and shows the pane; keeping them turning is its own housekeeping,
 * not an instruction for the model to carry.
 *
 * ## Why the install is synchronous and the pull is not
 *
 * The two halves have nothing in common but a name. Installing is a handful of
 * file writes from the checkout as it already stands, and it is what makes a
 * project opened for the first time carry the bank *for the run that is
 * starting right now* — so it happens before this function returns. Pulling is
 * the network: it belongs to the next run, not this one, so it is fired and
 * forgotten, throttled per bank, and re-installs only the banks whose checkout
 * actually moved.
 *
 * Silent unless something fails, and never throwing. A run must never wait on
 * a memory bank and must never fail because of one.
 */
export function syncMemoryBanksInBackground(cwd?: string): void {
  if (syncInFlight) {
    // Owed, not dropped: a project that opened while another's sync was
    // running still needs its install, and the throttle below would otherwise
    // hold it for a minute. Runs once more when the current pass ends.
    if (cwd !== undefined && cwd !== lastSyncCwd) pendingCwd = cwd;
    return;
  }
  // The switch before the disk reads, because it is the cheaper question and
  // the more important one: a machine that has banks configured but has not
  // said yes must not have its projects written to by the mere act of starting
  // a run.
  if (!isMasterEnabled()) return;

  const registry = readBanks();
  const banks = enabledBanksIn(registry);
  if (banks.length === 0) return;

  const now = Date.now();
  if (!syncDue({ lastSyncAt, lastSyncCwd }, cwd, now)) return;
  lastSyncAt = now;
  lastSyncCwd = cwd;
  syncInFlight = true;

  // First, from the checkout as it is. Each bank's own profile scope decides
  // which profiles are written to, and the run's directory is included even
  // when no profile has a memory directory for it yet — that is the project
  // about to be opened.
  for (const record of banks) {
    try {
      installBankNow(registry, record, cwd);
    } catch (error) {
      log.warn(`Could not install '${record.slug}' into project memory`, error);
    }
  }

  void pullBanks(registry, banks, cwd).finally(() => {
    syncInFlight = false;
    const next = pendingCwd;
    pendingCwd = undefined;
    if (next !== undefined && next !== lastSyncCwd) syncMemoryBanksInBackground(next);
  });
}

/**
 * Pull each bank that is due, and re-install the ones that moved.
 *
 * Every private bank's credential is composed once for the pass — see
 * `bankCredentialEnv`. A bank whose key-manager reference will not resolve is
 * simply not in the block: `credentialFor` degrades rather than throws, so the
 * others still pull and the one that could not says why in the pane. There is
 * no retry beyond the throttle: a sealed vault does not become unsealed by
 * being asked twice in a minute.
 *
 * Never rejects. A bank that cannot pull — no network, a clone mid-rebase, a
 * local commit that will not fast-forward — is a degraded enhancement, and the
 * run it rode in on has nothing to do with it.
 */
async function pullBanks(
  registry: BankRegistryV2,
  banks: readonly BankRecord[],
  cwd?: string,
): Promise<void> {
  try {
    const credentials = await bankCredentialEnv();
    try {
      for (const record of banks) {
        if (!pullDue(lastPullAt.get(record.slug), Date.now())) continue;
        lastPullAt.set(record.slug, Date.now());
        const pulled = await pullBank(record.path, credentials.env, 180_000);
        if (!pulled.pulled) continue;
        log.info(`memory-banks: '${record.slug}' ${pulled.detail}`);
        installBankNow(registry, record, cwd);
      }
    } finally {
      credentials.dispose();
    }
  } catch (error) {
    log.warn('memory-banks sync did not complete; a bank may be stale', error);
  }
}
