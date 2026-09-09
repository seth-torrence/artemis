/**
 * What a local run says about how full its context is.
 * ============================================================================
 *
 * Two numbers, from two places, and each has a way of being quietly wrong.
 *
 * **The occupancy** is arithmetic the adapter does, and the trap is that it
 * looks like something to accumulate. It is not. These servers are stateless,
 * so every request re-sends the whole conversation and `prompt_tokens` is
 * already the measured size of everything said so far — summing the completions
 * of one turn would count the opening prompt once per tool call and report a
 * window several times over-full. Spend accumulates; occupancy is a
 * measurement, and only the newest one is current. Both halves of that are
 * pinned below.
 *
 * **The window** comes from a different endpoint entirely and may not be
 * reachable at all. A run behind a router that proxies only `/v1` has no way to
 * learn it, and that must produce a reading with no denominator rather than an
 * error, a stall, or a guess.
 *
 * Driven against a real local HTTP server, on the same reasoning as its
 * siblings: what goes out on the wire is Artemis's business, and a stubbed
 * `fetch` would assert only that the test agrees with itself.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent, ProfileId, RunId, UsageSnapshot } from '@rx-artemis/protocol';

import { createLocalAdapter, LLAMA_CPP, LOCAL_CAPABILITIES, BASE_URL_ENV } from '../adapter.js';
import { clearContextWindowCache } from '../contextWindow.js';
import { LOCAL_PROFILE_DIR_ENV } from '../sessionStore.js';
import type { ResolvedRunInput, Run } from '../../types.js';

const PROFILE = 'profile-1' as ProfileId;

const servers: Server[] = [];
let profileDir: string;
let cwd: string;

const PROPS = { default_generation_settings: { n_ctx: 32768 }, model_alias: 'qwen3.8-27b' };

/** `/v1/models` as a router that aggregates backends answers it: no meta. */
const ROUTED_MODELS = { object: 'list', data: [{ id: 'qwen3.8-27b', object: 'model' }] };

/** One scripted completion: what the model says, and what it cost. */
interface Reply {
  readonly text?: string;
  /** A shell call, so the loop makes another request after this one. */
  readonly toolCall?: boolean;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

interface Options {
  /** Omit to be a server behind a router that does not forward `/props`. */
  readonly props?: unknown;
  readonly models?: unknown;
}

/**
 * A server that answers completions with scripted usage, and optionally
 * describes itself.
 */
async function serve(replies: readonly Reply[], options: Options = {}): Promise<{
  origin: string;
  seen: string[];
}> {
  const seen: string[] = [];
  let answered = 0;

  const server = createServer((request: IncomingMessage, response) => {
    const url = request.url ?? '';
    seen.push(url);

    if (url === '/props') {
      if (options.props === undefined) {
        response.writeHead(404).end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.props));
      return;
    }
    if (url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.models ?? ROUTED_MODELS));
      return;
    }

    request.resume();
    request.on('end', () => {
      const reply = replies[answered++] ?? { text: 'ok', promptTokens: 1, completionTokens: 1 };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = reply.toolCall
        ? { tool_calls: [{ index: 0, function: { name: 'shell', arguments: '{"command":"ls"}' } }] }
        : { content: reply.text ?? 'ok' };
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      // Usage on its own final chunk, which is where `include_usage` puts it.
      response.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: reply.promptTokens,
            completion_tokens: reply.completionTokens,
            total_tokens: reply.promptTokens + reply.completionTokens,
          },
        })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

function input(origin: string, overrides: Partial<ResolvedRunInput> = {}): ResolvedRunInput {
  return {
    providerId: 'llamacpp',
    profileId: PROFILE,
    cwd,
    prompt: 'hello',
    model: 'qwen3.8-27b',
    runId: `run-${String(Math.random()).slice(2)}` as RunId,
    env: { [BASE_URL_ENV]: origin, [LOCAL_PROFILE_DIR_ENV]: profileDir },
    // Nothing this adapter would offer a tool for, so a turn is one completion
    // unless a test asks for more.
    permissionMode: 'plan',
    ...overrides,
  } as ResolvedRunInput;
}

/**
 * Run one turn to its end, refusing any tool it asks for.
 *
 * A refusal still puts a result in front of the model and the loop makes
 * another request — which is all these tests need a tool call for. Nothing
 * actually executes, so there is no sandbox to depend on.
 */
async function drain(run: Run): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === 'permission.request') {
      void run.respondToPermission(event.requestId, {
        behavior: 'deny',
        message: 'not in this test',
      });
    }
  }
  return events;
}

/** Every usage snapshot the run emitted, in order, ending with `run.end`'s. */
function usages(events: readonly AgentEvent[]): UsageSnapshot[] {
  const snapshots: UsageSnapshot[] = [];
  for (const event of events) {
    if (event.type === 'usage') snapshots.push(event.usage);
    if (event.type === 'run.end' && event.usage !== undefined) snapshots.push(event.usage);
  }
  return snapshots;
}

beforeEach(async () => {
  clearContextWindowCache();
  profileDir = await realpath(await mkdtemp(path.join(tmpdir(), 'artemis-local-context-')));
  cwd = profileDir;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await rm(profileDir, { recursive: true, force: true });
});

