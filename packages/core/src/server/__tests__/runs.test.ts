/**
 * Runs that outlive the request that started them.
 * ============================================================================
 *
 * Two deadlines and one authorisation rule, exercised through
 * `handleServerRequest` rather than against `RunDirectory` alone: ownership is
 * the whole security model of the three completions run verbs, and a test that
 * called the directory directly would prove the record correct while saying
 * nothing about whether the routes consult it.
 *
 * Adapted from David's `ffd9031`. What is *not* here is his run list and his
 * `?afterSeq=` replay: both paths belong to the remote bridge on this fork —
 * see `dispatch.test.ts` for the precedence that keeps them there — so an
 * authorised touch is spelled with `messages` instead.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, RunHandle, ServerProfile } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { Catalogue } from '../catalogue.js';
import { UNATTENDED_PERMISSION_MESSAGE, type RunSource } from '../completions.js';
import { handleServerRequest, type ServerContext } from '../http.js';
import { createRunDirectory, type RunDirectory } from '../runs.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const OTHER_TOKEN = 'other-token-abcdefghijklmnopqrstuvwx';

const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'directory' as const, path: '/w' },
  token: TOKEN,
  createdAt: 0,
};

/** A second token on the same directory — same visibility, different ownership. */
const NEIGHBOUR = { ...CONNECTION, id: 'conn-2', label: 'Neighbour', token: OTHER_TOKEN };

const catalogue: Catalogue = {
  read: async () => [] as readonly ServerProfile[],
  invalidate: () => undefined,
};

const HANDLE: RunHandle = {
  runId: 'run-1',
  providerId: 'claude',
  profileId: 'prof-a',
  cwd: '/w',
  status: 'running',
  capabilities: NO_CAPABILITIES,
  startedAt: 0,
};

/** An engine that records what it was asked and can be made to refuse once. */
function fakeEngine() {
  const listeners = new Set<(event: AgentEvent) => void>();
  const calls: { name: string; args: readonly unknown[] }[] = [];
  let failNext: Error | undefined;

  const guard = (): void => {
    if (failNext === undefined) return;
    const error = failNext;
    failNext = undefined;
    throw error;
  };

  const emit = (event: Partial<AgentEvent>): void => {
    const full = { runId: 'run-1', seq: 0, ts: 0, ...event } as AgentEvent;
    for (const listener of listeners) listener(full);
  };

  const source: RunSource = {
    startRun: async () => HANDLE,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (runId, text) => {
      calls.push({ name: 'send', args: [runId, text] });
      guard();
      return { deliveredImmediately: true };
    },
    interrupt: async (runId) => {
      calls.push({ name: 'interrupt', args: [runId] });
      guard();
    },
    respondToPermission: async (runId, requestId, decision) => {
      calls.push({ name: 'respondToPermission', args: [runId, requestId, decision] });
      guard();
    },
    disposeRun: async (runId) => {
      calls.push({ name: 'disposeRun', args: [runId] });
    },
  };

  return {
    source,
    calls,
    emit,
    fail: (error: Error) => {
      failNext = error;
    },
  };
}

const directories: RunDirectory[] = [];
afterEach(() => {
  while (directories.length > 0) directories.pop()?.close();
});

/** A server with the run verbs, and a clock a test can move six hours in one line. */
function harness(options: { readonly ttlMs?: number; readonly parkMs?: number } = {}) {
  const engine = fakeEngine();
  let clock = 1_000;
  const directory = createRunDirectory({
    runs: engine.source,
    detachedRunTtlMs: options.ttlMs ?? 60_000,
    permissionParkMs: options.parkMs ?? 10_000,
    now: () => clock,
    // No interval: the sweep is called explicitly, and a timer would be racing
    // every assertion about what it had already done.
    sweepIntervalMs: 0,
  });
  directories.push(directory);

  const context: ServerContext = {
    connections: [CONNECTION, NEIGHBOUR],
    version: '1.1.1',
    catalogue,
    startedAt: 0,
    runs: engine.source,
    runDirectory: directory,
  };

  return {
    engine,
    directory,
    advance: (ms: number) => {
      clock += ms;
    },
    call: (
      url: string,
      init: { readonly method?: string; readonly body?: unknown; readonly token?: string } = {},
    ) =>
      handleServerRequest(
        {
          method: init.method ?? 'GET',
          url,
          headers: { host: '127.0.0.1:6472', authorization: `Bearer ${init.token ?? TOKEN}` },
          ...(init.body === undefined ? {} : { body: init.body }),
        },
        context,
      ),
  };
}

