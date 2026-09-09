/**
 * @vitest-environment jsdom
 *
 * Where a suggested task can be started, and what happens when it cannot.
 *
 * The menu and the action read one function — `suggestedTaskTargetStatus` — and
 * that is the whole point of it: an option that opens and then fails is worse
 * than one that was disabled with a reason, and the only way to guarantee the
 * two agree is for both to ask the same question. So most of what is pinned
 * here is that answer, per target, in both directions.
 *
 * The other half is the failure. A worktree that could not be made must leave
 * the offer standing and open no column: the user is about to try it somewhere
 * else, and hunting back through a transcript for a chip that vanished on a
 * failure is the wrong way to be told what happened.
 *
 * Same caveat as the neighbouring files: `renderer/tsconfig.json` excludes test
 * files, so the assertions are behavioural.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A bridge that answers only what these tests reach for.
 *
 * Installed before the store is imported, because `resolveBridge` caches its
 * binding on the first call — see `lib/bridge.ts`. Everything else in the store
 * degrades to "no bridge" on its own, which is exactly how `cwd.test.ts` runs
 * with none at all.
 */
const createWorktree = vi.fn();
const submitted = vi.fn();

/**
 * The background reads a new column kicks off — the catalogue, the commands,
 * the session list, the auth probe. None is what these tests are about, and all
 * of them are floating promises, so each answers a plain failure rather than
 * being left to throw into nothing.
 */
const refused = () =>
  Promise.resolve({
    ok: false as const,
    error: { code: 'transport', message: 'not wired in this test', retryable: false },
  });

(globalThis.window as unknown as { artemis: unknown }).artemis = {
  workspace: { createWorktree },
  providers: { models: refused, commands: refused },
  sessions: { list: refused, listAll: refused },
  auth: { status: refused },
  // The one call a *send* would make. Nothing here should reach it — see the
  // server target's own tests — and a spy is how that is proved rather than
  // assumed.
  runs: { start: (...args: unknown[]) => (submitted(...args), refused()) },
};

const {
  allPanes,
  closePane,
  dismissSuggestedTask,
  focusedPane,
  setSuggestedTaskTarget,
  startSuggestedTask,
  suggestedTaskContext,
  suggestedTaskDismissed,
  suggestedTaskTargetStatus,
  useApp,
} = await import('./store');
const { paneState, setPaneState } = await import('./pane');
type Pane = import('./pane').Pane;

const pane = () => focusedPane();
const session = () => paneState(pane());

const TASK = { title: 'Add tests', tldr: 'No coverage.', prompt: 'Write the tests.' };

/** A column in a repository, with no server profile in the window. */
const IN_A_REPO = {
  cwd: '/code/kronos',
  workspace: { name: 'kronos', repoName: 'kronos', repoRoot: '/code/kronos' },
  hasServer: false,
};

const status = (context: unknown, target: unknown) =>
  suggestedTaskTargetStatus(context as never, target as never);

const SERVER = { id: 's1', label: 'Server', providerId: 'artemis', configDir: '' };
const LOCAL = { id: 'p1', label: 'Local', providerId: 'claude', configDir: '/c' };

beforeEach(() => {
  createWorktree.mockReset();
  submitted.mockReset();
  useApp.setState({ banners: [], profiles: [], suggestedTaskTarget: 'here' });
  setPaneState(pane(), {
    cwd: '/code/kronos',
    workspace: IN_A_REPO.workspace,
    run: null,
    resumeSessionId: null,
    activeProfileId: null,
    dismissedSuggestedTasks: [],
  });
});

describe('where a task can be started', () => {
  it('always offers this conversation and a new one', () => {
    // Neither can fail in a way a menu could usefully warn about: a live run
    // steers or refuses with its own sentence, and a full grid falls back to
    // starting the conversation in place rather than refusing.
    expect(status(IN_A_REPO, 'here')).toEqual({ available: true });
    expect(status(IN_A_REPO, 'session')).toEqual({ available: true });
  });

  it('offers a worktree in a repository', () => {
    expect(status(IN_A_REPO, 'worktree')).toEqual({ available: true });
  });

  it('names the directory when there is no repository to split', () => {
    const answer = status({ ...IN_A_REPO, workspace: { name: 'notes' } }, 'worktree');
    expect(answer.available).toBe(false);
    expect(answer.reason).toContain('/code/kronos');
    expect(answer.reason).toContain('not in a git repository');
  });

  it('waits rather than refusing while the directory is still being read', () => {
    // `workspace` is null for a moment after a column moves. Refusing then
    // would make the menu's answer depend on how fast the user opened it.
    const answer = status({ ...IN_A_REPO, workspace: null }, 'worktree');
    expect(answer.available).toBe(false);
    expect(answer.reason).toContain('Still reading');
  });

  it('has nothing to split before a directory is set', () => {
    expect(status({ ...IN_A_REPO, cwd: '   ' }, 'worktree').available).toBe(false);
  });

  it('offers a server only when one is set up', () => {
    expect(status(IN_A_REPO, 'server')).toEqual({ available: false, reason: expect.any(String) });
    expect(status({ ...IN_A_REPO, hasServer: true }, 'server')).toEqual({ available: true });
  });

  it('reads the server question off the enabled profiles', () => {
    expect(suggestedTaskContext(session()).hasServer).toBe(false);

    useApp.setState({
      profiles: [
        { id: 's1', label: 'Server', providerId: 'artemis', configDir: '', disabled: true },
      ],
    });
    // Disabled is not "there is a machine": the run would be refused.
    expect(suggestedTaskContext(session()).hasServer).toBe(false);

    useApp.setState({
      profiles: [{ id: 's1', label: 'Server', providerId: 'artemis', configDir: '' }],
    });
    expect(suggestedTaskContext(session()).hasServer).toBe(true);
  });
});

