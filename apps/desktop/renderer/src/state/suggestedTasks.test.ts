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

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A bridge that answers only what these tests reach for.
 *
 * Installed before the store is imported, because `resolveBridge` caches its
 * binding on the first call — see `lib/bridge.ts`. Everything else in the store
 * degrades to "no bridge" on its own, which is exactly how `cwd.test.ts` runs
 * with none at all.
 */
const createWorktree = vi.fn();
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  workspace: { createWorktree },
};

const {
  allPanes,
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

beforeEach(() => {
  createWorktree.mockReset();
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
