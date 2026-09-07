/**
 * Everything the run is parked on, pinned above the prompt box.
 * ============================================================================
 *
 * A parked request — a question, an approval, a plan — used to be answerable
 * in exactly one place: the card at the point in the transcript where the
 * agent asked. That is the right place for the *record* of the ask, and it
 * was the wrong place for the *ask itself*: a long turn keeps writing under
 * the card, the tail follows the new text, and the question scrolls off the
 * top while the status line says "1 awaiting you". Finding it again meant
 * scrolling back through an unknown stretch of conversation, guided by a rail
 * label, to answer something the agent has been waiting on the whole time.
 *
 * So the ask lives here now. This strip sits inside the composer, directly
 * above the field, which is the one part of a column that is on screen no
 * matter where the transcript is scrolled — and it holds every request in the
 * pane's queue until each is answered. The transcript row keeps its place in
 * the story: while the request is pending it is a marker that says the ask is
 * waiting below and offers to jump there, and once it is settled it is the
 * same record it always was (see `PermissionRow` in `Transcript.tsx`).
 *
 * ## Minimising
 *
 * The pin is the right size for answering and the wrong size for *deciding*:
 * an interview or a plan can take half the window, and on a small screen the
 * transcript it covers is exactly what you need to read before you can answer.
 * So the strip minimises to its summary line — one row saying what is waiting,
 * with the control that brings it back — and the conversation gets the room.
 *
 * Three rules keep that from becoming a way to lose the ask again, which is
 * the failure this whole file exists to fix:
 *
 *  - **The summary never leaves.** Minimised is one line, not nothing: the
 *    strip, its region label, and the count are all still there, so a request
 *    cannot be out of sight while the agent waits on it.
 *  - **It survives an arrival, and counts it.** A request landing while the
 *    strip is minimised does not force it open — someone reading back has not
 *    changed their mind — but the summary says there are two now.
 *  - **It is forgotten when the queue empties.** Minimising is a decision
 *    about the ask in front of you, not a preference: answer everything and
 *    the next request arrives open, as if the button had never been pressed.
 *
 * The transcript marker's button opens the strip on its way to the card, so
 * the one route to the ask works from either state.
 *
 * ## What does not change
 *
 * The card is `InlinePermission`, unchanged: the same three branches, the same
 * keyboard rules, the same failure path reported on the card. Answering here
 * settles the same request the transcript row is watching, because both read
 * the pane's queue and the transcript's item by the request's id. And the run
 * is parked exactly as before — nothing here lets it continue unanswered, and
 * minimising least of all.
 *
 * ## Why one interactive surface, not two
 *
 * Rendering the live card in both places was the obvious first cut and is
 * wrong: two cards mean two drafts of the same answer, a note typed into one
 * and sent from the other, and two elements fighting to take focus when the
 * request arrives. The transcript row is a marker while the request is
 * pending for exactly that reason.
 */

import { useCallback, useEffect, useSyncExternalStore, type ReactElement } from 'react';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardListIcon,
  MessageCircleQuestionMarkIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import type { PermissionRequest } from '@rx-artemis/protocol';
import type { PermissionItem } from '@rx-artemis/transcript';

import { useTranscriptItem } from '../hooks/useTranscript';
import { usePane, usePaneRef } from '../state/paneContext';
import type { PaneId } from '../state/pane';
import { InlinePermission } from './InlinePermission';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Whether the strip is showing, per column                                   */
/* -------------------------------------------------------------------------- */

/**
 * Minimised, and which card to land on when it opens.
 *
 * `focusOnOpen` is the transcript marker's request travelling through a state
 * change: the card it names does not exist yet when the button is pressed, so
 * the strip records who asked and focuses it once the cards are mounted.
 */
interface PinState {
  readonly minimized: boolean;
  readonly focusOnOpen: string | null;
}

/** The state a column has until someone presses something. */
const OPEN: PinState = { minimized: false, focusOnOpen: null };

/*
 * A module map keyed by pane, not pane state, for the reason `foldMemory` gives
 * for folds: this is a reading position rather than anything the session owns,
 * and a column's store fans every write out to everything subscribed to it.
 * Two facts make the map the better home here. It is read by
 * `focusParkedAsk`, which is called from the transcript's marker and is not a
 * hook. And it must *not* be persisted or restored: a strip that came back
 * minimised for a request answered three days ago would hide the next one.
 */
