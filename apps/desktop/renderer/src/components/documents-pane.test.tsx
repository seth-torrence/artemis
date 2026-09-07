/**
 * @vitest-environment jsdom
 *
 * The documents list: the index of everything a conversation made, through
 * the real store, the real transcript model and the real dock.
 *
 * The tiles in the thread are each document's own announcement, and they stand
 * exactly where the agent made them — right while the reader is there, and
 * forty screens up an hour later. The claims worth pinning are the ones that
 * make this an index rather than a second copy of the thread:
 *
 *  - **one row per file**, in the order first made, however often the agent
 *    went back to one;
 *  - **a row opens the document** the way the tile's button does, and offers
 *    the source as text the way a transcript link does — one reader for each;
 *  - **a row leads back to the place it was made**, by scrolling the
 *    conversation there;
 *  - **it opens from the header's opener and only by request**, and says so
 *    when there is nothing in it yet.
 *
 * Same caveat as the sibling component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { AgentEvent, IpcResult, PreviewOpenResponse, UpdateState } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

vi.mock('@/lib/terminalSessions', () => ({
  ensureTerminalSession: vi.fn(),
  attachTerminal: vi.fn(() => null),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  focusTerminal: vi.fn(),
  requestTerminalFocus: vi.fn(),
  terminalHasFocus: vi.fn(() => false),
  writeToTerminal: vi.fn(),
  noteTerminalExit: vi.fn(),
  disposeTerminalSession: vi.fn(),
  setTerminalSessionHooks: vi.fn(),
  retheme: vi.fn(),
  preferredTerminalSize: vi.fn(() => null),
  getTerminalSelection: vi.fn(() => ''),
  onTerminalSelectionChange: vi.fn(() => () => undefined),
}));

/** Paths the renderer asked to preview, in order. */
let previewed: string[];
/** Paths handed to the file reader — the tab the source opens in. */
let read: string[];
/** Rows the transcript was scrolled to. */
let scrolledTo: Element[];

const IDLE: UpdateState = { phase: 'idle', version: null, message: null, releaseUrl: null };

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: { onEvent: () => () => undefined },
    terminal: { onEvent: () => () => undefined },
    preview: {
      open: async ({ path }: { path: string }): Promise<IpcResult<PreviewOpenResponse>> => {
        previewed.push(path);
        return {
          ok: true,
          value: {
            kind: 'frame' as const,
            url: `artemis-preview://tok${String(previewed.length)}/`,
            title: path.split('/').pop() ?? path,
            path,
            bytes: 1157,
          },
        };
      },
    },
    files: {
      read: async ({ path }: { path: string }) => {
        read.push(path);
        return { ok: true, value: { path, title: path, bytes: 3, text: 'ok', truncated: false } };
      },
    },
    window: {
      state: async () => ({
        ok: true,
        value: { state: { fullScreen: false, maximized: false, focused: true } },
      }),
      onStateChange: () => () => undefined,
    },
    updates: {
      state: async () => ({ ok: true, value: { state: IDLE } }),
      onChange: () => () => undefined,
    },
  },
});

// jsdom has no layout and no `scrollIntoView`; what matters here is which
// element the transcript chose to bring into view.
Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
  scrolledTo.push(this);
};

const { AppHeader } = await import('@/components/AppHeader');
const { DockPane } = await import('@/components/DockPane');
const { Transcript } = await import('@/components/Transcript');
const { closePane, focusedPane, handleAgentEvent, toggleDocuments, useApp } = await import(
  '@/state/store'
);
const { ALL_CAPABILITIES, seedApp } = await import('@/state/testkit');

const PAGE = '<!doctype html>\n<html>\n<body>hi</body>\n</html>';

function aRun(runId: string, sessionId: string) {
  return {
    runId,
    status: 'running' as const,
    providerId: 'claude' as const,
    profileId: 'p1',
    cwd: '/Users/me/project',
    capabilities: ALL_CAPABILITIES,
    startedAt: 0,
    sessionId,
  };
}

let seq = 0;
/*
 * A conversation of its own per test, for `artifact-tile.test.tsx`'s reason:
 * the first artifact of a conversation opens the preview by itself, once, and
 * a shared session id would spend that on the first test.
 */
let conversation = 0;
let RUN = '';

function next(): number {
  seq += 1;
  return seq;
}

/** A finished tool call, through the store's own event path. */
async function called(
  runId: string,
  name: string,
  input: Record<string, unknown>,
  status = 'ok',
): Promise<void> {
  const id = `c${String(next())}`;
  await act(async () => {
    handleAgentEvent({
      type: 'tool.start',
      runId,
      seq: next(),
      ts: seq,
      toolCallId: id,
      name,
      input,
    } as AgentEvent);
    handleAgentEvent({
      type: 'tool.end',
      runId,
      seq: next(),
      ts: seq,
      toolCallId: id,
      status,
    } as never);
    focusedPane().transcript.flush();
  });
}

const wrote = (runId: string, path: string, content = PAGE): Promise<void> =>
  called(runId, 'Write', { file_path: path, content });

const edited = (runId: string, path: string): Promise<void> =>
  called(runId, 'Edit', { file_path: path, old_string: 'hi', new_string: 'hello' });

/** The agent saying something, settled. */
async function said(runId: string, text: string): Promise<void> {
  await act(async () => {
    handleAgentEvent({
      type: 'text.complete',
      runId,
      seq: next(),
      ts: seq,
      messageId: `m${String(seq)}`,
      role: 'assistant',
      text,
    } as AgentEvent);
    focusedPane().transcript.flush();
  });
}

function mount(...ui: React.ReactNode[]): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** Open the tab the way the header's opener and the strip both do. */
function openDocuments(): void {
  act(() => {
    toggleDocuments(focusedPane());
  });
}

