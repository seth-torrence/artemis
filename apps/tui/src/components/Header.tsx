/**
 * The top of the screen: the mark, and where you are.
 *
 * Two lines of logo when the terminal is tall enough, one word when it is
 * not, the tagline beside it, and the working directory on the right. That is
 * all — which account is running, which model, which permission mode live
 * *under the conversation*, next to the composer that sends with them, where
 * the eye already is when it matters.
 *
 * Colours are the terminal's own: the mark in the theme's accent, the rest
 * dimmed.
 */

import { Box, Text } from 'ink';

import { ACCENT, LOGO_LINES, TAGLINE } from '../theme.js';
import { homedir } from 'node:os';

import { shortenPath } from '../directories.js';

export interface HeaderProps {
  readonly cwd: string;
  readonly columns: number;
  /** Two-line logo, or one word. */
  readonly tall: boolean;
}

export function Header({ cwd, columns, tall }: HeaderProps): React.JSX.Element {
  // The directory keeps its place; the tagline gives way first, then clips.
  const where = (
    <Box flexShrink={0} marginLeft={2}>
      <Text dimColor>{shortenPath(cwd, homedir())}</Text>
    </Box>
  );

  if (!tall || columns < 70) {
    return (
      <Box
        paddingX={1}
        justifyContent="space-between"
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderDimColor
      >
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate">
            <Text color={ACCENT} bold>
              ▲ ARTEMIS
            </Text>
            <Text dimColor>{'  '}{TAGLINE}</Text>
          </Text>
        </Box>
        {where}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      paddingX={1}
      justifyContent="space-between"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      <Box flexDirection="row" flexShrink={1} minWidth={0}>
        <Box flexDirection="column" marginRight={3} flexShrink={0}>
          {LOGO_LINES.map((line) => (
            <Text key={line} color={ACCENT} bold>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="flex-end" flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate">
            {TAGLINE}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" justifyContent="flex-end" flexShrink={0}>
        {where}
      </Box>
    </Box>
  );
}