const pins = new Map<PaneId, PinState>();
const listeners = new Map<PaneId, Set<() => void>>();

function pinState(pane: PaneId): PinState {
  return pins.get(pane) ?? OPEN;
}

function writePin(pane: PaneId, next: PinState): void {
  const now = pinState(pane);
  if (now.minimized === next.minimized && now.focusOnOpen === next.focusOnOpen) return;
  pins.set(pane, next);
  for (const notify of listeners.get(pane) ?? []) notify();
}

function subscribePin(pane: PaneId, notify: () => void): () => void {
  const set = listeners.get(pane) ?? new Set<() => void>();
  set.add(notify);
  listeners.set(pane, set);
  return () => {
    set.delete(notify);
  };
}

/** Drop every column's state. For tests; nothing in the app forgets a pane. */
export function forgetParkedAsks(): void {
  pins.clear();
}

/* -------------------------------------------------------------------------- */
/* Reaching one card                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The DOM id of a pinned request's wrapper.
 *
 * `getElementById` takes any string, so the request id — `run-1:perm:2`, with
 * its colons — is safe here; it is `#id` *selectors* that cannot carry one,
 * and nothing here writes one.
 */
export function parkedAskId(requestId: string): string {
  return `parked-ask:${requestId}`;
}

/** Land on a card that is on screen now. `false` when it is not. */
function focusCard(requestId: string): boolean {
  const wrapper = document.getElementById(parkedAskId(requestId));
  if (wrapper === null) return false;
  wrapper.scrollIntoView({ block: 'nearest' });
  const card = wrapper.querySelector<HTMLElement>('[role="group"]') ?? wrapper;
  card.focus({ preventScroll: true });
  return true;
}

/**
 * Bring a pinned request into view and put focus on its card.
 *
 * What the transcript marker's button does. Focus goes to the card itself
 * rather than a control on it, for the reason the cards give: the shortcuts
 * are bound there, a screen reader announces the whole ask, and nothing under
 * Enter can approve anything.
 *
 * A minimised strip is opened on the way — the button says "Answer below" and
 * must mean it — and the landing happens a commit later, once the card exists;
 * see the effect in {@link ParkedAsks}. `false` only when nothing is pinned
 * under that id on an open strip: the request was answered from the strip a
 * moment ago, and the marker is about to turn into the record.
 */
