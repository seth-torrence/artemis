/**
 * The terminal's palette, in one place — and only the terminal's.
 *
 * Nothing here names a colour by value. The desktop derives every colour from
 * a `{canvas, accent}` seed pair (ADR 0001); a terminal already has a theme
 * the person chose, and the right thing is to use it. So the accent is the
 * theme's own magenta — the slot closest to the desktop's blue-violet — and
 * everything else is the default foreground, dimmed where it is furniture,
 * bold where it is the thing to read. Red and yellow keep their meanings,
 * danger and caution, which every theme preserves.
 *
 * A named ANSI colour is the whole point: it is the one kind of colour a
 * terminal theme can restyle.
 */

export const ACCENT = 'magenta';

/** Two lines, half-block glyphs. Shown when there is room; a word otherwise. */
export const LOGO_LINES: readonly string[] = [
  '▄▀█ █▀█ ▀█▀ █▀▀ █▀▄▀█ █ █▀',
  '█▀█ █▀▄  █  ██▄ █ ▀ █ █ ▄█',
];

export const TAGLINE = 'agents, accounts and permissions — in the terminal';

/** Braille spinner, one frame per tick. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_MS = 80;
