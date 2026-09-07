import { describe, expect, it } from 'vitest';

import {
  forgeKindFor,
  githubRepository,
  parseRemoteUrl,
  pullRequestUrl,
  siblingRepository,
} from './forge.js';

describe('parseRemoteUrl', () => {
  it.each([
    ['https', 'https://github.com/Rx-Ventures/artemis.git', 'github.com', 'Rx-Ventures', 'artemis', 'github', 'https://github.com/Rx-Ventures/artemis'],
    ['scp form', 'git@github.com:Rx-Ventures/artemis.git', 'github.com', 'Rx-Ventures', 'artemis', 'github', 'https://github.com/Rx-Ventures/artemis'],
    ['ssh url', 'ssh://git@github.com/Rx-Ventures/artemis', 'github.com', 'Rx-Ventures', 'artemis', 'github', 'https://github.com/Rx-Ventures/artemis'],
    ['a LAN forge over http with a port', 'http://100.82.237.80:8300/david/cortex.git', '100.82.237.80:8300', 'david', 'cortex', 'unknown', 'http://100.82.237.80:8300/david/cortex'],
    ['a forge that says what it is', 'https://git.example.com/david/cortex', 'git.example.com', 'david', 'cortex', 'unknown', 'https://git.example.com/david/cortex'],
    ['codeberg', 'https://codeberg.org/forgejo/forgejo', 'codeberg.org', 'forgejo', 'forgejo', 'forgejo', 'https://codeberg.org/forgejo/forgejo'],
    ['a gitlab subgroup', 'git@gitlab.com:group/sub/project.git', 'gitlab.com', 'group/sub', 'project', 'gitlab', 'https://gitlab.com/group/sub/project'],
    ['ssh with a port, which is not the web port', 'ssh://git@git.example.com:2222/o/r.git', 'git.example.com', 'o', 'r', 'unknown', 'https://git.example.com/o/r'],
    ['bitbucket', 'https://bitbucket.org/team/repo.git', 'bitbucket.org', 'team', 'repo', 'bitbucket', 'https://bitbucket.org/team/repo'],
    ['a token in the url, which the web address must not carry', 'https://david:tok@100.82.237.80:8300/david/cortex.git', '100.82.237.80:8300', 'david', 'cortex', 'unknown', 'http://100.82.237.80:8300/david/cortex'.replace('http://', 'https://')],
  ])('reads %s', (_name, url, host, owner, repo, kind, web) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, repo, kind, web });
  });

  it('lets a hint override the kind the host name gave away', () => {
    expect(parseRemoteUrl('https://git.example.com/o/r', 'gitlab')?.kind).toBe('gitlab');
    expect(pullRequestUrl(parseRemoteUrl('https://git.example.com/o/r', 'gitlab')!, 4)).toBe(
      'https://git.example.com/o/r/-/merge_requests/4',
    );
  });

  it.each([
    ['a Windows path', 'C:\\Users\\me\\repo'],
    ['a local path', '/srv/git/repo.git'],
    ['a bare word', 'origin'],
    ['a host and nothing else', 'https://github.com/'],
    ['one segment', 'https://github.com/only'],
    ['a segment that is an option', 'https://github.com/-evil/repo'],
    ['a traversal', 'https://github.com/../repo'],
    ['ftp', 'ftp://github.com/o/r'],
  ])('refuses %s', (_name, url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});

describe('forgeKindFor', () => {
  it('reads the well-known names, with or without a port', () => {
    expect(forgeKindFor('github.com')).toBe('github');
    expect(forgeKindFor('GitLab.com')).toBe('gitlab');
    expect(forgeKindFor('gitlab.example.com:8443')).toBe('gitlab');
    expect(forgeKindFor('bitbucket.org')).toBe('bitbucket');
    expect(forgeKindFor('codeberg.org')).toBe('forgejo');
    expect(forgeKindFor('gitea.internal')).toBe('forgejo');
    expect(forgeKindFor('100.82.237.80:8300')).toBe('unknown');
  });
});

describe('pullRequestUrl', () => {
  it('spells the page the way each forge does', () => {
    const at = (url: string, hint?: Parameters<typeof parseRemoteUrl>[1]) => pullRequestUrl(parseRemoteUrl(url, hint)!, 141);
    expect(at('https://github.com/o/r')).toBe('https://github.com/o/r/pull/141');
    expect(at('https://gitlab.com/g/s/r')).toBe('https://gitlab.com/g/s/r/-/merge_requests/141');
    expect(at('https://bitbucket.org/t/r')).toBe('https://bitbucket.org/t/r/pull-requests/141');
    expect(at('https://codeberg.org/o/r')).toBe('https://codeberg.org/o/r/pulls/141');
    // The default for a server that does not say what it is: the shape the
    // self-hostable forges share.
    expect(at('http://100.82.237.80:8300/david/cortex.git')).toBe('http://100.82.237.80:8300/david/cortex/pulls/141');
  });
});

describe('naming another repository', () => {
  it('keeps a sibling on the same forge, scheme and all', () => {
    const cortex = parseRemoteUrl('http://100.82.237.80:8300/david/cortex.git')!;
    expect(siblingRepository(cortex, 'david', 'medulla')).toEqual({
      host: '100.82.237.80:8300', owner: 'david', repo: 'medulla', kind: 'unknown', web: 'http://100.82.237.80:8300/david/medulla',
    });
  });

  it('puts a repository with no checkout to speak for it on github.com', () => {
    expect(pullRequestUrl(githubRepository('Rx-Ventures', 'cerebro'), 7)).toBe('https://github.com/Rx-Ventures/cerebro/pull/7');
  });
});
