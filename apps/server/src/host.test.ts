/**
 * What the server's composition root puts around a served run.
 *
 * Driven through `createHeadlessHost` itself — with the SDK replaced by a
 * scripted transport, so what is exercised is the chain a served client hangs
 * off: host → registry → Claude adapter → the registry's fan-out, which is
 * where the wire picks events up. Two things are asked of it here: that a
 * subagent outliving its turn is still seen to finish, and that this machine's
 * memory banks reach every path that starts a run.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderId, RoutineDraft, ServerConnection } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
}));

// Resolved from core's own location and by real path, because pnpm's isolated
// linking means the bare specifier does not resolve from this package — and
// core's copy is the one that has to be replaced.
const sdk = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { realpathSync } = await import('node:fs');
  const fromCore = createRequire(realpathSync(createRequire(import.meta.url).resolve('@rx-artemis/core')));
  return { path: realpathSync(fromCore.resolve('@anthropic-ai/claude-agent-sdk')) };
});

vi.mock(sdk.path, () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
}));

const { createHeadlessHost } = await import('./host.js');
const { AsyncQueue, REGISTRY_V2_FILE, projectKey, workspaceKeyFor } = await import('@rx-artemis/core');

class FakeQuery {
  readonly messages = new AsyncQueue<SDKMessage>();
  closed = false;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }
  interrupt(): Promise<{ still_queued: string[] }> {
    return Promise.resolve({ still_queued: [] });
  }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  close(): void {
    this.closed = true;
    this.messages.close();
  }
}

/**
 * @param onQuery observed at the instant the SDK is called, which is *during*
 *   the start — the only way to assert that something happened before a run
 *   rather than merely by the time the test looked.
 */
function installQuery(onQuery?: () => void) {
  let captured:
    | { fake: FakeQuery; prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }
    | undefined;
  sdkMock.onQuery = (params) => {
    const fake = new FakeQuery();
    captured = {
      fake,
      prompt: params.prompt as AsyncIterable<SDKUserMessage>,
      options: (params.options ?? {}) as Record<string, unknown>,
    };
    onQuery?.();
    return fake;
  };
  const latest = () => {
    if (captured === undefined) throw new Error('query() was never called');
    return captured;
  };
  return {
    fake: () => latest().fake,
    prompts: () => latest().prompt[Symbol.asyncIterator](),
    options: () => latest().options,
    /** The text appended to the provider's preset, or `undefined` for none. */
    append: (): string | undefined => {
      const spec = latest().options['systemPrompt'];
      if (typeof spec !== 'object' || spec === null) return undefined;
      const append = (spec as { append?: unknown }).append;
      return typeof append === 'string' ? append : undefined;
    },
  };
}

const SESSION = 'sess-abc';
const sys = (subtype: string, rest: Record<string, unknown>): SDKMessage =>
  ({ type: 'system', subtype, session_id: SESSION, uuid: `${subtype}-${String(Math.random())}`, ...rest }) as unknown as SDKMessage;

const INIT = (cwd: string): SDKMessage =>
  sys('init', {
    cwd,
    model: 'claude-opus-4',
    tools: [],
    slash_commands: [],
    permissionMode: 'default',
    claude_code_version: '2.1.226',
    mcp_servers: [],
    apiKeySource: 'user',
    output_style: 'default',
    skills: [],
    plugins: [],
  });

const RESULT: SDKMessage = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 100,
  duration_api_ms: 90,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
  modelUsage: {},
  permission_denials: [],
  session_id: SESSION,
  uuid: 'result-1',
} as unknown as SDKMessage;

const tasksChanged = (ids: readonly string[]): SDKMessage =>
  sys('background_tasks_changed', {
    tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'map the keybindings', status: 'running' })),
  });

const taskStarted = (task_id: string): SDKMessage =>
  sys('task_started', { task_id, task_type: 'local_agent', description: 'map the keybindings', subagent_type: 'Explore' });

const taskNotification = (task_id: string): SDKMessage =>
  sys('task_notification', { task_id, status: 'completed', summary: 'Found 14 bindings', usage: { total_tokens: 4200, tool_uses: 6, duration_ms: 9000 } });

const NOTIFICATION: SDKMessage = {
  type: 'user',
  parent_tool_use_id: null,
  uuid: 'notif-1',
  session_id: SESSION,
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>' },
} as unknown as SDKMessage;

