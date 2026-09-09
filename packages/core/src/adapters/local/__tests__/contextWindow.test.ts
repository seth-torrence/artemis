/**
 * Asking a local server how big its window is.
 * ============================================================================
 *
 * The denominator of the context gauge, and the only number in the readout that
 * an OpenAI-compatible completion does not carry. Everything here is about the
 * two ways it can go quietly wrong:
 *
 *  - **The wrong number, presented as the right one.** `n_ctx_train` is 262144
 *    on a model being served at 32768. Both are in the same payload, one field
 *    apart, and taking the first one that parses gives a gauge that reads eight
 *    times emptier than the truth on the provider whose window is smallest and
 *    fills fastest.
 *  - **A missing number, presented as a failure.** A router in front of the
 *    server may proxy only `/v1` and strip the model meta on the way past.
 *    There is then no window to report, and the run must still finish and still
 *    show its occupancy.
 *
 * Driven against a real local HTTP server rather than a stubbed `fetch`, on the
 * same reasoning as `endpoint.test.ts`: the thing under test is which requests
 * go out and what is made of the answers, and a stub asserts only that the
 * test's idea of the request matches the test's idea of the request.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearContextWindowCache,
  parseLlamaModelsWindow,
  parseLlamaProps,
  parseLmStudioWindow,
  parseOllamaShowWindow,
  readContextWindow,
} from '../contextWindow.js';

const servers: Server[] = [];

afterEach(() => {
  clearContextWindowCache();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Verbatim `/props` from llama.cpp b10355, trimmed to the fields read. */
const PROPS = {
  default_generation_settings: { params: { temperature: 1 }, n_ctx: 32768 },
  total_slots: 1,
  model_alias: 'qwen3.8-27b',
  model_path: 'C:\\LLMs\\models\\qwen3.8-27b-IQ4_XS-pure.gguf',
};

/** Verbatim `/v1/models` from the same build. Note the two context fields. */
const MODELS = {
  object: 'list',
  data: [
    {
      id: 'qwen3.8-27b',
      aliases: ['qwen3.8-27b'],
      object: 'model',
      owned_by: 'llamacpp',
      meta: { n_vocab: 248320, n_ctx: 32768, n_ctx_train: 262144, n_embd: 5120 },
    },
  ],
};

/** What a router that aggregates several backends answers instead. */
const ROUTED_MODELS = {
  object: 'list',
  data: [
    { id: 'qwen3.5-4b', object: 'model', owned_by: 'olla' },
    { id: 'qwen3.8-27b', object: 'model', owned_by: 'olla' },
  ],
};

interface Route {
  readonly status?: number;
  readonly body?: unknown;
}

