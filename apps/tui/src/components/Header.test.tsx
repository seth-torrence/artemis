/**
 * The top line says where you are — as a person would write it.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { Header } from './Header.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('Header', () => {
  it('shortens a directory under home to ~', async () => {
    const { lastFrame } = render(<Header cwd={join(homedir(), 'code', 'artemis')} columns={120} tall={false} />);
    await tick();
    expect(lastFrame()).toContain(join('~', 'code', 'artemis'));
  });

  it('leaves a directory that merely starts with the letters of home alone', async () => {
    // `/home/adamant` begins with `/home/ada`, and was drawn as `~mant`: a
    // real directory renamed on screen to one that does not exist.
    const sibling = `${homedir()}mant`;
    const { lastFrame } = render(<Header cwd={sibling} columns={120} tall={false} />);
    await tick();
    expect(lastFrame()).toContain(sibling);
    expect(lastFrame()).not.toContain('~mant');
  });
});
