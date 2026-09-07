/**
 * The Scheduled strip — the sidebar's record that the app has appointments.
 *
 * A fixed, compact band above the session list rather than a section inside
 * it, on purpose. The list's rows are *conversations*, grouped by project and
 * virtualised by the thousand; routines are a handful of standing orders, and
 * threading them through `sessionGroups`' row model would put schedule state
 * into a pipeline built for transcripts — including the rule that files
 * scheduled-spawned sessions under Archived, which is about Claude's own
 * firings and must stay that way. The firings themselves *do* appear in the
 * list, as the ordinary conversations they are.
 *
 * Absent entirely when nothing is scheduled: a permanent empty "Scheduled"
 * heading would be chrome advertising a feature, and the sidebar is a record
 * of work, not a tour.
 */

import type { ReactElement } from 'react';
import { CalendarClockIcon } from 'lucide-react';

import { describeSchedule } from '@rx-artemis/protocol';

import { useRoutines } from '@/hooks/useRoutines';
import { formatUntil } from '@rx-artemis/transcript';
import { openSettings } from '../state/store';
import { cn } from '@/lib/utils';

/** Rows shown before the strip defers to the pane. The sidebar is not a list. */
const MAX_ROWS = 4;

export function ScheduledStrip(): ReactElement | null {
  const { state } = useRoutines();
  if (state.routines.length === 0) return null;

  const shown = state.routines.slice(0, MAX_ROWS);
  const hidden = state.routines.length - shown.length;

  return (
    <div className="shrink-0 border-b border-hairline px-2 pb-2">
      <div className="flex h-6 items-center px-1">
        <span className="chrome-label text-ink-faint">Scheduled</span>
      </div>
      <div className="flex flex-col">
        {shown.map((routine) => (
          <button
            key={routine.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-wash"
            // The pane is where a routine is acted on; the strip only reports.
            onClick={() => openSettings('routines')}
          >
            <CalendarClockIcon
              aria-hidden="true"
              className={cn(
                'size-3 shrink-0',
                routine.running ? 'text-beam-text' : routine.paused ? 'text-ink-faint' : 'text-ink-muted',
              )}
            />
            <span className="min-w-0 flex-1 truncate text-2xs text-ink">{routine.name}</span>
            <span className="shrink-0 text-2xs text-ink-faint">
              {routine.running
                ? 'running'
                : routine.paused
                  ? 'paused'
                  : routine.nextFireAt === undefined
                    ? describeSchedule(routine.schedule)
                    : formatUntil(routine.nextFireAt)}
            </span>
          </button>
        ))}
        {hidden > 0 ? (
          <button
            type="button"
            className="rounded-md px-1.5 py-1 text-left text-2xs text-ink-faint hover:bg-wash"
            onClick={() => openSettings('routines')}
          >
            and {hidden} more…
          </button>
        ) : null}
      </div>
    </div>
  );
}
