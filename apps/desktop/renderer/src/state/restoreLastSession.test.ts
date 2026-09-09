/**
 * @vitest-environment jsdom
 *
 * A restart comes back to the conversation the window was in.
 * ============================================================================
 *
 * Artemis recorded a great deal about a conversation — its model, its dock, its
 * half-written prompt — and nothing at all about *which one you were in*. So a
 * launch seeded a blank column from `cwd` and left the user to find their own
 * work again in a sidebar ordered by the transcript file's mtime.
 *
 * That is not the same question, and it answers wrongly under exactly the
 * conditions a crash leaves behind. The reported failure: a machine went down
 * with the app running, and the window came back on a conversation from the
 * previous day. Nothing had gone wrong with the newer session — it was simply
 * not pointed at, because nothing had ever written down that it was the one.
 *
 * The fixtures below mirror that incident. Two conversations, one account, one
 * directory: the one the user was working in this morning, and one from
 * yesterday. The listing is deliberately handed back with yesterday's first, so
 * a restore that reached for "the top of the list" would reproduce the bug and
 * fail here.
 *
 * ## Why the pointer is read out of the preferences file, not seeded
 *
 * "Restart" is the whole subject, so the pointer has to arrive the way it would
 * after one: written by a previous launch, read off disk before the first
 * paint. `loadPrefs` runs at module scope, which is why the bridge stub is
 * installed before `./store` is imported. Seeding the store instead would test
 * the restore while assuming away the half that failed.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes test
 * files, so these assertions are behavioural rather than typechecked.
 */

import { beforeEach, describe, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* The two conversations                                                      */
/* -------------------------------------------------------------------------- */

const PROFILE = 'profile-max';
const CWD = '/home/david/claude';

/** What the user was working in when the machine went down. */
const TODAY = 'today-28f7bc3d';
/** A conversation from the previous day, in the same account and directory. */
const YESTERDAY = 'yesterday-abfcd37b';
/** Something a background agent was running, in another account entirely. */
const ELSEWHERE = 'elsewhere-2ac062a1';

const CAPS = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
} as const;

function summary(id: string, updatedAt: number, profileId = PROFILE) {
  return {
    id,
    providerId: 'claude',
    profileId,
    cwd: CWD,
    title: id,
    updatedAt,
  } as const;
}

/*
 * Yesterday first, and it is not an accident of the fixture. The order a
 * listing arrives in must not decide which conversation a launch opens.
 */
let listed: readonly unknown[] = [summary(YESTERDAY, 1_000), summary(TODAY, 2_000)];

/** Runs the registry still holds — empty after a reboot, which is the case here. */
let liveRuns: readonly unknown[] = [];

/* -------------------------------------------------------------------------- */
/* The bridge, and the preferences a previous launch left behind              */
/* -------------------------------------------------------------------------- */

/** Every blob handed to the preferences file, oldest first. */
const written: string[] = [];

/** What the launch before this one wrote, and was killed without amending. */
const storedPrefs = JSON.stringify({
  activeProfileId: PROFILE,
  activeProviderId: 'claude',
  cwd: CWD,
  lastSessionByProfile: { [PROFILE]: TODAY },
});

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  prefsFile: {
    read: () => storedPrefs,
    write: (json: string) => {
      written.push(json);
    },
  },
  runs: {
    list: async () => ({ ok: true, value: { runs: liveRuns } }),
    events: async ({ runId }: { runId: string }) => ({
      ok: true,
      value: { runId, events: [], truncated: false },
    }),
    liveWork: async () => ({ ok: true, value: { sessionIds: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: listed, hasMore: false } }),
    messages: async () => ({ ok: true, value: { events: [], hasMore: false } }),
  },
  profiles: {
    list: async () => ({
      ok: true,
      value: {
        profiles: [
          { id: PROFILE, label: 'Max', providerId: 'claude', configDir: '/u/.max' },
          { id: 'profile-other', label: 'Other', providerId: 'claude', configDir: '/u/.other' },
        ],
      },
    }),
  },
  providers: {
    list: async () => ({
      ok: true,
      value: {
        providers: [
          {
            id: 'claude',
            label: 'Claude',
            capabilities: CAPS,
            models: [],
            effortLevels: [],
            available: true,
          },
        ],
      },
    }),
    models: async () => ({ ok: true, value: { models: [], live: false } }),
  },
  usagePlan: { cached: async () => ({ ok: true, value: { usage: null } }) },
  workspace: { describe: async () => ({ ok: true, value: { workspace: null } }) },
};

