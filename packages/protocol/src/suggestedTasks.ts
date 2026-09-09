/**
 * Suggested tasks — the follow-up work an agent offers at the end of a turn.
 *
 * An agent that has just finished something usually knows what it noticed on
 * the way and chose not to do: the test it did not write, the duplicated helper
 * it did not fold, the migration the change now needs. Saying so in prose puts
 * the burden back on the reader, who has to retype it as a prompt. A suggested
 * task is the same observation offered as *work* — a title, a sentence, and the
 * prompt that would start it — so accepting one is a click.
 *
 * ## The mechanism is a tool call, and that is the whole design
 *
 * The agent offers a task by calling {@link SUGGESTED_TASK_TOOL}, an in-process
 * MCP tool Artemis hands it per run (see `apps/desktop/main/taskTools.ts`).
 * Nothing is parsed out of the model's prose, and nothing rides a side channel.
 * Three things follow from that, and each of them is why it was built this way:
 *
 *  1. **It persists for free.** A tool call is in the provider's own transcript,
 *     so a reopened conversation replays it as `tool.start` / `tool.end` like
 *     any other call and the chips come back. Nothing in Artemis stores them,
 *     which means nothing in Artemis can lose them or disagree with the file.
 *  2. **It is per message, in place.** The call sits where the agent made it —
 *     under the answer it followed — rather than in a widget list beside the
 *     conversation that has to be invalidated when anything moves.
 *  3. **It degrades honestly.** A provider that cannot be handed tools never
 *     sees this one, offers no tasks, and shows no chips. That is
 *     {@link import('./provider.js').Capabilities.taskSuggestions}.
 *
 * ## Why `suggest_task` and not `spawn_task`
 *
 * Claude Code's desktop app has the same feature, built the same way — an MCP
 * tool its host injects — and names it `spawn_task`. Artemis does not, because
 * here the name would be a lie about who decides. Calling this tool starts
 * nothing: it *offers*, and the person picks whether the work happens in this
 * conversation, in a new one, or in a worktree — see {@link SuggestedTaskTarget}.
 * An agent told it can spawn sessions will write as though it has, and the chip
 * would then be a record of something that never happened.
 *
 * For the same reason the tool takes no working directory. Claude Code's does,
 * and it is the field behind its confirmation dialog naming one directory while
 * the work starts in another. Where a conversation happens is the user's
 * standing choice, held by the column; a suggestion has no business moving it.
 */

import type { JsonObject, JsonValue } from './json.js';

/**
 * The MCP server name Artemis registers the task tool under.
 *
 * The key, not the display name: the SDK addresses a tool as
 * `mcp__<key>__<tool>`, so this string is what appears in permission rules and
 * in every transcript that carries a suggestion. It is therefore a contract —
 * changing it silently retires every chip in every stored conversation.
 */
export const SUGGESTED_TASK_SERVER = 'artemisTasks';

/** The tool an agent calls to offer follow-up work. See the module docs. */
export const SUGGESTED_TASK_TOOL = `mcp__${SUGGESTED_TASK_SERVER}__suggest_task`;

/** One piece of follow-up work, as the agent described it. */
export interface SuggestedTask {
  /** A few words naming the work. What the chip reads. */
  readonly title: string;
  /** One sentence on what it involves and why it is worth doing. */
  readonly tldr: string;
  /** The prompt that starts the work — what a chosen chip sends. */
  readonly prompt: string;
}

/**
 * Where a chosen task runs.
 *
 * The four are not variations on one action; they differ in what they cost the
 * conversation on screen, which is the only thing a person is really choosing
 * between:
 *
 *  - `here`      — the prompt goes into *this* conversation, as the next turn.
 *                  Cheapest, and wrong when the task is a different subject.
 *  - `session`   — a fresh conversation beside this one, same directory, same
 *                  account. This conversation is untouched.
 *  - `worktree`  — a fresh conversation in a new git worktree of this
 *                  repository, on its own branch. The work cannot collide with
 *                  what is in the checkout. Needs a repository.
 *  - `server`    — a fresh conversation on an Artemis Server: another machine
 *                  entirely. Needs a server profile.
 *
 * The first three send the prompt. `server` is the one that does not: it opens
 * the column and puts the prompt in its composer for the user to review and
 * send. Which served account runs the work, on which model, at what thinking
 * level, is the choice a person moves work to a server in order to make — and
 * on a column that has just been opened, none of those answers exists yet. See
 * `startSuggestedTask` in the renderer's store for the two concrete faults
 * sending anyway produced.
 */
