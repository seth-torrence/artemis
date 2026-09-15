/**
 * The memory banks, read on demand and acted on one click at a time.
 *
 * A hook for the same reason `useSharedConfigStatus` is one: the reading has a
 * lifecycle (in flight, landed, failed) plus a re-read, and the pane also has
 * *actions* whose in-flight state has to dim the right button. Threading
 * that through a component body is how a pane ends up showing a stale bank
 * next to a fresh receipt.
 *
 * **Not in the app store, deliberately** — the same argument as the shared
 * config reading, stronger here: this is a photograph of git clones that
 * agents, hooks, and *other machines'* pull requests change underneath us.
 * Nothing in the app should ever treat it as settled fact; the pane re-reads
 * after every action, and that is the only freshness promised.
 *
 * Memories are fetched per bank, on request, and cached per slug for the
 * pane's lifetime: a machine with three banks should not pay three `list`
 * spawns to render three collapsed cards.
 *
 * Actions run one at a time (`busy` is a single slot, and every button
 * disables while any action runs). Not a technical limit — the CLI serialises
 * itself with locks — but an honest UI one: two in-flight receipts would
 * race for the one `lastAction` line, and the loser's outcome would vanish.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ArtemisBridge,
  IpcResult,
  MemoryBankActionResponse,
  MemoryBankAddRequest,
  MemoryBankMemory,
  MemoryBankPreflight,
  MemoryBankProfileScope,
  MemoryBankRetireRequest,
  MemoryBankVerifyRemoteRequest,
  MemoryBankVerifyRemoteResponse,
  MemoryBanksStatus,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

export type MemoryBankAction =
  | 'add'
  | 'sync'
  | 'retire'
  | 'switch'
  | 'profiles'
  | 'master'
  | 'forget';

/** What the last click came to — the CLI's own words, kept until the next click. */
export interface MemoryBankReceipt {
  readonly ok: boolean;
  readonly message: string;
}

export interface MemoryBanksPane {
  /** A read is in flight. True on first render, before anything is known. */
  readonly reading: boolean;
  /** The last successful status reading, or `null` if there has not been one. */
  readonly status: MemoryBanksStatus | null;
  /**
   * What this machine is missing, with the fix for each.
   *
   * Read alongside status rather than on demand: the pane's primary action is
   * "add a bank", and an enabled button that fails on click because `git` is
   * not installed is the exact experience the check exists to prevent.
   */
  readonly preflight: MemoryBankPreflight | null;
  /**
   * Why the preflight could not be read, already safe to show.
   *
   * Kept rather than folded into `preflight: null`, which is what this used to
   * do. The two states are not the same and the pane renders them
   * differently: `null` with no error means "still asking" and shows a spinner
   * line, while an error means "asked, and here is what went wrong" — most
   * often, on Windows, that the machine has no Python 3 to run the banks' CLI
   * with. Collapsing them left that machine reading "Checking what this
   * machine needs…" forever, which is the one sentence that is never true
   * after the read has finished.
   */
  readonly preflightError: string | null;
  /** Per-bank memories, filled by {@link MemoryBanksPane.loadMemories}. */
  readonly memories: Readonly<Record<string, readonly MemoryBankMemory[]>>;
  /** Why the read failed, already safe to show. Mutually exclusive with {@link status}. */
  readonly error: string | null;
  readonly refresh: () => void;
  /** The action currently running, or `null`. Every button disables while one runs. */
  readonly busy: MemoryBankAction | null;
  readonly lastAction: MemoryBankReceipt | null;
  /** Fetch one bank's memories (cached until the next refresh). */
  readonly loadMemories: (slug: string) => void;
  readonly add: (request: MemoryBankAddRequest) => Promise<boolean>;
  /**
   * Ask whether a remote is readable, without joining it.
   *
   * Deliberately outside the `busy` slot and outside `lastAction`: it changes
   * nothing, its answer belongs beside the URL field that produced it rather
   * than in the pane's one receipt line, and a user who is trying URLs should
   * not have every other button in the pane dim for fifteen seconds each time.
   */
  readonly verifyRemote: (
    request: MemoryBankVerifyRemoteRequest,
  ) => Promise<IpcResult<MemoryBankVerifyRemoteResponse>>;
  readonly sync: (slug?: string) => void;
  readonly retire: (request: MemoryBankRetireRequest) => void;
  /** Wire one bank on or off — the CLI's per-bank switch, honoured by hooks too. */
  readonly setEnabled: (slug: string, enabled: boolean) => void;
  /**
   * Which profiles this bank reaches: every one, or a chosen set.
   *
   * Through the same busy/receipt/refresh path as the switches rather than as
   * an optimistic tick, because it is not a local preference — the scope
   * decides which runs are briefed about the bank and which projects it is
   * installed into, so the answer that matters is the registry's after the
   * write, not the checkbox's before it.
   */
  readonly setProfiles: (slug: string, profiles: MemoryBankProfileScope) => void;
  /** Artemis's master gate: prompt injection + run-start syncs. */
  readonly setMasterEnabled: (enabled: boolean) => void;
  /** Unwire, uninstall, and forget one bank. The repo stays on disk. */
  readonly forget: (slug: string) => void;
}

