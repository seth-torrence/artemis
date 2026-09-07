/**
 * Bare pull-request references, turned into the links they were withholding.
 *
 * An agent that opens a PR usually pastes the URL, and `PullRequestLink` gives
 * that anchor its hover reading. But prose — the agent's and the user's alike —
 * says `#141`, or `Rx-Ventures/artemis#141`, or "see PR #98", and those were
 * dead text: the one spelling humans actually use was the one spelling that
 * went nowhere.
 *
 * This remark plugin rewrites those references into ordinary links during the
 * parse, which is the whole trick: downstream nothing changes. The anchor it
 * emits is rendered by the same `a:` component as a pasted URL, so a bare
 * `#141` on a GitHub checkout gets the same state-dot, checks and size reading
 * on hover that the full URL always had — one feature, reached from both
 * spellings — and on any other host it is the link the host would have shown.
 *
 * ## Where the repository comes from
 *
 * A bare `#123` is only meaningful *somewhere*, and the somewhere is the
 * pane's working directory: `WorkspaceNames.origin` carries the `origin`
 * remote's repository on whatever host it lives — github.com, gitlab.com, a
 * Forgejo on a LAN address and port — and `pullRequestUrl` spells the page
 * the way that host does. No remote, and bare references stay text: a link
 * invented for the wrong repository would be worse than the dead text this
 * replaces.
 *
 * `owner/repo#123` names its repository, and the *host* it names is the
 * workspace's: a checkout on a self-hosted forge that says `david/medulla#4`
 * means the neighbouring repository there, not the same name on github.com.
 * With no workspace to say otherwise it is read as github.com, which is what
 * the form has always meant in prose.
 *
 * ## Deliberate misses
 *
 * Code spans and fenced blocks are never touched (`#123` in a diff hunk or a
 * shell comment is code), existing links are never re-linked, and the number
 * must be delimited the way prose delimits it — `#123abc` and `abc#123` stay
 * text. The URL is the pull-request form for the host; GitHub and Forgejo
 * redirect it when the number turns out to be an issue, and the hover, where
 * there is one, degrades to "no pull request there" while the link keeps
 * working — the same failure direction every link in `PullRequestLink` is
 * built around.
 */

import {
  githubRepository,
  pullRequestUrl,
  siblingRepository,
  type PullRequestRef,
  type RepositoryOrigin,
} from '@rx-artemis/protocol';

/**
 * One reference in prose: optional `owner/repo`, a `#`, digits — delimited on
 * both sides the way a sentence delimits a word. The boundary classes are
 * spelled out rather than `\b` because `#` is not a word character: `\b#123`
 * would happily match inside `abc#123`.
 */
const REFERENCE =
  /(^|[\s([{])((?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d{1,10}))(?=$|[\s.,;:!?)\]}])/g;

interface TextNode {
  type: 'text';
  value: string;
}

interface ParentNode {
  type: string;
  children: Array<TextNode | ParentNode | LinkNode>;
}

interface LinkNode {
  type: 'link';
  url: string;
  children: TextNode[];
}

/** Containers whose text must never become links. */
const OPAQUE = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'html']);

function isParent(node: unknown): node is ParentNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

/**
 * The repository one reference names: its own `owner/repo`, on the
 * workspace's forge or github.com; or the workspace's, for a bare `#n`.
 */
function repositoryFor(
  owner: string | undefined,
  repo: string | undefined,
  fallback: RepositoryOrigin | null,
): RepositoryOrigin | null {
  if (owner === undefined || repo === undefined) return fallback;
  return fallback === null ? githubRepository(owner, repo) : siblingRepository(fallback, owner, repo);
}

/** Split one text node around its references. `null` when it holds none. */
function splitText(
  node: TextNode,
  fallback: RepositoryOrigin | null,
): Array<TextNode | LinkNode> | null {
  const out: Array<TextNode | LinkNode> = [];
  let consumed = 0;
  let linked = false;

  REFERENCE.lastIndex = 0;
  for (let match = REFERENCE.exec(node.value); match !== null; match = REFERENCE.exec(node.value)) {
    const [, lead = '', reference = '', owner, repo, digits = ''] = match;
    const at = match.index + lead.length;

    const target = repositoryFor(owner, repo, fallback);
    // A bare reference with no repository to resolve against stays text —
    // skipping the match rather than aborting, because `owner/repo#n` later in
    // the same sentence still deserves its link.
    if (target === null) continue;

    if (at > consumed) out.push({ type: 'text', value: node.value.slice(consumed, at) });
    out.push({
      type: 'link',
      url: pullRequestUrl(target, digits),
      children: [{ type: 'text', value: reference }],
    });
    consumed = at + reference.length;
    linked = true;
  }

  if (!linked) return null;
  if (consumed < node.value.length) {
    out.push({ type: 'text', value: node.value.slice(consumed) });
  }
  return out;
}

function walk(node: ParentNode, fallback: RepositoryOrigin | null): void {
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child === undefined || OPAQUE.has(child.type)) continue;

    if (child.type === 'text') {
      const replacement = splitText(child as TextNode, fallback);
      if (replacement !== null) {
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }

    if (isParent(child)) walk(child, fallback);
  }
}

/**
 * The plugin, as a factory: remark calls the returned transformer per parse.
 *
 * A factory rather than a bare plugin because the fallback repository is an
 * argument — the caller builds one plugin array per repository and memoises
 * it, which is what keeps this off the transcript's re-render path.
 */
export function remarkPullRequestReferences(fallback: RepositoryOrigin | null) {
  return () =>
    (tree: unknown): void => {
      if (isParent(tree)) walk(tree, fallback);
    };
}

/** Re-exported so callers can speak the protocol's names for a repository and a resolved ref. */
export type { PullRequestRef, RepositoryOrigin };
