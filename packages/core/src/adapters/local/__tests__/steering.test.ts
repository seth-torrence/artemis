/**
 * Saying something else while the turn is still running.
 * ============================================================================
 *
 * Two levels, because the interesting failures live at different ones.
 *
 * The **loop** is driven against a scripted completion function, where "the
 * user typed while the model was calling a tool" and "the user typed while the
 * model was writing its answer" can be produced exactly. What is pinned there
 * is order: a queued message joins the conversation *between* completions and
 * never inside one, it is delivered once, and the ceiling that stops a looping
 * model does not count the rounds spent before a person spoke.
 *
 * The **run** is driven against a real HTTP server, where what is pinned is the
 * event stream the renderer reads: `message.delivered` naming the caller's own
 * id, no second row for a message already on screen, and a refusal that says
 * `run_ended` so the composer can carry the words into a fresh run.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEvent, MessageId } from '@rx-artemis/protocol';

import { BASE_URL_ENV, createLocalAdapter, LLAMA_CPP } from '../adapter.js';
import { runAgentLoop } from '../loop.js';
import type { ChatMessage, CompletionRequest, CompletionResult, QueuedMessage } from '../loop.js';
import { READ_FILE } from '../tools.js';
import type { ToolContext } from '../tools.js';
import type { ResolvedRunInput } from '../../types.js';

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

const USER: readonly ChatMessage[] = [{ role: 'user', content: 'start the refactor' }];

const context: ToolContext = {
  root: process.cwd(),
  env: {},
  signal: new AbortController().signal,
  shell: () => Promise.resolve({ output: 'ran' }),
};

const call = (name: string, args: unknown, id = 'c1') => ({
  id,
  name,
  argumentsJson: JSON.stringify(args),
});

/** A completion function that replays a script and records what it was sent. */
function scripted(...steps: CompletionResult[]): {
  complete: (request: CompletionRequest) => Promise<CompletionResult>;
  seen: CompletionRequest[];
} {
  const seen: CompletionRequest[] = [];
  let index = 0;
  return {
    seen,
    complete: (request) => {
      seen.push({ messages: [...request.messages], tools: request.tools });
      return Promise.resolve(steps[index++] ?? { text: 'done', toolCalls: [] });
    },
  };
}

/** A queue whose contents a test schedules against completion number. */
function queueAt(schedule: Readonly<Record<number, QueuedMessage[]>>): {
  takeQueued: () => readonly QueuedMessage[];
  delivered: QueuedMessage[];
  onDelivered: (message: QueuedMessage) => void;
  advance: () => void;
} {
  let completions = 0;
  const delivered: QueuedMessage[] = [];
  return {
    advance: () => {
      completions += 1;
    },
    takeQueued: () => schedule[completions]?.splice(0) ?? [],
    delivered,
    onDelivered: (message) => delivered.push(message),
  };
}

