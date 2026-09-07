/**
 * The bank prompt a host composes for its own machine. Real directories, as
 * in `registry.test.ts`: the question is what a registry on disk produces.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { joinSystemPromptAppends, machineBankPrompt } from '../prompt.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-host-bank-'));
}

describe('machineBankPrompt', () => {
  it('describes the banks the registry enables, from their own config', () => {
    const bank = scratch();
    mkdirSync(join(bank, 'projects', 'personal', 'homelab', 'memories'), { recursive: true });
    mkdirSync(join(bank, 'bin'));
    writeFileSync(join(bank, 'bin', 'cerebro'), '#!/usr/bin/env python3\n');
    writeFileSync(
      join(bank, 'cerebro.json'),
      JSON.stringify({ layout: 'projects', default_org: 'personal', instructions: 'AGENTS.md' }),
    );
    writeFileSync(join(bank, 'AGENTS.md'), 'Read INDEX.md first.');
    const registry = join(scratch(), 'config.json');
    writeFileSync(registry, JSON.stringify({ banks: [{ slug: 'cortex', path: bank }], default: 'cortex' }));

    const text = machineBankPrompt({ registryPath: registry, legacyRoot: join(scratch(), 'none') });
    expect(text).toContain('`cortex`');
    expect(text).toContain('--org <org> --project <project>');
    expect(text).toContain('Read INDEX.md first.');
    expect(text).toContain(join(bank, 'bin', 'cerebro'));
  });

  it('is undefined for a machine with no registry, no legacy clone, or only disabled banks', () => {
    const nowhere = join(scratch(), 'none');
    expect(machineBankPrompt({ registryPath: nowhere, legacyRoot: nowhere })).toBeUndefined();

    const bank = scratch();
    mkdirSync(join(bank, 'memories'));
    const registry = join(scratch(), 'config.json');
    writeFileSync(registry, JSON.stringify({ banks: [{ slug: 'off', path: bank, enabled: false }] }));
    expect(machineBankPrompt({ registryPath: registry, legacyRoot: nowhere })).toBeUndefined();
  });
});

describe('joinSystemPromptAppends', () => {
  it('joins what is there with a blank line, and answers undefined for nothing', () => {
    expect(joinSystemPromptAppends('Rules.', undefined, 'Bank.')).toBe('Rules.\n\nBank.');
    expect(joinSystemPromptAppends(undefined, '  ', '')).toBeUndefined();
    expect(joinSystemPromptAppends()).toBeUndefined();
  });
});
