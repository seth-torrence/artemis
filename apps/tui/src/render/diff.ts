/**
 * A file edit, drawn as lines.
 *
 * `detectFileEdit` in `@rx-artemis/transcript` has already done the work — it
 * recognised the edit by its argument shape, diffed it, collapsed the unchanged
 * middle into gaps and capped the cost. This turns those rows into strings a
 * terminal can show: `+` in green, `-` in red, context dimmed, a gap as an
 * ellipsis with how many lines it hides. Line numbers are omitted; on a narrow
 * screen they cost more than they tell.
 *
 * Capped a second time here, tighter, because a transcript is a stream and one
 * five-hundred-line rewrite should not push the conversation off the top of
 * the screen. The cap says how much it left out.
 */

import type { FileEdit } from '@rx-artemis/transcript';

import { DIM, FG_OFF, GREEN, RED, RESET } from './ansi.js';

export const MAX_DIFF_LINES = 40;

export function renderDiff(edit: FileEdit, maxLines = MAX_DIFF_LINES): readonly string[] {
  const out: string[] = [];
  const header = `${DIM}${edit.path}${RESET}  ${GREEN}+${String(edit.added)}${FG_OFF} ${RED}-${String(edit.removed)}${FG_OFF}`;
  out.push(header);

  let shown = 0;
  for (const row of edit.rows) {
    if (shown >= maxLines) {
      const remaining = edit.rows.length - shown;
      out.push(`${DIM}  ⋯ ${String(remaining)} more line${remaining === 1 ? '' : 's'}${RESET}`);
      return out;
    }
    switch (row.kind) {
      case 'add':
        out.push(`${GREEN}+ ${row.text}${FG_OFF}`);
        break;
      case 'del':
        out.push(`${RED}- ${row.text}${FG_OFF}`);
        break;
      case 'ctx':
        out.push(`${DIM}  ${row.text}${RESET}`);
        break;
      case 'gap':
        out.push(`${DIM}  ⋯${row.skipped === undefined ? '' : ` ${String(row.skipped)} unchanged`}${RESET}`);
        break;
      default:
        break;
    }
    shown += 1;
  }
  if (edit.truncated) out.push(`${DIM}  ⋯ diff truncated${RESET}`);
  return out;
}
