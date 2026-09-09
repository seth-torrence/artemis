/**
 * The chip an agent offers follow-up work with.
 *
 * A suggested task is a tool call — see `@rx-artemis/protocol`'s
 * `suggestedTasks` — so this row is drawn from the transcript like any other
 * and comes back on reload without anything having stored it. What it draws is
 * an *offer*: a title, the sentence behind it, and one control that says both
 * "do this" and "and here".
 *
 * ## Why a split button rather than four buttons or one
 *
 * Four buttons would make every suggestion a paragraph of chrome under an
 * answer, and would put the rarest choice at the same weight as the commonest.
 * One button would hide the choice that matters most — a task started in the
 * wrong place costs more than one not started at all, because it lands in a
 * conversation or a checkout the user did not mean to disturb.
 *
 * So: a primary button carrying the target the user last chose, and a caret
 * onto all four with that one ticked. The habit is visible, one click from
 * being changed, and never silently applied to a target that cannot work here
 * — an unavailable option is shown disabled with the reason, and the primary
 * button falls back to the first one that *is* available rather than presenting
 * a click that fails.
 *
 * ## Why an unusable option is still in the menu
 *
 * The house rule from `disabled-reason.tsx`: "Start with worktree — this
 * directory is not in a git repository" teaches something. A menu that is
 * quietly one row shorter teaches nothing, and leaves the reader wondering
 * whether the feature exists.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ChevronDownIcon, CheckIcon, ListTodoIcon, XIcon } from 'lucide-react';
import {
  isProfileEnabled,
  parseSuggestedTask,
  SUGGESTED_TASK_TARGETS,
  suggestedTaskBranch,
  type SuggestedTask as Task,
  type SuggestedTaskTarget,
} from '@rx-artemis/protocol';
import type { ToolItem } from '@rx-artemis/transcript';

import { usePane, usePaneRef } from '../state/paneContext';
import {
  dismissSuggestedTask,
  startSuggestedTask,
  suggestedTaskDismissed,
  suggestedTaskTargetStatus,
  useApp,
} from '../state/store';
import { IconButton, ReasonButton } from './disabled-reason';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * What each target's control reads.
 *
 * Claude Code's desktop app names three of these — "Fix in this session",
 * "Start locally", "Start with worktree" — and Artemis keeps those words where
 * they mean the same thing, because a person who has used both should not have
 * to relearn a menu. The fourth diverges on purpose: Claude Code says "Send to
 * cloud" of a service Artemis does not have, and Artemis's other machine is an
 * Artemis Server the user set up themselves.
 */
const TARGET_LABELS: Readonly<Record<SuggestedTaskTarget, string>> = {
  here: 'Fix in this session',
  session: 'Start locally',
  worktree: 'Start with worktree',
  server: 'Send to a server',
};

/** The line under each menu row, saying what it costs the conversation on screen. */
const TARGET_DETAILS: Readonly<Record<SuggestedTaskTarget, string>> = {
  here: 'Sends the task as the next message in this conversation.',
  session: 'Opens a new conversation beside this one, in the same directory.',
  worktree: 'Splits a git worktree on a new branch, and works there.',
  server: 'Opens it on an Artemis Server, prefilled for you to review and send.',
};

/**
 * One offered task.
 *
 * Renders nothing when the call's arguments are not a task — a model that
 * called the tool with a missing prompt made a mistake, and the honest place
 * for it is the ordinary tool card the caller falls back to, not a chip with a
 * blank label. Same for a suggestion this column has put away.
 */
export function SuggestedTaskCard({ item }: { readonly item: ToolItem }): ReactElement | null {
  const pane = usePaneRef();
  const dismissed = usePane((s) => suggestedTaskDismissed(s, item.id));
  // Recomputed only when the arguments change, which for a tool call is once:
  // `tool.end` carries the result, never a new input.
  const task = useMemo(() => parseSuggestedTask(item.input), [item.input]);

  if (task === null || dismissed) return null;
  return <Card callId={item.id} task={task} onDismiss={() => dismissSuggestedTask(item.id, pane)} />;
}

