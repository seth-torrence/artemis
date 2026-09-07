/**
 * ⌘F / Ctrl+F: find a word in this conversation.
 * ============================================================================
 *
 * A long session is a long document, and the thing you want out of it is
 * usually one sentence you remember reading — the path a tool wrote, the
 * decision three turns back, the error you scrolled past. The window had a
 * search field already, and it searches *sessions, files and commands*: it can
 * take you to a conversation, and never to a line inside one. This is the other
 * half, bound to the key everyone already presses.
 *
 * ## What it searches
 *
 * The transcript model, not the page — see `search.ts` in the transcript
 * package for why that matters: a burst of tool calls is drawn as one marker
 * and a fold's text is not in the document at all, so a page search silently
 * cannot see most of a working session. The model can, which is why a phrase
 * inside a folded `grep` is found here, and why the count in the bar can be
 * larger than the number of highlights on screen.
 *
 * ## What it does with a match
 *
 * Takes you to the row it is in and flashes it, through the same jump the
 * documents list uses (`lib/rowJump.ts`), and paints every occurrence that is
 * in the document (`lib/findHighlight.ts`). Neither is the source of truth: the
 * count and the ordering come from the model, so a match behind a collapsed
 * fold still counts, still has its turn in the cycle, and lands you on the
 * marker that hides it.
 *
 * ## Scope
 *
 * One bar per column, holding that column's conversation. Two panes open means
 * two independent searches, and ⌘F opens the one in the *focused* pane — the
 * same rule every session-scoped shortcut in `App.tsx` follows. The open flag
 * lives in a module map keyed by pane rather than in the pane's store, for the
 * reason `foldMemory` gives: this is where someone is looking, not something
 * the session owns, and it must never be restored into a conversation opened
 * days later.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from 'react';
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from 'lucide-react';
import { searchTranscript, type TranscriptMatch } from '@rx-artemis/transcript';

import { useTranscriptRows } from '../hooks/useTranscript';
import { focusComposer } from '../lib/composerFocus';
import { observeFind, paintFind } from '../lib/findHighlight';
import { jumpToRow } from '../lib/rowJump';
import type { PaneId } from '../state/pane';
import { usePaneRef } from '../state/paneContext';
import { Button } from '@/components/ui/button';

/* -------------------------------------------------------------------------- */
/* Whether the bar is open, per column                                        */
/* -------------------------------------------------------------------------- */

/**
 * Open, and how many times it has been asked for.
 *
 * The counter is what makes a second ⌘F mean "select what I typed and let me
 * type over it", the way every other find bar behaves: the flag is already
 * true, so a boolean alone would be a state change of nothing and the effect
 * that focuses the field would not run.
 */
interface FindState {
  readonly open: boolean;
  readonly token: number;
}

const CLOSED: FindState = { open: false, token: 0 };
const states = new Map<PaneId, FindState>();
const listeners = new Map<PaneId, Set<() => void>>();

function findState(pane: PaneId): FindState {
  return states.get(pane) ?? CLOSED;
}

function write(pane: PaneId, next: FindState): void {
  states.set(pane, next);
  for (const notify of listeners.get(pane) ?? []) notify();
}

/** Open this column's find bar, or re-arm the one already open. */
export function openFindInSession(pane: PaneId): void {
  write(pane, { open: true, token: findState(pane).token + 1 });
}

/** Close it. The query survives, so the next ⌘F offers it again. */
export function closeFindInSession(pane: PaneId): void {
  if (!findState(pane).open) return;
  write(pane, { open: false, token: findState(pane).token });
}

/** Drop every column's state. For tests; nothing in the app forgets a pane. */
export function forgetFindInSession(): void {
  states.clear();
}

/* -------------------------------------------------------------------------- */
/* The bar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param scope The transcript's content element — what gets painted, and the
 * reason one column's highlights never appear in the other.
 */
