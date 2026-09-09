/**
 * The tool an agent offers follow-up work with.
 *
 * The handler does nothing, so almost none of what matters here is behaviour.
 * What matters is the *contract*, and it has two halves that fail in opposite
 * directions:
 *
 *  - **The name.** It is what a stored transcript carries, and what the
 *    transcript model matches on to draw a chip instead of a tool card. A
 *    rename retires every suggestion in every saved conversation, silently, so
 *    it is pinned against the constant both sides read.
 *  - **The description.** It is the only thing standing between this feature
 *    and a chip under every message. An agent that offers work it was asked to
 *    do — or asks a question through it — is worse than one with no tool at
 *    all, and those are the sentences that prevent it.
 *
 * The one behaviour worth a test is what the handler *says back*: an agent that
 * reads "started" will write as though something did.
 */

import { describe, expect, it } from 'vitest';

import { SUGGESTED_TASK_TOOL } from '@rx-artemis/protocol';

import { suggestedTaskTools } from './taskTools';

const TASK = {
  title: 'Add tests for the parser',
  tldr: 'The new branch in parseHeader has no coverage.',
  prompt: 'Write unit tests for parseHeader in src/parse.ts.',
};

function tool() {
  const found = suggestedTaskTools()[0];
  if (found === undefined) throw new Error('the server registered no tools');
  return found;
}

describe('the suggest_task tool', () => {
  it('is the only tool on the server', () => {
    // A second tool here would be a second thing the model can do at the end of
    // a turn, and the reason there is no `dismiss_task` is in the module docs.
    expect(suggestedTaskTools()).toHaveLength(1);
  });

  it('is addressed by the name the transcript matches on', () => {
    expect(SUGGESTED_TASK_TOOL.endsWith(`__${tool().name}`)).toBe(true);
  });

  it('takes the three fields a chip is drawn from, and no working directory', () => {
    // Claude Code's equivalent takes a `cwd`, and it is the field behind its
    // confirmation dialog naming one directory while the work starts in
    // another. Where a conversation happens is the user's standing choice.
    expect(Object.keys(tool().inputSchema as object).sort()).toEqual(['prompt', 'title', 'tldr']);
  });

  it('tells the agent nothing started, and not to wait', async () => {
    const result = (await (tool().handler as (args: unknown, extra: unknown) => Promise<unknown>)(
      TASK,
      {},
    )) as { content: { text: string }[] };

    const text = result.content[0]?.text ?? '';
    expect(text).toContain(TASK.title);
    expect(text).toContain('Nothing has started');
    // The two failure modes of a tool that returns nothing useful: an agent
    // that believes it delegated the work, and one that blocks waiting for an
    // answer that is never coming.
    expect(text).toContain('do not wait');
  });

  it('says when not to reach for it, not only what it is for', () => {
    const { description } = tool();
    expect(description).toContain('OUT OF SCOPE');
    expect(description).toContain('Do NOT use it for');
    // The rate limit is part of the contract: the value of a suggestion is
    // that it was worth interrupting for.
    expect(description).toContain('at most twice');
  });
});
