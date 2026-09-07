/**
 * The prompt library, as the Agents pane edits it.
 *
 * Not in the app store, and the reason is the same one that keeps the Cerebro
 * reading and the shared-config probe out of it: this is a document owned by
 * the main process, read when a pane opens and written back when it changes.
 * Nothing outside the pane reads it — runs get their copy from `engine.ts`,
 * never from here — so putting it in a store that every component subscribes to
 * would give the rest of the app a stale second source for a fact it has no
 * business holding.
 *
 * ---------------------------------------------------------------------------
 * OPTIMISTIC, WITH THE SERVER'S ANSWER WINNING
 * ---------------------------------------------------------------------------
 *
 * Edits apply locally at once — anything else puts an IPC round-trip between a
 * keystroke and the character appearing. The save that follows is debounced,
 * and its *response* is deliberately not applied on top of the local document.
 *
 * That looks like the wrong way round, and it is the important detail. Main
 * re-derives the library's invariants on write, so the response can legitimately
 * differ from the request — but it is the answer to a save that may already be
 * two keystrokes stale, and applying it would overwrite what the user typed in
 * the meantime with an echo of what they typed before. The response is used for
 * exactly one thing: to notice a save that *failed*. The corrections it carries
 * are all idempotent and land on the next open.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FLUSH ON UNMOUNT IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * The settings dialog unmounts its panes when the section changes, and the
 * whole dialog unmounts when it closes. Both happen well inside the debounce
 * window — type a word, press Escape — so without the flush the most recent
 * edit is the one that is always lost. It is the same reason the pane's own
 * "Saved" indicator is not the thing to trust: the honest signal is that the
 * write was *issued* before this hook went away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AgentPrompt,
  AgentPromptsDocument,
  ArtemisBridge,
  BuiltInPromptId,
  MemoryBankPromptInfo,
} from '@rx-artemis/protocol';
import { AGENT_PROMPTS_VERSION, withBuiltInRemoved, withBuiltInRestored } from '@rx-artemis/protocol';

import { call, resolveBridge } from '../lib/bridge';

/**
 * How long an edit sits before it is written.
 *
 * Long enough that ordinary typing produces one write per pause rather than one
 * per character, short enough that a user who types a sentence and reaches for
 * the mouse has already been saved. Below about 300ms the writes start to
 * overlap on a slow disk; above about a second the flush-on-unmount stops being
 * a safety net and becomes the normal path.
 */
const SAVE_DEBOUNCE_MS = 600;

export type SaveState =
  /** Nothing has been edited since the last write landed. */
  | { readonly kind: 'idle' }
  /** Edited, and a write is pending or in flight. */
  | { readonly kind: 'saving' }
  /** The last write failed. Carries the message, already safe to show. */
  | { readonly kind: 'error'; readonly message: string };

export interface AgentPromptsPane {
  /** True until the first read lands. The pane renders nothing editable before then. */
  readonly loading: boolean;
  /** Why the *read* failed. A failed read is fatal to the pane; a failed write is not. */
  readonly error: string | null;
  readonly prompts: readonly AgentPrompt[];
  /**
   * Artemis's own prompts the user has removed. Kept beside the list rather
   * than derived from it, because "not in the list" is also what a library
   * written before a built-in existed looks like, and the two must save
   * differently — see `AgentPromptsDocument.dismissedBuiltIns`.
   */
  readonly dismissedBuiltIns: readonly BuiltInPromptId[];
  /** This machine's banks, for previewing a built-in as it will be sent. */
  readonly memoryBanks: readonly MemoryBankPromptInfo[];
  readonly saveState: SaveState;
  /**
   * Replace the list.
   *
   * One mutator rather than add/update/remove/reorder, because every one of
   * those is "here is the new list" and four channels into one debounced writer
   * is four places for the debounce to be reset from. The two below are the
   * exceptions that prove it: removing a built-in is not "here is the new
   * list", it is a list *and* a record, and the record is what keeps the read
   * from putting the row back.
   */
  readonly setPrompts: (next: readonly AgentPrompt[]) => void;
  /** Remove one of Artemis's prompts, durably. `restoreBuiltIn` brings it back. */
  readonly removeBuiltIn: (id: BuiltInPromptId) => void;
  /** Put a removed built-in back, in its shipped state. */
  readonly restoreBuiltIn: (id: BuiltInPromptId) => void;
}

