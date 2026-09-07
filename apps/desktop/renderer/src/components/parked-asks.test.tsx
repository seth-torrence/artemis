/**
 * @vitest-environment jsdom
 *
 * A parked request is answered above the prompt box, wherever the transcript
 * is scrolled.
 *
 * The card used to live only at the point in the transcript where the agent
 * asked, and a long turn scrolled it off the top while the status line went
 * on counting it. Now the composer pins every request the run is parked on,
 * and the transcript row is a marker that points there until the request is
 * settled — then the record, in place, as before.
 *
 * What these pin:
 *
 *  - The interactive card is in the composer's strip, and only there: the
 *    transcript row is a marker while the request is pending, so there is one
 *    draft of any answer and one element taking focus.
 *  - Answering from the pin settles the transcript row into the record.
 *  - Every kind of ask is pinned — a question, an approval, a plan — and
 *    several at once are several pins, in arrival order.
 *  - The marker's button lands focus on the pinned card.
 *
 * The bridge is faked at `window.artemis`, as the card tests do, so the answer
 * goes through the real store: the real `respondToPermission`, the real queue
 * and the real transcript settling. `renderer/tsconfig.json` excludes this
 * file, so the assertions are behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IpcResult, PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';

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

let respond: (decision: PermissionDecision) => IpcResult<{ requestId: string }>;
let sent: PermissionDecision[];

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {
      respondToPermission: async ({ decision }: { decision: PermissionDecision }) => {
        sent.push(decision);
        return respond(decision);
      },
    },
  },
});

const { Composer } = await import('@/components/Composer');
const { Transcript } = await import('@/components/Transcript');
const { handleAgentEvent, resetRunStreamState } = await import('@/state/store');
const { appSession, appTranscript, seedApp } = await import('@/state/testkit');

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

const QUESTION: PermissionRequest = {
  id: 'perm-1',
  runId: 'run_1',
  toolName: 'AskUserQuestion',
  input: {},
  requestedAt: 1_000,
  question: {
    questions: [
      {
        question: 'Which date library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'date-fns', description: 'Tree-shakeable, function per import.' },
          { label: 'Luxon', description: 'Immutable, good zone support.' },
        ],
      },
    ],
  },
};

const APPROVAL: PermissionRequest = {
  id: 'perm-2',
  runId: 'run_1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Artemis wants to run a shell command',
  requestedAt: 2_000,
};

const PLAN: PermissionRequest = {
  id: 'perm-3',
  runId: 'run_1',
  toolName: 'ExitPlanMode',
  input: {},
  requestedAt: 3_000,
  plan: { plan: '# The plan\n\n1. Rewrite the parser.\n' },
};

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
    draft: '',
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    suggestion: null,
    run: {
      runId: 'run_1',
      status: 'running',
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
 * The turn the agent is parked inside: one prompt, drawn the way the window
 * draws it. A transcript with no message in it renders as the empty state
 * rather than as rows, so every case below opens a turn first.
 */
function openTurn(): void {
  act(() => {
    const model = appTranscript();
    model.confirmUserMessage(model.pushUserMessage('start the refactor', undefined, 'run_1:prompt:1'));
    // The model batches its rows behind a frame; there is no frame here.
    model.flush();
  });
}

/** The card an interview is answered on: the outer group, named by its one question. */
const card = (): HTMLElement => screen.getAllByRole('group', { name: 'Which date library?' })[0]!;