function Card({
  callId,
  task,
  onDismiss,
}: {
  readonly callId: string;
  readonly task: Task;
  readonly onDismiss: () => void;
}): ReactElement {
  const pane = usePaneRef();
  const preferred = useApp((s) => s.suggestedTaskTarget);
  /*
   * Subscribed one value at a time, and memoised on the three of them, because
   * a selector returning the four statuses as an array would hand the store a
   * fresh identity on every unrelated write and re-render every chip in the
   * column on every token. `workspace` is replaced only when the directory is
   * re-described, and the server question reduces to a boolean here so that
   * adding an unrelated profile does not count as a change.
   */
  const cwd = usePane((s) => s.cwd);
  const workspace = usePane((s) => s.workspace);
  const hasServer = useApp((s) =>
    s.profiles.some((profile) => profile.providerId === 'artemis' && isProfileEnabled(profile)),
  );
  const statuses = useMemo(
    () =>
      SUGGESTED_TASK_TARGETS.map(
        (target) =>
          [target, suggestedTaskTargetStatus({ cwd, workspace, hasServer }, target)] as const,
      ),
    [cwd, workspace, hasServer],
  );

  /*
   * The primary is the remembered habit — unless it cannot be honoured here, in
   * which case it is the first target that can. Falling back rather than
   * presenting a disabled primary, because the primary button is the one
   * control the user is expected to press without reading: a click that
   * explains why it did nothing is a worse answer than a click that starts the
   * work somewhere sensible, and the menu is right there to say where.
   */
  const primary =
    statuses.find(([target, status]) => target === preferred && status.available)?.[0] ??
    statuses.find(([, status]) => status.available)?.[0] ??
    'here';

  // Guards a double-click while a worktree is being made, which is the one
  // target with a round trip in front of it.
  const [starting, setStarting] = useState(false);
  const start = (target: SuggestedTaskTarget): void => {
    if (starting) return;
    setStarting(true);
    void startSuggestedTask(callId, task, target, pane).finally(() => {
      setStarting(false);
    });
  };

  return (
    <div
      data-testid="suggested-task"
      className="flex w-full items-start gap-2.5 rounded-lg border border-hairline bg-panel/60 px-3 py-2"
    >
      <ListTodoIcon className="mt-[3px] size-3.5 shrink-0 text-ink-faint" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <p className="text-2xs font-medium text-ink">{task.title}</p>
        {task.tldr.length > 0 ? (
          <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">{task.tldr}</p>
        ) : null}

        <div className="mt-1.5 flex items-center gap-1">
          {/*
            The split button. The two halves are one control to the eye — square
            inner corners, one border — and two to the keyboard, which is what
            lets the primary be pressed without opening anything.
          */}
          <ReasonButton
            size="xs"
            variant="outline"
            disabled={starting}
            className="h-[22px] rounded-r-none border-hairline-strong px-2 text-2xs font-normal"
            tooltip={TARGET_DETAILS[primary]}
            onClick={() => {
              start(primary);
            }}
          >
            {TARGET_LABELS[primary]}
          </ReasonButton>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ReasonButton
                size="xs"
                variant="outline"
                disabled={starting}
                aria-label="Choose where to start this task"
                className="-ml-px h-[22px] rounded-l-none border-hairline-strong px-1 text-2xs"
              >
                <ChevronDownIcon className="size-3" aria-hidden="true" />
              </ReasonButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              {statuses.map(([target, status]) => (
                <DropdownMenuItem
                  key={target}
                  disabled={!status.available}
                  title={status.available ? TARGET_DETAILS[target] : status.reason}
                  onSelect={() => {
                    start(target);
                  }}
                  className="items-start gap-2"
                >
                  <CheckIcon
                    className={cn('mt-[3px] size-3 shrink-0', target !== primary && 'opacity-0')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block">{TARGET_LABELS[target]}</span>
                    <span className="block text-2xs text-ink-faint">
                      {status.available ? detailFor(target, task) : status.reason}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <IconButton
        label="Dismiss this suggestion"
        className="-mr-1 -mt-0.5 shrink-0 text-ink-faint"
        onClick={onDismiss}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/**
 * The line under an available menu row.
 *
 * The worktree row names the branch it would create rather than describing the
 * mechanism, because that is the fact the user is actually deciding on — a
 * branch is a thing they will have to find, merge and delete later, and being
 * shown its name before agreeing to it is the difference between choosing one
 * and discovering one.
 */
function detailFor(target: SuggestedTaskTarget, task: Task): string {
  if (target !== 'worktree') return TARGET_DETAILS[target];
  return `New branch ${suggestedTaskBranch(task.title)}, in a worktree of its own.`;
}
