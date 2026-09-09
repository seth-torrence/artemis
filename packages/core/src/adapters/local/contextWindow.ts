/**
 * How big the window is that a local server is actually serving.
 * ============================================================================
 *
 * The hosted providers hand this over on the way past: Claude's result message
 * carries a `contextWindow` per model, Codex's a `modelContextWindow`. An
 * OpenAI-compatible completion carries no such field — `usage` says what the
 * turn cost and nothing at all about the size of the box it went into — so the
 * denominator has to be *asked for*, separately, against a different endpoint.
 *
 * ## Why not a table of model specs
 *
 * Because the number is a property of the **process**, not of the weights.
 * `llama-server -c 32768` serves a 32k window out of a checkpoint trained at
 * 262144, and the same GGUF on the next machine is started with a different
 * flag. A hardcoded map keyed by model name would be wrong on the ordinary
 * case, silently, in the direction that matters least kindly: a gauge reading
 * 12% full on a conversation that is actually about to be truncated.
 *
 * So every number here comes from the server describing itself, and when no
 * server will describe itself the answer is `undefined` — which the status line
 * renders as tokens with no denominator rather than as a guess.
 *
 * ## The chain, and why it has more than one link
 *
 * The endpoint that answers best is not always reachable. A profile pointed
 * straight at `llama-server` can read `/props`, which states the served
 * `n_ctx` exactly. A profile pointed at a router in front of it may only get
 * the OpenAI surface through, where the best available answer is the model
 * meta — and a router that aggregates several backends strips even that. Each
 * link is therefore a *weaker but still true* statement of the same fact, tried
 * in order:
 *
 *  1. `/props` → `default_generation_settings.n_ctx` — the window this process
 *     is serving. Exact.
 *  2. `/v1/models` → `meta.n_ctx` — the same number, when the build reports it.
 *  3. `/v1/models` → `meta.n_ctx_train` — what the *checkpoint* supports, which
 *     is an upper bound rather than the truth. Kept because a bound is worth
 *     more than a blank, and it is the last thing any of these servers will
 *     say.
 *
 * Beyond that the adapter falls back to what this model reported on a previous
 * run (the renderer remembers it per model), and beyond *that* to showing the
 * occupancy with no denominator at all.
 *
 * ## Verification status
 *
 * Same house rule as `catalogues.ts`: a reader written from documentation is
 * marked as such, because a capability declared from an advertisement is an
 * affordance that fails in the user's hands.
 *
 * | Server         | Status                                                    |
 * | -------------- | --------------------------------------------------------- |
 * | `llama-server` | **Verified** live, 2026-09-09, direct and behind a router  |
 * | LM Studio      | **Unverified** — written from documentation                |
 * | Ollama         | **Unverified** — written from documentation                |
 */

import type { ProviderId } from '@rx-artemis/protocol';

/**
 * One way of asking a server how big its window is.
 *
 * `parse` returns `undefined` for "this server did not say", which is a
 * different outcome from a request that failed — both move on to the next
 * probe, but only the second is worth a debug line.
 */
