/**
 * Tests for the Claude adapter's plumbing.
 *
 * The Agent SDK is mocked, so nothing is spawned and no credential is used —
 * but every path under test is the real adapter: the streaming input pump, the
 * permission deferreds, the teardown ordering, and the option construction that
 * decides what the provider actually inherits.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, PermissionRequestEvent, RunEndEvent } from '@rx-artemis/protocol';
import { SUGGESTED_TASK_TOOL } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
  onListSessions: undefined as ((options: unknown) => Promise<unknown>) | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: (options: unknown) => {
    if (sdkMock.onListSessions === undefined) {
      throw new Error('test did not install a listSessions hook');
    }
    return sdkMock.onListSessions(options);
  },
}));

const { buildClaudeOptions, CLAUDE_CAPABILITIES, createClaudeAdapter, mapSystemPrompt } =
  await import('../claude.js');
const { AsyncQueue } = await import('../stream.js');
const { AdapterError, toAgentError } = await import('../types.js');
type ResolvedRunInput = import('../types.js').ResolvedRunInput;

/* -------------------------------------------------------------------------- */
/* Fake Query                                                                 */
/* -------------------------------------------------------------------------- */

class FakeQuery {
  readonly messages = new AsyncQueue<SDKMessage>();
  closed = false;
  interruptCalls = 0;
  interruptImpl: () => Promise<{ still_queued: string[] }> = () =>
    Promise.resolve({ still_queued: [] });

  /**
   * The mid-session control requests, recorded in order.
   *
   * These are what make attaching to a live process sound rather than a silent
   * downgrade — a turn asking for a different model has to move the process onto
   * it — so the tests assert on them by name.
   */
  readonly models: (string | undefined)[] = [];
  readonly modes: string[] = [];
  readonly flags: unknown[] = [];

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }

  interrupt(): Promise<{ still_queued: string[] }> {
    this.interruptCalls += 1;
    return this.interruptImpl();
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }

  async applyFlagSettings(settings: unknown): Promise<void> {
    this.flags.push(settings);
  }

  close(): void {
    this.closed = true;
    this.messages.close();
  }
}

interface Harness {
  readonly fake: FakeQuery;
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Record<string, unknown>;
}

/** Install a query hook and capture what the adapter passed to it. */
function installQuery(): { harness: () => Harness } {
  let captured: Harness | undefined;
  sdkMock.onQuery = (params) => {
    const fake = new FakeQuery();
    captured = {
      fake,
      prompt: params.prompt as AsyncIterable<SDKUserMessage>,
      options: (params.options ?? {}) as Record<string, unknown>,
    };
    return fake;
  };
  return {
    harness: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured;
    },
  };
}

const BASE_INPUT: ResolvedRunInput = {
  runId: 'run-1',
  providerId: 'claude',
  profileId: 'prof-1',
  cwd: '/Users/dev/project',
  prompt: 'refactor the parser',
  env: { ANTHROPIC_API_KEY: 'sk-ant-profile', CLAUDE_CONFIG_DIR: '/app/profiles/work' },
};

const INIT_MESSAGE = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  cwd: '/Users/dev/project',
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
  uuid: 'uuid-init',
} as unknown as SDKMessage;

const RESULT_MESSAGE = {
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
  uuid: 'uuid-result',
  session_id: 'sess-abc',
} as unknown as SDKMessage;

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * A working directory that exists on the machine running the tests.
 *
 * `BASE_INPUT.cwd` is `/Users/dev/project`, which is fine everywhere the cwd is
 * only ever passed through to the (mocked) SDK — but the adapter now *stats*
 * the directory when a run fails to launch, in order to tell "the binary is
 * missing" apart from "the folder is not there". Tests about the former need a
 * folder that is really there.
 */
const REAL_CWD = process.cwd();

/** A directory that certainly does not exist. */
const MISSING_CWD = '/artemis-tests/no-such-directory/at-all';

/* -------------------------------------------------------------------------- */
/* Run lifecycle                                                              */
/* -------------------------------------------------------------------------- */

describe('run lifecycle', () => {
  it('streams mapped events and terminates on run.end', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(events[0]?.type).toBe('session.started');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed', sessionId: 'sess-abc' });
    expect(run.status).toBe('ended');
    expect(run.sessionId).toBe('sess-abc');
  });

  it('buffers events produced before anyone subscribes', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    // Let the pump run to completion with no consumer attached at all.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = await drain(run.events);
    expect(events.map((e) => e.type)).toEqual(['session.started', 'usage', 'run.end']);
  });

  it('is consumable exactly once', async () => {
    installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    run.events[Symbol.asyncIterator]();
    expect(() => run.events[Symbol.asyncIterator]()).toThrow(/only be consumed once/);
    await run.dispose();
  });

  it('hands agentToolServers the run input, and its servers to the SDK', async () => {
    // Which tools a run gets is the input's to say — a run browsing with the
    // user's own Chrome must not also carry the embedded browser — so the
    // factory sees the same input the run was started with, not just its id.
    const { harness } = installQuery();
    const seen: { runId: string; chromeBrowser?: boolean }[] = [];
    const marker = { type: 'sdk', name: 'artemis-browser' } as never;
    const adapter = createClaudeAdapter({
      agentToolServers: (runId, input) => {
        seen.push({ runId, ...(input.chromeBrowser === undefined ? {} : { chromeBrowser: input.chromeBrowser }) });
        return { artemisBrowser: marker };
      },
    });

    const run = await adapter.createRun({ ...BASE_INPUT, chromeBrowser: true });

    expect(seen).toEqual([{ runId: 'run-1', chromeBrowser: true }]);
    expect((harness().options.mcpServers as Record<string, unknown>).artemisBrowser).toBe(marker);
    await run.dispose();
  });

  it('passes no mcpServers when the factory declines', async () => {
    // `undefined` from the factory means "this run gets nothing from the
    // host" — the Chrome-bridge case. An empty object here instead would still
    // establish the MCP plumbing in the SDK.
    const { harness } = installQuery();
    const adapter = createClaudeAdapter({ agentToolServers: () => undefined });

    const run = await adapter.createRun({ ...BASE_INPUT, chromeBrowser: true });

    expect(harness().options.mcpServers).toBeUndefined();
    await run.dispose();
  });

  it('reports a transport failure as run.end rather than rejecting the stream', async () => {
    const { harness } = installQuery();
    // A cwd that really exists, so the launch-failure diagnosis below confirms
    // the directory is fine and leaves the provider's own classification alone.
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    harness().fake.messages.fail(new Error('spawn claude ENOENT'));

    const events = await drain(run.events);
    const end = events.at(-1) as RunEndEvent;
    expect(end).toMatchObject({ type: 'run.end', reason: 'error' });
    expect(end.error?.code).toBe('provider_not_found');
  });

  it('ends the run when query() itself cannot start', async () => {
    sdkMock.onQuery = () => {
      throw new Error('spawn claude ENOENT');
    };
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    const events = await drain(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'run.end', reason: 'error' });
  });

  it('walks through starting → running → ended', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    expect(run.status).toBe('starting');

    const { fake } = harness();
    const iterator = run.events[Symbol.asyncIterator]();
    fake.messages.push(INIT_MESSAGE);
    await iterator.next();
    expect(run.status).toBe('running');

    fake.messages.push(RESULT_MESSAGE);
    await iterator.next();
    await iterator.next();
    expect(run.status).toBe('ended');
  });
});

/* -------------------------------------------------------------------------- */
/* Streaming input                                                            */
/* -------------------------------------------------------------------------- */

describe('streaming input', () => {
  it('seeds the prompt iterable with the initial message', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);

    const iterator = harness().prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'refactor the parser' },
      parent_tool_use_id: null,
    });
    await run.dispose();
  });

  it('send() pushes into the live prompt iterable', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    const result = await run.send('actually, use a lexer');
    // The text reaches the CLI immediately, but whether it steers the running
    // turn or becomes a queued turn this run will never execute is the
    // provider's decision. `false` is the only answer that is true either way.
    expect(result.deliveredImmediately).toBe(false);

    const second = await iterator.next();
    expect(second.value).toMatchObject({ message: { content: 'actually, use a lexer' } });
    await run.dispose();
  });

  /**
   * Images.
   *
   * The shape matters more than it looks: `content` stays a plain string when
   * there are no images, because that is what the SDK writes to its session
   * `.jsonl` and what Artemis's own history reader parses back out.
   */
  describe('attachments', () => {
    const IMAGE = {
      kind: 'image',
      id: 'img-1',
      mediaType: 'image/png',
      data: 'aGVsbG8=',
    } as const;

    it('sends images as content blocks, ahead of the text', async () => {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun({
        ...BASE_INPUT,
        prompt: 'what is wrong here?',
        attachments: [IMAGE],
      });

      const iterator = harness().prompt[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toMatchObject({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
            { type: 'text', text: 'what is wrong here?' },
          ],
        },
      });
      await run.dispose();
    });

    it('keeps a plain string when there are no images', async () => {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, attachments: [] });

      const iterator = harness().prompt[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect((first.value as SDKUserMessage).message.content).toBe('refactor the parser');
      await run.dispose();
    });

    it('carries images on a mid-run send too', async () => {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun(BASE_INPUT);
      const iterator = harness().prompt[Symbol.asyncIterator]();
      await iterator.next();

      await run.send('and this one', [{ ...IMAGE, id: 'img-2' }]);
      const second = await iterator.next();
      expect((second.value as SDKUserMessage).message.content).toMatchObject([
        { type: 'image' },
        { type: 'text', text: 'and this one' },
      ]);
      await run.dispose();
    });

    it('sends a PDF as a document block and stages it as well', async () => {
      // Both, deliberately. The block is what gives the model vision over the
      // rendered pages — layout, tables, scanned text — which reading the file
      // with a tool does not recover; the staged copy lets the agent run
      // something over it. The staged PDF is *not* named in the note, because
      // pointing the agent at a file it can already see invites a wasted read.
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun({
        ...BASE_INPUT,
        prompt: 'summarise this',
        attachments: [
          { kind: 'file', id: 'f1', name: 'report.pdf', mediaType: 'application/pdf', data: 'aGk=' },
        ],
      });

      const iterator = harness().prompt[Symbol.asyncIterator]();
      const content = (await iterator.next()).value as SDKUserMessage;
      const blocks = content.message.content as { type: string; title?: string }[];

      expect(blocks[0]).toMatchObject({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'aGk=' },
        title: 'report.pdf',
      });
      const text = blocks.find((block) => block.type === 'text') as { text: string };
      expect(text.text).toBe('summarise this');
      await run.dispose();
    });

    it('names a staged file in the prompt, because nothing else tells the agent', async () => {
      // This sentence is the entire mechanism for non-image attachments.
      // Without it the file is on disk and nobody knows: the agent answers from
      // the prompt text alone and nothing reports that it was ignored.
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun({
        ...BASE_INPUT,
        prompt: 'what is in it?',
        attachments: [{ kind: 'file', id: 'f1', name: 'sales.csv', data: 'aGk=' }],
      });

      const iterator = harness().prompt[Symbol.asyncIterator]();
      const message = (await iterator.next()).value as SDKUserMessage;
      // A plain string, because a file adds no content blocks.
      const text = message.message.content as string;

      expect(text).toContain('sales.csv');
      expect(text).toMatch(/attached 1 file/);
      // The user's own words survive, after the note.
      expect(text.endsWith('what is in it?')).toBe(true);
      await run.dispose();
    });

    it('grants the staging directory so the agent may read what was staged', async () => {
      // Claude gates reads outside the working directory, so staging a file
      // without granting its directory produces the worst outcome available:
      // the agent reports that a file the user can see in the transcript does
      // not exist.
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun({
        ...BASE_INPUT,
        attachments: [{ kind: 'file', id: 'f1', name: 'sales.csv', data: 'aGk=' }],
      });

      const granted = harness().options['additionalDirectories'] as string[];
      expect(granted).toHaveLength(1);
      // The same directory the file was staged into.
      const iterator = harness().prompt[Symbol.asyncIterator]();
      const text = (await iterator.next()).value as SDKUserMessage;
      expect(String(text.message.content)).toContain(granted[0] ?? ' ');
      await run.dispose();
    });

    it('omits an empty text block, which the Messages API rejects', async () => {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun({
        ...BASE_INPUT,
        prompt: '',
        attachments: [IMAGE],
      });

      const iterator = harness().prompt[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect((first.value as SDKUserMessage).message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ]);
      await run.dispose();
    });
  });

  it('refuses to send once teardown has closed the prompt queue', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    // Do not await: dispose() closes the prompt queue immediately but only
    // marks the run ended after its grace waits. A send landing in that window
    // used to be pushed into a closed queue — a silent no-op — and still
    // reported success.
    const disposing = run.dispose();
    await expect(run.send('one more thing')).rejects.toThrow(/shutting down/);
    await disposing;
  });

  it('refuses to send into an ended run', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(run.send('too late')).rejects.toThrow(AdapterError);
    await expect(run.send('too late')).rejects.toThrow(/already ended/);
  });

  it('closes the prompt iterable on dispose so the provider stops waiting for input', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    await run.dispose();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Call the adapter's canUseTool exactly as the SDK would.
 *
 * Module scope rather than inside the permissions suite: the continuation suite
 * needs it too, because a prompt arriving after its turn ended is a permission
 * question asked through the same callback.
 */
function callCanUseTool(
  options: Record<string, unknown>,
  signal: AbortSignal,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const canUseTool = options['canUseTool'] as (
    toolName: string,
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<unknown>;
  return canUseTool(
    'Bash',
    { command: 'git status' },
    {
      signal,
      toolUseID: 'toolu_1',
      requestId: 'req_1',
      title: 'Claude wants to run git status',
      ...overrides,
    },
  );
}

describe('permissions', () => {
  it('emits permission.request and blocks until the answer arrives', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();
    harness().fake.messages.push(INIT_MESSAGE);
    await iterator.next();
    expect(run.status).toBe('running');

    const controller = new AbortController();
    const pending = callCanUseTool(harness().options, controller.signal);

    const event = (await iterator.next()).value as PermissionRequestEvent;
    expect(event.type).toBe('permission.request');
    expect(event.request).toMatchObject({
      toolName: 'Bash',
      toolCallId: 'toolu_1',
      title: 'Claude wants to run git status',
      input: { command: 'git status' },
    });
    expect(run.status).toBe('awaiting_permission');

    await run.respondToPermission(event.requestId, { behavior: 'allow', scope: 'session' });

    await expect(pending).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'toolu_1',
      decisionClassification: 'user_temporary',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash' }], destination: 'session' },
      ],
    });
    expect(run.status).toBe('running');
    await run.dispose();
  });

  it('forwards a denial with the SDK-required message', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    const pending = callCanUseTool(harness().options, new AbortController().signal);
    const event = (await iterator.next()).value as PermissionRequestEvent;
    await run.respondToPermission(event.requestId, { behavior: 'deny' });

    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'The user declined this tool call.',
      decisionClassification: 'user_reject',
    });
    await run.dispose();
  });

  it('rejects an unknown or double answer instead of silently succeeding', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    await expect(run.respondToPermission('nope', { behavior: 'allow' })).rejects.toThrow(
      /No outstanding permission request/,
    );

    const pending = callCanUseTool(harness().options, new AbortController().signal);
    const event = (await iterator.next()).value as PermissionRequestEvent;
    await run.respondToPermission(event.requestId, { behavior: 'allow' });
    await expect(run.respondToPermission(event.requestId, { behavior: 'allow' })).rejects.toThrow(
      AdapterError,
    );
    await pending;
    await run.dispose();
  });

  it('denies — never returns null — when the run is torn down mid-prompt', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    const pending = callCanUseTool(harness().options, new AbortController().signal);
    await iterator.next();

    await run.dispose();

    const result = await pending;
    // Returning null would leave the tool blocked forever: no control response
    // is written and permission prompts have no park deadline.
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ behavior: 'deny' });
  });

  it('denies immediately when the provider withdraws the request', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();

    const controller = new AbortController();
    const pending = callCanUseTool(harness().options, controller.signal);
    await iterator.next();
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'The provider withdrew this tool call.',
    });
    await run.dispose();
  });

  it('denies without ever emitting a prompt once the run has ended', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, options } = harness();
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(callCanUseTool(options, new AbortController().signal)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('ends the run as permission_denied when a denial interrupts it', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, options } = harness();
    const iterator = run.events[Symbol.asyncIterator]();

    const pending = callCanUseTool(options, new AbortController().signal);
    const event = (await iterator.next()).value as PermissionRequestEvent;
    await run.respondToPermission(event.requestId, { behavior: 'deny', interrupt: true });
    await pending;

    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['stopped'],
    } as unknown as SDKMessage);

    let end: AgentEvent | undefined;
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      end = next.value;
    }
    expect(end).toMatchObject({ type: 'run.end', reason: 'permission_denied' });
  });
});