describe('putting a suggestion away', () => {
  it('is one-shot, and keyed on the call that offered it', () => {
    expect(suggestedTaskDismissed(session(), 't:c1')).toBe(false);

    dismissSuggestedTask('t:c1', pane());
    dismissSuggestedTask('t:c1', pane());

    expect(session().dismissedSuggestedTasks).toEqual(['t:c1']);
    // A second offer in the same turn is a different call, and stays.
    expect(suggestedTaskDismissed(session(), 't:c2')).toBe(false);
  });
});

describe('remembering where tasks go', () => {
  it('records the habit, and says nothing when it has not changed', () => {
    setSuggestedTaskTarget('worktree');
    expect(useApp.getState().suggestedTaskTarget).toBe('worktree');

    setSuggestedTaskTarget('worktree');
    expect(useApp.getState().suggestedTaskTarget).toBe('worktree');
  });
});

describe('a worktree that cannot be made', () => {
  it('says so and leaves the offer standing', async () => {
    setPaneState(pane(), { workspace: { name: 'notes' } });
    const columns = allPanes().length;

    await startSuggestedTask('t:c1', TASK, 'worktree', pane());

    expect(createWorktree).not.toHaveBeenCalled();
    // Not dismissed: the user is about to try this somewhere else.
    expect(suggestedTaskDismissed(session(), 't:c1')).toBe(false);
    // And no column was opened for work that never started.
    expect(allPanes()).toHaveLength(columns);
    expect(useApp.getState().banners.at(-1)?.detail).toContain('not in a git repository');
  });

  it('reports what git said when the split fails', async () => {
    createWorktree.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'fatal: not a valid object name: HEAD' },
    });
    const columns = allPanes().length;

    await startSuggestedTask('t:c1', TASK, 'worktree', pane());

    expect(createWorktree).toHaveBeenCalledWith({
      path: '/code/kronos',
      // Named from the title, so `git branch` still says what the work was.
      branch: 'task/add-tests',
    });
    expect(suggestedTaskDismissed(session(), 't:c1')).toBe(false);
    expect(allPanes()).toHaveLength(columns);
    expect(useApp.getState().banners.at(-1)?.message).toContain('worktree');
  });
});

/**
 * The server target hands the prompt over; it does not send it.
 *
 * Three of the four end in a send and this one deliberately does not, because
 * on a column that has just been opened the two questions a send has to answer
 * have no answers yet: the served catalogue has not arrived, so the run goes
 * out with no model and the server replies `model_not_found`; and the model
 * choice is null, so the account would be whichever route the server happened
 * to list first. Which account, which model and what thinking level is the
 * choice a person moves work to a server in order to make.
 */
describe('sending a task to a server', () => {
  beforeEach(() => {
    useApp.setState({ profiles: [LOCAL, SERVER] });
    setPaneState(pane(), { activeProfileId: 'p1', activeProviderId: 'claude' });
  });

  afterEach(() => {
    // `splitPane` focuses what it opened, and the store is a singleton across
    // this file — a column left behind would be the one the next test's
    // `pane()` returned.
    for (const extra of allPanes().slice(1)) closePane(extra.id);
  });

  /**
   * Hand the task over, and give back both columns.
   *
   * `from` is the one the chip was clicked in — captured before the call,
   * because `splitPane` focuses what it opened and `focusedPane()` is no longer
   * it afterwards. That is the whole reason this helper exists: an assertion
   * written against `pane()` after the hand-off reads the wrong column and
   * passes or fails for the wrong reason.
   */
  async function handOff(): Promise<{ from: Pane; to: Pane }> {
    const from = pane();
    await startSuggestedTask('t:c1', TASK, 'server', from);
    const to = allPanes().find((p) => p.id !== from.id);
    if (to === undefined) throw new Error('no column was opened');
    return { from, to };
  }

  it('opens a column on the server with the prompt waiting in it', async () => {
    const { to } = await handOff();

    expect(paneState(to).activeProfileId).toBe('s1');
    // The same field a restored or parked draft lands in, so it is editable
    // and recallable exactly as anything typed here would be.
    expect(paneState(to).draft).toBe(TASK.prompt);
  });

  it('never submits — the regression this target exists to avoid', async () => {
    const { to } = await handOff();

    expect(submitted).not.toHaveBeenCalled();
    // Nothing is running in the new column either, so the profile, the model
    // and the thinking level are all still the user's to change before sending.
    expect(paneState(to).run).toBeNull();
  });

  it('leaves the model unchosen, so the picker shows the catalogue', async () => {
    const { to } = await handOff();

    // Null rather than a first-row guess: `activeModel` falling back to
    // `models[0]` is what made the served account arbitrary.
    expect(paneState(to).model).toBeNull();
  });

  it('puts the chip away in the column it was offered in', async () => {
    const { from } = await handOff();

    expect(suggestedTaskDismissed(paneState(from), 't:c1')).toBe(true);
    expect(useApp.getState().suggestedTaskTarget).toBe('server');
  });

  it('says so and does nothing when the server has gone', async () => {
    useApp.setState({ profiles: [LOCAL] });
    const from = pane();
    const columns = allPanes().length;

    await startSuggestedTask('t:c1', TASK, 'server', from);

    expect(allPanes()).toHaveLength(columns);
    expect(suggestedTaskDismissed(paneState(from), 't:c1')).toBe(false);
    expect(useApp.getState().banners.at(-1)?.message).toContain('No server');
  });
});
