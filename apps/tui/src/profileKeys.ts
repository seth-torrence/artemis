/**
 * The desktop's encrypted endpoint keys, seen from a process that cannot
 * decrypt them.
 *
 * `apps/desktop/main/profileSecrets.ts` stores one base64 ciphertext per
 * profile in `<dataDir>/profile-keys.json`, encrypted with Electron's
 * `safeStorage` — the OS keychain, in effect. There is no Electron here, so
 * there is no decrypting it, and this module does not try.
 *
 * What it does instead is tell the truth about *presence*. `ProfileStore`
 * derives `hasApiKey` from `secrets.has(id)`, and the picker greys a profile
 * out when the key it needs cannot be read here. An in-memory store would make
 * every profile look keyless and the picker could never explain itself; this
 * one reports the entry the desktop wrote and returns `null` for its value,
 * which is exactly the situation.
 *
 * Writes are refused rather than ignored. The skeleton never edits a profile,
 * and if it ever did, silently dropping a key the user typed would be the
 * worst of the available failures.
 *
 * Only endpoint-style profiles — LM Studio, Ollama, llama.cpp, a remote
 * Artemis — carry a key at all. Claude, Codex and OpenCode accounts sign in
 * through their own CLI into the profile's config directory and never touch
 * this file, so for the accounts this TUI is mostly about the answer is
 * simply "no key, none needed".
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProfileId } from '@rx-artemis/protocol';
import type { ProfileSecrets } from '@rx-artemis/core';

/** Must match `SECRETS_FILE` in `apps/desktop/main/profileSecrets.ts`. */
const SECRETS_FILE = 'profile-keys.json';

async function readDocument(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // No file, or an unreadable one: the same answer as "no keys". The
    // desktop treats it identically.
    return {};
  }
}

export function createReadOnlyProfileKeys(dataDir: string): ProfileSecrets {
  const file = join(dataDir, SECRETS_FILE);
  const refuse = (): never => {
    throw new Error(
      'Endpoint API keys are stored by the desktop app and cannot be changed from the terminal. Edit the profile in Artemis instead.',
    );
  };
  return {
    async has(id: ProfileId): Promise<boolean> {
      const document = await readDocument(file);
      return typeof document[id] === 'string';
    },
    async read(): Promise<string | null> {
      return null;
    },
    async write(): Promise<void> {
      refuse();
    },
    async clear(): Promise<void> {
      refuse();
    },
  };
}
