/**
 * Splitting a worktree off a repository.
 *
 * One function, called from one place: a suggested task the user chose to run
 * somewhere it cannot collide with what is already checked out. See
 * `@rx-artemis/protocol`'s `suggestedTasks` for what a suggested task is, and
 * the renderer's task chip for the choice this serves.
 *
 * ## Why this one shells out to git when `repo.ts` refuses to
 *
 * `describeWorkspace` walks directories on purpose — it runs on every change of
 * working directory, and a label must not depend on a binary being on the PATH.
 * None of that applies here. Creating a worktree *is* a git operation: it
 * writes refs and administrative files under `.git`, and re-implementing that
 * against git's private layout would be a promise this file cannot keep across
 * versions. So it runs `git`, once, on a click — and a machine without git gets
 * a plain failure rather than a corrupted repository.
 *
 * ## Where the worktree goes, and why nothing is dirtied by it
 *
 * `<checkout>/.worktrees/<branch-slug>` — beside the code it is a copy of, so
 * it is findable, and inside the checkout so it moves with it. That would
 * ordinarily leave an untracked directory in every `git status` from the moment
 * the feature is first used, which is exactly the kind of trace a tool has no
 * business leaving in someone's repository. So the path is added to
 * `.git/info/exclude` instead of to `.gitignore`: `info/exclude` is git's own
 * per-checkout ignore file, it is not tracked, it is not shared, and writing to
 * it changes nothing anybody would commit. A repository that already excludes
 * the path is left alone.
 *
 * ## The branch is a request, not an instruction
 *
 * A name in use is suffixed — `task/add-tests`, then `task/add-tests-2` — and
 * so is a directory that already exists. Refusing instead would produce an
 * error whose only remedy is for the user to invent a different name for the
 * same piece of work, which is not a decision anybody wants to be asked to
 * make. What is never done is *reusing* an existing branch or directory: the
 * whole point of the choice was that this work starts somewhere clean.
 */

import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describeWorkspace } from './repo.js';

const execFileAsync = promisify(execFile);

/** Directory under the checkout that holds worktrees Artemis made. */
export const WORKTREE_DIRNAME = '.worktrees';

/** The `.git/info/exclude` line that keeps {@link WORKTREE_DIRNAME} out of `git status`. */
const EXCLUDE_LINE = `/${WORKTREE_DIRNAME}/`;

/**
 * How many suffixed names to try before giving up.
 *
 * A bound rather than a belief: past a handful of collisions the user is not
 * looking at a name clash, they are looking at a repository already full of
 * these, and quietly creating a twelfth is not the helpful answer.
 */
const MAX_ATTEMPTS = 20;

/** Long enough for a large checkout, short enough that a hung git is not forever. */
const GIT_TIMEOUT_MS = 60_000;

/** Where a new worktree landed, or why there is not one. */
export type WorktreeResult =
  | { readonly ok: true; readonly path: string; readonly branch: string }
  | { readonly ok: false; readonly message: string };

/**
 * Create a worktree of the repository containing `from`, on a new branch.
 *
 * `from` may be anywhere inside the repository, including inside an existing
 * worktree of it — the split is always taken from the **main checkout**, which
 * is what `describeWorkspace` calls the project root. Splitting a worktree off
 * a worktree is legal in git and is very rarely what somebody meant: it would
 * bury the second copy inside the first, and deleting the first would take both.
 *
 * Never throws. Every failure a user can cause — no repository, no git, a
 * repository with no commits yet — comes back as a message fit to show.
 */
export async function createWorktree(
  from: string,
  branch: string,
  deps: { readonly run?: GitRunner; readonly exists?: (p: string) => Promise<boolean> } = {},
): Promise<WorktreeResult> {
  const run = deps.run ?? runGit;
  const exists = deps.exists ?? pathExists;

  const workspace = await describeWorkspace(from);
  const root = workspace.projectRoot ?? workspace.repoRoot;
  if (root === undefined) {
    return { ok: false, message: `${from} is not inside a git repository.` };
  }

  const base = path.join(root, WORKTREE_DIRNAME);
  // Before the first `git worktree add`, so the directory git is about to
  // create is already excluded when it appears rather than a moment later.
  await excludeWorktreeDir(root);

  let lastMessage = 'git could not create a worktree here.';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? branch : `${branch}-${String(attempt)}`;
    const target = path.join(base, name.replaceAll('/', path.sep));

    // Cheap, and the common collision: the same suggestion accepted twice.
    // Skipping straight past it keeps the loop's `git` calls to one per real
    // attempt rather than one per name.
    if (await exists(target)) continue;

    try {
      await run(root, ['worktree', 'add', '-b', name, target]);
      return { ok: true, path: target, branch: name };
    } catch (error) {
      const message = describeGitFailure(error);
      // A name already spoken for is the one failure worth retrying, and it is
      // the only one the loop is here for. Everything else — no git, a bare
      // repository, no commit to branch from — repeats identically nineteen
      // more times, so it is reported the first time it happens.
      if (!isNameTaken(message)) return { ok: false, message };
      lastMessage = message;
    }
  }

  return { ok: false, message: lastMessage };
}

/** How this module runs git. Injected so the collision path is testable. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/**
 * Run one git command in a repository.
 *
 * `GIT_TERMINAL_PROMPT=0` for the reason every other spawned CLI in Artemis
 * gets it: a git that decides to ask for a credential has nowhere to ask, and
 * without this it waits for an answer from a terminal that does not exist.
 */
async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });
  return stdout;
}

/**
 * Keep the worktree directory out of the repository's status.
 *
 * Best effort, and deliberately silent when it fails: a read-only `.git`, or a
 * repository whose `info` directory is not writable, is a reason to leave a
 * directory showing in `git status` — not a reason to refuse the user the
 * worktree they asked for.
 */
async function excludeWorktreeDir(root: string): Promise<void> {
  const file = path.join(root, '.git', 'info', 'exclude');
  try {
    const current = await readFile(file, 'utf8').catch(() => '');
    // Line-exact, so a repository that already excludes this is untouched and
    // a repository excluding something that merely contains the text is not
    // mistaken for one that does.
    if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return;
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${prefix}${EXCLUDE_LINE}\n`);
  } catch {
    // See the doc comment: a repository that cannot be written to still gets
    // its worktree.
  }
}

async function pathExists(target: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a git failure was "that name is taken".
 *
 * Matched on the message because git says so in words and reports it with the
 * same exit code as everything else. Both spellings are here because git uses
 * one for the branch and one for the directory, and a caller retrying needs
 * neither of them to be the end of the attempt.
 */
function isNameTaken(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('already exists') ||
    text.includes('is already checked out') ||
    text.includes('already used by worktree')
  );
}

/**
 * A sentence for a failed git call.
 *
 * git puts the useful part on stderr and the useless part in the exit code, so
 * stderr is preferred and trimmed to its first lines — the rest is a usage
 * dump nobody reads in a toast. `ENOENT` is special-cased because "spawn git
 * ENOENT" is the one failure whose message names the wrong thing entirely.
 */
function describeGitFailure(error: unknown): string {
  if (isEnoent(error)) {
    return 'git is not on the PATH, so Artemis cannot create a worktree here.';
  }
  const stderr = readField(error, 'stderr');
  const text = (stderr === '' ? readField(error, 'message') : stderr).trim();
  if (text === '') return 'git could not create a worktree here.';
  return text.split('\n').slice(0, 3).join(' ').trim();
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function readField(error: unknown, field: 'stderr' | 'message'): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}
