/**
 * The tool an agent offers follow-up work with.
 * ============================================================================
 *
 * One tool, one job: the agent names a piece of work it noticed and did not do,
 * and Artemis draws it as a chip under the answer. What the chip *does* is not
 * the agent's to decide — the person picks whether the work happens in this
 * conversation, in a new one, in a worktree, or on a server. See
 * `@rx-artemis/protocol`'s `suggestedTasks` for the vocabulary and for why the
 * tool is called `suggest_task` rather than Claude Code's `spawn_task`.
 *
 * ## Why this needs a file at all, when it does nothing
 *
 * The handler returns a sentence and touches nothing. Every effect this feature
 * has comes from the *call being in the transcript*: the provider files it like
 * any other tool use, Artemis replays it on reopen, and the chip comes back.
 * The tool is a place to put a structured suggestion where it will survive —
 * which is the whole reason it is a tool rather than a tag in the prose, a
 * side channel, or a second file beside the conversation.
 *
 * So the interesting content here is the *description*: it is the only thing
 * that decides whether the agent offers useful work at the right moment or
 * litters every turn with chips. It is written to the same standard as the
 * browser tools' — what the tool is for, when not to reach for it, and what the
 * person on the other end will see.
 *
 * ## Why it lives in `main` and not in `core`
 *
 * Only because its neighbours do. `agentToolServers` is the seam Artemis hands
 * host tools across, and the composition root that owns it is here — see
 * `browserTools.ts` for the seam's real constraint, which is that a tool
 * touching a `WebContentsView` cannot live in a package forbidden from
 * importing Electron. This one imports no Electron and could move the day a
 * second host wants it.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { SUGGESTED_TASK_LIMITS } from '@rx-artemis/protocol';

/**
 * Build the suggested-task tool server.
 *
 * Takes nothing and closes over nothing, unlike its browser neighbour: a
 * suggestion is not addressed to a surface, and the call's own position in the
 * transcript is what says which conversation it belongs to. Still built per run
 * through the same seam, because that is where host tools are assembled and a
 * second path would be a second thing to keep in step.
 */
export function suggestedTaskToolServer(): McpServerConfig {
  return createSdkMcpServer({
    name: 'artemis-tasks',
    version: '1',
    instructions: INSTRUCTIONS,
    tools: suggestedTaskTools(),
  });
}

/**
 * The tool definition, before the SDK packages it.
 *
 * Addressable for the reason `browserTools` is: `createSdkMcpServer` swallows
 * the handlers into an opaque server, and the decisions worth asserting — what
 * a too-long title comes back as, what the agent is told it just did — are in
 * here rather than reachable through the object it returns.
 */
export function suggestedTaskTools() {
  return [
    tool(
      'suggest_task',
      DESCRIPTION,
      {
        title: z
          .string()
          .describe(
            `A few words naming the work, as a chip label — "Add tests for the parser", ` +
              `"Drop the duplicated retry helper". No more than ` +
              `${String(SUGGESTED_TASK_LIMITS.title)} characters; longer titles are trimmed.`,
          ),
        tldr: z
          .string()
          .describe(
            'One sentence on what the work involves and why it is worth doing. This is ' +
              'the only thing the person reads before deciding, so it should say what ' +
              'you saw, not restate the title.',
          ),
        prompt: z
          .string()
          .describe(
            'The message that starts the work, written as the user would write it to a ' +
              'fresh agent: it may be read in a new conversation with none of this one’s ' +
              'context, so name the files, the symptom and the goal rather than saying ' +
              '"the thing we discussed".',
          ),
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the seam is async
      async ({ title }) => ({
        content: [
          {
            type: 'text' as const,
            // Said plainly because the alternative is an agent that believes it
            // started something. Nothing ran, nothing was created, and the next
            // thing that happens is a person reading a chip — or not.
            text:
              `Offered “${title}” to the user as a suggested task. Nothing has started: ` +
              'they choose whether to run it, and where. Carry on — do not do this work ' +
              'now, and do not wait for an answer.',
          },
        ],
      }),
    ),
  ];
}

/** What the model is told the server is for, once, at connection. */
const INSTRUCTIONS =
  'Lets you offer the user follow-up work as a clickable task, at the end of a turn. ' +
  'Offering is not doing: the user decides whether it runs and whether it runs here, ' +
  'in a new conversation, or in a worktree.';

/**
 * The tool description — the only thing standing between this feature and a
 * chip under every message.
 *
 * Three rules, in the order they matter. **Out of scope** is the whole test: a
 * suggestion the agent could simply have done is a chore it declined to finish,
 * and an agent that offers those is worse than one with no tool at all.
 * **After the answer** keeps the chip where the reader is looking when they
 * finish reading. **Few** exists because the value of a suggestion is that it
 * was worth interrupting for, and four of them are worth nothing each.
 */
const DESCRIPTION =
  'Offer the user a follow-up task, shown as a clickable chip under your answer. They ' +
  'choose whether to run it, and whether it runs in this conversation, in a new one, or ' +
  'in a git worktree of its own.\n\n' +
  'Use it for work that is genuinely OUT OF SCOPE of what you were asked: something you ' +
  'noticed on the way that is worth doing and is not part of this request. A test suite ' +
  'the change now needs; a second call site with the same bug; a migration the schema ' +
  'change implies.\n\n' +
  'Do NOT use it for:\n' +
  '- work you were asked for and have not finished — do that instead\n' +
  '- work you could do right now in a sentence or two — just do it\n' +
  '- a question for the user — ask them\n' +
  '- restating what you did, or "let me know if you want…"\n\n' +
  'Call it after your answer, not before, and at most twice in a turn. Most turns should ' +
  'not call it at all: a chip is an interruption, and one that was not worth making is ' +
  'the reason the user turns the feature off. If nothing genuinely out of scope came up, ' +
  'say nothing.';
