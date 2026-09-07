/**
 * Naming a directory, against a real filesystem.
 *
 * Same reasoning as `workdir.test.ts`: mocking `node:fs` would test the mock,
 * and the claim this module makes is about what is actually on disk. The two
 * shapes of `.git` — a directory in a clone, a file in a linked worktree — are
 * both built here rather than asserted about, because "we also accept the file"
 * is exactly the sort of statement that is true in a comment and false in code.
 *
 * Every fixture below sits under `tmpdir()`, so every description of one also
 * carries `temporary: true`. That is not incidental to the assertions — it is
 * the proof that the two facts are independent: a repository can perfectly well
 * be a repository *and* be somewhere that will not last. See `temp.test.ts` for
 * the flag's own tests.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeWorkspace, readOriginRemote } from './repo.js';

let root: string;
/** A clone: `.git` is a directory at its root. */
let clone: string;
/** A directory several levels inside that clone. */
let nested: string;
/** A linked worktree: `.git` is a file holding a `gitdir:` pointer. */
let worktree: string;
/** A directory inside that worktree. */
let insideWorktree: string;
/** A worktree whose pointer is written relative to its own directory. */
let relativeWorktree: string;
/** A worktree of a bare repository, which has no main checkout to name. */
let bareWorktree: string;
/** A worktree whose pointer is in no layout this can read past. */
let strangeWorktree: string;
/** A submodule: the same `.git` file shape, pointing somewhere else entirely. */
let submodule: string;
/** A `.git` file that is not a `gitdir:` pointer at all. */
let malformed: string;
/** An ordinary directory, in no repository at all. */
let plain: string;

