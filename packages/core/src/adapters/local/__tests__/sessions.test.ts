/**
 * A local model that remembers the last thing it was told.
 * ============================================================================
 *
 * The defect these pin is not subtle and was invisible from inside the app: an
 * inference server is a pure function of the array it is sent, this adapter
 * sent `[system?, latest user message]`, and so every turn began a fresh
 * conversation with a model the user believed was following one. Asked "what
 * did I just ask you?", it guessed — plausibly, which is what made it hard to
 * notice.
 *
 * So the assertion that matters is about the *request body*: what came back is
 * the model's business, and what went out is Artemis's. These drive the adapter
 * against a real local server, for the reason `endpoint.test.ts` gives — a
 * stubbed `fetch` would be asserting that the test's idea of the request
 * matches the test's idea of the request.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent, ProfileId, RunId, SessionId } from '@rx-artemis/protocol';

import { encodeProjectDir } from '../../claudeSessionSpawn.js';
import { createLocalAdapter, LLAMA_CPP, BASE_URL_ENV } from '../adapter.js';
import { LOCAL_PROFILE_DIR_ENV } from '../sessionStore.js';
import type { ResolvedRunInput, Run } from '../../types.js';

const PROFILE = 'profile-1' as ProfileId;

const servers: Server[] = [];
let profileDir: string;
let cwd: string;

/** A message as it appears in a recorded request body. */
interface WireMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_call_id?: string;
}

/**
 * Everything a run asks for that is not a completion.
 *
 * A run also probes for the size of the context window — `/props`, then
 * `/v1/models` — and these fixtures used to answer *every* path with the next
 * scripted completion. That made the probe eat a scripted reply and a `GET`
 * with no body reach a `JSON.parse`. Answering 404 is what a server that does
 * not expose those endpoints does, and the reading degrades to "unknown", which
 * is the state under test everywhere else in this file: none of it is about the
 * window.
 */
function notACompletion(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url === '/v1/chat/completions') return false;
  request.resume();
  response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  return true;
}

/**
 * A server that answers completions with a scripted reply, recording what it
 * was sent. One reply per request, then a plain acknowledgement.
 */
async function serveCompletions(
  ...replies: string[]
): Promise<{ origin: string; bodies: { messages: WireMessage[] }[] }> {
  const bodies: { messages: WireMessage[] }[] = [];
  let answered = 0;

  const server = createServer((request: IncomingMessage, response) => {
    if (notACompletion(request, response)) return;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: WireMessage[] });
      const text = replies[answered++] ?? 'ok';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, bodies };
}

/**
 * A server whose first answer asks for a shell command, and whose later ones
 * are plain text.
 *
 * The id is omitted deliberately: llama.cpp and Ollama both do, which is what
 * makes `call_0` the id of every turn's first tool call.
 */