export const SUGGESTED_TASK_TARGETS = ['here', 'session', 'worktree', 'server'] as const;

/** See {@link SUGGESTED_TASK_TARGETS}. */
export type SuggestedTaskTarget = (typeof SUGGESTED_TASK_TARGETS)[number];

/** Runtime type guard for {@link SuggestedTaskTarget}. */
export function isSuggestedTaskTarget(value: unknown): value is SuggestedTaskTarget {
  return (
    typeof value === 'string' && (SUGGESTED_TASK_TARGETS as readonly string[]).includes(value)
  );
}

/**
 * Caps on what a suggestion may carry.
 *
 * A chip is a line of UI and a prompt is a message; neither has anywhere to put
 * an essay. These are enforced on the way *in* — see {@link parseSuggestedTask}
 * — rather than by the renderer clipping text, so what is stored is what is
 * shown and a stored transcript cannot surprise a later build.
 */
export const SUGGESTED_TASK_LIMITS = {
  title: 80,
  tldr: 240,
  prompt: 4000,
} as const;

/**
 * Read a suggestion out of a tool call's arguments.
 *
 * `null` for anything that is not one — the wrong shape, a missing field, a
 * title that is only whitespace. The caller is drawing a chip, and a chip with
 * no words on it is worse than no chip: the transcript would carry a control
 * that says nothing and does something.
 *
 * Over-long fields are truncated rather than refused. The agent got the *work*
 * right and the length wrong, and throwing away a good suggestion over a
 * verbose summary would be the wrong trade — see {@link SUGGESTED_TASK_LIMITS}.
 */
export function parseSuggestedTask(input: JsonValue | undefined): SuggestedTask | null {
  if (!isJsonObject(input)) return null;

  const title = clip(input['title'], SUGGESTED_TASK_LIMITS.title);
  const prompt = clip(input['prompt'], SUGGESTED_TASK_LIMITS.prompt);
  // A title and a prompt are the two the chip cannot be drawn without: one is
  // what it says, the other is what it does. A missing summary is a suggestion
  // that explains itself badly, which is survivable.
  if (title === '' || prompt === '') return null;

  return { title, tldr: clip(input['tldr'], SUGGESTED_TASK_LIMITS.tldr), prompt };
}

/** Narrow to the one JSON shape a tool's arguments can be. */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A branch name for the worktree a task would be started in.
 *
 * Derived from the title so the branch says what the work is, and reduced to
 * the conservative subset every git host and filesystem agrees on: lowercase
 * ASCII, digits and single dashes. `git check-ref-format` rejects far less than
 * this, but a branch also becomes a directory name and, later, a URL, and the
 * cost of being strict here is a slightly duller name.
 *
 * Prefixed rather than bare so a repository's branch list stays readable about
 * where these came from, and suffixed by the caller when the name is taken —
 * see `createWorktree`, which owns collisions because only it can see them.
 *
 * Falls back to the prefix alone for a title with nothing usable in it, which
 * is a title in a script this cannot transliterate rather than a bug.
 */
export function suggestedTaskBranch(title: string, prefix = 'task'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    // The slice can leave a trailing dash where it cut mid-word, and a branch
    // ending in one is legal but reads as truncation damage.
    .replace(/-+$/, '');
  return slug === '' ? prefix : `${prefix}/${slug}`;
}

/** A string field, trimmed and capped. `''` for anything that is not one. */
function clip(value: JsonValue | undefined, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
