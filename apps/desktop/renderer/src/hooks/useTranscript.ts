import { useCallback, useSyncExternalStore } from 'react';
import { usePaneRef } from '../state/paneContext';
import type { ActivityGroup, TranscriptItem } from '@rx-artemis/transcript';

/*
 * REMOVED: `useTranscriptIds`.
 *
 * It returned the raw item ids, and `useTranscriptRows` below replaced its only
 * caller when consecutive tool calls started folding into one marker. The two
 * differ solely in whether that folding has happened, so keeping both would
 * mean offering a subscription whose only distinguishing feature is that it
 * renders the pane the pane no longer looks like.
 *
 * The underlying `transcript.getListSnapshot` is untouched and still the
 * model's primitive read — that is what the model's own tests assert against.
 */

/*
 * Every hook here reads its model off the *pane*, not off a module singleton.
 *
 * There is one `TranscriptModel` per open pane (see `state/pane.ts`), so these
 * subscriptions are per conversation: a burst of tokens in one pane reaches
 * nothing subscribed in another, and the hot paths never meet. `usePaneRef`
 * resolves the pane from context, falling back to the focused one.
 *
 * That is also why each hook builds its own `subscribe` and `getSnapshot`
 * rather than passing the model's bound methods straight to
 * `useSyncExternalStore`: the pair has to change identity when the pane does,
 * or a component moved between panes would keep reading the old transcript.
 */

/**
 * The transcript's row ids, for the pane this component is in.
 *
 * This subscription fires when the *shape* of the transcript changes — an item
 * appears or the transcript is reset — and not when text arrives. That is the
 * whole reason streaming stays cheap: the list component re-renders once per
 * new block, never once per token.
 *
 * A run of consecutive machinery — thinking blocks and tool calls — arrives as
 * one `g:` group id rather than one id per member; pass it to
 * {@link useActivityGroup} to read the summary.
 */
export function useTranscriptRows(): readonly string[] {
  const { transcript } = usePaneRef();
  const subscribe = useCallback(
    (onChange: () => void) => transcript.subscribeList(onChange),
    [transcript],
  );
  const snapshot = useCallback(() => transcript.getRowsSnapshot(), [transcript]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * One activity group, subscribed by id.
 *
 * Fires when the group's membership or its members' statuses change — a call
 * starting or ending, a thinking block opening or settling — and never on a
 * delta arriving inside one. The cards do that part, each on its own id.
 */
export function useActivityGroup(id: string): ActivityGroup | undefined {
  const { transcript } = usePaneRef();
  const subscribe = useCallback(
    (onChange: () => void) => transcript.subscribeGroup(id, onChange),
    [transcript, id],
  );
  const snapshot = useCallback(() => transcript.getGroup(id), [transcript, id]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * One item, subscribed by id.
 *
 * A `text.delta` notifies only the component holding that id, so a burst of
 * tokens re-renders one leaf rather than the list.
 */
export function useTranscriptItem(id: string): TranscriptItem | undefined {
  const { transcript } = usePaneRef();
  const subscribe = useCallback(
    (onChange: () => void) => transcript.subscribeItem(id, onChange),
    [transcript, id],
  );
  const snapshot = useCallback(() => transcript.getItem(id), [transcript, id]);
  return useSyncExternalStore(subscribe, snapshot);
}
