/**
 * The card that answers a `permission.request`.
 *
 * Three different things ride that one event, and each gets its own face:
 *
 *  - **An approval.** A tool wants to run. The card shows the provider's own
 *    sentence for it, the arguments (as a diff when they are an edit), and the
 *    choices: deny, allow once, and whatever standing rules the provider
 *    suggested — "allow always" is those suggestions echoed back verbatim.
 *  - **A question.** `AskUserQuestion`, decoded onto `request.question`. The
 *    card walks the questions one at a time; answering *is* allowing, and Esc
 *    is a skip — an allow with no answers, which is how the protocol spells it.
 *  - **A plan.** `ExitPlanMode`, decoded onto `request.plan`. The plan is shown
 *    as markdown and the two answers are "do that" and "think again"; there is
 *    no allow-for-session for a plan.
 *
 * Two rules from the desktop's card, carried over on purpose: **Esc denies**,
 * and **a bare Enter never authorises**. The list opens on the denying row, so
 * pressing Enter once too often does nothing worse than saying no.
 *
 * Option previews in a question are model-authored text and are shown as
 * text — never interpreted as markdown.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type {
  PermissionDecision,
  PermissionRequest,
  PermissionRuleUpdate,
  Question,
  QuestionAnswer,
} from '@rx-artemis/protocol';
import { detectFileEdit, formatJson, oneLine, summarizeToolInput } from '@rx-artemis/transcript';

import { renderDiff } from '../render/diff.js';
import { renderMarkdown } from '../render/markdown.js';
import { Picker, type PickerItem } from './Picker.js';

export const DEFAULT_DENIAL = 'The user declined this action.';

export interface PermissionCardProps {
  readonly request: PermissionRequest;
  readonly onDecision: (decision: PermissionDecision) => void;
  readonly isActive?: boolean;
}

export function PermissionCard(props: PermissionCardProps): React.JSX.Element {
  const { request } = props;
  if (request.plan !== undefined) return <PlanCard {...props} />;
  if (request.question !== undefined) return <QuestionCard {...props} />;
  return <ApprovalCard {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

function describeRules(update: PermissionRuleUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
      return `${update.behavior === 'allow' ? 'Allow always' : update.behavior === 'deny' ? 'Deny always' : 'Always ask'}: ${update.rules
        .map((rule) => (rule.ruleContent !== undefined ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName))
        .join(', ')}`;
    case 'removeRules':
      return `Remove rule: ${update.rules.map((rule) => rule.toolName).join(', ')}`;
    case 'setMode':
      return `Switch to ${update.mode} mode`;
    case 'addDirectories':
      return `Allow access to ${update.directories.join(', ')}`;
    case 'removeDirectories':
      return `Remove access to ${update.directories.join(', ')}`;
    default:
      return 'Apply the suggested rule';
  }
}

const scopeNote = (update: PermissionRuleUpdate): string =>
  update.scope === 'session' ? 'for this session' : update.scope === 'once' ? '' : `saved to ${update.scope} settings`;

function ApprovalCard({ request, onDecision, isActive = true }: PermissionCardProps): React.JSX.Element {
  const title = request.title ?? `${request.toolName} ${summarizeToolInput(request.input)}`.trim();
  const edit = detectFileEdit(request.toolName, request.input);
  const body = edit === null ? formatJson(request.input).split('\n').slice(0, 14) : renderDiff(edit, 30);
  const suggestions = request.suggestions ?? [];

  const items: PickerItem[] = [
    { key: 'deny', label: 'Deny', detail: 'tell the agent no and let it continue' },
    { key: 'allow', label: 'Allow once' },
    ...suggestions.map((update, index) => ({
      key: `suggest:${String(index)}`,
      label: describeRules(update),
      detail: scopeNote(update),
    })),
    { key: 'stop', label: 'Deny and stop the run', danger: true },
  ];

  const choose = (item: PickerItem): void => {
    if (item.key === 'deny') {
      onDecision({ behavior: 'deny', message: DEFAULT_DENIAL });
    } else if (item.key === 'stop') {
      onDecision({ behavior: 'deny', message: DEFAULT_DENIAL, interrupt: true });
    } else if (item.key === 'allow') {
      onDecision({ behavior: 'allow', scope: 'once' });
    } else {
      const index = Number(item.key.split(':')[1]);
      const update = suggestions[index];
      onDecision({
        behavior: 'allow',
        scope: 'session',
        ...(update === undefined ? {} : { updatedPermissions: [update] }),
      });
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text>
        <Text color="yellow" bold>
          ⚿ Permission{' '}
        </Text>
        <Text bold>{request.toolName}</Text>
      </Text>
      <Text>{oneLine(title, 200)}</Text>
      {request.description !== undefined && <Text dimColor>{request.description}</Text>}
      {request.reason !== undefined && <Text color="yellow">{request.reason}</Text>}
      {request.blockedPath !== undefined && <Text dimColor>path: {request.blockedPath}</Text>}
      <Box flexDirection="column" paddingLeft={2} marginY={1}>
        {body.map((line, i) => (
          <Text key={i} dimColor={edit === null}>
            {line}
          </Text>
        ))}
      </Box>
      <Picker
        title=""
        items={items}
        initialKey="deny"
        onSelect={choose}
        onCancel={() => onDecision({ behavior: 'deny', message: DEFAULT_DENIAL })}
        hint="↑↓ move · Enter choose · Esc denies"
        isActive={isActive}
      />
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

const MAX_PLAN_LINES = 80;

function PlanCard({ request, onDecision, isActive = true }: PermissionCardProps): React.JSX.Element {
  const plan = request.plan?.plan ?? '';
  const lines = renderMarkdown(plan).split('\n');
  const shown = lines.slice(0, MAX_PLAN_LINES);
  const items: PickerItem[] = [
    { key: 'again', label: 'Think again', detail: 'send it back to planning' },
    { key: 'go', label: 'Do that', detail: 'approve the plan and leave plan mode' },
  ];
  const suggestions = request.suggestions ?? [];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Text color="blue" bold>
        Plan
      </Text>
      {request.plan?.planPath !== undefined && <Text dimColor>{request.plan.planPath}</Text>}
      <Box flexDirection="column" marginY={1}>
        {shown.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        {lines.length > shown.length && (
          <Text dimColor>⋯ {String(lines.length - shown.length)} more lines in the plan file</Text>
        )}
      </Box>
      <Picker
        title=""
        items={items}
        initialKey="again"
        onSelect={(item) => {
          if (item.key === 'go') {
            onDecision({
              behavior: 'allow',
              ...(suggestions.length > 0 ? { updatedPermissions: suggestions } : {}),
            });
          } else {
            onDecision({ behavior: 'deny', message: 'Keep planning; the plan was not approved.' });
          }
        }}
        onCancel={() => onDecision({ behavior: 'deny', message: 'Keep planning; the plan was not approved.' })}
        hint="↑↓ move · Enter choose · Esc sends it back"
        isActive={isActive}
      />
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* Question                                                                   */
/* -------------------------------------------------------------------------- */

