/**
 * Routines — the pane where appointments are made.
 *
 * A list of scheduled runs and one form, following the profile screen's
 * grammar: cards for what exists, a bordered form for what is being made. The
 * schedule itself lives in `@rx-artemis/protocol` (`RoutineSchedule` and the
 * minute math), so what this file owns is only the asking — every "when does
 * this fire next" is `nextFireAt` from the same module the scheduler ticks on,
 * which is what keeps the pane and the scheduler from ever disagreeing.
 */

import { useState, type FormEvent, type ReactElement } from 'react';
import { PauseIcon, PlayIcon, PlusIcon, Trash2Icon, ZapIcon } from 'lucide-react';

import {
  describeSchedule,
  scheduleProblem,
  type ProviderId,
  type RoutineDraft,
  type RoutineRunRecord,
  type RoutineSchedule,
  type RoutineSnapshot,
} from '@rx-artemis/protocol';

import { useRoutines } from '@/hooks/useRoutines';
import { formatRelative, formatUntil } from '@rx-artemis/transcript';
import { shortenPath } from '../../lib/paths';
import { activeModels, useApp } from '../../state/store';
import { usePane } from '../../state/paneContext';
import { SettingsPane } from './pane';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToneBadge } from '../primitives';
import { IconButton } from '../disabled-reason';

/** The schedule kinds the form offers, in the order they are met. */
const SCHEDULE_KINDS = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'cron', label: 'Cron' },
  { id: 'manual', label: 'Manual' },
] as const;

const WEEKDAYS = [
  { id: '1', label: 'Monday' },
  { id: '2', label: 'Tuesday' },
  { id: '3', label: 'Wednesday' },
  { id: '4', label: 'Thursday' },
  { id: '5', label: 'Friday' },
  { id: '6', label: 'Saturday' },
  { id: '0', label: 'Sunday' },
];

/** What the form holds while a schedule is being described. */
interface ScheduleForm {
  readonly kind: (typeof SCHEDULE_KINDS)[number]['id'];
  readonly at: string;
  readonly minute: string;
  readonly day: string;
  readonly expression: string;
}

const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  kind: 'daily',
  at: '09:00',
  minute: '0',
  day: '1',
  expression: '0 9 * * 1-5',
};

function toSchedule(form: ScheduleForm): RoutineSchedule {
  switch (form.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'hourly':
      return { kind: 'hourly', minute: Number(form.minute) };
    case 'daily':
      return { kind: 'daily', at: form.at };
    case 'weekdays':
      return { kind: 'weekdays', at: form.at };
    case 'weekly':
      return { kind: 'weekly', day: Number(form.day), at: form.at };
    case 'cron':
      return { kind: 'cron', expression: form.expression };
  }
}

function toScheduleForm(schedule: RoutineSchedule): ScheduleForm {
  switch (schedule.kind) {
    case 'manual':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'manual' };
    case 'hourly':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'hourly', minute: String(schedule.minute) };
    case 'daily':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'daily', at: schedule.at };
    case 'weekdays':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'weekdays', at: schedule.at };
    case 'weekly':
      return {
        ...DEFAULT_SCHEDULE_FORM,
        kind: 'weekly',
        day: String(schedule.day),
        at: schedule.at,
      };
    case 'cron':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'cron', expression: schedule.expression };
  }
}

/** One firing's verdict, in the palette's own words: mint settles, amber
 * warns, signal fails — the same assignments the transcript's badges make. */
function outcomeTone(row: RoutineRunRecord): 'mint' | 'amber' | 'signal' | 'cyan' {
  switch (row.outcome) {
    case 'completed':
      return 'mint';
    case 'running':
      return 'cyan';
    case 'skipped':
    case 'interrupted':
      return 'amber';
    case 'error':
      return 'signal';
  }
}

function outcomeLabel(row: RoutineRunRecord): string {
  if (row.outcome === 'skipped') {
    return row.skipReason === 'overlap'
      ? 'skipped — still running'
      : `skipped — ${row.skipReason ?? 'skipped'}`;
  }
  if (row.outcome === 'error' && row.endReason !== undefined && row.endReason !== 'error') {
    return row.endReason.replaceAll('_', ' ');
  }
  return row.outcome;
}