/** Record run-1 as CONNECTION's, the way the completions route does. */
function own(
  directory: RunDirectory,
  overrides: { readonly detachable?: boolean; readonly permissions?: boolean } = {},
): void {
  directory.claim({
    runId: 'run-1',
    connectionId: CONNECTION.id,
    permissions: overrides.permissions ?? false,
  });
  // The turn is what decides a run may be kept; the directory learns it from
  // the handover. Mirrored here so a test reads the way the real path runs.
  if (overrides.detachable === true) directory.noteDetached('run-1');
}

describe('a run belongs to the connection that started it', () => {
  it('lets its own connection steer it', async () => {
    const { directory, engine, call } = harness();
    own(directory);

    const reply = await call('/api/v0/runs/run-1/messages', {
      method: 'POST',
      body: { text: 'try the other file' },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ runId: 'run-1', deliveredImmediately: true });
    expect(engine.calls).toEqual([{ name: 'send', args: ['run-1', 'try the other file'] }]);
  });

  it('refuses another token holding the same id, with nothing to confirm', async () => {
    // The threat is not guessing a run id — the server minted it — it is
    // *confirming* one. "Not yours" and "never existed" are one sentence.
    const { directory, engine, call } = harness();
    own(directory);

    const mine = await call('/api/v0/runs/run-1/messages', {
      method: 'POST',
      body: { text: 'x' },
    });
    const theirs = await call('/api/v0/runs/run-1/messages', {
      method: 'POST',
      body: { text: 'x' },
      token: OTHER_TOKEN,
    });
    const absent = await call('/api/v0/runs/no-such-run/messages', {
      method: 'POST',
      body: { text: 'x' },
      token: OTHER_TOKEN,
    });

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body)).toEqual(JSON.stringify(absent.body));
    // And the engine never heard about the refused ones.
    expect(engine.calls).toHaveLength(1);
  });

  it('refuses a body it cannot act on', async () => {
    const { directory, call } = harness();
    own(directory);
    expect((await call('/api/v0/runs/run-1/messages', { method: 'POST' })).status).toBe(400);
    expect(
      (await call('/api/v0/runs/run-1/messages', { method: 'POST', body: { text: '  ' } })).status,
    ).toBe(400);
  });

  it("passes a run's own refusal through, and nothing else's", async () => {
    // The caller owns this run, so "already ended" is a fact about their own
    // conversation. An error from anywhere else is an unbounded adapter string.
    const { directory, engine, call } = harness();
    own(directory);
    engine.fail(new Error('a path and a command line'));

    const reply = await call('/api/v0/runs/run-1/messages', {
      method: 'POST',
      body: { text: 'x' },
    });
    expect(reply.status).toBe(502);
    expect(JSON.stringify(reply.body)).not.toContain('command line');
  });
});

describe('answering a permission prompt over the wire', () => {
  it('delivers an approval to the run', async () => {
    const { directory, engine, call } = harness();
    own(directory, { permissions: true });

    const reply = await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: {
        requestId: 'perm-1',
        decision: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
      },
    });
    expect(reply.body).toEqual({ requestId: 'perm-1' });
    expect(engine.calls.at(-1)).toEqual({
      name: 'respondToPermission',
      args: ['run-1', 'perm-1', { behavior: 'allow', updatedInput: { command: 'ls -la' } }],
    });
  });

  it('delivers a denial with the reason the client typed', async () => {
    const { directory, engine, call } = harness();
    own(directory, { permissions: true });

    await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: { requestId: 'perm-1', decision: { behavior: 'deny', message: 'not that folder' } },
    });
    expect(engine.calls.at(-1)?.args[2]).toEqual({
      behavior: 'deny',
      message: 'not that folder',
    });
  });

  it('refuses bypassPermissions, whatever else the request says', async () => {
    // The one decision that would turn a leaked token from "an agent in one
    // folder" into "an agent with no brakes in one folder". Refused at the
    // parser, so no ordering of checks can leave a path around it.
    const { directory, engine, call } = harness();
    own(directory, { permissions: true });

    const reply = await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: {
        requestId: 'perm-1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', scope: 'session' }],
        },
      },
    });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('bypassPermissions');
    expect(engine.calls).toEqual([]);
  });

  it('refuses every other mode switch too, rather than enumerating against one', async () => {
    const { directory, engine, call } = harness();
    own(directory, { permissions: true });

    const reply = await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: {
        requestId: 'perm-1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
        },
      },
    });
    expect(reply.status).toBe(400);
    expect(engine.calls).toEqual([]);
  });

  it("refuses a rule written to the serving machine's own settings", async () => {
    // `local`, `project` and `user` outlive the run and belong to the person
    // running the server. A remote "always allow" is honoured for the session.
    const { directory, engine, call } = harness();
    own(directory, { permissions: true });

    const durable = await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: {
        requestId: 'perm-1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [
            { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }], scope: 'user' },
          ],
        },
      },
    });
    expect(durable.status).toBe(400);

    const session = await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: {
        requestId: 'perm-1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Bash' }],
              scope: 'session',
            },
          ],
        },
      },
    });
    expect(session.status).toBe(200);
    expect(engine.calls).toHaveLength(1);
  });

  it('refuses a decision that would widen the directories the run may touch', async () => {
    const { directory, engine, call } = harness();
    own(directory, { permissions: true });

    const reply = await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: {
        requestId: 'perm-1',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'addDirectories', directories: ['/'], scope: 'session' }],
        },
      },
    });
    expect(reply.status).toBe(400);
    expect(engine.calls).toEqual([]);
  });

  it('refuses a decision it cannot read at all', async () => {
    const { directory, call } = harness();
    own(directory, { permissions: true });
    expect(
      (
        await call('/api/v0/runs/run-1/permission', {
          method: 'POST',
          body: { requestId: 'perm-1', decision: { behavior: 'maybe' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/api/v0/runs/run-1/permission', {
          method: 'POST',
          body: { decision: { behavior: 'allow' } },
        })
      ).status,
    ).toBe(400);
  });
});

