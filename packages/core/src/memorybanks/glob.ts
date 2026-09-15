/**
 * A small glob for a bank's own file patterns.
 *
 * A bank says where its memories are with a pattern — the cortex shape is
 * "projects, any org, any project, memories, anything below, ending in .md" —
 * and that pattern is the whole of what a format adapter needs to know about a
 * layout. Four constructs cover every bank met so far: a double star for any
 * number of directories, a single star within one segment, a question mark for
 * one character, and braces for alternatives. A hand-rolled matcher over
 * forward-slash relative paths is smaller than a dependency and behaves the
 * same on every platform, which a bank's files (a Windows clone, a Linux
 * server) do not.
 *
 * Patterns are matched against paths relative to the bank root with `/` as the
 * separator, never against absolute paths, so a pattern written on one machine
 * means the same thing on another.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directories no bank keeps memories in, pruned before they are walked. */
const PRUNED_DIRECTORIES = new Set(['.git', 'node_modules', '.hg', '.svn']);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one pattern to a regular expression over a relative path.
 *
 * A double star matches any number of directories (including none when it is
 * followed by a slash), a single star anything within one segment, a question
 * mark one character, and braces one of their literal alternatives. A bracket
 * expression passes through as written.
 */
export function compileGlob(pattern: string): RegExp {
  const normalised = pattern.replace(/\\/g, '/').replace(/^\.?\//, '');
  let source = '';
  let i = 0;
  while (i < normalised.length) {
    const char = normalised[i] ?? '';
    if (char === '*') {
      if (normalised[i + 1] === '*') {
        if (normalised[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    if (char === '{') {
      const close = normalised.indexOf('}', i);
      if (close !== -1) {
        const alternatives = normalised
          .slice(i + 1, close)
          .split(',')
          .map((alternative) => escapeRegex(alternative.trim()));
        source += `(?:${alternatives.join('|')})`;
        i = close + 1;
        continue;
      }
    }
    if (char === '[') {
      const close = normalised.indexOf(']', i);
      if (close !== -1) {
        source += normalised.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    source += escapeRegex(char);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

/** Does the relative path match any of the patterns? */
export function matchesAny(relativePath: string, patterns: readonly RegExp[]): boolean {
  const path = relativePath.replace(/\\/g, '/');
  return patterns.some((pattern) => pattern.test(path));
}

/**
 * Every file under `root` matching one of the patterns, as sorted relative
 * paths with forward slashes.
 *
 * Symbolic links are not followed: a bank is a checkout, and a link out of it
 * is not the bank's content. Pruned directories are never entered.
 */
export function listFiles(root: string, patterns: readonly string[]): string[] {
  const compiled = patterns.map(compileGlob);
  const found: string[] = [];
  const walk = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(relative.length === 0 ? root : join(root, relative), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (PRUNED_DIRECTORIES.has(entry.name)) continue;
        walk(path);
        continue;
      }
      if (entry.isFile() && matchesAny(path, compiled)) found.push(path);
    }
  };
  walk('');
  return found.sort();
}
