/**
 * The standing prompts — the rule half of the Instructions pane.
 * ============================================================================
 *
 * No longer a pane of its own: `InstructionsSection` composes these groups
 * above the memory banks, on the argument the old nav made from a distance —
 * a prompt library is the general case of "what the agent is told before the
 * conversation starts", and the banks are its best-known instance. The file
 * keeps its name because the section id `agents` is a frozen address, and the
 * file answering for an address is easier to find when it is named after it.
 *
 * A prompt library and the rules for which accounts each prompt reaches. What
 * the user writes here is appended to the provider's own system prompt on every
 * run, which makes this the one settings surface whose contents the model
 * actually reads — and that fact governs almost every decision below.
 *
 * ---------------------------------------------------------------------------
 * A LIST AND AN EDITOR, NOT A PAGE OF EDITORS
 * ---------------------------------------------------------------------------
 *
 * The obvious layout is every prompt expanded down the page. It falls apart at
 * three: prompts are paragraphs, not settings, so a stacked page becomes a
 * document with no way to see what is in it. So the list is a table of
 * contents — name, on/off, who it reaches — and exactly one prompt is open.
 *
 * Selection is local state and is deliberately not persisted. Which prompt you
 * were last editing is not a preference, and restoring it would reopen a
 * document the user closed the app on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCOPE LIST SHOWS PROFILES IT WILL NOT LET YOU TICK
 * ---------------------------------------------------------------------------
 *
 * Appending to a system prompt is a capability, not a universal: the Claude
 * adapter has one and the Codex adapter does not (see
 * `Capabilities.systemPromptAppend`). A Codex profile therefore cannot receive
 * a prompt from this pane, and the honest way to say so is to keep its row
 * exactly where it is, disabled, with the reason attached — the rule
 * `disabled-reason.tsx` exists to enforce. Hiding the row would leave a user
 * with two accounts wondering where the second one went, and would make "my
 * prompt is not working" a question with no visible answer.
 *
 * ---------------------------------------------------------------------------
 * BUILT-INS ARE DELETED BY BEING TURNED OFF
 * ---------------------------------------------------------------------------
 *
 * Artemis's own prompts have no delete button. Not to keep them: the read path
 * re-appends any built-in the document is missing (`parseAgentPromptsDocument`),
 * so a deleted one would reappear on the next open and read as the app
 * overruling the user. Turning it off is durable, does the same thing, and is
 * the only one of the two this app can honour.
 *
 * ---------------------------------------------------------------------------
 * ONE BUILT-IN IS EDITABLE, AND IT IS THE ONE ABOUT THE USER'S TEAM
 * ---------------------------------------------------------------------------
 *
 * A built-in is read-only because its text is a thing Artemis knows and keeps
 * current. The memory-bank prompt is the exception, because most of what it
 * says is not about Artemis at all: which facts belong in the bank, how this
 * team words a memory, what never goes in one. Artemis cannot know those, and
 * a team that disagrees with the shipped wording had, before this, no move
 * except turning the prompt off entirely and rewriting it from nothing.
 *
 * So editing it is allowed, and taking it over is recorded (`overridden`)
 * rather than inferred from the text having changed. The consequence the user
 * has to be told about is that Artemis stops updating it — which is what the
 * banner says, and what the reset button undoes.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { LockIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';

import type {
  AgentPrompt,
  AgentPromptScope,
  BuiltInPromptId,
  ProfileMetadata,
} from '@rx-artemis/protocol';
import { BUILT_IN_AGENT_PROMPTS, promptText, scopeCovers } from '@rx-artemis/protocol';

import type { AgentPromptsPane } from '../../hooks/useAgentPrompts';
import { newId } from '../../lib/id';
import { useApp } from '../../state/store';
import { WithReason } from '../disabled-reason';
import { MarkdownEditor } from '../MarkdownEditor';
import { StatusDot, ToneBadge } from '../primitives';
import { SettingsGroup } from './pane';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * The one built-in whose text is the user's to take over.
 *
 * A function rather than the id spelled out at each site, because the list and
 * the editor have to agree about it: the list stops claiming a row is locked at
 * exactly the moment the editor stops locking it. See the note on this module
 * for why it is this prompt and not built-ins in general.
 */