describe('the loop takes a message at a turn boundary', () => {
  it('folds it in after a round of tool calls, before the next completion', async () => {
    const queue = queueAt({ 1: [{ text: 'actually, do the tests first', id: 'm1' }] });
    const { complete, seen } = scripted(
      { text: '', toolCalls: [call('read_file', { path: 'a.txt' })] },
      { text: 'the tests it is', toolCalls: [] },
    );

    const out = await runAgentLoop({
      initialMessages: USER,
      complete: async (request) => {
        const result = await complete(request);
        queue.advance();
        return result;
      },
      tools: [READ_FILE],
      context,
      approve: () => Promise.resolve('allow'),
      takeQueued: queue.takeQueued,
      onDelivered: queue.onDelivered,
    });

    expect(out).toBe('the tests it is');
    // Between the tool result and the next completion — never inside one, and
    // never before the result the model asked for.
    const second = seen[1]?.messages ?? [];
    expect(second.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(second.at(-1)?.content).toBe('actually, do the tests first');
    expect(queue.delivered).toEqual([{ text: 'actually, do the tests first', id: 'm1' }]);
  });

  it('folds one in after the answer, and keeps the turn going rather than ending on it', async () => {
    // The message arrived while the model was composing a tool-free reply, so
    // there is no tool boundary left for it to land on.
    const queue = queueAt({ 1: [{ text: 'and the docs', id: 'm2' }] });
    const { complete, seen } = scripted(
      { text: 'the refactor is done', toolCalls: [] },
      { text: 'the docs are updated too', toolCalls: [] },
    );

    const out = await runAgentLoop({
      initialMessages: USER,
      complete: async (request) => {
        const result = await complete(request);
        queue.advance();
        return result;
      },
      tools: [READ_FILE],
      context,
      approve: () => Promise.resolve('allow'),
      takeQueued: queue.takeQueued,
      onDelivered: queue.onDelivered,
    });

    expect(out).toBe('the docs are updated too');
    // The answer the model gave is in the array, then the correction: the
    // conversation as it actually happened.
    const second = seen[1]?.messages ?? [];
    expect(second.slice(-2)).toEqual([
      { role: 'assistant', content: 'the refactor is done' },
      { role: 'user', content: 'and the docs' },
    ]);
  });

  it('delivers several in the order they were sent', async () => {
    const queue = queueAt({
      1: [
        { text: 'first correction', id: 'm1' },
        { text: 'second correction', id: 'm2' },
      ],
    });
    const { complete, seen } = scripted(
      { text: 'working', toolCalls: [] },
      { text: 'both done', toolCalls: [] },
    );

    await runAgentLoop({
      initialMessages: USER,
      complete: async (request) => {
        const result = await complete(request);
        queue.advance();
        return result;
      },
      tools: [READ_FILE],
      context,
      approve: () => Promise.resolve('allow'),
      takeQueued: queue.takeQueued,
      onDelivered: queue.onDelivered,
    });

    expect((seen[1]?.messages ?? []).slice(-2).map((message) => message.content)).toEqual([
      'first correction',
      'second correction',
    ]);
    expect(queue.delivered.map((message) => message.id)).toEqual(['m1', 'm2']);
  });

  it('delivers each message exactly once', async () => {
    const queue = queueAt({ 1: [{ text: 'only once', id: 'm1' }] });
    const { complete, seen } = scripted(
      { text: 'a', toolCalls: [] },
      { text: 'b', toolCalls: [] },
      { text: 'c', toolCalls: [] },
    );

    await runAgentLoop({
      initialMessages: USER,
      complete: async (request) => {
        const result = await complete(request);
        queue.advance();
        return result;
      },
      tools: [READ_FILE],
      context,
      approve: () => Promise.resolve('allow'),
      takeQueued: queue.takeQueued,
      onDelivered: queue.onDelivered,
    });

    const last = seen.at(-1)?.messages ?? [];
    expect(last.filter((message) => message.content === 'only once')).toHaveLength(1);
    expect(queue.delivered).toHaveLength(1);
  });

  it('does not spend the ceiling that a looping model was going to spend', async () => {
    /*
     * The bound exists to catch a small model calling one tool forever. A
     * person typing is the strongest evidence available that the run is not
     * doing that — so their message resets the count rather than arriving with
     * one round left to be answered in.
     */
    const looping: CompletionResult = { text: '', toolCalls: [call('read_file', { path: 'a.txt' })] };
    const queue = queueAt({ 2: [{ text: 'stop and do this instead', id: 'm1' }] });
    let completions = 0;

    const out = await runAgentLoop({
      initialMessages: USER,
      complete: () => {
        completions += 1;
        queue.advance();
        // Two rounds of looping, the steer, then an answer.
        return Promise.resolve(completions <= 2 ? looping : { text: 'done', toolCalls: [] });
      },
      tools: [READ_FILE],
      context,
      approve: () => Promise.resolve('allow'),
      takeQueued: queue.takeQueued,
      onDelivered: queue.onDelivered,
      maxIterations: 3,
    });

    // Without the reset the third completion would have been the last of the
    // budget and the turn would have ended on the ceiling notice.
    expect(out).toBe('done');
  });

  it('is unchanged for a caller that never queues anything', async () => {
    // The failure the ceiling exists for: one tool, the same arguments, forever.
    let completions = 0;
    const out = await runAgentLoop({
      initialMessages: USER,
      complete: () => {
        completions += 1;
        return Promise.resolve({ text: '', toolCalls: [call('read_file', { path: 'a.txt' })] });
      },
      tools: [READ_FILE],
      context,
      approve: () => Promise.resolve('allow'),
      maxIterations: 2,
    });

    expect(completions).toBe(2);
    // Still the ceiling notice, worded exactly as it was.
    expect(out).toContain('Stopped after 2 tool rounds');
  });
});

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const httpServers: HttpServer[] = [];

afterEach(() => {
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

const textChunk = (text: string) => ({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });

/**
 * A server that answers completions, and lets the test act between them.
 *
 * `beforeTurn` runs before each response is written, which is where a test
 * plays the user typing into a turn that is already in flight.
 */
async function serveInference(
  turns: readonly (readonly unknown[])[],
  beforeTurn: (index: number) => void | Promise<void>,
): Promise<{ origin: string; requests: ChatMessage[][] }> {
  const requests: ChatMessage[][] = [];
  let index = 0;
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: ChatMessage[] };
        requests.push(body.messages);
        const turn = index++;
        await beforeTurn(turn);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sse(turns[turn] ?? [textChunk('done')]));
      })();
    });
  });
  httpServers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, requests };
}