async function serveToolCall(calls = 1): Promise<{ origin: string }> {
  let answered = 0;
  const server = createServer((request: IncomingMessage, response) => {
    if (notACompletion(request, response)) return;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta =
        answered++ === 0
          ? {
              tool_calls: Array.from({ length: calls }, (_unused, index) => ({
                index,
                function: { name: 'shell', arguments: '{"command":"ls"}' },
              })),
            }
          : { content: 'all done' };
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}` };
}

function input(origin: string, overrides: Partial<ResolvedRunInput> = {}): ResolvedRunInput {
  return {
    providerId: 'llamacpp',
    profileId: PROFILE,
    cwd,
    prompt: 'hello',
    runId: `run-${String(Math.random()).slice(2)}` as RunId,
    env: { [BASE_URL_ENV]: origin, [LOCAL_PROFILE_DIR_ENV]: profileDir },
    // Nothing this adapter would offer a tool for, so a turn is one completion.
    permissionMode: 'plan',
    ...overrides,
  } as ResolvedRunInput;
}

/** Run one turn to its end, returning everything it emitted. */
async function drain(run: Run): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

beforeEach(async () => {
  profileDir = await realpath(await mkdtemp(path.join(tmpdir(), 'artemis-local-sessions-')));
  cwd = profileDir;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await rm(profileDir, { recursive: true, force: true });
});

describe('what goes out on the wire', () => {
  it('sends only the new message when the conversation is new', async () => {
    const { origin, bodies } = await serveCompletions('hi there');
    const adapter = createLocalAdapter(LLAMA_CPP);

    await drain(await adapter.createRun(input(origin)));

    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('replays the whole conversation when the run resumes one', async () => {
    // The reported defect, stated as a request: turn two must carry turn one.
    const { origin, bodies } = await serveCompletions('the sky is blue', 'you asked about the sky');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin, { prompt: 'why is the sky blue?' }));
    await drain(first);

    await drain(
      await adapter.createRun(
        input(origin, {
          prompt: 'what did I just ask you?',
          resumeSessionId: first.sessionId as SessionId,
        }),
      ),
    );

    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: 'why is the sky blue?' },
      { role: 'assistant', content: 'the sky is blue' },
      { role: 'user', content: 'what did I just ask you?' },
    ]);
  });

  it('keeps the system prompt first and the new message last', async () => {
    // Order is not cosmetic: a system message the server sees after the
    // conversation is not a system prompt, and a question buried mid-array
    // gets answered as history.
    const { origin, bodies } = await serveCompletions('one', 'two');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const system = { kind: 'append' as const, text: 'Be terse.' };
    const first = await adapter.createRun(input(origin, { systemPrompt: system }));
    await drain(first);

    await drain(
      await adapter.createRun(
        input(origin, {
          prompt: 'again',
          systemPrompt: system,
          resumeSessionId: first.sessionId as SessionId,
        }),
      ),
    );

    expect(bodies[1]?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(bodies[1]?.messages.at(-1)).toEqual({ role: 'user', content: 'again' });
  });
});

describe('the session a turn belongs to', () => {
  it('reports an id of its own, and repeats it when resumed', async () => {
    const { origin } = await serveCompletions('hi', 'hi again');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin));
    const opened = (await drain(first))[0] as { type: string; sessionId: SessionId };

    expect(opened.type).toBe('session.started');
    expect(opened.sessionId).toBe(first.sessionId);
    // The run id used to stand in here, which made every turn a new
    // conversation as far as anything downstream could tell.
    expect(opened.sessionId).not.toBe(first.runId);

    const second = await adapter.createRun(
      input(origin, { resumeSessionId: first.sessionId as SessionId }),
    );
    const resumed = (await drain(second))[0] as { sessionId: SessionId; resumedFrom?: SessionId };

    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.resumedFrom).toBe(first.sessionId);
  });
});

describe('history, end to end', () => {
  it('lists a conversation, reopens it, and carries it into the next turn', async () => {
    const { origin, bodies } = await serveCompletions('a fine question', 'as I said');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin, { prompt: 'why is the sky blue?' }));
    await drain(first);
    const sessionId = first.sessionId as SessionId;
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const listed = await adapter.listSessions?.({ profileId: PROFILE, cwd, env });
    expect(listed?.sessions).toHaveLength(1);
    expect(listed?.sessions[0]).toMatchObject({
      id: sessionId,
      cwd,
      providerId: 'llamacpp',
      firstPrompt: 'why is the sky blue?',
      messageCount: 2,
    });

    // The same conversation, in the shape the transcript renders.
    const transcript = await adapter.getSessionMessages?.({
      profileId: PROFILE,
      sessionId,
      cwd,
      env,
      runId: 'run-reader' as RunId,
    });
    expect(
      transcript?.events.map((event) => [
        (event as { role?: string }).role,
        (event as { text?: string }).text,
      ]),
    ).toEqual([
      ['user', 'why is the sky blue?'],
      ['assistant', 'a fine question'],
    ]);
    expect(transcript?.events.every((event) => event.runId === 'run-reader')).toBe(true);

    // And the same conversation, in the shape the server is sent.
    await drain(
      await adapter.createRun(input(origin, { prompt: 'again?', resumeSessionId: sessionId })),
    );
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: 'why is the sky blue?' },
      { role: 'assistant', content: 'a fine question' },
      { role: 'user', content: 'again?' },
    ]);
  });

  it('counts the seam between what came before and what this run adds', async () => {
    // `RunRegistry` takes this number in the moment between resolving a run and
    // spawning it, and it cannot be recovered later — one line further on, the
    // run's own message is in the file.
    const { origin } = await serveCompletions('first answer', 'second answer');
    const adapter = createLocalAdapter(LLAMA_CPP);
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const first = await adapter.createRun(input(origin));
    await drain(first);
    const sessionId = first.sessionId as SessionId;

    const boundary = await adapter.countSessionMessages?.({ sessionId, cwd, env });
    expect(boundary).toBe(2);

    await drain(await adapter.createRun(input(origin, { resumeSessionId: sessionId })));

    // The seam still names the same two messages; the turn after it added its
    // own, which is what makes the count worth taking before the run.
    expect(await adapter.countSessionMessages?.({ sessionId, cwd, env })).toBe(4);
    const before = await adapter.getSessionMessages?.({
      profileId: PROFILE,
      sessionId,
      cwd,
      env,
      runId: 'run-reader' as RunId,
      limit: boundary,
    });
    expect(before?.events.map((event) => (event as { text?: string }).text)).toEqual([
      'hello',
      'first answer',
    ]);
    expect(before?.hasMore).toBe(true);
  });

  it('stays one conversation when the resume names the directory differently', async () => {
    /*
     * An API caller passes the client's `cwd` straight through, and a resume
     * routinely arrives with a trailing slash or a differently-resolved path.
     * Reads walked the whole store and found the original file; writes trusted
     * the spelling and started a second one under a second encoded name. The
     * turn after that direct-hit the new file, so the history stopped at the
     * split — silently, with the sidebar showing the id twice.
     */
    const { origin, bodies } = await serveCompletions('first answer', 'second answer');
    const adapter = createLocalAdapter(LLAMA_CPP);
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const first = await adapter.createRun(input(origin, { prompt: 'one' }));
    await drain(first);
    const sessionId = first.sessionId as SessionId;

    await drain(
      await adapter.createRun(
        input(origin, { prompt: 'two', cwd: `${cwd}/`, resumeSessionId: sessionId }),
      ),
    );

    // The second turn carried the first, and both counters agree about where
    // the conversation is — the registry asks with the run's cwd, the renderer
    // with the summary's.
    expect(bodies[1]?.messages.map((message) => message.content)).toEqual([
      'one',
      'first answer',
      'two',
    ]);
    expect(await adapter.countSessionMessages?.({ sessionId, cwd, env })).toBe(4);
    expect(await adapter.countSessionMessages?.({ sessionId, cwd: `${cwd}/`, env })).toBe(4);

    const listed = await adapter.listSessions?.({ profileId: PROFILE, cwd, env });
    expect(listed?.sessions).toHaveLength(1);
    expect(listed?.sessions[0]?.messageCount).toBe(4);
  });

  it('answers zero for a conversation it has never seen', async () => {
    // Honest here rather than a guess: this adapter owns the store, so no file
    // means nothing was ever written.
    const adapter = createLocalAdapter(LLAMA_CPP);

    await expect(
      adapter.countSessionMessages?.({
        sessionId: 'nope' as SessionId,
        cwd,
        env: { [LOCAL_PROFILE_DIR_ENV]: profileDir },
      }),
    ).resolves.toBe(0);
  });
});

describe('a transcript that cannot be written', () => {
  it('says so once, and stores no half of a turn', async () => {
    /*
     * A write that fails partway through a turn is the one failure that must
     * not be shrugged off: an assistant message holding tool calls whose
     * results never landed is rejected outright by every one of these servers,
     * so half a turn on disk is a conversation that can never be resumed. The
     * rest of the turn is abandoned instead — and the user is told now, rather
     * than next turn when the model has forgotten everything since.
     */
    const { origin } = await serveCompletions('first answer', 'second answer');
    const adapter = createLocalAdapter(LLAMA_CPP);

    const first = await adapter.createRun(input(origin));
    await drain(first);
    const sessionId = first.sessionId as SessionId;

    // Readable, so the conversation still replays — and unwritable, so the
    // turn about to be added cannot land.
    const stored = path.join(
      profileDir,
      'sessions',
      encodeProjectDir(cwd),
      `${String(sessionId)}.jsonl`,
    );
    await chmod(stored, 0o444);

    const events = await drain(
      await adapter.createRun(input(origin, { prompt: 'again', resumeSessionId: sessionId })),
    );

    const notices = events.filter(
      (event) => event.type === 'text.complete' && (event as { synthetic?: boolean }).synthetic,
    );
    // One notice, not one per message: the first failure abandons the rest of
    // the turn rather than retrying it message by message.
    expect(notices).toHaveLength(1);
    expect((notices[0] as { text: string }).text).toContain('could not be saved');
    expect(events.at(-1)?.type).toBe('run.end');

    // The turn that did land is intact and untouched.
    await chmod(stored, 0o644);
    expect((await readFile(stored, 'utf8')).trim().split('\n')).toHaveLength(2);
  });
});

describe('stopping a turn', () => {
  it('ends a run interrupted while a permission prompt is open', async () => {
    /*
     * The deadlock this pins: the loop parks inside `#approve` on a promise
     * that only an answer settles, and the only thing that used to release it
     * was the run's own `finally` — which is downstream of the loop. So
     * stopping during a prompt cancelled a request nobody was making and left
     * the turn in `awaiting_permission` for good: no `run.end`, no flushed
     * transcript, and a row the user could not clear. Before the fix this test
     * does not fail, it hangs.
     */
    const { origin } = await serveToolCall();
    const adapter = createLocalAdapter(LLAMA_CPP);

    const run = await adapter.createRun(
      input(origin, { prompt: 'run the tests', permissionMode: 'default' }),
    );

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'permission.request') void run.interrupt();
    }

    const last = events.at(-1) as { type: string; reason?: string };
    expect(last.type).toBe('run.end');
    expect(last.reason).toBe('interrupted');
    expect(run.status).toBe('ended');

    // And the part of the turn that happened is on disk, which is what makes
    // "stop" different from "undo".
    expect(
      await adapter.countSessionMessages?.({
        sessionId: run.sessionId as SessionId,
        cwd,
        env: { [LOCAL_PROFILE_DIR_ENV]: profileDir },
      }),
    ).toBeGreaterThan(0);
  });

  it('asks nothing more once the turn has been stopped', async () => {
    // Releasing the *parked* prompt is only half of it. A turn that asked for
    // several tools in one message still has the rest of them to get through,
    // and each one reaches the approval path after the abort has already been
    // and gone — so a prompt raised then would park on a deferred nobody is
    // left to release, and the run would hang one call further along.
    const { origin } = await serveToolCall(3);
    const adapter = createLocalAdapter(LLAMA_CPP);

    const run = await adapter.createRun(input(origin, { permissionMode: 'default' }));

    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'permission.request') void run.interrupt();
    }

    // One prompt, three refused calls, and an ending.
    expect(events.filter((event) => event.type === 'permission.request')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.end')).toHaveLength(3);
    expect(events.at(-1)?.type).toBe('run.end');
  });
});