/* -------------------------------------------------------------------------- */
/* Interrupt and dispose                                                      */
/* -------------------------------------------------------------------------- */

describe('interrupt', () => {
  /**
   * The receipt, answered in the ids the caller uses.
   *
   * `still_queued` is a list of the CLI's own uuids, and a caller holding rows
   * on screen cannot do anything with those. It can only be translated because
   * the adapter now stamps the uuid itself when it is given a `messageId` —
   * which is also what puts the message in the CLI's *named* queue at all: the
   * receipt lists uuid-stamped messages, and until this the app's own steers
   * carried no uuid and so could never appear on one.
   *
   * Ids that cannot be placed are dropped rather than passed through, on the
   * SDK's own advice: the list may name messages this client never sent — a
   * cron trigger, an auto-resume continuation — and a caller matching those
   * against its transcript would find nothing and be unable to tell that from
   * a bug.
   */
  it('names the messages it sent, and drops the ids it cannot place', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, prompt } = harness();
    const reader = prompt[Symbol.asyncIterator]();
    await reader.next(); // the opening prompt

    await run.send('and check the tests', undefined, 'run-1:prompt:2');
    const sent = (await reader.next()).value as SDKUserMessage;
    const uuid = sent.uuid;
    expect(typeof uuid).toBe('string');

    fake.interruptImpl = () =>
      Promise.resolve({ still_queued: [uuid as string, 'a-cron-trigger'] });

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: ['run-1:prompt:2'] });
    expect(fake.interruptCalls).toBe(1);
    await run.dispose();
  });

  it('has nothing to report for a message the caller never named', async () => {
    // No `messageId` on the send: the caller did not ask to hear about this
    // one, so nothing is tracked and the receipt has no id to translate.
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();
    await run.send('and check the tests');
    fake.interruptImpl = () => Promise.resolve({ still_queued: ['msg-2', 'msg-3'] });

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: [] });
    await run.dispose();
  });

  it('reports reason "interrupted" even though the provider says it errored', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    await run.interrupt();
    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['aborted'],
      terminal_reason: 'aborted_streaming',
    } as unknown as SDKMessage);

    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'interrupted' });
  });

  it('is a no-op on a run that already ended', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: [] });
    expect(harness().fake.interruptCalls).toBe(0);
  });

  it('falls back to a hard teardown when the control channel never answers', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();
    fake.interruptImpl = () => Promise.reject(new Error('control channel closed'));

    await expect(run.interrupt()).resolves.toEqual({ stillQueued: [] });
    await run.dispose();
    const events = await drain(run.events);
    expect(events.at(-1)?.type).toBe('run.end');
  });
});

describe('dispose', () => {
  it('emits run.end even when the provider never sent a result', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(INIT_MESSAGE);

    await run.dispose();
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'disposed' });
  });

  it('is idempotent under concurrent and repeated calls', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);

    await Promise.all([run.dispose(), run.dispose(), run.dispose()]);
    await run.dispose();

    const events = await drain(run.events);
    expect(events.filter((e) => e.type === 'run.end')).toHaveLength(1);
    expect(harness().fake.closed).toBe(true);
  });

  it('cancels open tool calls before the terminal event', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push({
      type: 'assistant',
      uuid: 'uuid-a',
      session_id: 'sess-abc',
      parent_tool_use_id: null,
      message: {
        id: 'msg_01',
        role: 'assistant',
        type: 'message',
        model: 'claude-opus-4',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
      },
    } as unknown as SDKMessage);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await run.dispose();

    const events = await drain(run.events);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['tool.start', 'tool.end', 'run.end']);
    expect(events[1]).toMatchObject({ status: 'cancelled' });
  });

  it('tears the run down when an external abort signal fires', async () => {
    const { harness } = installQuery();
    const controller = new AbortController();
    const run = await createClaudeAdapter().createRun({
      ...BASE_INPUT,
      abortSignal: controller.signal,
    });
    harness().fake.messages.push(INIT_MESSAGE);

    controller.abort();
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'disposed' });
  });

  it('ends immediately when the abort signal was already aborted', async () => {
    installQuery();
    const run = await createClaudeAdapter().createRun({
      ...BASE_INPUT,
      abortSignal: AbortSignal.abort(),
    });
    const events = await drain(run.events);
    expect(events).toEqual([expect.objectContaining({ type: 'run.end', reason: 'disposed' })]);
  });
});

/* -------------------------------------------------------------------------- */
/* Launch failures                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The misleading-error bug, from the adapter's side.
 *
 * `spawn` raises `ENOENT` both for a missing executable and for a missing
 * `cwd`, and the SDK guesses the first — reporting, on macOS, that its native
 * binary "exists but failed to launch" because it "does not match this
 * system's libc". The adapter's job here is to check which it actually was and
 * say so, without discarding what the provider reported.
 */
describe('a run that never launches', () => {
  const endOf = (events: AgentEvent[]): RunEndEvent => events.at(-1) as RunEndEvent;

  const SDK_LIBC_MESSAGE =
    'Claude Code native binary at /opt/claude exists but failed to launch. This usually means ' +
    "the binary does not match this system's libc — e.g. spawning a musl-linked binary on a " +
    'glibc Linux host.';

  it('blames the working directory when that is what is actually wrong', async () => {
    sdkMock.onQuery = () => {
      throw new Error(SDK_LIBC_MESSAGE);
    };

    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    const end = endOf(await drain(run.events));

    expect(end.reason).toBe('error');
    // Re-classified: this is a bad request, not a missing provider.
    expect(end.error?.code).toBe('invalid_request');
    // The headline is the directory, and it names the path.
    expect(end.error?.message).toContain(`That directory does not exist: ${MISSING_CWD}`);
    // …and the provider's own words survive underneath. Wrapped, not swallowed:
    // if the diagnosis is ever wrong, this is the only way anyone finds out.
    expect(end.error?.message).toContain('exists but failed to launch');
  });

  it('does the same for a failure that arrives on the event stream', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    harness().fake.messages.fail(new Error(SDK_LIBC_MESSAGE));

    const end = endOf(await drain(run.events));
    expect(end.error?.code).toBe('invalid_request');
    expect(end.error?.message).toContain(MISSING_CWD);
  });

  it('names the working directory even when the directory is fine', async () => {
    // The genuinely-missing-binary case. Nothing is re-classified, but the cwd
    // is still stated, so the next report of this failure does not have to
    // guess at it.
    sdkMock.onQuery = () => {
      throw new Error(SDK_LIBC_MESSAGE);
    };

    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    const end = endOf(await drain(run.events));

    expect(end.error?.code).toBe('provider_not_found');
    expect(end.error?.message).toContain('exists but failed to launch');
    expect(end.error?.message).toContain(`(working directory: ${REAL_CWD})`);
  });

  it('leaves a failure that is not about launching alone', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    const overloaded = Object.assign(new Error('Overloaded'), { status: 529 });
    harness().fake.messages.fail(overloaded);

    const end = endOf(await drain(run.events));
    // A bad cwd is real here, but it is not what went wrong, and inventing a
    // directory problem for every failure would be its own misdiagnosis.
    expect(end.error?.code).toBe('provider_unavailable');
    expect(end.error?.message).toBe('Overloaded');
  });

  it('still ends the run exactly once, with the stream terminating', async () => {
    sdkMock.onQuery = () => {
      throw new Error('spawn claude ENOENT');
    };

    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: MISSING_CWD });
    const events = await drain(run.events);

    expect(events.filter((event) => event.type === 'run.end')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(run.status).toBe('ended');
  });
});

/* -------------------------------------------------------------------------- */
/* Input validation                                                           */
/* -------------------------------------------------------------------------- */

describe('createRun validation', () => {
  it('rejects a relative working directory', async () => {
    installQuery();
    await expect(
      createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: 'relative/path' }),
    ).rejects.toThrow(/absolute path/);
  });

  it('rejects an unsupported permission mode instead of downgrading it', async () => {
    installQuery();
    const promise = createClaudeAdapter().createRun({
      ...BASE_INPUT,
      permissionMode: 'nonsense' as never,
    });
    await expect(promise).rejects.toThrow(/does not support the permission mode/);
    await promise.catch((error: unknown) => {
      expect(toAgentError(error).code).toBe('invalid_request');
    });
  });

  it('rejects forkSession with nothing to fork from', async () => {
    installQuery();
    await expect(
      createClaudeAdapter().createRun({ ...BASE_INPUT, forkSession: true }),
    ).rejects.toThrow(/requires resumeSessionId/);
  });

  // The SDK would resolve it against the run's `cwd`, so the same value would
  // name a different directory in every repository and find nothing in most of
  // them — a skill that is quietly absent.
  it('rejects a relative plugin path', async () => {
    installQuery();
    await expect(
      createClaudeAdapter().createRun({ ...BASE_INPUT, plugins: [{ path: 'skill-bridges/work' }] }),
    ).rejects.toThrow(/Plugin path must be absolute/);
  });

  it('accepts every mode the capability descriptor advertises', async () => {
    installQuery();
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const) {
      const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, permissionMode: mode });
      await run.dispose();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Option construction                                                        */
