#!/usr/bin/env node
/**
 * `artemis` — Artemis in the terminal.
 *
 * The third front end over the same engine as the desktop app and the
 * headless server. This file is the entry and nothing more: it reads the
 * flags, resolves where Artemis's data lives, runs `launch()`, and then either
 * hands the terminal to Ink or — for `--print` — streams one turn and exits.
 *
 *   artemis                          open a conversation in this directory
 *   artemis --profile work           …as a particular account
 *   artemis --model fable --mode plan
 *   artemis -p "what does this repo do?"   one turn, answer on stdout
 *
 * Nothing here talks to a provider. That is `host.ts`, composed the way
 * `apps/server/src/host.ts` composes it, driven by `conversation.ts`, and drawn
 * by `app.tsx`.
 */


import { render } from 'ink';

import { App } from './app.js';
import { artemisDataDir } from './dataDir.js';
import { launch } from './launch.js';
import { currentVersion, installRoot, runUpdate } from './update.js';
import { runPrint } from './print.js';

interface Args {
  readonly print?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly resume?: string;
  readonly help: boolean;
  readonly version: boolean;
  readonly update: boolean;
}

const USAGE = `Usage: artemis [options]

  --profile <label>   the account to open on (default: the first usable one)
  --model <id>        the model, as the provider names it
  --mode <mode>       permission mode to start in (default, acceptEdits, plan, …)
  --cwd <path>        work in this directory instead of the current one
  -c, --continue      pick up the newest conversation in this directory
  -r, --resume <id>   pick up a particular stored conversation
  -p, --print <text>  send one message, write the answer to stdout, exit
  --update            replace an installed copy with the latest release
  -v, --version
  -h, --help

Data directory: ${artemisDataDir()}  (set ARTEMIS_DATA_DIR to move it)
`;

function parseArgs(argv: readonly string[]): Args | string {
  const out: { -readonly [K in keyof Args]: Args[K] } = { help: false, version: false, update: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '--update':
        out.update = true;
        break;
      case '--profile':
        out.profile = next();
        break;
      case '--model':
        out.model = next();
        break;
      case '--mode':
        out.mode = next();
        break;
      case '--cwd':
        out.cwd = next();
        break;
      case '-c':
      case '--continue':
        out.resume = 'latest';
        break;
      case '-r':
      case '--resume':
        out.resume = next() ?? 'latest';
        break;
      case '-p':
      case '--print':
        out.print = next() ?? '';
        break;
      default:
        if (arg.startsWith('-')) return `Unknown option ${arg}\n\n${USAGE}`;
        rest.push(arg);
    }
  }
  // `artemis -p what does this do` — words after the prompt join it.
  if (out.print !== undefined && rest.length > 0) out.print = [out.print, ...rest].join(' ').trim();
  else if (rest.length > 0) return `Unexpected argument "${rest[0] ?? ''}"\n\n${USAGE}`;
  return out;
}


async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    process.stderr.write(parsed);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`artemis ${currentVersion()}\n`);
    return 0;
  }
  if (parsed.update) {
    const root = installRoot();
    if (root === undefined) {
      process.stderr.write('This copy runs from a source checkout; update it with git pull, then pnpm tui.\n');
      return 1;
    }
    return runUpdate(root);
  }

  const result = await launch({
    dataDir: artemisDataDir(),
    cwd: parsed.cwd ?? process.cwd(),
    ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
    ...(parsed.resume === undefined ? {} : { resume: parsed.resume }),
  });
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  const { launched } = result;

  try {
    if (parsed.print !== undefined) {
      if (parsed.print.trim().length === 0) {
        process.stderr.write('--print needs a message.\n');
        return 2;
      }
      return await runPrint(launched, parsed.print, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      });
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('artemis needs a terminal. For scripts, use: artemis --print "<message>"\n');
      return 2;
    }

    // The whole terminal, on the alternate screen: what was on it before is
    // restored on exit, and the app draws to the size it is given.
    const instance = render(<App launched={launched} />, { exitOnCtrlC: false, alternateScreen: true });
    await instance.waitUntilExit();
    return 0;
  } finally {
    await launched.cache.flush();
    await launched.preferences.flush();
    await launched.host.dispose();
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
