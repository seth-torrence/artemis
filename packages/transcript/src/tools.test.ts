import { describe, expect, it } from 'vitest';
import { classifyTool, describeActivity } from './tools.js';

describe('classifyTool', () => {
  it('knows Claude vocabulary', () => {
    expect(classifyTool('Bash')).toBe('command');
    expect(classifyTool('Read')).toBe('read');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('MultiEdit')).toBe('edit');
    expect(classifyTool('Grep')).toBe('search');
    expect(classifyTool('WebFetch')).toBe('web');
    expect(classifyTool('Task')).toBe('agent');
    expect(classifyTool('TodoWrite')).toBe('plan');
  });

  it('knows Codex vocabulary, which spells the same ideas differently', () => {
    expect(classifyTool('shell')).toBe('command');
    expect(classifyTool('apply_patch')).toBe('edit');
    expect(classifyTool('update_plan')).toBe('plan');
    expect(classifyTool('web_search')).toBe('web');
  });

  it('ignores case and separators, so one entry covers every house style', () => {
    expect(classifyTool('apply_patch')).toBe(classifyTool('ApplyPatch'));
    expect(classifyTool('apply-patch')).toBe(classifyTool('applypatch'));
  });

  it('counts every MCP tool as MCP, whatever the server called it', () => {
    // A server is free to expose a tool named `read`. It is still not this
    // app reading a file, and must not be counted as one.
    expect(classifyTool('mcp__filesystem__read')).toBe('mcp');
    expect(classifyTool('mcp__github__create_issue')).toBe('mcp');
  });

  it('falls back rather than guessing', () => {
    expect(classifyTool('SomethingNobodyHasWrittenYet')).toBe('other');
  });
});

describe('describeActivity', () => {
  it('builds the summary line in category order, capitalised once', () => {
    expect(describeActivity({ command: 36, read: 6, other: 1 })).toBe(
      'Ran 36 commands, read 6 files, used a tool',
    );
  });

  it('uses real singulars rather than "1 things"', () => {
    expect(describeActivity({ command: 1 })).toBe('Ran a command');
    expect(describeActivity({ agent: 1 })).toBe('Delegated to an agent');
    expect(describeActivity({ search: 1 })).toBe('Searched the code');
    expect(describeActivity({ mcp: 1 })).toBe('Called an MCP tool');
  });

  it('switches the whole line to present tense while work is in flight', () => {
    expect(describeActivity({ command: 2, read: 1 }, true)).toBe('Running 2 commands, reading a file');
  });

  it('says nothing about an empty group', () => {
    expect(describeActivity({})).toBe('');
  });
});