/* -------------------------------------------------------------------------- */

describe('buildClaudeOptions', () => {
  const context = {
    canUseTool: (async () => ({ behavior: 'deny', message: 'x' })) as never,
    abortController: new AbortController(),
    stderr: () => undefined,
    hostEnv: {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-from-the-users-shell',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CONFIG_DIR: '/Users/dev/.claude',
    },
  };

  it('inherits no filesystem settings by default', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).settingSources).toEqual([]);
  });

  it('honours an explicit opt-in', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, settingSources: ['project'] },
      context,
    );
    expect(options.settingSources).toEqual(['project']);
  });

  /*
   * The channel the user's skills arrive on, and the reason it is a separate
   * knob: plugin discovery does not go through `settingSources`, so this is the
   * one way a skill reaches a session that inherits no settings at all.
   */
  it('passes skill plugins through while inheriting no settings', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, plugins: [{ path: '/app/skill-bridges/work' }] },
      context,
    );
    expect(options.plugins).toEqual([{ type: 'local', path: '/app/skill-bridges/work' }]);
    expect(options.settingSources).toEqual([]);
  });

  // Not `[]`: an empty array still initialises the SDK's plugin machinery, so a
  // run with no skills has to be byte-identical to one from before the option
  // existed.
  it('omits plugins entirely when there are none', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).plugins).toBeUndefined();
    expect(buildClaudeOptions({ ...BASE_INPUT, plugins: [] }, context).plugins).toBeUndefined();
  });

  it('gives the provider the profile’s credentials, not the shell’s', () => {
    const env = buildClaudeOptions(BASE_INPUT, context).env ?? {};
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-profile');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/app/profiles/work');
    // An api-key profile: the subscription token in the shell is not the
    // profile's choice, so it does not travel.
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['CLAUDE_AGENT_SDK_CLIENT_APP']).toBe('artemis');
  });

  it('BILLING: a subscription bundle reaches the SDK with no ANTHROPIC_API_KEY, even one inherited from the shell', () => {
    // End of the chain: `resolveEnv` already refuses to emit an API key in
    // subscription mode, and this is the last place the shell could put one
    // back. `context.hostEnv` deliberately contains one.
    const env =
      buildClaudeOptions(
        {
          ...BASE_INPUT,
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-profile-token',
            CLAUDE_CONFIG_DIR: '/app/profiles/work',
          },
        },
        context,
      ).env ?? {};

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-profile-token');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/app/profiles/work');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('turns partial messages on unless the caller opts out', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).includePartialMessages).toBe(true);
    expect(
      buildClaudeOptions({ ...BASE_INPUT, includePartialMessages: false }, context)
        .includePartialMessages,
    ).toBe(false);
  });

  // The CLI defaults an SDK-driven session's thinking display to `omitted`,
  // which returns every thinking block as a signature beside empty text —
  // nothing a transcript can show. Every run overrides it; see the note on
  // `extraArgs` in `buildClaudeOptions`.
  it('always asks for reasoning the transcript can display', () => {
    const args = buildClaudeOptions(BASE_INPUT, context).extraArgs ?? {};
    expect(args['thinking-display']).toBe('summarized');
  });

  it('maps resume and fork', () => {
    const plain = buildClaudeOptions(BASE_INPUT, context);
    expect(plain.resume).toBeUndefined();
    expect(plain.forkSession).toBeUndefined();

    const forked = buildClaudeOptions(
      { ...BASE_INPUT, resumeSessionId: 'sess-old', forkSession: true },
      context,
    );
    expect(forked).toMatchObject({ resume: 'sess-old', forkSession: true });
  });

  it('ties the dangerous bypass flag to the mode the user actually picked', () => {
    expect(buildClaudeOptions(BASE_INPUT, context).allowDangerouslySkipPermissions).toBeUndefined();
    expect(
      buildClaudeOptions({ ...BASE_INPUT, permissionMode: 'acceptEdits' }, context)
        .allowDangerouslySkipPermissions,
    ).toBeUndefined();
    expect(
      buildClaudeOptions({ ...BASE_INPUT, permissionMode: 'bypassPermissions' }, context)
        .allowDangerouslySkipPermissions,
    ).toBe(true);
  });

  it('copies list options so a caller cannot mutate a live run', () => {
    const allowedTools = ['Read'];
    const options = buildClaudeOptions({ ...BASE_INPUT, allowedTools }, context);
    expect(options.tools).toEqual(['Read']);
    expect(options.tools).not.toBe(allowedTools);
  });

  it('maps allowedTools onto the SDK restriction knob, not its auto-approve list', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, allowedTools: ['Read', 'Grep'] },
      context,
    );
    // `Options.allowedTools` auto-approves without prompting and leaves the
    // full default tool set in place — the opposite of what the caller asked
    // for. `Options.tools` is what narrows the available tools.
    expect(options.tools).toEqual(['Read', 'Grep']);
    expect(options.allowedTools).toBeUndefined();
  });

  it('leaves the tool set alone when no allow-list was given', () => {
    const options = buildClaudeOptions(BASE_INPUT, context);
    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
  });

  it('sends the claude_code preset when the run named no system prompt', () => {
    // The default path for every Artemis run: `RunInput.systemPrompt` is optional
    // and the renderer never sets it. Passing `undefined` through would ship an
    // empty system prompt and silently lose the whole Claude Code preset.
    expect(buildClaudeOptions(BASE_INPUT, context).systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('passes budgets, turn limits and the run title through', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, maxTurns: 12, maxBudgetUsd: 2.5, title: 'Parser work', model: 'claude-opus-4', fallbackModel: 'claude-sonnet-4' },
      context,
    );
    expect(options).toMatchObject({
      maxTurns: 12,
      maxBudgetUsd: 2.5,
      title: 'Parser work',
      model: 'claude-opus-4',
      fallbackModel: 'claude-sonnet-4',
    });
  });

  it('asks the CLI for the Chrome bridge as a bare --chrome flag', () => {
    // The bridge has no SDK option; `extraArgs: {chrome: null}` is the SDK's
    // spelling of a valueless flag. Anything else — `true`, `'true'` — would
    // reach the CLI as `--chrome true` and be read as a positional argument.
    const options = buildClaudeOptions({ ...BASE_INPUT, chromeBrowser: true }, context);
    expect(options.extraArgs).toEqual({ 'thinking-display': 'summarized', chrome: null });
  });

  it('keeps the Chrome flag out when the bridge was not asked for', () => {
    // The flag loads the whole `claude-in-chrome` tool set into context every
    // turn, and the CLI reads an absent flag as off — so a run that never
    // asked must not carry it. The thinking display is the one flag every run
    // carries.
    expect(buildClaudeOptions(BASE_INPUT, context).extraArgs).toEqual({
      'thinking-display': 'summarized',
    });
    expect(
      buildClaudeOptions({ ...BASE_INPUT, chromeBrowser: false }, context).extraArgs,
    ).toEqual({ 'thinking-display': 'summarized' });
  });
});

describe('mapSystemPrompt', () => {
  it('treats an absent spec as the provider preset, not as no prompt', () => {
    // Omitting `systemPrompt` does NOT mean "let the CLI use its default". The
    // SDK normalises undefined to the empty string and sends it as an explicit
    // custom prompt, which overrides the preset — so every default run would
    // start with no Claude Code system prompt at all.
    expect(mapSystemPrompt(undefined)).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('keeps the provider preset for default and append', () => {
    expect(mapSystemPrompt({ kind: 'default' })).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(mapSystemPrompt({ kind: 'append', text: 'Use tabs.' })).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Use tabs.',
    });
  });

  it('replaces it wholesale only when asked to', () => {
    expect(mapSystemPrompt({ kind: 'replace', text: 'You are terse.' })).toBe('You are terse.');
  });
});

/* -------------------------------------------------------------------------- */
/* Session listing                                                            */
/* -------------------------------------------------------------------------- */

