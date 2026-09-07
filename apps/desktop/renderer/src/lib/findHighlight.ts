/**
 * Painting a search term onto the conversation, without touching a row.
 * ============================================================================
 *
 * The find bar knows where every match is — it asks the transcript model, which
 * can see into folds the page has not drawn (see `search.ts` in the transcript
 * package). What it cannot do from the model is *show* you the word inside a
 * paragraph, and every obvious way of doing that is worse than the problem:
 * threading the query into `Markdown` re-parses every message on each
 * keystroke, and wrapping matches in `<mark>` means rewriting a tree that
 * `react-markdown` owns.
 *
 * The CSS Custom Highlight API paints ranges instead. A `Range` over a text
 * node, handed to the browser, is decorated by a `::highlight()` rule in
 * `index.css` — the DOM is not modified at all, so nothing re-renders, no
 * component learns about search, and the paint is dropped by clearing the
 * registry. Chromium has had it since 105 and this app *is* Chromium; anywhere
 * it is missing — jsdom, in the tests below the components — every call here is
 * a no-op and the bar still finds, counts and jumps. Highlighting is the
 * decoration, never the feature.
 *
 * Two limits, both deliberate. Only text that is *in the document* can be
 * painted, so a match inside a collapsed fold is counted and jumped to but not
 * lit until the fold is opened — which the observer below repaints for. And a
 * match split across two text nodes by markup (`peli<em>can</em>`) is not
 * painted; the model still counted it, so the number is right and one
 * highlight is missing.
 */

/** The registry name; must match the `::highlight()` rule in `index.css`. */
const NAME = 'artemis-find';

/**
 * Ranges past this are not painted. A two-letter query in a long session
 * matches thousands of times, and every range is work for the compositor on
 * every scroll. The count in the bar comes from the model and is unaffected.
 */
const PAINT_LIMIT = 2000;

interface HighlightRegistryLike {
  set: (name: string, highlight: Highlight) => void;
  delete: (name: string) => void;
}

/** The registry, or `null` where the API does not exist (jsdom, old engines). */
function registry(): HighlightRegistryLike | null {
  if (typeof CSS === 'undefined' || typeof Highlight !== 'function') return null;
  const highlights = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  return highlights ?? null;
}

/**
 * Light every occurrence of `query` inside `root`.
 *
 * Idempotent and self-clearing: each call replaces the previous paint, and an
 * empty query — or a null root — leaves nothing lit. Case-insensitive and
 * literal, matching what the model counts.
 */
export function paintFind(root: HTMLElement | null, query: string): void {
  const highlights = registry();
  if (highlights === null) return;

  highlights.delete(NAME);
  const needle = query.trim().toLowerCase();
  if (root === null || needle === '') return;

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase();
    if (text === undefined || text === '') continue;

    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      if (ranges.length >= PAINT_LIMIT) {
        highlights.set(NAME, new Highlight(...ranges));
        return;
      }
    }
  }

  if (ranges.length > 0) highlights.set(NAME, new Highlight(...ranges));
}

/**
 * Repaint when the conversation's DOM changes under a live search.
 *
 * A fold opening, a message streaming, a session being read in: all of them add
 * text that ought to light up, and none of them go through the find bar. The
 * observer coalesces a burst into one repaint on a timer, because a streaming
 * turn mutates the tree many times a second and painting is the expensive half.
 *
 * Returns the disconnect, shaped for the effect that calls it.
 */
export function observeFind(root: HTMLElement | null, query: string): () => void {
  if (root === null || registry() === null || query.trim() === '') return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      paintFind(root, query);
    }, 120);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  return () => {
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
  };
}
