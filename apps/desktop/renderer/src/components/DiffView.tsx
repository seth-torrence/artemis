/**
 * A file edit, rendered as a diff.
 *
 * The reason this exists rather than the generic argument dump: an `Edit` call
 * arrives as two long strings under `old_string` and `new_string`, and reading
 * a change out of that is work the interface should be doing. This is the one
 * tool result a user genuinely reviews, so it gets a real gutter, real line
 * numbers, and highlighting of the characters that actually moved.
 *
 * ## What "syntax-appropriate coloring" means here, and what it does not
 *
 * Colour is **diff-semantic**: added lines green, removed lines red, gutters and
 * line numbers tinted to match, unchanged lines muted so the change carries the
 * eye. On top of that, lines that pair up get **intra-line spans** marking the
 * exact characters that differ — which is what makes a one-token change in a
 * long line findable.
 *
 * There is deliberately **no per-language token highlighting**. It would need a
 * highlighter, and there is none in this app's dependency set; the renderer's
 * CSP (`script-src 'self'`) forbids pulling one at runtime, so adding it means
 * adding a bundled dependency, which is a decision to take openly rather than
 * smuggle into a diff component. For reviewing an agent's edit, knowing which
 * characters changed is worth more than knowing which of them are keywords.
 *
 * ## Cost
 *
 * All of the work happens in `lib/diff.ts`, which is bounded there. This file
 * only maps rows to elements, and the row list is capped, so a runaway edit
 * cannot turn into tens of thousands of DOM nodes inside a transcript that is
 * already streaming.
 */

import type { ReactElement, ReactNode } from 'react';
import { FilePlus2Icon, FilePenLineIcon } from 'lucide-react';

import type { DiffRow, FileEdit } from '@rx-artemis/transcript';
import { ToneBadge } from './primitives';
import { cn } from '@/lib/utils';

export function DiffView({ edit }: { readonly edit: FileEdit }): ReactElement {
  const Icon = edit.whole ? FilePlus2Icon : FilePenLineIcon;

  // Square, and it stays square — this is the first of the surfaces
  // `--radius-machine` is named for. 7D moves the fill and the seam onto the ink
  // (`--wash`, `--hairline`) and drops the separate fill the header strip used
  // to carry: a bar inside a card in a different colour from the card is a
  // second surface where there is only one thing.
  return (
    <div className="overflow-hidden rounded-none border border-hairline bg-wash">
      <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-1">
        <Icon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
        {/* `dir="rtl"` with LTR text: a path too long for the column keeps its
            tail — the filename — rather than its root, which is the half that
            identifies it. */}
        <span
          dir="rtl"
          className="min-w-0 flex-1 truncate text-left font-mono text-2xs text-ink-muted"
        >
          <bdi>{edit.path}</bdi>
        </span>
        {edit.extension ? <ToneBadge>{edit.extension}</ToneBadge> : null}
        {edit.whole ? (
          <ToneBadge tone="cyan">new content</ToneBadge>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs">
            <span className="text-mint">+{edit.added}</span>
            <span className="text-signal">−{edit.removed}</span>
          </span>
        )}
      </div>

      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse font-mono text-2xs leading-[1.45]">
          <tbody>
            {edit.rows.map((row, index) => (
              <Line key={index} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {edit.truncated ? (
        <p className="border-t border-hairline px-2.5 py-1 font-mono text-2xs text-amber">
          Diff clipped — this edit is larger than Artemis will render inline.
        </p>
      ) : null}
    </div>
  );
}

const ROW_STYLES: Record<DiffRow['kind'], string> = {
  add: 'bg-mint/8 text-mint',
  del: 'bg-signal/8 text-signal',
  ctx: 'text-ink-faint',
  gap: 'bg-wash-strong text-ink-faint',
};

const GUTTER_MARKS: Record<DiffRow['kind'], string> = {
  add: '+',
  del: '−',
  ctx: ' ',
  gap: '⋯',
};

function Line({ row }: { readonly row: DiffRow }): ReactElement {
  if (row.kind === 'gap') {
    return (
      <tr className={ROW_STYLES.gap}>
        <td colSpan={3} className="px-2 py-[1px] text-center text-2xs select-none">
          ⋯ {row.text} ⋯
        </td>
      </tr>
    );
  }

  return (
    <tr className={ROW_STYLES[row.kind]}>
      {/* Line numbers are `select-none` so copying a diff yields the code and
          not a column of integers glued to the front of every line. */}
      <td className="w-10 border-r border-hairline px-1.5 text-right align-top text-ink-faint/70 tabular-nums select-none">
        {row.oldNo ?? ''}
      </td>
      <td className="w-10 border-r border-hairline px-1.5 text-right align-top text-ink-faint/70 tabular-nums select-none">
        {row.newNo ?? ''}
      </td>
      <td className="w-full px-2 align-top break-words whitespace-pre-wrap">
        <span aria-hidden="true" className="mr-1.5 inline-block w-2 select-none">
          {GUTTER_MARKS[row.kind]}
        </span>
        <Spans text={row.text} spans={row.spans} kind={row.kind} />
      </td>
    </tr>
  );
}

/**
 * A line, with the changed characters picked out.
 *
 * Falls back to plain text when there are no spans, which is every context line
 * and every line whose counterpart shares nothing with it — where highlighting
 * the whole line would add nothing the row colour has not already said.
 */
function Spans({
  text,
  spans,
  kind,
}: {
  readonly text: string;
  readonly spans: DiffRow['spans'];
  readonly kind: DiffRow['kind'];
}): ReactElement {
  if (!spans || spans.length === 0) return <>{text || ' '}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  spans.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={i}
        className={cn(
          'rounded-[2px] bg-transparent px-px',
          kind === 'add' ? 'bg-mint/25 text-mint' : 'bg-signal/25 text-signal',
        )}
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
