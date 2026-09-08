/**
 * @vitest-environment jsdom
 *
 * Work still running after the words stopped, said above the prompt box.
 *
 * The `Agent` tool backgrounds by default and a workflow is always async, so
 * the turn that launched them is routinely over minutes before the work is.
 * The transcript's tail describes the *turn*, and an ended turn describes
 * nothing — which is exactly when a person looks at a quiet column and
 * concludes the agent has stopped. The composer now carries a standing row
 * for as long as anything the conversation delegated is still going, whatever
 * the turn is doing, with the delegated list one click away.
 *
 * What these pin: the row counts live tasks and only live tasks, it stands
 * after the run has ended, it is absent when nothing is running, and its
 * button opens the delegated tab for the column.
 *
 * `renderer/tsconfig.json` excludes this file, so the assertions are
 * behavioural.
 */

import type { BackgroundTask } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: { onEvent: () => () => undefined },
  },
});

const { Composer } = await import('@/components/Composer');
const { focusedPane, useApp } = await import('@/state/store');
const { paneState, setPaneState } = await import('@/state/pane');
const { capabilities, seedApp } = await import('@/state/testkit');

const CAPABILITIES = capabilities();

const task = (id: string, status: BackgroundTask['status']): BackgroundTask => ({
  id,
  kind: 'local_subagent',
  description: `Task ${id}`,
  status,
  startedAt: 1_000,
  ...(status === 'running' || status === 'pending' ? {} : { endedAt: 2_000 }),
});

function setUp(tasks: readonly BackgroundTask[], status: 'running' | 'ended' = 'ended'): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    capabilities: CAPABILITIES,
    cwd: '/w',
    draft: '',
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    suggestion: null,
    tasks,
    dismissedTasks: [],
    run: {
      runId: 'run_1',
      status,
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
      sessionId: 'sess-1',
      promptsSent: 1,
    },
  });
}

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <Composer />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useApp.setState({ activeDockTab: null } as never);
});

afterEach(cleanup);

describe('the background-work row', () => {
  it('counts the tasks still running, after the turn has ended', () => {
    setUp([task('a', 'running'), task('b', 'completed'), task('c', 'pending')]);
    mount();
    expect(screen.getByRole('status', { name: '2 background tasks are still running' })).toBeTruthy();
    expect(screen.getByText(/2 background tasks still running/)).toBeTruthy();
  });

  it('speaks in the singular for one', () => {
    setUp([task('a', 'running')], 'running');
    mount();
    expect(screen.getByRole('status', { name: '1 background task is still running' })).toBeTruthy();
  });

  it('is absent when nothing is running, settled rows or none', () => {
    setUp([task('a', 'completed'), task('b', 'failed')]);
    mount();
    expect(screen.queryByRole('status', { name: /background task/ })).toBeNull();
    cleanup();
    setUp([]);
    mount();
    expect(screen.queryByRole('status', { name: /background task/ })).toBeNull();
  });

  it('asks for the delegated list of its own column', () => {
    // What the header's delegated button writes, on the pane it acts on: the
    // dock draws its tab from this record (see `tasks-pane.test.tsx` for the
    // strip itself). A column that dismissed the list earlier gets it back.
    setUp([task('a', 'running')]);
    setPaneState(focusedPane(), { dismissedTasks: ['a'], tasksRequested: false });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(paneState(focusedPane())).toMatchObject({ tasksRequested: true, dismissedTasks: [] });
  });
});
