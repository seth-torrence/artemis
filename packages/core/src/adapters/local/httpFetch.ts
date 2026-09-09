/**
 * `http_fetch` — the one tool that leaves this machine.
 * ============================================================================
 *
 * A coding agent that can read, write, search and run a command still cannot
 * read a changelog, call an API it is being asked to integrate, or check
 * whether the service it just configured is answering. On the hosted providers
 * that gap is filled by the vendor's own fetch tool; here there is no vendor,
 * so it is filled by this file.
 *
 * Performed by Artemis rather than handed to something else, which is what
 * makes the limits below real limits rather than requests: the redirect count,
 * the byte ceiling, the clock and the address rules are all enforced on this
 * side of the call.
 *
 * ## Why private addresses are allowed at all
 *
 * Most fetch tools block RFC1918 and be done with it. That rule is written for
 * a server-side agent whose neighbours on the LAN are other tenants. This one
 * runs on a person's own desktop, and the endpoints they actually want are a
 * Home Assistant on `192.168.x`, a container on `localhost`, a service on a
 * tailnet's `100.64/10`. A tool that could reach the public internet but not
 * the user's own machines would be exactly backwards.
 *
 * So the gate is the permission mode, and it turns on *whether a person saw the
 * address*:
 *
 * | Mode                 | Private addresses                          |
 * | -------------------- | ------------------------------------------ |
 * | `plan`               | the tool is not offered at all             |
 * | `default`            | allowed — every call is approved by hand    |
 * | `acceptEdits`        | **refused** — see below                    |
 * | `bypassPermissions`  | allowed — the user said not to ask         |
 *
 * `acceptEdits` is the interesting row. That mode's bargain is "stop asking me
 * about edits to this working directory": it is a statement about files the
 * user is looking at and git can undo. It was never a decision about the
 * network, and quietly letting an unattended turn reach the LAN under it would
 * be exactly the scope creep the permission modes exist to prevent. The same
 * reasoning keeps `acceptEdits` from auto-allowing a tool server.
 *
 * ## What is refused in every mode
 *
 * The cloud metadata addresses. `169.254.169.254` and its siblings exist to
 * hand out credentials to whatever asks, and no run has a legitimate reason to
 * read one. This is the single hard-coded refusal here, and it stays hard-coded
 * because a mode that could turn it off would be a mode that exfiltrates an
 * instance role.
 *
 * ## What this does not claim
 *
 * The address is classified by resolving the name and checking every answer,
 * which closes ordinary DNS rebinding but not a determined one: `fetch`
 * resolves again when it connects, and nothing here pins the socket to the
 * address that was checked. Said plainly rather than papered over — the honest
 * boundary is "a name that resolves privately is treated as private", and the
 * approval prompt is what the user is actually relying on.
 */

import { lookup } from 'node:dns/promises';

import type { ToolResult, ToolSpec } from './tools.js';

/** How long one fetch may take, start to finish. */
const TIMEOUT_MS = 30_000;

/** Most bytes read from a response before it is truncated. */
const MAX_BYTES = 2_000_000;

/** Most characters handed to the model, after any extraction. */
const MAX_OUTPUT = 30_000;

/** How many redirects are followed before the chain is called a loop. */
const MAX_REDIRECTS = 5;

export const HTTP_FETCH: ToolSpec = {
  name: 'http_fetch',
  description:
    'Fetch an http or https URL and return the response as text. GET or POST. ' +
    'HTML is converted to readable text; JSON and plain text are returned as they are. ' +
    'Large responses are truncated. A non-2xx status is returned rather than treated as an error.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http or https address to fetch.' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'Defaults to GET.' },
      headers: {
        type: 'object',
        description: 'Request headers, as a flat object of strings.',
        additionalProperties: { type: 'string' },
      },
      body: { type: 'string', description: 'Request body, for POST.' },
    },
    required: ['url'],
  },
  // The same gate as `write_file`: withheld in plan mode, prompted in default,
  // and covered by `acceptEdits`. A request that leaves the machine is not a
  // read of this workspace, whatever the HTTP verb says.
  risk: 'write',
  // Artemis performs this itself, so `confine`'s absence is not a gap: there is
  // no path to resolve and no command line to wrap. See the header of
  // `tools.ts` for the three kinds of tool and which needs which defence.
  needsOsSandbox: false,
};

/* -------------------------------------------------------------------------- */
/* Addresses                                                                  */
/* -------------------------------------------------------------------------- */

/** What kind of place an address points at. */
export type HostKind = 'public' | 'private' | 'metadata';

/** Hostnames that name a cloud metadata service rather than an address. */
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);

