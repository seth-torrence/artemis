/**
 * Workspace: facts about the directory an agent is pointed at.
 *
 * ```ts
 * const check = await checkWorkingDirectory(input.cwd)
 * if (!check.ok) throw new RunError('invalid_request', check.message)
 * ```
 *
 * Three modules, three questions about the same directory:
 *
 *  - `workdir.ts` — *can* it be used? Asked before a provider subprocess is
 *    spawned with it, because `spawn`'s error for a bad cwd is indistinguishable
 *    from its error for a missing binary.
 *  - `repo.ts` — what is it *called*? Asked by the sidebar, which heads a
 *    session list with the name of the repository rather than of the directory.
 *  - `temp.ts` — will it *last*? Asked by the recent-folders menu, which is
 *    offering to take somebody back there later. `repo.ts` folds the answer
 *    into its own, so the UI asks one question rather than two.
 *
 * All three answer rather than throw, and none needs `git` on the PATH.
 *
 * `worktree.ts` is the exception that proves the last clause: it *makes* a
 * directory rather than describing one, it is the only thing here that runs
 * `git`, and it is called on a click. It answers rather than throws like the
 * rest.
 */

export * from './workdir.js';
export * from './repo.js';
export * from './temp.js';
export * from './worktree.js';