const assistantText = (text: string, id = 'msg-a'): SDKMessage =>
  ({
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION,
    uuid: `u-${id}`,
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

let root: string;
let cwd: string;
let dataDir: string;
/** The two served accounts' config directories, where their project memory lives. */
let configDirs: { work: string; personal: string };
let host: ReturnType<typeof createHeadlessHost>;

/** The bridge's connection, pinned to the run directory these tests use. */
const connection = (): ServerConnection => ({
  id: 'conn-a',
  label: 'Laptop',
  workspace: { kind: 'directory', path: cwd },
  token: 'token-a',
  createdAt: 0,
});

/** A legacy-flat bank with one memory in it. No git, so nothing ever pulls. */
async function writeBank(slug: string): Promise<string> {
  const bank = join(root, `bank-${slug}`);
  await mkdir(join(bank, 'memories'), { recursive: true });
  await writeFile(
    join(bank, 'memories', 'unraid-paths.md'),
    '---\nname: unraid-paths\ndescription: Before writing a host path on an Unraid box\nmetadata:\n  type: reference\n---\n\nUse /mnt/user.\n',
  );
  return bank;
}

/** Artemis's own registry, listing one bank at one profile scope. */
async function registerBank(
  slug: string,
  path: string,
  profiles: { kind: 'all' } | { kind: 'profiles'; profileIds: readonly string[] },
): Promise<void> {
  await writeFile(
    join(dataDir, REGISTRY_V2_FILE),
    JSON.stringify({
      version: 2,
      banks: [{ slug, path, role: 'readwrite', enabled: true, profiles }],
      default: slug,
    }),
  );
}

const profile = (id: string, label: string, configDir: string) => ({
  id,
  label,
  providerId: 'claude',
  configDir,
  publicEnv: {},
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-served-settle-'));
  dataDir = join(root, 'data');
  cwd = join(root, 'work');
  configDirs = {
    work: join(dataDir, 'profiles', 'work'),
    personal: join(dataDir, 'profiles', 'personal'),
  };
  await Promise.all([
    mkdir(configDirs.work, { recursive: true }),
    mkdir(configDirs.personal, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  await writeFile(
    join(dataDir, 'profiles.json'),
    JSON.stringify({
      version: 2,
      profiles: [
        profile('prof_work', 'Work', configDirs.work),
        profile('prof_personal', 'Personal', configDirs.personal),
      ],
    }),
  );
  /*
   * The banks are read from this machine's own files, and by default that
   * means the *developer's* — `~/.config/cerebro/config.json` and the
   * single-bank era's `~/Documents/cerebro`. Both are pointed at this test's
   * scratch directory, so a machine that really carries banks neither leaks
   * them into these assertions nor has its CLI registry written to.
   */
  process.env['XDG_CONFIG_HOME'] = join(root, 'xdg');
  process.env['ARTEMIS_CEREBRO_ROOT'] = join(root, 'no-legacy-clone');
  host = createHeadlessHost(dataDir, () => [connection()]);
});

afterEach(async () => {
  sdkMock.onQuery = undefined;
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['ARTEMIS_CEREBRO_ROOT'];
  await host.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('a subagent that outlives its served turn', () => {
  it('settles on the stream a client is listening to, on a turn of the provider\'s own', async () => {
    const seen: AgentEvent[] = [];
    host.runs.subscribe((event) => seen.push(event));
    const query = installQuery();

    const handle = await host.runs.start({ providerId: 'claude', profileId: 'prof_work' as never, cwd, prompt: 'delegate something', permissionMode: 'default' } as never);
    await query.prompts().next();
    const fake = query.fake();

    // The turn delegates and ends, leaving the subagent running.
    fake.messages.push(INIT(cwd));
    fake.messages.push(taskStarted('t1'));
    fake.messages.push(tasksChanged(['t1']));
    fake.messages.push(RESULT);
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'run.end' && event.runId === handle.runId)).toBe(true));
    expect(fake.closed).toBe(false);

    // The subagent finishes; the CLI says so, then takes a turn of its own about it.
    fake.messages.push(tasksChanged([]));
    fake.messages.push(taskNotification('t1'));
    fake.messages.push(INIT(cwd));
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The Explore agent found 14 bindings.', 'msg-notif'));
    fake.messages.push(RESULT);

    await vi.waitFor(
      () => {
        const settled = seen.find(
          (event) => event.type === 'background.tasks' && event.tasks.some((task) => task.id === 't1' && task.status === 'completed'),
        );
        expect(settled).toBeDefined();
        // On a run the client never started — the one it has to be told about.
        expect(settled?.runId).not.toBe(handle.runId);
        expect(host.runs.get(settled!.runId)?.sessionId).toBe(SESSION);
      },
      { timeout: 3_000 },
    );
    expect(seen.some((event) => event.type === 'text.complete' && event.text === 'The Explore agent found 14 bindings.')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The banks this machine carries                                             */
/* -------------------------------------------------------------------------- */

type StartRunInput = Parameters<typeof host.runSource.startRun>[0];

const started = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  providerId: 'claude',
  profileId: 'prof_work',
  cwd,
  prompt: 'what does the team know about this repo?',
  model: 'claude-opus-4',
  ...overrides,
});

describe('the memory banks this machine carries', () => {
  it('describes a bank to the account it is attached to, and to no other', async () => {
    await registerBank('cortex', await writeBank('cortex'), {
      kind: 'profiles',
      profileIds: ['prof_work'],
    });
    const query = installQuery();

    await host.runSource.startRun(started());
    expect(query.append()).toContain('`cortex`');

    // The same machine, the same bank, a different account: nothing about it
    // reaches the run, and nothing about it is installed for that account.
    await host.runSource.startRun(started({ profileId: 'prof_personal' }));
    expect(query.append()).toBeUndefined();
    expect(existsSync(join(configDirs.personal, 'projects', projectKey(cwd), 'memory', 'banks', 'cortex'))).toBe(false);
  });

  it('carries the bank on the bridge path and on a routine firing', async () => {
    const bank = await writeBank('cortex');
    await registerBank('cortex', bank, { kind: 'all' });
    const query = installQuery();

    // The bridge: a person at another machine, running with their own settings.
    await host.runSource.startUserRun!({
      providerId: 'claude',
      profileId: 'prof_work',
      cwd,
      prompt: 'catch me up',
    });
    expect(query.append()).toContain('`cortex`');
    // And the checkout itself, so a sandboxed tool can open what the index
    // points at — the bank lives outside the working directory.
    expect(query.options()['additionalDirectories']).toContain(bank);

    // A firing: the most unattended run this process starts.
    await host.routines.load();
    const draft: RoutineDraft = {
      name: 'Morning triage',
      instructions: 'Read the overnight alerts and summarise.',
      profileId: 'prof_work',
      providerId: 'claude',
      model: 'claude-opus-4',
      schedule: { kind: 'daily', at: '09:00' },
    };
    const created = await host.routines.create({ draft, connection: connection() });
    await host.routines.runNow(workspaceKeyFor(connection()), created.id);

    expect(query.options()['systemPrompt']).toBeDefined();
    expect(query.append()).toContain('`cortex`');
    expect(query.options()['additionalDirectories']).toContain(bank);
  });

  it('hands a provider whose harness will not load the memory file its index inline', async () => {
    await registerBank('cortex', await writeBank('cortex'), { kind: 'all' });
    /*
     * The same adapter under another id. What is under test is what the *host*
     * makes of the provider — a Claude harness loads the project's memory file
     * itself, and every other provider has to be told what is in it — not how
     * a local model runs, which has its own tests.
     */
    const claude = host.providers.get('claude');
    host.providers.register({ ...claude!, id: 'llamacpp' as ProviderId }, { replace: true });
    const query = installQuery();

    await host.runSource.startRun(started({ providerId: 'llamacpp' }));
    const append = query.append();
    expect(append).toContain('What `cortex` holds for this project');
    expect(append).toContain('Before writing a host path on an Unraid box');

    // The Claude account on the same machine is told where the index is, not
    // what is in it.
    await host.runSource.startRun(started());
    expect(query.append()).not.toContain('What `cortex` holds for this project');
  });

  it('installs the bank into the run\'s project before the run starts', async () => {
    await registerBank('cortex', await writeBank('cortex'), { kind: 'all' });
    const memory = join(configDirs.work, 'projects', projectKey(cwd), 'memory');

    // Read at the instant the SDK is called, which is inside the start: a
    // first run in a new project must not begin without the team's memory.
    let installedWhenQueried = false;
    installQuery(() => {
      installedWhenQueried = existsSync(join(memory, 'banks', 'cortex', 'unraid-paths.md'));
    });
    await host.runSource.startRun(started());

    expect(installedWhenQueried).toBe(true);
    const index = await readFile(join(memory, 'MEMORY.md'), 'utf8');
    expect(index).toContain('<!-- cerebro:cortex:begin -->');
    expect(index).toContain('unraid-paths.md');
  });

  it('starts the run it always started on a machine with no banks', async () => {
    const query = installQuery();
    await host.runSource.startRun(started({ systemPrompt: 'Answer in one line.' }));
    // The client's own standing instructions, and nothing of this machine's.
    expect(query.append()).toBe('Answer in one line.');
    // The adapter attaches a scratch directory of its own for attachments; no
    // bank is among them, because there is no bank.
    const directories = (query.options()['additionalDirectories'] ?? []) as readonly string[];
    expect(directories.some((directory) => directory.startsWith(join(root, 'bank-')))).toBe(false);
  });
});