/** Suffixes that are private by construction, whatever they resolve to. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * Classify one literal IP address.
 *
 * Returns `null` when the text is not an address at all, which is how the
 * caller knows to resolve it.
 */
export function classifyAddress(address: string): HostKind | null {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4 !== null) {
    const octets = v4.slice(1, 5).map((part) => Number(part));
    if (octets.some((octet) => octet > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    // The one that is never allowed, checked before anything else can widen it.
    if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata';
    if (a === 0 || a === 10 || a === 127) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private';
    // 100.64/10 — carrier-grade NAT, and what a tailnet addresses its machines
    // in. The single most likely private range for this user base.
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    // Benchmarking and IETF protocol assignments; neither is a real internet
    // host and both have been used to smuggle a loopback reference.
    if (a === 198 && (b === 18 || b === 19)) return 'private';
    if (a === 192 && b === 0 && c === 0) return 'private';
    return 'public';
  }

  if (!bare.includes(':')) return null;
  const v6 = bare.toLowerCase().split('%')[0] ?? '';
  // An IPv4-mapped address is the IPv4 address wearing a hat.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
  if (mapped?.[1] !== undefined) return classifyAddress(mapped[1]);
  if (v6 === '::1' || v6 === '::') return 'private';
  if (v6 === 'fd00:ec2::254') return 'metadata';
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd]/.test(v6)) return 'private';
  if (/^fe[89ab]/.test(v6)) return 'private';
  return 'public';
}

/**
 * Classify a hostname, resolving it when it is not already an address.
 *
 * Every answer is checked, not the first: a name with one public and one
 * private A record is a private name for this purpose.
 */
export async function classifyHost(hostname: string): Promise<HostKind> {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (METADATA_NAMES.has(name)) return 'metadata';

  const literal = classifyAddress(hostname);
  if (literal !== null) return literal;

  if (name === 'localhost' || name.endsWith('.localhost')) return 'private';
  if (PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'private';

  let answers: { address: string }[];
  try {
    answers = await lookup(name, { all: true });
  } catch {
    // A name that does not resolve is not a way in. Treated as private so the
    // refusal is the conservative one; the fetch would fail anyway.
    return 'private';
  }
  let kind: HostKind = 'public';
  for (const answer of answers) {
    const answered = classifyAddress(answer.address);
    if (answered === 'metadata') return 'metadata';
    if (answered === 'private') kind = 'private';
  }
  return kind;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                       */
/* -------------------------------------------------------------------------- */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
};

/**
 * A page's prose, without its markup.
 *
 * The same judgement `browserTools.ts` makes with `innerText`, made without a
 * browser to ask: a page whose text is two kilobytes is routinely four hundred
 * kilobytes of HTML, and the model is nearly always asking what the page says
 * rather than how it is built. Script, style and head go entirely — their
 * contents are not prose and are usually most of the bytes.
 *
 * Deliberately not a parser. A regex cannot be a correct HTML parser and this
 * one does not try to be; it is a lossy renderer whose failure mode is stray
 * punctuation in a result the model reads, which is the right failure mode for
 * something on this path.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      const known = ENTITIES[key];
      if (known !== undefined) return known;
      const numeric = /^#(x?)([0-9a-f]+)$/i.exec(name);
      if (numeric === null) return whole;
      const code = Number.parseInt(numeric[2] ?? '', numeric[1] === '' ? 10 : 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    })
    .replace(/[ \t\f\v ]+/g, ' ')
    // Spaces around a break go with it: `</li> <li>` leaves one behind, and a
    // line that starts with a space reads as an indent the page never had.
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

/** What `http_fetch` needs beyond its arguments. */
export interface FetchContext {
  /** Cancels the request when the run is stopped. */
  readonly signal: AbortSignal;
  /** Whether this run's permission mode lets it reach a private address. */
  readonly allowPrivateNetwork: boolean;
  /** Injected for tests. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Read a body up to the ceiling, saying how much was left. */
async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { text: '', truncated: false };

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let read = 0;
  const reader = (body as unknown as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done === true) break;
      const value = next.value;
      if (value === undefined) continue;
      read += value.byteLength;
      if (read > MAX_BYTES) {
        const room = value.byteLength - (read - MAX_BYTES);
        chunks.push(decoder.decode(value.subarray(0, Math.max(0, room))));
        return { text: chunks.join(''), truncated: true };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Releasing rather than cancelling: a truncated read still wants the socket
    // torn down, and `cancel` on an already-finished stream throws on some
    // runtimes.
    await reader.cancel().catch(() => undefined);
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(''), truncated: false };
}

/** Headers the model asked for, minus the ones it is not allowed to decide. */
function requestHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return headers;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const name = key.toLowerCase();
    // `host` decides which virtual host answers and is the other half of every
    // DNS-rebinding trick; the rest are the transport's to set.
    if (name === 'host' || name === 'content-length' || name === 'connection') continue;
    headers[key] = value;
  }
  return headers;
}

