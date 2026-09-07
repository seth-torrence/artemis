/**
 * The Ink root: the whole terminal, laid out.
 *
 * ```
 * ┌ header ── logo · tagline ─────────────────────────── directory ────┐
 * │ conversations│ transcript viewport (bottom-anchored, scrolls)       │
 * │  ▾ folder    │                                                     │
 * │    session   │ permission card / picker / agent view, when open    │
 * │  ▸ folder    │ ╭ composer ─────────────────────────────────────╮   │
 * │              │ ╰────────────────────────────────────────────────╯   │
 * │              │ account · model · mode           5hr · Week · Fable │
 * │ Tab          │ status · spinner · tokens · cost                    │
 * └──────────────┴─────────────────────────────────────────────────────┘
 * ```
 *
 * Who has the keys is decided in exactly one place, here. A modal or a
 * permission card, when open, has them; otherwise focus is either the
 * composer or the sidebar (Tab toggles). Every child takes an `isActive` prop
 * and touches nothing when it is false, so two components never answer the
 * same keystroke. Esc, Ctrl+C and the scrolling arrows are handled globally
 * only when no modal owns them.
 *
 * Slash commands are parsed before anything is sent. The switchers and
 * viewers are pickers over data the host already knows how to fetch:
 *
 *  - `/profile` — the catalogue, which spawns a probe per account and so is
 *    read here, on demand, never at launch. Unusable accounts stay listed,
 *    greyed, with the reason. Switching is refused mid-run and, when it would
 *    end a conversation, confirmed first.
 *  - `/model`   — the account's own model list, then an effort picker if the
 *    model has levels, then a speed picker if it offers fast mode or ultracode.
 *  - `/mode`    — the provider's permission modes, no more. Bypass is red and
 *    asks twice.
 *  - `/resume`  — the account's stored conversations in this directory. The
 *    sidebar shows every project's, worktrees folded into their repository as
 *    the desktop does, and opens one on Enter — moving the working directory
 *    to wherever it ran.
 *  - `/tasks`   — background work as the provider last listed it. A delegated
 *    agent's row opens what it did; a live row offers to stop it.
 *  - `/usage`   — every plan window, fetched now; the line under the composer
 *    keeps the 5-hour, the week and Fable's bucket, as the desktop's rings do.
 *  - `/attach`  — a path, read now, sent with the next message.
 *
 * The settings a picker changes are the *next* turn's; the line under the
 * composer shows what the provider actually reported for the current one.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import {
  PERMISSION_MODES,
  isPermissionMode,
  isTaskLive,
  type AgentEvent,
  type Attachment,
  type BackgroundTask,
  type PermissionMode,
  type PlanUsage,
  type ProfileMetadata,
  type ProviderModelOption,
  type ServerProfile,
  type SessionId,
  type SessionSummary,
} from '@rx-artemis/protocol';
import { formatDuration, formatRelative, formatUntil, oneLine } from '@rx-artemis/transcript';
import { isArchived } from '@rx-artemis/protocol';

import { browseRowLabel, browseRows, browseStart, recentDirectories, shortenPath } from './directories.js';
import { prunePool, railActivityFor } from './pool.js';

import { readAttachment } from './attachments.js';
import { CATALOGUE_KEY, commandsKey, modelsKey, usageKey } from './cache.js';
import { checkForUpdate, currentVersion, installRoot } from './update.js';
import { COMMANDS, parseCommand, type Command } from './commands.js';
import { Conversation, type ConversationSettings } from './conversation.js';
import type { Launched } from './launch.js';
import type { ModelListing } from './host.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { ACCENT } from './theme.js';
import { Composer } from './components/Composer.js';
import { Header } from './components/Header.js';
import { PermissionCard } from './components/PermissionCard.js';
import { Picker, type PickerItem } from './components/Picker.js';
import { Sidebar, railRows, type RailRow } from './components/Sidebar.js';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { describeWorkspace } from '@rx-artemis/core';
import { StatusBar } from './components/StatusBar.js';
import { ReplayRows, TranscriptViewport } from './components/Transcript.js';

export interface AppProps {
  readonly launched: Launched;
}

interface PickerModal {
  readonly kind: 'picker';
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly initialKey?: string;
  readonly hint?: string;
  readonly onSelect: (item: PickerItem) => void;
  /**
   * Which opening this is. A picker that opened on a cached answer is
   * refreshed in place when the fresh one lands — but only if it is still
   * the picker on screen, which the token is how the refresh can tell.
   */
  readonly token?: number;
}

interface LoadingModal {
  readonly kind: 'loading';
  readonly title: string;
}

interface ReplayModal {
  readonly kind: 'replay';
  readonly title: string;
  readonly events: readonly AgentEvent[];
}

type Modal = PickerModal | LoadingModal | ReplayModal;
type Focus = 'composer' | 'sidebar';

/** The row that leaves the recents list for the filesystem. Not a path, so it cannot be one. */
const BROWSE_KEY = '\u0000browse';

const MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};

const MODE_DETAIL: Readonly<Record<PermissionMode, string>> = {
  default: 'prompt for anything not already allowed',
  acceptEdits: 'file edits go through; everything else asks',
  plan: 'research and propose only; no changes',
  auto: 'the provider decides; asks when it judges the risk real',
  dontAsk: 'never prompt — denies instead of asking',
  bypassPermissions: 'approve everything. Dangerous.',
};

const QUIT_WINDOW_MS = 2_000;
/** A plan-usage read is a CLI call; one a minute is the desktop's own tolerance. */
const PLAN_USAGE_MIN_INTERVAL_MS = 60_000;
/** A cached plan reading older than this is not shown while the fresh one is read: the windows will have moved. */
const USAGE_SEED_MAX_AGE_MS = 24 * 60 * 60_000;
/** A model list older than this is re-read at launch, in the background, so `/model` has a fresh one. */
const MODELS_WARM_MAX_AGE_MS = 24 * 60 * 60_000;
/** The key legend, for a picker whose hint has something else to say first. */
const PICKER_KEYS = '↑↓ · Enter · Esc';
/**
 * Below this many columns the rail is dropped; the pickers cover the same
 * ground. The conversation needs about ninety columns to read as prose, and
 * the rail takes thirty-two.
 */