describe('listSessions', () => {
  it('scopes the listing to the profile’s config directory and restores the environment', async () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    let seenConfigDir: string | undefined;
    let seenOptions: Record<string, unknown> | undefined;

    sdkMock.onListSessions = (options) => {
      seenConfigDir = process.env['CLAUDE_CONFIG_DIR'];
      seenOptions = options as Record<string, unknown>;
      return Promise.resolve([
        { sessionId: 's1', summary: 'One', lastModified: 3 },
        { sessionId: 's2', summary: 'Two', lastModified: 2 },
        { sessionId: 's3', summary: 'Three', lastModified: 1 },
      ]);
    };

    const adapter = createClaudeAdapter();
    const page = await adapter.listSessions?.({
      profileId: 'prof-1',
      cwd: '/Users/dev/project',
      env: { CLAUDE_CONFIG_DIR: '/app/profiles/work' },
      limit: 2,
      offset: 0,
    });

    expect(seenConfigDir).toBe('/app/profiles/work');
    // Over-fetch by one so `hasMore` is a fact, not a guess.
    expect(seenOptions).toMatchObject({ dir: '/Users/dev/project', limit: 3, offset: 0 });
    expect(page?.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(page?.hasMore).toBe(true);
    expect(page?.sessions[0]).toMatchObject({ providerId: 'claude', profileId: 'prof-1', cwd: '/Users/dev/project' });
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });

  it('restores the environment even when the listing throws', async () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    sdkMock.onListSessions = () => Promise.reject(new Error('permission denied'));

    const adapter = createClaudeAdapter();
    await expect(
      adapter.listSessions?.({ profileId: 'p', cwd: '/w', env: { CLAUDE_CONFIG_DIR: '/app/x' } }),
    ).rejects.toThrow(/Could not read Claude session history/);

    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });

  it('reports hasMore false when the page was not filled', async () => {
    sdkMock.onListSessions = () =>
      Promise.resolve([{ sessionId: 's1', summary: 'One', lastModified: 1 }]);

    const page = await createClaudeAdapter().listSessions?.({
      profileId: 'p',
      cwd: '/w',
      env: {},
      limit: 10,
    });
    expect(page?.hasMore).toBe(false);
    expect(page?.sessions).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Aggregated session listing                                                 */
/* -------------------------------------------------------------------------- */

describe('listAllSessions', () => {
  /** A profile's config directory, as `resolveStoreEnv` would produce it. */
  const scope = (profileId: string, configDir: string) => ({
    profileId,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });

  it('walks every profile’s config directory and stamps the profile it found each session in', async () => {
    const seen: Array<{ configDir: string | undefined; options: unknown }> = [];

    sdkMock.onListSessions = (options) => {
      const configDir = process.env['CLAUDE_CONFIG_DIR'];
      seen.push({ configDir, options });
      return Promise.resolve(
        configDir === '/app/profiles/work'
          ? [{ sessionId: 'w1', summary: 'Work', lastModified: 2, cwd: '/repos/api' }]
          : [{ sessionId: 'p1', summary: 'Personal', lastModified: 5, cwd: '/repos/blog' }],
      );
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('work', '/app/profiles/work'), scope('home', '/app/profiles/home')],
    });

    // One call per *store*, which for two ordinary profiles is one per
    // profile, each with its own config directory swapped in and no `dir` —
    // the SDK enumerates every project itself.
    expect(seen.map((call) => call.configDir)).toEqual([
      '/app/profiles/work',
      '/app/profiles/home',
    ]);
    expect(seen[0]?.options).toEqual({});

    // The profile is which store the session was found in, and that is what
    // lands on the summary. `alsoInProfiles` stays absent while stores are
    // private, so the ordinary payload is exactly the shape it always was.
    expect(result?.sessions).toEqual([
      expect.objectContaining({ id: 'p1', profileId: 'home', cwd: '/repos/blog' }),
      expect.objectContaining({ id: 'w1', profileId: 'work', cwd: '/repos/api' }),
    ]);
    expect(result?.sessions.every((s) => s.alsoInProfiles === undefined)).toBe(true);
    expect(result?.unreadableProfiles).toEqual([]);
  });

  it('takes cwd from the session, not from the encoded project directory name', async () => {
    // The encoding replaces every non-alphanumeric character with `-`, so
    // `/repos/my-app` and `/repos/my/app` share a directory name. Only the
    // session's own record can say which one this was.
    sdkMock.onListSessions = () =>
      Promise.resolve([
        { sessionId: 's1', summary: 'Hyphenated', lastModified: 1, cwd: '/repos/my-app' },
      ]);

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('work', '/app/profiles/work')],
    });

    expect(result?.sessions[0]?.cwd).toBe('/repos/my-app');
  });

  it('drops a session whose working directory cannot be recovered', async () => {
    // Nothing on disk to read it back out of either — `/app/profiles/work` does
    // not exist — so this is the residue after the recovery below has tried. A
    // guessed path would start an agent somewhere the user never worked.
    sdkMock.onListSessions = () =>
      Promise.resolve([
        { sessionId: 'good', summary: 'Has a cwd', lastModified: 2, cwd: '/repos/api' },
        { sessionId: 'orphan', summary: 'No cwd', lastModified: 1 },
        { sessionId: 'blank', summary: 'Blank cwd', lastModified: 1, cwd: '   ' },
      ]);

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('work', '/app/profiles/work')],
    });

    expect(result?.sessions.map((s) => s.id)).toEqual(['good']);
  });

  /**
   * The reported bug: a conversation that opened with an image disappeared.
   *
   * The SDK's summary pass takes `firstPrompt` from the first user record whose
   * content is a plain string and takes `cwd` from whatever record it settled on,
   * so an opening message carrying an attachment comes back with neither — and
   * the adapter used to drop the session on the spot. Real files here, because
   * the recovery is a read of a real store's layout.
   */
  describe('a session the provider reports without a directory', () => {
    const made: string[] = [];

    afterEach(() => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A store holding one transcript, laid out the way Claude lays them out. */
    function storeWith(sessionId: string, cwd: string): string {
      const configDir = mkdtempSync(join(tmpdir(), 'artemis-recover-'));
      made.push(configDir);
      const project = join(configDir, 'projects', '-Users-me-code-app');
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, `${sessionId}.jsonl`),
        [
          JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            cwd,
            message: {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
                { type: 'text', text: 'look at this' },
              ],
            },
          }),
        ].join('\n'),
      );
      return configDir;
    }

    it('reads the directory out of the transcript instead of dropping the row', async () => {
      const configDir = storeWith('imaged', '/Users/me/code/app');
      sdkMock.onListSessions = () =>
        Promise.resolve([
          { sessionId: 'plain', summary: 'Ordinary', lastModified: 2, cwd: '/repos/api' },
          // No `cwd`, and no `firstPrompt` either — the two go missing together.
          { sessionId: 'imaged', summary: 'Opened with a screenshot', lastModified: 1 },
        ]);

      const result = await createClaudeAdapter().listAllSessions?.({
        profiles: [scope('work', configDir)],
      });

      // Both rows, and the recovered one carries the real directory — so it
      // groups under its project and resumes where it ran, rather than being
      // visible-but-dead.
      expect(result?.sessions.map((s) => s.id)).toEqual(['plain', 'imaged']);
      expect(result?.sessions[1]).toEqual(
        expect.objectContaining({ id: 'imaged', cwd: '/Users/me/code/app', profileId: 'work' }),
      );
    });

    it('rides along on a shared store like any other row', async () => {
      const configDir = storeWith('imaged', '/Users/me/code/app');
      sdkMock.onListSessions = () =>
        Promise.resolve([{ sessionId: 'imaged', summary: 'No cwd', lastModified: 1 }]);

      const result = await createClaudeAdapter().listAllSessions?.({
        profiles: [scope('work', configDir), scope('personal', configDir)],
      });

      // Recovery happens after the split into own/shared, so a recovered
      // session has to come back with the same `alsoInProfiles` an ordinary one
      // would — otherwise resuming it switches the user's account.
      expect(result?.sessions).toHaveLength(1);
      expect(result?.sessions[0]?.alsoInProfiles).toEqual(['personal']);
    });
  });

  it('keeps going when one profile’s store cannot be read', async () => {
    // The property that matters: a profile with a deleted config directory
    // must not blank the whole sidebar.
    sdkMock.onListSessions = () => {
      const configDir = process.env['CLAUDE_CONFIG_DIR'];
      if (configDir === '/app/profiles/broken') {
        return Promise.reject(new Error('EACCES: permission denied'));
      }
      return Promise.resolve([
        { sessionId: 'ok1', summary: 'Fine', lastModified: 1, cwd: '/repos/api' },
      ]);
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [
        scope('broken', '/app/profiles/broken'),
        scope('healthy', '/app/profiles/healthy'),
      ],
    });

    expect(result?.sessions.map((s) => s.id)).toEqual(['ok1']);
    expect(result?.unreadableProfiles).toEqual(['broken']);
  });

  it('restores CLAUDE_CONFIG_DIR even when a profile throws', async () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    sdkMock.onListSessions = () => Promise.reject(new Error('boom'));

    await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('a', '/app/profiles/a'), scope('b', '/app/profiles/b')],
    });

    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });

  it('sorts newest first across profiles, tie-breaking on id for a stable list', async () => {
    sdkMock.onListSessions = () => {
      const configDir = process.env['CLAUDE_CONFIG_DIR'];
      return Promise.resolve(
        configDir === '/app/profiles/a'
          ? [
              { sessionId: 'a-old', summary: 'x', lastModified: 1, cwd: '/repos/one' },
              { sessionId: 'b-tie', summary: 'x', lastModified: 7, cwd: '/repos/one' },
            ]
          : [
              { sessionId: 'a-tie', summary: 'x', lastModified: 7, cwd: '/repos/two' },
              { sessionId: 'c-new', summary: 'x', lastModified: 9, cwd: '/repos/two' },
            ],
      );
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [scope('a', '/app/profiles/a'), scope('b', '/app/profiles/b')],
    });

    expect(result?.sessions.map((s) => s.id)).toEqual(['c-new', 'a-tie', 'b-tie', 'a-old']);
  });

  it('asks for no page — merging happens above it, so slicing cannot happen here', async () => {
    let seenOptions: unknown;
    sdkMock.onListSessions = (options) => {
      seenOptions = options;
      return Promise.resolve([]);
    };

    await createClaudeAdapter().listAllSessions?.({ profiles: [scope('a', '/app/a')] });

    // A per-profile limit would drop one profile's older sessions in favour of
    // another's newer ones before the two were ever compared.
    expect(seenOptions).toEqual({});
  });

  /**
   * Profiles that resolve to one store — the defect behind #79.
   *
   * Real directories, because the grouping is a `realpath` of the directory the
   * SDK walks and a fake path proves nothing about symlink resolution. Every
   * other test in this describe uses invented paths, which is precisely why
   * they never caught this: an unresolvable path falls back to itself and each
   * profile stays in its own group, so they exercise the private-store case
   * only.
   */
  describe('when profiles share a store', () => {
    const made: string[] = [];

    afterEach(() => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** A root `.claude` plus `count` profile dirs whose `projects` link into it. */
    function sharedStore(count: number): { root: string; profiles: string[] } {
      const base = mkdtempSync(join(tmpdir(), 'artemis-store-'));
      made.push(base);

      const root = join(base, 'root-claude');
      mkdirSync(join(root, 'projects'), { recursive: true });

      const profiles: string[] = [];
      for (let n = 0; n < count; n += 1) {
        const dir = join(base, `profile-${String(n)}`);
        mkdirSync(dir, { recursive: true });
        // Exactly what the shared-config script does: link `projects`, and
        // nothing else, so the credential stays per profile. A junction on
        // Windows, where a directory symlink is refused unprivileged; what the
        // grouping reads is the resolved target, which both spellings give.
        symlinkSync(
          join(root, 'projects'),
          join(dir, 'projects'),
          process.platform === 'win32' ? 'junction' : undefined,
        );
        profiles.push(dir);
      }
      return { root, profiles };
    }

    it('lists a shared session once and names the profiles that can reach it', async () => {
      const { profiles } = sharedStore(3);
      let calls = 0;
      sdkMock.onListSessions = () => {
        calls += 1;
        return Promise.resolve([
          { sessionId: 'shared', summary: 'One conversation', lastModified: 4, cwd: '/repos/api' },
        ]);
      };

      const result = await createClaudeAdapter().listAllSessions?.({
        profiles: [
          scope('work', profiles[0] ?? ''),
          scope('personal', profiles[1] ?? ''),
          scope('max', profiles[2] ?? ''),
        ],
      });

      // One row, not three. This is the bug: before the fix each profile
      // enumerated the same transcript and the sidebar rendered it per profile.
      expect(result?.sessions).toHaveLength(1);
      expect(result?.sessions[0]).toEqual(
        expect.objectContaining({ id: 'shared', profileId: 'work' }),
      );
      // The other two ride along so a caller can resume under either.
      expect(result?.sessions[0]?.alsoInProfiles).toEqual(['personal', 'max']);
      // And the store is read once rather than once per profile.
      expect(calls).toBe(1);
    });

    it('groups two profiles that simply name the same directory', async () => {
      const { root } = sharedStore(0);
      sdkMock.onListSessions = () =>
        Promise.resolve([{ sessionId: 's', summary: 'x', lastModified: 1, cwd: '/repos/api' }]);

      const result = await createClaudeAdapter().listAllSessions?.({
        profiles: [scope('a', root), scope('b', root)],
      });

      // No symlink involved — two profiles are allowed to name one configDir,
      // and that shares a store just as thoroughly.
      expect(result?.sessions).toHaveLength(1);
      expect(result?.sessions[0]?.alsoInProfiles).toEqual(['b']);
    });

    it('reports every profile in the group when the shared store cannot be read', async () => {
      const { profiles } = sharedStore(2);
      sdkMock.onListSessions = () => Promise.reject(new Error('EACCES: permission denied'));

      const result = await createClaudeAdapter().listAllSessions?.({
        profiles: [scope('work', profiles[0] ?? ''), scope('personal', profiles[1] ?? '')],
      });

      // Naming only the group's first profile would leave the other looking
      // like it had merely contributed nothing, when it is just as broken.
      expect(result?.unreadableProfiles).toEqual(['work', 'personal']);
    });

    it('keeps profiles with no store yet apart', async () => {
      const base = mkdtempSync(join(tmpdir(), 'artemis-store-'));
      made.push(base);
      const a = join(base, 'a');
      const b = join(base, 'b');
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });

      sdkMock.onListSessions = () => {
        const dir = process.env['CLAUDE_CONFIG_DIR'];
        return Promise.resolve([
          { sessionId: dir === a ? 'sa' : 'sb', summary: 'x', lastModified: 1, cwd: '/repos/api' },
        ]);
      };

      const result = await createClaudeAdapter().listAllSessions?.({
        profiles: [scope('a', a), scope('b', b)],
      });

      // Neither has a `projects` directory, so neither resolves. Collapsing
      // them on that basis would be wrong in the direction that matters: a
      // session written by one a moment later would come back under the other.
      expect(result?.sessions.map((s) => s.profileId).sort()).toEqual(['a', 'b']);
      expect(result?.sessions.every((s) => s.alsoInProfiles === undefined)).toBe(true);
    });
  });

  it('answers an empty profile list without touching the SDK', async () => {
    sdkMock.onListSessions = () => Promise.reject(new Error('should not be called'));

    const result = await createClaudeAdapter().listAllSessions?.({ profiles: [] });
    expect(result).toEqual({ sessions: [], unreadableProfiles: [] });
  });

  it('needs no credential — only the config directory is read out of the env', async () => {
    // `resolveStoreEnv` emits exactly this and no secret, so a profile that has
    // never had a key stored still lists its history.
    let seenApiKey: string | undefined;
    sdkMock.onListSessions = () => {
      seenApiKey = process.env['ANTHROPIC_API_KEY'];
      return Promise.resolve([]);
    };

    const result = await createClaudeAdapter().listAllSessions?.({
      profiles: [{ profileId: 'keyless', env: { CLAUDE_CONFIG_DIR: '/app/profiles/keyless' } }],
    });

    expect(result?.sessions).toEqual([]);
    expect(result?.unreadableProfiles).toEqual([]);
    // Nothing in this path sets one; whatever the host environment has is
    // untouched by the adapter.
    expect(seenApiKey).toBe(process.env['ANTHROPIC_API_KEY']);
  });
});

