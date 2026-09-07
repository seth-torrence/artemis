/**
 * The one markdown pipeline.
 * ============================================================================
 *
 * Three surfaces render markdown — an answer in the transcript, a `.md` file in
 * the preview, a plan in its approval card — and until this file existed all
 * three wrote out `<Markdown remarkPlugins={[remarkGfm]}>` themselves. Identical
 * by coincidence rather than by construction, which is the arrangement where the
 * fourth caller quietly gets a different set of plugins and nobody notices until
 * a table renders as text in one place and a grid in another.
 *
 * So the configuration lives here and the callers say `<Markdown>`. The thing
 * that made it worth doing now is the copy button below: a per-call-site
 * `components` map would have been the same coincidence again, with more of it.
 *
 * ## Still no `rehype-raw`, in any of them
 *
 * The security posture is unchanged and is the reason this wrapper does not take
 * a `rehypePlugins` prop. `react-markdown` does not render raw HTML unless it is
 * asked to, so a `<script>` written into an answer or a `.md` file is displayed
 * as text. `PreviewPane`'s header explains what that buys and what it costs; the
 * point here is that it is now one decision rather than three, and adding a
 * prop to loosen it per caller would put it back to three.
 *
 * ## Why the copy button hangs off `pre`, not `code`
 *
 * `code` is both halves of the language: the fenced block and the backticked
 * word in the middle of a sentence. Only the block gets a `pre` around it, so
 * overriding `pre` is what distinguishes "a snippet someone wants to run
 * somewhere else" from "a symbol named in a paragraph", with no need to inspect
 * a `language-*` class that fenced blocks do not always carry anyway.
 *
 * ## The wrapper div, and why `.md` does not mind it
 *
 * The button is a sibling of the `<pre>` inside a positioned wrapper rather than
 * a child of it. Inside, it would join the block's own text — selecting the
 * snippet would select the button, and copying by hand, which is what people
 * fall back to, would pick up its label. It is also inside `overflow-x: auto`
 * there, so it would slide away from the corner on a long line.
 *
 * The wrapper takes the `<pre>`'s place as a child of `.md`, which matters
 * because that stylesheet's spacing rule is `.md > * + *`. A wrapper is one
 * child in the same position, so the space above a code block is what it was.
 * `.md pre` still styles the `<pre>` itself, since it is a descendant selector.
 *
 * ## The text comes from the hast node
 *
 * `node` is the parsed tree `react-markdown` hands to a component override, and
 * walking it is how the raw source of the block is recovered — the React
 * children at that point are elements, and reassembling a string from them means
 * reaching into rendered output for something the parser already knows exactly.
 * Fenced code arrives as one text node under one `code` element; the walk is
 * recursive anyway because that is a fact about today's parser rather than a
 * guarantee, and a plugin that decorates the block should not silently truncate
 * what gets copied.
 */

import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RepositoryOrigin } from '@rx-artemis/protocol';

import { useReachableFile } from '../lib/fileReach';
import { remarkPullRequestReferences } from '../lib/prReferences';
import { parseFileReference, resolveFilePath, type FileReference } from '../lib/filePaths';
import { hostPlatform } from '../state/pane';
import { CopyButton } from './primitives';
import { PullRequestLink } from './PullRequestLink';

/**
 * A hast node, named without importing `hast`.
 *
 * `@types/hast` is `react-markdown`'s dependency rather than the desktop app's,
 * so it resolves for that package's own declarations and is not ours to import
 * by name. Deriving the type from the prop it arrives on gets the real thing —
 * including the `text` / `element` discriminant {@link textOf} narrows on —
 * without adding a dependency to say so.
 */
type MarkdownNode = NonNullable<ExtraProps['node']>;

/** Every bit of text under a node, in document order. */
function textOf(node: MarkdownNode | undefined): string {
  if (node === undefined) return '';
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += textOf(child);
  }
  return out;
}

/**
 * A fenced block, with the button that copies it.
 *
 * The trailing newline goes. `mdast-to-hast` terminates a fenced block's text
 * with one, and pasting a stray blank line into a SQL console or a shell is a
 * small nuisance that is entirely this layer's doing. Only the last one, and
 * only at the end: leading indentation is the snippet's, and a deliberate blank
 * line before the close of a fence is rare enough that losing exactly one
 * character of it beats shipping the artefact to everybody.
 */
