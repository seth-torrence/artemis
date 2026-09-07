/**
 * The working directory, listed.
 * ============================================================================
 *
 * Until this existed, the only way to see a file in Artemis was for the *agent*
 * to mention it: `FileViewer` opens what a transcript links to, and a path
 * nobody had written about was unreachable. That is a strange shape for a tool
 * whose whole subject is a directory — you could read the file the agent
 * touched and nothing beside it.
 *
 * So: the folder the column is working in, and a click opens what is in it.
 *
 * ## It reuses the file reader rather than growing one
 *
 * Clicking a file calls `openFile`, which is the same path a link in the
 * transcript takes — same channel, same gates, same kind of tab. Two readers
 * for one kind of thing would be two places to fix a bug in, and that one
 * already handles the parts that are genuinely hard: binary refusal, the 2MB
 * cap and its caption, syntax highlighting.
 *
 * A tab each, so clicking through a folder builds up the files you are reading
 * rather than replacing them one by one. Clicking the same file twice is still
 * one tab — `openFile` brings the open one forward.
 *
 * ## Navigation is a stack, not a tree
 *
 * A directory opens *into* the pane and the header offers the way back, rather
 * than expanding in place. A tree is the better shape once someone wants two
 * distant folders on screen together; it is the worse shape for the thing this
 * is for, which is finding one file in a project you already know. This is the
 * smaller half deliberately — see the note on `up`.
 *
 * ## What it does not do
 *
 * No creating, renaming, moving or deleting. The channel behind it reads and
 * nothing else, and a browser that could write would want confirmations, undo
 * and a conflict story with the agent editing the same tree underneath it.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  ChevronLeftIcon,
  CornerLeftUpIcon,
  FileCodeIcon,
  FileIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  RefreshCwIcon,
  SettingsIcon,
} from 'lucide-react';
import type { DirectoryEntry } from '@rx-artemis/protocol';

import { usePaneCwd } from '../hooks/usePaneCwd';
import { call, resolveBridge } from '../lib/bridge';
import { allLivePanes, openFile, useApp } from '../state/store';
import type { PaneId } from '../state/pane';
import { DockHeader } from './DockHeader';
import { IconButton } from './disabled-reason';
import { cn } from '@/lib/utils';

/**
 * Which glyph a name gets.
 *
 * By extension, and deliberately a short list. The point is to make a directory
 * *scannable* — code from config from prose at a glance — not to have an icon
 * per language, which is a maintenance burden that buys a reader nothing they
 * could not get from the name two pixels to the right.
 */
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|swift|kt|sh|zsh|fish)$/i;
const DATA = /\.(json|jsonc|ya?ml|toml|ini|env|lock)$/i;
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;
/** Dotfiles that are configuration whatever their extension says. */
const DOTFILE = /^\./;

function EntryIcon({ entry }: { readonly entry: DirectoryEntry }): ReactElement {
  const style = 'size-3.5 shrink-0';
  if (entry.kind === 'directory') {
    return <FolderIcon className={cn(style, 'text-beam-text')} aria-hidden="true" />;
  }
  // `other` is a socket, a device, or a symlink pointing at nothing. It gets
  // the blank page and the muted row below, because it is a real thing in the
  // directory that cannot be opened.
  if (entry.kind === 'other') {
    return <FileIcon className={cn(style, 'text-ink-faint')} aria-hidden="true" />;
  }
  if (IMAGE.test(entry.name)) {
    return <ImageIcon className={cn(style, 'text-sage')} aria-hidden="true" />;
  }
  if (DATA.test(entry.name)) {
    return <FileJsonIcon className={cn(style, 'text-amber')} aria-hidden="true" />;
  }
  if (PROSE.test(entry.name)) {
    return <FileTextIcon className={cn(style, 'text-ink-muted')} aria-hidden="true" />;
  }
  if (CODE.test(entry.name)) {
    return <FileCodeIcon className={cn(style, 'text-cyan')} aria-hidden="true" />;
  }
  if (DOTFILE.test(entry.name)) {
    return <SettingsIcon className={cn(style, 'text-ink-faint')} aria-hidden="true" />;
  }
  return <FileIcon className={cn(style, 'text-ink-faint')} aria-hidden="true" />;
}