function banksChannel(): ArtemisBridge['memoryBanks'] | null {
  return resolveBridge().bridge?.memoryBanks ?? null;
}

export function useMemoryBanks(): MemoryBanksPane {
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState(true);
  const [status, setStatus] = useState<MemoryBanksStatus | null>(null);
  const [preflight, setPreflight] = useState<MemoryBankPreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [memories, setMemories] = useState<Record<string, readonly MemoryBankMemory[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<MemoryBankAction | null>(null);
  const [lastAction, setLastAction] = useState<MemoryBankReceipt | null>(null);
  /** Slugs with a `list` in flight, so an expand-collapse-expand does not double-spawn. */
  const loading = useRef(new Set<string>());

  useEffect(() => {
    const channel = banksChannel();
    if (channel === null) {
      setReading(false);
      setError('This window cannot reach the main process.');
      return undefined;
    }

    let cancelled = false;
    setReading(true);
    loading.current.clear();

    void (async () => {
      const statusResult = await call(() => channel.status({}));
      if (cancelled) return;
      if (!statusResult.ok) {
        setReading(false);
        setStatus(null);
        setMemories({});
        setError(statusResult.error.message);
        return;
      }
      // The preflight matters most when nothing is set up yet — it is what
      // gates the add-a-bank flow — but a machine with banks still shows it
      // when something is broken, so it is read either way.
      const preflightResult = await call(() => channel.preflight({}));
      if (cancelled) return;
      setReading(false);
      setStatus(statusResult.value);
      // Both halves are set on every read, and only one of them is ever
      // non-null: a failed preflight must not leave the last successful one on
      // screen next to its error, and a recovered one must clear the error.
      setPreflight(preflightResult.ok ? preflightResult.value : null);
      setPreflightError(preflightResult.ok ? null : preflightResult.error.message);
      setMemories({});
      setError(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const loadMemories = useCallback((slug: string) => {
    const channel = banksChannel();
    if (channel === null) return;
    if (loading.current.has(slug)) return;
    loading.current.add(slug);
    void (async () => {
      const result = await call(() => channel.memories({ slug }));
      loading.current.delete(slug);
      if (result.ok) {
        setMemories((current) => ({ ...current, [slug]: result.value.memories }));
      }
    })();
  }, []);

  const act = useCallback(
    async (
      kind: MemoryBankAction,
      operation: (channel: ArtemisBridge['memoryBanks']) => Promise<IpcResult<MemoryBankActionResponse>>,
    ): Promise<boolean> => {
      const channel = banksChannel();
      if (channel === null) return false;
      setBusy(kind);
      const result = await call(() => operation(channel));
      setBusy(null);
      setLastAction(
        result.ok ? { ok: true, message: result.value.message } : { ok: false, message: result.error.message },
      );
      if (result.ok) refresh();
      return result.ok;
    },
    [refresh],
  );

  const add = useCallback(
    (request: MemoryBankAddRequest) => act('add', (c) => c.add(request)),
    [act],
  );
  const verifyRemote = useCallback(
    async (request: MemoryBankVerifyRemoteRequest): Promise<IpcResult<MemoryBankVerifyRemoteResponse>> => {
      const channel = banksChannel();
      if (channel === null) {
        return {
          ok: false,
          error: { code: 'transport', message: 'This window cannot reach the main process.', retryable: true },
        };
      }
      return call(() => channel.verifyRemote(request));
    },
    [],
  );
  const sync = useCallback(
    (slug?: string) => void act('sync', (c) => c.sync(slug === undefined ? {} : { slug })),
    [act],
  );
  const retire = useCallback(
    (request: MemoryBankRetireRequest) => void act('retire', (c) => c.retire(request)),
    [act],
  );
  const setEnabled = useCallback(
    (slug: string, enabled: boolean) => void act('switch', (c) => c.setEnabled({ slug, enabled })),
    [act],
  );
  const setProfiles = useCallback(
    (slug: string, profiles: MemoryBankProfileScope) =>
      void act('profiles', (c) => c.setProfiles({ slug, profiles })),
    [act],
  );
  const setMasterEnabled = useCallback(
    (enabled: boolean) => void act('master', (c) => c.setMasterEnabled({ enabled })),
    [act],
  );
  const forget = useCallback(
    (slug: string) => void act('forget', (c) => c.forget({ slug })),
    [act],
  );

  return {
    reading,
    status,
    preflight,
    preflightError,
    memories,
    error,
    refresh,
    busy,
    lastAction,
    loadMemories,
    add,
    verifyRemote,
    sync,
    retire,
    setEnabled,
    setProfiles,
    setMasterEnabled,
    forget,
  };
}

/**
 * Just "is the memory-banks prompt actually being sent?".
 *
 * The prompt library needs this one boolean, to decide whether its built-in
 * memory-banks row is currently reaching the model. This used to be its own
 * hook with its own `status` spawn; now that the library and the banks share
 * the Instructions pane — and therefore one {@link useMemoryBanks} reading —
 * it is a pure derivation of that reading, which is the strongest form of the
 * promise the hook made: the two halves cannot disagree, because they are
 * looking at the same photograph.
 *
 * Master on **and** at least one enabled bank present, which is the same
 * conjunction `engine.ts` composes runs with. Two sources of truth for "is
 * this prompt live" is the one failure this surface must not have: it would
 * tell the user a prompt is being sent that main is quietly withholding, or
 * the reverse.
 *
 * `null` while there is no reading — in flight, or failed. Not `false`: "not
 * available" is a claim the pane puts on screen next to a prompt it says is
 * not being sent, and a failed read is not evidence for it.
 */
export function banksAvailability(status: MemoryBanksStatus | null): boolean | null {
  if (status === null) return null;
  return status.masterEnabled && status.banks.some((bank) => bank.enabled && bank.exists);
}

/**
 * The bank directories a run is handed for free, or `[]`.
 *
 * The engine attaches every enabled, present bank to a run as a readable
 * additional directory (see `main/engine.ts` and `banksForRun`), so a
 * folder-picking control can show the user that a bank kept outside the project
 * — Cortex in `~/Documents`, say — is already along for the ride, without their
 * having to add it. The same conjunction the engine and
 * {@link banksAvailability} use: master on, bank enabled, bank present.
 *
 * Status only — no preflight spawn — because this answers a display question,
 * not the add-a-bank flow's readiness one. Empty while the read is in flight and
 * if it fails: a list captioned "already attached" must not claim a folder that
 * is not.
 */
export function useAutoIncludedBankDirectories(): readonly string[] {
  const [dirs, setDirs] = useState<readonly string[]>([]);

  useEffect(() => {
    const channel = banksChannel();
    if (channel === null) return undefined;

    let cancelled = false;
    void (async () => {
      const result = await call(() => channel.status({}));
      if (cancelled || !result.ok) return;
      const { masterEnabled, banks } = result.value;
      setDirs(
        masterEnabled
          ? banks.filter((bank) => bank.enabled && bank.exists).map((bank) => bank.path)
          : [],
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return dirs;
}
