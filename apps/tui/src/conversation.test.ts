import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Capabilities,
  PermissionRequest,
  RunHandle,
  RunId,
  RunInput,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import { syncScheduler } from '@rx-artemis/transcript';

import { Conversation, type ConversationSettings, type RunDriver } from './conversation.js';

const CLAUDE: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  resumeSession: true,
  permissionModes: ['default', 'plan', 'acceptEdits'],
};

const settings: ConversationSettings = {
  profileId: 'p1' as never,
  providerId: 'claude',
  profileLabel: 'work',
  providerLabel: 'Claude',
  cwd: '/repo',
  permissionMode: 'default',
};

/** A registry that records calls and lets a test emit events by hand. */
function fakeDriver(capabilities: Capabilities = CLAUDE) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const active = new Set<RunId>();
  const handles = new Map<RunId, RunHandle>();
  let seq = 0;
  const driver: RunDriver & {
    emit(event: Omit<AgentEvent, 'seq' | 'ts'>): void;
    start: ReturnType<typeof vi.fn<(input: RunInput) => Promise<RunHandle>>>;
    send: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    respondToPermission: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    stopTask: ReturnType<typeof vi.fn>;
  } = {
    start: vi.fn(async (input: RunInput) => {
      const runId = input.runId as RunId;
      active.add(runId);
      const handle: RunHandle = {
        runId,
        providerId: input.providerId,
        profileId: input.profileId,
        cwd: input.cwd,
        status: 'running',
        capabilities,
        startedAt: 0,
        promptCount: 1,
      };
      handles.set(runId, handle);
      return handle;
    }),
    send: vi.fn(async () => ({ deliveredImmediately: false })),
    interrupt: vi.fn(async () => ({})),
    respondToPermission: vi.fn(async () => undefined),
    dispose: vi.fn(async () => ({})),
    stopTask: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (runId) => handles.get(runId),
    isActive: (runId) => active.has(runId),
    emit(event) {
      const full = { ...event, seq: seq++, ts: 0 } as AgentEvent;
      if (full.type === 'run.end') active.delete(full.runId);
      for (const listener of listeners) listener(full);
    },
  };
  return driver;
}

const ids = (() => {
  let n = 0;
  return () => `run-${++n}` as RunId;
})();

function conversation(driver: RunDriver, overrides: Partial<ConversationSettings> = {}) {
  return new Conversation({
    driver,
    settings: { ...settings, ...overrides },
    capabilitiesFor: () => CLAUDE,
    scheduler: syncScheduler,
    newRunId: ids,
  });
}

const rows = (c: Conversation) =>
  c.transcript.getRowsSnapshot().map((id) => c.transcript.getItem(id) ?? c.transcript.getGroup(id));

