/**
 * @vitest-environment jsdom
 *
 * An artifact: the tile that replaces the tool row, the pane that opens by
 * itself, and the moment both stop being true.
 *
 * `preview-pane.test.tsx` covers the *manual* path — the Preview button, and
 * what the pane does with what it is handed. This file covers the three claims
 * that act without being asked, which is what makes each of them a way to annoy
 * someone rather than merely a bug:
 *
 *  - **A page written outside the project becomes a tile**, and the tool row it
 *    replaces is still reachable underneath. The tile is the durable way back
 *    into an artifact, so nothing else here has to be reliable to be useful.
 *  - **The first artifact of a conversation opens the pane, and only the
 *    first.** A second uninvited pane, or one that reopens after being closed,
 *    is the app arguing with the user.
 *  - **A preview belongs to its conversation.** When that conversation is no
 *    longer in a column, the artifact goes with it — otherwise the window is
 *    framing a file with nothing on screen to connect it to.
 */

import type { AgentEvent, IpcResult, PreviewOpenResponse } from '@rx-artemis/protocol';
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

/** Paths the renderer asked to preview, in order. */
let asked: string[];

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {},
    preview: {
      open: async ({ path }: { path: string }): Promise<IpcResult<PreviewOpenResponse>> => {
        asked.push(path);
        return {
          ok: true,
          value: {
            kind: 'frame' as const,
            url: `artemis-preview://tok${asked.length}/`,
            title: path.split('/').pop() ?? path,
            path,
            bytes: 1157,
          },
        };
      },
    },
  },
});

const { Transcript } = await import('@/components/Transcript');
const { closePane, focusedPane, handleAgentEvent, splitPane, useApp } = await import(
  '@/state/store'
);
const { setPaneState } = await import('@/state/pane');
const { seedApp } = await import('@/state/testkit');

/** The open previews' paths — previews are a list now, one per conversation. */
function previewPaths(): readonly string[] {
  return useApp.getState().previews.map((one) => one.path);
}

const NO_CAPABILITIES = {
  interactivePermissions: false,
  partialMessages: false,
  midRunSteering: false,
  forkSession: false,
  listSessions: false,
  subagents: false,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: false,
  costReporting: false,
  planUsageReporting: false,
};

const PAGE = '<!doctype html>\n<html>\n<body>hi</body>\n</html>';

