import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { collectDocuments, type Document } from '../lib/documents';
import type { Pane } from '../state/pane';
import { usePane, usePaneRef } from '../state/paneContext';
import { useApp } from '../state/store';
import { usePaneCwd } from './usePaneCwd';
import { useTranscriptArtifacts } from './useTranscript';

const NO_IDS: readonly string[] = Object.freeze([]);
const NO_DOCUMENTS: readonly Document[] = Object.freeze([]);

/**
 * The documents of the pane this component is in — what the header's opener
 * counts.
 *
 * Recomputed only when the set of artifacts, the directory or the platform
 * moves; the per-item parse behind it is cached in `lib/documents.ts`, so the
 * recompute is a walk over a handful of ids and not a diff per document.
 */
export function useDocuments(): readonly Document[] {
  const pane = usePaneRef();
  const ids = useTranscriptArtifacts();
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  return useMemo(
    () => collectDocuments(ids, pane.transcript.getItem, cwd, platform),
    [ids, pane, cwd, platform],
  );
}

/**
 * The documents of a named column, for the dock.
 *
 * The dock is drawn outside every `PaneProvider` and may be handed a column
 * that has just closed, so the pane arrives as a value that can be `undefined`
 * — and the subscription has to be built by hand rather than through
 * `useTranscriptArtifacts`, which reads the pane off context.
 */
export function usePaneDocuments(pane: Pane | undefined): readonly Document[] {
  const subscribe = useCallback(
    (onChange: () => void) =>
      pane === undefined ? () => undefined : pane.transcript.subscribeList(onChange),
    [pane],
  );
  const snapshot = useCallback(
    () => (pane === undefined ? NO_IDS : pane.transcript.getArtifactsSnapshot()),
    [pane],
  );
  const ids = useSyncExternalStore(subscribe, snapshot);
  const cwd = usePaneCwd(pane);
  const platform = useApp((s) => s.platform);
  return useMemo(
    () =>
      pane === undefined
        ? NO_DOCUMENTS
        : collectDocuments(ids, pane.transcript.getItem, cwd, platform),
    [ids, pane, cwd, platform],
  );
}
