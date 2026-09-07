/**
 * The line you type into.
 *
 * A single-line editor with a cursor, built on `useInput` rather than a text
 * input package so that the keys the TUI cares about — Esc to interrupt, `/`
 * to hint commands, Enter to send — are decided in one place. Pasted text
 * arrives as one chunk and is kept whole, newlines included; the composer does
 * not try to be a multi-line editor.
 *
 * It owns no state of the conversation. It reports a submission and shows what
 * it is told: whether the agent is working (so Enter means "steer" rather than
 * "start"), whether the provider can even take a message right now, and any
 * one-line reason the last submission was refused.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { completeCommand, completeProviderCommand } from '../commands.js';
import { ACCENT } from '../theme.js';

export interface ComposerProps {
  readonly onSubmit: (text: string) => void;
  /** The agent is mid-turn. Enter steers; the hint says so. */
  readonly live: boolean;
  /** The provider cannot take a message until the turn ends. */
  readonly locked: boolean;
  /** Why the last submission was refused, if it was. */
  readonly notice?: string;
  /** Names of files queued to go with the next message. */
  readonly attachments?: readonly string[];
  /** The provider's own slash commands, offered beside the TUI's. */
  readonly providerCommands?: readonly string[];
  readonly isActive?: boolean;
}

export function Composer({
  onSubmit,
  live,
  locked,
  notice,
  attachments = [],
  providerCommands = [],
  isActive = true,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  const typed = value.startsWith('/') && !value.includes(' ') ? value.slice(1).toLowerCase() : null;
  const completions =
    typed === null
      ? []
      : [
          ...completeCommand(value),
          ...completeProviderCommand(value, providerCommands).map((name) => ({
            name,
            usage: `/${name}`,
            // The plugin's name is already the front half of the row; saying
            // it again in the description column is noise. What the column is
            // for is the distinction the name does not carry — whether this
            // came from the user's own skills or from the provider itself.
            summary: name.includes(':') ? 'skill' : 'provider command',
          })),
        ].slice(0, 10);

  useInput(
    (input, key) => {
      if (key.return) {
        if (value.trim().length === 0 && attachments.length === 0) return;
        onSubmit(value);
        setValue('');
        setCursor(0);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((current) => current.slice(0, cursor - 1) + current.slice(cursor));
        setCursor((current) => current - 1);
        return;
      }
      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(value.length, current + 1));
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        setValue('');
        setCursor(0);
        return;
      }
      if (key.tab && completions.length > 0) {
        // Complete to the first match — the canonical name, prefix and all,
        // which is what makes a bridged `/plugin:command` typeable.
        const first = completions[0];
        if (first !== undefined) {
          const completed = `${first.usage.split(' ')[0] ?? first.usage} `;
          setValue(completed);
          setCursor(completed.length);
        }
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (input.length === 0) return;
      // More than one character at once is a paste, and Ink hands it over
      // whole. Line endings are normalised and a single trailing newline —
      // the one a terminal adds when you copy a whole line — is dropped
      // rather than inserted, because it would otherwise sit invisibly at the
      // end of the message; a paste never submits by itself.
      const text = input.length > 1 ? input.replace(/\r\n?/g, '\n').replace(/\n$/, '') : input;
      if (text.length === 0) return;
      setValue((current) => current.slice(0, cursor) + text + current.slice(cursor));
      setCursor((current) => current + text.length);
    },
    { isActive },
  );

  // Wide enough for the longest row on offer, so the descriptions line up:
  // a bridged `/marketplace:command` is far longer than `/help`, and a fixed
  // column put the two halves of those rows flush against each other.
  const nameColumn = completions.reduce((widest, command) => Math.max(widest, command.usage.length), 0) + 1;

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || ' ';
  const after = value.slice(cursor + 1);
  const placeholder = locked ? 'working — wait for this turn' : live ? 'steer the agent…' : 'message, or / for commands';

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={isActive ? ACCENT : undefined} borderDimColor={!isActive} paddingX={1}>
        <Text color={locked ? undefined : ACCENT} dimColor={locked} bold>
          {'❯ '}
        </Text>
        {value.length === 0 ? (
          <Text>
            {isActive ? <Text inverse> </Text> : ' '}
            <Text dimColor>{placeholder}</Text>
          </Text>
        ) : (
          <Text wrap="wrap">
            {before}
            {isActive ? <Text inverse>{at}</Text> : at}
            {after}
          </Text>
        )}
      </Box>
      {completions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {completions.map((command) => (
            <Text key={command.usage} dimColor>
              {command.usage.padEnd(nameColumn)} {command.summary}
            </Text>
          ))}
        </Box>
      )}
      {attachments.length > 0 && (
        <Text dimColor>
          {'  ⎘ '}
          {attachments.join(', ')} · goes with the next message · /attach clear
        </Text>
      )}
      {notice !== undefined && (
        <Text color="yellow">
          {'  '}
          {notice}
        </Text>
      )}
    </Box>
  );
}