describe('the deadlines on a run nobody is watching', () => {
  const parked = {
    type: 'permission.request',
    requestId: 'perm-1',
    request: {},
  } as Partial<AgentEvent>;

  it('reaps a detached run that nobody came back for', async () => {
    const { directory, engine, advance } = harness({ ttlMs: 60_000 });
    own(directory, { detachable: true });

    advance(59_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);

    advance(2_000);
    await directory.sweep();
    expect(engine.calls.map((entry) => entry.name)).toEqual(['interrupt', 'disposeRun']);
  });

  it('holds off for as long as the owner keeps coming back', async () => {
    // The clock is "how long since anyone came back for it", not "how long
    // since the socket closed" — reaping a run out from under a client that is
    // still steering it would be the feature failing in its own scenario.
    const { directory, engine, advance, call } = harness({ ttlMs: 60_000 });
    own(directory, { detachable: true });

    for (let poll = 0; poll < 4; poll += 1) {
      advance(50_000);
      await call('/api/v0/runs/run-1/messages', { method: 'POST', body: { text: 'still here' } });
      await directory.sweep();
    }
    expect(engine.calls.filter((entry) => entry.name === 'interrupt')).toEqual([]);

    advance(61_000);
    await directory.sweep();
    expect(engine.calls.some((entry) => entry.name === 'interrupt')).toBe(true);
  });

  it('does not restart the clock for a token that does not own the run', async () => {
    // `noteSeen` runs after the ownership check, not before it, so a neighbour
    // poking at an id cannot keep somebody else's run alive.
    const { directory, engine, advance, call } = harness({ ttlMs: 60_000 });
    own(directory, { detachable: true });

    advance(50_000);
    await call('/api/v0/runs/run-1/messages', {
      method: 'POST',
      body: { text: 'x' },
      token: OTHER_TOKEN,
    });
    advance(11_000);
    await directory.sweep();
    expect(engine.calls.map((entry) => entry.name)).toEqual(['interrupt', 'disposeRun']);
  });

  it('never reaps a run whose client is still attached', async () => {
    // No handover has happened, so nothing here owns the run's death: the turn
    // still does, and it will interrupt on teardown as it always did.
    const { directory, engine, advance } = harness({ ttlMs: 60_000 });
    own(directory);

    advance(10 * 60_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);
  });

  it('reaps a detached run exactly once, however long it takes to die', async () => {
    const { directory, engine, advance } = harness({ ttlMs: 60_000 });
    own(directory, { detachable: true });

    advance(61_000);
    await directory.sweep();
    advance(61_000);
    await directory.sweep();
    expect(engine.calls.filter((entry) => entry.name === 'interrupt')).toHaveLength(1);
  });

  it('denies a prompt nobody answered, in the words an unattended turn gets', async () => {
    const { directory, engine, advance } = harness({ parkMs: 10_000 });
    own(directory, { permissions: true });
    engine.emit(parked);

    advance(9_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);

    advance(2_000);
    await directory.sweep();
    expect(engine.calls.at(-1)).toEqual({
      name: 'respondToPermission',
      args: ['run-1', 'perm-1', { behavior: 'deny', message: UNATTENDED_PERMISSION_MESSAGE }],
    });
  });

  it("leaves a detached run's prompt for the client that went away holding it", async () => {
    // A laptop that slept on an approval wakes to grant it. Denying on the
    // user's behalf while they were away would be the server making the one
    // decision it was told not to make; the run's own deadline still bounds it.
    const { directory, engine, advance } = harness({ ttlMs: 600_000, parkMs: 10_000 });
    own(directory, { detachable: true, permissions: true });
    engine.emit(parked);

    advance(60_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);
  });

  it('forgets a prompt the run settled on its own', async () => {
    const { directory, engine, advance } = harness({ parkMs: 10_000 });
    own(directory, { permissions: true });
    engine.emit(parked);
    engine.emit({
      type: 'permission.resolved',
      requestId: 'perm-1',
      outcome: 'withdrawn',
    } as Partial<AgentEvent>);

    advance(60_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);
  });

  it('forgets a prompt answered through the route', async () => {
    // Belt and braces on the `permission.resolved` event: an adapter that
    // settles a request without announcing it would otherwise leave a deadline
    // running against a decision already made.
    const { directory, engine, advance, call } = harness({ parkMs: 10_000 });
    own(directory, { permissions: true });
    engine.emit(parked);

    await call('/api/v0/runs/run-1/permission', {
      method: 'POST',
      body: { requestId: 'perm-1', decision: { behavior: 'allow' } },
    });
    advance(60_000);
    await directory.sweep();
    expect(engine.calls.filter((entry) => entry.name === 'respondToPermission')).toHaveLength(1);
  });

  it('tracks no prompt at all for a run that never asked to see them', async () => {
    // Those are denied by the turn the instant they arrive, so a deadline here
    // would be a second answer to a settled question.
    const { directory, engine, advance } = harness({ parkMs: 10_000 });
    own(directory);
    engine.emit(parked);

    advance(60_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);
  });

  it('stops watching an ended run rather than reaping a corpse', async () => {
    const { directory, engine, advance } = harness({ ttlMs: 60_000 });
    own(directory, { detachable: true });
    engine.emit({ type: 'run.end', reason: 'completed' } as Partial<AgentEvent>);

    advance(61_000);
    await directory.sweep();
    expect(engine.calls).toEqual([]);
  });
});