/** `1.2 kB`, `340 B`. Absent sizes render nothing rather than a zero. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Listing {
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

export function FilesPane({ paneId }: { readonly paneId: PaneId }): ReactElement | null {
  // Looked up rather than passed, for `TasksPane`'s reason: the dock is drawn
  // outside every `PaneProvider`, so a tab naming a column has to resolve it.
  const pane = useApp((s) => allLivePanes(s).find((one) => one.id === paneId));
  const cwd = usePaneCwd(pane);

  /**
   * Where we are looking, which starts at the column's `cwd` and moves as the
   * reader clicks into folders.
   *
   * Reset when `cwd` changes: pointing the conversation somewhere else and
   * finding the browser still in the old tree would be a stale view of a
   * question nobody asked twice.
   */
  const [at, setAt] = useState(cwd);
  useEffect(() => {
    setAt(cwd);
  }, [cwd]);

  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const read = useCallback(async (path: string): Promise<void> => {
    const { bridge } = resolveBridge();
    if (!bridge || path === '') return;

    setLoading(true);
    const result = await call(() => bridge.files.list({ path }));
    setLoading(false);

    if (!result.ok) {
      setError(result.error.message);
      setListing(null);
      return;
    }
    setError(null);
    setListing(result.value);
  }, []);

  useEffect(() => {
    void read(at);
  }, [at, read]);

  if (pane === undefined) return null;

  /**
   * The parent, or `null` at the top of the tree.
   *
   * Deliberately not bounded by `cwd`. Someone who has walked up out of the
   * working directory is looking at the machine, which is what the file channel
   * already permits and what a "you may not look there" would only make
   * confusing — the boundary that matters is enforced in main, not by hiding a
   * chevron here.
   */
  const parent = at === '/' || at === '' ? null : at.slice(0, at.lastIndexOf('/')) || '/';
  const here = at.split('/').filter(Boolean).at(-1) ?? at;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DockHeader inset="controls" className="gap-1">
        <IconButton
          label="Up one folder"
          size="icon-xs"
          disabled={parent === null}
          disabledReason="This is the top of the filesystem."
          onClick={() => {
            if (parent !== null) setAt(parent);
          }}
          // The browser's nav buttons two tabs away take the same shape and the
          // same hover; `ghost`'s own `--muted` is a grey step 7D replaced.
          className="shrink-0 rounded-md text-ink-faint hover:bg-wash"
        >
          <ChevronLeftIcon />
        </IconButton>
        <span title={at} className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
          {here}
        </span>
        {/*
          The agent is editing this tree while you look at it, so a way to ask
          again is not a nicety. There is no watcher: one would mean a channel
          that pushes, and a button is the honest amount of machinery for a view
          nobody keeps open for hours.
        */}
        <IconButton
          label="Read this folder again"
          size="icon-xs"
          onClick={() => void read(at)}
          className="shrink-0 rounded-md text-ink-faint hover:bg-wash"
        >
          <RefreshCwIcon className={cn(loading && 'animate-spin')} />
        </IconButton>
      </DockHeader>

      {error !== null ? (
        <div className="grid flex-1 place-items-center p-4 text-center text-2xs text-amber">
          {error}
        </div>
      ) : listing === null ? (
        <div className="grid flex-1 place-items-center p-4 text-2xs text-ink-faint">
          {loading ? 'Reading…' : 'Nothing to show.'}
        </div>
      ) : listing.entries.length === 0 ? (
        <div className="grid flex-1 place-items-center p-4 text-2xs text-ink-faint">
          This folder is empty.
        </div>
      ) : (
        // Inset on all four sides, because the rows are rounded now: a
        // `rounded-md` row that runs to the pane's edge has its corners cut off
        // by the very edge it is supposed to stand clear of. The 6px pad is the
        // mockup's `.flist` (docs/design/7d-full.html).
        <ul
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5"
          aria-label="Folder"
        >
          {/*
            The way back, in the list rather than only in the header.

            The chevron above does the same thing and is not where anyone looks
            for it: a folder listing is a thing you navigate by clicking rows,
            and every file browser since the Finder has put `..` at the top of
            one. Having walked *into* a folder by clicking its row, the hand is
            already here — asking it to travel to a chevron in the header to
            come back out is the kind of small friction that makes a browser
            feel like a viewer.

            Both, not one. The header control keeps its place because it is
            where the current folder's name is, and because it stays reachable
            when the list is scrolled past this row.
          */}
          {parent === null ? null : (
            <li>
              <button
                type="button"
                onClick={() => {
                  setAt(parent);
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink"
              >
                <CornerLeftUpIcon className="size-3.5 shrink-0 text-beam-text" aria-hidden="true" />
                {/* Mono, because it is a path fragment rather than a name — and
                    two dots in the body font read as an ellipsis that lost a
                    letter. */}
                <span className="min-w-0 flex-1 truncate font-mono">..</span>
              </button>
            </li>
          )}

          {listing.entries.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                disabled={entry.kind === 'other'}
                onClick={() => {
                  const next = at.endsWith('/') ? `${at}${entry.name}` : `${at}/${entry.name}`;
                  if (entry.kind === 'directory') setAt(next);
                  else void openFile({ path: next }, pane);
                }}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
                  entry.kind === 'other'
                    ? 'cursor-default text-ink-faint'
                    : 'text-ink-muted hover:bg-wash hover:text-ink',
                )}
              >
                <EntryIcon entry={entry} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="shrink-0 font-mono text-2xs text-ink-faint tabular-nums">
                  {formatBytes(entry.bytes)}
                </span>
              </button>
            </li>
          ))}

          {listing.truncated ? (
            /* Said rather than hidden: a list that stops silently reads as a
               complete account of a folder that is not. */
            <li className="px-2 py-2 text-2xs text-amber">
              This folder holds more than can be listed at once. Showing the
              first {listing.entries.length}.
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
