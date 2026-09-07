/**
 * What is this directory called?
 *
 * ## Why the answer is not `basename(cwd)`
 *
 * The sidebar names the thing you are working on. For a directory that sits
 * inside a repository, the name of that thing is the repository's: in
 * `~/code/artemis/apps/desktop` you are working on *artemis*, and "desktop" is
 * the answer to a question nobody asked. Both names are here, and the caller
 * picks — {@link WorkspaceDescription.repoName} when there is one, otherwise
 * {@link WorkspaceDescription.name}.
 *
 * ## Why it does not shell out to git
 *
 * `git rev-parse --show-toplevel` is the obvious implementation and the wrong
 * one for something a UI calls on every directory change. It needs `git` on the
 * PATH — which is not guaranteed for a GUI app on macOS, where the process
 * environment is the launchd one rather than the shell's — it costs a process
 * spawn per keystroke-adjacent event, and it fails in ways that would have to
 * be told apart from "not a repository".
 *
 * Walking up looking for `.git` needs none of that. It is a handful of `stat`
 * calls, it cannot fail in a way worth reporting, and it agrees with git on
 * every layout Artemis can encounter:
 *
 *  - **A normal clone** has `.git/` at the root.
 *  - **A linked worktree** has a `.git` *file* at its root holding a `gitdir:`
 *    pointer. Both are accepted, because both mark a root — and a worktree
 *    deliberately reports its own name rather than the main checkout's. Two
 *    worktrees of one repository are two different places to be working, and
 *    the sidebar is naming a place; collapsing them to a shared repository name
 *    would make the two indistinguishable in the one view whose job is telling
 *    you where you are. It is also reported *as* a worktree — see
 *    {@link WorkspaceDescription.worktree} for the one caller that cares, and
 *    {@link WorkspaceDescription.projectRoot} for the checkout it was split
 *    off from, which is a different question with a different answer.
 *  - **Submodules** likewise have a `.git` file, and likewise are their own
 *    thing to be working in — and are deliberately not worktrees, which is why
 *    the pointer inside that file gets read rather than assumed.
 *
 * The one case it gets wrong is a bare repository pointed at by `GIT_DIR`, with
 * no `.git` anywhere above the cwd. Nobody runs an agent in one.
 *
 * ## Never throws
 *
 * A missing, unreadable, or nonsense path yields a description with no repo
 * rather than an error. The caller is a header label; the degraded answer is
 * "the directory's own name", which is what it showed before this module
 * existed. {@link checkWorkingDirectory} is the module that has opinions about
 * whether a path is usable, and it stays the only one.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { isForgeKind, parseRemoteUrl, type RepositoryOrigin } from '@rx-artemis/protocol';

import { isTemporaryPath } from './temp.js';

/** Names for one directory. See the module docs for which to prefer. */
export interface WorkspaceDescription {
  /** The path as asked about. */
  readonly path: string;
  /** The directory's own name — its last segment. */
  readonly name: string;
  /** Root of the repository containing `path`, when there is one. */
  readonly repoRoot?: string;
  /** Last segment of {@link repoRoot}. */
  readonly repoName?: string;
  /**
   * The *project* `path` belongs to — which is not always the place it is.
   *
   * Equal to {@link repoRoot} for every ordinary checkout, and for a submodule,
   * which is its own project by the same reasoning that makes it its own root.
   * For a **linked worktree** it is the main checkout the worktree was split
   * off from: a worktree of Artemis is still Artemis, and the sidebar groups a
   * session by the project it was working on rather than by the directory that
   * work happened in.
   *
   * That is the one distinction {@link repoRoot} cannot carry, because the two
   * answers are wanted at once and by different readers. The header names the
   * *place* — see the module docs on why a worktree is named after itself — and
   * the session list groups by the *project*, so a branch split off for an
   * afternoon does not read as a repository the user has never heard of.
   *
   * Absent only when there is no repository at all, where the caller's fallback
   * — the directory itself — is already the right answer. A worktree whose main
   * checkout cannot be derived falls back to {@link repoRoot}, which stands the
   * worktree on its own exactly as it did before this field existed; see
   * {@link readWorktreePointer} for the layouts that lands on.
   */
  readonly projectRoot?: string;
  /**
   * Is {@link repoRoot} a linked worktree rather than an ordinary checkout?
   *
   * Absent unless it is one, so the ordinary answer stays the ordinary shape.
   *
   * Naming does not use this — a worktree is still named after itself, for the
   * reasons in the module docs. The recent-folders list does: a worktree is a
   * *temporary* place to be working, made for one branch and deleted when that
   * branch lands, and a menu of "where have I been lately" that fills up with
   * directories which no longer exist is worse than one that never mentions
   * them. See `rememberFolder` in the renderer's store.
   */
  readonly worktree?: boolean;
  /**
   * The repository the project's `origin` remote points at, on whatever host
   * it points at. What lets a bare `#123` in a transcript become a link to
   * the pull request it names, spelled the way that host spells one — see
   * {@link readOriginRemote} for how it is read.
   */
  readonly origin?: RepositoryOrigin;
  /**
   * Is {@link path} inside the machine's temporary directory?
   *
   * Absent unless it is. The same caller and the same reason as
   * {@link worktree} — a directory the OS deletes is not one to offer somebody
   * a week later — but an independent fact: scratch checkouts are routinely
   * both, and plenty of temporary directories are no repository at all.
   *
   * See `isTemporaryPath`, including why it is answered from the path rather
   * than from the filesystem.
   */
  readonly temporary?: boolean;
}