beforeEach(() => {
  previewed = [];
  read = [];
  scrolledTo = [];
  seq = 0;
  conversation += 1;
  RUN = `run_${String(conversation)}`;
  for (const extra of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    closePane(extra.id);
  }
  focusedPane().transcript.reset();
  focusedPane().transcript.flush();
  useApp.setState({
    previews: [],
    files: [],
    terminals: [],
    browsers: [],
    activeDockTab: null,
    visibleDockTabs: [],
    dockScope: 'pane',
  });
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: ALL_CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/Users/me/project',
    run: aRun(RUN, `sess_${String(conversation)}`),
    resumeSessionId: null,
    permissionQueue: [],
    documentsRequested: false,
    filesRequested: false,
    tasks: [],
    conversationWidth: 'comfortable',
    runSummary: 'always',
  } as never);
});

afterEach(cleanup);

describe('the documents list', () => {
  it('lists each document once, in the order it was made', async () => {
    await wrote(RUN, '/tmp/report.md', '# Report\n');
    await wrote(RUN, '/tmp/chart.html');
    await edited(RUN, '/tmp/report.md');
    openDocuments();
    mount(<DockPane key="dock" />);

    const rows = within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByText(/\.(md|html)$/).textContent)).toEqual([
      'report.md',
      'chart.html',
    ]);
    // The edit folded into the first row rather than becoming a third.
    expect(within(rows[0] as HTMLElement).getByText(/1 edit/)).not.toBeNull();
    expect(within(rows[1] as HTMLElement).queryByText(/edit/)).toBeNull();
    expect(screen.getByText('2 documents')).not.toBeNull();
  });

  it('opens a document the way its tile does', async () => {
    await wrote(RUN, '/tmp/report.md', '# Report\n');
    openDocuments();
    mount(<DockPane key="dock" />);
    // The first artifact opened itself; that is the tile's business, not the
    // list's.
    previewed = [];

    fireEvent.click(screen.getByTitle('Open /tmp/report.md'));

    await waitFor(() => expect(previewed).toEqual(['/tmp/report.md']));
    expect(useApp.getState().activeDockTab?.kind).toBe('preview');
  });

  it('offers the source as text, in the tab a transcript link opens', async () => {
    await wrote(RUN, '/tmp/chart.html');
    openDocuments();
    mount(<DockPane key="dock" />);

    fireEvent.click(screen.getByLabelText('Open the source as text'));

    await waitFor(() => expect(read).toEqual(['/tmp/chart.html']));
    expect(useApp.getState().activeDockTab?.kind).toBe('file');
  });

  it('leads back to the place in the conversation where it was made', async () => {
    await said(RUN, 'the report first');
    await wrote(RUN, '/tmp/report.html');
    await said(RUN, 'and then some more');
    openDocuments();
    mount(<Transcript key="transcript" />, <DockPane key="dock" />);

    fireEvent.click(screen.getByLabelText('Show where it was made'));

    // The tile itself, not the list's row: what was scrolled to holds the
    // artifact's own disclosure, which only the thread draws.
    expect(scrolledTo).toHaveLength(1);
    const row = scrolledTo[0] as Element;
    expect(row.textContent).toContain('report.html');
    expect(row.querySelector('button[aria-label="Show the diff"]')).not.toBeNull();
    // And the follower has let go, so the next token cannot snap the reader
    // back to the tail before they have read it.
    expect(screen.getByRole('button', { name: /jump to latest/i })).not.toBeNull();
  });

  it('says so when nothing has been made yet', () => {
    openDocuments();
    mount(<DockPane key="dock" />);

    expect(screen.getByText('Nothing made yet')).not.toBeNull();
    expect(screen.queryByRole('list', { name: 'Documents' })).toBeNull();
  });

  it('closes on the second press, and comes back on the third', async () => {
    await wrote(RUN, '/tmp/report.md', '# Report\n');
    openDocuments();
    mount(<DockPane key="dock" />);
    expect(screen.getByText('1 document')).not.toBeNull();

    openDocuments();
    expect(screen.queryByText('1 document')).toBeNull();
    expect(useApp.getState().visibleDockTabs.some((tab) => tab.kind === 'documents')).toBe(false);

    openDocuments();
    expect(screen.getByText('1 document')).not.toBeNull();
  });

  it('shows what the column holds now, as documents arrive', async () => {
    openDocuments();
    mount(<DockPane key="dock" />);
    expect(screen.getByText('Nothing made yet')).not.toBeNull();

    await wrote(RUN, '/tmp/late.md', '# Late\n');

    // The first artifact of a conversation opens its preview in front — the
    // tile's standing rule, and not this tab's to override — so the list is
    // one click behind it, and up to date when it comes back.
    expect(useApp.getState().activeDockTab?.kind).toBe('preview');
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));

    const list = screen.getByRole('list', { name: 'Documents' });
    expect(within(list).getByText('late.md')).not.toBeNull();
    expect(screen.getByText('1 document')).not.toBeNull();
  });
});

describe('the header’s opener', () => {
  it('offers the documents list, with the count, and opens it in the dock', async () => {
    await wrote(RUN, '/tmp/report.md', '# Report\n');
    await wrote(RUN, '/tmp/chart.html');
    mount(<AppHeader key="header" />, <DockPane key="dock" />);

    fireEvent.keyDown(screen.getByLabelText('Open a surface'), { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: /Documents/ });
    expect(item.textContent).toContain('2');

    fireEvent.click(item);

    await screen.findByText('2 documents');
    expect(useApp.getState().activeDockTab).toEqual({
      kind: 'documents',
      paneId: focusedPane().id,
    });
  });
});