export interface ContextProbe {
  /** Appended to the profile's base URL. */
  readonly path: string;
  readonly method: 'GET' | 'POST';
  /** Body for a `POST`, built from the model the run is using. */
  readonly body?: (model: string | undefined) => unknown;
  readonly parse: (body: unknown, model: string | undefined) => number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A window size, or nothing.
 *
 * Positive and finite, because every failure mode this guards against renders
 * as arithmetic rather than as an error: a `0` divides the gauge by zero, a
 * `-1` (which is what `llama-server` prints for "unlimited" in some fields)
 * paints a negative bar, and a stringified number silently produces `NaN%`.
 */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/* -------------------------------------------------------------------------- */
/* llama-server — VERIFIED                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `llama-server`'s `/props`, the exact answer.
 *
 * `default_generation_settings.n_ctx` is the context the process was started
 * with — the `-c` flag, or the checkpoint's own default when none was given.
 * It is the only number in this file that describes what will actually happen
 * when the conversation gets long.
 *
 * Driven live on 2026-09-09 against llama.cpp b10355, both directly and through
 * a router. Worth recording that the router passed it: `/props` is outside the
 * OpenAI surface, so it was the link most likely to be missing, and it was not.
 */
export function parseLlamaProps(body: unknown): number | undefined {
  const settings = asRecord(asRecord(body)?.['default_generation_settings']);
  return positive(settings?.['n_ctx']);
}

/**
 * The same fact from `/v1/models`, for a server that will not answer `/props`.
 *
 * Two numbers live under `meta`, and they are not interchangeable:
 *
 *  - `n_ctx` is the served window, and is preferred whenever the build reports
 *    it.
 *  - `n_ctx_train` is what the checkpoint was trained for — 262144 on a model
 *    being served at 32768. An upper bound, taken only when nothing better is
 *    on offer, because a gauge that reads eight times emptier than the truth is
 *    still more useful than one with no scale at all, and it is honest about
 *    being a bound in the sense that it can never be too small.
 *
 * The row is matched on the id the run is using, including the `aliases` list,
 * before falling back to a sole entry. A `llama-server` list is usually one row
 * — it serves the model it was started with — so the fallback is the ordinary
 * path, and matching first is what keeps it correct in front of a router that
 * lists several.
 */
export function parseLlamaModelsWindow(body: unknown, model: string | undefined): number | undefined {
  const entry = modelRow(body, model);
  const meta = asRecord(entry?.['meta']);
  if (meta === undefined) return undefined;
  return positive(meta['n_ctx']) ?? positive(meta['n_ctx_train']);
}

/**
 * The `data` row this run is talking to, or the only row there is.
 *
 * Shared by the two OpenAI-shaped readers below. Returning the sole entry when
 * nothing matches is deliberate and is not a guess: a list of one is a server
 * saying it has one model, and the run is talking to that server.
 */
function modelRow(body: unknown, model: string | undefined): Record<string, unknown> | undefined {
  const data = asRecord(body)?.['data'];
  if (!Array.isArray(data)) return undefined;

  const rows = data.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined);
  if (model !== undefined) {
    const named = rows.find((row) => {
      if (row['id'] === model) return true;
      const aliases = row['aliases'];
      return Array.isArray(aliases) && aliases.includes(model);
    });
    if (named !== undefined) return named;
  }
  return rows.length === 1 ? rows[0] : undefined;
}

/* -------------------------------------------------------------------------- */
/* LM Studio — UNVERIFIED                                                     */
/* -------------------------------------------------------------------------- */

/**
 * LM Studio's `/api/v0/models`, from documentation. **Not driven.**
 *
 * Documented to report `max_context_length` per model and, for a model that is
 * loaded, the `loaded_context_length` it was loaded at. The loaded one wins for
 * the same reason `/props` beats `n_ctx_train` above: it is what the server is
 * doing rather than what the file permits.
 */
export function parseLmStudioWindow(body: unknown, model: string | undefined): number | undefined {
  const entry = modelRow(body, model);
  if (entry === undefined) return undefined;
  return positive(entry['loaded_context_length']) ?? positive(entry['max_context_length']);
}

/* -------------------------------------------------------------------------- */
/* Ollama — UNVERIFIED                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ollama's `/api/show`, from documentation. **Not driven.**
 *
 * The awkward one. Ollama answers with a `model_info` map keyed by the
 * *architecture* — `qwen3.context_length`, `llama.context_length` — so the key
 * cannot be named up front and is found by suffix. That is the checkpoint's
 * length; the served one, when the model was pulled with a `num_ctx` override,
 * appears in the `parameters` block as free text. `num_ctx` wins where both are
 * present, on the same rule as everywhere else in this file: what the server is
 * doing beats what the file permits.
 */
