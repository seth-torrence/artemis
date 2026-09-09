/**
 * The one tool that leaves the machine.
 *
 * The address rules are driven against a real loopback server rather than a
 * stubbed `fetch`, because "does a redirect into a private address get
 * classified again" is a question about what the code does with a real
 * `Location` header, and a stub would be asserting that the test's idea of a
 * redirect matches the test's idea of a redirect.
 *
 * The pure parts — the address classifier and the HTML renderer — are exercised
 * directly, since neither needs a socket to be wrong.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyAddress, classifyHost, htmlToText, httpFetch, HTTP_FETCH } from '../httpFetch.js';

const servers: HttpServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

interface Route {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A loopback server whose routes a test writes. */
async function serve(routes: Readonly<Record<string, Route>>): Promise<{
  origin: string;
  seen: { url: string; method: string; headers: NodeJS.Dict<string | string[]> }[];
}> {
  const seen: { url: string; method: string; headers: NodeJS.Dict<string | string[]> }[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      seen.push({ url: path, method: request.method ?? 'GET', headers: request.headers });
      const route = routes[path] ?? { status: 404, body: 'nothing here' };
      response.writeHead(route.status ?? 200, route.headers ?? { 'content-type': 'text/plain' });
      response.end(route.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

const open = { signal: new AbortController().signal, allowPrivateNetwork: true };
const closed = { signal: new AbortController().signal, allowPrivateNetwork: false };

describe('the spec', () => {
  it('is gated exactly like write_file, and needs no OS sandbox', () => {
    // Withheld in plan mode, prompted in default, covered by acceptEdits. A
    // request that leaves the machine is not a read of this workspace.
    expect(HTTP_FETCH.risk).toBe('write');
    // There is no command line here for `commandSandbox` to wrap, which is why
    // this stays false on Windows too rather than becoming a second refusal.
    expect(HTTP_FETCH.needsOsSandbox).toBe(false);
  });
});

describe('classifying an address', () => {
  it('knows the private ranges, including the one a tailnet uses', () => {
    expect(classifyAddress('10.0.0.1')).toBe('private');
    expect(classifyAddress('172.16.4.4')).toBe('private');
    expect(classifyAddress('172.32.4.4')).toBe('public');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('127.0.0.1')).toBe('private');
    // 100.64/10 — what Tailscale addresses machines in, and the single most
    // likely private range for this user base.
    expect(classifyAddress('100.109.204.54')).toBe('private');
    expect(classifyAddress('100.200.1.1')).toBe('public');
    expect(classifyAddress('8.8.8.8')).toBe('public');
  });

  it('knows the metadata addresses apart from link-local', () => {
    expect(classifyAddress('169.254.169.254')).toBe('metadata');
    expect(classifyAddress('169.254.1.1')).toBe('private');
    expect(classifyAddress('fd00:ec2::254')).toBe('metadata');
  });

  it('sees through an IPv4-mapped IPv6 address', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('private');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('metadata');
  });

  it('knows IPv6 loopback, unique-local and link-local', () => {
    expect(classifyAddress('::1')).toBe('private');
    expect(classifyAddress('fd12:3456::1')).toBe('private');
    expect(classifyAddress('fe80::1%eth0')).toBe('private');
    expect(classifyAddress('2606:4700::1111')).toBe('public');
  });

  it('says "not an address" for a name', () => {
    expect(classifyAddress('example.com')).toBeNull();
    expect(classifyAddress('999.1.1.1')).toBeNull();
  });
});

describe('classifying a host', () => {
  it('treats localhost and the private suffixes as private without resolving', async () => {
    await expect(classifyHost('localhost')).resolves.toBe('private');
    await expect(classifyHost('nas.local')).resolves.toBe('private');
    await expect(classifyHost('vault.internal')).resolves.toBe('private');
  });

  it('refuses the metadata names outright', async () => {
    await expect(classifyHost('metadata.google.internal')).resolves.toBe('metadata');
  });

  it('treats a name that does not resolve as private', async () => {
    // The conservative direction: the fetch would fail anyway, and a name that
    // cannot be classified is not a hole.
    await expect(classifyHost('nothing.invalid')).resolves.toBe('private');
  });
});

describe('fetching', () => {
  it('returns the status, the address and the body', async () => {
    const { origin } = await serve({ '/hello': { body: 'hi there' } });
    const result = await httpFetch({ url: `${origin}/hello` }, open);

    expect(result.failed).toBeUndefined();
    expect(result.output).toContain('200 OK');
    expect(result.output).toContain('hi there');
  });

  it('hands a 404 to the model rather than swallowing it', async () => {
    // A status the model can read is what lets it try another path. Ending the
    // turn on one would make every wrong guess fatal.
    const { origin } = await serve({});
    const result = await httpFetch({ url: `${origin}/missing` }, open);
    expect(result.failed).toBe(true);
    expect(result.output).toContain('404');
    expect(result.output).toContain('nothing here');
  });

  it('posts a body and sends the headers it was given', async () => {
    const { origin, seen } = await serve({ '/api': { body: 'ok' } });
    await httpFetch(
      { url: `${origin}/api`, method: 'POST', body: '{"a":1}', headers: { 'x-token': 'abc' } },
      open,
    );
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers['x-token']).toBe('abc');
  });

  it('refuses to let the model set Host', async () => {
    // The other half of every DNS-rebinding trick, and the transport's to set.
    const { origin, seen } = await serve({ '/x': { body: 'ok' } });
    await httpFetch({ url: `${origin}/x`, headers: { Host: 'evil.example' } }, open);
    expect(seen[0]?.headers.host).not.toBe('evil.example');
  });

  it('refuses a scheme it cannot fetch', async () => {
    await expect(httpFetch({ url: 'file:///etc/passwd' }, open)).resolves.toMatchObject({
      failed: true,
      output: expect.stringContaining('not a scheme'),
    });
  });

  it('refuses a method it cannot send', async () => {
    const { origin } = await serve({ '/x': { body: 'ok' } });
    await expect(httpFetch({ url: `${origin}/x`, method: 'DELETE' }, open)).resolves.toMatchObject({
      failed: true,
    });
  });
});