const { bootstrap, focusedPane, handleAgentEvent, resetRunStreamState, resumeSession, useApp } =
  await import('./store');
const { paneState, setPaneState } = await import('./pane');

/** The pointer as it stands in the most recently written preferences blob. */
function persistedPointer(): Record<string, string> {
  const last = written.at(-1);
  if (last === undefined) return {};
  const blob = JSON.parse(last) as { lastSessionByProfile?: Record<string, string> };
  return blob.lastSessionByProfile ?? {};
}

beforeEach(() => {
  resetRunStreamState();
  liveRuns = [];
  listed = [summary(YESTERDAY, 1_000), summary(TODAY, 2_000)];
  written.length = 0;
  useApp.setState({ banners: [], background: [], sessions: [] });
  const pane = focusedPane();
  pane.transcript.reset();
  setPaneState(pane, {
    run: null,
    resumeSessionId: null,
    activeProfileId: PROFILE,
    activeProviderId: 'claude',
    cwd: CWD,
  });
});

/* -------------------------------------------------------------------------- */

describe('reopening after a restart', () => {
  it('comes back to the conversation the account was last working in', async () => {
    // Nothing survived the reboot but the preferences file: no live run to
    // adopt, no window state, no clean quit to have flushed anything.
    await bootstrap();

    const state = paneState(focusedPane());
    expect(state.resumeSessionId).toBe(TODAY);
    // And not merely a different id: the row above it in the listing is the
    // conversation the user was sent to when nothing was recorded.
    expect(state.resumeSessionId).not.toBe(YESTERDAY);
    expect(state.cwd).toBe(CWD);
    expect(state.activeProfileId).toBe(PROFILE);
  });

  it('leaves a column alone when it has already adopted a live run', async () => {
    // A reload rather than a reboot: the run outlived the page and `attachRun`
    // has already pointed this column at it. An agent working now outranks a
    // pointer written before the window went away.
    liveRuns = [
      {
        runId: 'run-live',
        status: 'running',
        providerId: 'claude',
        profileId: PROFILE,
        cwd: CWD,
        capabilities: CAPS,
        startedAt: 1,
        sessionId: ELSEWHERE,
        historyOffset: 0,
      },
    ];

    await bootstrap();

    expect(paneState(focusedPane()).resumeSessionId).toBe(ELSEWHERE);
  });

  it('does not reopen a conversation this account cannot reach', async () => {
    // The stored pointer names a session that now only exists under another
    // profile's config directory. Resuming it would send the run at a
    // transcript the account cannot see.
    listed = [summary(TODAY, 2_000, 'profile-other'), summary(YESTERDAY, 1_000)];

    await bootstrap();

    expect(paneState(focusedPane()).resumeSessionId).toBeNull();
  });

  it('starts blank when the stored conversation is gone', async () => {
    listed = [summary(YESTERDAY, 1_000)];

    await bootstrap();

    expect(paneState(focusedPane()).resumeSessionId).toBeNull();
  });
});

describe('recording which conversation is open', () => {
  it('writes the pointer when a column is pointed at a conversation', () => {
    resumeSession(summary(YESTERDAY, 1_000) as never);

    // On the click, not at quit: the file on disk already names it.
    expect(useApp.getState().lastSessionByProfile[PROFILE]).toBe(YESTERDAY);
    expect(persistedPointer()[PROFILE]).toBe(YESTERDAY);
  });

  it('writes the pointer the moment a new conversation reports an id', () => {
    const pane = focusedPane();
    setPaneState(pane, {
      run: {
        runId: 'run-new',
        status: 'running',
        providerId: 'claude',
        profileId: PROFILE,
        cwd: CWD,
        capabilities: CAPS,
        startedAt: 1,
      } as never,
    });

    // A brand-new conversation has no id until this arrives, so this is the
    // first moment there is anything to record — and it is a moment the app
    // reaches while running, not on the way out.
    handleAgentEvent({
      type: 'session.started',
      runId: 'run-new',
      seq: 0,
      ts: 0,
      sessionId: 'fresh-session',
    } as never);

    expect(useApp.getState().lastSessionByProfile[PROFILE]).toBe('fresh-session');
    expect(persistedPointer()[PROFILE]).toBe('fresh-session');
  });

  it('keeps one pointer per account', () => {
    resumeSession(summary(YESTERDAY, 1_000) as never);
    resumeSession(summary(ELSEWHERE, 1_500, 'profile-other') as never);

    const pointer = useApp.getState().lastSessionByProfile;
    expect(pointer[PROFILE]).toBe(YESTERDAY);
    expect(pointer['profile-other']).toBe(ELSEWHERE);
  });
});