export function FindInSession({
  scope,
}: {
  readonly scope: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const pane = usePaneRef();
  const state = useSyncExternalStore(
    useCallback(
      (notify: () => void) => {
        const set = listeners.get(pane.id) ?? new Set<() => void>();
        set.add(notify);
        listeners.set(pane.id, set);
        return () => {
          set.delete(notify);
        };
      },
      [pane.id],
    ),
    useCallback(() => findState(pane.id), [pane.id]),
  );

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  /** The match last jumped to, so streaming does not yank the view back. */
  const landed = useRef<string | null>(null);

  // The transcript's shape, as a trigger: a search is only as current as the
  // rows it ran over, and rows change when a message, a tool call or a whole
  // replayed session arrives.
  const rows = useTranscriptRows();

  const { matches, capped } = useMemo(() => {
    void rows;
    if (!state.open) return { matches: [] as readonly TranscriptMatch[], capped: false };
    return searchTranscript(pane.transcript, query);
  }, [rows, state.open, query, pane.transcript]);

  // Opening — or pressing the key again while open — puts the caret in the
  // field with the previous query selected, ready to be typed over.
  useEffect(() => {
    if (!state.open) return;
    const input = field.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [state.open, state.token]);

  // A new search starts at the first match. Editing the query is a new search;
  // a message arriving is not, and must not move the reader's place.
  useEffect(() => {
    setIndex(0);
  }, [query]);

  const current = matches[Math.min(index, Math.max(matches.length - 1, 0))];

  // Take the reader to the current match — on arrival, and never twice for the
  // same one. Re-searching after a token arrives rebuilds the match objects;
  // without the guard, every delta of a live turn would drag the view back to
  // whatever was found first.
  useEffect(() => {
    if (!state.open || current === undefined) {
      landed.current = null;
      return;
    }
    const key = `${current.rowId}:${String(current.at)}`;
    if (landed.current === key) return;
    landed.current = key;
    jumpToRow(pane.id, current.rowId);
  }, [state.open, current, pane.id]);

  // Paint, and keep painting as the conversation changes underneath.
  useEffect(() => {
    const root = state.open ? scope.current : null;
    paintFind(root, query);
    const stop = observeFind(root, state.open ? query : '');
    return () => {
      stop();
      paintFind(null, '');
    };
  }, [state.open, query, rows, scope]);

  if (!state.open) return null;

  const step = (by: number): void => {
    if (matches.length === 0) return;
    setIndex((at) => (at + by + matches.length) % matches.length);
  };

  const close = (): void => {
    closeFindInSession(pane.id);
    // Back to where the keystroke came from. A bar that leaves focus on a
    // removed element drops the caret on `<body>`, and the next thing typed
    // goes nowhere.
    focusComposer(pane.id);
  };

  const status =
    query.trim() === ''
      ? ''
      : matches.length === 0
        ? 'No results'
        : `${String(Math.min(index, matches.length - 1) + 1)} of ${String(matches.length)}${capped ? '+' : ''}`;

  return (
    <div
      role="search"
      aria-label="Find in conversation"
      /*
        Over the conversation, not in it, and never wider than the column it
        floats on: a split pane can be narrow enough that the field, the count
        and three buttons do not fit, and the field is what gives up the room —
        the same rule the header follows for its search.
      */
      className="absolute top-2 right-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border border-hairline-strong bg-float px-1.5 py-1 shadow-lg shadow-black/40"
    >
      <SearchIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
      <input
        ref={field}
        value={query}
        aria-label="Search this conversation"
        placeholder="Find in conversation"
        spellCheck={false}
        className="h-6 w-44 min-w-0 shrink bg-transparent text-2xs text-ink outline-none placeholder:text-ink-faint"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          // Handled here rather than in the window map: these keys mean
          // something else everywhere but in this field, and the global map
          // ignores text entry for exactly that reason.
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      />
      <span
        aria-live="polite"
        className="min-w-14 shrink-0 text-right text-2xs tabular-nums text-ink-muted"
      >
        {status}
      </span>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Previous match"
        title="Previous match — Shift+Enter"
        disabled={matches.length === 0}
        className="size-6 shrink-0 p-0"
        onClick={() => {
          step(-1);
        }}
      >
        <ChevronUpIcon className="size-3" aria-hidden="true" />
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Next match"
        title="Next match — Enter"
        disabled={matches.length === 0}
        className="size-6 shrink-0 p-0"
        onClick={() => {
          step(1);
        }}
      >
        <ChevronDownIcon className="size-3" aria-hidden="true" />
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-label="Close find"
        title="Close — Escape"
        className="size-6 shrink-0 p-0"
        onClick={close}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}