export function focusParkedAsk(pane: PaneId, requestId: string): boolean {
  if (pinState(pane).minimized) {
    writePin(pane, { minimized: false, focusOnOpen: requestId });
    return true;
  }
  return focusCard(requestId);
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                  */
/* -------------------------------------------------------------------------- */

/** What the summary line says, and the tint it carries. */
function summarise(queue: readonly PermissionRequest[]): {
  readonly text: string;
  readonly Icon: typeof ShieldAlertIcon;
  readonly question: boolean;
} {
  const only = queue.length === 1 ? queue[0] : undefined;
  if (only === undefined) {
    return {
      text: `${String(queue.length)} requests are waiting for your answer.`,
      Icon: ShieldAlertIcon,
      question: false,
    };
  }
  if (only.question !== undefined) {
    const count = only.question.questions.length;
    return {
      text:
        count === 1
          ? 'A question is waiting for your answer.'
          : `${String(count)} questions are waiting for your answer.`,
      Icon: MessageCircleQuestionMarkIcon,
      question: true,
    };
  }
  if (only.plan !== undefined) {
    return { text: 'A plan is waiting for your sign-off.', Icon: ClipboardListIcon, question: false };
  }
  return { text: 'A tool call is waiting for your approval.', Icon: ShieldAlertIcon, question: false };
}

export function ParkedAsks({ columnMax }: { readonly columnMax: string }): ReactElement | null {
  const queue = usePane((s) => s.permissionQueue);
  const pane = usePaneRef();
  const state = useSyncExternalStore(
    useCallback((notify: () => void) => subscribePin(pane.id, notify), [pane.id]),
    useCallback(() => pinState(pane.id), [pane.id]),
  );

  // Minimising is a decision about the ask in front of you. Once there is
  // nothing left to answer the strip forgets it, so the next request opens.
  useEffect(() => {
    if (queue.length === 0) writePin(pane.id, OPEN);
  }, [queue.length, pane.id]);

  /*
   * The landing asked for by the transcript marker.
   *
   * Here rather than in the card, and deliberately: every card focuses itself
   * on mount, so opening a strip that holds three of them ends with focus on
   * the *last*, whichever one the reader actually asked for. This effect
   * belongs to their parent and so runs after all of them — the last word in
   * the commit goes to the request that was named. No dependency array: it is
   * a one-shot that clears its own trigger, and re-running it on an unrelated
   * render costs one null check.
   */
  useEffect(() => {
    if (state.focusOnOpen === null || state.minimized) return;
    writePin(pane.id, OPEN);
    focusCard(state.focusOnOpen);
  });

  if (queue.length === 0) return null;

  const { text, Icon, question } = summarise(queue);
  const label =
    queue.length === 1
      ? 'Waiting for your answer'
      : `${String(queue.length)} requests waiting for your answer`;
  const listId = `parked-asks:${pane.id}`;

  return (
    <div className={cn('mx-auto w-full px-3 pt-1', columnMax)}>
      <div role="region" aria-label={label} className="flex flex-col gap-1.5">
        {/*
          The summary line. Minimised it is the whole strip and carries the
          card's own border and tint — a standing state, drawn the way the
          transcript's marker draws the same fact. Open, it is a bare row: the
          cards under it are bordered already, and a second frame around them
          would read as a panel rather than as what is waiting.
        */}
        <div
          className={cn(
            'flex items-center gap-2',
            state.minimized &&
              cn(
                'rounded-lg border px-2.5 py-1.5',
                question ? 'border-cyan/45 bg-cyan/6' : 'border-amber/45 bg-amber/8',
              ),
          )}
        >
          <Icon
            className={cn(
              'size-3.5 shrink-0',
              state.minimized ? (question ? 'text-cyan' : 'text-amber') : 'text-ink-faint',
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-2xs text-ink-muted">{text}</span>
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1"
            aria-expanded={!state.minimized}
            {...(state.minimized ? {} : { 'aria-controls': listId })}
            title={
              state.minimized
                ? 'Show the request again'
                : 'Hide it while you read back — it stays here, and the run stays parked, until you answer'
            }
            onClick={() => {
              writePin(pane.id, { minimized: !state.minimized, focusOnOpen: null });
            }}
          >
            {state.minimized ? (
              <>
                <ChevronUpIcon className="size-3" aria-hidden="true" />
                Show
              </>
            ) : (
              <>
                <ChevronDownIcon className="size-3" aria-hidden="true" />
                Hide
              </>
            )}
          </Button>
        </div>

        {/*
          Bounded, and scrolling inside itself. A plan is a document and an
          interview can be three questions long; either could otherwise push the
          field off the bottom of the window, which would replace one way of
          losing the ask with another. Three fifths of the window: measured on a
          900px-tall window, a one-question card with a note field is about 350px
          and fits whole, and the transcript keeps its top two fifths — the ask
          is what needs the room while it is parked.
        */}
        {!state.minimized && (
          <div id={listId} className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
            {queue.map((request) => (
              <ParkedAsk key={request.id} request={request} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One pinned request.
 *
 * The card is drawn from the transcript's own item when the transcript has
 * one, so a settling — an answer sent from anywhere, a request the provider
 * withdrew — is reflected here in the same tick it lands in the story. The
 * queue can run ahead of the transcript by an event; a request the transcript
 * has not filed yet is drawn from the request alone, pending, which is what
 * it is.
 */
function ParkedAsk({ request }: { readonly request: PermissionRequest }): ReactElement {
  const filed = useTranscriptItem(`p:${request.id}`);
  const item: PermissionItem =
    filed?.kind === 'permission'
      ? filed
      : {
          id: `p:${request.id}`,
          ts: request.requestedAt,
          kind: 'permission',
          requestId: request.id,
          request,
          state: 'pending',
        };

  // A request that arrives while the transcript is scrolled far up used to
  // be scrolled to by its own card. The card still does that, but the card is
  // in this strip now, and the strip is already on screen — so the only thing
  // left to do on arrival is make sure the strip's own scroller shows the
  // newest request rather than the first.
  useEffect(() => {
    document.getElementById(parkedAskId(request.id))?.scrollIntoView({ block: 'nearest' });
  }, [request.id]);

  return (
    <div id={parkedAskId(request.id)} className="shrink-0">
      <InlinePermission item={item} />
    </div>
  );
}
