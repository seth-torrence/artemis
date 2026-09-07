import { useEffect, useState } from 'react';

import { paneState, type Pane } from '../state/pane';

/**
 * A named column's working directory, subscribed.
 *
 * By hand rather than through `usePane`, for `usePaneTasks`' reason: the dock
 * is drawn outside every `PaneProvider`, and a column can close between the
 * strip being computed and a dock pane rendering — so the pane is `undefined`
 * on some renders, and a hook cannot be skipped on those.
 *
 * Reading `paneState(pane).cwd` once at render would compile and be wrong: the
 * window store does not change when a conversation is pointed somewhere else,
 * so a pane reading it that way would sit in the old tree until something
 * unrelated redrew it.
 */
export function usePaneCwd(pane: Pane | undefined): string {
  const [cwd, setCwd] = useState(() => (pane === undefined ? '' : paneState(pane).cwd));

  useEffect(() => {
    if (pane === undefined) {
      setCwd('');
      return;
    }
    setCwd(paneState(pane).cwd);
    return pane.store.subscribe(() => setCwd(paneState(pane).cwd));
  }, [pane]);

  return cwd;
}
