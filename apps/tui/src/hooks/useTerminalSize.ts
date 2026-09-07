/**
 * The terminal's size, as state.
 *
 * A full-screen layout is sized from the terminal rather than flowing, so the
 * root needs the numbers and needs to re-render when they change. Ink already
 * re-lays out on `resize`; this makes the same event visible to components
 * that compute heights from it — the viewport, the sidebar's row budget.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const FALLBACK: TerminalSize = { columns: 100, rows: 30 };

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    columns: stdout.columns > 0 ? stdout.columns : FALLBACK.columns,
    rows: stdout.rows > 0 ? stdout.rows : FALLBACK.rows,
  });
  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    const onResize = (): void => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
