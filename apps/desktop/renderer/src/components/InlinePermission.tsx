/**
 * The permission prompt, rendered inline in the transcript.
 * ============================================================================
 *
 * When this is pending the run is *parked*: the adapter is blocked inside its
 * `canUseTool` callback and nothing else will happen until a decision is sent.
 * There is no deadline on the provider side, so an unanswered prompt is a
 * wedged agent.
 *
 * ## Why inline rather than a modal
 *
 * The obvious design is a dialog, and it was one. Three things are better here:
 *
 *  1. **The failure path is visible.** A decision that fails to send has to be
 *     reported where the user is looking. A modal covers the window, so a
 *     banner behind it or a toast beneath it is invisible, and the user is left
 *     staring at a dialog that appeared to do nothing. `respondToPermission`
 *     returns a sentence rather than throwing, and it is rendered on this card,
 *     directly above the buttons, where it cannot be missed.
 *  2. **The ask keeps its context.** The prompt sits where it happened — after
 *     the reasoning that led to it and the tool calls before it — instead of
 *     covering all of that up at the moment it matters most.
 *  3. **The decision stays on the record.** The card does not disappear when
 *     answered; it becomes the transcript's note of what was decided and why.
 *
 * ## Rules that carried over from the modal, unchanged
 *
 *  - **Arguments are rendered verbatim.** They are the actual ask, and a
 *    friendly summary that hid `rm -rf` inside a sentence would be a security
 *    bug.
 *  - **Nothing is focused that Enter could fire.** Focus lands on the card
 *    itself, never on Approve, so a stray Enter cannot approve a tool call the
 *    user has not read.
 *  - **Escape means deny, not dismiss.** Denying is the safe answer *and* it
 *    unblocks the provider, so the reflex to press Escape resolves the run
 *    instead of stranding it.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { CheckIcon, ShieldAlertIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import type { PermissionRuleUpdate } from '@rx-artemis/protocol';

import { formatJson } from '@rx-artemis/transcript';
import { DEFAULT_DENIAL, activeProfile, respondToPermission } from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import type { PermissionItem } from '@rx-artemis/transcript';
import { InlinePlan } from './InlinePlan';
import { InlineQuestion } from './InlineQuestion';
import { CodeBlock, Fold, ToneBadge } from './primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The suggested rule changes, as a remote run may actually receive them.
 *
 * A suggestion arrives from the provider CLI carrying its own scope, and that
 * scope is frequently durable — `project`, `local`, `user` — because locally
 * those are exactly what "stop asking me about this" should write. Across a
 * connection token they are not available: a durable rule writes to the
 * *serving* machine's settings, which is someone else's disk, and both the
 * server's parser and `guardRemoteDecision` refuse the whole decision when one
 * appears.
 *
 * The refusal is right and stays. What was wrong is that the button offering
 * them was drawn anyway, so "Allow for this session" on a remote run failed
 * every time with a message about durable scopes, leaving "Approve once" as
 * the only answer that worked — once per prompt, forever.
 *
 * Narrowing rather than hiding, because `session` is what the button already
 * promises. The rule still stops the run asking again; it simply stops at the
 * end of the run instead of being written down. That is the whole of what a
 * connection token can offer, and it is most of what the user wanted.
 *
 * Rule *kinds* the token cannot carry at any scope are dropped instead — see
 * the filter. A card left with no suggestions draws no button, which is the
 * honest state: there is nothing here a remote answer could say.
 */
export function scopedForRun(
  suggestions: readonly PermissionRuleUpdate[],
  remote: boolean,
): readonly PermissionRuleUpdate[] {
  if (!remote) return suggestions;
  return (
    suggestions
      /*
       * Two kinds cannot be narrowed, only dropped. A mode switch changes how
       * the run asks — the serving user's setting, not this client's to change —
       * and a directory grant widens the connection's pinned workspace by the
       * very thing the workspace constrains. The guard refuses both at any
       * scope, and the CLI does suggest them: `setMode` on a prompt it thinks
       * is noisy, `addDirectories` for an edit outside the working directory.
       * Left in, they would fail the decision exactly as a durable scope did.
       */
      .filter(
        (update) =>
          update.type !== 'setMode' &&
          update.type !== 'addDirectories' &&
          update.type !== 'removeDirectories',
      )
      .map((update) =>
        update.scope === undefined || update.scope === 'once' || update.scope === 'session'
          ? update
          : { ...update, scope: 'session' as const },
      )
  );
}

