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
 * ## What does not change
 *
 * The card is `InlinePermission`, unchanged: the same three branches, the same
 * keyboard rules, the same failure path reported on the card. Answering here
 * settles the same request the transcript row is watching, because both read
 * the pane's queue and the transcript's item by the request's id. And the run
 * is parked exactly as before — nothing here lets it continue unanswered.
 *
 * ## Why one interactive surface, not two
 *
 * Rendering the live card in both places was the obvious first cut and is
 * wrong: two cards mean two drafts of the same answer, a note typed into one
 * and sent from the other, and two elements fighting to take focus when the
 * request arrives. The transcript row is a marker while the request is
 * pending for exactly that reason.
 */

import { useEffect, type ReactElement } from 'react';
import type { PermissionRequest } from '@rx-artemis/protocol';
import type { PermissionItem } from '@rx-artemis/transcript';

import { useTranscriptItem } from '../hooks/useTranscript';
import { usePane } from '../state/paneContext';
import { InlinePermission } from './InlinePermission';
import { cn } from '@/lib/utils';

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

/**
 * Bring a pinned request into view and put focus on its card.
 *
 * What the transcript marker's button does. Focus goes to the card itself
 * rather than a control on it, for the reason the cards give: the shortcuts
 * are bound there, a screen reader announces the whole ask, and nothing under
 * Enter can approve anything. `false` when nothing is pinned under that id —
 * the request was answered from the strip a moment ago, and the marker is
 * about to turn into the record.
 */
export function focusParkedAsk(requestId: string): boolean {
  const wrapper = document.getElementById(parkedAskId(requestId));
  if (wrapper === null) return false;
  wrapper.scrollIntoView({ block: 'nearest' });
  const card = wrapper.querySelector<HTMLElement>('[role="group"]') ?? wrapper;
  card.focus({ preventScroll: true });
  return true;
}

export function ParkedAsks({ columnMax }: { readonly columnMax: string }): ReactElement | null {
  const queue = usePane((s) => s.permissionQueue);
  if (queue.length === 0) return null;

  return (
    <div className={cn('mx-auto w-full px-3 pt-1', columnMax)}>
      {/*
        Bounded, and scrolling inside itself. A plan is a document and an
        interview can be three questions long; either could otherwise push the
        field off the bottom of the window, which would replace one way of
        losing the ask with another. Three fifths of the window: measured on a
        900px-tall window, a one-question card with a note field is about 350px
        and fits whole, and the transcript keeps its top two fifths — the ask
        is what needs the room while it is parked.
      */}
      <div
        role="region"
        aria-label={queue.length === 1 ? 'Waiting for your answer' : `${String(queue.length)} requests waiting for your answer`}
        className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto"
      >
        {queue.map((request) => (
          <ParkedAsk key={request.id} request={request} />
        ))}
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