/** A server answering a fixed map of paths, recording what it was asked. */
async function serve(routes: Readonly<Record<string, Route>>): Promise<{
  origin: string;
  seen: string[];
}> {
  const seen: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const url = request.url ?? '';
    seen.push(url);
    const route = routes[url];
    if (route === undefined) {
      response.writeHead(404).end('{}');
      return;
    }
    response.writeHead(route.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(route.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

describe('reading the payloads', () => {
  it('takes the served window from /props', () => {
    expect(parseLlamaProps(PROPS)).toBe(32768);
  });

  it('prefers meta.n_ctx over n_ctx_train', () => {
    // The whole point of the reader. Both are present, one field apart, and
    // `n_ctx_train` is eight times too large on this exact server.
    expect(parseLlamaModelsWindow(MODELS, 'qwen3.8-27b')).toBe(32768);
  });

  it('falls back to n_ctx_train when the build reports only that', () => {
    // An upper bound is worth more than a blank: it can never be too small.
    const trainOnly = { data: [{ id: 'm', meta: { n_ctx_train: 262144 } }] };
    expect(parseLlamaModelsWindow(trainOnly, 'm')).toBe(262144);
  });

  it('matches the row by alias as well as by id', () => {
    const aliased = { data: [{ id: 'path/to.gguf', aliases: ['short'], meta: { n_ctx: 8192 } }] };
    expect(parseLlamaModelsWindow(aliased, 'short')).toBe(8192);
  });

  it('takes the sole row when the id does not match', () => {
    // `llama-server` serves the model it was started with, so a list of one is
    // that server describing itself — not a coincidence worth refusing.
    expect(parseLlamaModelsWindow(MODELS, 'some-other-name')).toBe(32768);
  });

  it('refuses to guess between several rows', () => {
    // Two backends behind one address. Picking either would attribute one
    // model's window to another's conversation.
    const two = {
      data: [
        { id: 'a', meta: { n_ctx: 4096 } },
        { id: 'b', meta: { n_ctx: 32768 } },
      ],
    };
    expect(parseLlamaModelsWindow(two, undefined)).toBeUndefined();
  });

  it('says nothing when the meta was stripped in transit', () => {
    expect(parseLlamaModelsWindow(ROUTED_MODELS, 'qwen3.8-27b')).toBeUndefined();
  });

  it('rejects a zero, a negative and a stringified number', () => {
    // Each of these renders as arithmetic rather than as an error: a divide by
    // zero, a negative bar, and `NaN%`.
    expect(parseLlamaProps({ default_generation_settings: { n_ctx: 0 } })).toBeUndefined();
    expect(parseLlamaProps({ default_generation_settings: { n_ctx: -1 } })).toBeUndefined();
    expect(parseLlamaProps({ default_generation_settings: { n_ctx: '32768' } })).toBeUndefined();
  });

  it('survives a body that is not the shape at all', () => {
    for (const body of [null, undefined, 'nope', 42, [], {}]) {
      expect(parseLlamaProps(body)).toBeUndefined();
      expect(parseLlamaModelsWindow(body, 'm')).toBeUndefined();
    }
  });

  it('prefers what LM Studio loaded over what the file permits', () => {
    const body = { data: [{ id: 'm', max_context_length: 131072, loaded_context_length: 8192 }] };
    expect(parseLmStudioWindow(body, 'm')).toBe(8192);
    expect(parseLmStudioWindow({ data: [{ id: 'm', max_context_length: 131072 }] }, 'm')).toBe(
      131072,
    );
  });

  it("finds Ollama's context length under an architecture-keyed name", () => {
    // The key cannot be named up front — it is `<arch>.context_length`.
    expect(parseOllamaShowWindow({ model_info: { 'qwen3.context_length': 40960 } })).toBe(40960);
  });

  it('lets an Ollama num_ctx override beat the checkpoint length', () => {
    const body = {
      parameters: 'stop "<|im_end|>"\nnum_ctx                        8192\n',
      model_info: { 'qwen3.context_length': 40960 },
    };
    expect(parseOllamaShowWindow(body)).toBe(8192);
  });
});

describe('the probe chain', () => {
  it('reads /props first and stops there', async () => {
    const { origin, seen } = await serve({ '/props': { body: PROPS }, '/v1/models': { body: MODELS } });

    const window = await readContextWindow({
      flavourId: 'llamacpp',
      baseUrl: origin,
      model: 'qwen3.8-27b',
      headers: {},
    });

    expect(window).toBe(32768);
    // Not `/v1/models` as well: the exact answer was already in hand, and a
    // second request per run against a busy inference server is not free.
    expect(seen).toEqual(['/props']);
  });

  it('falls through to the model meta when /props is not routed', async () => {
    // A reverse proxy that only forwards `/v1`, which is the ordinary shape of
    // a router in front of several backends.
    const { origin, seen } = await serve({ '/v1/models': { body: MODELS } });

    const window = await readContextWindow({
      flavourId: 'llamacpp',
      baseUrl: origin,
      model: 'qwen3.8-27b',
      headers: {},
    });

    expect(window).toBe(32768);
    expect(seen).toEqual(['/props', '/v1/models']);
  });

  it('answers undefined when nothing will state a size', async () => {
    // The state the whole feature has to survive: occupancy with no scale. Not
    // a throw, because a gauge is not worth failing a run over.
    const { origin } = await serve({ '/v1/models': { body: ROUTED_MODELS } });

    await expect(
      readContextWindow({
        flavourId: 'llamacpp',
        baseUrl: origin,
        model: 'qwen3.8-27b',
        headers: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('answers undefined rather than throwing when nothing is listening', async () => {
    await expect(
      readContextWindow({
        flavourId: 'llamacpp',
        baseUrl: 'http://127.0.0.1:9',
        model: 'm',
        headers: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('sends the profile’s key, because a keyed server refuses /props too', async () => {
    const authorizations: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(PROPS));
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;

    await readContextWindow({
      flavourId: 'llamacpp',
      baseUrl: `http://127.0.0.1:${String(port)}`,
      model: 'm',
      headers: { authorization: 'Bearer hunter2' },
    });

    expect(authorizations).toEqual(['Bearer hunter2']);
  });

  it('asks once per server and model, then answers from memory', async () => {
    // A turn makes one completion per tool call and every one of them wants to
    // report occupancy. Probing on each would put two requests between a tool
    // finishing and the next starting.
    const { origin, seen } = await serve({ '/props': { body: PROPS } });
    const query = { flavourId: 'llamacpp', baseUrl: origin, model: 'm', headers: {} } as const;

    const readings = await Promise.all([
      readContextWindow(query),
      readContextWindow(query),
      readContextWindow(query),
    ]);
    await readContextWindow(query);

    expect(readings).toEqual([32768, 32768, 32768]);
    expect(seen).toEqual(['/props']);
  });

  it('does not remember a failure, so a server that was still loading is asked again', async () => {
    const { origin, seen } = await serve({ '/props': { status: 503 } });
    const query = { flavourId: 'llamacpp', baseUrl: origin, model: 'm', headers: {} } as const;

    await readContextWindow(query);
    await readContextWindow(query);

    // Two attempts, two probes each — `/props` then `/v1/models`, which 404s.
    expect(seen).toEqual(['/props', '/v1/models', '/props', '/v1/models']);
  });

  it('keys the cache by model, so a router serving two windows is not conflated', async () => {
    const { origin } = await serve({
      '/props': { status: 404 },
      '/v1/models': {
        body: {
          data: [
            { id: 'small', meta: { n_ctx: 4096 } },
            { id: 'big', meta: { n_ctx: 32768 } },
          ],
        },
      },
    });
    const base = { flavourId: 'llamacpp', baseUrl: origin, headers: {} } as const;

    expect(await readContextWindow({ ...base, model: 'small' })).toBe(4096);
    expect(await readContextWindow({ ...base, model: 'big' })).toBe(32768);
  });

  it('asks Ollama and LM Studio their own questions', async () => {
    const ollama = await serve({
      '/api/show': { body: { model_info: { 'qwen3.context_length': 40960 } } },
    });
    const lmStudio = await serve({
      '/api/v0/models': { body: { data: [{ id: 'm', loaded_context_length: 8192 }] } },
    });

    expect(
      await readContextWindow({
        flavourId: 'ollama',
        baseUrl: ollama.origin,
        model: 'm',
        headers: {},
      }),
    ).toBe(40960);
    expect(
      await readContextWindow({
        flavourId: 'lmstudio',
        baseUrl: lmStudio.origin,
        model: 'm',
        headers: {},
      }),
    ).toBe(8192);
    expect(ollama.seen).toEqual(['/api/show']);
    expect(lmStudio.seen).toEqual(['/api/v0/models']);
  });
});