/** A run in a pane, as the store would have left one. */
function aRun(runId: string, sessionId?: string) {
  return {
    runId,
    status: 'running' as const,
    providerId: 'claude' as const,
    profileId: 'p1',
    cwd: '/Users/me/project',
    capabilities: NO_CAPABILITIES,
    startedAt: 0,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

let seq = 0;

/*
 * A conversation of its own per test.
 *
 * Auto-open fires once per *conversation* and remembers that it has — which is
 * the behaviour three of these tests exist to pin. Reusing one session id
 * across the file would mean the first test to write an artifact spent the
 * allowance for all of them, and every later assertion about opening would fail
 * for a reason that has nothing to do with what it is testing.
 */
let conversation = 0;
let RUN = '';
let SESSION = '';
let RUN2 = '';
let SESSION2 = '';

/**
 * Drive a completed write through the *store's* event path.
 *
 * Deliberately `handleAgentEvent` and not `transcript.apply`: auto-open hangs
 * off the store's `tool.end`, so a test that applied events straight to the
 * transcript would render the tile correctly and prove nothing about the pane
 * opening.
 */
async function wrote(runId: string, path: string, content = PAGE, status = 'ok'): Promise<void> {
  const id = `c${(seq += 1)}`;
  await act(async () => {
    handleAgentEvent({
      type: 'tool.start',
      runId,
      seq: seq * 2,
      ts: seq,
      toolCallId: id,
      name: 'Write',
      input: { file_path: path, content },
    } as AgentEvent);
    handleAgentEvent({
      type: 'tool.end',
      runId,
      seq: seq * 2 + 1,
      ts: seq,
      toolCallId: id,
      status,
    } as never);
    focusedPane().transcript.flush();
  });
}

/**
 * Open the activity marker, which is what ordinary tool cards live behind.
 *
 * Not for an artifact: the model keeps those out of the fold entirely, so a
 * test that clicked here to reach a tile would be asserting the opposite of
 * what the app does. See `an artifact is never behind the marker` below.
 */
function openTheMarker(): void {
  fireEvent.click(screen.getByText(/^(Edited|Wrote|Read|Ran)/i));
}

/**
 * The agent saying something, settled — the row a tile stands between.
 *
 * Streamed and then completed, which is two events for the two sequence slots
 * every helper here takes: a single event would leave a hole in `seq`, and
 * the model would rightly add a "dropped in transit" notice to the thread.
 */
async function said(runId: string, messageId: string, text: string): Promise<void> {
  seq += 1;
  await act(async () => {
    handleAgentEvent({
      type: 'text.delta',
      runId,
      seq: seq * 2,
      ts: seq,
      messageId,
      blockIndex: 0,
      text,
    } as AgentEvent);
    handleAgentEvent({
      type: 'text.complete',
      runId,
      seq: seq * 2 + 1,
      ts: seq,
      messageId,
      blockIndex: 0,
      role: 'assistant',
      text,
    } as AgentEvent);
    focusedPane().transcript.flush();
  });
}

/** Is `later` after `earlier` in the document? */
function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** A tool call that is not an artifact, to bury a tile in if one folded. */
async function ranACommand(runId: string): Promise<void> {
  const id = `c${(seq += 1)}`;
  await act(async () => {
    handleAgentEvent({
      type: 'tool.start',
      runId,
      seq: seq * 2,
      ts: seq,
      toolCallId: id,
      name: 'Bash',
      input: { command: 'ls' },
    } as AgentEvent);
    handleAgentEvent({
      type: 'tool.end',
      runId,
      seq: seq * 2 + 1,
      ts: seq,
      toolCallId: id,
      status: 'ok',
    } as never);
    focusedPane().transcript.flush();
  });
}

function mount(): void {
  render(
    <TooltipProvider>
      <Transcript />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  asked = [];
  seq = 0;
  conversation += 1;
  RUN = `run_${conversation}`;
  SESSION = `sess_${conversation}`;
  RUN2 = `run_${conversation}_b`;
  SESSION2 = `sess_${conversation}_b`;
  // One column, no leftovers from a split in a previous test.
  for (const pane of useApp.getState().grid.flatMap((row) => row.panes).slice(1)) {
    closePane(pane.id);
  }
  // A fresh transcript, and no memory of folds opened in the last test: fold
  // state is keyed by transcript id and these fixtures reuse ids.
  forgetFolds();
  focusedPane().transcript.reset();
  focusedPane().transcript.flush();
  useApp.setState({ previews: [] });
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: NO_CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/Users/me/project',
    run: aRun(RUN, SESSION),
    resumeSessionId: null,
    permissionQueue: [],
    conversationWidth: 'comfortable',
    runSummary: 'always',
  });
});

afterEach(cleanup);

