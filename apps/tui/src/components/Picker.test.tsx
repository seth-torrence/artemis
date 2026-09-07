import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { Picker, pickerWindow, type PickerItem } from './Picker.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const items: readonly PickerItem[] = [
  { key: 'a', label: 'Alpha', detail: 'first' },
  { key: 'b', label: 'Beta', disabled: true, reason: 'not signed in' },
  { key: 'c', label: 'Gamma', danger: true },
];

describe('Picker', () => {
  it('lists every row, including disabled ones with their reason', async () => {
    const { lastFrame } = render(<Picker title="Pick" items={items} onSelect={() => undefined} onCancel={() => undefined} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pick');
    expect(frame).toContain('❯ Alpha');
    expect(frame).toContain('Beta');
    expect(frame).toContain('not signed in');
    expect(frame).toContain('Gamma');
  });

  it('opens on the initial key, moves with arrows, and will not select a disabled row', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker title="Pick" items={items} initialKey="c" onSelect={onSelect} onCancel={() => undefined} />,
    );
    await tick();
    expect(lastFrame()).toContain('❯ Gamma');
    stdin.write('[A'); // up → Beta (disabled)
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    stdin.write('[A'); // up → Alpha
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it('Esc cancels without selecting', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<Picker title="Pick" items={items} onSelect={onSelect} onCancel={onCancel} />);
    await tick();
    stdin.write('');
    await tick();
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/*
 * The scrolling window. A long list scrolls instead of growing: the folder
 * browser can offer a directory with hundreds of entries and the conversation
 * list grows without limit; either would otherwise push the picker's own
 * title off the top of the screen.
 */
describe('pickerWindow', () => {
  it('shows everything when everything fits', () => {
    expect(pickerWindow(0, 4, 12)).toEqual({ top: 0, size: 4 });
    expect(pickerWindow(3, 4, 12)).toEqual({ top: 0, size: 4 });
  });

  it('keeps the selection roughly centred once the list outgrows the window', () => {
    expect(pickerWindow(0, 100, 10)).toEqual({ top: 0, size: 10 });
    expect(pickerWindow(50, 100, 10)).toEqual({ top: 45, size: 10 });
    // And never scrolls past the end, so the last row stays reachable.
    expect(pickerWindow(99, 100, 10)).toEqual({ top: 90, size: 10 });
  });

  it('survives an empty list', () => {
    expect(pickerWindow(0, 0, 12)).toEqual({ top: 0, size: 1 });
  });
});