export function RoutinesSection(): ReactElement {
  const { state, busy, create, update, remove, runNow } = useRoutines();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const editingRoutine = state.routines.find((routine) => routine.id === editing) ?? null;

  return (
    <SettingsPane
      title="Routines"
      description="Runs the app starts on a schedule — same transcripts, same history as a prompt you typed. The machine has to be awake; a missed appointment fires once on wake, and older misses are let go."
      actions={
        creating || editingRoutine !== null ? null : (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New routine
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {state.routines.length === 0 && !creating ? (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Nothing scheduled. A routine is a prompt with an appointment — a morning triage, a
            nightly digest — run under the profile you pick, in the directory you name.
          </p>
        ) : null}

        {creating || editingRoutine !== null ? (
          <RoutineForm
            key={editingRoutine?.id ?? 'new'}
            routine={editingRoutine}
            busy={busy}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSubmit={(draft) => {
              if (editingRoutine === null) create(draft);
              else update(editingRoutine.id, draft);
              setCreating(false);
              setEditing(null);
            }}
          />
        ) : (
          state.routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              busy={busy}
              onEdit={() => setEditing(routine.id)}
              onRunNow={() => runNow(routine.id)}
              onTogglePause={() => update(routine.id, { paused: !routine.paused })}
              onDelete={() => remove(routine.id)}
            />
          ))
        )}
      </div>
    </SettingsPane>
  );
}