/**
 * Fetch one URL.
 *
 * Never throws: the model is the one that has to recover, and "that host is not
 * answering" is something it can read and work around. See `executeTool`.
 */
export async function httpFetch(
  args: Record<string, unknown>,
  context: FetchContext,
): Promise<ToolResult> {
  const requested = args['url'];
  if (typeof requested !== 'string' || requested.trim() === '') {
    return { output: 'The "url" argument is required and must be a non-empty string.', failed: true };
  }
  const method = typeof args['method'] === 'string' ? args['method'].toUpperCase() : 'GET';
  if (method !== 'GET' && method !== 'POST') {
    return { output: `"${method}" is not a method this tool can send. Use GET or POST.`, failed: true };
  }

  const doFetch = context.fetch ?? globalThis.fetch;
  // One clock for the whole chain, redirects included: a per-hop timeout is six
  // timeouts, and the thing being bounded is how long the user waits.
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([context.signal, deadline]);

  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return { output: `"${requested}" is not a valid URL.`, failed: true };
  }

  const visited: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { output: `"${url.protocol}" is not a scheme this tool can fetch. Use http or https.`, failed: true };
    }

    // Re-checked on every hop, not only the first. A redirect into a private
    // address is the ordinary way this rule gets stepped around, and an open
    // redirect to the metadata service is a real technique rather than a
    // hypothetical one.
    const kind = await classifyHost(url.hostname);
    if (kind === 'metadata') {
      return {
        output: `Refused: ${url.hostname} is a cloud metadata address, which exists only to hand out credentials. This is refused in every permission mode.`,
        failed: true,
      };
    }
    if (kind === 'private' && !context.allowPrivateNetwork) {
      return {
        output: `Refused: ${url.hostname} is a private address, and this run's permission mode does not allow reaching one unattended. Switch to the default mode, where each request is approved, or to bypassPermissions.`,
        failed: true,
      };
    }

    visited.push(url.toString());
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: requestHeaders(args['headers']),
        ...(method === 'POST' && typeof args['body'] === 'string' ? { body: args['body'] } : {}),
        // Followed by hand so every hop is classified. `fetch`'s own
        // redirect-following would land on a private address without asking.
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        output: deadline.aborted
          ? `The request to ${url.hostname} took longer than ${String(TIMEOUT_MS / 1000)} seconds and was stopped.`
          : `Could not reach ${url.hostname}: ${detail}`,
        failed: true,
      };
    }

    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (location !== null) {
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { output: `${url.toString()} redirected to "${location}", which is not a valid URL.`, failed: true };
      }
      if (hop === MAX_REDIRECTS) {
        return {
          output: `Stopped after ${String(MAX_REDIRECTS)} redirects:\n${visited.join('\n')}\n→ ${next.toString()}`,
          failed: true,
        };
      }
      url = next;
      continue;
    }

    return render(response, url, visited);
  }

  // Unreachable: the loop either returns or redirects, and the last hop
  // refuses. Present because the compiler cannot see that and a thrown
  // "unreachable" would be a run-ending error for a state that cannot happen.
  return { output: 'The redirect chain did not end.', failed: true };
}

/** One response, as the model should read it. */
async function render(response: Response, url: URL, visited: readonly string[]): Promise<ToolResult> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const { text, truncated } = await readCapped(response);
  const body = contentType.includes('html') || /^\s*<(!doctype|html)\b/i.test(text)
    ? htmlToText(text)
    : text;

  const head = [
    `${String(response.status)} ${response.statusText} — ${url.toString()}`,
    ...(visited.length > 1 ? [`Redirected from ${visited[0] ?? ''}`] : []),
    ...(contentType === '' ? [] : [contentType]),
  ].join('\n');

  const trimmed = body.length <= MAX_OUTPUT
    ? body
    : `${body.slice(0, MAX_OUTPUT)}\n\n[truncated — ${String(body.length - MAX_OUTPUT)} more characters]`;
  const note = truncated && body.length <= MAX_OUTPUT ? `\n\n[the response exceeded ${String(MAX_BYTES)} bytes and was cut short]` : '';

  return {
    output: `${head}\n\n${trimmed === '' ? '(empty response body)' : trimmed}${note}`,
    // A 404 is an answer. Marked as failed so the row reads correctly, but the
    // status and body still reach the model — that is what lets it read the
    // error and try another path instead of giving up.
    ...(response.ok ? {} : { failed: true }),
  };
}