describe('checkAvailability', () => {
  it('is available on the platforms the SDK ships a runtime for', async () => {
    const availability = await createClaudeAdapter().checkAvailability?.();
    // The test runner is itself one of the supported platforms.
    expect(availability).toEqual({ available: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Keeping the process past the turn                                          */
/* -------------------------------------------------------------------------- */

/**
 * The defect: a turn ending closed the transport, and everything the process was
 * holding went with it. The `Agent` tool backgrounds by default and `Workflow` is
 * always async, so that is the ordinary case rather than an edge one.
 *
 * These assert on `fake.closed` — whether the SDK's `close()` was called — which
 * is the exact act that killed the work. Measured against the real SDK before
 * this was written: a `sleep 40` backgrounded in turn one was still running
 * seventeen seconds after that turn's `result` when `close()` was withheld.
 */
describe('a turn that ends while work is still running', () => {
  const tasksChanged = (tasks: readonly unknown[]) =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks,
      uuid: 'u-tasks',
      session_id: 'sess-abc',
    }) as unknown as SDKMessage;

  const toolStart = (name: string) =>
    ({
      type: 'assistant',
      message: {
        id: `msg-${name}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu-${name}`, name, input: {} }],
      },
      session_id: 'sess-abc',
      uuid: `u-${name}`,
    }) as unknown as SDKMessage;

  const busyTask = [{ task_id: 't1', task_type: 'local_bash', description: 'sleep 40' }];

  it('closes the transport when nothing is left running', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // The ordinary turn, unchanged: no background work, so the process goes.
    expect(fake.closed).toBe(true);
  });

  it('reports the conversation as holding work, so a window can be told', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busyTask));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    /*
     * The turn is over and the work is not. This is the interval a window
     * cannot see into: `background.tasks` is run-scoped, so nothing more will be
     * emitted about `t1` until some turn opens, while the process is kept alive
     * for exactly it. Everything a window decides from its own rows in here —
     * the sidebar's marker, and whether the column may be destroyed — is a guess
     * unless it can ask this.
     */
    expect(run.status).toBe('ended');
    expect(adapter.sessionsHoldingWork?.()).toEqual(['sess-abc']);
  });

  it('goes on reporting it through the settle grace, deliberately', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busyTask));
    // The empty set is the authoritative "nothing is running any more" — see
    // `BackgroundTasksEvent` — but it lands about a tenth of a second *before*
    // the provider's own turn about the work that finished, so the process is
    // held for a beat rather than released under that turn. See
    // `SETTLE_GRACE_MS`.
    fake.messages.push(tasksChanged([]));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    /*
     * Still reported, and that is the right answer rather than a lag to be
     * corrected. The settle turn is the single most valuable thing the user is
     * waiting for — it is the message that says what the work came to — and a
     * window told "finished" here could retire the column it is about to land
     * in. Erring towards "still working" costs a pane held two seconds longer.
     */
    expect(adapter.sessionsHoldingWork?.()).toEqual(['sess-abc']);
  });

  it('reports nothing for a conversation that never delegated anything', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    expect(adapter.sessionsHoldingWork?.()).toEqual([]);
  });

  /*
   * The retention set and the working set part ways on exactly one thing: a
   * registered schedule. Retention keeps that process forever — nothing tells
   * the adapter when a wakeup fires — but between wakeups the conversation is
   * idle, and the sidebar drew its working marker from the retention set. The
   * result was a permanent spinner on every conversation that had ever run a
   * `/loop`, which read as "working" for sessions that were plainly done.
   */
  it('holds a scheduled conversation without calling it working', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(toolStart('ScheduleWakeup'));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // Retained — a wakeup may fire at any time and needs this process…
    expect(adapter.sessionsHoldingWork?.()).toEqual(['sess-abc']);
    // …and idle, because nothing is running until one does.
    expect(adapter.sessionsWorking?.()).toEqual([]);
  });

  it('calls a conversation with a live background task working', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busyTask));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    expect(adapter.sessionsWorking?.()).toEqual(['sess-abc']);
  });

  it('calls an open turn working, even one no window started', async () => {
    // A scheduled wakeup fires between reloads: the turn is real, and no
    // pane's own state can know about it. Main's working set is the one place
    // it is visible from.
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(adapter.sessionsWorking?.()).toEqual(['sess-abc']);
    await run.dispose();
  });

  it('keeps it open while a background task is live', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'local_bash', description: 'sleep 40' }]),
    );
    fake.messages.push(RESULT_MESSAGE);

    // The turn still ends properly — this is what the caller sees, and it is
    // unchanged. What changed is what happens to the transport underneath it.
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    expect(run.status).toBe('ended');

    expect(fake.closed).toBe(false);
  });

  it('reports the tasks as rows, merged from every message about them', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busyTask));
    fake.messages.push({
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'sleep 40',
      subagent_type: 'Explore',
      usage: { total_tokens: 24_100, tool_uses: 7, duration_ms: 12_000 },
      last_tool_name: 'Grep',
      uuid: 'u-prog',
      session_id: 'sess-abc',
    } as unknown as SDKMessage);
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    const sets = events.filter((e) => e.type === 'background.tasks');

    // One per change, each carrying the whole set — and the last one has the
    // detail the level never carried, which is the point of the ledger.
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(sets.at(-1)).toMatchObject({
      tasks: [
        {
          id: 't1',
          description: 'sleep 40',
          status: 'running',
          subagentType: 'Explore',
          lastToolName: 'Grep',
          totalTokens: 24_100,
          toolUses: 7,
        },
      ],
    });
  });

  it('keeps the sequence dense while it does so', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busyTask));
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    // A row set takes its turn in the run's own numbering. A gap is what the
    // transcript reads as events dropped in transit.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('survives the registry letting go of the finished turn', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busyTask));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    /*
     * What the run registry does at the end of every run, and the reason
     * `release` exists at all: it used to call `dispose`, which is the one act
     * that overrules retention, so the work kept alive above was killed one
     * layer up instead — with every adapter test still passing, because none of
     * them goes through the registry.
     */
    await run.release?.();

    expect(fake.closed).toBe(false);
  });

  it('closes it once the last task settles', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'local_bash', description: 'sleep 40' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    expect(fake.closed).toBe(false);

    /*
     * Replace semantics: an empty set is the provider saying nothing is running.
     * It does not release the process on its own, though — measured, the provider
     * takes a turn about the work that just finished roughly a tenth of a second
     * later, and closing the transport on the empty set killed exactly that turn.
     * So the release happens at the end of the turn that follows.
     */
    fake.messages.push(tasksChanged([]));
    expect(fake.closed).toBe(false);

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await vi.waitFor(() => expect(fake.closed).toBe(true));
  });

  it('releases the process when a task settles and no turn follows', async () => {
    // The other half of that rule: a task that settles in silence must not pin a
    // CLI open for the rest of the session. Only `setTimeout` is faked — the
    // pump's own promises stay real, so this is the grace expiring rather than a
    // rewritten event order.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun(BASE_INPUT);
      const { fake } = harness();

      fake.messages.push(INIT_MESSAGE);
      fake.messages.push(tasksChanged(busyTask));
      fake.messages.push(RESULT_MESSAGE);
      await drain(run.events);

      fake.messages.push(tasksChanged([]));
      await vi.waitFor(() => expect(fake.closed).toBe(false));

      await vi.advanceTimersByTimeAsync(2_500);
      expect(fake.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps it open after a scheduling tool has been called', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    // A cron job lives *inside* the process and fires only while it is idle —
    // which is a window a per-turn process never has. There is no control
    // request that asks a CLI what schedules it holds, so the call that
    // registered it is the only evidence there is.
    fake.messages.push(toolStart('CronCreate'));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    expect(fake.closed).toBe(false);
  });

  it('does not keep it open for an ordinary tool call', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(toolStart('Bash'));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // The set is explicit rather than a pattern, so a tool that schedules
    // nothing cannot pin a process open for the rest of the conversation.
    expect(fake.closed).toBe(true);
  });

  it('still closes on dispose, whatever it is holding', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'subagent', description: 'audit the mapper' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    expect(fake.closed).toBe(false);

    await run.dispose();

    // Dropping the conversation is the escape hatch, and it has to win over
    // retention or a wedged process would have nothing that ends it.
    expect(fake.closed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The next turn joins a process that is still running                        */
/* -------------------------------------------------------------------------- */

/**
 * Attaching is not an optimisation, it is what stops a correctness failure.
 *
 * Once a process can outlive its turn, a fresh spawn for the next message would
 * put two CLIs on one conversation — both appending to the same
 * `projects/…/<id>.jsonl`, with the second `--resume`ing a file the first is
 * still writing. Every case here is about which of those two happened.
 *
 * `installQuery` captures the *latest* harness, so a second `query()` call is
 * visible as a second harness object; a turn that attached leaves the first one
 * in place.
 */
describe('attaching to a live process', () => {
  const tasksChanged = (tasks: readonly unknown[]) =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks,
      uuid: 'u-tasks',
      session_id: 'sess-abc',
    }) as unknown as SDKMessage;

  const busy = [{ task_id: 't1', task_type: 'local_bash', description: 'sleep 40' }];

  /** Turn one, left holding a background task so its process stays. */
  async function firstTurn(over?: Partial<ResolvedRunInput>) {
    const adapter = createClaudeAdapter();
    const { harness } = installQuery();
    const run = await adapter.createRun({ ...BASE_INPUT, ...over });
    const first = harness();

    first.fake.messages.push(INIT_MESSAGE);
    first.fake.messages.push(tasksChanged(busy));
    first.fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    return { adapter, first, harness };
  }

  /** What a second message from the renderer looks like: same session, resumed. */
  const nextTurn = (over?: Partial<ResolvedRunInput>): ResolvedRunInput => ({
    ...BASE_INPUT,
    runId: 'run-2',
    prompt: 'and now the other thing',
    resumeSessionId: 'sess-abc',
    ...over,
  });

  it('serves the next turn on the same process instead of spawning a second', async () => {
    const { adapter, first } = await firstTurn();
    expect(first.fake.closed).toBe(false);

    const second = await adapter.createRun(nextTurn());

    // No second `query()`: the same fake is still the only transport, and the
    // turn is a new run on it.
    expect(second.runId).toBe('run-2');
    expect(first.fake.closed).toBe(false);

    // And it is a real turn — the process's stream feeds it.
    first.fake.messages.push(INIT_MESSAGE);
    first.fake.messages.push(tasksChanged([]));
    first.fake.messages.push(RESULT_MESSAGE);
    const events = await drain(second.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end' });
    // Each turn numbers its own events from zero, densely, which is the contract
    // a run has and the reason turns stayed the unit of a run.
    expect(events[0]?.seq).toBe(0);
  });

  it('spawns fresh when a turn asks for a bypass the live process cannot enter', async () => {
    /*
     * The SDK's `allowDangerouslySkipPermissions` is a spawn-time option and
     * `setPermissionMode` cannot supply it, so a process started on any other
     * mode refuses the switch for as long as it lives — quietly, because
     * `#applySettings` swallows a failed setter. The chip said
     * bypassPermissions, the CLI stayed on acceptEdits, and every tool call
     * kept asking; sending another message changed nothing, because the same
     * warm process served that turn too.
     */
    const { adapter, first } = await firstTurn({ permissionMode: 'acceptEdits' });
    // The work settles; the process is merely retained — the state a mode
    // switch actually lands in, and the one the pool may release.
    first.fake.messages.push(tasksChanged([]));
    await vi.waitFor(() => expect(first.fake.closed).toBe(false));
    const second = installQuery();

    await adapter.createRun(nextTurn({ permissionMode: 'bypassPermissions' }));

    // Release before resume: the old transport is down, so the fresh spawn
    // resumes a file nobody else is writing…
    await vi.waitFor(() => expect(first.fake.closed).toBe(true));
    // …and it carries the opt-in the mode requires, on the same conversation.
    expect(second.harness().options['permissionMode']).toBe('bypassPermissions');
    expect(second.harness().options['allowDangerouslySkipPermissions']).toBe(true);
    expect(second.harness().options['resume']).toBe('sess-abc');
    // The old process was never asked for a mode it would have refused.
    expect(first.fake.modes).not.toContain('bypassPermissions');
  });

  it('refuses the switch while the conversation still holds work', async () => {
    // Releasing a process with a background task would destroy the very thing
    // retention exists to protect; spawning alongside it would put two writers
    // on one transcript. Same terms as a hand-off: stop the work, then switch.
    const { adapter, first } = await firstTurn({ permissionMode: 'acceptEdits' });
    const second = installQuery();

    await expect(adapter.createRun(nextTurn({ permissionMode: 'bypassPermissions' }))).rejects.toThrow(
      /stop it before switching/,
    );

    expect(() => second.harness()).toThrow(/never called/);
    expect(first.fake.closed).toBe(false);
  });

  it('keeps the live process when a turn leaves bypassPermissions', async () => {
    // Tightening asks no permission of anyone, so `setPermissionMode` does it
    // in place. Respawning here would throw away a warm conversation to apply
    // a change the process can make itself.
    const { adapter, first } = await firstTurn({ permissionMode: 'bypassPermissions' });
    const second = installQuery();

    await adapter.createRun(nextTurn({ permissionMode: 'acceptEdits' }));

    expect(() => second.harness()).toThrow(/never called/);
    expect(first.fake.modes).toContain('acceptEdits');
  });

  it('keeps the live process when the bypass was there from the start', async () => {
    // Spawned with the opt-in, so the mode is already available to it and
    // nothing needs replacing.
    const { adapter, first } = await firstTurn({ permissionMode: 'bypassPermissions' });
    const second = installQuery();

    await adapter.createRun(nextTurn({ permissionMode: 'bypassPermissions' }));

    expect(() => second.harness()).toThrow(/never called/);
    expect(first.fake.closed).toBe(false);
  });

  it('spawns a fresh process when the last one is gone', async () => {
    const adapter = createClaudeAdapter();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const first = harness();
    first.fake.messages.push(INIT_MESSAGE);
    first.fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    expect(first.fake.closed).toBe(true);

    const second = await adapter.createRun(nextTurn());
    const later = harness();

    // A closed process must never be attached to: the next message would wait
    // for a turn on a CLI that has stopped reading it.
    expect(later.fake).not.toBe(first.fake);
    expect(second.runId).toBe('run-2');
  });

  it('refuses to attach while the previous turn is still streaming', async () => {
    const adapter = createClaudeAdapter();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const first = harness();

    // Turn one has its session id — so the pool knows the process — but no
    // `result` yet: it is mid-turn, and its consumer is still reading.
    const firstEvents = drain(run.events);
    first.fake.messages.push(INIT_MESSAGE);
    await vi.waitFor(() => expect(run.sessionId).toBe('sess-abc'));

    const second = await adapter.createRun(nextTurn());

    // A fresh spawn, not an attach. `beginTurn` replaces the active state and
    // queue outright, so attaching here would strand turn one's consumer on a
    // queue nobody ever closes and map its remaining messages with turn two's
    // state. Two CLIs on one conversation is the lesser harm: `--resume` is
    // serialised by the provider's own transcript.
    expect(harness().fake).not.toBe(first.fake);
    expect(second.runId).toBe('run-2');

    // And turn one is untouched by the refusal — its own `result` still ends
    // its stream normally.
    first.fake.messages.push(RESULT_MESSAGE);
    const events = await firstEvents;
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('refuses to serve a fork on the process that owns the original', async () => {
    const { adapter, first, harness } = await firstTurn();

    await adapter.createRun(nextTurn({ forkSession: true }));

    // A fork is a new conversation by definition; serving it here would write
    // the branch into the trunk.
    expect(harness().fake).not.toBe(first.fake);
  });

  it('refuses a turn pointed at a different directory', async () => {
    const { adapter, first, harness } = await firstTurn();

    await adapter.createRun(nextTurn({ cwd: REAL_CWD }));

    // The cwd is fixed at spawn, and a session only resumes in the directory it
    // was created in.
    expect(harness().fake).not.toBe(first.fake);
  });

  it('refuses a turn pointed at a different store while the process holds work', async () => {
    const { adapter, first } = await firstTurn();

    /*
     * This used to fall through to a fresh spawn beside the held process, on
     * the reasoning that a session id does not resolve in another profile's
     * store anyway. With `projects/` shared it does resolve — a cross-store
     * resume is a *hand off* — and a fresh spawn here would put two CLIs on
     * one JSONL: this process is retained precisely because it is still
     * writing about the work it holds. So the turn is refused, with the way
     * out named. The idle case releases and respawns instead — see "a resume
     * under a different account" below.
     */
    await expect(
      adapter.createRun(
        nextTurn({ env: { ...BASE_INPUT.env, CLAUDE_CONFIG_DIR: '/app/profiles/other' } }),
      ),
    ).rejects.toThrow(/work running under the account it started on/);
    expect(first.fake.closed).toBe(false);
  });

  it('moves the live process onto the new turn’s model and mode', async () => {
    const { adapter, first } = await firstTurn({ model: 'sonnet', permissionMode: 'default' });

    await adapter.createRun(nextTurn({ model: 'opus', permissionMode: 'plan' }));

    // Silently running the new turn on the old model would be the failure that
    // makes attaching unsafe: the status line would name one model and another
    // would answer.
    expect(first.fake.models).toEqual(['opus']);
    expect(first.fake.modes).toEqual(['plan']);
  });

  it('sends no control requests when nothing changed', async () => {
    const { adapter, first } = await firstTurn({ model: 'sonnet', permissionMode: 'default' });

    await adapter.createRun(nextTurn({ model: 'sonnet', permissionMode: 'default' }));

    expect(first.fake.models).toEqual([]);
    expect(first.fake.modes).toEqual([]);
    expect(first.fake.flags).toEqual([]);
  });

  it('clears a speed flag the new turn turned off, rather than omitting it', async () => {
    const { adapter, first } = await firstTurn({ fastMode: true, effort: 'high' });

    await adapter.createRun(nextTurn({ fastMode: false, effort: 'low' }));

    // Successive `applyFlagSettings` calls shallow-merge and `undefined` is
    // dropped by JSON, so omitting a flag leaves the previous turn's value in
    // force — which would make turning fast mode off between turns do nothing.
    expect(first.fake.flags).toEqual([{ fastMode: null, ultracode: null, effortLevel: 'low' }]);
  });

  it('fails the turn loudly when the process dies while it is being prepared', async () => {
    /*
     * `canServe` runs before `continueWith`'s awaits, and the process is free
     * to die during them — a control request to a dying CLI is exactly what
     * that looks like. The prompt is pushed onto the process's own queue, and
     * `push` on a closed queue is a documented no-op: without a re-check, the
     * turn would come back as started with its message silently discarded and
     * its `run.end` owed by a pump that has already exited. A user who left a
     * conversation idle long enough for its process to die is the person this
     * happens to.
     */
    const { adapter, first } = await firstTurn({ model: 'sonnet' });

    // The model differs, so `continueWith` sends a control request — and the
    // process dies underneath it, deterministically: the fake holds the reply
    // until the prompt queue it was handed reports closed.
    first.fake.setModel = async () => {
      first.fake.close();
      await vi.waitFor(() => {
        expect((first.prompt as { closed?: boolean }).closed).toBe(true);
      });
    };

    await expect(adapter.createRun(nextTurn({ model: 'opus' }))).rejects.toMatchObject({
      name: 'AdapterError',
      agentError: { code: 'transport' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The staging directory's lifetime                                           */
/* -------------------------------------------------------------------------- */

/**
 * Staged attachments are copies of the user's own files, sitting in the system
 * temp directory. Dispose has always removed them — but most runs are never
 * disposed: they end naturally and are *released*, which is a no-op on purpose.
 * The process closing its transport is the moment nothing can read the staged
 * files any more, so that is when they must go, or every finished conversation
 * leaves its attachments behind in /tmp.
 */
describe('the staging directory', () => {
  /** "hello", staged under the user's own file name. */
  const NOTES = { kind: 'file', id: 'file-1', name: 'notes.md', data: 'aGVsbG8=' } as const;

  it('is removed when the run ends naturally, without a dispose', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, attachments: [NOTES] });

    // The run granted itself the directory — the last additional directory is
    // how a test finds it, the same way the CLI would.
    const dirs = harness().options.additionalDirectories as readonly string[];
    const staging = dirs.at(-1) as string;
    expect(existsSync(join(staging, 'notes.md'))).toBe(true);

    harness().fake.messages.push(INIT_MESSAGE);
    harness().fake.messages.push(RESULT_MESSAGE);
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });

    // Removal happens after the event stream closes, so poll rather than race.
    await vi.waitFor(() => expect(existsSync(staging)).toBe(false));
  });

  it('is removed when the run never launches', async () => {
    let staging: string | undefined;
    sdkMock.onQuery = (params) => {
      const { additionalDirectories } = params.options as {
        additionalDirectories?: readonly string[];
      };
      staging = additionalDirectories?.at(-1);
      throw new Error('spawn claude ENOENT');
    };

    const run = await createClaudeAdapter().createRun({
      ...BASE_INPUT,
      cwd: REAL_CWD,
      attachments: [NOTES],
    });
    const events = await drain(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'error' });

    // No process ever opened, so no transport close will ever run — the launch
    // failure path has to clean up after itself.
    expect(staging).toBeDefined();
    await vi.waitFor(() => expect(existsSync(staging as string)).toBe(false));
  });
});

/* -------------------------------------------------------------------------- */
/* Turns the provider starts on its own                                       */
/* -------------------------------------------------------------------------- */

/**
 * Measured before it was built: when a backgrounded `sleep 40` settled, the CLI
 * emitted `init`, an assistant message and a `result` with no prompt from
 * anyone — the agent is told its task finished and answers.
 *
 * That output is written to the session's own `.jsonl` either way, so it is never
 * lost; what is at stake is whether the live conversation shows it or quietly
 * falls out of step with the provider's own record until it is reopened.
 */
describe('a turn nobody asked for', () => {
  const tasksChanged = (tasks: readonly unknown[]) =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks,
      uuid: 'u-tasks',
      session_id: 'sess-abc',
    }) as unknown as SDKMessage;

  const busy = [{ task_id: 't1', task_type: 'local_bash', description: 'sleep 40' }];

  /** An adapter that records the runs it is handed, the way the engine adopts them. */
  function adapterWithSink() {
    const adopted: { run: Run; context: unknown }[] = [];
    let n = 0;
    const adapter = createClaudeAdapter({
      onContinuation: (run, context) => adopted.push({ run, context }),
      newRunId: () => `run-c${String(++n)}` as RunId,
    });
    return { adapter, adopted };
  }

  it('opens a run for it, and the events land there rather than nowhere', async () => {
    const { adapter, adopted } = adapterWithSink();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busy));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    expect(adopted).toHaveLength(0);

    // The task settles, and the provider takes a turn about it.
    fake.messages.push(tasksChanged([]));
    fake.messages.push(INIT_MESSAGE);
    fake.messages.push({
      type: 'assistant',
      message: {
        id: 'msg-c',
        role: 'assistant',
        content: [{ type: 'text', text: 'that finished' }],
      },
      session_id: 'sess-abc',
      uuid: 'u-c',
    } as unknown as SDKMessage);
    fake.messages.push(RESULT_MESSAGE);

    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const continuation = adopted[0]?.run as Run;

    // Its own run, with its own dense sequence — the contract every run has.
    expect(continuation.runId).toBe('run-c1');
    const events = await drain(continuation.events);
    expect(events[0]).toMatchObject({ type: 'session.started', seq: 0 });
    expect(events.map((e) => e.type)).toContain('text.complete');
    expect(events.at(-1)).toMatchObject({ type: 'run.end' });

    // And it is the same conversation, which is what lets a pane adopt it.
    expect(adopted[0]?.context).toMatchObject({
      providerId: 'claude',
      profileId: BASE_INPUT.profileId,
      cwd: BASE_INPUT.cwd,
      sessionId: 'sess-abc',
    });
  });

  it('does not reopen the turn that already ended', async () => {
    const { adapter, adopted } = adapterWithSink();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busy));
    fake.messages.push(RESULT_MESSAGE);
    const first = await drain(run.events);

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));

    // `run.end` fired on the first turn and its stream terminated — a `Run`'s
    // events are consumable exactly once, so there is nothing to re-read and
    // nothing could have been appended to it.
    expect(first.at(-1)).toMatchObject({ type: 'run.end' });

    // The continuation is a different run with its own dense sequence, rather
    // than more events on the one that ended.
    const continuation = adopted[0]?.run as Run;
    expect(continuation.runId).not.toBe(run.runId);
    const events = await drain(continuation.events);
    expect(events[0]).toMatchObject({ type: 'session.started', seq: 0 });
  });

  it('lets a subagent ask for permission long after its own turn ended', async () => {
    const { adapter, adopted } = adapterWithSink();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake, options } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busy));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // The subagent is still running and wants a tool. Denying here — which is
    // what an ended run used to do — would stop the work this change exists to
    // keep alive, at the one moment the user could have said yes.
    const pending = callCanUseTool(options, new AbortController().signal);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));

    const continuation = adopted[0]?.run as Run;
    const iterator = continuation.events[Symbol.asyncIterator]();
    const first = (await iterator.next()).value as PermissionRequestEvent;
    expect(first.type).toBe('permission.request');

    // Answerable, on the run it arrived on, and the tool call proceeds.
    await continuation.respondToPermission(first.requestId, { behavior: 'allow' });
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('denies instead of parking when nothing would receive the turn', async () => {
    // No `onContinuation`: a prompt opened here would wait on a promise nobody
    // can resolve, and the subagent would hang for ever. Refusing to pretend
    // there is a turn is the honest failure.
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, options } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(tasksChanged(busy));
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await expect(callCanUseTool(options, new AbortController().signal)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Predicted next prompts                                                     */
/* -------------------------------------------------------------------------- */

describe('prompt suggestions', () => {
  const SUGGESTION_MESSAGE = {
    type: 'prompt_suggestion',
    suggestion: '  Now run the tests and fix what breaks  ',
    uuid: 'uuid-sugg',
    session_id: 'sess-abc',
  } as unknown as SDKMessage;

  it('asks the SDK to predict only when someone is listening', async () => {
    const first = installQuery();
    await createClaudeAdapter().createRun(BASE_INPUT);
    expect(first.harness().options['promptSuggestions']).toBeUndefined();

    const second = installQuery();
    await createClaudeAdapter({ onSuggestion: () => undefined }).createRun(BASE_INPUT);
    expect(second.harness().options['promptSuggestions']).toBe(true);
  });

  it('delivers the prediction trimmed, then releases the process', async () => {
    const heard: unknown[] = [];
    const { harness } = installQuery();
    const run = await createClaudeAdapter({
      onSuggestion: (suggestion) => heard.push(suggestion),
    }).createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // The turn is over and its stream has closed, and the process is still
    // here — held for exactly the message that has not arrived yet.
    expect(fake.closed).toBe(false);

    fake.messages.push(SUGGESTION_MESSAGE);
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toEqual({
      kind: 'run-suggestion',
      runId: 'run-1',
      sessionId: 'sess-abc',
      suggestion: 'Now run the tests and fix what breaks',
    });
    await vi.waitFor(() => expect(fake.closed).toBe(true));
  });

  it('releases the process when no prediction arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const heard: unknown[] = [];
      const { harness } = installQuery();
      const run = await createClaudeAdapter({
        onSuggestion: (suggestion) => heard.push(suggestion),
      }).createRun(BASE_INPUT);
      const { fake } = harness();

      fake.messages.push(INIT_MESSAGE);
      fake.messages.push(RESULT_MESSAGE);
      await drain(run.events);
      expect(fake.closed).toBe(false);

      await vi.advanceTimersByTimeAsync(10_500);
      expect(fake.closed).toBe(true);
      expect(heard).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait after an ending the provider never predicts for', async () => {
    // Errors and interruptions get no prediction from the CLI, so holding the
    // process for one would be ten seconds of nothing after every failure.
    const { harness } = installQuery();
    const run = await createClaudeAdapter({ onSuggestion: () => undefined }).createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['the API fell over'],
    } as unknown as SDKMessage);
    await drain(run.events);

    await vi.waitFor(() => expect(fake.closed).toBe(true));
  });

  it('does not wait after a plan-mode turn', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter({ onSuggestion: () => undefined }).createRun({
      ...BASE_INPUT,
      permissionMode: 'plan',
    });
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    await vi.waitFor(() => expect(fake.closed).toBe(true));
  });

  it('drops an empty prediction and still releases', async () => {
    const heard: unknown[] = [];
    const { harness } = installQuery();
    const run = await createClaudeAdapter({
      onSuggestion: (suggestion) => heard.push(suggestion),
    }).createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    fake.messages.push({
      type: 'prompt_suggestion',
      suggestion: '   ',
      uuid: 'uuid-blank',
      session_id: 'sess-abc',
    } as unknown as SDKMessage);

    await vi.waitFor(() => expect(fake.closed).toBe(true));
    expect(heard).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Rewind                                                                     */
/* -------------------------------------------------------------------------- */

describe('rewind', () => {
  const tasksChanged = (tasks: readonly unknown[]) =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks,
      uuid: 'u-tasks',
      session_id: 'sess-abc',
    }) as unknown as SDKMessage;

  it('maps the resolved point onto the SDK options', () => {
    const options = buildClaudeOptions(
      { ...BASE_INPUT, resumeSessionId: 'sess-old' },
      {
        canUseTool: async () => ({ behavior: 'deny', message: 'x' }) as never,
        abortController: new AbortController(),
        stderr: () => undefined,
        rewind: { resumeSessionAt: 'uuid-cut', dropsTurn: true },
      },
    );
    expect(options).toMatchObject({
      resume: 'sess-old',
      resumeSessionAt: 'uuid-cut',
      resumeDropsTurn: true,
    });
  });

  it('releases a grace-held idle process and rewinds fresh', async () => {
    // A process lingering on a grace window — here, the settle beat after its
    // last task finished — is idle in every sense the user can see. The
    // rewind must not refuse for the length of a timer nobody knows is
    // running: the retained transport is closed and the truncating resume
    // spawns fresh.
    const first = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = first.harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'subagent', description: 'brief work' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    // The work settles; the process is retained for the turn about it.
    fake.messages.push(tasksChanged([]));
    await vi.waitFor(() => expect(fake.closed).toBe(false));

    sdkMock.onListSessions = () => Promise.resolve([]);
    const second = installQuery();
    const rewound = await adapter
      .createRun({
        ...BASE_INPUT,
        runId: 'run-2',
        resumeSessionId: 'sess-abc',
        rewindToMessageId: 'uuid-anywhere',
      })
      .catch((error: unknown) => error);

    // The retained process was released rather than refused-behind…
    await vi.waitFor(() => expect(fake.closed).toBe(true));
    // …and the rewind proceeded past the refusal into the stored-chain read —
    // which is the assertion that matters. The module mock exports no session
    // reader, so the read itself fails with the resolver's own wrapper; a
    // refusal would have said "still has work running" instead.
    expect(String((rewound as Error).message)).toContain('Could not read the session to rewind');
    void second;
  });

  it('still refuses while the conversation holds real work', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'subagent', description: 'still going' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    expect(fake.closed).toBe(false);

    await expect(
      adapter.createRun({
        ...BASE_INPUT,
        runId: 'run-2',
        resumeSessionId: 'sess-abc',
        rewindToMessageId: 'uuid-anywhere',
      }),
    ).rejects.toThrow(/still has work running/);
    expect(fake.closed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* A hand-off resume: same conversation, different store                       */
/* -------------------------------------------------------------------------- */

/**
 * §5 obstacle 2, pinned. A cross-profile resume deliberately misses the pool —
 * `canServe` refuses the config-dir mismatch — and spawns a second CLI against
 * the same (shared) transcript file. The *source* process must be released
 * first, exactly as the rewind path releases it, or it goes on appending —
 * a settling turn, a scheduled wakeup — under the CLI that now owns the file:
 * two writers, one JSONL.
 *
 * The invariant is release-before-resume: by the time the fresh spawn exists,
 * the retained process's transport is down. Work in flight refuses instead,
 * because a release there destroys the very thing retention exists to protect.
 */
describe('a resume under a different account', () => {
  const tasksChanged = (tasks: readonly unknown[]) =>
    ({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks,
      uuid: 'u-tasks',
      session_id: 'sess-abc',
    }) as unknown as SDKMessage;

  /** The same conversation, asked for under another profile's store. */
  const HANDOFF_INPUT: ResolvedRunInput = {
    ...BASE_INPUT,
    runId: 'run-2',
    profileId: 'prof-2',
    resumeSessionId: 'sess-abc',
    prompt: 'carry on',
    env: { CLAUDE_CONFIG_DIR: '/app/profiles/personal' },
  };

  it('releases the retained source process, then spawns fresh against the store', async () => {
    const first = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = first.harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'subagent', description: 'brief work' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    // The work settles; the process is retained on the grace beat — idle in
    // every sense the user can see, and exactly the state a hand off lands in.
    fake.messages.push(tasksChanged([]));
    await vi.waitFor(() => expect(fake.closed).toBe(false));

    const second = installQuery();
    await adapter.createRun(HANDOFF_INPUT);

    // Release before resume: the source transport is down…
    await vi.waitFor(() => expect(fake.closed).toBe(true));
    // …and the fresh spawn is a --resume of the same conversation, not an
    // attach — the config-dir mismatch is a different store by definition.
    expect(second.harness().options).toMatchObject({ resume: 'sess-abc' });
  });

  it('refuses while the source process holds real work', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'subagent', description: 'still going' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    expect(fake.closed).toBe(false);

    // Releasing here would destroy the delegated work retention exists to
    // protect; spawning without releasing would put two CLIs on one file. The
    // only honest answer is to refuse and say what is in the way.
    await expect(adapter.createRun(HANDOFF_INPUT)).rejects.toThrow(
      /work running under the account it started on/,
    );
    expect(fake.closed).toBe(false);
  });

  it('leaves the ordinary same-store resume exactly as it was', async () => {
    const { harness } = installQuery();
    const adapter = createClaudeAdapter();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(
      tasksChanged([{ task_id: 't1', task_type: 'subagent', description: 'still going' }]),
    );
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // Same store, work in flight: the pool attaches, as it always has. The
    // hand-off guard must not widen into refusing what `canServe` accepts.
    const attached = await adapter.createRun({
      ...BASE_INPUT,
      runId: 'run-3',
      resumeSessionId: 'sess-abc',
      prompt: 'and then?',
    });
    expect(fake.closed).toBe(false);
    expect(attached.runId).toBe('run-3');
    await attached.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Steers the turn never folded in                                            */
/* -------------------------------------------------------------------------- */

/**
 * The CLI folds a mid-turn message in only at a tool-batch boundary; one that
 * misses every boundary is parked in the CLI's queue as the *next* turn. A run
 * here is one turn cycle, and the pump used to leave at the first `result` —
 * closing the transport over the parked message, which destroyed it. From the
 * user's side: a steer rendered as sent that the model never read, more often
 * than not (2026-08-24).
 *
 * What these pin is the repair's whole shape: the process is held past the
 * boundary for exactly as long as a steer is pending, the queued turn opens as
 * a continuation of the same conversation, an interrupt keeps the queue (that
 * is what makes "read it now" a lever rather than a destructor), and a steer
 * that *was* folded releases the process on a short grace instead of holding
 * it forever.
 */
describe('a steer the turn never folded in', () => {
  const CONTINUATION_TEXT = {
    type: 'assistant',
    message: {
      id: 'msg-q',
      role: 'assistant',
      content: [{ type: 'text', text: 'right — doing that instead' }],
    },
    session_id: 'sess-abc',
    uuid: 'u-q',
  } as unknown as SDKMessage;

  function adapterWithSink() {
    const adopted: { run: Run; context: unknown }[] = [];
    let n = 0;
    const adapter = createClaudeAdapter({
      onContinuation: (run, context) => adopted.push({ run, context }),
      newRunId: () => `run-q${String(++n)}` as RunId,
    });
    return { adapter, adopted };
  }

  it('keeps the process past the turn boundary and serves the queued turn', async () => {
    const { adapter, adopted } = adapterWithSink();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.send('also check the tests');
    // The turn ends tool-free — nothing folded the steer in.
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // The old exit: transport closed here, queue and all.
    expect(fake.closed).toBe(false);

    // The CLI's drain loop opens the queued turn; it lands as a continuation
    // of the same conversation.
    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(CONTINUATION_TEXT);
    fake.messages.push(RESULT_MESSAGE);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));

    const continuation = adopted[0]?.run as Run;
    const events = await drain(continuation.events);
    expect(events[0]).toMatchObject({ type: 'session.started', seq: 0 });
    expect(events.map((e) => e.type)).toContain('text.complete');
    expect(events.at(-1)).toMatchObject({ type: 'run.end' });

    // The queued turn consumed the steer — nothing holds the process now.
    await vi.waitFor(() => expect(fake.closed).toBe(true));
  });

  it('releases the process on the grace when the steer was folded in after all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun(BASE_INPUT);
      const { fake } = harness();

      fake.messages.push(INIT_MESSAGE);
      await run.send('fold me in');
      fake.messages.push(RESULT_MESSAGE);
      await drain(run.events);

      // Held: from here the adapter cannot tell a fold from a queued turn.
      expect(fake.closed).toBe(false);

      // No turn arrives — the fold consumed it. The grace lets go.
      await vi.advanceTimersByTimeAsync(5_500);
      expect(fake.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an interrupt keeps the queue: the steer runs as the next turn', async () => {
    const { adapter, adopted } = adapterWithSink();
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.send('stop that and do this instead');
    await run.interrupt();
    // The interrupted turn's ending — the kind the provider never predicts
    // after, which used to mean an immediate exit.
    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
    } as unknown as SDKMessage);
    await drain(run.events);

    expect(fake.closed).toBe(false);

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(CONTINUATION_TEXT);
    fake.messages.push(RESULT_MESSAGE);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const events = await drain(adopted[0]?.run.events as AsyncIterable<AgentEvent>);
    expect(events.map((e) => e.type)).toContain('text.complete');
  });

  it('refuses a late steer with the reason the renderer recovers on', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);

    // `details.reason` is what `isEndedRunError` branches on — without it the
    // renderer strands the message under a red banner instead of carrying it
    // into a fresh run.
    await expect(run.send('too late')).rejects.toMatchObject({
      agentError: {
        code: 'invalid_request',
        details: { reason: 'run_ended', runId: 'run-1' },
      },
    });
  });

  it('refuses a steer during teardown with the same recoverable reason', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = harness().prompt[Symbol.asyncIterator]();
    await iterator.next();

    const disposing = run.dispose();
    await expect(run.send('one more thing')).rejects.toMatchObject({
      agentError: {
        code: 'invalid_request',
        details: { reason: 'run_ended', runId: 'run-1' },
      },
    });
    await disposing;
  });
});

