/**
 * @vitest-environment jsdom
 *
 * A turn that produced nothing.
 *
 * Reported against the terminal app as an agent that "spun for a second and
 * insta-stopped": the run ended having said nothing, run nothing and thought
 * nothing, and all there was to show for it was `52ms · 0 tok`. Here it is
 * worse — under the default `runSummary`, a *completed* run's block is hidden
 * altogether, so a message answered by silence leaves no row at all, which is
 * indistinguishable from the agent having ignored it.
 *
 * This file's rule is the one `RunEndRow` already states for failures:
 * anything the reader has to act on stays.
 */

import type { AgentEvent } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { Transcript } from '@/components/Transcript';
import { TooltipProvider } from '@/components/ui/tooltip';
import { forgetFolds } from '@/lib/foldMemory';
import { useApp } from '@/state/store';
import { appTranscript, seedApp } from '@/state/testkit';

class CapturingObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', CapturingObserver);

function play(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  act(() => {
    const events = drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
    for (const event of events) appTranscript().apply(event);
    appTranscript().flush();
  });
}

function open(): void {
  render(
    <TooltipProvider>
      <Transcript />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  forgetFolds();
  appTranscript().reset();
  appTranscript().flush();
  seedApp({ run: null, permissionQueue: [], resumeSessionId: null as never, conversationWidth: 'comfortable' });
});

afterEach(() => {
  cleanup();
  useApp.setState({ conversationWidth: 'comfortable' });
});

describe('a run that produced nothing', () => {
  it('is shown even when clean runs are hidden', () => {
    useApp.setState({ runSummary: 'failures' });
    open();

    play({ type: 'run.end', reason: 'completed', durationMs: 52 } as Omit<AgentEvent, 'runId' | 'seq' | 'ts'>);

    // Without this the reader is shown nothing whatsoever for their message.
    expect(screen.getByText(/no reply/i)).toBeTruthy();
  });

  it('is named rather than called "completed" when summaries are on', () => {
    useApp.setState({ runSummary: 'always' });
    open();

    play({ type: 'run.end', reason: 'completed', durationMs: 52 } as Omit<AgentEvent, 'runId' | 'seq' | 'ts'>);

    expect(screen.getByText(/no reply/i)).toBeTruthy();
  });

  it('leaves an ordinary finished turn alone', () => {
    useApp.setState({ runSummary: 'always' });
    open();

    play(
      { type: 'text.complete', text: 'On it.' } as Omit<AgentEvent, 'runId' | 'seq' | 'ts'>,
      { type: 'run.end', reason: 'completed', durationMs: 900 } as Omit<AgentEvent, 'runId' | 'seq' | 'ts'>,
    );

    expect(screen.queryByText(/no reply/i)).toBeNull();
    expect(screen.getByText(/completed/i)).toBeTruthy();
  });
});
