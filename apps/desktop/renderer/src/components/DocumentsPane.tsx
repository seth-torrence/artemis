/**
 * Every document this conversation has made, listed.
 * ============================================================================
 *
 * A tile in the thread is the record of one document at the moment it was
 * written, and it stands exactly where the agent wrote it — which is right
 * while the reader is there and useless an hour later, when it is forty
 * screens up. This is the index: one row per document, in the order they were
 * made, each a way back into the file and a way back to the place in the
 * conversation it came from.
 *
 * ## What a row offers
 *
 *  - **Open**, the row itself: the same `openPreview` the tile's button calls,
 *    so a page is framed and markdown is rendered exactly as they are from the
 *    thread. One reader for one kind of thing.
 *  - **The source, as text**: `openFile`, the tab a link in the transcript
 *    opens. For a page that is the difference between looking at it and
 *    reading it.
 *  - **Where it was made**: the transcript scrolls to the tile and marks it.
 *    See `lib/rowJump.ts` for how a pane outside the transcript reaches in.
 *
 * ## It is a view, and owns nothing
 *
 * Like the folder browser and the delegated list, this tab is keyed by pane
 * and reads the pane's own transcript; closing it drops nothing, and it shows
 * whatever conversation the column is showing now. It never opens on its own:
 * the tiles already announce each document where it happened, and a tab that
 * appeared uninvited would be the same news twice.
 */

import type { ReactElement } from 'react';
import { AppWindowIcon, FileCodeIcon, FileTextIcon, LocateIcon } from 'lucide-react';
import { formatClock } from '@rx-artemis/transcript';

import { usePaneDocuments } from '../hooks/useDocuments';
import { formatBytes } from '../lib/attachments';
import type { Document } from '../lib/documents';
import { jumpToRow } from '../lib/rowJump';
import type { Pane, PaneId } from '../state/pane';
import { allLivePanes, openFile, openPreview, useApp } from '../state/store';
import { DockHeader } from './DockHeader';
import { IconButton } from './disabled-reason';

export function DocumentsPane({ paneId }: { readonly paneId: PaneId }): ReactElement | null {
  // Looked up rather than passed, for `FilesPane`'s reason: the dock is drawn
  // outside every `PaneProvider`, so a tab naming a column has to resolve it.
  const pane = useApp((s) => allLivePanes(s).find((one) => one.id === paneId));
  const documents = usePaneDocuments(pane);
  if (pane === undefined) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The count and nothing else: the tab names the thing, and a bar that
          said "Documents" over a list of documents would be the same word
          twice. */}
      <DockHeader className="gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted">
          {documents.length === 0
            ? 'Nothing made yet'
            : `${String(documents.length)} document${documents.length === 1 ? '' : 's'}`}
        </span>
      </DockHeader>

      {documents.length === 0 ? (
        <div className="grid flex-1 place-items-center p-4 text-center text-2xs text-ink-faint">
          Pages and documents the agent writes appear here, in the order they are made.
        </div>
      ) : (
        // Inset on all four sides for the folder browser's reason: the rows
        // are rounded, and a rounded row that runs to the pane's edge has its
        // corners cut off by the very edge it is supposed to stand clear of.
        <ul
          aria-label="Documents"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5"
        >
          {documents.map((document) => (
            <DocumentRow key={document.path} document={document} pane={pane} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What the row says under the name.
 *
 * The kind first, because it is what the tile leads with and what decides
 * whether opening it runs script; then what is known about the size, which is
 * either a number or the fact that the number is stale (see `Document.bytes`);
 * then when it was first made, in the transcript's own clock, which is what a
 * reader scrolling back to it will be matching against.
 */
function describe(document: Document): string {
  const parts: string[] = [document.kind === 'page' ? 'page' : 'markdown'];
  if (document.bytes !== undefined) parts.push(formatBytes(document.bytes));
  if (document.revisions > 1) {
    const edits = document.revisions - 1;
    parts.push(`${String(edits)} edit${edits === 1 ? '' : 's'}`);
  }
  parts.push(formatClock(document.madeAt));
  return parts.join(' · ');
}

function DocumentRow({
  document,
  pane,
}: {
  readonly document: Document;
  readonly pane: Pane;
}): ReactElement {
  return (
    <li>
      {/*
        A `group`, so the two secondary actions appear on hover of the whole
        row rather than only of themselves — the transcript's rewind pair does
        the same, for the same reason: a control that has to be hovered before
        it is visible is not a control. Focus reveals them for the keyboard.
      */}
      <div className="group flex min-w-0 items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-wash">
        <button
          type="button"
          title={`Open ${document.path}`}
          onClick={() => void openPreview(document.path, pane)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {/* The tile's own glyphs, so the list and the thread agree about
              what each thing is. */}
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-wash-strong">
            {document.kind === 'page' ? (
              <AppWindowIcon className="size-3 text-cyan" aria-hidden="true" />
            ) : (
              <FileTextIcon className="size-3 text-sage" aria-hidden="true" />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium text-ink">{document.title}</span>
            <span className="truncate font-mono text-2xs text-ink-faint">{describe(document)}</span>
          </span>
        </button>
        <IconButton
          label="Show where it was made"
          size="icon-xs"
          onClick={() => {
            jumpToRow(pane.id, document.madeBy);
          }}
          className="shrink-0 rounded-md text-ink-faint opacity-0 group-hover:opacity-100 hover:bg-wash-strong focus-visible:opacity-100"
        >
          <LocateIcon />
        </IconButton>
        <IconButton
          label="Open the source as text"
          size="icon-xs"
          onClick={() => void openFile({ path: document.path }, pane)}
          className="shrink-0 rounded-md text-ink-faint opacity-0 group-hover:opacity-100 hover:bg-wash-strong focus-visible:opacity-100"
        >
          <FileCodeIcon />
        </IconButton>
      </div>
    </li>
  );
}