function isEditableBuiltIn(prompt: AgentPrompt): boolean {
  return prompt.builtIn === 'builtin:cerebro';
}

/** What a profile can be told, and why not when it cannot. */
interface ScopeTarget {
  readonly profile: ProfileMetadata;
  readonly reachable: boolean;
  /** Empty when reachable; a full sentence when not. */
  readonly reason: string;
}

export function AgentPromptsGroups({
  pane,
  banksAvailable,
}: {
  readonly pane: AgentPromptsPane;
  /**
   * The banks' condition, for the one built-in that depends on them. Handed
   * down from the pane's single `useMemoryBanks` reading rather than fetched
   * again here, so the two halves of Instructions cannot disagree about
   * whether the banks are configured *and* switched on — which is the
   * conjunction `engine.ts` composes runs with, and the only thing that makes
   * this row's "not being sent" line true. `null` while unknown, and a
   * failed read stays unknown rather than becoming a claim of "not available".
   */
  readonly banksAvailable: boolean | null;
}): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);

  const availableBuiltIns = useMemo((): ReadonlySet<BuiltInPromptId> => {
    const available = new Set<BuiltInPromptId>();
    if (banksAvailable === true) available.add('builtin:cerebro');
    return available;
  }, [banksAvailable]);

  const targets = useMemo((): readonly ScopeTarget[] => {
    return profiles.map((profile) => {
      const descriptor = providers.find((entry) => entry.id === profile.providerId);
      // Unknown provider reads as reachable rather than as blocked. The
      // descriptor list is fetched, so a profile can legitimately render before
      // its provider arrives — and disabling a checkbox for one frame teaches
      // the user something false about their account.
      const reachable = descriptor === undefined || descriptor.capabilities.systemPromptAppend;
      return {
        profile,
        reachable,
        reason: reachable
          ? ''
          : `${descriptor?.label ?? profile.providerId} cannot take instructions appended to its system prompt, so prompts from this pane never reach this profile.`,
      };
    });
  }, [profiles, providers]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    pane.prompts.find((prompt) => prompt.id === selectedId) ?? pane.prompts[0] ?? null;

  const addPrompt = (): void => {
    const prompt: AgentPrompt = {
      id: newId('prompt'),
      name: 'New prompt',
      markdown: '',
      enabled: true,
      // `all` rather than the profiles that happen to exist, per
      // `AgentPromptScope`: a new prompt should keep applying to an account
      // added next month unless the user says otherwise.
      scope: { kind: 'all' },
    };
    pane.setPrompts([...pane.prompts, prompt]);
    setSelectedId(prompt.id);
  };

  return (
    <>
      {pane.error !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.error}</p>
      ) : null}

      {pane.loading ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Reading the library…</p>
      ) : null}

      {!pane.loading && pane.error === null ? (
        <>
          <SettingsGroup label="Prompts">
            <div className="flex flex-col gap-0.5 p-1.5">
              {pane.prompts.map((prompt) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  pane={pane}
                  targets={targets}
                  available={availableBuiltIns}
                  selected={prompt.id === selected?.id}
                  onSelect={() => setSelectedId(prompt.id)}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <Button size="sm" variant="outline" onClick={addPrompt}>
                <PlusIcon aria-hidden="true" />
                New prompt
              </Button>
              {/* One of Artemis's prompts the user removed can be met again.
                  Offered here, beside "New prompt", because that is what it
                  is: adding a prompt to the library, in its shipped state —
                  not an undo of the removal, which took the user's edits to
                  it along. Absent when nothing was removed, so a library that
                  never touched a built-in reads exactly as it did. */}
              {pane.dismissedBuiltIns.map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant="ghost"
                  className="text-ink-faint"
                  onClick={() => {
                    pane.restoreBuiltIn(id);
                    setSelectedId(id);
                  }}
                >
                  <RotateCcwIcon aria-hidden="true" />
                  Bring back “{BUILT_IN_AGENT_PROMPTS[id]?.name ?? id}”
                </Button>
              ))}
            </div>
          </SettingsGroup>

          {selected === null ? (
            <p className="text-2xs leading-relaxed text-ink-faint">
              No prompts yet. A new one is sent to every profile until you narrow it.
            </p>
          ) : (
            <PromptEditor
              key={selected.id}
              prompt={selected}
              pane={pane}
              targets={targets}
              available={availableBuiltIns}
            />
          )}
        </>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Save state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether what is on screen is on disk.
 *
 * Present because the library has no save button — edits land on a debounce —
 * and a surface that writes silently owes the user a way to tell that it did.
 * The idle state says "Saved" rather than nothing, for the same reason: a
 * blank space is indistinguishable from a component that is broken. Exported
 * for the Instructions pane's title row, which is where a whole-pane indicator
 * belongs.
 */
export function SaveIndicator({ pane }: { readonly pane: AgentPromptsPane }): ReactElement | null {
  if (pane.loading || pane.error !== null) return null;
  if (pane.saveState.kind === 'error') {
    return <span className="text-2xs text-signal">{pane.saveState.message}</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-2xs text-ink-faint">
      <StatusDot tone={pane.saveState.kind === 'saving' ? 'amber' : 'mint'} />
      {pane.saveState.kind === 'saving' ? 'Saving…' : 'Saved'}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* One row in the list                                                        */
/* -------------------------------------------------------------------------- */

/** What a prompt's scope reads as in one line. */
function describeScope(
  scope: AgentPromptScope,
  targets: readonly ScopeTarget[],
): string {
  if (scope.kind === 'all') return 'every profile';
  const named = targets.filter((target) => scope.profileIds.includes(target.profile.id));
  if (named.length === 0) return 'no profiles — it will not be sent';
  if (named.length === 1) return named[0]!.profile.label;
  return `${named.length} profiles`;
}

function PromptRow({
  prompt,
  pane,
  targets,
  available,
  selected,
  onSelect,
}: {
  readonly prompt: AgentPrompt;
  readonly pane: AgentPromptsPane;
  readonly targets: readonly ScopeTarget[];
  readonly available: ReadonlySet<BuiltInPromptId>;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const builtIn = prompt.builtIn === undefined ? undefined : BUILT_IN_AGENT_PROMPTS[prompt.builtIn];
  const unavailable = prompt.builtIn !== undefined && !available.has(prompt.builtIn);

  const setEnabled = (enabled: boolean): void => {
    pane.setPrompts(pane.prompts.map((p) => (p.id === prompt.id ? { ...p, enabled } : p)));
  };

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-2 transition-colors',
        selected ? 'bg-wash-strong' : 'hover:bg-wash',
      )}
    >
      {/*
        The row is a button and the switch is not inside it — a control inside a
        control is the pattern that produces a "select" that sometimes toggles,
        depending on where in the row the pointer landed.
      */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
      >
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-xs leading-snug font-medium',
              prompt.enabled ? 'text-ink' : 'text-ink-faint',
            )}
          >
            {prompt.name}
          </span>
          {builtIn ? (
            <ToneBadge tone="neutral" className="gap-1">
              {/* The padlock is a claim about this row, not decoration: it says
                  the text below is Artemis's and cannot be changed. It belongs
                  only on the rows where that is still true. */}
              {isEditableBuiltIn(prompt) ? null : (
                <LockIcon aria-hidden="true" className="size-2.5" />
              )}
              {prompt.overridden === true ? 'built-in, edited' : 'built-in'}
            </ToneBadge>
          ) : null}
        </span>
        <span className="text-2xs leading-snug text-ink-faint">
          {prompt.enabled
            ? unavailable
              ? `On, but not sent — ${builtIn?.requires ?? 'its precondition'} is not true on this machine.`
              : `Sent to ${describeScope(prompt.scope, targets)}.`
            : 'Off — kept, never sent.'}
        </span>
      </button>

      <Switch
        checked={prompt.enabled}
        onCheckedChange={setEnabled}
        aria-label={`Send “${prompt.name}”`}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The open prompt                                                            */
/* -------------------------------------------------------------------------- */

function PromptEditor({
  prompt,
  pane,
  targets,
  available,
}: {
  readonly prompt: AgentPrompt;
  readonly pane: AgentPromptsPane;
  readonly targets: readonly ScopeTarget[];
  readonly available: ReadonlySet<BuiltInPromptId>;
}): ReactElement {
  const builtIn = prompt.builtIn === undefined ? undefined : BUILT_IN_AGENT_PROMPTS[prompt.builtIn];
  const unavailable = prompt.builtIn !== undefined && !available.has(prompt.builtIn);
  const editableBuiltIn = isEditableBuiltIn(prompt);
  const overridden = prompt.overridden === true;

  /**
   * Bumped when the user resets, and part of the editor's key.
   *
   * `MarkdownEditor` reads `value` once, so putting Artemis's text back in the
   * record does not put it back on screen — the live ProseMirror instance is
   * still holding what the user typed. Remounting is what actually restores it,
   * and it discards an undo history that no longer describes the document.
   */
  const [restored, setRestored] = useState(0);

  const patch = (change: Partial<AgentPrompt>): void => {
    pane.setPrompts(pane.prompts.map((p) => (p.id === prompt.id ? { ...p, ...change } : p)));
  };

  const remove = (): void => {
    // A built-in is removed through the pane's own mutator, which also records
    // the removal — filtering the row out alone would have it back on the next
    // read. See `AgentPromptsDocument.dismissedBuiltIns`.
    if (prompt.builtIn !== undefined) {
      pane.removeBuiltIn(prompt.builtIn);
      return;
    }
    pane.setPrompts(pane.prompts.filter((p) => p.id !== prompt.id));
  };

  const reset = (): void => {
    patch({ overridden: false, markdown: '' });
    setRestored((n) => n + 1);
  };

  return (
    <SettingsGroup label={builtIn ? `${prompt.name} — Artemis's own` : 'Prompt'}>
      {builtIn ? (
        <div className="flex items-start justify-between gap-3 px-3 py-2.5">
          <p className="text-2xs leading-relaxed text-ink-muted">
            {builtIn.summary}{' '}
            {editableBuiltIn ? (
              overridden ? (
                <>
                  You have rewritten it, so what is below is what gets sent and Artemis no longer
                  updates it. Reset to go back to Artemis's live version.
                </>
              ) : (
                <>
                  Artemis wrote this one and keeps it current until you edit it — after that the
                  text is yours, and reset brings Artemis's version back.
                </>
              )
            ) : (
              <>Artemis wrote this one and keeps it current, so it is shown rather than edited.</>
            )}{' '}
            It is only sent when {builtIn.requires}.
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {editableBuiltIn && overridden ? (
              <Button size="sm" variant="outline" onClick={reset}>
                <RotateCcwIcon aria-hidden="true" />
                Reset to Artemis's default
              </Button>
            ) : null}
            <DeleteButton
              name={prompt.name}
              onConfirm={remove}
              description="Artemis's text stays with Artemis, so nothing is lost: “Bring back” under the list puts it back in its shipped state. Any edits or narrowing you made to it go with the row. To stop sending it without removing it, turn it off instead."
            />
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-2 px-3 py-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="chrome-label text-ink-faint">
              Name
            </span>
            <Input
              value={prompt.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="House style"
              className="text-xs md:text-xs"
            />
          </label>
          <DeleteButton name={prompt.name} onConfirm={remove} />
        </div>
      )}

      {unavailable ? (
        <p className="flex items-center gap-1.5 px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          <StatusDot tone="amber" />
          Not being sent right now — {builtIn?.requires} is not true on this machine.
        </p>
      ) : null}

      {/* A genuine nested well, not a row: the editor keeps its own box so the
          typed text reads as a document rather than a settings field, and the
          wrapper's padding is what keeps that box off the card's edge. Its
          border color comes from the same call-site override the rest of this
          pane leans on — `MarkdownEditor` itself is out of scope here. */}
      <div className="px-3 py-2.5">
        <MarkdownEditor
          // Keyed by the caller, so this component never has to reconcile a
          // document change against a live ProseMirror instance. See
          // `MarkdownEditor` — `value` is read exactly once. The reset counter
          // joins the key because a reset is the one change of document that
          // happens without the selection changing.
          key={restored}
          // For a built-in still on Artemis's text this is Artemis's text, which
          // is what makes the first edit an edit *of* it rather than a blank page
          // the user has to fill from memory.
          value={builtIn ? promptText(prompt, pane.memoryBanks) : prompt.markdown}
          // The first keystroke on a pristine built-in is the act of taking it
          // over, so it carries the flag. Recording it here rather than inferring
          // it from the text differing keeps a round-trip through the serialiser
          // — which can renormalise whitespace on its own — from reading as a
          // decision the user never made.
          onChange={(markdown) =>
            patch(editableBuiltIn && !overridden ? { markdown, overridden: true } : { markdown })
          }
          readOnly={builtIn !== undefined && !editableBuiltIn}
          // Deliberately not the prompt's name. `MarkdownEditor` hands its
          // attributes to ProseMirror once, at construction, so a label built
          // from a field the user can rename would keep announcing the old name
          // for as long as the editor stays mounted — and the editor is
          // deliberately *not* remounted on a rename, so that renaming does not
          // discard the undo history. A stale accessible name is worse than a
          // general one; the group heading above carries the prompt's identity.
          ariaLabel="Prompt instructions"
          placeholder="Always run the typechecker before saying a change is done…"
          className="border-hairline"
        />
      </div>

      <ScopePicker prompt={prompt} targets={targets} onChange={(scope) => patch({ scope })} />
    </SettingsGroup>
  );
}

function DeleteButton({
  name,
  onConfirm,
  description = 'The text goes with it, and nothing here keeps a copy. To stop sending a prompt without losing what it says, turn it off instead.',
}: {
  readonly name: string;
  readonly onConfirm: () => void;
  /** What deleting costs. The default is written for a prompt the user wrote. */
  readonly description?: string;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-ink-faint" aria-label={`Delete “${name}”`}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which profiles this prompt reaches.
 *
 * "Every profile" is a checkbox above the list rather than a mode switch beside
 * it, because it is the *default* and the list underneath is what narrowing
 * looks like. Unticking it converts the standing answer into the concrete one —
 * seeded with every profile that can actually receive it, so the act of
 * narrowing does not itself turn every prompt off and make the user re-tick
 * what they already had.
 */
function ScopePicker({
  prompt,
  targets,
  onChange,
}: {
  readonly prompt: AgentPrompt;
  readonly targets: readonly ScopeTarget[];
  readonly onChange: (scope: AgentPromptScope) => void;
}): ReactElement {
  const all = prompt.scope.kind === 'all';

  const toggleProfile = (id: string, on: boolean): void => {
    const current = prompt.scope.kind === 'profiles' ? prompt.scope.profileIds : [];
    onChange({
      kind: 'profiles',
      profileIds: on ? [...current, id] : current.filter((entry) => entry !== id),
    });
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <span className="chrome-label text-ink-faint">
        Applies to
      </span>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          checked={all}
          onCheckedChange={(next) =>
            onChange(
              next === true
                ? { kind: 'all' }
                : {
                    kind: 'profiles',
                    profileIds: targets
                      .filter((target) => target.reachable)
                      .map((target) => target.profile.id),
                  },
            )
          }
        />
        <span className="flex flex-col">
          <span className="text-xs leading-snug text-ink">Every profile</span>
          <span className="text-2xs leading-snug text-ink-faint">
            Including accounts added later.
          </span>
        </span>
      </label>

      {all ? null : (
        <div className="flex flex-col gap-1 border-t border-hairline pt-2">
          {targets.length === 0 ? (
            <span className="text-2xs text-ink-faint">
              No profiles yet — add one in Profiles and it will appear here.
            </span>
          ) : null}
          {targets.map((target) => {
            const checked = scopeCovers(prompt.scope, target.profile.id);
            const row = (
              <label
                className={cn(
                  'flex items-center gap-2',
                  target.reachable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                )}
              >
                <Checkbox
                  checked={checked && target.reachable}
                  disabled={!target.reachable}
                  onCheckedChange={(next) => toggleProfile(target.profile.id, next === true)}
                />
                <span className="text-xs leading-snug text-ink">{target.profile.label}</span>
                <span className="text-2xs text-ink-faint">{target.profile.providerId}</span>
              </label>
            );
            return target.reachable ? (
              <span key={target.profile.id}>{row}</span>
            ) : (
              <WithReason
                key={target.profile.id}
                reason={target.reason}
                focusable={false}
                side="right"
                className="w-fit"
              >
                {row}
              </WithReason>
            );
          })}
        </div>
      )}
    </div>
  );
}