describe('redirects', () => {
  it('follows one and says where it came from', async () => {
    const { origin } = await serve({
      '/from': { status: 302, headers: { location: '/to' } },
      '/to': { body: 'arrived' },
    });
    const result = await httpFetch({ url: `${origin}/from` }, open);
    expect(result.output).toContain('arrived');
    expect(result.output).toContain('Redirected from');
  });

  it('stops after five and shows the chain', async () => {
    const { origin } = await serve({
      '/loop': { status: 302, headers: { location: '/loop' } },
    });
    const result = await httpFetch({ url: `${origin}/loop` }, open);
    expect(result.failed).toBe(true);
    expect(result.output).toContain('Stopped after 5 redirects');
  });

  it('re-checks every hop, so a redirect cannot reach the metadata service', async () => {
    // An open redirect to 169.254.169.254 is a real technique, not a
    // hypothetical one — which is why the check is per hop and not per call.
    const { origin } = await serve({
      '/open': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
    });
    const result = await httpFetch({ url: `${origin}/open` }, open);
    expect(result.failed).toBe(true);
    expect(result.output).toContain('metadata');
  });

  it('re-checks every hop against the private rule too', async () => {
    /*
     * A public first hop redirecting inward, which is the shape that matters
     * and the one a loopback server cannot produce: every address a test server
     * can bind is already private. So the transport is injected and the first
     * hop is a literal public address, which needs no name to resolve.
     */
    const hops: string[] = [];
    const result = await httpFetch(
      { url: 'http://8.8.8.8/out' },
      {
        ...closed,
        fetch: (input) => {
          hops.push(String(input));
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/admin' } }),
          );
        },
      },
    );

    expect(result.failed).toBe(true);
    expect(result.output).toContain('10.0.0.5');
    // And the second request was never made — the refusal is before the socket,
    // not after it.
    expect(hops).toEqual(['http://8.8.8.8/out']);
  });
});

describe('the private-network gate', () => {
  it('refuses a private address when the mode does not allow one', async () => {
    const { origin } = await serve({ '/x': { body: 'secret' } });
    const result = await httpFetch({ url: `${origin}/x` }, closed);

    expect(result.failed).toBe(true);
    expect(result.output).toContain('Refused');
    // The sentence has to say what to do about it, because the user reading it
    // is the one who can change the mode.
    expect(result.output).toContain('bypassPermissions');
  });

  it('refuses the metadata service even when private addresses are allowed', async () => {
    // The single hard-coded refusal. A mode that could turn it off would be a
    // mode that exfiltrates an instance role.
    const result = await httpFetch({ url: 'http://169.254.169.254/latest/meta-data/' }, open);
    expect(result.failed).toBe(true);
    expect(result.output).toContain('every permission mode');
  });
});

describe('HTML', () => {
  it('returns the prose and not the markup', async () => {
    const { origin } = await serve({
      '/page': {
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html><head><title>t</title><style>body{color:red}</style></head><body><script>var x=1</script><h1>Title</h1><p>Body &amp; more</p></body></html>',
      },
    });
    const result = await httpFetch({ url: `${origin}/page` }, open);

    expect(result.output).toContain('Title');
    expect(result.output).toContain('Body & more');
    // The bytes a page mostly consists of, and the ones the model has no use
    // for.
    expect(result.output).not.toContain('color:red');
    expect(result.output).not.toContain('var x=1');
  });

  it('leaves JSON alone', async () => {
    const { origin } = await serve({
      '/api': { headers: { 'content-type': 'application/json' }, body: '{"a":"<b>"}' },
    });
    const result = await httpFetch({ url: `${origin}/api` }, open);
    expect(result.output).toContain('{"a":"<b>"}');
  });

  it('decodes the entities a reader would see decoded', () => {
    expect(htmlToText('<p>a &lt; b &amp;&nbsp;c &#39;d&#39;</p>')).toBe("a < b & c 'd'");
  });

  it('turns block ends into line breaks rather than running words together', () => {
    expect(htmlToText('<li>one</li><li>two</li>')).toBe('one\ntwo');
  });
});