/**
 * How far up to look for a repository root.
 *
 * A bound rather than a belief about real paths: the loop already terminates at
 * the filesystem root, and this only decides how much work a pathological path
 * can cost. Deep monorepo checkouts run to a dozen segments, so 64 is far past
 * anything real and still finite.
 */
const MAX_ASCENT = 64;

/**
 * Describe `path`: its own name, and its repository's if it is in one.
 *
 * @param path an absolute path. A relative one is described by name only —
 *             resolving it against *this* process's cwd would answer about a
 *             directory the user never named.
 */
export async function describeWorkspace(path: unknown): Promise<WorkspaceDescription> {
  const value = typeof path === 'string' ? path.trim() : '';
  const name = lastSegment(value);
  if (value.length === 0 || !isAbsolute(value)) return { path: value, name };

  // Before the repository walk rather than after, because it is the answer for
  // a scratch directory that is in no repository at all — which is most of them.
  const temporary = isTemporaryPath(value) ? ({ temporary: true } as const) : {};

  const found = await findRepositoryRoot(value);
  if (found === undefined) return { path: value, name, ...temporary };

  const { repoRoot, worktree, projectRoot } = found;
  const origin = await readOriginRemote(projectRoot ?? repoRoot);
  return {
    path: value,
    name,
    repoRoot,
    repoName: lastSegment(repoRoot),
    // `repoRoot` for everything that is not a worktree, which is the whole of
    // what "the project this is part of" means for an ordinary checkout.
    projectRoot: projectRoot ?? repoRoot,
    // Only when true, so an ordinary checkout keeps the shape it had before
    // these fields existed.
    ...(worktree ? { worktree: true } : {}),
    ...temporary,
    ...(origin === undefined ? {} : { origin }),
  };
}

/**
 * The `origin` remote's repository, straight out of `.git/config`.
 *
 * Read from the file rather than `git remote get-url` for the reasons the
 * module docs give for the whole walk: no `git` on PATH required, no process
 * spawn on a UI-adjacent path, and no failure taxonomy — every unhappy shape
 * is "no remote", which renders as exactly what rendered before.
 *
 * Read against the *project* root deliberately: a linked worktree's own
 * `.git` is a pointer file with no config in it, and the remote it pushes to
 * is the main checkout's. The one shape this leaves behind is a submodule,
 * whose config lives in the superproject's `.git/modules/…` — it degrades to
 * "no remote", which is honest enough for a link decoration.
 *
 * Any host produces an answer — this used to stop at `github.com`, on the
 * reasoning that `#123` → `/pull/123` is a GitHub convention and a link to
 * the wrong host is worse than none. Both halves were right and the
 * conclusion was not: every forge has *a* convention, `parseRemoteUrl` spells
 * the ones it can name, and a checkout on a Forgejo or a GitLab was getting
 * dead text for the one spelling people use. Where the host name does not
 * say what it runs, the repository can, in its own config:
 *
 *     [artemis]
 *         forge = gitlab
 *
 * and that word wins over the guess. See `forge.ts` in protocol for the
 * default a nameless host gets, and why.
 */
export async function readOriginRemote(root: string): Promise<RepositoryOrigin | undefined> {
  let config: string;
  try {
    config = await readFile(join(root, '.git', 'config'), 'utf8');
  } catch {
    return undefined;
  }

  // The url line of the `[remote "origin"]` section, wherever it sits. Git's
  // own format: sections in brackets, `key = value` lines beneath.
  const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1];
  const url = section === undefined ? undefined : /^\s*url\s*=\s*(.+?)\s*$/m.exec(section)?.[1];
  if (url === undefined) return undefined;

  // The repository's own word on what its host runs, when it has one.
  const own = /\[artemis\]([^[]*)/.exec(config)?.[1];
  const said = own === undefined ? undefined : /^\s*forge\s*=\s*(\S+)\s*$/m.exec(own)?.[1]?.toLowerCase();
  const hint = isForgeKind(said) ? said : undefined;

  return parseRemoteUrl(url, hint) ?? undefined;
}

/** A repository root, and which of the two kinds it is. */
interface RepositoryRoot {
  readonly repoRoot: string;
  readonly worktree: boolean;
  /**
   * The main checkout, when `repoRoot` is a linked worktree and it could be
   * derived. Absent for every other root, where `repoRoot` is the answer.
   */
  readonly projectRoot?: string;
}

