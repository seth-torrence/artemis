/**
 * The agent's plan, rendered as a plan.
 * ============================================================================
 *
 * The third thing that arrives on the permission wire, and the one the generic
 * card served worst. `ExitPlanMode` is not a tool that wants to do something —
 * its work is already finished when it is called, and its "arguments" are a
 * document. What the user is being asked is "shall I go and do this", which is
 * not a question about risk at all.
 *
 * Rendered as an ordinary approval it came out like this: a markdown document
 * with headings, tables and code, JSON-escaped, in a scroller four lines tall,
 * under a label reading `arguments`, above buttons offering **Approve once**,
 * **Deny**, **Allow for this session** and a box asking for a *reason for
 * denial*. Every one of those is wrong. "Once" is meaningless for a plan that
 * will only be proposed once; "for this session" is meaningless for a document;
 * and the one thing the user actually needed to do — read it — was the one
 * thing the card made hardest.
 *
 * So this is the third branch, alongside {@link InlineQuestion}, and it follows
 * that component's reasoning rather than the permission card's.
 *
 * ## What carries over from the permission card
 *
 *  - **Inline, not a modal.** A decision that fails to send is reported on the
 *    card, above the buttons that produced it, because a parked run waits
 *    forever and a banner behind an overlay is invisible.
 *  - **Focus lands on the card, not a control.** The plan is announced on
 *    landing, and nothing is primed for a stray Enter.
 *  - **Escape resolves rather than dismisses.** The provider is blocked with no
 *    deadline, so the reflex that means "get this off my screen" has to unblock
 *    the run.
 *
 * ## What is deliberately different
 *
 *  - **The plan is markdown, so it renders as markdown.** Same treatment an
 *    agent's answer gets in the transcript, for the same reason: it is prose
 *    written to be read. `react-markdown` with no `rehype-raw`, so HTML inside
 *    a model-authored document stays inert text.
 *  - **Nothing is amber.** Approving a plan is not a risk judgement. The shield
 *    and the warning colour are the app's one alarm and this is not the place
 *    to spend it.
 *  - **Escape means "keep planning", not "deny".** Both are the same `deny` on
 *    the wire, but the words matter: the agent is being sent back to revise,
 *    not refused. The textarea is where that revision is written, which is why
 *    it is labelled for the note rather than for a denial.
 *  - **No "allow for this session".** There is no rule to persist. Approving is
 *    a one-off answer about one document.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { CheckIcon, ClipboardListIcon, PencilLineIcon, TriangleAlertIcon } from 'lucide-react';
import type { PlanProposal } from '@rx-artemis/protocol';

import { respondToPermission } from '../state/store';
import { usePaneRef } from '../state/paneContext';
import type { PermissionItem } from '@rx-artemis/transcript';
import { Markdown } from './Markdown';
import { ToneBadge } from './primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Past this, the plan is shown as plain text instead of parsed markdown.
 *
 * The same guard the transcript puts on an agent turn, at the same size. A plan
 * this long is pathological rather than merely thorough, and parsing it would
 * block the frame that is trying to tell the user the run is parked.
 */
const MARKDOWN_LIMIT = 80_000;

/** Sent when the user approves without typing anything. */
const KEEP_PLANNING = 'The user wants to keep planning. Revise the plan and propose it again.';

export function InlinePlan({
  item,
  proposal,
}: {
  readonly item: PermissionItem;
  readonly proposal: PlanProposal;
}): ReactElement {
  return item.state === 'pending' ? (
    <PendingPlan item={item} proposal={proposal} />
  ) : (
    <DecidedRecord item={item} />
  );
}

/* -------------------------------------------------------------------------- */
/* Pending                                                                    */
/* -------------------------------------------------------------------------- */

