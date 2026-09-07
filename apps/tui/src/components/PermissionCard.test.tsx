import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import type { PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';

import { PermissionCard } from './PermissionCard.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const base: PermissionRequest = {
  id: 'req' as never,
  runId: 'run' as never,
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Run rm -rf build',
  requestedAt: 0,
  suggestions: [
    { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], scope: 'session' },
  ],
};

describe('PermissionCard', () => {
  it('shows the provider sentence and opens on Deny, so a bare Enter never authorises', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Run rm -rf build');
    expect(lastFrame()).toContain('❯ Deny');
    expect(lastFrame()).toContain('Allow always: Bash(rm:*)');

    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'deny', message: expect.any(String) });
  });

  it('Esc denies', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const { stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    stdin.write('');
    await tick();
    expect(onDecision.mock.calls[0]?.[0]?.behavior).toBe('deny');
  });

  it('echoes the chosen suggestion back as a session-scoped rule update', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const { stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    stdin.write('[B'); // Allow once
    await tick();
    stdin.write('[B'); // Allow always
    await tick();
    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      scope: 'session',
      updatedPermissions: base.suggestions,
    });
  });

  it('renders a plan as a plan, with approval carrying the suggested mode change', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const request: PermissionRequest = {
      ...base,
      toolName: 'ExitPlanMode',
      input: {},
      plan: { plan: '# Steps\n\n- do the thing' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
    };
    const { lastFrame, stdin } = render(<PermissionCard request={request} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Plan');
    expect(lastFrame()).toContain('do the thing');
    expect(lastFrame()).toContain('❯ Think again');
    stdin.write('[B');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'allow', updatedPermissions: request.suggestions });
  });

  it('walks a question and answers by allowing; Esc skips with no answers', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const request: PermissionRequest = {
      ...base,
      toolName: 'AskUserQuestion',
      input: {},
      question: {
        questions: [
          {
            question: 'Which database?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'relational' },
              { label: 'SQLite', description: 'embedded', preview: '**not markdown**' },
            ],
          },
        ],
      },
    };
    const { lastFrame, stdin } = render(<PermissionCard request={request} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Which database?');
    stdin.write('[B');
    await tick();
    // The preview is model-authored and shown as plain text.
    expect(lastFrame()).toContain('**not markdown**');
    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      answers: [{ question: 'Which database?', options: ['SQLite'] }],
    });

    const skip = vi.fn<(d: PermissionDecision) => void>();
    const second = render(<PermissionCard request={request} onDecision={skip} />);
    await tick();
    second.stdin.write('');
    await tick();
    expect(skip).toHaveBeenCalledWith({ behavior: 'allow', answers: [] });
  });
});