describe('a client that comes back', () => {
  it('stops the abandoned-run clock and starts the parked prompts\' one', async () => {
    /*
     * The mirror image of detaching. A detached run's prompt waits without a
     * deadline — nobody is there to answer it — and the run itself is reaped
     * after the TTL. A client attaching to the run's stream is somebody being
     * there again: the run is no longer abandoned, and the question in front
     * of the person who just walked in is counted from now.
     */
    const { engine, directory, advance } = harness({ ttlMs: 60_000, parkMs: 10_000 });
    directory.claim({ runId: 'run-1' as never, connectionId: 'conn-1', permissions: true, route: 'work-max/opus' });
    directory.noteDetached('run-1' as never);
    engine.emit({
      type: 'permission.request',
      requestId: 'perm-1',
      request: { id: 'perm-1', toolName: 'Bash', input: {} },
    } as never);

    // Detached: the prompt waits past its deadline, untouched.
    advance(30_000);
    await directory.sweep();
    expect(engine.calls.map((call) => call.name)).toEqual([]);

    directory.noteAttached('run-1' as never);
    expect(directory.routeOf('run-1' as never)).toBe('work-max/opus');

    // Attached: the run's own deadline is off, however long it has been.
    advance(60_000);
    await directory.sweep();
    expect(engine.calls.map((call) => call.name)).toEqual(['respondToPermission']);
    expect(engine.calls[0]?.args[1]).toBe('perm-1');
    // …and the prompt was denied ten seconds after the attach, not thirty
    // seconds before it: the clock restarted when somebody arrived.
    expect(engine.calls.some((call) => call.name === 'interrupt')).toBe(false);
  });

  it('does not resurrect a run that has ended', async () => {
    const { engine, directory, advance } = harness({ ttlMs: 60_000 });
    directory.claim({ runId: 'run-1' as never, connectionId: 'conn-1', permissions: false });
    engine.emit({ type: 'run.end', reason: 'completed' } as never);
    directory.noteAttached('run-1' as never);
    advance(120_000);
    await directory.sweep();
    expect(directory.owns('conn-1', 'run-1' as never)).toBe(false);
  });
});