describe('the capability flags and the methods behind them', () => {
  it('claims exactly what it implements', () => {
    // The pairing is the contract: the UI hides history on the flag, not on an
    // empty result, so a flag without a method is a pane that throws and a
    // method without a flag is a feature nobody can reach.
    const adapter = createLocalAdapter(LLAMA_CPP);

    expect(adapter.capabilities.listSessions).toBe(true);
    expect(typeof adapter.listSessions).toBe('function');
    expect(typeof adapter.listAllSessions).toBe('function');
    expect(typeof adapter.getSessionMessages).toBe('function');
    expect(adapter.capabilities.renameSession).toBe(true);
    expect(typeof adapter.setSessionTitle).toBe('function');
    expect(adapter.capabilities.deleteSession).toBe(true);
    expect(typeof adapter.deleteSession).toBe('function');
    expect(adapter.capabilities.tagSession).toBe(true);
    expect(typeof adapter.tagSession).toBe('function');

    // Still ours to write, and still false: the store is append-only and has no
    // message identity to point a rewind at.
    expect(adapter.capabilities.resumeSession).toBe(true);
    expect(adapter.capabilities.rewind).toBe(false);
    expect(adapter.capabilities.forkSession).toBe(false);
    // Unchanged by any of *this* — history is one axis and steering is another
    // — but no longer false: the loop takes a message at its turn boundaries.
    // See `steering.test.ts`.
    expect(adapter.capabilities.midRunSteering).toBe(true);
  });

  it('refuses a fork or a rewind rather than quietly continuing', async () => {
    const { origin } = await serveCompletions('hi');
    const adapter = createLocalAdapter(LLAMA_CPP);

    await expect(
      adapter.createRun(
        input(origin, { resumeSessionId: 'session-x' as SessionId, forkSession: true }),
      ),
    ).rejects.toThrow(/forked or rewound/);
  });

  it('renames and destroys a stored conversation', async () => {
    const { origin } = await serveCompletions('hi');
    const adapter = createLocalAdapter(LLAMA_CPP);
    const env = { [LOCAL_PROFILE_DIR_ENV]: profileDir };

    const run = await adapter.createRun(input(origin));
    await drain(run);
    const sessionId = run.sessionId as SessionId;

    await adapter.setSessionTitle?.({ sessionId, title: 'Sky questions', cwd, env });
    expect((await adapter.listSessions?.({ profileId: PROFILE, cwd, env }))?.sessions[0]).toMatchObject(
      { title: 'Sky questions', titleIsCustom: true },
    );

    expect(await adapter.deleteSession?.({ sessionId, cwd, env })).toBe(true);
    expect((await adapter.listSessions?.({ profileId: PROFILE, cwd, env }))?.sessions).toEqual([]);
  });
});
