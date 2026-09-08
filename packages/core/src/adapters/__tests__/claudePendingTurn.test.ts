/**
 * A prompt handed to a live process claims only the CLI turn that is its own.
 *
 * The bug, reproduced on a served session on 2026-09-08: a conversation whose
 * turn had ended with a subagent still running was sent a new prompt. The CLI,
 * about to answer its own task notification, opened *that* turn first; the
 * adapter had already made the prompt's turn the active one, so the
 * notification's sentence streamed as the prompt's answer and the `result`
 * ended the run — after which the prompt ran on a turn nobody was watching.
 * From the user's side the conversation woke for a second, said something
 * about a subagent, and stopped; the second message worked.
 *
 * What these pin: a turn opened by `continueWith` waits until the CLI echoes
 * its prompt; a CLI turn whose user message is the harness's becomes a
 * continuation and leaves the prompt queued; a turn the wire never narrates
 * with a user message still lands on the prompt (the reading every turn had
 * before); and a process that closes with a prompt still waiting ends that
 * turn rather than leaving it open forever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, RunId } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
}));

const { createClaudeAdapter } = await import('../claude.js');
const { AsyncQueue } = await import('../stream.js');
type ResolvedRunInput = import('../types.js').ResolvedRunInput;
type Run = import('../types.js').Run;

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

function installQuery(): { fake: () => FakeQuery; prompts: () => AsyncIterable<SDKUserMessage> } {
  let captured: { fake: FakeQuery; prompt: AsyncIterable<SDKUserMessage> } | undefined;
  sdkMock.onQuery = (params) => {
    const fake = new FakeQuery();
    captured = { fake, prompt: params.prompt as AsyncIterable<SDKUserMessage> };
    return fake;
  };
  return {
    fake: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured.fake;
    },
    prompts: () => {
      if (captured === undefined) throw new Error('query() was never called');
      return captured.prompt;
    },
  };
}

const BASE_INPUT: ResolvedRunInput = {
  runId: 'run-1',
  providerId: 'claude',
  profileId: 'prof-1',
  cwd: process.cwd(),
  prompt: 'launch a subagent',
  env: {},
} as ResolvedRunInput;

const INIT: SDKMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  cwd: process.cwd(),
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
  uuid: 'init-1',
} as unknown as SDKMessage;

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
  session_id: 'sess-abc',
  uuid: 'result-1',
} as unknown as SDKMessage;

function tasksChanged(tasks: readonly { task_id: string; description: string }[]): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((task) => ({ ...task, task_type: 'local_subagent', status: 'running' })),
    session_id: 'sess-abc',
    uuid: `tasks-${String(tasks.length)}`,
  } as unknown as SDKMessage;
}

function assistantText(text: string, id = 'msg-a'): SDKMessage {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    session_id: 'sess-abc',
    uuid: `u-${id}`,
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

/** The harness's own turn opener: a task notification in a user slot. */
const NOTIFICATION: SDKMessage = {
  type: 'user',
  parent_tool_use_id: null,
  uuid: 'notif-1',
  session_id: 'sess-abc',
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>',
  },
} as unknown as SDKMessage;

/** The CLI echoing the prompt it was handed, under the uuid it was stamped with. */
function echoOf(prompt: SDKUserMessage): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    uuid: prompt.uuid,
    session_id: 'sess-abc',
    message: { role: 'user', content: prompt.message.content },
  } as unknown as SDKMessage;
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Wait for the next prompt the adapter pushed at the CLI. */
async function nextPrompt(prompts: AsyncIterator<SDKUserMessage>): Promise<SDKUserMessage> {
  const next = await prompts.next();
  if (next.done === true) throw new Error('the prompt queue closed');
  return next.value;
}

/**
 * A process left alive by a subagent: the first turn launched one and ended.
 * Returns the adapter, the fake transport, and the prompt iterator with the
 * opening prompt already consumed.
 */
async function processHoldingWork() {
  const adopted: Run[] = [];
  let n = 0;
  const adapter = createClaudeAdapter({
    onContinuation: (run) => adopted.push(run),
    newRunId: () => `run-c${String(++n)}` as RunId,
  });
  const query = installQuery();
  const first = await adapter.createRun(BASE_INPUT);
  const prompts = query.prompts()[Symbol.asyncIterator]();
  await nextPrompt(prompts);

  const fake = query.fake();
  fake.messages.push(INIT);
  fake.messages.push(tasksChanged([{ task_id: 't1', description: 'sleep then report' }]));
  fake.messages.push(RESULT);
  await drain(first.events);
  expect(fake.closed).toBe(false);

  return { adapter, fake, prompts, adopted };
}