export function InlinePermission({ item }: { readonly item: PermissionItem }): ReactElement {
  /*
   * Not every parked request is an approval. A provider can only hand control
   * back mid-turn through the permission callback, so tools whose entire purpose
   * is to put something in front of a person arrive here too — and rendering
   * those as approvals offers Approve and Deny to a question that wanted an
   * answer, or to a plan that wanted a decision.
   *
   * Two branches, then, and everything below is unchanged for the requests that
   * really are about permission. Both decoders are strict and both fall through
   * to the verbatim-arguments card when the arguments do not parse — ugly, but
   * still answerable, which is what a parked run needs above all.
   */
  const plan = item.request.plan;
  if (plan) return <InlinePlan item={item} proposal={plan} />;

  const question = item.request.question;
  if (question) return <InlineQuestion item={item} prompt={question} />;

  return item.state === 'pending' ? (
    <PendingPrompt item={item} />
  ) : (
    <ResolvedRecord item={item} />
  );
}

/* -------------------------------------------------------------------------- */
/* Pending                                                                    */
/* -------------------------------------------------------------------------- */

function PendingPrompt({ item }: { readonly item: PermissionItem }): ReactElement {
  const request = item.request;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  /**
   * Scroll the ask into view and take focus off the composer.
   *
   * Focus goes to the card, not to a button: the card is what the shortcuts
   * below are bound to, a screen reader announces the whole ask on landing, and
   * — critically — there is nothing under the cursor or the Enter key that
   * approves anything. `preventScroll` because the `scrollIntoView` on the
   * previous line already decided where the viewport goes, and letting the
   * focus call move it again fights the transcript's tail-following.
   */
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.focus({ preventScroll: true });
  }, []);

  // The card answers the run in *its own* column. A prompt parked on the left
  // must stay answerable while the user works on the right, so the decision is
  // routed by the pane the card is rendered in rather than by what has focus.
  const pane = usePaneRef();
  // The same question the navigator asks: a profile belongs to one provider,
  // and `artemis` is the one that reaches another machine.
  const remote = usePane((state) => activeProfile(state)?.providerId === 'artemis');

  const decide = (run: () => Promise<string | null>): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    void run()
      .then((error) => setFailure(error))
      .finally(() => setBusy(false));
  };

  const allow = (updates?: readonly PermissionRuleUpdate[]): void =>
    decide(() =>
      respondToPermission(
        request.id,
        {
          behavior: 'allow',
          scope: updates ? 'session' : 'once',
          ...(updates ? { updatedPermissions: updates } : {}),
        },
        pane,
      ),
    );

  const deny = (interrupt: boolean): void =>
    decide(() =>
      respondToPermission(
        request.id,
        {
          behavior: 'deny',
          message: reason.trim().length > 0 ? reason.trim() : DEFAULT_DENIAL,
          ...(interrupt ? { interrupt: true } : {}),
        },
        pane,
      ),
    );

  const suggestions = scopedForRun(request.suggestions ?? [], remote);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label={request.title ?? `${request.toolName} needs your approval`}
      onKeyDown={(event) => {
        // Bound on the card rather than the window so they cannot fire while
        // the user is somewhere else entirely — and Escape is handled globally
        // too, for the case where focus has wandered.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          deny(false);
          return;
        }
        // A modifier is required for approval. A bare Enter is far too easy to
        // hit on reflex, and this is the one control in the app where a reflex
        // must not be able to authorise something unread.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          allow();
        }
      }}
      /*
       * The gate, in the gate's colour. 7D draws this card as `.ask`: the
       * warning hue at 45% for the edge, the gate wash behind it, and nothing
       * else in the pane wearing either. The neutral card this replaced was a
       * reaction to an earlier, louder amber — a solid tint with a heavy border
       * — and it over-corrected: a parked run is the one thing in the app that
       * is *allowed* to be findable by colour, because the run is stopped until
       * it is answered. At 8% behind and 45% on the edge it is unmistakable
       * without being an alarm.
       *
       * The focus ring stays beam, because beam *is* the focus ring in this
       * palette (see `index.css`), and a ring drawn in the card's own hue would
       * be a focus state you cannot see against the card.
       */
      className="rounded-lg border border-amber/45 bg-amber/8 outline-none focus-visible:ring-2 focus-visible:ring-beam/50"
    >
      <div className="flex items-start gap-2 border-b border-hairline px-2.5 py-2">
        <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {request.title ?? `${request.toolName} needs your approval`}
          </p>
          <p className="mt-0.5 text-2xs leading-snug text-ink-muted">
            {request.description ?? 'The run is paused here. Nothing happens until you answer.'}
          </p>
          <p className="mt-1 font-mono text-2xs text-ink-faint">
            tool <span className="text-cyan">{request.toolName}</span>
            {request.blockedPath ? ` · path ${request.blockedPath}` : ''}
            {request.agentId ? ` · subagent ${request.agentId.slice(0, 8)}` : ''}
          </p>
        </div>
      </div>

      <div className="px-2.5 py-2">
        {request.reason ? (
          <p className="mb-2 rounded-none border border-hairline bg-wash px-2.5 py-1.5 font-mono text-2xs text-ink-muted">
            {request.reason}
          </p>
        ) : null}

        <p className="mb-1 chrome-label text-ink-faint">arguments</p>
        <CodeBlock text={formatJson(request.input)} className="max-h-56" />

        {suggestions.length > 0 ? (
          <Fold
            className="mt-2"
            triggerClassName="text-2xs"
            summary={
              <span className="font-mono text-2xs">
                {suggestions.length} rule change{suggestions.length === 1 ? '' : 's'} offered
              </span>
            }
          >
            <CodeBlock text={JSON.stringify(suggestions, null, 2)} />
          </Fold>
        ) : null}

        <div className="mt-2.5">
          <Label
            htmlFor={`deny-reason-${request.id}`}
            className="mb-1 chrome-label text-ink-faint"
          >
            reason for denial (optional)
          </Label>
          <Textarea
            id={`deny-reason-${request.id}`}
            rows={2}
            value={reason}
            spellCheck={false}
            placeholder="Handed back to the model so it can try something else."
            onChange={(event) => setReason(event.target.value)}
            className="min-h-12 bg-wash font-mono text-2xs md:text-2xs"
          />
        </div>
      </div>

      {/*
       * THE POINT OF RENDERING THIS INLINE. A failed decision is reported on
       * the card, above the buttons that produced it. Nothing covers it, so it
       * cannot be missed, and the buttons stay live to try again.
       */}
      {failure ? (
        <Alert
          variant="destructive"
          className="mx-2.5 mb-1 border-signal/45 bg-signal/10 py-2"
        >
          <TriangleAlertIcon />
          <AlertTitle className="font-mono text-2xs">The decision did not reach the run</AlertTitle>
          <AlertDescription className="font-mono text-2xs leading-snug text-signal/90">
            {failure}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* The buttons sit on the card, not on a strip of their own: 7D's `.ask`
          has one surface, and a second fill under the row of controls only made
          the card look like two cards. The rule above them stays — it is what
          separates reading from answering. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-2.5 py-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => deny(false)}>
          <XIcon />
          Deny
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => deny(true)}>
          Deny &amp; stop run
        </Button>

        <span className="ml-auto flex items-center gap-2">
          {suggestions.length > 0 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => allow(suggestions)}>
              Allow for this session
            </Button>
          ) : null}
          <Button size="sm" disabled={busy} onClick={() => allow()}>
            <CheckIcon />
            Approve once
          </Button>
        </span>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-2 text-2xs text-ink-faint">
        <Kbd>Esc</Kbd>
        <span>deny</span>
        <Kbd>⌘↵</Kbd>
        <span>approve once</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Resolved                                                                   */
/* -------------------------------------------------------------------------- */

/** What an answered prompt leaves behind: a compact record of the decision. */
function ResolvedRecord({ item }: { readonly item: PermissionItem }): ReactElement {
  const allowed = item.state === 'allowed';
  return (
    <div
      className={cn(
        'rounded-lg border bg-wash px-2.5 py-1.5',
        allowed ? 'border-hairline' : 'border-signal/30',
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldAlertIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
          {item.request.title ?? `${item.request.toolName} needed approval`}
        </span>
        <ToneBadge tone={allowed ? 'mint' : 'signal'}>
          {allowed ? (
            <CheckIcon className="size-2.5" aria-hidden="true" />
          ) : (
            <XIcon className="size-2.5" aria-hidden="true" />
          )}
          {item.state}
        </ToneBadge>
      </div>
      {item.note ? <p className="mt-1 pl-5 text-2xs text-ink-faint">{item.note}</p> : null}
    </div>
  );
}
