/**
 * What a tool-server entry is allowed to be.
 *
 * Three layers run this check — the settings form, the IPC boundary and the
 * profile store — so the rules live here and are pinned here. The one that
 * earns its keep is the literal-secret refusal: `profiles.json` is a file with
 * nothing secret in it, and the way it stays one is that a pasted token never
 * gets in.
 */

import { describe, expect, it } from 'vitest';

import { enabledToolServers, toolServerProblem, toolServersProblem } from './toolServer.js';
import type { ToolServerConfig } from './toolServer.js';

const http = (over: Partial<ToolServerConfig> = {}): ToolServerConfig => ({
  name: 'github',
  transport: 'http',
  url: 'https://api.github.com/mcp',
  ...over,
});

const stdio = (over: Partial<ToolServerConfig> = {}): ToolServerConfig => ({
  name: 'cortex',
  transport: 'stdio',
  command: 'cerebro-mcp',
  ...over,
});

describe('names', () => {
  it('accepts what survives mcp__<name>__<tool> unchanged', () => {
    expect(toolServerProblem(http({ name: 'open-bao_2' }))).toBeNull();
  });

  it('refuses a name that would be rewritten on its way to the model', () => {
    // `open bao` would reach the model as `open_bao`, so a permission rule
    // written against the name the user typed would never match.
    expect(toolServerProblem(http({ name: 'open bao' }))).toContain('server name');
    expect(toolServerProblem(http({ name: '' }))).toContain('server name');
    expect(toolServerProblem(http({ name: '-leading' }))).toContain('server name');
  });

  it('refuses two servers with one name, which would shadow each other silently', () => {
    expect(toolServersProblem([http(), http({ url: 'https://elsewhere/mcp' })])).toContain(
      'must be unique',
    );
    // Case is not a distinction: `mcp__GitHub__` and `mcp__github__` are two
    // prefixes and one source of confusion.
    expect(toolServersProblem([http(), http({ name: 'GitHub' })])).toContain('must be unique');
  });
});

describe('transports', () => {
  it('wants a command for stdio and a url for http', () => {
    expect(toolServerProblem(stdio())).toBeNull();
    expect(toolServerProblem(http())).toBeNull();
    expect(toolServerProblem(stdio({ command: undefined }))).toContain('command');
    expect(toolServerProblem(http({ url: undefined }))).toContain('url');
  });

  it('refuses an entry that is both', () => {
    expect(toolServerProblem(stdio({ url: 'https://x/mcp' }))).toContain('cannot also have a url');
    expect(toolServerProblem(http({ command: 'x' }))).toContain('cannot also have a command');
  });

  it('refuses an address that is not http or https', () => {
    expect(toolServerProblem(http({ url: 'ws://host/mcp' }))).toContain('not usable');
    expect(toolServerProblem(http({ url: 'localhost:3000' }))).toContain('not usable');
  });
});

describe('secrets', () => {
  it('accepts a ${NAME} reference, which is the whole point', () => {
    expect(
      toolServerProblem(http({ headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } })),
    ).toBeNull();
    expect(toolServerProblem(stdio({ env: { GITHUB_TOKEN: '${GH_PAT}' } }))).toBeNull();
  });

  it('refuses a token pasted into a header', () => {
    const problem = toolServerProblem(
      http({ headers: { Authorization: 'Bearer ghp_0123456789abcdefghij' } }),
    );
    // The sentence has to teach the fix, because the user is looking at a box
    // they have just pasted into.
    expect(problem).toContain('${NAME}');
  });

  it('refuses a long opaque value under a credential-shaped name', () => {
    expect(toolServerProblem(stdio({ env: { API_KEY: 'abcdefghijklmnopqrstuvwxyz' } }))).toContain(
      '${NAME}',
    );
  });

  it('leaves short values alone, which are settings rather than secrets', () => {
    expect(toolServerProblem(http({ headers: { Authorization: 'Basic' } }))).toBeNull();
    expect(toolServerProblem(stdio({ env: { API_KEY_FILE: '/etc/k' } }))).toBeNull();
  });
});

describe('enabledToolServers', () => {
  it('keeps a switched-off entry in the file and out of the run', () => {
    // Kept rather than deleted: switching a server off for an afternoon should
    // not cost the user the config they typed.
    const list = [http(), stdio({ enabled: false })];
    expect(enabledToolServers(list).map((server) => server.name)).toEqual(['github']);
  });

  it('treats an absent flag as on', () => {
    expect(enabledToolServers([http()])).toHaveLength(1);
    expect(enabledToolServers(undefined)).toEqual([]);
  });
});
