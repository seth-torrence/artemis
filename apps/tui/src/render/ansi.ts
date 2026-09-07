/**
 * The handful of SGR codes the TUI styles text with.
 *
 * Ink's `<Text>` props cover most styling, but two places produce *strings*
 * rather than elements — the markdown renderer and the diff renderer — and a
 * string can only carry style as escape codes. These are the codes, named, so
 * no other file spells the escape byte and the palette can change in one
 * place.
 *
 * Deliberately not a dependency: `chalk` is in the tree only as Ink's own
 * dependency, and under the isolated linker nothing here may import what it
 * did not declare. A dozen constants do not justify declaring one.
 */

const ESC = '\u001b';

export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
export const ITALIC = `${ESC}[3m`;
export const UNDERLINE = `${ESC}[4m`;
export const BOLD_OFF = `${ESC}[22m`;
export const ITALIC_OFF = `${ESC}[23m`;
export const UNDERLINE_OFF = `${ESC}[24m`;
export const RED = `${ESC}[31m`;
export const GREEN = `${ESC}[32m`;
export const YELLOW = `${ESC}[33m`;
export const CYAN = `${ESC}[36m`;
export const FG_OFF = `${ESC}[39m`;

export const bold = (s: string): string => `${BOLD}${s}${BOLD_OFF}`;
export const dim = (s: string): string => `${DIM}${s}${RESET}`;
export const italic = (s: string): string => `${ITALIC}${s}${ITALIC_OFF}`;
export const red = (s: string): string => `${RED}${s}${FG_OFF}`;
export const green = (s: string): string => `${GREEN}${s}${FG_OFF}`;
export const yellow = (s: string): string => `${YELLOW}${s}${FG_OFF}`;
export const cyan = (s: string): string => `${CYAN}${s}${FG_OFF}`;