function QuestionCard({ request, onDecision, isActive = true }: PermissionCardProps): React.JSX.Element {
  const questions: readonly Question[] = request.question?.questions ?? [];
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [answers, setAnswers] = useState<readonly QuestionAnswer[]>([]);

  const question = questions[index];

  const finish = (all: readonly QuestionAnswer[]): void => {
    onDecision({ behavior: 'allow', answers: all });
  };

  useInput(
    (input, key) => {
      if (question === undefined) return;
      if (key.escape) {
        // A skip: allowing with no answers is how the protocol spells "the
        // user did not want to answer".
        onDecision({ behavior: 'allow', answers: [] });
        return;
      }
      const count = question.options.length;
      if (key.upArrow || input === 'k') {
        setCursor((c) => (c - 1 + count) % Math.max(1, count));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => (c + 1) % Math.max(1, count));
        return;
      }
      if (input === ' ' && question.multiSelect) {
        setPicked((current) => {
          const next = new Set(current);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
        return;
      }
      if (key.return) {
        const chosen = question.multiSelect
          ? [...picked].sort((a, b) => a - b).map((i) => question.options[i]?.label ?? '')
          : [question.options[cursor]?.label ?? ''];
        if (chosen.length === 0 || chosen[0] === '') return;
        const next: QuestionAnswer[] = [...answers, { question: question.question, options: chosen }];
        if (index + 1 >= questions.length) {
          finish(next);
          return;
        }
        setAnswers(next);
        setIndex(index + 1);
        setCursor(0);
        setPicked(new Set());
      }
    },
    { isActive },
  );

  if (question === undefined) {
    return (
      <Box borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
        <Text dimColor>The agent asked a question with nothing to choose from.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text>
        <Text color="magenta" bold>
          ? {question.header}
        </Text>
        {questions.length > 1 && <Text dimColor>{`  ${String(index + 1)}/${String(questions.length)}`}</Text>}
      </Text>
      <Text>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {question.options.map((option, i) => {
          const selected = i === cursor;
          const checked = picked.has(i);
          return (
            <Box key={option.label} flexDirection="column">
              <Text>
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
                {question.multiSelect && <Text>{checked ? '[x] ' : '[ ] '}</Text>}
                <Text bold={selected}>{option.label}</Text>
                <Text dimColor>{`  ${option.description}`}</Text>
              </Text>
              {selected && option.preview !== undefined && (
                <Text dimColor>
                  {'      '}
                  {oneLine(option.preview, 200)}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>
        {question.multiSelect ? '↑↓ move · Space toggle · Enter confirm · Esc skip' : '↑↓ move · Enter choose · Esc skip'}
      </Text>
    </Box>
  );
}
