/**
 * The agent's question, rendered as a question.
 * ============================================================================
 *
 * A provider that wants to ask the user something has only one place to hand
 * control back mid-turn: the permission callback. So Claude's `AskUserQuestion`
 * arrives on the same wire as "may I run `rm -rf`", and the naive result is a
 * card that shows the user a JSON blob full of options and offers them Approve
 * and Deny — two buttons that answer a question nobody asked. Approving sends
 * the model no answer at all; denying sends it a refusal. Either way the thing
 * the agent actually wanted to know goes unanswered, and the user is left
 * authorising a tool call when they were being asked to make a choice.
 *
 * This card is the other branch. `InlinePermission` delegates here whenever the
 * request carries a decoded `question`, and the run is parked exactly the same
 * way — the only difference is what the user is shown and what goes back.
 *
 * ## What carries over from the permission card, and why
 *
 *  - **Inline, not a modal.** Same reason: a decision that fails to send has to
 *    be reported where the user is looking, and the card stays afterwards as
 *    the transcript's record of what was asked and answered.
 *  - **Focus lands on the card, not a control.** A screen reader announces the
 *    whole ask on landing, and the composer yields.
 *  - **Escape resolves rather than dismisses.** A parked run has no deadline,
 *    so the reflex that means "get this off my screen" must unblock it.
 *
 * ## What is deliberately different
 *
 *  - **Escape skips; it does not deny.** There is nothing here to refuse. A
 *    skip tells the model the questions went unanswered and to use its own
 *    judgement, which is what a person who does not want to choose means. A
 *    denial would read to the model as a rejection of the asking.
 *  - **Nothing is amber.** An approval is a risk decision and looks like one.
 *    A question is just a question.
 *  - **Free text sits alongside the options, not instead of them.** The model
 *    wrote the options; the user is under no obligation to agree that they are
 *    exhaustive. Prose is sent as a note against the question — it reaches the
 *    model as the user talking, rather than as an unrecognisable selection.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { CheckIcon, MessageCircleQuestionMarkIcon, TriangleAlertIcon } from 'lucide-react';
import type { Question, QuestionAnswer, QuestionPrompt } from '@rx-artemis/protocol';

import { respondToPermission } from '../state/store';
import { usePaneRef } from '../state/paneContext';
import type { PermissionItem } from '@rx-artemis/transcript';
import { CodeBlock, Fold, ToneBadge } from './primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function InlineQuestion({
  item,
  prompt,
}: {
  readonly item: PermissionItem;
  readonly prompt: QuestionPrompt;
}): ReactElement {
  return item.state === 'pending' ? (
    <PendingQuestion item={item} prompt={prompt} />
  ) : (
    <AnsweredRecord item={item} prompt={prompt} />
  );
}

/* -------------------------------------------------------------------------- */
/* Draft answers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the user has picked so far, keyed by position in the prompt.
 *
 * By index rather than by question text because the text is long, arbitrary and
 * model-authored, and nothing here needs it until the answer is sent. The
 * prompt is immutable for the life of the card, so the index is stable.
 */
type Draft = Record<number, { readonly options: readonly string[]; readonly notes: string }>;

const EMPTY = { options: [] as readonly string[], notes: '' };

function draftFor(draft: Draft, index: number): { options: readonly string[]; notes: string } {
  return draft[index] ?? EMPTY;
}

/** Whether anything has been said about this question — an option or a note. */
function said(entry: { options: readonly string[]; notes: string }): boolean {
  return entry.options.length > 0 || entry.notes.trim().length > 0;
}

function toAnswers(prompt: QuestionPrompt, draft: Draft): readonly QuestionAnswer[] {
  const answers: QuestionAnswer[] = [];
  prompt.questions.forEach((question, index) => {
    const entry = draftFor(draft, index);
    if (!said(entry)) return;
    const notes = entry.notes.trim();
    answers.push({
      question: question.question,
      options: entry.options,
      ...(notes.length > 0 ? { notes } : {}),
    });
  });
  return answers;
}

