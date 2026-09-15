/**
 * The memory banks this server carries, kept for the runs it serves.
 * ============================================================================
 *
 * A served run executes *here*, among this machine's banks, so this process is
 * the one that has to keep them: installed into the served accounts' project
 * memory, where Claude Code's auto-memory will find them, and fresh enough to
 * be worth reading. The desktop does both from its engine — the install on the
 * path of a run start, the pull in the background — and this is the same two
 * halves without a window around them.
 *
 * Until now neither happened. The container's banks were kept installed by a
 * cron on the host running `cerebro sync` every fifteen minutes, which meant a
 * machine with no Python had no banks, a project served for the first time
 * waited up to fifteen minutes for its install, and the freshness of a served
 * run's memory depended on a crontab nothing in this repository mentions. Core
 * can now read, install and pull a bank itself, so the server does it itself:
 * the cron becomes redundant, and a deployment that never had one still works.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SYNCHRONOUS AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * The **install** is synchronous, on the path of every served run. It is file
 * reads and writes only — no spawn — and it is the half that has to be done
 * *before* the run starts, because the run's very first turn is when the
 * provider loads the project's memory file. A first run in a new project that
 * had to wait for a background install would be a run without the team's
 * memory, which is the case the whole feature exists for.
 *
 * The **pull** is not. It spawns git, it talks to a remote, and a run must
 * never wait on either. It is throttled to once every fifteen minutes per
 * bank — the interval the host cron used, and long enough that a burst of
 * served turns costs one fetch — and the install is repeated only when the
 * checkout actually moved, which is read from `.git` rather than inferred from
 * git's own output (`--quiet` says nothing on either outcome).
 *
 * Nothing here throws into a run. A bank that cannot be read, installed or
 * pulled is a warning on stderr and a run that starts anyway: memory is an
 * augmentation, and an augmentation that can fail a turn is a liability.
 *
 * ---------------------------------------------------------------------------
 * CREDENTIALS
 * ---------------------------------------------------------------------------
 *
 * The desktop composes a per-bank credential into git's environment from its
 * key-manager registry (`gitCredentialEnv.ts`, main process). This process has
 * no such registry and no window to authorise one, so it pulls with the
 * environment it was started with — an ambient credential helper, a deploy key
 * on the SSH remote, or a public remote — and `GIT_TERMINAL_PROMPT=0` from
 * `pullBank`, so a private remote with no ambient credential fails fast and
 * silently rather than hanging a container on a password prompt.
 */

import type { RunInput } from '@rx-artemis/protocol';
import {
  banksForProfile,
  pullBank,
  readRegistryV2,
  reconcileBankInstalls,
  registryPath,
  sharedIndexBudget,
  sourceStamp,
  writeRegistryV2,
  type BankRecord,
  type IndexBudget,
} from '@rx-artemis/core';

/** How long a pull stands for, per bank. The interval the host cron used. */
const PULL_THROTTLE_MS = 15 * 60_000;

/** How long an install of an unmoved checkout stands for a project it already reached. */
const INSTALL_MEMO_MS = 10 * 60_000;

/** What a run tells the banks about itself. Both fields are absent on some paths. */
export interface ServedRunScope {
  readonly profileId?: string;
  readonly cwd?: string;
}

export interface ServerMemoryBanksOptions {
  /** The data directory holding `profiles.json` and `memory-banks.json`. */
  readonly dataDir: string;
  /** The CLI's registry, when this machine keeps one. Defaults to the CLI's own location. */
  readonly cliRegistryPath?: string;
  /** One line about something that went wrong. Defaults to stderr. */
  readonly log?: (message: string) => void;
  /** Clock, injectable so a test can exercise the throttle without waiting. */
  readonly now?: () => number;
  /**
   * How a checkout is brought up to date. Injectable so a test can drive the
   * throttle and the re-install without spawning git or reaching a network.
   */
  readonly pull?: (root: string) => Promise<{ readonly pulled: boolean; readonly detail: string }>;
}

export interface ServerMemoryBanks {
  /**
   * Install this account's banks for this run's project, now, and bring them
   * up to date in the background. Never throws.
   */
  prepare(run: ServedRunScope): void;
  /** The checkouts this account's banks live in, for a run's extra directories. */
  directoriesFor(profileId: string | undefined): readonly string[];
  /** Wait for the background pulls, for a test or an orderly shutdown. */
  settle(): Promise<void>;
}

/**
 * Fold the banks in scope into a run's `additionalDirectories`.
 *
 * The desktop's own merge (`mergeAdditionalDirectories` in its engine),
 * reimplemented here rather than imported, because it lives in the main
 * process and core must not grow a dependency on either host. The rules are
 * the same three: the caller's own directories are never dropped and come
 * first, banks follow in registry order, and a path already present on either
 * side appears once — so a resumed run that already carries its banks does not
 * double them. A no-op returns the input by reference, `undefined` included.
 *
 * There is no master switch here, unlike the desktop: a headless server has
 * nobody to flip one, and its banks are exactly what its registry lists.
 */
export function mergeBankDirectories(
  userDirs: readonly string[] | undefined,
  bankPaths: readonly string[],
): readonly string[] | undefined {
  if (bankPaths.length === 0) return userDirs;
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...(userDirs ?? []), ...bankPaths]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  if (userDirs !== undefined && merged.length === userDirs.length) return userDirs;
  return merged;
}