function PendingPlan({
  item,
  proposal,
}: {
  readonly item: PermissionItem;
  readonly proposal: PlanProposal;
}): ReactElement {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [clipped, setClipped] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Same reasoning as the other two cards: bring the ask into view, take focus
  // off the composer, and land on the card rather than on a button.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.focus({ preventScroll: true });
  }, []);

  /*
   * Whether the plan is taller than the box showing it.
   *
   * Measured once, because the plan is immutable for the life of this card —
   * the request cannot change under it, and the box's height is a fixed class.
   * A layout effect rather than an effect: this decides whether a fade is
   * painted over content the user is about to read, and doing it after the
   * browser has already shown the unfaded frame is a visible flicker.
   */
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    setClipped(box.scrollHeight > box.clientHeight + 1);
  }, []);

  // Answers the run in *its own* column, so a plan parked on the left stays
  // answerable while the user works on the right.
  const pane = usePaneRef();
  const request = item.request;

  const decide = (run: () => Promise<string | null>): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    void run()
      .then((error) => setFailure(error))
      .finally(() => setBusy(false));
  };

  /*
   * Approving echoes the provider's own suggestions back verbatim.
   *
   * Leaving plan mode is the provider's business, not this card's. `ExitPlanMode`
   * ends plan mode by running at all, and whatever mode it lands in is described
   * by the `setMode` update the provider attached to the request — which is why
   * this sends that update rather than one of its own choosing. A card that
   * picked the next mode itself would be inventing policy at the one moment the
   * provider has already stated it.
   */
  const approve = (): void =>
    decide(() =>
      respondToPermission(
        request.id,
        {
          behavior: 'allow',
          scope: 'once',
          ...(request.suggestions && request.suggestions.length > 0
            ? { updatedPermissions: request.suggestions }
            : {}),
        },
        pane,
      ),
    );

  const keepPlanning = (interrupt: boolean): void =>
    decide(() =>
      respondToPermission(
        request.id,
        {
          behavior: 'deny',
          message: note.trim().length > 0 ? note.trim() : KEEP_PLANNING,
          ...(interrupt ? { interrupt: true } : {}),
        },
        pane,
      ),
    );

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label={request.title ?? 'The agent has a plan'}
      onKeyDown={(event) => {
        // Bound on the card rather than the window so they cannot fire while the
        // user is somewhere else entirely. Escape is handled globally too, for
        // the case where focus has wandered.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          keepPlanning(false);
          return;
        }
        // ⌘↵ rather than a bare Enter, which belongs to the note field — and
        // because approving a plan starts real work, which a reflex should not
        // be able to do to a document the user has not finished reading.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          approve();
        }
      }}
      /*
       * The third card that parks a run, in 7D's `.ask` shape and its own hue.
       * Beam rather than amber: approving a plan is not a risk judgement, and
       * the shield's colour is the app's one alarm. The 6% wash is nowhere near
       * the 24% the user's bubble takes, so a proposal never reads as something
       * the user said.
       */
      className="rounded-lg border border-beam/45 bg-beam/6 outline-none focus-visible:ring-2 focus-visible:ring-beam/50"
    >
      <div className="flex items-start gap-2 border-b border-hairline px-2.5 py-2">
        <ClipboardListIcon className="mt-0.5 size-3.5 shrink-0 text-beam-text" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{request.title ?? 'The agent has a plan'}</p>
          <p className="mt-0.5 text-2xs leading-snug text-ink-muted">
            Nothing has been changed yet. Approving starts the work; sending it back keeps the run
            in planning.
          </p>
        </div>
      </div>

      {/*
       * The plan itself, and the reason this component exists.
       *
       * `.md` is the transcript's own markdown treatment, so a plan reads here
       * exactly as the agent's prose reads above it. Tall, because it is a
       * document and a four-line window on a document is useless — but bounded
       * and scrollable, because a long plan must not push the buttons that
       * answer it off the bottom of the pane.
       *
       * The fade below is not decoration. A bounded box on macOS has no visible
       * scrollbar at rest, so a plan cut off mid-sentence looks exactly like a
       * plan that ended there — and someone approving work they believe they
       * have read in full is the one outcome this card exists to prevent.
       */}
      <div className="relative">
        <div ref={scrollRef} className="max-h-[26rem] overflow-auto px-2.5 py-2">
          {proposal.plan.length > MARKDOWN_LIMIT ? (
            <div className="text-2xs leading-relaxed whitespace-pre-wrap text-ink">
              {proposal.plan}
            </div>
          ) : (
            <div className="md text-ink">
              <Markdown>{proposal.plan}</Markdown>
            </div>
          )}
        </div>
        {clipped ? (
          /* The fade has to end in the card's own colour or it draws a band
             across the plan instead of hiding the cut. The card is no longer a
             flat surface — it is a 6% wash of the beam over the window ground —
             so this is that composite spelled out, which is the one place in
             here a `color-mix` earns its keep. */
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-[color-mix(in_oklch,var(--color-beam)_6%,var(--color-abyss))]"
          />
        ) : null}
      </div>

      {clipped ? (
        <p className="px-2.5 pb-1 text-2xs text-ink-faint">
          Scroll to read the rest of the plan.
        </p>
      ) : null}

      {proposal.planPath ? (
        <p className="border-t border-hairline px-2.5 py-1.5 font-mono text-2xs break-all text-ink-faint">
          saved to {proposal.planPath}
        </p>
      ) : null}

      <div className="px-2.5 py-2">
        <Label
          htmlFor={`plan-note-${request.id}`}
          className="mb-1 chrome-label text-ink-faint"
        >
          what to change (optional)
        </Label>
        <Textarea
          id={`plan-note-${request.id}`}
          rows={2}
          value={note}
          spellCheck={false}
          placeholder="Handed back to the agent so it can revise the plan."
          onChange={(event) => setNote(event.target.value)}
          className="min-h-12 bg-wash font-mono text-2xs md:text-2xs"
        />
      </div>

      {/*
       * On the card, above the buttons that produced it. A parked run waits
       * forever, so a decision that did not land has to be reported where the
       * user is already looking.
       */}
      {failure ? (
        <Alert variant="destructive" className="mx-2.5 mb-1 border-signal/45 bg-signal/10 py-2">
          <TriangleAlertIcon />
          <AlertTitle className="font-mono text-2xs">The decision did not reach the run</AlertTitle>
          <AlertDescription className="font-mono text-2xs leading-snug text-signal/90">
            {failure}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* One surface, as `.ask` has: the controls sit on the card, with the rule
          above them doing the separating a second fill used to. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-2.5 py-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => keepPlanning(false)}>
          <PencilLineIcon />
          Keep planning
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => keepPlanning(true)}>
          Stop the run
        </Button>

        <span className="ml-auto">
          <Button size="sm" disabled={busy} onClick={approve}>
            <CheckIcon />
            Approve plan
          </Button>
        </span>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-2 text-2xs text-ink-faint">
        <Kbd>Esc</Kbd>
        <span>keep planning</span>
        <Kbd>⌘↵</Kbd>
        <span>approve plan</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Decided                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a settled plan leaves behind.
 *
 * Deliberately not the plan again. Unlike an answered question — where the
 * choices are meaningless without the question beside them — an approved plan
 * is about to be carried out in full, in the transcript directly below this
 * card. Repeating the document here would say everything twice.
 */
function DecidedRecord({ item }: { readonly item: PermissionItem }): ReactElement {
  const approved = item.state === 'allowed';
  return (
    <div className="rounded-lg border border-hairline bg-wash px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <ClipboardListIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
          {approved ? 'plan approved' : 'plan sent back'}
        </span>
        <ToneBadge tone={approved ? 'mint' : 'neutral'}>
          {approved ? <CheckIcon className="size-2.5" aria-hidden="true" /> : null}
          {approved ? 'approved' : 'planning'}
        </ToneBadge>
      </div>
      {item.note ? <p className="mt-1 pl-5 text-2xs text-ink-faint">{item.note}</p> : null}
    </div>
  );
}