function channel(): ArtemisBridge['agentPrompts'] | null {
  return resolveBridge().bridge?.agentPrompts ?? null;
}

export function useAgentPrompts(): AgentPromptsPane {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setLocalPrompts] = useState<readonly AgentPrompt[]>([]);
  const [dismissedBuiltIns, setDismissedBuiltIns] = useState<readonly BuiltInPromptId[]>([]);
  /*
   * The banks main saw at read time, kept only so a built-in previews as the
   * text a run would carry. Never written back and never part of a save: these
   * are facts about the machine, not part of the library.
   */
  const [memoryBanks, setMemoryBanks] = useState<readonly MemoryBankPromptInfo[]>([]);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  /**
   * The document a pending write will send.
   *
   * A ref rather than the state above because the flush runs from a timer and
   * from an unmount cleanup, both of which close over whatever `prompts` was
   * when they were created. A ref is the value *now*, which is the only value a
   * save should ever be built from.
   */
  const pending = useRef<AgentPromptsDocument | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async (): Promise<void> => {
    const document = pending.current;
    if (document === null) return;
    pending.current = null;

    const bridge = channel();
    if (bridge === null) {
      setSaveState({ kind: 'error', message: 'This window cannot reach the main process.' });
      return;
    }

    const result = await call(() => bridge.save({ document }));
    if (!result.ok) {
      setSaveState({ kind: 'error', message: result.error.message });
      return;
    }
    // An edit that arrived while this write was in flight owns the state — it
    // has its own save coming, and reporting `idle` here would say "saved"
    // about a document that is already out of date. The response itself is not
    // applied; see the note on this module.
    if (pending.current === null) setSaveState({ kind: 'idle' });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* First read                                                              */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const bridge = channel();
    if (bridge === null) {
      setLoading(false);
      setError('This window cannot reach the main process.');
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const result = await call(() => bridge.list({}));
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error.message);
        // Deliberately *not* seeded with the defaults on a failed read. A pane
        // showing the default library over a read that failed invites the user
        // to edit it, and the first save would replace whatever is really on
        // disk with what they were shown by mistake.
        return;
      }
      setError(null);
      setLocalPrompts(result.value.document.prompts);
      setDismissedBuiltIns(result.value.document.dismissedBuiltIns ?? []);
      setMemoryBanks(result.value.memoryBanks);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Edits                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The document as the pane currently has it, for a mutator to start from.
   *
   * A ref for the same reason `pending` is one: `removeBuiltIn` closes over
   * whatever `prompts` was when it was created, and a removal that started from
   * a stale list would resurrect an edit made since.
   */
  const current = useRef<AgentPromptsDocument>({ version: AGENT_PROMPTS_VERSION, prompts: [] });
  current.current = {
    version: AGENT_PROMPTS_VERSION,
    prompts,
    ...(dismissedBuiltIns.length === 0 ? {} : { dismissedBuiltIns }),
  };

  const commit = useCallback(
    (next: AgentPromptsDocument) => {
      setLocalPrompts(next.prompts);
      setDismissedBuiltIns(next.dismissedBuiltIns ?? []);
      setSaveState({ kind: 'saving' });
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const setPrompts = useCallback(
    (next: readonly AgentPrompt[]) => commit({ ...current.current, prompts: next }),
    [commit],
  );
  const removeBuiltIn = useCallback(
    (id: BuiltInPromptId) => commit(withBuiltInRemoved(current.current, id)),
    [commit],
  );
  const restoreBuiltIn = useCallback(
    (id: BuiltInPromptId) => commit(withBuiltInRestored(current.current, id)),
    [commit],
  );

  // The flush that makes the debounce safe. See the note on this module: the
  // pane is unmounted by closing the dialog or switching section, and both are
  // well inside the window.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      void flush();
    };
  }, [flush]);

  return {
    loading,
    error,
    prompts,
    dismissedBuiltIns,
    memoryBanks,
    saveState,
    setPrompts,
    removeBuiltIn,
    restoreBuiltIn,
  };
}