/* -------------------------------------------------------------------------- */
/* A steer that was still being staged when the turn ended                    */
/* -------------------------------------------------------------------------- */

/**
 * The window between `send`'s guard and `send`'s push.
 *
 * `send` refuses a run that is already down, then stages the message's files —
 * real filesystem work — and only *then* pushes and counts the steer. Every
 * fact the pump uses to decide whether to keep the process is written on the
 * far side of that await, so a turn that ends while a message is being staged
 * finds nothing holding it: the pump leaves, the `finally` closes the prompt
 * queue, and the push that lands a moment later is a documented no-op on a
 * closed queue. The message reported success, rendered as sent, and reached
 * nobody — and the transport it was addressed to is gone, so the conversation
 * ends instead of continuing on it.
 *
 * That is "the interrupt completely stops the session instead of continuing on
 * reading the message" (2026-08-27): interrupting is exactly when a user types
 * the correction, so it is the ending most likely to land inside this window.
 *
 * What these pin is both halves. The process is held open across an in-flight
 * send, so the ordinary case delivers and the queued turn runs. And when the
 * hold has expired anyway, the send is *refused* with the reason the renderer
 * recovers on, rather than reporting a success it did not achieve.
 */
describe('a steer still being staged when the turn ended', () => {
  /** A file, so `#stage` does real I/O and the window is a real one. */
  const NOTE = { kind: 'file', id: 'file-1', name: 'note.md', data: 'aGVsbG8=' } as const;

  const INTERRUPTED_RESULT = {
    ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
    subtype: 'error_during_execution',
  } as unknown as SDKMessage;

  it('holds the process while the send is in flight, and delivers it', async () => {
    const adopted: { run: Run }[] = [];
    let n = 0;
    const adapter = createClaudeAdapter({
      onContinuation: (run) => adopted.push({ run }),
      newRunId: () => `run-s${String(++n)}` as RunId,
    });
    const { harness } = installQuery();
    const run = await adapter.createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    const { fake, prompt } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.interrupt();

    // The user types the correction as the interrupt lands: `send` is suspended
    // in `#stage` when the interrupted turn's `result` reaches the pump.
    const sending = run.send('do the tests instead', [NOTE]);
    fake.messages.push(INTERRUPTED_RESULT);
    await drain(run.events);

    await expect(sending).resolves.toMatchObject({ deliveredImmediately: false });
    // The transport is the thing the message needs; it must still be there.
    expect(fake.closed).toBe(false);

    // And the message really reached the CLI's queue rather than a closed one.
    // A text-only turn's content is a plain string — see `#userMessage`.
    const messages: string[] = [];
    const iterator = prompt[Symbol.asyncIterator]();
    for (let i = 0; i < 2; i += 1) {
      const next = await iterator.next();
      const content = (next.value as { message: { content: unknown } } | undefined)?.message.content;
      messages.push(typeof content === 'string' ? content : JSON.stringify(content));
    }
    expect(messages[0]).toBe('refactor the parser');
    expect(messages[1]).toContain('do the tests instead');

    // The CLI runs it as the queued turn, and it opens as a continuation.
    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
  });

  it('refuses rather than reporting a success it did not achieve', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun({ ...BASE_INPUT, cwd: REAL_CWD });
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await drain(run.events);
    // The grace let go; the transport is down and the queue with it.
    await vi.waitFor(() => expect(fake.closed).toBe(true));

    // `details.reason` is what `isEndedRunError` branches on — it is the
    // difference between the words being carried into a fresh run and being
    // stranded under a red banner.
    await expect(run.send('too late', [NOTE])).rejects.toMatchObject({
      agentError: {
        code: 'invalid_request',
        details: { reason: 'run_ended', runId: 'run-1' },
      },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The fold, made visible                                                     */
/* -------------------------------------------------------------------------- */

/**
 * When the CLI reads a message that was waiting, and how anyone finds out.
 *
 * A mid-turn message is folded into the running turn at a tool-batch boundary.
 * That fold used to be invisible from outside the provider process: the only
 * thing that ever happened was the CLI echoing the message back on its own
 * stream, and `mapUserMessage` drops that echo on sight — rightly, because the
 * window drew the row the moment the words were typed and a second one would
 * show the user their own words twice.
 *
 * The cost of dropping it was a UI that could say a message had been sent and
 * never that it had been read. A queued indicator built on the send alone had
 * nothing to clear it but the end of the run, so it went on announcing "1
 * message queued" while the agent was visibly acting on the message.
 *
 * So the echo is read here — beside the drop, not instead of it. The transcript
 * still gets no second row; what it produces is `message.delivered`, naming the
 * message in the id the *caller* filed it under, which is the only id both ends
 * can speak.
 */
describe('a queued message the provider reads', () => {
  /** The CLI writing a user turn to its transcript, and echoing it back. */
  const echo = (text: string, uuid?: string): SDKMessage =>
    ({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-abc',
      ...(uuid === undefined ? {} : { uuid }),
      message: { role: 'user', content: text },
    }) as unknown as SDKMessage;

  it('says so, under the name the caller gave it', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake, prompt } = harness();
    const reader = prompt[Symbol.asyncIterator]();
    await reader.next(); // the opening prompt

    fake.messages.push(INIT_MESSAGE);
    await run.send('actually, do the tests first', undefined, 'run-1:prompt:2');
    const sent = (await reader.next()).value as SDKUserMessage;

    // The fold: the CLI takes the message and writes it to the transcript.
    fake.messages.push(echo('actually, do the tests first', sent.uuid));
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(events.filter((event) => event.type === 'message.delivered')).toEqual([
      expect.objectContaining({ type: 'message.delivered', messageId: 'run-1:prompt:2' }),
    ]);
    // And still no second copy of the user's words.
    expect(
      events.filter((event) => event.type === 'text.complete' && event.role === 'user'),
    ).toEqual([]);
  });

  it('recognises the message by its words inside the CLI framing', async () => {
    /*
     * The shape a fold actually arrives in. The CLI takes a queued message as
     * a `queued_command` attachment minted under an id of its own — the id it
     * was sent with survives only as `source_uuid` — and frames the text for
     * the model with a line saying who it came from. So the uuid does not come
     * back and the words are not alone; the user's own sentence in the middle
     * is what is left to recognise it by.
     */
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.send('actually, do the tests first', undefined, 'run-1:prompt:2');
    fake.messages.push(
      echo(
        'The user sent a new message while you were working:\nactually, do the tests first',
        'an-id-of-the-clis-own',
      ),
    );
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(events.filter((event) => event.type === 'message.delivered')).toEqual([
      expect.objectContaining({ messageId: 'run-1:prompt:2' }),
    ]);
  });

  it('says nothing for an echo of a message nobody is waiting on', async () => {
    // The turn's opening prompt is echoed too, and it was never queued. A
    // report for it would take a waiting message's place in the caller's set.
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.send('actually, do the tests first', undefined, 'run-1:prompt:2');
    fake.messages.push(echo(BASE_INPUT.prompt, 'uuid-opening'));
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(events.filter((event) => event.type === 'message.delivered')).toEqual([]);
  });

  it('does not mistake replayed history for a message being read', async () => {
    // A resumed conversation reads its whole transcript back. An old turn
    // arriving as history is not this turn's message being taken up.
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.send('actually, do the tests first', undefined, 'run-1:prompt:2');
    fake.messages.push({
      ...(echo('actually, do the tests first', 'uuid-old') as unknown as Record<string, unknown>),
      isReplay: true,
    } as unknown as SDKMessage);
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(events.filter((event) => event.type === 'message.delivered')).toEqual([]);
  });

  it('reports each waiting message once, in the order they were read', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    await run.send('first', undefined, 'run-1:prompt:2');
    await run.send('second', undefined, 'run-1:prompt:3');

    fake.messages.push(echo('first', 'uuid-a'));
    // The same echo again — the CLI writing the turn is one event, but nothing
    // downstream may be told twice that one message was read.
    fake.messages.push(echo('first', 'uuid-a'));
    fake.messages.push(echo('second', 'uuid-b'));
    fake.messages.push(RESULT_MESSAGE);

    const events = await drain(run.events);
    expect(
      events
        .filter((event) => event.type === 'message.delivered')
        .map((event) => (event as { messageId: string }).messageId),
    ).toEqual(['run-1:prompt:2', 'run-1:prompt:3']);
  });
});

/* -------------------------------------------------------------------------- */
/* The interrupt receipt                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the provider itself says survives an interrupt.
 *
 * `interrupt()` comes back with `still_queued` — the uuids of messages the CLI
 * will run anyway, taken as a snapshot at the instant of the abort. It is a
 * stronger fact than the adapter's own steer count, which is a local guess: it
 * is zeroed whenever a turn opens, it cannot see a message the CLI enqueued for
 * itself (a cron trigger, an auto-resume continuation), and a fold leaves it
 * counting a steer that has already been read.
 *
 * So the receipt is what the hold is armed from when the two disagree. The
 * alternative is the transport closing over a turn the provider has promised
 * to run — the session ending on the one action whose entire purpose is to
 * make it read something.
 */
describe('an interrupt that reports queued messages', () => {
  it('keeps the process for a turn the count did not know about', async () => {
    const adopted: { run: Run }[] = [];
    let n = 0;
    const adapter = createClaudeAdapter({
      onContinuation: (run) => adopted.push({ run }),
      newRunId: () => `run-r${String(++n)}` as RunId,
    });
    const { harness } = installQuery();
    const run = await adapter.createRun(BASE_INPUT);
    const { fake } = harness();

    fake.messages.push(INIT_MESSAGE);
    // Nothing this adapter sent — the CLI is holding a message of its own.
    fake.interruptImpl = () => Promise.resolve({ still_queued: ['q-1'] });
    /*
     * So the caller is told nothing: `q-1` is in the CLI's id space and names
     * no row this app could show. The receipt is still *read* — that is what
     * the rest of this test is about. The hold does not need the caller to
     * understand the id, only the adapter to have seen one.
     */
    await expect(run.interrupt()).resolves.toMatchObject({ stillQueued: [] });

    fake.messages.push({
      ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
      subtype: 'error_during_execution',
    } as unknown as SDKMessage);
    await drain(run.events);

    // The old exit: the transport closed over the promised turn.
    expect(fake.closed).toBe(false);

    fake.messages.push(INIT_MESSAGE);
    fake.messages.push(RESULT_MESSAGE);
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
  });

  it('lets go on the grace when an empty receipt means nothing is coming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { harness } = installQuery();
      const run = await createClaudeAdapter().createRun(BASE_INPUT);
      const { fake } = harness();

      fake.messages.push(INIT_MESSAGE);
      await run.interrupt();
      fake.messages.push({
        ...(RESULT_MESSAGE as unknown as Record<string, unknown>),
        subtype: 'error_during_execution',
      } as unknown as SDKMessage);
      await drain(run.events);

      // An interrupt with nothing queued is a plain stop: no hold to expire.
      expect(fake.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Suggested tasks                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The one tool that is never asked about.
 *
 * `suggest_task` is Artemis's own, its handler runs in Artemis's process, and
 * its only effect is that the call is in the transcript — which is what draws a
 * chip. There is nothing for a person to weigh, so parking the turn to ask them
 * would put an approval card in front of a suggestion they can already ignore,
 * and teach them to click through prompts. See `#canUseTool`.
 */
describe('suggested tasks', () => {
  const TASK = { title: 'Add tests', tldr: 'No coverage.', prompt: 'Write the tests.' };

  /** `canUseTool` for a named tool, called exactly as the SDK would. */
  function ask(options: Record<string, unknown>, toolName: string, input: Record<string, unknown>) {
    const canUseTool = options['canUseTool'] as (
      name: string,
      args: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => Promise<unknown>;
    return canUseTool(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_task',
      requestId: 'req_task',
      title: 'Claude wants to suggest a task',
    });
  }

  it('allows the call itself, with the arguments untouched', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    harness().fake.messages.push(INIT_MESSAGE);

    await expect(ask(harness().options, SUGGESTED_TASK_TOOL, TASK)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: TASK,
      toolUseID: 'toolu_task',
    });
    await run.dispose();
  });

  it('parks nothing on the stream, so no card is ever drawn for it', async () => {
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();
    harness().fake.messages.push(INIT_MESSAGE);
    await iterator.next();

    await ask(harness().options, SUGGESTED_TASK_TOOL, TASK);

    // The next event is the one that follows in the conversation, not a
    // `permission.request` for the suggestion. Asserted by what arrives rather
    // than by a timeout, so a request emitted late still fails this.
    harness().fake.messages.push(RESULT_MESSAGE);
    const next = (await iterator.next()).value as AgentEvent;
    expect(next.type).not.toBe('permission.request');
    await run.dispose();
  });

  it('still asks about every other tool, including one from the same server', async () => {
    // The allowance is one name, checked in the open — not a blanket exemption
    // for anything Artemis happens to have registered.
    const { harness } = installQuery();
    const run = await createClaudeAdapter().createRun(BASE_INPUT);
    const iterator = run.events[Symbol.asyncIterator]();
    harness().fake.messages.push(INIT_MESSAGE);
    await iterator.next();

    void ask(harness().options, 'mcp__artemisTasks__something_else', {});
    const event = (await iterator.next()).value as PermissionRequestEvent;

    expect(event.type).toBe('permission.request');
    await run.dispose();
  });

  it('declares the capability the chips are gated on', () => {
    expect(CLAUDE_CAPABILITIES.taskSuggestions).toBe(true);
  });
});