describe('Conversation', () => {
  it('starts a run for the first message and resumes the session for the next', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);

    expect(await c.send('hello')).toEqual({ ok: true });
    const first = driver.start.mock.calls[0]?.[0];
    expect(first).toMatchObject({ prompt: 'hello', permissionMode: 'default', cwd: '/repo' });
    expect(first?.resumeSessionId).toBeUndefined();
    expect(c.getState().status).toBe('running');

    // The optimistic row is confirmed once start() resolves.
    const user = rows(c)[0];
    expect(user).toMatchObject({ kind: 'user', text: 'hello', pending: false });

    const runId = first?.runId as RunId;
    driver.emit({ type: 'session.started', runId, sessionId: 's1' as never, providerId: 'claude', cwd: '/repo' });
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    expect(c.getState().status).toBe('idle');
    expect(c.getState().sessionId).toBe('s1');
    expect(driver.dispose).toHaveBeenCalledWith(runId);

    await c.send('again');
    expect(driver.start.mock.calls[1]?.[0]).toMatchObject({ prompt: 'again', resumeSessionId: 's1' });
  });

  it('steers a live run when the provider allows it, and tracks queued delivery', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('first');
    const runId = c.getState().runId as RunId;

    expect(await c.send('and also')).toEqual({ ok: true });
    expect(driver.send).toHaveBeenCalledWith(runId, 'and also');
    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(c.getState().queued).toBe(1);
    expect(rows(c)[1]).toMatchObject({ kind: 'user', text: 'and also', messageId: `${runId}:prompt:2` });

    driver.emit({ type: 'message.delivered', runId, messageId: `${runId}:prompt:2` as never });
    expect(c.getState().queued).toBe(0);
  });

  it('refuses a mid-turn message on a provider without steering', async () => {
    const driver = fakeDriver({ ...CLAUDE, midRunSteering: false });
    const c = new Conversation({
      driver,
      settings: { ...settings, providerLabel: 'OpenCode' },
      capabilitiesFor: () => ({ ...CLAUDE, midRunSteering: false }),
      scheduler: syncScheduler,
      newRunId: ids,
    });
    await c.send('first');
    const outcome = await c.send('second');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/OpenCode cannot take a message mid-turn/);
    expect(driver.send).not.toHaveBeenCalled();
  });

  it('carries a steer that raced the end of its run into a fresh run', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('first');
    const runId = c.getState().runId as RunId;
    driver.send.mockImplementationOnce(async () => {
      driver.emit({ type: 'run.end', runId, reason: 'completed', sessionId: 's9' as never });
      throw new Error('that run is over');
    });

    expect(await c.send('late')).toEqual({ ok: true });
    expect(driver.start).toHaveBeenCalledTimes(2);
    expect(driver.start.mock.calls[1]?.[0]).toMatchObject({ prompt: 'late', resumeSessionId: 's9' });
    // One row for the prompt, not two.
    expect(rows(c).filter((row) => row?.kind === 'user').map((row) => (row as { text: string }).text)).toEqual([
      'first',
      'late',
    ]);
  });

  it('tracks permission prompts and lets an allow with setMode change the next mode', async () => {
    const driver = fakeDriver();
    const c = conversation(driver, { permissionMode: 'plan' });
    await c.send('plan it');
    const runId = c.getState().runId as RunId;
    const request: PermissionRequest = {
      id: 'req-1' as never,
      runId,
      toolName: 'ExitPlanMode',
      input: {},
      requestedAt: 0,
    };
    driver.emit({ type: 'permission.request', runId, requestId: request.id, request });
    expect(c.getState().status).toBe('awaiting_permission');
    expect(c.getState().pendingPermissions.map((r) => r.id)).toEqual(['req-1']);

    await c.respondToPermission(request.id, {
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
    });
    expect(driver.respondToPermission).toHaveBeenCalledWith(runId, 'req-1', expect.anything());
    expect(c.getState().settings.permissionMode).toBe('acceptEdits');
    expect(c.getState().status).toBe('running');
    expect(c.getState().pendingPermissions).toEqual([]);
  });

  it('drops a card whose request is no longer open instead of surfacing an error', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('go');
    const runId = c.getState().runId as RunId;
    driver.emit({
      type: 'permission.request',
      runId,
      requestId: 'r' as never,
      request: { id: 'r' as never, runId, toolName: 'Bash', input: {}, requestedAt: 0 },
    });
    driver.respondToPermission.mockRejectedValueOnce(new Error('not open'));
    await c.respondToPermission('r' as never, { behavior: 'deny' });
    expect(c.getState().pendingPermissions).toEqual([]);
    expect(rows(c).some((row) => row?.kind === 'notice')).toBe(false);
  });

  it('omits a permission mode the provider does not have', async () => {
    const driver = fakeDriver();
    const c = new Conversation({
      driver,
      settings: { ...settings, permissionMode: 'bypassPermissions' },
      capabilitiesFor: () => CLAUDE,
      scheduler: syncScheduler,
      newRunId: ids,
    });
    await c.send('x');
    expect(driver.start.mock.calls[0]?.[0]?.permissionMode).toBeUndefined();
  });

  it('refuses an account change while live and ends the conversation when idle', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('x');
    expect(c.updateSettings({ profileId: 'p2' as never }).ok).toBe(false);
    expect(c.updateSettings({ model: 'fable' }).ok).toBe(true);

    driver.emit({ type: 'run.end', runId: c.getState().runId as RunId, reason: 'completed', sessionId: 's' as never });
    expect(c.getState().sessionId).toBe('s');
    expect(c.updateSettings({ profileId: 'p2' as never }).ok).toBe(true);
    expect(c.getState().sessionId).toBeUndefined();
    expect(c.transcript.isEmpty).toBe(true);
  });

  it('records a start failure in the transcript and returns to idle', async () => {
    const driver = fakeDriver();
    driver.start.mockRejectedValueOnce(new Error('no such profile'));
    const c = conversation(driver);
    const outcome = await c.send('x');
    expect(outcome).toEqual({ ok: false, reason: 'no such profile' });
    expect(c.getState().status).toBe('idle');
    expect(rows(c).some((row) => row?.kind === 'notice' && row.text === 'no such profile')).toBe(true);
  });

  it('keeps the background-task list as a replacement, across the end of the run', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('x');
    const runId = c.getState().runId as RunId;
    const task = { id: 't1', kind: 'local_bash', description: 'tests', status: 'running', startedAt: 0 } as const;
    driver.emit({ type: 'background.tasks', runId, tasks: [task] });
    expect(c.getState().tasks).toEqual([task]);
    driver.emit({ type: 'background.tasks', runId, tasks: [{ ...task, status: 'completed' }] });
    expect(c.getState().tasks[0]?.status).toBe('completed');
    driver.emit({ type: 'run.end', runId, reason: 'completed' });
    expect(c.getState().tasks).toHaveLength(1);
    // Stopping after the run ended still targets the run that started it.
    await c.stopTask('t1');
    expect(driver.stopTask).toHaveBeenCalledWith(runId, 't1');
  });

  it('folds plan.limit readings onto the plan snapshot and lets a fetch replace it', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    c.setPlanUsage({
      available: true,
      windows: [{ id: 'five_hour', label: '5 hours', utilization: 10, resetsAt: null }],
      fetchedAt: 0,
    });
    await c.send('x');
    const runId = c.getState().runId as RunId;
    driver.emit({
      type: 'plan.limit',
      runId,
      limit: { status: 'warning', windowId: 'five_hour', utilization: 85 },
    });
    expect(c.getState().planUsage?.windows[0]?.utilization).toBe(85);
    // A reading with no window is not a reason to forget.
    driver.emit({ type: 'plan.limit', runId, limit: { status: 'ok' } });
    expect(c.getState().planUsage?.windows[0]?.utilization).toBe(85);
  });

  it('loads a stored conversation and resumes it on the next turn', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    const old = 'old-run' as RunId;
    const outcome = c.loadHistory('s-old' as never, [
      { type: 'text.complete', runId: old, seq: 0, ts: 0, messageId: 'm1' as never, role: 'user', text: 'earlier', replay: true },
      { type: 'text.complete', runId: old, seq: 1, ts: 0, messageId: 'm2' as never, role: 'assistant', text: 'yes', replay: true },
    ]);
    expect(outcome.ok).toBe(true);
    expect(rows(c).map((row) => row?.kind)).toEqual(['user', 'assistant']);
    await c.send('and now');
    expect(driver.start.mock.calls[0]?.[0]).toMatchObject({ resumeSessionId: 's-old' });
  });

  it('refuses attachments the provider cannot take, and passes the rest through', async () => {
    const driver = fakeDriver({ ...CLAUDE, imageInput: false, fileInput: true });
    const c = new Conversation({
      driver,
      settings,
      capabilitiesFor: () => ({ ...CLAUDE, imageInput: false, fileInput: true }),
      scheduler: syncScheduler,
      newRunId: ids,
    });
    const image = { kind: 'image', id: 'i', mediaType: 'image/png', data: 'AAAA' } as const;
    const file = { kind: 'file', id: 'f', name: 'notes.txt', data: 'AAAA' } as const;
    expect((await c.send('look', [image])).ok).toBe(false);
    expect(driver.start).not.toHaveBeenCalled();
    expect((await c.send('read', [file])).ok).toBe(true);
    expect(driver.start.mock.calls[0]?.[0]?.attachments).toEqual([file]);
  });

  it('folds usage: deltas add, cumulative replaces', async () => {
    const driver = fakeDriver();
    const c = conversation(driver);
    await c.send('x');
    const runId = c.getState().runId as RunId;
    driver.emit({ type: 'usage', runId, usage: { scope: 'delta', tokens: { inputTokens: 10, outputTokens: 1 } } });
    driver.emit({ type: 'usage', runId, usage: { scope: 'delta', tokens: { inputTokens: 5, outputTokens: 2 }, costUsd: 0.5 } });
    expect(c.getState().usage?.tokens).toEqual({ inputTokens: 15, outputTokens: 3 });
    expect(c.getState().usage?.costUsd).toBe(0.5);
    driver.emit({ type: 'usage', runId, usage: { scope: 'cumulative', tokens: { inputTokens: 100, outputTokens: 9 } } });
    expect(c.getState().usage?.tokens.inputTokens).toBe(100);
  });
});
