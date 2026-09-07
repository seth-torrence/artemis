/**
 * The words in the sidebar tooltips, decided away from the DOM.
 *
 * A session row's tooltip is a small dossier — title, directory, branch,
 * account, model, length, recency — and every one of those lines involves a
 * decision: which fields earn a row, what a missing profile is called, how
 * much of a prompt-derived title is still a title. Those decisions used to be
 * inlined in a template string inside `SessionList`, where nothing could test
 * them. Here they are data in, strings out; `SessionTooltip.tsx` only draws
 * the result.
 *
 * NOT DECIDED HERE: wrapping. Whether a value breaks mid-token is a property
 * of the box it is drawn in, so the helpers only *mark* the values with a
 * long-token tail (`mono`) and the component chooses the classes.
 */

import type { SessionSummary } from '@rx-artemis/protocol';

import { formatRelative, oneLine } from '@rx-artemis/transcript';

/**
 * One label/value line of the session tooltip.
 *
 * `label` doubles as the row's identity — the labels are unique, lowercase
 * single words in the run-info dialog's vocabulary, and the component keys on
 * them and picks out `profile` for its swatch.
 */
export interface SessionTooltipRow {
  readonly label: 'directory' | 'branch' | 'profile' | 'model' | 'messages' | 'activity';
  readonly value: string;
  /**
   * Monospaced, which in the tooltip also means "may be one enormous token":
   * paths, branch names and model ids have no spaces to wrap at, and the
   * component gives them `break-all` where prose gets `wrap-anywhere`.
   */
  readonly mono: boolean;
}

export interface SessionTooltipOptions {
  /** The owning profile's display name; absent when the profile is gone. */
  readonly profileLabel?: string | undefined;
  /** Injection point for the clock, so tests do not race `Date.now()`. */
  readonly now?: number;
}

/**
 * The tooltip's headline: the whole title, not `condenseTitle`'s eight words.
 *
 * Collapsed to one run of spaces because most "titles" are the opening prompt
 * verbatim, newlines included, and the tooltip is a card rather than a
 * transcript. Capped — generously — for the same reason: a pasted stack trace
 * as an opening prompt would otherwise become a tooltip taller than the
 * window. 280 characters is several lines at the tooltip's width, which is as
 * much title as anyone is hovering to read.
 */
const TITLE_MAX = 280;
export function sessionTooltipTitle(title: string): string {
  const flat = oneLine(title, TITLE_MAX);
  return flat.length === 0 ? 'Untitled session' : flat;
}

/**
 * Every fact the row cannot afford to show, one labelled line each.
 *
 * Present unconditionally: the directory (the reason this tooltip exists —
 * see #85), the profile (which account a resume would bill), and the last
 * activity. Present when the summary carries them: branch, model, message
 * count. Absent fields drop their row rather than rendering an em-dash —
 * a tooltip is a glance, not a form with required fields.
 *
 * The missing-profile wording is defensive: an orphaned row is disabled and
 * its tooltip is the `disabledReason` sentence instead (see `ReasonButton`),
 * so in practice this branch shows only if that gating ever changes — but a
 * helper that printed `undefined` the day it does would be a trap left armed.
 *
 * The unrecorded-profile wording is not defensive at all — it is the ordinary
 * state for any history that predates the ownership ledger on a machine using
 * the shared-config arrangement. The row itself shows no account there (see
 * `SessionSummary.profileIsUnknown`), which is honest but silent, and silence
 * on a row invites the reading that the field failed to load. The tooltip is
 * where there is room to say which of the two it is, and how many accounts the
 * conversation is reachable from.
 */
export function sessionTooltipRows(
  session: SessionSummary,
  options: SessionTooltipOptions = {},
): readonly SessionTooltipRow[] {
  const rows: SessionTooltipRow[] = [{ label: 'directory', value: session.cwd, mono: true }];

  if (session.gitBranch !== undefined && session.gitBranch.length > 0) {
    rows.push({ label: 'branch', value: session.gitBranch, mono: true });
  }

  rows.push({
    label: 'profile',
    value:
      session.profileIsUnknown === true
        ? unrecordedProfile(session)
        : (options.profileLabel ?? `${session.profileId} (no longer exists)`),
    mono: false,
  });

  if (session.model !== undefined && session.model.length > 0) {
    rows.push({ label: 'model', value: session.model, mono: true });
  }

  if (session.messageCount !== undefined) {
    rows.push({ label: 'messages', value: String(session.messageCount), mono: true });
  }

  rows.push({
    label: 'activity',
    value: formatRelative(session.updatedAt, options.now ?? Date.now()),
    mono: false,
  });

  return rows;
}

/**
 * What to say instead of an account, when no account is known.
 *
 * Two facts, because either alone misleads. "Not recorded" without the count
 * reads as data loss; the count without it reads as though the conversation
 * belongs to all of them, which is not what a shared store means — one account
 * ran it and the store simply did not write down which.
 *
 * Counted from the full sharer set, `[profileId, ...alsoInProfiles]`, and never
 * below two: the flag is only ever set on a store several profiles reach.
 */
function unrecordedProfile(session: SessionSummary): string {
  const sharers = 1 + (session.alsoInProfiles?.length ?? 0);
  return `not recorded — ${String(sharers)} accounts share this history`;
}

/** `22` → `22 sessions`, for the project heading's tooltip. */
export function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}