/**
 * The nearest ancestor of `from` (inclusive) containing a `.git` entry.
 *
 * Ascends by `dirname` and stops when it stops moving, which is how a path
 * hits its root on both POSIX (`/`) and Windows (`C:\`, and a UNC share root)
 * without either being spelled out here.
 */
async function findRepositoryRoot(from: string): Promise<RepositoryRoot | undefined> {
  const { root } = parse(from);
  let current = from;

  for (let step = 0; step < MAX_ASCENT; step += 1) {
    // Either kind of `.git` marks a root: a directory in a normal clone, a
    // file in a linked worktree or a submodule.
    const marker = join(current, '.git');
    const kind = await entryKind(marker);
    if (kind === 'dir') return { repoRoot: current, worktree: false };
    if (kind === 'file') {
      const linked = await readWorktreePointer(marker);
      // A submodule, or a `.git` file that could not be read: same root, and
      // deliberately not a worktree. See `readWorktreePointer`.
      if (linked === undefined) return { repoRoot: current, worktree: false };
      return {
        repoRoot: current,
        worktree: true,
        ...(linked.mainRoot === undefined ? {} : { projectRoot: linked.mainRoot }),
      };
    }
    if (current === root) return undefined;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** What is at this path — a directory, something else, or nothing? */
async function entryKind(path: string): Promise<'dir' | 'file' | 'none'> {
  try {
    return (await stat(path)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

/** What a linked worktree's `.git` file says about where it came from. */
interface WorktreePointer {
  /** The checkout this worktree belongs to, when the layout reveals one. */
  readonly mainRoot?: string;
}

/**
 * Is this `.git` file a linked worktree's, rather than a submodule's — and if
 * so, which checkout was it split off from?
 *
 * Both are a file holding a `gitdir:` pointer, and telling them apart is the
 * whole reason this reads the file rather than stopping at "not a directory".
 * Git puts a worktree's real directory at `<repo>/.git/worktrees/<id>` and a
 * submodule's at `<super>/.git/modules/<path>`, so the `worktrees` segment is
 * the distinction — and it is git's own layout rather than a guess about
 * anyone's naming, which matters because a submodule is a permanent place to
 * be working and must keep behaving like one.
 *
 * A segment match, not a substring one: `~/code/worktrees-notes/…` is somebody's
 * ordinary project and contains the word.
 *
 * `undefined` means "not a worktree", and every failure reads that way — an
 * unreadable `.git` file is a repository this cannot describe, not a reason to
 * start dropping it from a menu.
 *
 * ## The main checkout, from the same pointer
 *
 * The layout above says where it is: `<repo>/.git/worktrees/<id>` names a git
 * directory two levels below `<repo>/.git`, so the checkout is that path's
 * grandparent with the `.git` taken off. Deriving it from the pointer costs
 * nothing beyond the read already being done, and it is the only route to the
 * answer — the worktree's own directory holds no other trace of where it came
 * from.
 *
 * Resolved against the worktree's directory, because the pointer is *usually*
 * absolute but not always: git can be asked for relative ones
 * (`worktree.useRelativePaths`), and `resolve` hands an absolute path straight
 * back, so this is correct for both without asking which it got.
 *
 * `mainRoot` is absent, rather than guessed at, in two cases:
 *
 *  - The pointer does not end in `worktrees/<id>` — some layout this does not
 *    recognise, where every answer would be invention.
 *  - The common git directory is not called `.git`, which is a worktree of a
 *    **bare** repository. There is no main checkout to name at all then, and
 *    the bare directory is reported instead: worktrees of one bare repo are
 *    still one project, which is the question this field answers.
 */
async function readWorktreePointer(marker: string): Promise<WorktreePointer | undefined> {
  let pointer: string | undefined;
  try {
    const contents = await readFile(marker, 'utf8');
    pointer = /^\s*gitdir:\s*(.+?)\s*$/mu.exec(contents)?.[1];
  } catch {
    return undefined;
  }
  if (pointer === undefined) return undefined;
  if (!pointer.split(/[\\/]/).includes('worktrees')) return undefined;

  const gitDir = resolve(dirname(marker), pointer);
  // `<common>/worktrees/<id>` — anything else is a layout this cannot read, and
  // it is still a worktree; only the checkout it belongs to is unknown.
  const worktrees = dirname(gitDir);
  if (lastSegment(worktrees) !== 'worktrees') return {};

  const common = dirname(worktrees);
  return { mainRoot: lastSegment(common) === '.git' ? dirname(common) : common };
}

/**
 * Last segment of a path.
 *
 * Not `node:path.basename`: that is platform-specific, and a profile or session
 * recorded on one platform is routinely read on another — `basename` on POSIX
 * returns the whole of `C:\Users\you\app`. Splitting on both separators is
 * correct for every path either platform can produce. Falls back to the input
 * so a root, or a string with nothing in it, still yields something to render.
 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}
