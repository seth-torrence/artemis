/**
 * Splitting a worktree, against a real filesystem and a fake git.
 *
 * The split of the two is deliberate. The **filesystem** parts are real for the
 * reason `repo.test.ts` gives — finding the checkout and writing
 * `.git/info/exclude` are claims about what is on disk, and a mocked `fs` would
 * test the mock. **git** is injected, because what is worth pinning here is the
 * behaviour *around* the command: which directory it is run in, what is done
 * about a name already taken, and what the user is told when it fails. Running
 * real git would test git, take seconds, and make the suite depend on a binary
 * this module is careful to treat as optional.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorktree, WORKTREE_DIRNAME } from './worktree.js';

let root: string;
/** A clone: `.git` is a directory at its root. */
let clone: string;
/** A directory several levels inside it, which is where a session usually sits. */
let nested: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'artemis-worktree-'));
  clone = path.join(root, 'kronos');
  nested = path.join(clone, 'packages', 'core');
  await mkdir(path.join(clone, '.git', 'info'), { recursive: true });
  await mkdir(nested, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A git that always succeeds, recording what it was asked to do. */
function fakeGit(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => '');
}

describe('createWorktree', () => {
  it('splits from the checkout, not from the directory it was called in', async () => {
    const run = fakeGit();
    const result = await createWorktree(nested, 'task/add-tests', { run });

    expect(result).toEqual({
      ok: true,
      path: path.join(clone, WORKTREE_DIRNAME, 'task', 'add-tests'),
      branch: 'task/add-tests',
    });
    // The cwd is the repository root. A `git worktree add` run three levels
    // down would still work, and the point of pinning it is the *worktree*
    // case below, where "the directory it was called in" is a different repo.
    expect(run).toHaveBeenCalledWith(clone, [
      'worktree',
      'add',
      '-b',
      'task/add-tests',
      path.join(clone, WORKTREE_DIRNAME, 'task', 'add-tests'),
    ]);
  });

  it('keeps the worktree directory out of git status, without touching .gitignore', async () => {
    await createWorktree(clone, 'task/add-tests', { run: fakeGit() });

    const exclude = await readFile(path.join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain(`/${WORKTREE_DIRNAME}/`);
    // `.gitignore` is tracked; writing to it would put a line in the user's
    // next commit that they did not author. `info/exclude` is nobody's but
    // this checkout's.
    await expect(readFile(path.join(clone, '.gitignore'), 'utf8')).rejects.toThrow();
  });

  it('writes the exclude line once, however many worktrees are made', async () => {
    await createWorktree(clone, 'task/one', { run: fakeGit() });
    await createWorktree(clone, 'task/two', { run: fakeGit() });

    const exclude = await readFile(path.join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line.trim() === `/${WORKTREE_DIRNAME}/`)).toHaveLength(1);
  });

  it('keeps what the file already said, on its own line', async () => {
    const file = path.join(clone, '.git', 'info', 'exclude');
    // No trailing newline, which is the case that would otherwise glue the new
    // line onto the user's last one and silently change what it excludes.
    await writeFile(file, '# mine\n*.log');
    await createWorktree(clone, 'task/one', { run: fakeGit() });

    expect(await readFile(file, 'utf8')).toBe(`# mine\n*.log\n/${WORKTREE_DIRNAME}/\n`);
  });

  it('makes the worktree anyway when the exclude cannot be written', async () => {
    // A repository whose `.git` is a file — a linked worktree, a submodule —
    // has no `info` directory here to write to. Refusing the user their
    // worktree over a cosmetic `git status` entry would be the wrong trade.
    const bare = path.join(root, 'odd');
    await mkdir(bare, { recursive: true });
    await writeFile(path.join(bare, '.git'), 'gitdir: /nowhere\n');

    const result = await createWorktree(bare, 'task/one', { run: fakeGit() });
    expect(result.ok).toBe(true);
  });

  it('suffixes a name that is already taken rather than refusing', async () => {
    // The commonest collision by far: the same suggestion accepted twice.
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { stderr: "fatal: a branch named 'task/add-tests' already exists" }))
      .mockResolvedValueOnce('');

    const result = await createWorktree(clone, 'task/add-tests', { run });

    expect(result).toMatchObject({ ok: true, branch: 'task/add-tests-2' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips a directory that exists without spending a git call on it', async () => {
    const run = fakeGit();
    const taken = path.join(clone, WORKTREE_DIRNAME, 'task', 'add-tests');
    await mkdir(taken, { recursive: true });

    const result = await createWorktree(clone, 'task/add-tests', { run });

    expect(result).toMatchObject({ ok: true, branch: 'task/add-tests-2' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a failure that is not a collision the first time it happens', async () => {
    // Nineteen more attempts would fail identically and take nineteen times as
    // long to say so.
    const run = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { stderr: 'fatal: not a valid object name: HEAD' }));

    const result = await createWorktree(clone, 'task/add-tests', { run });

    expect(result).toEqual({ ok: false, message: 'fatal: not a valid object name: HEAD' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('names git rather than the syscall when git is not installed', async () => {
    // "spawn git ENOENT" is the one failure whose message names the wrong thing
    // entirely, and this channel's message goes straight to a person.
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));

    const result = await createWorktree(clone, 'task/add-tests', { run });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain('git is not on the PATH');
  });

  it('refuses a directory that is in no repository, and says which', async () => {
    const loose = path.join(root, 'notes');
    await mkdir(loose, { recursive: true });
    const run = fakeGit();

    const result = await createWorktree(loose, 'task/one', { run });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain(loose);
    // Nothing was attempted, which is what makes the message trustworthy.
    expect(run).not.toHaveBeenCalled();
  });

  it('gives up rather than making a twentieth copy of the same name', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { stderr: "fatal: directory 'x' already exists" }));

    const result = await createWorktree(clone, 'task/add-tests', { run });

    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(20);
  });
});