const SIDEBAR_MIN_COLUMNS = 120;
const SIDEBAR_WIDTH = 32;
/** Below this many rows the two-line logo becomes one word. */
const TALL_HEADER_MIN_ROWS = 24;
/** Lines one arrow press scrolls — a wheel tick arrives as a few of these. */
const SCROLL_STEP = 2;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function App({ launched }: AppProps): React.JSX.Element {
  const { host, descriptors, cache, preferences } = launched;
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  /**
   * A conversation, ready to be shown.
   *
   * Everything it can already answer from the last launch is put in before it
   * is drawn once: the plan reading under the composer, and the provider's
   * commands, which `/` is often the first thing typed at. See `cache.ts`.
   */
  const makeConversation = useCallback(
    (settings: ConversationSettings): Conversation => {
      const created = new Conversation({
        driver: host.runs,
        settings,
        capabilitiesFor: (id) => host.capabilitiesFor(id),
      });
      const remembered = cache.get<PlanUsage>(usageKey(settings.profileId));
      if (remembered !== undefined && Date.now() - remembered.at < USAGE_SEED_MAX_AGE_MS) created.setPlanUsage(remembered.value);
      const commands = cache.get<readonly string[]>(commandsKey(settings.profileId, settings.cwd));
      if (commands !== undefined) created.seedSlashCommands(commands.value);
      return created;
    },
    [host, cache],
  );

  /*
   * More than one conversation is alive at a time, and only one is on screen.
   * ------------------------------------------------------------------------
   *
   * Switching used to be refused while a turn was running, which made the one
   * thing worth doing during a long turn — going and reading something else —
   * the one thing you could not do. The registry never needed that: a run has
   * one producer and any number of consumers, and "consumers come and go; the
   * run does not care" (`sessions/registry.ts`). What tied a turn to the
   * screen was this file holding exactly one `Conversation`.
   *
   * So it holds several. Each one subscribes to the registry and keeps only
   * its own run's events, so a parked conversation goes on filling its own
   * transcript — including a permission request, which is why the rail shows
   * that too. Switching back is instant and complete, because nothing was
   * torn down and nothing has to be re-read.
   *
   * The pool is bounded by disposing, on every switch, whatever is neither on
   * screen nor working. What that throws away is a transcript the store
   * already has, so the cost of being wrong is one read.
   */
  const [pool, setPool] = useState<readonly Conversation[]>(() => [makeConversation(launched.settings)]);
  const [conversation, setConversation] = useState<Conversation>(() => pool[0] as Conversation);
  /*
   * Mirrors of the two states above, for callbacks that must read the
   * *current* value without being rebuilt every time it changes — and for the
   * unmount, which runs long after the closure that scheduled it was made.
   */
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const poolRef = useRef(pool);
  poolRef.current = pool;

  useEffect(
    () => () => {
      for (const alive of poolRef.current) alive.dispose();
    },
    [],
  );

  const switchTo = useCallback((next: Conversation) => {
    if (next === conversationRef.current) return;
    // Decided by `prunePool`, disposed here: the rule is pure and tested, and
    // a state updater with side effects is a thing React may run twice.
    const { kept, dropped } = prunePool(poolRef.current, next, (parked) => parked.isLive);
    for (const gone of dropped) gone.dispose();
    poolRef.current = kept;
    setPool(kept);
    conversationRef.current = next;
    setConversation(next);
    setScroll(0);
  }, []);

  const state = useSyncExternalStore(conversation.subscribe, conversation.getState);

  /*
   * A parked conversation has no other way to reach the screen: nothing here
   * re-renders when *its* run moves, so the rail would show it working for as
   * long as it took to touch a key. One listener each, and the rail is honest.
   */
  const [parkedTick, setParkedTick] = useState(0);
  const parkedWentIdle = useRef(false);
  useEffect(() => {
    const offs = pool
      .filter((parked) => parked !== conversation)
      .map((parked) => {
        let was = parked.getState().status;
        return parked.subscribe(() => {
          const now = parked.getState().status;
          // A parked turn finishing is the one change the rail's *list* has
          // to hear about — its title and time have moved in the store — and
          // the active conversation's own idle transitions are already
          // watched. Flagged here, acted on below, so the effect that owns
          // `refreshRail` does not have to be rebuilt per parked conversation.
          if (was !== 'idle' && now === 'idle') parkedWentIdle.current = true;
          was = now;
          setParkedTick((n) => n + 1);
        });
      });
    return () => {
      for (const off of offs) off();
    };
  }, [pool, conversation]);

  /** What each conversation is doing, for the glyph in front of its title. */
  const railActivity = useMemo(
    () => railActivityFor(pool.map((parked) => parked.getState())),
    // `parkedTick` is the signal that a parked conversation moved; `state`,
    // that the one on screen did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, parkedTick, state],
  );
  const { transcript } = conversation;

  const [modal, setModal] = useState<Modal | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [flash, setFlash] = useState<string | undefined>(undefined);
  const [update, setUpdate] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<Focus>('composer');
  const [scroll, setScroll] = useState(0);
  /** How far back the viewport can go, as it last measured itself. */
  const scrollExtent = useRef({ maxOffset: 0, viewportLines: 0 });
  const onScrollExtent = useCallback((extent: { readonly maxOffset: number; readonly viewportLines: number }) => {
    scrollExtent.current = extent;
  }, []);
  const scrollBy = useCallback((lines: number) => {
    // Past the top is allowed by one screen: the viewport draws more rows as
    // the offset nears the top of what it has, and clamps what it shows.
    setScroll((current) => Math.max(0, Math.min(current + lines, scrollExtent.current.maxOffset + scrollExtent.current.viewportLines)));
  }, []);
  const [pendingAttachments, setPendingAttachments] = useState<readonly { name: string; attachment: Attachment }[]>([]);
  const quitArmed = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planFetchedAt = useRef(0);
  const pickerToken = useRef(0);

  const pendingRequest = state.pendingPermissions[0];
  const workspace = basename(state.settings.cwd) || state.settings.cwd;
  const live = state.status !== 'idle';
  const locked = live && !state.capabilities.midRunSteering;

  const say = useCallback(
    (level: 'info' | 'warn' | 'error', text: string, detail?: string) => {
      transcript.note(level, text, detail);
    },
    [transcript],
  );

  const showFlash = useCallback((text: string) => {
    setFlash(text);
    setTimeout(() => setFlash(undefined), QUIT_WINDOW_MS).unref?.();
  }, []);

  // A new row arriving while scrolled back is the one moment "follow" would
  // hide something; anything else that changes the transcript keeps the
  // person where they were.
  useEffect(() => {
    if (live) setScroll(0);
  }, [live]);

  /* ---------------------------------------------------------------------- */
  /* The rail's data                                                         */
  /* ---------------------------------------------------------------------- */

  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [accounts, setAccounts] = useState<readonly ProfileMetadata[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railIndex, setRailIndex] = useState(0);
  // Folders unfolded in the rail, keyed by project root. The current one is
  // always open.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set());
  // Folders showing every conversation rather than the newest few.
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Directory → project root. A worktree maps to its main checkout, which is
   * what folds worktrees into one folder; an unresolved directory is its own
   * project until the answer lands.
   *
   * Resolved *before* a session list is shown, never after: a row that first
   * paints under a directory-named folder and then jumps into its repository's
   * reads as the rail reordering itself. The ref is the source of truth so a
   * refresh can consult it without waiting for a render; the state is what the
   * rail re-renders on.
   */
  const [projectRoots, setProjectRoots] = useState<Readonly<Record<string, string>>>({});
  const projectRootsRef = useRef<Readonly<Record<string, string>>>({});
  const projectOf = useCallback((cwd: string) => projectRoots[cwd] ?? cwd, [projectRoots]);
  const resolveProjectRoots = useCallback(async (cwds: readonly string[]) => {
    const unresolved = [...new Set(cwds)].filter((cwd) => projectRootsRef.current[cwd] === undefined);
    if (unresolved.length === 0) return;
    const pairs = await Promise.all(
      unresolved.map(async (cwd) => {
        try {
          const description = await describeWorkspace(cwd);
          return [cwd, description.projectRoot ?? description.repoRoot ?? cwd] as const;
        } catch {
          return [cwd, cwd] as const;
        }
      }),
    );
    projectRootsRef.current = { ...projectRootsRef.current, ...Object.fromEntries(pairs) };
    setProjectRoots(projectRootsRef.current);
  }, []);

  const refreshRail = useCallback(async () => {
    try {
      const metadata = (await host.profiles.listMetadata()).filter((profile) => profile.disabled !== true);
      setAccounts(metadata);
      const list = await host.listSessionsAcross(metadata.map((profile) => ({ id: profile.id, providerId: profile.providerId })));
      await resolveProjectRoots(list.map((session) => session.cwd));
      setSessions(list);
    } catch {
      // The rail is a convenience over the pickers; a failed read leaves it as it was.
    } finally {
      setRailLoading(false);
    }
  }, [host, resolveProjectRoots]);

  useEffect(() => {
    void refreshRail();
  }, [refreshRail]);
  useEffect(() => {
    if (state.status === 'idle' && state.sessionId !== undefined) void refreshRail();
  }, [state.status, state.sessionId, refreshRail]);
  useEffect(() => {
    if (!parkedWentIdle.current) return;
    parkedWentIdle.current = false;
    void refreshRail();
  }, [parkedTick, refreshRail]);
  /*
   * Whatever the settings line says is what the next launch opens as.
   *
   * Watched here rather than written at each picker, because there are five
   * ways to change these — three pickers, a flag on a slash command, and
   * opening someone else's conversation from the rail — and a save at each is
   * five chances to forget one. The model is stored against the account it
   * belongs to; see `preferences.ts`.
   */
  useEffect(() => {
    const { profileId, permissionMode, model, modelLabel, effort, fastMode, ultracode } = state.settings;
    preferences.save({ profileId, permissionMode });
    preferences.saveModelFor(profileId, {
      ...(model === undefined ? {} : { model }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(effort === undefined ? {} : { effort }),
      ...(fastMode === undefined ? {} : { fastMode }),
      ...(ultracode === undefined ? {} : { ultracode }),
    });
  }, [
    preferences,
    state.settings.profileId,
    state.settings.permissionMode,
    state.settings.model,
    state.settings.modelLabel,
    state.settings.effort,
    state.settings.fastMode,
    state.settings.ultracode,
  ]);

  // The working directory can change without the list doing so (`/cwd`).
  useEffect(() => {
    void resolveProjectRoots([state.settings.cwd]);
  }, [state.settings.cwd, resolveProjectRoots]);

  const currentProject = projectOf(state.settings.cwd);
  useEffect(() => {
    setOpenFolders((current) => (current.has(currentProject) ? current : new Set([...current, currentProject])));
  }, [currentProject]);

  const accountOf = useCallback(
    (session: SessionSummary): string | undefined =>
      session.profileId === state.settings.profileId
        ? undefined
        : accounts.find((profile) => profile.id === session.profileId)?.label ?? 'another account',
    [accounts, state.settings.profileId],
  );
  const rail: readonly RailRow[] = useMemo(
    () => railRows(sessions, openFolders, projectOf, accountOf, expandedFolders),
    [sessions, openFolders, projectOf, accountOf, expandedFolders],
  );

  /* ---------------------------------------------------------------------- */
  /* Plan usage                                                              */
  /* ---------------------------------------------------------------------- */

  const refreshPlanUsage = useCallback(
    async (force = false): Promise<void> => {
      if (!force && Date.now() - planFetchedAt.current < PLAN_USAGE_MIN_INTERVAL_MS) return;
      planFetchedAt.current = Date.now();
      try {
        const usage = await host.fetchPlanUsage(state.settings.profileId, state.settings.providerId);
        conversation.setPlanUsage(usage);
        // Only a real reading is worth remembering; "could not read" is not.
        if (usage !== null && usage.available) cache.set(usageKey(state.settings.profileId), usage);
      } catch {
        // A gauge that cannot be read is a gauge that is not shown.
      }
    },
    [host, cache, state.settings.profileId, state.settings.providerId, conversation],
  );

  /** What the line under the composer shows for an account before its fresh reading lands. */
  const seedPlanUsage = useCallback(
    (profileId: string) => {
      const remembered = cache.get<PlanUsage>(usageKey(profileId));
      conversation.setPlanUsage(
        remembered !== undefined && Date.now() - remembered.at < USAGE_SEED_MAX_AGE_MS ? remembered.value : null,
      );
    },
    [cache, conversation],
  );

  /**
   * The provider's own slash commands — the user's skills among them — read
   * now and remembered, so the next launch in this directory has them before
   * the first frame rather than a second after it.
   */
  const refreshCommands = useCallback(async (): Promise<void> => {
    const { profileId, providerId, cwd } = state.settings;
    try {
      const commands = await host.listCommands(profileId, providerId, cwd);
      if (commands.length === 0) return;
      cache.set(commandsKey(profileId, cwd), commands);
      conversation.seedSlashCommands(commands);
    } catch {
      // The menu keeps whatever it had; a run will report the rest.
    }
  }, [host, cache, conversation, state.settings]);

  /*
   * Asked again when the account or the directory changes, because both
   * change the answer: commands are discovered relative to a working
   * directory, and an account's plugins are its own. The cached list for
   * wherever we have arrived goes up first, as at launch.
   */
  useEffect(() => {
    const { profileId, cwd } = state.settings;
    const remembered = cache.get<readonly string[]>(commandsKey(profileId, cwd));
    if (remembered !== undefined) conversation.seedSlashCommands(remembered.value);
    const timer = setTimeout(() => void refreshCommands(), 1_500);
    return () => clearTimeout(timer);
  }, [cache, conversation, refreshCommands, state.settings.profileId, state.settings.cwd]);

  /** The account's model list, read now and remembered for the next `/model` and the next launch. */
  const readModels = useCallback(async (): Promise<ModelListing> => {
    const listing = await host.listModels(state.settings.profileId, state.settings.providerId);
    if (listing.live) cache.set(modelsKey(state.settings.profileId), listing);
    return listing;
  }, [host, cache, state.settings.profileId, state.settings.providerId]);

  /*
   * What the screen needs but did not wait for, a beat after the first frame
   * so the probes do not race it: the plan windows, and — when the remembered
   * model list is a day old or missing — a fresh one, so that `/model` costs
   * nothing later. The commands have an effect of their own above, because
   * they have to be re-asked when the directory changes.
   *
   * Concurrently, because they are independent CLI calls and running them in
   * a line made the last of them seconds late.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const known = cache.get(modelsKey(state.settings.profileId));
      void Promise.all([
        refreshPlanUsage(true),
        known === undefined || Date.now() - known.at > MODELS_WARM_MAX_AGE_MS
          ? // The picker will ask again when it is opened.
            readModels().catch(() => undefined)
          : undefined,
      ]).then(
        async () => {
          // An installed copy learns, once a day, whether a newer release
          // exists; a checkout does not need telling. See `update.ts`.
          if (installRoot() === undefined) return;
          const newer = await checkForUpdate(currentVersion(), cache);
          if (newer !== null) setUpdate(newer);
        },
        () => undefined,
      );
    }, 1_500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state.status === 'idle' && state.sessionId !== undefined) void refreshPlanUsage();
  }, [state.status, state.sessionId, refreshPlanUsage]);

  /* ---------------------------------------------------------------------- */
  /* Resume                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Show a stored conversation, reading it in if it is not already alive.
   *
   * Three cases, in order: it is the one on screen, and nothing happens; it is
   * one of the parked ones, and switching is instant because its transcript
   * and its run were never let go of; or it is neither, and it is read from
   * the store into a conversation of its own.
   *
   * `into` is the account and directory it belongs to, for a conversation
   * from elsewhere in the rail. Without it the current ones are used, which is
   * what `/resume` and `--resume` want — they only ever name a conversation
   * from here.
   */
  const loadSession = useCallback(
    async (sessionId: SessionId, title: string, into?: ConversationSettings): Promise<void> => {
      const current = conversationRef.current;
      if (current.getState().sessionId === sessionId) return;
      const parked = pool.find((candidate) => candidate.getState().sessionId === sessionId);
      if (parked !== undefined) {
        switchTo(parked);
        return;
      }
      const settings = into ?? current.getState().settings;
      setModal({ kind: 'loading', title: `Opening ${oneLine(title, 60)}…` });
      try {
        const events = await host.sessionMessages(settings.profileId, settings.providerId, sessionId, settings.cwd);
        setModal(null);
        const next = makeConversation(settings);
        const outcome = next.loadHistory(sessionId, events);
        if (!outcome.ok) {
          next.dispose();
          setNotice(outcome.reason);
          return;
        }
        switchTo(next);
      } catch (error) {
        setModal(null);
        say('error', `Could not open that conversation: ${describeError(error)}`);
      }
    },
    [host, pool, makeConversation, switchTo, say],
  );

  const openResumePicker = useCallback(
    async (latest = false) => {
      setModal({ kind: 'loading', title: 'Conversations — reading the store…' });
      try {
        // The picker's own list: one account, this directory. The rail keeps
        // its cross-account, cross-project list.
        const list = await host.listSessions(state.settings.profileId, state.settings.providerId, state.settings.cwd);
        if (list.length === 0) {
          setModal(null);
          say('info', `No stored conversations for ${state.settings.profileLabel} in ${workspace}.`);
          return;
        }
        if (latest) {
          const newest = list[0];
          if (newest !== undefined) await loadSession(newest.id, newest.title);
          return;
        }
        const items: PickerItem[] = list.map((session) => ({
          key: session.id,
          label: oneLine(session.title, 70),
          detail: [formatRelative(session.updatedAt), session.model, session.gitBranch]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join(' · '),
          ...(session.id === state.sessionId ? { note: 'this conversation' } : {}),
        }));
        setModal({
          kind: 'picker',
          title: `Conversations in ${workspace}`,
          items,
          ...(state.sessionId === undefined ? {} : { initialKey: state.sessionId }),
          onSelect: (item) => {
            const session = list.find((candidate) => candidate.id === item.key);
            setModal(null);
            if (session === undefined || session.id === state.sessionId) return;
            void loadSession(session.id, session.title);
          },
        });
      } catch (error) {
        setModal(null);
        say('error', `Could not list conversations: ${describeError(error)}`);
      }
    },
    [host, state.settings, state.sessionId, workspace, say, loadSession],
  );

  // `artemis -c` / `--resume <id>`: act once the screen exists.
  const resumedOnLaunch = useRef(false);
  useEffect(() => {
    if (resumedOnLaunch.current || launched.resume === undefined) return;
    resumedOnLaunch.current = true;
    if (launched.resume === 'latest') void openResumePicker(true);
    else void loadSession(launched.resume as SessionId, launched.resume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Pickers                                                                 */
  /* ---------------------------------------------------------------------- */

  const openPicker = useCallback((picker: Omit<PickerModal, 'kind'>) => {
    setModal({ kind: 'picker', ...picker });
  }, []);

  const confirm = useCallback(
    (title: string, yes: string, danger: boolean, onYes: () => void) => {
      openPicker({
        title,
        items: [
          { key: 'no', label: 'Not now' },
          { key: 'yes', label: yes, danger },
        ],
        initialKey: 'no',
        onSelect: (item) => {
          setModal(null);
          if (item.key === 'yes') onYes();
        },
      });
    },
    [openPicker],
  );

  /** The one door to another account, from the picker or the rail. */
  const switchAccount = useCallback(
    (profile: { readonly id: string; readonly label: string; readonly providerId: string; readonly providerLabel: string }) => {
      if (profile.id === state.settings.profileId) return;
      const fresh: ConversationSettings = {
        ...state.settings,
        profileId: profile.id as never,
        providerId: profile.providerId as never,
        profileLabel: profile.label,
        providerLabel: profile.providerLabel,
        model: undefined,
        modelLabel: undefined,
        effort: undefined,
        fastMode: undefined,
        ultracode: undefined,
      };
      const apply = (): void => {
        planFetchedAt.current = 0;
        /*
         * A conversation belongs to the account it started on, so a new one
         * is begun on the other account. While this one is still working it
         * is parked rather than reset — the same rule as `startNew` — so
         * switching account no longer has to wait for a turn to end.
         */
        if (conversation.isLive) {
          switchTo(makeConversation(fresh));
        } else {
          const outcome = conversation.updateSettings(fresh);
          if (!outcome.ok) {
            setNotice(outcome.reason);
            return;
          }
          seedPlanUsage(profile.id);
        }
        say('info', `Now running as ${profile.label} (${profile.providerLabel}). New conversation.`);
      };
      if (state.sessionId !== undefined && !conversation.isLive) {
        confirm('Switching account ends this conversation.', `Switch to ${profile.label} and start fresh`, false, apply);
      } else {
        apply();
      }
    },
    [state.settings, state.sessionId, conversation, confirm, say, seedPlanUsage, switchTo, makeConversation],
  );

  /*
   * The two pickers that cost a subprocess open on the remembered answer and
   * refresh in place, so the wait is paid behind a usable list rather than in
   * front of an empty one. The first launch on a machine still waits: there is
   * nothing to show yet, and a picker with no rows would be worse than a line
   * saying why.
   */
  const openProfilePicker = useCallback(async () => {
    const token = ++pickerToken.current;
    const present = (catalogue: readonly ServerProfile[], metadata: readonly ProfileMetadata[]): Omit<PickerModal, 'kind'> => {
      const keyed = new Map(metadata.map((profile) => [profile.id, profile]));
      const items: PickerItem[] = catalogue.map((row) => {
        const meta = keyed.get(row.id);
        const current = row.id === state.settings.profileId;
        let reason: string | undefined;
        if (!row.available) reason = row.unavailableReason ?? 'not available on this machine';
        else if (row.disabled) reason = 'hidden in Artemis';
        else if (row.auth?.loggedIn === false) reason = 'not signed in';
        else if (meta?.hasApiKey === true) reason = "its key is stored by the desktop app and can't be read here";
        return {
          key: row.id,
          label: row.label,
          detail: `${row.provider.label}${row.auth?.email !== undefined ? ` · ${row.auth.email}` : ''}${current ? ' · current' : ''}`,
          disabled: reason !== undefined,
          ...(reason === undefined ? {} : { reason }),
        };
      });
      return {
        title: 'Accounts',
        items,
        initialKey: state.settings.profileId,
        token,
        onSelect: (item) => {
          setModal(null);
          const row = catalogue.find((candidate) => candidate.id === item.key);
          if (row === undefined) return;
          switchAccount({ id: row.id, label: row.label, providerId: row.provider.id, providerLabel: row.provider.label });
        },
      };
    };
    const remembered = cache.get<readonly ServerProfile[]>(CATALOGUE_KEY);
    if (remembered === undefined) setModal({ kind: 'loading', title: 'Accounts — asking each one how it is…' });
    else openPicker({ ...present(remembered.value, await host.profiles.listMetadata()), hint: `asking each one how it is… · ${PICKER_KEYS}` });
    try {
      const [catalogue, metadata] = await Promise.all([host.catalogue.read(), host.profiles.listMetadata()]);
      cache.set(CATALOGUE_KEY, catalogue);
      const fresh = present(catalogue, metadata);
      if (remembered === undefined) openPicker(fresh);
      else setModal((current) => (current?.kind === 'picker' && current.token === token ? { ...current, ...fresh, hint: undefined } : current));
    } catch (error) {
      if (remembered === undefined) {
        setModal(null);
        say('error', `Could not list accounts: ${describeError(error)}`);
      } else {
        setModal((current) =>
          current?.kind === 'picker' && current.token === token ? { ...current, hint: `could not ask — this is the last answer · ${PICKER_KEYS}` } : current,
        );
      }
    }
  }, [host, cache, state.settings.profileId, openPicker, switchAccount, say]);

  const openSpeedPicker = useCallback(
    (model: ProviderModelOption) => {
      const items: PickerItem[] = [{ key: 'normal', label: 'Normal', detail: 'the model as it comes' }];
      if (model.supportsFastMode === true) items.push({ key: 'fast', label: 'Fast', detail: 'less reasoning, quicker replies' });
      if (model.supportsUltracode === true) items.push({ key: 'ultracode', label: 'Ultracode', detail: 'maximum effort, multi-agent where offered' });
      const current = state.settings.fastMode === true ? 'fast' : state.settings.ultracode === true ? 'ultracode' : 'normal';
      openPicker({
        title: 'Speed',
        items,
        initialKey: current,
        onSelect: (item) => {
          setModal(null);
          conversation.updateSettings({ fastMode: item.key === 'fast', ultracode: item.key === 'ultracode' });
        },
      });
    },
    [openPicker, conversation, state.settings.fastMode, state.settings.ultracode],
  );

  const openEffortPicker = useCallback(
    (model: ProviderModelOption) => {
      const descriptor = descriptors.get(state.settings.providerId);
      const all = descriptor?.effortLevels ?? [];
      const allowed = model.effortLevels === undefined ? all : all.filter((level) => model.effortLevels?.includes(level.id));
      const next = (): void => {
        if (model.supportsFastMode === true || model.supportsUltracode === true) openSpeedPicker(model);
      };
      if (allowed.length === 0) {
        next();
        return;
      }
      openPicker({
        title: `Effort for ${model.label}`,
        items: [
          { key: '', label: 'Default', detail: "the provider's own choice" },
          ...allowed.map((level) => ({ key: level.id, label: level.label, detail: level.note })),
        ],
        initialKey: state.settings.effort ?? '',
        onSelect: (item) => {
          setModal(null);
          conversation.updateSettings({ effort: item.key === '' ? undefined : item.key });
          next();
        },
      });
    },
    [descriptors, state.settings.providerId, state.settings.effort, openPicker, conversation, openSpeedPicker],
  );

  const openModelPicker = useCallback(async () => {
    const token = ++pickerToken.current;
    const present = (listing: ModelListing): Omit<PickerModal, 'kind'> => {
      const items: PickerItem[] = [
        { key: '', label: 'Provider default', detail: 'whatever the CLI would pick' },
        ...listing.models.map((model) => ({
          key: model.id,
          label: model.label,
          detail: model.displayName !== undefined && model.displayName !== model.label ? model.displayName : model.note,
        })),
      ];
      return {
        title: listing.live ? 'Models' : 'Models (built-in list — the account did not confirm it)',
        items,
        initialKey: state.settings.model ?? '',
        token,
        onSelect: (item) => {
          setModal(null);
          if (item.key === '') {
            conversation.updateSettings({ model: undefined, modelLabel: undefined, effort: undefined, fastMode: undefined, ultracode: undefined });
            return;
          }
          const model = listing.models.find((candidate) => candidate.id === item.key);
          if (model === undefined) return;
          conversation.updateSettings({ model: model.id, modelLabel: model.label, effort: undefined, fastMode: undefined, ultracode: undefined });
          openEffortPicker(model);
        },
      };
    };
    const remembered = cache.get<ModelListing>(modelsKey(state.settings.profileId));
    if (remembered === undefined) setModal({ kind: 'loading', title: 'Models — asking the account…' });
    else openPicker({ ...present(remembered.value), hint: `asking the account… · ${PICKER_KEYS}` });
    try {
      const fresh = present(await readModels());
      if (remembered === undefined) openPicker(fresh);
      else setModal((current) => (current?.kind === 'picker' && current.token === token ? { ...current, ...fresh, hint: undefined } : current));
    } catch (error) {
      if (remembered === undefined) {
        setModal(null);
        say('error', `Could not list models: ${describeError(error)}`);
      } else {
        setModal((current) =>
          current?.kind === 'picker' && current.token === token ? { ...current, hint: `could not ask — this is the last list · ${PICKER_KEYS}` } : current,
        );
      }
    }
  }, [cache, readModels, state.settings.profileId, state.settings.model, openPicker, conversation, openEffortPicker, say]);

  const applyMode = useCallback(
    (mode: PermissionMode) => {
      conversation.updateSettings({ permissionMode: mode });
      say('info', `Permission mode: ${MODE_LABEL[mode]}.${conversation.isLive ? ' Takes effect on the next turn.' : ''}`);
    },
    [conversation, say],
  );

  const openModePicker = useCallback(() => {
    const available = PERMISSION_MODES.filter((mode) => state.capabilities.permissionModes.includes(mode));
    openPicker({
      title: `Permission mode — ${state.settings.providerLabel}`,
      items: available.map((mode) => ({
        key: mode,
        label: MODE_LABEL[mode],
        detail: MODE_DETAIL[mode],
        danger: mode === 'bypassPermissions',
      })),
      initialKey: state.settings.permissionMode,
      onSelect: (item) => {
        setModal(null);
        const mode = item.key as PermissionMode;
        if (mode === 'bypassPermissions') {
          confirm('Approve every tool call without asking?', 'Yes — bypass all permission prompts', true, () => applyMode(mode));
        } else {
          applyMode(mode);
        }
      },
    });
  }, [openPicker, state.capabilities.permissionModes, state.settings.providerLabel, state.settings.permissionMode, confirm, applyMode]);

  /* ---------------------------------------------------------------------- */
  /* Tasks and usage                                                         */
  /* ---------------------------------------------------------------------- */

  const describeTask = (task: BackgroundTask): string => {
    const parts = [task.status, task.subagentType ?? task.workflowName ?? task.kind.replace(/^local_/, '')];
    const elapsed = (task.endedAt ?? Date.now()) - task.startedAt;
    if (elapsed > 0) parts.push(formatDuration(elapsed));
    if (task.summary !== undefined) parts.push(oneLine(task.summary, 60));
    return parts.join(' · ');
  };

  const openTaskTranscript = useCallback(
    async (task: BackgroundTask) => {
      const sessionId = state.sessionId;
      if (sessionId === undefined) {
        setNotice('No session to read the agent from yet.');
        return;
      }
      setModal({ kind: 'loading', title: `Reading what "${oneLine(task.description, 50)}" did…` });
      try {
        const events = await host.subagentMessages(
          state.settings.profileId,
          state.settings.providerId,
          sessionId,
          task.id,
          state.settings.cwd,
        );
        setModal({ kind: 'replay', title: oneLine(task.description, 90), events });
      } catch (error) {
        setModal(null);
        say('error', `Could not read that agent's transcript: ${describeError(error)}`);
      }
    },
    [host, state.sessionId, state.settings, say],
  );

  const openTasksPicker = useCallback(() => {
    const tasks = state.tasks.filter((task) => task.ambient !== true);
    if (tasks.length === 0) {
      say('info', 'No background work has been reported in this conversation.');
      return;
    }
    const canRead = state.capabilities.subagentTranscripts;
    openPicker({
      title: 'Background work',
      items: tasks.map((task) => ({
        key: task.id,
        label: oneLine(task.description, 70),
        detail: describeTask(task),
        ...(task.error !== undefined ? { note: oneLine(task.error, 100) } : {}),
      })),
      hint: canRead ? '↑↓ move · Enter opens what it did, or stops it · Esc back' : '↑↓ move · Enter stops a live task · Esc back',
      onSelect: (item) => {
        const task = tasks.find((candidate) => candidate.id === item.key);
        setModal(null);
        if (task === undefined) return;
        const delegated = task.subagentType !== undefined || task.kind.includes('agent') || task.kind.includes('workflow');
        if (delegated && canRead) {
          void openTaskTranscript(task);
        } else if (isTaskLive(task)) {
          confirm(`Stop "${oneLine(task.description, 50)}"?`, 'Stop it', true, () => {
            void conversation.stopTask(task.id).then((outcome) => {
              if (!outcome.ok) setNotice(outcome.reason);
            });
          });
        } else {
          say('info', `${oneLine(task.description, 80)} — ${describeTask(task)}`, task.outputFile === undefined ? undefined : `output: ${task.outputFile}`);
        }
      },
    });
  }, [state.tasks, state.capabilities.subagentTranscripts, openPicker, openTaskTranscript, confirm, conversation, say]);

  const showUsage = useCallback(async () => {
    await refreshPlanUsage(true);
    const usage = conversation.getState().planUsage;
    if (usage === null) {
      say('info', `${state.settings.providerLabel} reports no plan windows for this account.`);
      return;
    }
    if (!usage.available) {
      say('info', usage.unavailableReason ?? 'No plan limits apply to this account.');
      return;
    }
    const lines = usage.windows.map((window) => {
      const used = window.utilization === null ? 'unknown' : `${String(Math.round(window.utilization))}% used`;
      const resets = window.resetsAt === null ? '' : ` · resets ${formatUntil(window.resetsAt)}`;
      return `${window.label.padEnd(14)} ${used}${resets}`;
    });
    say('info', `Plan${usage.subscriptionType !== undefined ? ` · ${usage.subscriptionType}` : ''}`, lines.join('\n'));
  }, [refreshPlanUsage, conversation, say, state.settings.providerLabel]);

  /* ---------------------------------------------------------------------- */
  /* Commands and messages                                                   */
  /* ---------------------------------------------------------------------- */

  const attach = useCallback(
    async (args: string) => {
      if (args.length === 0) {
        say(
          'info',
          pendingAttachments.length === 0
            ? 'Nothing attached. /attach <path> queues a file for the next message.'
            : `Attached: ${pendingAttachments.map((entry) => entry.name).join(', ')}`,
        );
        return;
      }
      if (args === 'clear' || args === 'none') {
        setPendingAttachments([]);
        return;
      }
      const result = await readAttachment(args, state.settings.cwd);
      if (!result.ok) {
        setNotice(result.reason);
        return;
      }
      const kind = result.attachment.kind;
      if (kind === 'image' && !state.capabilities.imageInput) {
        setNotice(`${state.settings.providerLabel} cannot take images.`);
        return;
      }
      if (kind === 'file' && !state.capabilities.fileInput) {
        setNotice(`${state.settings.providerLabel} cannot take file attachments.`);
        return;
      }
      const name = result.attachment.kind === 'image' ? result.attachment.name ?? 'image' : result.attachment.name;
      setPendingAttachments((current) => [...current, { name, attachment: result.attachment }]);
    },
    [pendingAttachments, state.settings.cwd, state.settings.providerLabel, state.capabilities, say],
  );

  /**
   * Begin again, on the same account and in the same directory.
   *
   * A conversation still working is left to work — parked in the pool, shown
   * in the rail — and the new one starts beside it. Only an idle conversation
   * is reset in place, which costs nothing and keeps the pool small.
   */
  const startNew = useCallback(() => {
    const current = conversationRef.current;
    if (current.isLive) {
      switchTo(makeConversation(current.getState().settings));
      return;
    }
    const outcome = current.reset();
    if (!outcome.ok) setNotice(outcome.reason);
    else setScroll(0);
  }, [makeConversation, switchTo]);

  /**
   * Work in `target`, starting fresh there.
   *
   * A conversation belongs to the directory it started in — that is what the
   * provider files it under and what the rail groups it by — so moving is a
   * new conversation rather than the same one relocated, and the message says
   * so. The path arrives already chosen from a list, but it is still checked:
   * a recent folder is a folder that existed when a conversation ran in it,
   * which is not the same as one that exists now.
   */
  const moveToDirectory = useCallback(
    async (target: string) => {
      if (target === conversationRef.current.getState().settings.cwd) {
        startNew();
        return;
      }
      try {
        if (!(await stat(target)).isDirectory()) {
          say('error', `${target} is not a directory.`);
          return;
        }
      } catch {
        say('error', `${target} is gone, or cannot be read.`);
        return;
      }
      // A new conversation there, rather than this one moved: the directory
      // is what the provider files a conversation under, and the one on
      // screen may still be working in the directory it started in.
      switchTo(makeConversation({ ...conversationRef.current.getState().settings, cwd: target }));
      say('info', `Working in ${target}. New conversation.`);
    },
    [makeConversation, switchTo, say, startNew],
  );

  /**
   * Walk the filesystem for a folder nothing has run in yet.
   *
   * One picker per directory, rebuilt on each step, rather than a component
   * with its own cursor: the rows are a list to choose from like every other
   * list in here, and reusing the picker means the scrolling, the keys and the
   * look are the ones already learned. The first row chooses where you have
   * arrived, so accepting a folder is Enter and there is no second key.
   */
  const openBrowser = useCallback(
    (path: string): void => {
      void (async () => {
        const home = homedir();
        let entries: Dirent[];
        try {
          entries = await readdir(path, { withFileTypes: true });
        } catch {
          say('error', `Cannot read ${path}.`);
          setModal(null);
          return;
        }
        const rows = browseRows(path, entries);
        setModal({
          kind: 'picker',
          title: `Browse — ${shortenPath(path, home)}`,
          items: rows.map((row, i) => ({
            key: String(i),
            label: browseRowLabel(row, home),
            ...(row.kind === 'choose' ? { detail: shortenPath(path, home) } : {}),
          })),
          hint: '↑↓ move · Enter open · first row chooses · Esc back',
          onSelect: (item) => {
            const row = rows[Number(item.key)];
            if (row === undefined) return;
            if (row.kind === 'choose') {
              setModal(null);
              void moveToDirectory(row.path);
              return;
            }
            openBrowser(row.path);
          },
        });
      })();
    },
    [say, moveToDirectory],
  );

  /**
   * Where to work: the folders already worked in, and browsing for one that
   * is not there yet.
   *
   * Recents first and browsing last, because the folder someone wants is
   * nearly always one they have been in before — the same order, and the same
   * reasoning, as the control above the desktop's composer.
   */
  const openDirectoryPicker = useCallback(() => {
    const home = homedir();
    const recents = recentDirectories(sessions, state.settings.cwd, home);
    setModal({
      kind: 'picker',
      title: 'New conversation in…',
      initialKey: state.settings.cwd,
      items: [
        ...recents.map((recent) => ({
          key: recent.path,
          label: recent.label,
          ...(recent.path === state.settings.cwd
            ? { detail: 'here' }
            : recent.count > 0
              ? { detail: `${formatRelative(recent.updatedAt)} · ${String(recent.count)}` }
              : {}),
        })),
        { key: BROWSE_KEY, label: 'Browse folders…', detail: 'somewhere new' },
      ],
      onSelect: (item) => {
        if (item.key === BROWSE_KEY) {
          openBrowser(browseStart(state.settings.cwd));
          return;
        }
        setModal(null);
        void moveToDirectory(item.key);
      },
    });
  }, [sessions, state.settings.cwd, moveToDirectory, openBrowser]);

  const runCommand = useCallback(
    (command: Command) => {
      switch (command.name) {
        case 'help':
          say('info', 'Commands', COMMANDS.map((spec) => `${spec.usage.padEnd(16)} ${spec.summary}`).join('\n'));
          return;
        case 'cwd':
          openDirectoryPicker();
          return;
        case 'quit':
          exit();
          return;
        case 'new':
          startNew();
          return;
        case 'profile':
          void openProfilePicker();
          return;
        case 'model':
          if (command.args.length > 0) {
            conversation.updateSettings({ model: command.args, modelLabel: command.args, effort: undefined });
            say('info', `Model: ${command.args}`);
            return;
          }
          void openModelPicker();
          return;
        case 'mode':
          if (command.args.length > 0) {
            const wanted = command.args;
            if (!isPermissionMode(wanted)) {
              setNotice(`"${wanted}" is not a permission mode. Try /mode with no argument.`);
            } else if (!state.capabilities.permissionModes.includes(wanted)) {
              setNotice(`${state.settings.providerLabel} does not have a "${wanted}" mode.`);
            } else if (wanted === 'bypassPermissions') {
              confirm('Approve every tool call without asking?', 'Yes — bypass all permission prompts', true, () => applyMode(wanted));
            } else {
              applyMode(wanted);
            }
            return;
          }
          openModePicker();
          return;
        case 'resume':
          if (command.args === 'latest' || command.args === 'last') void openResumePicker(true);
          else if (command.args.length > 0) void loadSession(command.args as SessionId, command.args);
          else void openResumePicker();
          return;
        case 'attach':
          void attach(command.args);
          return;
        case 'tasks':
          openTasksPicker();
          return;
        case 'usage':
          void showUsage();
          return;
        default:
          return;
      }
    },
    [
      say,
      state.settings,
      state.capabilities.permissionModes,
      exit,
      conversation,
      startNew,
      openProfilePicker,
      openModelPicker,
      openModePicker,
      openResumePicker,
      loadSession,
      attach,
      openTasksPicker,
      showUsage,
      confirm,
      applyMode,
    ],
  );

  const submit = useCallback(
    (text: string) => {
      setNotice(undefined);
      const command = parseCommand(text);
      if (command !== null) {
        runCommand(command);
        return;
      }
      const attachments = pendingAttachments.map((entry) => entry.attachment);
      setPendingAttachments([]);
      setScroll(0);
      void conversation.send(text, attachments).then((outcome) => {
        if (!outcome.ok) {
          setNotice(outcome.reason);
          // Not lost: a refused message keeps its attachments for the retry.
          if (attachments.length > 0) setPendingAttachments(pendingAttachments);
        }
      });
    },
    [conversation, runCommand, pendingAttachments],
  );

  /* ---------------------------------------------------------------------- */
  /* Keys                                                                    */
  /* ---------------------------------------------------------------------- */

  const showSidebar = columns >= SIDEBAR_MIN_COLUMNS;
  const modalOpen = modal !== null || pendingRequest !== undefined;
  const sidebarActive = focus === 'sidebar' && showSidebar && !modalOpen;
  const composerActive = focus === 'composer' && !modalOpen;

  /**
   * Put a conversation away, or take it back out.
   *
   * A tag written into the provider's own store — the same one the desktop
   * writes — so a row archived here is archived there. Nothing is destroyed
   * and the conversation is still resumable from the archive folder, which is
   * what makes this the safe half of the pair and why it asks nothing before
   * doing it.
   */
  const archiveRailSession = useCallback(
    async (session: SessionSummary) => {
      const archived = isArchived(session);
      if (host.capabilitiesFor(session.providerId)?.tagSession !== true) {
        setNotice(`${state.settings.providerLabel} cannot archive a conversation.`);
        return;
      }
      try {
        const done = await host.archiveSession(session.profileId, session.providerId, session.id, session.cwd, !archived);
        if (!done) {
          setNotice('That conversation could not be archived; it may already be gone.');
          return;
        }
        say('info', `${archived ? 'Restored' : 'Archived'} ${oneLine(session.title, 60)}.`);
        await refreshRail();
      } catch (error) {
        say('error', `Could not archive that conversation: ${describeError(error)}`);
      }
    },
    [host, state.settings.providerLabel, say, refreshRail],
  );

  /**
   * Destroy a conversation, after asking.
   *
   * The transcript file goes and nothing here can bring it back, which is the
   * whole difference from archiving and the reason this is the one rail
   * action that confirms first — with the safe row selected, so Enter pressed
   * once too often does nothing.
   */
  const deleteRailSession = useCallback(
    (session: SessionSummary) => {
      if (host.capabilitiesFor(session.providerId)?.deleteSession !== true) {
        setNotice(`${state.settings.providerLabel} cannot delete a stored conversation.`);
        return;
      }
      confirm(`Delete "${oneLine(session.title, 50)}"? This cannot be undone.`, 'Delete it', true, () => {
        void (async () => {
          try {
            const done = await host.deleteSession(session.profileId, session.providerId, session.id, session.cwd);
            if (!done) {
              setNotice('That conversation could not be deleted; it may already be gone.');
              return;
            }
            // The screen is showing what was just destroyed; there is no
            // conversation left to be in.
            if (session.id === state.sessionId) startNew();
            say('info', `Deleted ${oneLine(session.title, 60)}.`);
            await refreshRail();
          } catch (error) {
            say('error', `Could not delete that conversation: ${describeError(error)}`);
          }
        })();
      });
    },
    [host, state.settings.providerLabel, state.sessionId, confirm, say, refreshRail, startNew],
  );

  const chooseRailRow = useCallback(
    (row: RailRow) => {
      setFocus('composer');
      switch (row.kind) {
        case 'new':
          startNew();
          return;
        case 'new-elsewhere':
          openDirectoryPicker();
          return;
        case 'folder':
          setFocus('sidebar');
          setOpenFolders((current) => {
            const next = new Set(current);
            if (next.has(row.project)) next.delete(row.project);
            else next.add(row.project);
            return next;
          });
          return;
        case 'more':
          setFocus('sidebar');
          setExpandedFolders((current) => new Set([...current, row.project]));
          return;
        case 'session': {
          if (row.session.id === state.sessionId) return;
          /*
           * A conversation lives in its account's store and where it ran, so
           * opening one from elsewhere in the rail is opening it on that
           * account, in that directory — as the desktop does. Those go into
           * the conversation being built for it rather than being patched
           * onto the one on screen, which may still be working and is not
           * the one moving.
           */
          const settings: { -readonly [K in keyof ConversationSettings]: ConversationSettings[K] } = {
            ...state.settings,
            cwd: row.session.cwd,
          };
          if (row.session.profileId !== state.settings.profileId) {
            const profile = accounts.find((candidate) => candidate.id === row.session.profileId);
            if (profile === undefined) {
              setNotice('That conversation belongs to an account that is no longer configured.');
              return;
            }
            settings.profileId = profile.id;
            settings.providerId = profile.providerId;
            settings.profileLabel = profile.label;
            settings.providerLabel = descriptors.get(profile.providerId)?.label ?? profile.providerId;
            settings.model = undefined;
            settings.modelLabel = undefined;
            settings.effort = undefined;
            settings.fastMode = undefined;
            settings.ultracode = undefined;
            // The conversation built for it seeds its own plan reading; the
            // one on screen is being left and must not be handed another
            // account's gauge.
            planFetchedAt.current = 0;
          }
          void loadSession(row.session.id, row.session.title, settings);
          return;
        }
        default:
          return;
      }
    },
    [startNew, openDirectoryPicker, state.sessionId, state.settings.cwd, state.settings.profileId, accounts, descriptors, conversation, loadSession],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (quitArmed.current !== null) {
        clearTimeout(quitArmed.current);
        exit();
        return;
      }
      if (conversation.isLive) void conversation.interrupt();
      showFlash(conversation.isLive ? 'Interrupting · Ctrl+C again to quit' : 'Ctrl+C again to quit');
      quitArmed.current = setTimeout(() => {
        quitArmed.current = null;
      }, QUIT_WINDOW_MS);
      quitArmed.current.unref?.();
      return;
    }

    if (modal?.kind === 'replay') {
      if (key.escape) setModal(null);
      return;
    }
    if (modalOpen) return;

    if (key.tab) {
      if (showSidebar) setFocus((current) => (current === 'composer' ? 'sidebar' : 'composer'));
      return;
    }
    /*
     * Scrolling the conversation. Arrows, because a laptop has no Page keys
     * and because a terminal on the alternate screen turns the mouse wheel
     * into arrow presses — so the wheel works without mouse reporting. Shift
     * or Ctrl with an arrow moves half a screen; Esc, when nothing is
     * running, follows the end again. The sidebar owns the arrows while it
     * has focus.
     */
    if (!sidebarActive) {
      const half = Math.max(SCROLL_STEP, Math.floor(scrollExtent.current.viewportLines / 2));
      if (key.upArrow || key.pageUp) {
        scrollBy(key.pageUp || key.shift || key.ctrl ? half : SCROLL_STEP);
        return;
      }
      if (key.downArrow || key.pageDown) {
        scrollBy(-(key.pageDown || key.shift || key.ctrl ? half : SCROLL_STEP));
        return;
      }
      if (key.end || (key.escape && scroll > 0 && !conversation.isLive)) {
        setScroll(0);
        return;
      }
    }

    if (sidebarActive) {
      const row = rail[railIndex];
      if (key.upArrow || input === 'k') setRailIndex((i) => (i - 1 + rail.length) % Math.max(1, rail.length));
      else if (key.downArrow || input === 'j') setRailIndex((i) => (i + 1) % Math.max(1, rail.length));
      else if (key.return) {
        if (row !== undefined) chooseRailRow(row);
      } else if (input === 'a' && row?.kind === 'session') {
        void archiveRailSession(row.session);
      } else if (input === 'd' && row?.kind === 'session') {
        deleteRailSession(row.session);
      } else if (key.escape) setFocus('composer');
      return;
    }

    if (key.escape && conversation.isLive) void conversation.interrupt();
  });

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  const tallHeader = rows >= TALL_HEADER_MIN_ROWS;
  const headerRows = tallHeader ? 3 : 2;
  const bodyRows = Math.max(6, rows - headerRows);
  const mainWidth = showSidebar ? columns - SIDEBAR_WIDTH : columns;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header cwd={state.settings.cwd} columns={columns} tall={tallHeader} />

      <Box flexDirection="row" height={bodyRows}>
        {showSidebar && (
          <Sidebar
            rows={rail}
            selected={railIndex}
            focused={sidebarActive}
            {...(state.sessionId === undefined ? {} : { activeSessionId: state.sessionId })}
            activity={railActivity}
            currentProject={currentProject}
            width={SIDEBAR_WIDTH}
            height={bodyRows}
            loading={railLoading}
          />
        )}

        <Box flexDirection="column" width={mainWidth} height={bodyRows}>
          <TranscriptViewport transcript={transcript} live={live} offset={scroll} onExtent={onScrollExtent} />

          {pendingRequest !== undefined && modal === null && (
            <Box paddingX={1} flexShrink={0}>
              <PermissionCard
                key={pendingRequest.id}
                request={pendingRequest}
                onDecision={(decision) => void conversation.respondToPermission(pendingRequest.id, decision)}
              />
            </Box>
          )}
          {modal?.kind === 'loading' && (
            <Box paddingX={1} flexShrink={0}>
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text dimColor>{modal.title}</Text>
              </Box>
            </Box>
          )}
          {modal?.kind === 'picker' && (
            <Box paddingX={1} flexShrink={0}>
              <Picker
                /*
                 * Keyed by title, so that a picker showing a *different*
                 * list starts at the top of it. The folder browser replaces
                 * its rows on every step, and a cursor kept from the last
                 * directory can sit past the end of a smaller one — a
                 * selection you cannot see and an Enter that does nothing. A
                 * picker refreshed in place keeps its title, and so keeps
                 * its cursor, which is the case this must not disturb.
                 */
                key={modal.title}
                title={modal.title}
                items={modal.items}
                {...(modal.initialKey === undefined ? {} : { initialKey: modal.initialKey })}
                {...(modal.hint === undefined ? {} : { hint: modal.hint })}
                onSelect={modal.onSelect}
                onCancel={() => setModal(null)}
              />
            </Box>
          )}
          {modal?.kind === 'replay' && (
            <Box paddingX={1} flexShrink={0}>
              <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
                <Text color={ACCENT} bold>
                  Agent · {modal.title}
                </Text>
                <ReplayRows events={modal.events} maxRows={Math.max(6, bodyRows - 8)} />
                <Text dimColor>Esc closes</Text>
              </Box>
            </Box>
          )}

          <Box flexDirection="column" flexShrink={0} paddingX={1}>
            <Composer
              onSubmit={submit}
              live={live}
              locked={locked}
              isActive={composerActive}
              attachments={pendingAttachments.map((entry) => entry.name)}
              providerCommands={state.slashCommands}
              {...(notice === undefined ? {} : { notice })}
            />
            <StatusBar
              state={state}
              columns={mainWidth}
              {...(flash === undefined ? {} : { flash })}
              {...(update === undefined ? {} : { update })}
              {...(sidebarActive ? { hint: 'sidebar: ↑↓ Enter · a archive · d delete · Esc back' } : scroll > 0 ? { hint: 'scrolled · Esc to follow' } : {})}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
