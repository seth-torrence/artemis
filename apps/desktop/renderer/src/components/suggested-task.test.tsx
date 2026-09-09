/**
 * @vitest-environment jsdom
 *
 * The chip an agent offers follow-up work with.
 *
 * A suggested task reaches the window as a tool call — see
 * `@rx-artemis/protocol`'s `suggestedTasks` — and everything worth pinning here
 * follows from that one decision:
 *
 *  - The call is drawn as an **offer**, not as a tool card, and it stands under
 *    the answer it followed rather than folding into the run's activity marker.
 *  - The **whole menu is always there**. An option that cannot work in this
 *    column is disabled with the reason, never missing: "Start with worktree —
 *    this directory is not in a git repository" teaches something, and a menu
 *    one row shorter teaches nothing.
 *  - The primary button is the **remembered habit**, and it falls back rather
 *    than presenting a click that would fail.
 *  - A malformed call draws no chip at all. A control with no words on it that
 *    nonetheless does something is worse than no control.
 *
 * As with the neighbouring component tests, `renderer/tsconfig.json` excludes
 * these, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SUGGESTED_TASK_TOOL } from '@rx-artemis/protocol';
import { Transcript } from '@/components/Transcript';
import { TooltipProvider } from '@/components/ui/tooltip';
import { handleAgentEvent, resetRunStreamState, useApp } from '@/state/store';
import { appTranscript, seedApp, ALL_CAPABILITIES } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const startSuggestedTask = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  startSuggestedTask,
}));

const TASK = {
  title: 'Add tests for the parser',
  tldr: 'The new branch in parseHeader has no coverage.',
  prompt: 'Write unit tests for parseHeader in src/parse.ts.',
};

/** A column in a git repository, on a provider that can be handed tools. */
function setUp(over: Record<string, unknown> = {}): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: ALL_CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    capabilities: ALL_CAPABILITIES,
    cwd: '/code/kronos',
    workspace: {
      name: 'kronos',
      repoName: 'kronos',
      repoRoot: '/code/kronos',
      projectRoot: '/code/kronos',
    },
    draft: '',
    banners: [],
    dismissedSuggestedTasks: [],
    run: {
      runId: 'run_1',
      status: 'ended',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/code/kronos',
      capabilities: ALL_CAPABILITIES,
      startedAt: 0,
      sessionId: 'sess-1',
    },
    ...over,
  });
}

/** An answer, then the offer the agent made under it, then ordinary work. */
function drawTurn(input: unknown = TASK): void {
  act(() => {
    let seq = 0;
    const next = () => ({ runId: 'run_1', seq: seq++, ts: 1000 + seq });
    handleAgentEvent({
      type: 'text.complete',
      messageId: 'm1',
      role: 'assistant',
      text: 'Done — the parser handles the new header.',
      ...next(),
    });
    handleAgentEvent({
      type: 'tool.start',
      toolCallId: 'c1',
      name: SUGGESTED_TASK_TOOL,
      input,
      ...next(),
    });
    handleAgentEvent({ type: 'tool.end', toolCallId: 'c1', status: 'ok', ...next() });
    appTranscript().flush();
  });
}

function mount(ui: ReactNode = <Transcript />): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/**
 * Open the caret.
 *
 * `pointerDown`, not `click`: Radix opens a dropdown on the pointer going down,
 * which is what the rest of the component tests here drive it with.
 */
function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Choose where to start this task' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  });
}

beforeEach(() => {
  startSuggestedTask.mockClear();
  resetRunStreamState();
  appTranscript().reset();
  useApp.setState({ suggestedTaskTarget: 'here' });
});

afterEach(cleanup);