const NEXT: ResolvedRunInput = {
  ...BASE_INPUT,
  runId: 'run-2',
  resumeSessionId: 'sess-abc',
  prompt: 'reply with exactly the word awake',
} as ResolvedRunInput;

afterEach(() => {
  sdkMock.onQuery = undefined;
});

describe('a prompt handed to a process running a turn of its own', () => {
  it('leaves the prompt queued while the CLI answers its notification, then serves it', async () => {
    const { adapter, fake, prompts, adopted } = await processHoldingWork();

    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);
    expect(pushed.message.content).toBe('reply with exactly the word awake');
    expect(typeof pushed.uuid).toBe('string');
    expect(second.status).toBe('starting');

    // The CLI's own turn first: the notification, a sentence about it, done.
    fake.messages.push(INIT);
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The subagent returned early.', 'msg-notif'));
    fake.messages.push(RESULT);

    // It lands as a continuation, as it would have had nothing been waiting…
    await vi.waitFor(() => expect(adopted).toHaveLength(1));
    const foreign = await drain(adopted[0]!.events);
    expect(foreign.map((e) => e.type)).toContain('text.complete');
    expect(foreign.at(-1)).toMatchObject({ type: 'run.end' });
    const said = foreign.find((e) => e.type === 'text.complete') as { text: string };
    expect(said.text).toBe('The subagent returned early.');

    // …and the prompt's turn has not been touched by it.
    expect(second.status).toBe('starting');

    // Now the CLI opens the prompt's turn: its echo carries the stamped uuid.
    fake.messages.push(INIT);
    fake.messages.push(echoOf(pushed));
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect(events[0]).toMatchObject({ type: 'session.started', seq: 0 });
    const answer = events.find((e) => e.type === 'text.complete') as { text: string };
    expect(answer.text).toBe('awake');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    // The notification turn's sentence never reached the prompt's stream.
    expect(events.some((e) => e.type === 'text.complete' && (e as { text: string }).text.includes('subagent'))).toBe(false);
  });

  it('recognises the echo by its words when the CLI minted another id', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);

    fake.messages.push(INIT);
    fake.messages.push({
      ...(echoOf(pushed) as unknown as Record<string, unknown>),
      uuid: 'minted-elsewhere',
      message: { role: 'user', content: `The user says: ${String(pushed.message.content)}` },
    } as unknown as SDKMessage);
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
  });

  it('still lands a turn the wire never narrated with a user message on the prompt', async () => {
    // The reading every turn had before the decision existed: a CLI turn
    // with no echo at all is the prompt's. Refusing it would strand the prompt.
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    fake.messages.push(INIT);
    fake.messages.push(assistantText('awake', 'msg-awake'));
    fake.messages.push(RESULT);

    const events = await drain(second.events);
    expect((events.find((e) => e.type === 'text.complete') as { text: string }).text).toBe('awake');
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
  });

  it('accepts a steer typed while the prompt is still waiting for its turn', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    const pushed = await nextPrompt(prompts);

    // The steer queues behind the prompt, exactly as it would had the CLI
    // already begun; refusing it would send the renderer down the "run
    // ended" path and start a rival run.
    await expect(second.send('and then say goodnight')).resolves.toMatchObject({
      deliveredImmediately: false,
    });
    const steer = await nextPrompt(prompts);
    expect(steer.message.content).toBe('and then say goodnight');

    fake.messages.push(INIT);
    fake.messages.push(echoOf(pushed));
    fake.messages.push(RESULT);
    await drain(second.events);
  });

  it('ends a waiting turn when the process closes under it', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    const second = await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    fake.close();

    const events = await drain(second.events);
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      reason: 'error',
      error: { code: 'transport' },
    });
  });

  it('refuses to attach a second prompt behind one still waiting', async () => {
    const { adapter, fake, prompts } = await processHoldingWork();
    await adapter.createRun(NEXT);
    await nextPrompt(prompts);

    // A third turn on the same session goes the fresh-spawn way: the pool
    // will not queue two prompts on a CLI whose order of answering neither
    // side can predict.
    const fresh = installQuery();
    const third = await adapter.createRun({ ...NEXT, runId: 'run-3', prompt: 'and another' });
    expect(third.runId).toBe('run-3');
    expect(fresh.fake()).not.toBe(fake);
    await third.dispose();
  });
});