function CopyablePre({
  node,
  children,
  ...rest
}: ComponentPropsWithoutRef<'pre'> & ExtraProps): ReactElement {
  const text = textOf(node).replace(/\n$/, '');
  return (
    <div className="group/copy relative">
      {/*
        The fence is announced to the `code` below it, which is the same
        component that renders a backticked word mid-sentence and has no other
        way to tell the two apart. Context rather than a parser detail — a fenced
        block's text happens to end in a newline and an inline span's does not,
        which is true today and is not a thing to build on.
      */}
      <pre {...rest}>
        <Fenced.Provider value={true}>{children}</Fenced.Provider>
      </pre>
      <CopyButton text={text} label="Copy this code" className="absolute top-1.5 right-1.5" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* File references                                                            */
/* -------------------------------------------------------------------------- */

/** True inside a fenced block. See {@link CopyablePre}. */
const Fenced = createContext(false);

/** What a caller supplies to turn paths in its text into links. */
export interface FileLinks {
  /**
   * The directory a relative path in this text is relative to.
   *
   * The conversation's own, and the reason this is a prop rather than something
   * the component reaches for: the same `src/store.ts` means a different file in
   * the column next door, and only the caller knows which column it is drawing.
   */
  readonly cwd: string;
  /** What to do when the reader clicks one. */
  readonly open: (reference: FileReference) => void;
}

/** How to act on paths, or `null` to render them as ordinary code. */
const Links = createContext<FileLinks | null>(null);

/**
 * A backticked fragment, which is sometimes a file.
 *
 * Most of them are not — `useCopy`, `--force`, `pnpm test` — so the great
 * majority of what this renders is the plain `<code>` it always was.
 * `parseFileReference` holds the judgement and the argument for where it draws
 * the line.
 *
 * Being path-*shaped* is necessary and not sufficient. `useReachableFile` asks
 * the main process whether there is a file at the resolved path, and until the
 * answer is yes this renders as text — so an agent's `apps/desktop/main/files.ts`
 * is a link and the `foo.ts` it says it is *about to* write is not, which is a
 * distinction no amount of looking at the string could have made. The two rules
 * fail the same way round, which is the point: where either is unsure, no link.
 *
 * A **button**, not an anchor. There is no URL here and nothing to put in an
 * `href`: the path is resolved against a conversation's directory and read over
 * IPC, so an anchor would be a link that cannot be opened in a new window,
 * copied as a location, or followed by anything but this handler. The `<code>`
 * stays inside it, which keeps `.md code`'s well and lets the button supply only
 * what it adds — a colour, an underline, and a focus ring.
 */
function CodeSpan({
  node,
  children,
  ...rest
}: ComponentPropsWithoutRef<'code'> & ExtraProps): ReactElement {
  const fenced = useContext(Fenced);
  const links = useContext(Links);
  const reference = fenced || links === null ? null : parseFileReference(textOf(node));

  /*
   * Resolved here rather than at the click, because this is the layer that has
   * to ask about it — and asking about `src/store.ts` without saying which
   * conversation's `src` would be asking about nothing. `openFile` resolves it
   * again from the store for the click itself; the two agree because they use
   * the same function against the same pane's directory.
   */
  const path =
    reference === null || links === null
      ? null
      : resolveFilePath(reference.path, links.cwd, hostPlatform());
  const reachable = useReachableFile(path);

  if (reference === null || links === null || !reachable) return <code {...rest}>{children}</code>;

  return (
    <button
      type="button"
      onClick={() => links.open(reference)}
      title={reference.line === undefined ? reference.path : `${reference.path}, line ${String(reference.line)}`}
      className="cursor-pointer rounded-sm text-beam-text underline decoration-beam-text/40 underline-offset-2 outline-none hover:decoration-beam-text focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <code {...rest}>{children}</code>
    </button>
  );
}

/*
 * `a` is overridden for one reason and changes nothing about the rest.
 *
 * `PullRequestLink` renders the anchor react-markdown would have rendered
 * unless the href is a GitHub pull request, in which case it adds a hover card
 * saying where that PR stands. Every other link — and that is nearly all of
 * them — comes out of it byte-identical.
 *
 * It goes here rather than at the call sites because a PR link is worth
 * explaining wherever one appears, and this is the single place every rendered
 * link in the app passes through.
 */
const COMPONENTS: Components = { pre: CopyablePre, code: CodeSpan, a: PullRequestLink };

export interface MarkdownProps {
  readonly children: string;
  /**
   * Where paths in this text point, and what to do when one is clicked.
   *
   * Absent — the default, and what the preview pane and the plan card both
   * use — means paths render as ordinary code. Passing it is what turns them
   * into links.
   *
   * One object rather than two props because neither half is any use alone: a
   * handler with no directory cannot say which file `src/store.ts` is, and a
   * directory with no handler describes links that do nothing. Making them
   * inseparable in the type is cheaper than a comment asking for both.
   */
  readonly files?: FileLinks;
  /**
   * The repository bare `#123` references resolve against — the pane's
   * working directory's `origin`, on whatever host it names. Absent, bare
   * references stay text and only the self-naming `owner/repo#123` form links,
   * to github.com. See `lib/prReferences.ts`.
   */
  readonly origin?: RepositoryOrigin | null;
}

/**
 * Markdown, the way Artemis renders it.
 *
 * Memoised on its props. The transcript re-renders a settled answer whenever
 * anything else in the pane moves, and re-parsing a long answer to produce the
 * identical tree is the most expensive thing on that path — so a caller passing
 * `files` should pass a stable object, which `AssistantRow` does.
 */
export const Markdown = memo(function Markdown({ children, files, origin }: MarkdownProps): ReactElement {
  /*
   * One context for the whole block rather than a prop threaded through every
   * span. Note that the *reachability* subscription below it is per span and is
   * not the same trade: it is keyed by path, so an answer about one file wakes
   * only the spans naming that file — see `fileReach.ts`.
   */
  const links = useMemo(() => files ?? null, [files]);

  /*
   * One plugin array per repository, not per render. `react-markdown` re-parses
   * when its plugin array changes identity, and the repository changes when the
   * pane's directory does — which is exactly when a bare `#123` starts meaning
   * a different pull request and the re-parse is owed anyway.
   */
  const plugins = useMemo(
    () => [remarkGfm, remarkPullRequestReferences(origin ?? null)],
    [origin],
  );

  return (
    <Links.Provider value={links}>
      <ReactMarkdown remarkPlugins={plugins} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </Links.Provider>
  );
});
