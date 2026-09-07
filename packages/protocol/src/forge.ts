/**
 * Where a repository lives, read off its remote — on any host, not one.
 * ============================================================================
 *
 * A bare `#123` in a transcript becomes a link to the pull request it names,
 * and it needs to know two things to do it: which repository, and what that
 * repository's host calls a pull request's page. The first version answered
 * both by recognising `github.com` and nothing else, so a checkout whose
 * `origin` was a Forgejo, a GitLab or a Gitea produced dead text — the one
 * spelling people actually use, on the hosts people actually self-host.
 *
 * This module is the general answer, and it is pure: {@link parseRemoteUrl}
 * turns the three spellings git uses for a remote into a {@link RepositoryOrigin}
 * on whatever host they name, and {@link pullRequestUrl} spells the page the
 * way that host does. No environment is assumed — the package compiles with
 * `"types": []` — which is why the URL grammar is a regular expression rather
 * than `new URL()`.
 *
 * ## What a host is taken to be
 *
 * The page a forge serves a pull request at is a convention of the *software*,
 * not the host name, and a self-hosted server tells nobody what it runs. So
 * the kind is read from the name where the name says it (`github.com`,
 * `gitlab.com`, `bitbucket.org`, `codeberg.org`, anything with `gitlab`,
 * `gitea` or `forgejo` in it), and everything else is `unknown` — which is
 * spelled the Gitea/Forgejo way, `/pulls/<n>`, because that is the shape the
 * self-hostable forges share (Gogs, Gitea and Forgejo alike) and the one a
 * bare IP-and-port origin has turned out to be in practice. A repository can
 * say otherwise in its own config:
 *
 *     [artemis]
 *         forge = gitlab
 *
 * which the reader in core honours over the guess. Wrong-host links are the
 * failure this module is written against; a guess that is wrong is one line
 * of git config away from right, and a guess withheld is dead text forever.
 */

/** The forges whose pull-request pages this can spell. */
export type ForgeKind = 'github' | 'gitlab' | 'bitbucket' | 'forgejo' | 'unknown';

/** One repository, as its remote names it. */
export interface RepositoryOrigin {
  /** Host as it appears in a web address, port included: `100.82.237.80:8300`. */
  readonly host: string;
  /**
   * Everything between the host and the repository. One segment on most
   * forges; GitLab nests groups, so `group/subgroup` is an owner too.
   */
  readonly owner: string;
  readonly repo: string;
  readonly kind: ForgeKind;
  /** The repository's own page: `https://github.com/o/r`, `http://host:8300/o/r`. */
  readonly web: string;
}

/** The set {@link ForgeKind} is, for a reader checking a config value. */
export const FORGE_KINDS: readonly ForgeKind[] = ['github', 'gitlab', 'bitbucket', 'forgejo', 'unknown'];

export function isForgeKind(value: unknown): value is ForgeKind {
  return typeof value === 'string' && (FORGE_KINDS as readonly string[]).includes(value);
}

/**
 * Which forge a host name gives away.
 *
 * Only the name. `unknown` is an honest answer and the common one for a
 * self-hosted server, and callers spell it the Gitea/Forgejo way — see the
 * module note for why that default and not another.
 */
export function forgeKindFor(host: string): ForgeKind {
  const name = host.toLowerCase().replace(/:\d+$/, '');
  if (name === 'github.com' || name.endsWith('.github.com')) return 'github';
  if (name === 'gitlab.com' || name.includes('gitlab')) return 'gitlab';
  if (name === 'bitbucket.org') return 'bitbucket';
  if (name === 'codeberg.org' || name.includes('forgejo') || name.includes('gitea') || name.includes('gogs')) {
    return 'forgejo';
  }
  return 'unknown';
}

/**
 * One path segment as every forge accepts it: letters, digits, `.`, `_` and
 * `-`, not beginning with a hyphen — an argument starting with `-` is an
 * option to every CLI ever written, and these strings end up as arguments.
 */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A host: a name or an address, with an optional port. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