beforeAll(async () => {
  // `mkdtemp` under `/var` on macOS, which is a symlink to `/private/var`. The
  // paths compared below all come back out of the same string, so the symlink
  // never enters the assertions.
  root = await mkdtemp(join(tmpdir(), 'artemis-repo-'));

  clone = join(root, 'artemis');
  nested = join(clone, 'apps', 'desktop');
  await mkdir(join(clone, '.git'), { recursive: true });
  await mkdir(nested, { recursive: true });

  worktree = join(root, 'artemis-fix-thing');
  insideWorktree = join(worktree, 'apps');
  await mkdir(insideWorktree, { recursive: true });
  await writeFile(join(worktree, '.git'), `gitdir: ${join(clone, '.git', 'worktrees', 'fix')}\n`);

  // Git writes an absolute pointer by default and a relative one on request
  // (`worktree.useRelativePaths`), so both spellings are real and both name the
  // same checkout.
  relativeWorktree = join(root, 'artemis-relative');
  await mkdir(relativeWorktree);
  await writeFile(join(relativeWorktree, '.git'), 'gitdir: ../artemis/.git/worktrees/rel\n');

  // A bare repository has no working tree of its own, so `<common>` is the
  // repository directory rather than a `.git` inside a checkout.
  bareWorktree = join(root, 'mirror-fix');
  await mkdir(bareWorktree);
  await writeFile(
    join(bareWorktree, '.git'),
    `gitdir: ${join(root, 'mirror.git', 'worktrees', 'fix')}\n`,
  );

  // Contains the segment, so it is a worktree — but not `<common>/worktrees/<id>`,
  // so there is nothing to derive a checkout from.
  strangeWorktree = join(root, 'artemis-odd');
  await mkdir(strangeWorktree);
  await writeFile(join(strangeWorktree, '.git'), `gitdir: ${join(clone, '.git', 'worktrees')}\n`);

  // Git points a submodule at `.git/modules/<path>`, never at `worktrees/`.
  submodule = join(root, 'vendor-lib');
  await mkdir(submodule);
  await writeFile(join(submodule, '.git'), `gitdir: ${join(clone, '.git', 'modules', 'vendor')}\n`);

  malformed = join(root, 'artemis-broken');
  await mkdir(malformed);
  await writeFile(join(malformed, '.git'), 'this is not a gitdir pointer\n');

  plain = join(root, 'notes');
  await mkdir(plain);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('describeWorkspace', () => {
  it('names the repository when the directory is its root', async () => {
    const result = await describeWorkspace(clone);
    expect(result).toEqual({
      path: clone,
      name: 'artemis',
      repoRoot: clone,
      repoName: 'artemis',
      // The same directory: an ordinary checkout is the project it is part of.
      projectRoot: clone,
      // Because the fixture lives under `tmpdir()`. See the module note.
      temporary: true,
    });
  });

  it('names the repository from several levels inside it', async () => {
    // The case the whole module exists for: `name` is the directory, `repoName`
    // is what the person would say they are working on.
    const result = await describeWorkspace(nested);
    expect(result.name).toBe('desktop');
    expect(result.repoName).toBe('artemis');
    expect(result.repoRoot).toBe(clone);
  });

  it('accepts a `.git` file, so a linked worktree is a repository too', async () => {
    const result = await describeWorkspace(worktree);
    expect(result.repoRoot).toBe(worktree);
    // Its own name, deliberately — two checkouts of one repository are two
    // different places to be working, and the sidebar is naming a place.
    expect(result.repoName).toBe('artemis-fix-thing');
  });

  it('reports a linked worktree as one, so the folder menu can decline it', async () => {
    expect((await describeWorkspace(worktree)).worktree).toBe(true);
  });

  it('reports a directory inside a worktree as one too', async () => {
    // The cwd is routinely below the checkout root, and everything under a
    // worktree goes away when the worktree does.
    const result = await describeWorkspace(insideWorktree);
    expect(result.repoRoot).toBe(worktree);
    expect(result.worktree).toBe(true);
  });

  it('points a linked worktree at the checkout it was split off from', async () => {
    // The place is the worktree; the *project* is the repository it belongs to.
    // A session run in a worktree of Artemis is still a session on Artemis, and
    // the sidebar groups by the second of those two facts.
    const result = await describeWorkspace(worktree);
    expect(result.repoRoot).toBe(worktree);
    expect(result.projectRoot).toBe(clone);
  });

  it('points a directory inside a worktree at the same checkout', async () => {
    expect((await describeWorkspace(insideWorktree)).projectRoot).toBe(clone);
  });

  it('resolves a relative `gitdir:` pointer against the worktree', async () => {
    const result = await describeWorkspace(relativeWorktree);
    expect(result.worktree).toBe(true);
    expect(result.projectRoot).toBe(clone);
  });

  it('names the bare repository when a worktree has no main checkout', async () => {
    // Nothing is checked out at `mirror.git`, so there is no working tree to
    // name — but every worktree of it is still one project, which is the
    // question this field answers.
    expect((await describeWorkspace(bareWorktree)).projectRoot).toBe(join(root, 'mirror.git'));
  });

  it('leaves a worktree standing alone when the layout says nothing', async () => {
    // Still a worktree, so the folder menu still declines it; simply no checkout
    // to attribute it to, which reads as the worktree being its own project
    // rather than as a guess.
    const result = await describeWorkspace(strangeWorktree);
    expect(result.worktree).toBe(true);
    expect(result.projectRoot).toBe(strangeWorktree);
  });

  it('makes a submodule its own project, as it is its own root', async () => {
    expect((await describeWorkspace(submodule)).projectRoot).toBe(submodule);
  });

  it('names the repository as the project from inside a subdirectory', async () => {
    // Same answer as `repoRoot` here, and the one the sidebar groups on: work in
    // `apps/desktop` is work on artemis.
    expect((await describeWorkspace(nested)).projectRoot).toBe(clone);
  });

  it('does not call a submodule a worktree, though it has the same `.git` file', async () => {
    // The distinction the pointer is read for: a submodule is a permanent place
    // to be working, and a menu that forgot it would be losing a real project.
    const result = await describeWorkspace(submodule);
    expect(result.repoRoot).toBe(submodule);
    expect(result.worktree).toBeUndefined();
  });

  it('does not call a plain clone a worktree', async () => {
    expect((await describeWorkspace(clone)).worktree).toBeUndefined();
  });

  it('treats an unreadable `.git` pointer as an ordinary checkout', async () => {
    // "Cannot tell" has to mean "record it". Dropping a directory from the menu
    // on the strength of a file this could not parse would lose real projects
    // to a malformed line.
    const result = await describeWorkspace(malformed);
    expect(result.repoRoot).toBe(malformed);
    expect(result.worktree).toBeUndefined();
  });

  it('reports no repository for an ordinary directory', async () => {
    const result = await describeWorkspace(plain);
    expect(result).toEqual({ path: plain, name: 'notes', temporary: true });
    expect(result.repoName).toBeUndefined();
  });

  it('stops at the filesystem root rather than walking off the top', async () => {
    const result = await describeWorkspace('/');
    expect(result.repoName).toBeUndefined();
    expect(result.name).toBe('/');
  });

  it('describes a path that does not exist, without failing', async () => {
    // A stale `cwd` from a restored session is ordinary. The header still needs
    // a label, and "the last segment" is the right one.
    const missing = join(root, 'gone', 'missing');
    const result = await describeWorkspace(missing);
    expect(result).toEqual({ path: missing, name: 'missing', temporary: true });
  });

  it('describes a relative path by name only', async () => {
    // Resolving it against *this* process's cwd would answer about a directory
    // the user never named.
    const result = await describeWorkspace('src/components');
    expect(result).toEqual({ path: 'src/components', name: 'components' });
  });

  it('survives a value that is not a string', async () => {
    expect(await describeWorkspace(undefined)).toEqual({ path: '', name: '' });
    expect(await describeWorkspace(42)).toEqual({ path: '', name: '' });
  });
});

describe('readOriginRemote', () => {
  async function withRepo(config: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'artemis-remote-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'config'), config);
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it.each([
    ['https', 'https://github.com/Rx-Ventures/artemis.git'],
    ['ssh scp-form', 'git@github.com:Rx-Ventures/artemis.git'],
    ['ssh url-form', 'ssh://git@github.com/Rx-Ventures/artemis'],
    ['no .git suffix', 'https://github.com/Rx-Ventures/artemis'],
  ])('reads the origin coordinates from a %s remote', async (_kind, url) => {
    await withRepo(`[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`, async (root) => {
      expect(await readOriginRemote(root)).toEqual({
        host: 'github.com',
        owner: 'Rx-Ventures',
        repo: 'artemis',
        kind: 'github',
        web: 'https://github.com/Rx-Ventures/artemis',
      });
    });
  });

  it('reads an origin on any other host, spelled for that host', async () => {
    // The case this used to refuse: a self-hosted Forgejo reached over plain
    // http on a LAN address and port, and a GitLab with nested groups.
    await withRepo('[remote "origin"]\n\turl = http://100.82.237.80:8300/david/cortex.git\n', async (root) => {
      expect(await readOriginRemote(root)).toEqual({
        host: '100.82.237.80:8300',
        owner: 'david',
        repo: 'cortex',
        kind: 'unknown',
        web: 'http://100.82.237.80:8300/david/cortex',
      });
    });
    await withRepo('[remote "origin"]\n\turl = git@gitlab.com:group/sub/r.git\n', async (root) => {
      expect(await readOriginRemote(root)).toMatchObject({ owner: 'group/sub', repo: 'r', kind: 'gitlab' });
    });
  });

  it('lets the repository say what its host runs', async () => {
    await withRepo('[remote "origin"]\n\turl = https://git.example.com/o/r.git\n[artemis]\n\tforge = gitlab\n', async (root) => {
      expect((await readOriginRemote(root))?.kind).toBe('gitlab');
    });
    // A word this does not know is not a kind; the host's own reading stands.
    await withRepo('[remote "origin"]\n\turl = https://git.example.com/o/r.git\n[artemis]\n\tforge = svn\n', async (root) => {
      expect((await readOriginRemote(root))?.kind).toBe('unknown');
    });
  });

  it('answers nothing for another remote name, a remote that is no URL, or no repo at all', async () => {
    await withRepo('[remote "upstream"]\n\turl = https://github.com/o/r.git\n', async (root) => {
      expect(await readOriginRemote(root)).toBeUndefined();
    });
    await withRepo('[remote "origin"]\n\turl = /srv/git/r.git\n', async (root) => {
      expect(await readOriginRemote(root)).toBeUndefined();
    });
    expect(await readOriginRemote(join(tmpdir(), 'artemis-no-such-dir'))).toBeUndefined();
  });

  it('lands on the describe result for a checkout with an origin', async () => {
    await withRepo('[remote "origin"]\n\turl = git@github.com:owner/repo.git\n', async (root) => {
      const described = await describeWorkspace(root);
      expect(described.origin).toMatchObject({ owner: 'owner', repo: 'repo', kind: 'github' });
    });
  });
});
