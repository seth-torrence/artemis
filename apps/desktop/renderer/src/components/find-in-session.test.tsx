/**
 * @vitest-environment jsdom
 *
 * ⌘F finds a word in the conversation on screen.
 *
 * The bar is thin over `searchTranscript` — the counting and ordering are the
 * transcript package's, and covered there — so what these pin is the part that
 * only exists here: that the key opens a bar bound to *this* column, that the
 * count is what the model can see rather than what the page happens to be
 * drawing, that Enter walks the matches and wraps, and that leaving keeps what
 * you typed.
 *
 * `jumpToRow` is mocked because the jump it performs is the transcript's own
 * scroller, which jsdom does not lay out; what matters here is that the right
 * row was asked for. Highlight painting is a no-op under jsdom — the CSS
 * Custom Highlight API is not implemented there — which is exactly the
 * degradation `lib/findHighlight.ts` is written for.
 *
 * `renderer/tsconfig.json` excludes this file, so the assertions are
 * behavioural.
 */

import type { AgentEvent } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { forgetFolds } from '@/lib/foldMemory';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const jumpToRow = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/rowJump', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rowJump')>()),
  jumpToRow,
}));

const { Transcript } = await import('@/components/Transcript');
const { forgetFindInSession, openFindInSession } = await import('@/components/FindInSession');
const { focusedPane } = await import('@/state/store');
const { appTranscript, capabilities, seedApp } = await import('@/state/testkit');

const CAPABILITIES = capabilities();

function setUp(): void {
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
    permissionQueue: [],
    banners: [],
    run: {
      runId: 'run_1',
      status: 'idle',
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

/**
 * A conversation with a phrase in three places, one of them inside a tool call
 * that the transcript folds into a single marker.
 */
function conversation(): void {
  act(() => {
    const model = appTranscript();
    model.confirmUserMessage(model.pushUserMessage('where does the pelican live?'));
    const events: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>> = [
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'grep -r pelican src' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'src/birds.ts' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { path: 'src/birds.ts' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: 'nothing to see' },
      {
        type: 'text.complete',
        messageId: 'm2',
        role: 'assistant',
        blockIndex: 0,
        text: 'The pelican lives in src/birds.ts.',
      },
    ];
    events.forEach((draft, index) => {
      model.apply({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index } as AgentEvent);
    });
    model.flush();
  });
}

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <Transcript />
    </TooltipProvider>,
  );
}

/** What ⌘F does, which is all `App.tsx` binds it to. */
function pressFind(): void {
  act(() => {
    openFindInSession(focusedPane().id);
  });
}

const field = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'Search this conversation' }) as HTMLInputElement;

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } });
}

beforeEach(() => {
  jumpToRow.mockClear();
  forgetFolds();
  forgetFindInSession();
  appTranscript().reset();
  setUp();
});

afterEach(cleanup);

describe('find in session', () => {
  it('is absent until the key is pressed, and then has the caret', () => {
    conversation();
    mount();
    expect(screen.queryByRole('search', { name: 'Find in conversation' })).toBeNull();

    pressFind();
    expect(screen.getByRole('search', { name: 'Find in conversation' })).toBeTruthy();
    expect(document.activeElement).toBe(field());
  });

  it('counts what the model can see, including a folded tool call', () => {
    conversation();
    mount();
    pressFind();
    type('pelican');

    // The question, the folded `grep` argument, and the answer.
    expect(screen.getByText('1 of 3')).toBeTruthy();

    // And a phrase that exists *only* inside the burst still counts, though
    // the page is drawing a marker rather than the call.
    type('grep -r');
    expect(screen.getByText('1 of 1')).toBeTruthy();
    expect(screen.queryByText(/grep -r pelican/)).toBeNull();
  });

  it('takes the reader to the row the match is in', () => {
    conversation();
    mount();
    pressFind();
    type('grep -r');

    const [pane, rowId] = jumpToRow.mock.calls.at(-1) as unknown as [string, string];
    expect(pane).toBe(focusedPane().id);
    // The row is the marker the call folded into, not the call's own id.
    expect(rowId.startsWith('g:')).toBe(true);
  });

  it('walks the matches with Enter, backwards with Shift, and wraps', () => {
    conversation();
    mount();
    pressFind();
    type('pelican');
    expect(screen.getByText('1 of 3')).toBeTruthy();

    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('3 of 3')).toBeTruthy();
    // Past the end is the beginning again.
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByText('1 of 3')).toBeTruthy();
    // And back the other way, off the front.
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(screen.getByText('3 of 3')).toBeTruthy();

    // The buttons are the same two moves for a mouse.
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('3 of 3')).toBeTruthy();
  });

  it('says when a word is not there, and jumps nowhere', () => {
    conversation();
    mount();
    pressFind();
    jumpToRow.mockClear();
    type('albatross');
    expect(screen.getByText('No results')).toBeTruthy();
    expect(jumpToRow).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Next match' })).toHaveProperty('disabled', true);
  });

  it('closes on Escape and offers the same query next time', () => {
    conversation();
    mount();
    pressFind();
    type('pelican');

    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('search', { name: 'Find in conversation' })).toBeNull();

    pressFind();
    expect(field().value).toBe('pelican');
    expect(screen.getByText('1 of 3')).toBeTruthy();
  });

  it('closes from the button too', () => {
    conversation();
    mount();
    pressFind();
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }));
    expect(screen.queryByRole('search', { name: 'Find in conversation' })).toBeNull();
  });
});