describe('the context reading a local run reports', () => {
  it('declares the capability the meter mounts on', () => {
    // The flag and the numbers are one claim: a meter gated on a capability the
    // adapter does not fill is an empty gauge, and numbers behind a flag that
    // is off are a readout nothing renders.
    expect(LOCAL_CAPABILITIES.contextReporting).toBe(true);
    expect(LOCAL_CAPABILITIES.planUsageReporting).toBe(false);
  });

  it('reports occupancy and the window the server was started with', async () => {
    const { origin } = await serve([{ text: 'hi', promptTokens: 7210, completionTokens: 45 }], {
      props: PROPS,
    });
    const adapter = createLocalAdapter(LLAMA_CPP);

    const snapshots = usages(await drain(await adapter.createRun(input(origin))));

    expect(snapshots.at(-1)).toMatchObject({
      scope: 'final',
      contextTokens: 7255,
      contextWindow: 32768,
      tokens: { inputTokens: 7210, outputTokens: 45 },
    });
  });

  it('says so while the turn is still running, not only at its end', async () => {
    // The defect this feature exists to fix: the only snapshot this adapter
    // ever emitted rode on `run.end`, so a long turn — the kind where knowing
    // the window is filling could change what you do next — showed nothing at
    // all until it was too late to act on.
    const { origin } = await serve(
      [
        { toolCall: true, promptTokens: 1000, completionTokens: 20 },
        { text: 'done', promptTokens: 1500, completionTokens: 30 },
      ],
      { props: PROPS },
    );
    const adapter = createLocalAdapter(LLAMA_CPP);

    const events = await drain(
      await adapter.createRun(input(origin, { permissionMode: 'default' })),
    );

    const streamed = events.filter((event) => event.type === 'usage');
    expect(streamed).toHaveLength(2);
    // And the first one landed before the turn was over.
    expect(events.indexOf(streamed[0] as AgentEvent)).toBeLessThan(
      events.findIndex((event) => event.type === 'run.end'),
    );
  });

  it('measures occupancy from the newest completion and never sums it', async () => {
    /*
      The arithmetic trap. Turn two re-sends turn one, so 1000 + 1500 would
      report 2500 tokens of a 32768 window against a conversation actually
      holding 1530 — and on a longer turn the invented total climbs past the
      window and pins the gauge at 100% while there is room to spare.
    */
    const { origin } = await serve(
      [
        { toolCall: true, promptTokens: 1000, completionTokens: 20 },
        { text: 'done', promptTokens: 1500, completionTokens: 30 },
      ],
      { props: PROPS },
    );
    const adapter = createLocalAdapter(LLAMA_CPP);

    const snapshots = usages(
      await drain(await adapter.createRun(input(origin, { permissionMode: 'default' }))),
    );

    expect(snapshots.map((snapshot) => snapshot.contextTokens)).toEqual([1020, 1530, 1530]);
  });

  it('sums the spend it reports, which is the other half of that', async () => {
    // Totals used to be the *last* completion alone, so a turn that read six
    // files reported the tokens of its shortest exchange as the whole turn.
    const { origin } = await serve(
      [
        { toolCall: true, promptTokens: 1000, completionTokens: 20 },
        { text: 'done', promptTokens: 1500, completionTokens: 30 },
      ],
      { props: PROPS },
    );
    const adapter = createLocalAdapter(LLAMA_CPP);

    const snapshots = usages(
      await drain(await adapter.createRun(input(origin, { permissionMode: 'default' }))),
    );

    expect(snapshots.at(-1)?.tokens).toEqual({ inputTokens: 2500, outputTokens: 50 });
  });

  it('reports occupancy with no window when nothing will state one', async () => {
    // Behind a router that forwards only `/v1` and strips the model meta. The
    // run finishes normally and the readout shows tokens with no scale, which
    // is what is actually known.
    const { origin } = await serve([{ text: 'hi', promptTokens: 900, completionTokens: 10 }]);
    const adapter = createLocalAdapter(LLAMA_CPP);

    const events = await drain(await adapter.createRun(input(origin)));

    const last = usages(events).at(-1);
    expect(last?.contextTokens).toBe(910);
    expect(last?.contextWindow).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('falls back to the model meta when /props is not routed', async () => {
    const { origin } = await serve([{ text: 'hi', promptTokens: 900, completionTokens: 10 }], {
      models: { data: [{ id: 'qwen3.8-27b', meta: { n_ctx: 16384, n_ctx_train: 262144 } }] },
    });
    const adapter = createLocalAdapter(LLAMA_CPP);

    const snapshots = usages(await drain(await adapter.createRun(input(origin))));

    expect(snapshots.at(-1)?.contextWindow).toBe(16384);
  });

  it('asks for the window once, however many completions the turn makes', async () => {
    const { origin, seen } = await serve(
      [
        { toolCall: true, promptTokens: 1000, completionTokens: 20 },
        { text: 'done', promptTokens: 1500, completionTokens: 30 },
      ],
      { props: PROPS },
    );
    const adapter = createLocalAdapter(LLAMA_CPP);

    await drain(await adapter.createRun(input(origin, { permissionMode: 'default' })));

    expect(seen.filter((url) => url === '/props')).toHaveLength(1);
    expect(seen.filter((url) => url === '/v1/chat/completions')).toHaveLength(2);
  });
});
