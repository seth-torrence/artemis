/**
 * @vitest-environment jsdom
 *
 * The predicted next prompt as ghost text inside the composer.
 *
 * The suggestion rides the placeholder slot — the field's resident ghost — the
 * way Claude Code shows it, instead of the chip row the feature shipped with.
 * What these pin is the contract that makes ghost text honest:
 *
 *  - **It is an offer, not input.** The ghost never becomes the draft on its
 *    own — only Tab materialises it, and what Tab produces is ordinary
 *    editable text, sent only by the user.
 *  - **Tab keeps its honest scope: the empty field.** With anything typed, Tab
 *    must not replace the user's words with a machine's guess.
 *  - **Lock and permission messages outrank the ghost.** A prediction must
 *    never paper over "why can't I type here".
 *  - **Escape declines the offer** — and only the offer: it must keep meaning
 *    deny/stop when a permission is parked or a run is live.
 *
 * As with the neighbouring composer tests, `renderer/tsconfig.json` excludes
 * these, so the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Composer } from '@/components/Composer';
import { focusedPane } from '@/state/store';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const interruptRun = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const submitPrompt = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const refreshCommands = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const denyPendingPermission = vi.hoisted(() => vi.fn(() => Promise.resolve(false)));
// Only the bridge-reaching actions are stubbed. `acceptSuggestion` and
// `dismissSuggestion` stay real — the point here is the actual state change
// behind Tab and Escape, not whether a handler was wired to something.
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  interruptRun,
  submitPrompt,
  refreshCommands,
  denyPendingPermission,
}));

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
  imageInput: true,
  fileInput: true,
};

const SUGGESTED = 'Now wire the smoke test into CI so this stays fixed';

function setUp({
  suggestion = { runId: 'r1', text: SUGGESTED } as { runId: string; text: string } | null,
  draft = '',
  status = 'ended' as 'ended' | 'running',
} = {}): void {
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
    cwd: '/w',
    draft,
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    suggestion,
    run: {
      runId: 'r1',
      status,
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
    },
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const field = (): HTMLTextAreaElement => screen.getByLabelText('Prompt') as HTMLTextAreaElement;
const draft = (): string => focusedPane().store.getState().draft;

beforeEach(() => {
  interruptRun.mockClear();
  submitPrompt.mockClear();
  refreshCommands.mockClear();
  denyPendingPermission.mockClear();
  denyPendingPermission.mockImplementation(() => Promise.resolve(false));
});

afterEach(cleanup);

describe('the ghost', () => {
  it('shows the suggestion in the placeholder slot while the field is empty', () => {
    setUp();
    mount(<Composer />);
    expect(field().placeholder).toBe(SUGGESTED);
    // Ghost text, not draft text: the field itself holds nothing.
    expect(field().value).toBe('');
  });

  it('is absent when there is nothing to offer', () => {
    setUp({ suggestion: null });
    mount(<Composer />);
    expect(field().placeholder).toBe('Ask Artemis to do something…');
  });

  it('never outranks a parked permission — that message keeps the slot', () => {
    setUp();
    seedApp({
      permissionQueue: [
        {
          id: 'perm-1',
          runId: 'r1',
          title: 'Run a command',
          receivedAt: 1,
        } as never,
      ],
    });
    mount(<Composer />);
    expect(field().placeholder).toBe('A tool call is waiting for your approval, just above this box…');
  });

  it('no longer renders the chip row', () => {
    setUp();
    mount(<Composer />);
    expect(screen.queryByTitle('Dismiss the suggestion')).toBeNull();
  });
});

describe('Tab', () => {
  it('materialises the ghost into an editable draft, one-shot', () => {
    setUp();
    mount(<Composer />);

    fireEvent.keyDown(field(), { key: 'Tab' });

    expect(draft()).toBe(SUGGESTED);
    expect(field().value).toBe(SUGGESTED);
    // The offer is spent — the placeholder returns to its resting hint.
    expect(field().placeholder).toBe('Ask Artemis to do something…');
    // Nothing was sent on the user's behalf.
    expect(submitPrompt).not.toHaveBeenCalled();

    // The text is ordinary draft now: editable like anything typed.
    fireEvent.change(field(), { target: { value: `${SUGGESTED} and lint` } });
    expect(draft()).toBe(`${SUGGESTED} and lint`);
  });

  it('does nothing over a non-empty draft', () => {
    setUp({ draft: 'my own words' });
    mount(<Composer />);

    fireEvent.keyDown(field(), { key: 'Tab' });

    expect(draft()).toBe('my own words');
  });

  it('ignores Shift+Tab', () => {
    setUp();
    mount(<Composer />);

    fireEvent.keyDown(field(), { key: 'Tab', shiftKey: true });

    expect(draft()).toBe('');
  });
});

describe('Escape', () => {
  it('declines the offer and leaves the field alone', () => {
    setUp();
    mount(<Composer />);

    fireEvent.keyDown(field(), { key: 'Escape' });

    expect(field().placeholder).toBe('Ask Artemis to do something…');
    expect(draft()).toBe('');
    // Declining a hint must not read as "stop the run".
    expect(interruptRun).not.toHaveBeenCalled();
  });

  it('keeps meaning stop while a run is live', async () => {
    // A live run cannot offer a suggestion through the real gate
    // (`offeredSuggestion` requires the ended run it followed), so the
    // dismissal branch must yield — Escape stays the stop gesture.
    setUp({ status: 'running', suggestion: null });
    mount(<Composer />);

    fireEvent.keyDown(field(), { key: 'Escape' });

    await vi.waitFor(() => expect(interruptRun).toHaveBeenCalledTimes(1));
  });
});
