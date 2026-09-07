/**
 * Jumping a transcript to one of its rows, from outside it.
 * ============================================================================
 *
 * The documents list lives in the dock, which is drawn outside every column;
 * the rows live in a `Transcript`, one per column, which owns the only scroller
 * that can bring a row into view. Neither can reach the other through React —
 * the dock is not inside a `PaneProvider`, and the transcript must not read the
 * window store on its hot path — so the link is a small registry: a transcript
 * registers the one thing it can do for a row while it is mounted, and a caller
 * asks for it by pane.
 *
 * Keyed by pane rather than by a DOM id per row, because row ids are per
 * transcript — two columns can both hold a `t:c1` — and the pane is what tells
 * them apart.
 */

import type { PaneId } from '../state/pane';

/** Bring a row into view. `false` when it is not on screen to be brought. */
export type RowJumper = (rowId: string) => boolean;

const jumpers = new Map<PaneId, RowJumper>();

/**
 * Register the way to reach a row in this pane's transcript. Returns the
 * unregister, shaped for the effect that calls it.
 */
export function registerRowJumper(paneId: PaneId, jumper: RowJumper): () => void {
  jumpers.set(paneId, jumper);
  return () => {
    // Only its own: a transcript remounting for the same pane registers the
    // replacement before the old effect cleans up, and the cleanup must not
    // take the newcomer with it.
    if (jumpers.get(paneId) === jumper) jumpers.delete(paneId);
  };
}

/**
 * Scroll a pane's transcript to one of its rows.
 *
 * `false` when the pane has no transcript mounted, or the row is not there to
 * be scrolled to. A caller that cares can say so; one that does not can ignore
 * it.
 */
export function jumpToRow(paneId: PaneId, rowId: string): boolean {
  return jumpers.get(paneId)?.(rowId) ?? false;
}
