/**
 * One list, one choice.
 *
 * Every switcher in the TUI — account, model, effort, permission mode, and the
 * "are you sure" that guards two of them — is this component with different
 * rows. Up/Down or j/k move, Enter picks, Esc leaves without picking. Rows can
 * be disabled with a reason, and a disabled row is still *shown*: the profile
 * screen's rule that an account you cannot use is greyed with its reason, not
 * hidden, because a row you cannot see cannot tell you what to fix.
 *
 * The initial selection is the caller's to set. For a destructive choice that
 * means the safe row, so that Enter pressed once too often does nothing worse
 * than nothing.
 *
 * A list longer than the window scrolls rather than growing: the folder
 * browser can offer a directory with hundreds of entries, and a list of
 * conversations grows without limit, either of which would otherwise push the
 * top of the picker — its title — off the screen. The selection is kept
 * roughly centred and what is out of sight is counted above and below, so the
 * list never silently ends.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/** Rows on screen at once before the list starts scrolling. */
const DEFAULT_MAX_ROWS = 12;

export interface PickerItem<K extends string = string> {
  readonly key: K;
  readonly label: string;
  /** Shown dimmed after the label. */
  readonly detail?: string;
  /** A second, dimmer line under the row. */
  readonly note?: string;
  readonly disabled?: boolean;
  /** Why it is disabled; replaces `detail` when set. */
  readonly reason?: string;
  /** Paint the label in the danger colour. */
  readonly danger?: boolean;
}

export interface PickerProps<K extends string = string> {
  readonly title: string;
  readonly items: readonly PickerItem<K>[];
  readonly initialKey?: K;
  readonly onSelect: (item: PickerItem<K>) => void;
  readonly onCancel: () => void;
  /** Shown under the list; defaults to the key legend. */
  readonly hint?: string;
  /** Rows visible at once; the rest scroll. */
  readonly maxRows?: number;
  readonly isActive?: boolean;
}

/**
 * The slice of a list to draw so that `index` is visible and, where the list
 * is long enough, roughly centred.
 *
 * Derived rather than remembered: a scroll offset held in state can disagree
 * with the selection — after the items change under it, which is exactly what
 * the folder browser does on every step into a directory.
 */
export function pickerWindow(index: number, count: number, maxRows: number): { readonly top: number; readonly size: number } {
  const size = Math.max(1, Math.min(maxRows, count));
  const top = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
  return { top, size };
}

export function Picker<K extends string = string>({
  title,
  items,
  initialKey,
  onSelect,
  onCancel,
  hint,
  maxRows = DEFAULT_MAX_ROWS,
  isActive = true,
}: PickerProps<K>): React.JSX.Element {
  const initial = Math.max(
    0,
    items.findIndex((item) => item.key === initialKey),
  );
  const [selected, setSelected] = useState(initial);
  /*
   * Clamped rather than trusted: a picker refreshed in place can be handed a
   * shorter list than the one its cursor was last on, and a cursor past the
   * end is a selection nobody can see and an Enter that does nothing.
   */
  const index = Math.max(0, Math.min(selected, items.length - 1));
  const { top, size } = pickerWindow(index, items.length, maxRows);
  const visible = items.slice(top, top + size);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || input === 'k') {
        setSelected(() => (index - 1 + items.length) % Math.max(1, items.length));
        return;
      }
      if (key.downArrow || input === 'j') {
        setSelected(() => (index + 1) % Math.max(1, items.length));
        return;
      }
      if (key.return) {
        const item = items[index];
        if (item !== undefined && item.disabled !== true) onSelect(item);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text bold>{title}</Text>
      {items.length === 0 && <Text dimColor>Nothing to choose from.</Text>}
      {top > 0 && <Text dimColor>{`  ↑ ${String(top)} more`}</Text>}
      {visible.map((item, offset) => {
        const i = top + offset;
        const selected = i === index;
        const marker = selected ? '❯' : ' ';
        const colour = item.danger === true ? 'red' : selected ? 'cyan' : undefined;
        return (
          <Box key={item.key} flexDirection="column">
            <Text>
              <Text color={selected ? 'cyan' : undefined}>{marker} </Text>
              <Text color={colour} dimColor={item.disabled === true} bold={selected}>
                {item.label}
              </Text>
              {item.disabled === true && item.reason !== undefined ? (
                <Text dimColor>{'  '}{item.reason}</Text>
              ) : item.detail !== undefined ? (
                <Text dimColor>{'  '}{item.detail}</Text>
              ) : null}
            </Text>
            {item.note !== undefined && <Text dimColor>{'    '}{item.note}</Text>}
          </Box>
        );
      })}
      {top + size < items.length && <Text dimColor>{`  ↓ ${String(items.length - top - size)} more`}</Text>}
      <Text dimColor>{hint ?? '↑↓ move · Enter choose · Esc back'}</Text>
    </Box>
  );
}