/** The agent parks on a request: the event the wire delivers, in order. */
function park(request: PermissionRequest, seq: number): void {
  act(() => {
    handleAgentEvent({
      type: 'permission.request',
      runId: 'run_1',
      seq,
      ts: request.requestedAt,
      requestId: request.id,
      request,
    } as never);
    appTranscript().flush();
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

const field = (): HTMLTextAreaElement => screen.getByLabelText('Prompt') as HTMLTextAreaElement;

beforeEach(() => {
  sent = [];
  respond = (decision) => ({ ok: true, value: { requestId: 'perm-1' } });
  forgetFolds();
  resetRunStreamState();
  appTranscript().reset();
  setUp();
  openTurn();
});

afterEach(cleanup);

describe('the pin', () => {
  it('holds a parked question above the prompt box', () => {
    park(QUESTION, 1);
    mount(<Composer />);
    // The card, with its controls, sits in the composer — not a summary of it.
    expect(card()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /date-fns/ })).toBeTruthy();
    expect(field().placeholder).toMatch(/waiting on your answer, just above this box/);
  });

  it('is one region for the reader, named by what is waiting', () => {
    park(QUESTION, 1);
    mount(<Composer />);
    expect(screen.getByRole('region', { name: 'Waiting for your answer' })).toBeTruthy();
    park(APPROVAL, 2);
    expect(screen.getByRole('region', { name: '2 requests waiting for your answer' })).toBeTruthy();
  });

  it('pins an approval and a plan too, each as its own card', () => {
    park(APPROVAL, 1);
    park(PLAN, 2);
    mount(<Composer />);
    // The approval, verbatim, with its own buttons.
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve once/ })).toBeTruthy();
    // The plan, as a document.
    expect(screen.getByText('The plan')).toBeTruthy();
    expect(field().placeholder).toMatch(/waiting for your approval, just above this box/);
  });

  it('keeps several requests in arrival order', () => {
    park(QUESTION, 1);
    park(APPROVAL, 2);
    mount(<Composer />);
    const region = screen.getByRole('region', { name: /waiting for your answer/ });
    const text = region.textContent ?? '';
    expect(text.indexOf('Which date library?')).toBeLessThan(text.indexOf('rm -rf build'));
  });

  it('is absent when nothing is parked', () => {
    mount(<Composer />);
    expect(screen.queryByRole('region', { name: /waiting for your answer/ })).toBeNull();
  });
});

describe('the transcript row', () => {
  it('marks the ask and points below, rather than drawing a second card', () => {
    park(QUESTION, 1);
    mount(<Transcript />);
    expect(screen.getByText('The agent has a question.')).toBeTruthy();
    expect(screen.getByText(/pinned above the prompt box/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Answer below' })).toBeTruthy();
    // No controls here: one draft of the answer, in one place.
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
    expect(screen.queryByRole('radio', { name: /date-fns/ })).toBeNull();
  });

  it('says what kind of ask is waiting', () => {
    park(APPROVAL, 1);
    park(PLAN, 2);
    mount(<Transcript />);
    expect(screen.getByText('A tool call is waiting for your approval.')).toBeTruthy();
    expect(screen.getByText("The agent's plan is waiting for your sign-off.")).toBeTruthy();
  });

  it('becomes the record once the pin is answered', async () => {
    park(QUESTION, 1);
    mount(
      <>
        <Transcript />
        <Composer />
      </>,
    );
    fireEvent.click(screen.getByRole('radio', { name: /date-fns/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(appSession().permissionQueue).toEqual([]));
    // The pin is gone…
    expect(screen.queryByRole('region', { name: /waiting for your answer/ })).toBeNull();
    // …the marker with it, and the row is the record: the question as asked,
    // with the choice marked.
    expect(screen.queryByRole('button', { name: 'Answer below' })).toBeNull();
    expect(screen.getByText('asked a question')).toBeTruthy();
    expect(screen.getByText('date-fns')).toBeTruthy();
    expect(sent).toEqual([
      { behavior: 'allow', answers: [{ question: 'Which date library?', options: ['date-fns'] }] },
    ]);
  });

  it('puts focus on the pinned card from the marker', () => {
    park(QUESTION, 1);
    mount(
      <>
        <Transcript />
        <Composer />
      </>,
    );
    // The card took focus on arrival; give it back to the field first, so the
    // button is what moves it.
    act(() => field().focus());
    expect(document.activeElement).toBe(field());

    fireEvent.click(screen.getByRole('button', { name: 'Answer below' }));
    expect(document.activeElement).toBe(card());
  });
});