describe('the suggested-task chip', () => {
  it('draws the offer under the answer, not as a tool card', () => {
    setUp();
    mount();
    drawTurn();

    expect(screen.getByTestId('suggested-task')).toBeTruthy();
    expect(screen.getByText(TASK.title)).toBeTruthy();
    expect(screen.getByText(TASK.tldr)).toBeTruthy();
    // The prompt is what a click sends, not something the reader has to read
    // past — a tool card would have shown it as a quoted argument.
    expect(screen.queryByText(TASK.prompt)).toBeNull();
    // And it is not folded into the run's activity marker.
    expect(screen.queryByText(/Ran \d+ command/)).toBeNull();
  });

  it('offers the remembered target as the button, and all four in the menu', () => {
    setUp();
    mount();
    drawTurn();

    expect(screen.getByRole('button', { name: 'Fix in this session' })).toBeTruthy();

    openMenu();
    for (const label of [
      'Fix in this session',
      'Start locally',
      'Start with worktree',
      'Send to a server',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('starts the work on the target that was chosen', () => {
    setUp();
    mount();
    drawTurn();

    fireEvent.click(screen.getByRole('button', { name: 'Fix in this session' }));

    expect(startSuggestedTask).toHaveBeenCalledTimes(1);
    const [callId, task, target] = startSuggestedTask.mock.calls[0];
    // Keyed on the call, which is what makes the dismissal survive a rebuild
    // of the rows and stay unambiguous across two offers with one title.
    expect(callId).toBe('t:c1');
    expect(task).toMatchObject({ title: TASK.title, prompt: TASK.prompt });
    expect(target).toBe('here');
  });

  it('follows the habit the user last chose', () => {
    setUp();
    useApp.setState({ suggestedTaskTarget: 'worktree' });
    mount();
    drawTurn();

    expect(screen.getByRole('button', { name: 'Start with worktree' })).toBeTruthy();
  });

  it('keeps the worktree row, disabled and explained, outside a repository', () => {
    // The house rule: an unusable option is shown with its reason rather than
    // hidden. The reason is the useful half.
    setUp({ cwd: '/notes', workspace: { name: 'notes' } });
    mount();
    drawTurn();

    openMenu();
    const row = screen.getByText('Start with worktree').closest('[role="menuitem"]');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.textContent).toContain('not in a git repository');
  });

  it('does not offer a server when there is none set up', () => {
    setUp();
    mount();
    drawTurn();

    openMenu();
    const row = screen.getByText('Send to a server').closest('[role="menuitem"]');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.textContent).toContain('No Artemis Server profile');
  });

  it('does not put an unusable target on the primary button', () => {
    // The primary is the one control a user presses without reading, so it
    // falls back to something that works rather than explaining a dead click.
    setUp({ cwd: '/notes', workspace: { name: 'notes' } });
    useApp.setState({ suggestedTaskTarget: 'worktree' });
    mount();
    drawTurn();

    expect(screen.queryByRole('button', { name: 'Start with worktree' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Fix in this session' })).toBeTruthy();
  });

  it('names the branch it would create before the user agrees to one', () => {
    setUp();
    mount();
    drawTurn();

    openMenu();
    const row = screen.getByText('Start with worktree').closest('[role="menuitem"]');
    expect(row?.textContent).toContain('task/add-tests-for-the-parser');
  });

  it('goes away when dismissed, and leaves no tool card behind it', () => {
    setUp();
    mount();
    drawTurn();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this suggestion' }));

    expect(screen.queryByTestId('suggested-task')).toBeNull();
    // The row is the chip. A dismissed offer must not fall back to showing the
    // machinery the chip existed to spare the reader.
    expect(screen.queryByText(SUGGESTED_TASK_TOOL)).toBeNull();
    expect(screen.queryByText(TASK.title)).toBeNull();
  });

  it('draws nothing at all for a call the model got wrong', () => {
    // A chip with no words on it that nonetheless does something is worse than
    // no chip. The answer above it is untouched.
    setUp();
    mount();
    drawTurn({ title: 'Add tests' });

    expect(screen.queryByTestId('suggested-task')).toBeNull();
    expect(screen.getByText('Done — the parser handles the new header.')).toBeTruthy();
  });
});