/**
 * The three spellings git uses for one remote, on any host:
 *
 *     https://host[:port]/owner/repo(.git)      (and http, for a LAN forge)
 *     ssh://git@host[:port]/owner/repo(.git)
 *     git@host:owner/repo(.git)                  (the scp form)
 *
 * The scp form is only read when the host looks like one — a name with a dot,
 * or `localhost` — so `C:\Users\…` and `origin:foo` are not remotes. An ssh
 * port is dropped from the web address: it is the port sshd listens on, not
 * the one the pages are served from.
 */
const WEB_REMOTE = /^(https?):\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+?)(?:\.git)?\/?$/i;
const SSH_REMOTE = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+?)(?:\.git)?\/?$/i;
const SCP_REMOTE = /^(?:[^@\s:/]+@)?((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|localhost):([^:\s].*?)(?:\.git)?\/?$/;

/**
 * The repository a remote URL names, or `null` for anything that is not one.
 *
 * `hint` overrides the kind read off the host — what a repository's own
 * `[artemis] forge = …` says about itself. Everything about the answer is a
 * fact about the string; whether the repository exists is not this
 * function's business, which is the same rule `parsePullRequestUrl` keeps.
 */
export function parseRemoteUrl(url: string, hint?: ForgeKind): RepositoryOrigin | null {
  const text = url.trim();
  let scheme: 'http' | 'https';
  let host: string;
  let path: string;

  const web = WEB_REMOTE.exec(text);
  const ssh = web === null ? SSH_REMOTE.exec(text) : null;
  const scp = web === null && ssh === null ? SCP_REMOTE.exec(text) : null;
  if (web !== null) {
    scheme = web[1]?.toLowerCase() === 'http' ? 'http' : 'https';
    host = web[2] ?? '';
    path = web[3] ?? '';
  } else if (ssh !== null) {
    scheme = 'https';
    host = (ssh[1] ?? '').replace(/:\d+$/, '');
    path = ssh[2] ?? '';
  } else if (scp !== null) {
    scheme = 'https';
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    return null;
  }

  if (!HOST.test(host)) return null;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment))) return null;

  const repo = segments[segments.length - 1] as string;
  const owner = segments.slice(0, -1).join('/');
  return {
    host,
    owner,
    repo,
    kind: hint ?? forgeKindFor(host),
    web: `${scheme}://${host}/${owner}/${repo}`,
  };
}

/**
 * Another repository on the same forge as `origin` — what `owner/repo#12` in
 * prose names when the pane's own checkout lives on a self-hosted server: the
 * neighbouring repository there, not the same name on github.com.
 */
export function siblingRepository(origin: RepositoryOrigin, owner: string, repo: string): RepositoryOrigin {
  const scheme = origin.web.startsWith('http://') ? 'http' : 'https';
  return { host: origin.host, owner, repo, kind: origin.kind, web: `${scheme}://${origin.host}/${owner}/${repo}` };
}

/**
 * A repository on github.com, the convention `owner/repo#12` had before any
 * other host was read — and still the reading when there is no checkout to
 * say otherwise.
 */
export function githubRepository(owner: string, repo: string): RepositoryOrigin {
  return { host: 'github.com', owner, repo, kind: 'github', web: `https://github.com/${owner}/${repo}` };
}

/**
 * The page for one pull request, spelled the way its forge spells it.
 *
 * GitHub says `/pull/`, GitLab says `/-/merge_requests/`, Bitbucket says
 * `/pull-requests/`, and Gitea, Forgejo, Gogs and every host this cannot name
 * say `/pulls/` — see the module note for the default.
 */
export function pullRequestUrl(origin: RepositoryOrigin, number: number | string): string {
  const n = String(number);
  switch (origin.kind) {
    case 'github':
      return `${origin.web}/pull/${n}`;
    case 'gitlab':
      return `${origin.web}/-/merge_requests/${n}`;
    case 'bitbucket':
      return `${origin.web}/pull-requests/${n}`;
    case 'forgejo':
    case 'unknown':
      return `${origin.web}/pulls/${n}`;
  }
}
