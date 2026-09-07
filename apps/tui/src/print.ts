/**
 * `artemis --print "<prompt>"` — one turn, no screen.
 *
 * The scripting face of the same engine: start a run, write the assistant's
 * text to stdout as it streams, exit when the run ends with a code that says
 * how. Tool activity goes to stderr so a pipe sees only the answer.
 *
 * Nobody is watching, so a permission prompt is **denied**, with a message
 * that tells the model why — the same rule the headless server applies on its
 * completions surface. Pre-authorise what unattended work needs through the
 * profile's own settings, or pass `--mode` explicitly; do not expect this path
 * to guess.
 *
 * Also the first thing that ran against a real provider while the UI was still
 * being built, and worth keeping for exactly that: it proves the engine seam
 * with nothing between it and the terminal.
 */

import type { SessionId } from '@rx-artemis/protocol';
import { syncScheduler } from '@rx-artemis/transcript';

import { Conversation } from './conversation.js';
import type { Launched } from './launch.js';

const NOBODY_HOME =
  'This run was started with `artemis --print`, which has nobody to ask. Run interactively, or start with a permission mode that already allows this.';

export interface PrintIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Resolves to the process exit code. */
export async function runPrint(launched: Launched, prompt: string, io: PrintIo): Promise<number> {
  const { host, settings } = launched;
  const conversation = new Conversation({
    driver: host.runs,
    settings,
    capabilitiesFor: (id) => host.capabilitiesFor(id),
    scheduler: syncScheduler,
  });

  const streamed = new Set<string>();
  let ended = false;
  let resolveEnd: (code: number) => void = () => undefined;
  const end = new Promise<number>((resolve) => {
    resolveEnd = resolve;
  });

  conversation.subscribeEvents((event) => {
    switch (event.type) {
      case 'text.delta':
        if (event.agentId === undefined) {
          streamed.add(event.messageId);
          io.stdout(event.text);
        }
        break;
      case 'text.complete':
        // A non-streaming provider sends only this; a streaming one already
        // wrote every fragment and must not be echoed twice.
        if (event.role === 'assistant' && event.agentId === undefined && !streamed.has(event.messageId)) {
          io.stdout(event.text);
        }
        break;
      case 'tool.start':
        io.stderr(`  ⚙ ${event.title ?? event.name}\n`);
        break;
      case 'permission.request':
        void conversation.respondToPermission(event.requestId, { behavior: 'deny', message: NOBODY_HOME });
        io.stderr(`  ⊘ denied: ${event.request.toolName} (nobody to ask)\n`);
        break;
      case 'run.end': {
        ended = true;
        io.stdout('\n');
        if (event.reason !== 'completed') {
          io.stderr(`run ended: ${event.reason.replace(/_/g, ' ')}${event.error !== undefined ? ` — ${event.error.message}` : ''}\n`);
        }
        resolveEnd(event.reason === 'completed' ? 0 : 1);
        break;
      }
      default:
        break;
    }
  });

  // `-c` / `--resume`: continue a stored conversation rather than open a new
  // one. Only the id is needed; nothing here draws the history.
  if (launched.resume !== undefined) {
    const sessionId =
      launched.resume === 'latest'
        ? (await host.listSessions(settings.profileId, settings.providerId, settings.cwd, 1))[0]?.id
        : (launched.resume as SessionId);
    if (sessionId === undefined) {
      io.stderr('No stored conversation to continue in this directory.\n');
      conversation.dispose();
      return 1;
    }
    conversation.loadHistory(sessionId, []);
  }

  const outcome = await conversation.send(prompt);
  if (!outcome.ok) {
    io.stderr(`${outcome.reason}\n`);
    conversation.dispose();
    return 1;
  }
  if (ended) {
    conversation.dispose();
    return end;
  }
  const code = await end;
  conversation.dispose();
  return code;
}