/* -------------------------------------------------------------------------- */
/* Pending                                                                    */
/* -------------------------------------------------------------------------- */

function PendingQuestion({
  item,
  prompt,
}: {
  readonly item: PermissionItem;
  readonly prompt: QuestionPrompt;
}): ReactElement {
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Same reasoning as the permission card: bring the ask into view, take focus
  // off the composer, and land on the card rather than on a control so the
  // whole question is announced and nothing is primed to fire.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.focus({ preventScroll: true });
  }, []);

  // The card answers the run in *its own* column, so a question parked on the
  // left stays answerable while the user works on the right.
  const pane = usePaneRef();
  const requestId = item.request.id;

  const answered = useMemo(
    () => prompt.questions.some((_, index) => said(draftFor(draft, index))),
    [prompt, draft],
  );

  const send = (answers: readonly QuestionAnswer[]): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    // Answering *is* allowing: the tool's only job is to carry the answers back
    // to the model. An empty array is the skip — see the store's `recordFor`.
    void respondToPermission(requestId, { behavior: 'allow', answers }, pane)
      .then((error) => setFailure(error))
      .finally(() => setBusy(false));
  };

  /**
   * Takes an updater, not a value.
   *
   * A multi-select toggle is read-modify-write on the current selection, and
   * the reader has to be the one React runs — two boxes ticked inside a single
   * batch both see the pre-batch value through the closure, and the second
   * write silently discards the first.
   */
  const setOptions = (
    index: number,
    update: (current: readonly string[]) => readonly string[],
  ): void =>
    setDraft((d) => {
      const entry = draftFor(d, index);
      return { ...d, [index]: { ...entry, options: update(entry.options) } };
    });

  const setNotes = (index: number, notes: string): void =>
    setDraft((d) => ({ ...d, [index]: { ...draftFor(d, index), notes } }));

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label={
        prompt.questions.length === 1
          ? (prompt.questions[0]?.question ?? 'The agent has a question')
          : `The agent has ${String(prompt.questions.length)} questions`
      }
      onKeyDown={(event) => {
        // Bound on the card rather than the window so they cannot fire while
        // the user is somewhere else entirely. Escape is handled globally too,
        // for the case where focus has wandered.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          send([]);
          return;
        }
        // ⌘↵ rather than a bare Enter, which belongs to the notes fields.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          send(toAnswers(prompt, draft));
        }
      }}
      /*
       * 7D's `.ask` shape — a tinted card behind a 45% edge — in cyan rather
       * than amber. The shape is what the three parked-run cards share, because
       * all three stop the run until they are answered and all three have to be
       * findable by scrolling. The hue is what tells them apart: the permission
       * card's amber says "a risk decision is waiting", and dressing a
       * multiple-choice question in the warning colour would spend the app's one
       * alarm on the agent being polite.
       */
      className="rounded-lg border border-cyan/45 bg-cyan/6 outline-none focus-visible:ring-2 focus-visible:ring-beam/50"
    >
      <div className="flex items-start gap-2 border-b border-hairline px-2.5 py-2">
        <MessageCircleQuestionMarkIcon
          className="mt-0.5 size-3.5 shrink-0 text-cyan"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {prompt.questions.length === 1
              ? 'The agent has a question'
              : `The agent has ${String(prompt.questions.length)} questions`}
          </p>
          <p className="mt-0.5 text-2xs leading-snug text-ink-muted">
            The run is paused here. Answer, or skip and it will carry on using its own judgement.
          </p>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-hairline">
        {prompt.questions.map((question, index) => (
          <QuestionBlock
            key={question.question}
            question={question}
            selected={draftFor(draft, index).options}
            notes={draftFor(draft, index).notes}
            disabled={busy}
            onSelect={(options) => setOptions(index, options)}
            onNotes={(notes) => setNotes(index, notes)}
          />
        ))}
      </div>

      {/*
       * Reported on the card, above the buttons that produced it — the same
       * argument the permission prompt makes for being inline. A parked run
       * waits forever, so a decision that did not land cannot be reported
       * anywhere the user is not already looking.
       */}
      {failure ? (
        <Alert variant="destructive" className="mx-2.5 mb-1 border-signal/45 bg-signal/10 py-2">
          <TriangleAlertIcon />
          <AlertTitle className="font-mono text-2xs">The answer did not reach the run</AlertTitle>
          <AlertDescription className="font-mono text-2xs leading-snug text-signal/90">
            {failure}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* One surface, as `.ask` has: the buttons sit on the card rather than on
          a strip of their own, and the rule above them is what separates
          reading from answering. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-2.5 py-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => send([])}>
          Skip
        </Button>
        <span className="ml-auto">
          <Button
            size="sm"
            disabled={busy || !answered}
            onClick={() => send(toAnswers(prompt, draft))}
          >
            <CheckIcon />
            {prompt.questions.length === 1 ? 'Send answer' : 'Send answers'}
          </Button>
        </span>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-2 text-2xs text-ink-faint">
        <Kbd>Esc</Kbd>
        <span>skip</span>
        <Kbd>⌘↵</Kbd>
        <span>send</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One question                                                               */
/* -------------------------------------------------------------------------- */

interface QuestionBlockProps {
  readonly question: Question;
  readonly selected: readonly string[];
  readonly notes: string;
  readonly disabled: boolean;
  readonly onSelect: (update: (current: readonly string[]) => readonly string[]) => void;
  readonly onNotes: (notes: string) => void;
}

function QuestionBlock({
  question,
  selected,
  notes,
  disabled,
  onSelect,
  onNotes,
}: QuestionBlockProps): ReactElement {
  // React's own, rather than anything derived from the request: a permission id
  // is `run-1:perm:2`, and colons in a DOM id are legal but unusable in a `#id`
  // selector. Nothing here needs the id to mean anything.
  const base = useId();
  const legendId = `${base}-legend`;

  const toggle = (label: string): void => {
    if (!question.multiSelect) {
      onSelect(() => [label]);
      return;
    }
    onSelect((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      // Order follows the options as offered rather than the order they were
      // clicked in: the answer is joined into one string for the model, and a
      // list that matches the question reads better than a click history.
      return question.options.map((o) => o.label).filter((option) => next.has(option));
    });
  };

  // Indexed, not labelled. An `id` may not contain whitespace, and an option
  // label is model-authored prose — `q-1-Fix the test` is invalid HTML, breaks
  // any `#id` selector, and takes the label/control association down with it.
  const rows = question.options.map((option, position) => (
    <OptionRow
      key={option.label}
      id={`${base}-o${String(position)}`}
      option={option}
      multiSelect={question.multiSelect}
      checked={selected.includes(option.label)}
      disabled={disabled}
      onToggle={() => toggle(option.label)}
    />
  ));

  return (
    <div className="px-2.5 py-2.5" role="group" aria-labelledby={legendId}>
      <div className="mb-1.5 flex items-baseline gap-2">
        {question.header ? <ToneBadge tone="cyan">{question.header}</ToneBadge> : null}
        {question.multiSelect ? (
          <span className="font-mono text-2xs text-ink-faint">choose any</span>
        ) : null}
      </div>
      <p id={legendId} className="mb-2 text-xs leading-snug text-ink">
        {question.question}
      </p>

      {/*
       * Radix's `RadioGroup` gives roving-tabindex and arrow-key movement for
       * the single-select case, which is what a keyboard user expects from a
       * list of mutually exclusive choices. Multi-select is a plain list of
       * checkboxes, where every box is its own tab stop — also what is
       * expected, and the reason these are not the same component.
       */}
      {question.multiSelect ? (
        <div className="flex flex-col gap-1">{rows}</div>
      ) : (
        <RadioGroup
          className="gap-1"
          value={selected[0] ?? ''}
          disabled={disabled}
          onValueChange={(label) => onSelect(() => [label])}
        >
          {rows}
        </RadioGroup>
      )}

      <div className="mt-2">
        <Label
          htmlFor={`${base}-notes`}
          className="mb-1 chrome-label text-ink-faint"
        >
          {selected.length > 0 ? 'add a note (optional)' : 'or answer in your own words'}
        </Label>
        <Textarea
          id={`${base}-notes`}
          rows={2}
          value={notes}
          disabled={disabled}
          spellCheck={false}
          placeholder="Sent alongside your choice, so the agent has your reasoning."
          onChange={(event) => onNotes(event.target.value)}
          className="min-h-12 bg-wash text-2xs md:text-2xs"
        />
      </div>
    </div>
  );
}

interface OptionRowProps {
  readonly id: string;
  readonly option: Question['options'][number];
  readonly multiSelect: boolean;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

function OptionRow({
  id,
  option,
  multiSelect,
  checked,
  disabled,
  onToggle,
}: OptionRowProps): ReactElement {
  return (
    <div
      className={cn(
        // The chosen row has to clear the card it sits on, and the card is now
        // a cyan wash itself — 5% inside 6% is a row nobody can see is picked.
        'rounded-md border px-2 py-1.5 transition-colors',
        checked ? 'border-cyan/45 bg-cyan/15' : 'border-hairline hover:border-hairline-strong',
      )}
    >
      <div className="flex items-start gap-2">
        {multiSelect ? (
          <Checkbox
            id={id}
            className="mt-0.5"
            checked={checked}
            disabled={disabled}
            onCheckedChange={onToggle}
          />
        ) : (
          <RadioGroupItem id={id} className="mt-0.5" value={option.label} disabled={disabled} />
        )}
        <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5">
          <span className="text-xs font-medium text-ink">{option.label}</span>
          {option.description ? (
            <span className="text-2xs leading-snug font-normal text-ink-muted">
              {option.description}
            </span>
          ) : null}
        </Label>
      </div>
      {option.preview ? (
        <Fold
          className="mt-1.5 pl-6"
          triggerClassName="text-2xs"
          summary={<span className="font-mono text-2xs">preview</span>}
        >
          {/*
           * A `CodeBlock`, i.e. plain text in a well. Providers describe this
           * field as markdown or as an HTML fragment, and it is neither here:
           * it is model-authored content arriving through a tool argument, and
           * the app does not hand model output a paintbrush for its own chrome.
           */}
          <CodeBlock text={option.preview} />
        </Fold>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Answered                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What an answered question leaves behind.
 *
 * The questions again, with what was chosen — not a one-line summary. The
 * transcript is the record of the conversation, and "Approach: rewrite in
 * place" a screen further down is unreadable without the question it answers.
 */
function AnsweredRecord({
  item,
  prompt,
}: {
  readonly item: PermissionItem;
  readonly prompt: QuestionPrompt;
}): ReactElement {
  const byQuestion = new Map((item.answers ?? []).map((a) => [a.question, a]));
  const settled = item.state === 'answered';

  return (
    <div className="rounded-lg border border-hairline bg-wash px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <MessageCircleQuestionMarkIcon
          className="size-3 shrink-0 text-ink-faint"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
          {prompt.questions.length === 1 ? 'asked a question' : 'asked some questions'}
        </span>
        <ToneBadge tone={settled ? 'cyan' : 'neutral'}>{item.state}</ToneBadge>
      </div>

      {settled ? (
        <dl className="mt-1.5 flex flex-col gap-1 pl-5">
          {prompt.questions.map((question) => {
            const answer = byQuestion.get(question.question);
            return (
              <div key={question.question} className="flex flex-col gap-0.5">
                <dt className="text-2xs leading-snug text-ink-faint">{question.question}</dt>
                <dd className="text-2xs leading-snug text-ink">
                  {answer && answer.options.length > 0 ? (
                    <span className="font-medium">{answer.options.join(', ')}</span>
                  ) : (
                    <span className="text-ink-faint italic">no option chosen</span>
                  )}
                  {answer?.notes ? (
                    <span className="text-ink-muted"> — {answer.notes}</span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : item.note ? (
        <p className="mt-1 pl-5 text-2xs text-ink-faint">{item.note}</p>
      ) : null}
    </div>
  );
}