function RoutineCard({
  routine,
  busy,
  onEdit,
  onRunNow,
  onTogglePause,
  onDelete,
}: {
  readonly routine: RoutineSnapshot;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onRunNow: () => void;
  readonly onTogglePause: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const profile = profiles.find((entry) => entry.id === routine.profileId);

  return (
    // The card primitive still writes its own `border-line` and `rounded-md`;
    // Console draws a card at the surface radius with a hairline, so the call
    // site says so rather than the shared primitive being bent for one pane.
    <Card className="rounded-lg border-hairline">
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {routine.name}
          </span>
          {routine.running ? <ToneBadge tone="cyan">running</ToneBadge> : null}
          {routine.paused ? <ToneBadge tone="amber">paused</ToneBadge> : null}
          <IconButton
            label="Run now"
            disabled={busy || routine.running}
            disabledReason={routine.running ? 'A firing is already running.' : undefined}
            onClick={onRunNow}
          >
            <ZapIcon />
          </IconButton>
          <IconButton
            label={routine.paused ? 'Resume the schedule' : 'Pause the schedule'}
            disabled={busy}
            onClick={onTogglePause}
          >
            {routine.paused ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton
            label="Delete the routine and its history"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2Icon />
          </IconButton>
        </div>

        <button
          type="button"
          className="flex flex-col items-start gap-0.5 text-left"
          onClick={onEdit}
        >
          <span className="text-2xs text-ink-muted">
            {describeSchedule(routine.schedule)}
            {routine.nextFireAt === undefined
              ? ''
              : ` — next ${formatUntil(routine.nextFireAt)}`}
          </span>
          <span className="text-2xs text-ink-faint">
            {profile?.label ?? routine.profileId} · {shortenPath(routine.cwd)}
            {routine.model === undefined ? '' : ` · ${routine.model}`}
          </span>
        </button>

        {routine.history.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-hairline pt-2">
            {routine.history.slice(0, 3).map((row) => (
              <div key={`${row.firedAt}`} className="flex items-center gap-2 text-2xs">
                <ToneBadge tone={outcomeTone(row)}>{outcomeLabel(row)}</ToneBadge>
                <span className="text-ink-faint">{formatRelative(row.firedAt)}</span>
                {row.catchUp === true ? (
                  <span className="text-ink-faint">· made up after a sleep</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A Radix `SelectItem` may not carry an empty value, so "no model" wears a sentinel. */
const PROVIDER_DEFAULT = '__provider-default__';
const NO_PINS: readonly string[] = [];

/**
 * The routine's model, chosen from the catalogue rather than typed.
 *
 * This was a free-text input, which meant a routine could be aimed at a model
 * that does not exist and nobody would learn it until the appointment fired
 * and the provider shrugged — the one failure mode a *scheduled* run cannot
 * afford, because there is no person at the keyboard to read the error. The
 * picker offers the same catalogue every other model control reads: the
 * pane's live-preferred list when the routine bills the provider the window
 * is on, and the provider descriptor's built-in lineup otherwise.
 *
 * The profile's pinned models lead the menu, in the quick picker's own order,
 * because a routine is usually aimed at a model its owner already switches
 * between. Free text survives in exactly one case — a provider with no
 * catalogue at all — where a picker would be an empty menu over a field that
 * used to work. And a stored model the catalogue no longer lists stays
 * choosable under its own name, flagged, rather than being silently blanked:
 * editing a routine's schedule must not cost it its model.
 */
function ModelField({
  profileId,
  value,
  onChange,
}: {
  readonly profileId: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);
  const paneProviderId = usePane((s) => s.activeProviderId);
  const paneCatalogue = usePane(activeModels);
  // The raw entry, defaulted *outside* the selector: `?? []` inside it would
  // hand zustand a fresh identity on every read and loop the render.
  const pins = usePane((s) => s.quickModelIdsByProfile[profileId]) ?? NO_PINS;

  const providerId = profiles.find((profile) => profile.id === profileId)?.providerId;
  const catalogue =
    providerId !== undefined && providerId === paneProviderId
      ? paneCatalogue
      : (providers.find((provider) => provider.id === providerId)?.models ?? []);

  if (catalogue.length === 0) {
    // No catalogue to validate against, so the honest control is the old one:
    // free text, sent as typed.
    return (
      <Field>
        <FieldLabel htmlFor="routine-model" className="chrome-label text-ink-faint">
          Model (optional)
        </FieldLabel>
        <Input
          id="routine-model"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="Provider default"
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs md:text-xs"
        />
        <FieldDescription className="text-2xs">
          This provider published no model list, so the id is sent as written.
        </FieldDescription>
      </Field>
    );
  }

  const known = catalogue.some((model) => model.id === value);
  const pinned = catalogue.filter((model) => pins.includes(model.id));
  const rest = pinned.length === 0 ? catalogue : catalogue.filter((model) => !pins.includes(model.id));

  return (
    <Field>
      <FieldLabel className="chrome-label text-ink-faint">Model (optional)</FieldLabel>
      <Select
        value={value === '' ? PROVIDER_DEFAULT : value}
        onValueChange={(next) => onChange(next === PROVIDER_DEFAULT ? '' : next)}
      >
        <SelectTrigger className="text-xs" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PROVIDER_DEFAULT} className="text-xs">
            Provider default
          </SelectItem>
          {value !== '' && !known ? (
            <SelectItem value={value} className="font-mono text-xs">
              {value} — not in the catalogue
            </SelectItem>
          ) : null}
          {pinned.length > 0 ? (
            <SelectGroup>
              <SelectLabel className="text-2xs text-ink-faint">Pinned</SelectLabel>
              {pinned.map((model) => (
                <SelectItem key={model.id} value={model.id} className="text-xs">
                  {model.displayName ?? model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {rest.length > 0 ? (
            <SelectGroup>
              {pinned.length > 0 ? (
                <SelectLabel className="text-2xs text-ink-faint">Catalogue</SelectLabel>
              ) : null}
              {rest.map((model) => (
                <SelectItem key={model.id} value={model.id} className="text-xs">
                  {model.displayName ?? model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
    </Field>
  );
}

function RoutineForm({
  routine,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly routine: RoutineSnapshot | null;
  readonly busy: boolean;
  readonly onSubmit: (draft: RoutineDraft) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const [name, setName] = useState(routine?.name ?? '');
  const [instructions, setInstructions] = useState(routine?.instructions ?? '');
  const [cwd, setCwd] = useState(routine?.cwd ?? '');
  const [profileId, setProfileId] = useState(routine?.profileId ?? profiles[0]?.id ?? '');
  const [model, setModel] = useState(routine?.model ?? '');
  const [schedule, setSchedule] = useState<ScheduleForm>(
    routine === null ? DEFAULT_SCHEDULE_FORM : toScheduleForm(routine.schedule),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const profile = profiles.find((entry) => entry.id === profileId);
    if (profile === undefined) {
      setError('Pick a profile — the account each firing bills.');
      return;
    }
    const built = toSchedule(schedule);
    const problem = scheduleProblem(built);
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (name.trim() === '' || instructions.trim() === '' || cwd.trim() === '') {
      setError('A routine needs a name, instructions, and a directory to run in.');
      return;
    }
    onSubmit({
      name: name.trim(),
      instructions,
      cwd: cwd.trim(),
      profileId: profile.id,
      providerId: profile.providerId as ProviderId,
      ...(model.trim() === '' ? {} : { model: model.trim() }),
      schedule: built,
    });
  };

  return (
    <Card className="rounded-lg border-hairline">
      <CardContent className="p-3">
        <form onSubmit={submit}>
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="routine-name" className="chrome-label text-ink-faint">
                Name
              </FieldLabel>
              <Input
                id="routine-name"
                value={name}
                placeholder="Morning triage"
                autoComplete="off"
                autoFocus={routine === null}
                onChange={(event) => setName(event.target.value)}
                className="text-xs md:text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="routine-instructions" className="chrome-label text-ink-faint">
                Instructions
              </FieldLabel>
              <Textarea
                id="routine-instructions"
                value={instructions}
                rows={4}
                placeholder="Read the overnight alerts, summarise anything on fire, and file the rest."
                onChange={(event) => setInstructions(event.target.value)}
                className="text-xs md:text-xs"
              />
              <FieldDescription className="text-2xs">
                The prompt each firing sends, word for word. Permission prompts follow your
                ordinary settings — a firing you are not there to approve behaves like any run
                you walked away from.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="routine-cwd" className="chrome-label text-ink-faint">
                Directory
              </FieldLabel>
              <Input
                id="routine-cwd"
                value={cwd}
                spellCheck={false}
                autoComplete="off"
                placeholder="/Users/you/code/project"
                onChange={(event) => setCwd(event.target.value)}
                className="font-mono text-xs md:text-xs"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel className="chrome-label text-ink-faint">Profile</FieldLabel>
                <Select value={profileId} onValueChange={setProfileId}>
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id} className="text-xs">
                        {profile.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <ModelField profileId={profileId} value={model} onChange={setModel} />
            </div>

            <Field>
              <FieldLabel className="chrome-label text-ink-faint">Schedule</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={schedule.kind}
                  onValueChange={(kind) =>
                    setSchedule({ ...schedule, kind: kind as ScheduleForm['kind'] })
                  }
                >
                  <SelectTrigger className="w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_KINDS.map((kind) => (
                      <SelectItem key={kind.id} value={kind.id} className="text-xs">
                        {kind.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {schedule.kind === 'weekly' ? (
                  <Select
                    value={schedule.day}
                    onValueChange={(day) => setSchedule({ ...schedule, day })}
                  >
                    <SelectTrigger className="w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((day) => (
                        <SelectItem key={day.id} value={day.id} className="text-xs">
                          {day.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                {schedule.kind === 'daily' ||
                schedule.kind === 'weekdays' ||
                schedule.kind === 'weekly' ? (
                  <Input
                    aria-label="Time of day"
                    value={schedule.at}
                    placeholder="09:00"
                    autoComplete="off"
                    onChange={(event) => setSchedule({ ...schedule, at: event.target.value })}
                    className="w-24 font-mono text-xs md:text-xs"
                  />
                ) : null}

                {schedule.kind === 'hourly' ? (
                  <Input
                    aria-label="Minute of the hour"
                    value={schedule.minute}
                    placeholder="0"
                    autoComplete="off"
                    onChange={(event) => setSchedule({ ...schedule, minute: event.target.value })}
                    className="w-16 font-mono text-xs md:text-xs"
                  />
                ) : null}

                {schedule.kind === 'cron' ? (
                  <Input
                    aria-label="Cron expression"
                    value={schedule.expression}
                    placeholder="0 9 * * 1-5"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setSchedule({ ...schedule, expression: event.target.value })
                    }
                    className="w-44 font-mono text-xs md:text-xs"
                  />
                ) : null}
              </div>
              <FieldDescription className="text-2xs">
                Local time, one-minute floor. {describeSchedule(toSchedule(schedule))}.
              </FieldDescription>
            </Field>

            {error !== null ? (
              <p className="text-2xs leading-relaxed text-amber">{error}</p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {routine === null ? 'Create routine' : 'Save changes'}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