const runInput = (origin: string): ResolvedRunInput =>
  ({
    runId: 'run-steer-1',
    providerId: 'llamacpp',
    profileId: 'p1',
    cwd: process.cwd(),
    prompt: 'start the refactor',
    env: { [BASE_URL_ENV]: origin },
  }) as ResolvedRunInput;

describe('a steered run', () => {
  it('advertises that it can be steered', () => {
    // What the composer reads to decide whether to stay usable mid-run.
    expect(createLocalAdapter(LLAMA_CPP).capabilities.midRunSteering).toBe(true);
  });

  it('accepts the message as queued, then reports the delivery', async () => {
    let run: Awaited<ReturnType<ReturnType<typeof createLocalAdapter>['createRun']>> | undefined;
    let accepted: { deliveredImmediately: boolean } | undefined;

    const inference = await serveInference(
      [[textChunk('the refactor is done')], [textChunk('and the docs are updated')]],
      async (turn) => {
        // Typed while the first completion is in flight.
        if (turn === 0 && run !== undefined) {
          accepted = await run.send('and the docs', undefined, 'run-steer-1:prompt:2' as MessageId);
        }
      },
    );

    run = await createLocalAdapter(LLAMA_CPP).createRun(runInput(inference.origin));
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    // Queued, and said to be queued. Nothing can amend a completion that is
    // already streaming, and claiming otherwise would be a guarantee this layer
    // cannot make.
    expect(accepted).toEqual({ deliveredImmediately: false });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message.delivered', messageId: 'run-steer-1:prompt:2' }),
    );
    // The message reached the model, in the turn the user was watching.
    expect(inference.requests[1]?.at(-1)).toEqual({ role: 'user', content: 'and the docs' });
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('draws no second row for a message the renderer already has', async () => {
    /*
     * `message.delivered` is news about *timing*. A transcript row for it would
     * be the record of a message being read sitting under the record of it
     * being sent, saying the same sentence twice — which is exactly what the
     * renderer's own replay tests forbid.
     */
    let run: Awaited<ReturnType<ReturnType<typeof createLocalAdapter>['createRun']>> | undefined;
    const inference = await serveInference(
      [[textChunk('working')], [textChunk('done')]],
      async (turn) => {
        if (turn === 0 && run !== undefined) {
          await run.send('one more thing', undefined, 'm-1' as MessageId);
        }
      },
    );

    run = await createLocalAdapter(LLAMA_CPP).createRun(runInput(inference.origin));
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    const userRows = events.filter(
      (event) =>
        event.type === 'text.complete' && (event as { role?: string }).role === 'user',
    );
    expect(userRows).toEqual([]);
  });

  it('refuses an ended run with the reason the composer branches on', async () => {
    const inference = await serveInference([[textChunk('done')]], () => undefined);
    const run = await createLocalAdapter(LLAMA_CPP).createRun(runInput(inference.origin));
    for await (const event of run.events) void event;

    // `isEndedRunError` reads this, and carries the user's words into a fresh
    // run instead of stranding them under a red banner.
    await expect(run.send('too late', undefined, 'm-2' as MessageId)).rejects.toMatchObject({
      agentError: { details: { reason: 'run_ended' } },
    });
  });

  it('refuses an attachment rather than dropping it', async () => {
    const inference = await serveInference([[textChunk('done')]], () => undefined);
    const run = await createLocalAdapter(LLAMA_CPP).createRun(runInput(inference.origin));

    await expect(
      run.send('look at this', [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] as never),
    ).rejects.toThrow(/attachments/);

    await run.interrupt();
    for await (const event of run.events) void event;
  });

  it('drops what it never delivered when the run is stopped', async () => {
    let run: Awaited<ReturnType<ReturnType<typeof createLocalAdapter>['createRun']>> | undefined;
    let interruption: { stillQueued: readonly string[] } | undefined;

    const inference = await serveInference([[textChunk('working')]], async (turn) => {
      if (turn === 0 && run !== undefined) {
        await run.send('never mind', undefined, 'm-3' as MessageId);
        interruption = await run.interrupt();
      }
    });

    run = await createLocalAdapter(LLAMA_CPP).createRun(runInput(inference.origin));
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);

    // `stillQueued` means "will still run". Nothing here survives the abort, so
    // an empty list is the truth rather than a shrug.
    expect(interruption).toEqual({ stillQueued: [] });
    expect(events.some((event) => event.type === 'message.delivered')).toBe(false);
    expect(inference.requests).toHaveLength(1);
  });
});