describe('the artifact tile', () => {
  it('replaces the tool row for a page written outside the project', async () => {
    await wrote(RUN, '/tmp/report.html');
    mount();

    // Named by what it is, not by the tool that made it.
    expect(screen.getByText('report.html')).not.toBeNull();
    expect(screen.getByRole('button', { name: /open/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^preview$/i })).toBeNull();
  });

  it('keeps the diff one click away underneath', async () => {
    await wrote(RUN, '/tmp/report.html');
    mount();

    // The tile is not a replacement for the record — the write is still a tool
    // call, and its arguments are still there.
    fireEvent.click(screen.getByRole('button', { name: /show the diff/i }));
    expect(screen.getByText(/raw arguments|input/i)).not.toBeNull();
  });

  /*
   * The reason the two tests above no longer open anything first.
   *
   * An artifact surrounded on both sides by ordinary work still has to be on
   * screen and still has to be openable, because the marker it would otherwise
   * fold into says "Ran a command, edited 1 file" — a description of the work
   * that gives no hint the thing the work produced is in there.
   */
  it('an artifact is never behind the marker', async () => {
    await ranACommand(RUN);
    await wrote(RUN, '/tmp/report.html');
    await ranACommand(RUN);
    mount();

    // Visible with nothing expanded, and usable from there.
    expect(screen.getByText('report.html')).not.toBeNull();
    expect(screen.getByRole('button', { name: /open/i })).not.toBeNull();
  });

  /*
   * Lifted out, not split apart.
   *
   * The commands on either side of the artifact are one burst and have to stay
   * one burst: ending the run at each artifact would mean the more the agent
   * made, the more machinery the reader scrolls past to reach it.
   */
  it('leaves the work around it as a single folded line', async () => {
    await ranACommand(RUN);
    await wrote(RUN, '/tmp/report.html');
    await ranACommand(RUN);
    mount();

    // One marker for two commands, not one marker per side of the tile — and it
    // does not claim the file, which is sitting right there as a tile.
    const markers = screen.getAllByText(/^Ran \d+ commands?/i);
    expect(markers.length).toBe(1);
    expect(markers[0]?.textContent).toMatch(/^Ran 2 commands$/i);
    expect(markers[0]?.textContent).not.toMatch(/file/i);
  });

  it('folds to nothing when every call was an artifact', async () => {
    await wrote(RUN, '/tmp/one.html');
    await wrote(RUN, '/tmp/two.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    mount();

    // Both tiles, and no marker: with them lifted there is no work left to hide.
    expect(screen.getByText('one.html')).not.toBeNull();
    expect(screen.getByText('two.svg')).not.toBeNull();
    expect(screen.queryByText(/^(Edited|Wrote|Read|Ran)/i)).toBeNull();
  });

  it('still folds a burst that made nothing worth looking at', async () => {
    await ranACommand(RUN);
    await ranACommand(RUN);
    mount();

    // No tile, and the cards are behind the marker exactly as before.
    expect(screen.queryByRole('button', { name: /open/i })).toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();
    openTheMarker();
    expect(screen.getAllByText('Bash').length).toBe(2);
  });

  /*
   * Where the tile stands. The tiles used to come out under the marker at the
   * foot of the run, which in a long turn put every one of them at the bottom
   * of the conversation with each new paragraph arriving *above* the stack —
   * twenty documents were twenty tiles to scroll back past to find the words.
   */
  it('stands where it was made, between the sentence before and the one after', async () => {
    await said(RUN, 'm1', 'the report first');
    await wrote(RUN, '/tmp/report.html');
    await said(RUN, 'm2', 'and that is that');
    await ranACommand(RUN);
    mount();

    const before = screen.getByText('the report first');
    const tile = screen.getByText('report.html');
    const after = screen.getByText('and that is that');
    const marker = screen.getByText(/^Ran (a|1) command/i);
    expect(follows(before, tile)).toBe(true);
    expect(follows(tile, after)).toBe(true);
    // The machinery still sinks: the one command is a marker at the foot,
    // below everything the agent said and made.
    expect(follows(after, marker)).toBe(true);
  });

  it('leaves an ordinary tool row for a page written into the project', async () => {
    await wrote(RUN, '/Users/me/project/index.html');
    mount();
    openTheMarker();

    // The Preview button, not a tile: this is source, and the reader wants the diff.
    expect(screen.getByRole('button', { name: /^preview$/i })).not.toBeNull();
  });

  it('leaves an ordinary tool row for a fragment', async () => {
    await wrote(RUN, '/tmp/partial.html', '<div class="row">x</div>');
    mount();
    openTheMarker();

    expect(screen.getByRole('button', { name: /^preview$/i })).not.toBeNull();
  });
});

describe('opening by itself', () => {
  it('opens the pane for the first artifact of a conversation', async () => {
    await wrote(RUN, '/tmp/report.html');

    expect(asked).toEqual(['/tmp/report.html']);
    expect(previewPaths()).toContain('/tmp/report.html');
  });

  it('does not open a second time, and leaves the first where it is', async () => {
    await wrote(RUN, '/tmp/one.html');
    await wrote(RUN, '/tmp/two.html');

    // The second one is a tile and nothing more. One uninvited pane per
    // conversation is the whole allowance.
    expect(asked).toEqual(['/tmp/one.html']);
    expect(previewPaths()).toContain('/tmp/one.html');
  });

  it('stays shut once the user has closed it', async () => {
    await wrote(RUN, '/tmp/one.html');
    act(() => {
      useApp.setState({ previews: [] });
    });

    await wrote(RUN, '/tmp/two.html');
    expect(useApp.getState().previews).toEqual([]);
  });

  it('refreshes itself when the page on screen is the one that changed', async () => {
    await wrote(RUN, '/tmp/report.html');
    // An edit — not a whole write — to the file already framed.
    const id = 'edit1';
    await act(async () => {
      handleAgentEvent({
        type: 'tool.start',
        runId: RUN,
        seq: 90,
        ts: 90,
        toolCallId: id,
        name: 'Edit',
        input: { file_path: '/tmp/report.html', old_string: 'hi', new_string: 'hello' },
      } as AgentEvent);
      handleAgentEvent({
        type: 'tool.end',
        runId: RUN,
        seq: 91,
        ts: 91,
        toolCallId: id,
        status: 'ok',
      } as never);
    });

    // Asked again for the same path: the user is looking at this exact file and
    // it changed underneath them.
    expect(asked).toEqual(['/tmp/report.html', '/tmp/report.html']);
  });

  it('does not open from a write that failed', async () => {
    await wrote(RUN, '/tmp/report.html', PAGE, 'error');

    expect(asked).toEqual([]);
    expect(useApp.getState().previews).toEqual([]);
  });

  it('does not take the window for a column that is not focused', async () => {
    const right = splitPane('right');
    expect(right).not.toBeNull();
    setPaneState(right!, { run: aRun(RUN2, SESSION2), cwd: '/Users/me/project' });

    // Focus stays on the right after a split, so point it back at the left and
    // have the *right* column write.
    act(() => {
      useApp.setState({ focusedPaneId: focusedPane().id });
    });
    const left = useApp.getState().grid[0]!.panes[0]!;
    act(() => {
      useApp.setState({ focusedPaneId: left.id });
    });

    await wrote(RUN2, '/tmp/background.html');

    expect(asked).toEqual([]);
    expect(useApp.getState().previews).toEqual([]);
  });
});

describe('an artifact belongs to its conversation', () => {
  it('closes when the owning column is closed', async () => {
    const right = splitPane('right');
    setPaneState(right!, { run: aRun(RUN2, SESSION2), cwd: '/Users/me/project' });
    act(() => {
      useApp.setState({ focusedPaneId: right!.id });
    });

    await wrote(RUN2, '/tmp/report.html');
    expect(previewPaths()).toContain('/tmp/report.html');

    act(() => {
      closePane(right!.id);
    });

    expect(useApp.getState().previews).toEqual([]);
  });

  it('closes when the column moves to a different session', async () => {
    await wrote(RUN, '/tmp/report.html');
    expect(useApp.getState().previews).not.toEqual([]);

    // Resuming something else into this column: same column, different
    // conversation, and the artifact belonged to the one that left.
    act(() => {
      setPaneState(focusedPane(), { run: aRun(`${RUN}_other`, `${SESSION}_other`), resumeSessionId: null });
    });

    expect(useApp.getState().previews).toEqual([]);
  });

  it('survives the run that made it ending', async () => {
    await wrote(RUN, '/tmp/report.html');

    act(() => {
      setPaneState(focusedPane(), {
        run: { ...aRun(RUN, SESSION), status: 'ended', endReason: 'complete' },
      });
    });

    // The conversation is still in the column; only the turn is over.
    expect(previewPaths()).toContain('/tmp/report.html');
  });

  it('follows the conversation when it is still there under a resume pointer', async () => {
    await wrote(RUN, '/tmp/report.html');

    // A finished conversation with no live run is identified by what the next
    // prompt would continue — the case `sessionShownBy` exists for.
    act(() => {
      setPaneState(focusedPane(), { run: null, resumeSessionId: SESSION });
    });

    expect(previewPaths()).toContain('/tmp/report.html');
  });
});