/**
 * A run with one more append on its system prompt.
 *
 * The desktop's `withSystemPromptAppended`, for the same reason the merge
 * above is copied. A `replace` the caller sent is left alone: replacing the
 * provider's preset is the caller's deliberate choice, and quietly appending
 * to it would change a prompt somebody wrote in full.
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

export function createServerMemoryBanks(options: ServerMemoryBanksOptions): ServerMemoryBanks {
  const where = {
    dataDir: options.dataDir,
    cliRegistryPath: options.cliRegistryPath ?? registryPath(),
  };
  const now = options.now ?? (() => Date.now());
  const pull = options.pull ?? ((root: string) => pullBank(root));
  const log =
    options.log ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  /** When each bank was last pulled, by slug. The throttle's whole memory. */
  const pulledAt = new Map<string, number>();
  /**
   * What each bank was last installed from, by slug: the checkout's commit,
   * the projects it was written for, and when. An install is a read of every
   * entry and a write per entry per project, and a completions server can be
   * asked for a turn many times a minute — so a bank whose checkout has not
   * moved is not rewritten for a project it was already written for, within
   * the window. A project seen for the first time is always written, which is
   * the guarantee the synchronous install exists to give.
   */
  const installedFrom = new Map<string, { stamp: string; at: number; cwds: Set<string> }>();
  /** The background pass in flight, so `settle` and `dispose` have something to await. */
  let inFlight: Promise<void> = Promise.resolve();

  function warn(what: string, error: unknown): void {
    log(`memory banks: ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }

  /**
   * The banks this account carries: enabled, in scope, and on disk.
   *
   * The registry is read afresh every time rather than cached. It is one small
   * file, and the alternative is a server that has to be restarted after
   * `cerebro enable` or a change to a bank's profile scope — exactly the kind
   * of staleness a headless deployment has no way to notice.
   */
  function inScope(profileId: string | undefined): BankRecord[] {
    try {
      const { registry, dirty } = readRegistryV2(where);
      if (dirty) {
        try {
          writeRegistryV2(where, registry);
        } catch (error) {
          // A courtesy to the next read; this call already holds the answer.
          warn('could not write the registry', error);
        }
      }
      return banksForProfile({
        registry,
        ...(profileId === undefined ? {} : { profileId }),
      });
    } catch (error) {
      warn('could not read the registry', error);
      return [];
    }
  }

  /**
   * `budget` is computed from the banks *in scope*, not from the ones being
   * written: they share one project memory file, so a re-install of a single
   * bank must keep to the share it had when all of them were written.
   */
  function install(
    records: readonly BankRecord[],
    cwd: string | undefined,
    budget: IndexBudget,
  ): void {
    for (const record of records) {
      try {
        reconcileBankInstalls(record, options.dataDir, cwd, budget);
        const memo = installedFrom.get(record.slug) ?? { stamp: '', at: 0, cwds: new Set<string>() };
        memo.stamp = sourceStamp(record.path);
        memo.at = now();
        if (cwd !== undefined) memo.cwds.add(cwd);
        installedFrom.set(record.slug, memo);
      } catch (error) {
        warn(`could not install '${record.slug}'`, error);
      }
    }
  }

  /** The banks whose installs may be stale for this run: never written, moved, unseen project, or old. */
  function dueForInstall(records: readonly BankRecord[], cwd: string | undefined): BankRecord[] {
    const at = now();
    return records.filter((record) => {
      const memo = installedFrom.get(record.slug);
      if (memo === undefined) return true;
      if (at - memo.at >= INSTALL_MEMO_MS) return true;
      if (cwd !== undefined && !memo.cwds.has(cwd)) return true;
      return memo.stamp !== sourceStamp(record.path);
    });
  }

  function refresh(records: readonly BankRecord[], cwd: string | undefined, budget: IndexBudget): void {
    const at = now();
    // A bank nothing has pulled yet is always due: the first run after a
    // restart is exactly when a checkout left behind by the last deployment
    // is most likely to be behind.
    const due = records.filter(
      (record) => at - (pulledAt.get(record.slug) ?? Number.NEGATIVE_INFINITY) >= PULL_THROTTLE_MS,
    );
    if (due.length === 0) return;
    // Stamped before the work rather than after, so a second run arriving
    // while a fetch is in flight does not start a rival one.
    for (const record of due) pulledAt.set(record.slug, at);

    inFlight = inFlight.then(async () => {
      for (const record of due) {
        try {
          const before = sourceStamp(record.path);
          const result = await pull(record.path);
          const after = sourceStamp(record.path);
          if (after === before) continue;
          // The checkout moved, so what is installed in every project is a
          // commit out of date. Read from `.git` rather than taken from git's
          // own words: `pullBank` runs `--quiet`, which prints nothing on
          // either outcome, so the message cannot tell the two apart.
          log(`memory banks: '${record.slug}' moved to ${after} (${result.detail}); reinstalling`);
          install([record], cwd, budget);
        } catch (error) {
          warn(`could not pull '${record.slug}'`, error);
        }
      }
    });
  }

  return {
    prepare(run) {
      try {
        const records = inScope(run.profileId);
        if (records.length === 0) return;
        // One allowance shared between the banks that reach this project: the
        // memory file is loaded up to a fixed size, so two banks each taking a
        // full index is one index whose tail nobody reads.
        const budget = sharedIndexBudget(records.length);
        install(dueForInstall(records, run.cwd), run.cwd, budget);
        refresh(records, run.cwd, budget);
      } catch (error) {
        // Belt and braces: every step above already catches its own, and a run
        // must not fail because of a memory bank.
        warn('could not prepare the banks for this run', error);
      }
    },

    directoriesFor(profileId) {
      return inScope(profileId).map((record) => record.path);
    },

    settle: () => inFlight,
  };
}