export function parseOllamaShowWindow(body: unknown): number | undefined {
  const record = asRecord(body);
  if (record === undefined) return undefined;

  const parameters = record['parameters'];
  if (typeof parameters === 'string') {
    const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
    if (match !== null) {
      const declared = positive(Number(match[1]));
      if (declared !== undefined) return declared;
    }
  }

  const info = asRecord(record['model_info']);
  if (info === undefined) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length')) continue;
    const length = positive(value);
    if (length !== undefined) return length;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The chain                                                                  */
/* -------------------------------------------------------------------------- */

/** What each flavour is asked, in the order the answers should be trusted. */
export function contextProbesFor(flavourId: ProviderId): readonly ContextProbe[] {
  if (flavourId === 'ollama') {
    return [
      {
        path: '/api/show',
        method: 'POST',
        body: (model) => ({ model: model ?? '' }),
        parse: (body) => parseOllamaShowWindow(body),
      },
    ];
  }
  if (flavourId === 'lmstudio') {
    return [{ path: '/api/v0/models', method: 'GET', parse: parseLmStudioWindow }];
  }
  return [
    { path: '/props', method: 'GET', parse: (body) => parseLlamaProps(body) },
    { path: '/v1/models', method: 'GET', parse: parseLlamaModelsWindow },
  ];
}

/**
 * One reading per server-and-model, held for the life of the process.
 *
 * The window does not change while a server is up, and a run makes several
 * completions — one per tool call — each of which wants to report occupancy.
 * Probing on every one of them would put two extra HTTP requests between a
 * model finishing a tool call and starting the next, on the one provider whose
 * latency the user is already watching closely.
 *
 * Keyed by address *and* model because a profile is an address: two profiles on
 * two machines are two different servers, and a router in front of several
 * backends serves a different window per model behind one address.
 *
 * The promise is cached rather than the value, so the completions of a single
 * turn share one in-flight request rather than racing three. A rejected or
 * empty reading is evicted, so a server that was still loading when the first
 * run started is asked again on the next one rather than being remembered as
 * unknowable for the session.
 */
const cache = new Map<string, Promise<number | undefined>>();

/** Test seam, and a hook for a future "the server restarted" signal. */
export function clearContextWindowCache(): void {
  cache.clear();
}

export interface ContextWindowQuery {
  readonly flavourId: ProviderId;
  /** Already normalised — no trailing slash. See the adapter's `baseUrl`. */
  readonly baseUrl: string;
  readonly model: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Injected by tests; production passes nothing and gets the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Ask the server how big its window is, once.
 *
 * Never throws. Every failure — a refused connection, a 404 from a router that
 * only proxies `/v1`, a body that is not JSON — is the same outcome as a server
 * that answered without saying: `undefined`, and the caller shows tokens with
 * no denominator. A context gauge is not worth failing a run over.
 */
export async function readContextWindow(query: ContextWindowQuery): Promise<number | undefined> {
  const key = `${query.flavourId}|${query.baseUrl}|${query.model ?? ''}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const reading = probe(query);
  cache.set(key, reading);
  // Evicted unless it actually landed, so "the server was still loading" does
  // not become "this server has no window" for the rest of the session.
  void reading.then(
    (value) => {
      if (value === undefined) cache.delete(key);
    },
    () => cache.delete(key),
  );
  return reading;
}

/**
 * How long one probe may take before it is abandoned.
 *
 * Short, and it has to be: a run waits for this reading before declaring itself
 * over, so an endpoint that accepts the connection and then never answers —
 * which is what a wedged reverse proxy looks like — would hold a finished
 * conversation open on a gauge nobody asked for. Two of these back to back is
 * the worst case, and it only happens on a server that is already broken.
 */
const PROBE_TIMEOUT_MS = 3_000;

async function probe(query: ContextWindowQuery): Promise<number | undefined> {
  const doFetch = query.fetchImpl ?? fetch;

  for (const spec of contextProbesFor(query.flavourId)) {
    try {
      const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const response = await doFetch(`${query.baseUrl}${spec.path}`, {
        method: spec.method,
        headers: {
          ...query.headers,
          ...(spec.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body(query.model)) }),
        signal:
          query.signal === undefined ? deadline : AbortSignal.any([query.signal, deadline]),
      });
      if (!response.ok) continue;
      const window = spec.parse(await response.json(), query.model);
      if (window !== undefined) return window;
    } catch {
      // Next probe. See the header: an unknown window is a supported state.
    }
  }
  return undefined;
}
