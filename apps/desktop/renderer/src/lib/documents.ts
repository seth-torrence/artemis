/**
 * The documents a conversation has made, as a list.
 * ============================================================================
 *
 * A tile in the thread is one artifact at the moment it was written. This is
 * the other view of the same facts: every document the conversation has
 * produced, one entry per *file*, however many times the agent went back to
 * it. It is what the dock's documents tab draws and what the header's opener
 * counts.
 *
 * ## Built from the model's verdicts, not from a second pass over the items
 *
 * Which calls made artifacts is a question `TranscriptModel` already answers
 * — and memoises — for the rows, so the model keeps the answer as a list of
 * ids (`getArtifactsSnapshot`) and this reads that. What it adds is the part
 * the model cannot know: the *path* each call wrote, which needs the call's
 * arguments parsed against the column's working directory. That parse is a
 * diff, and it is not free, so it is cached per item object. An item is an
 * immutable snapshot that the model replaces rather than mutates, which makes
 * the object itself a sound key, and a `WeakMap` lets the cache follow the
 * transcript's own lifetime instead of needing to be emptied.
 *
 * ## One entry per file
 *
 * "Make the chart blue" is an `Edit` to an artifact that already exists, and
 * the transcript rightly shows it as a second tile — the reader wants the pane
 * to follow the change. A *list* of documents that showed the same file five
 * times would be a list of edits, not of documents, so entries are folded by
 * path: the first write fixes the entry's place (the order documents were made
 * is the order the conversation reads in), and each later call updates what is
 * known about it.
 */

import type { ToolItem, TranscriptItem } from '@rx-artemis/transcript';
import { detectFileEdit } from '@rx-artemis/transcript';
import { detectArtifact, type Artifact, type ArtifactKind } from './artifact';
import type { Platform } from './paths';

export interface Document {
  /** Absolute path, as the tile resolved it. */
  readonly path: string;
  /** Final path segment. */
  readonly title: string;
  readonly kind: ArtifactKind;
  /** Lower-case extension. */
  readonly extension: string;
  /** The call that first wrote it — where "show where it was made" goes. */
  readonly madeBy: string;
  /** The call that last wrote or edited it. */
  readonly touchedBy: string;
  /** When it was first written. */
  readonly madeAt: number;
  /** When it was last touched. */
  readonly touchedAt: number;
  /** How many calls wrote or edited it. One is a document never revised. */
  readonly revisions: number;
  /**
   * Its size, when the last thing that happened to it was a whole write.
   *
   * Absent after an edit, for the tile's reason: an edit's payload is a
   * fragment and the total is not knowable from the call. Reporting the size
   * of the version *before* the edit would be a number that is confidently
   * wrong.
   */
  readonly bytes?: number;
}

/** What {@link artifactOf} last answered for an item, and against what. */
interface Verdict {
  readonly cwd: string;
  readonly platform: Platform;
  readonly artifact: Artifact | null;
}

const verdicts = new WeakMap<ToolItem, Verdict>();

/**
 * The artifact a finished call produced, or `null`.
 *
 * The same question `ToolRow` asks with its own `useMemo`, cached here against
 * the item object so the list and the header can ask it of every artifact in
 * the conversation without re-parsing a diff per render. Re-taken when the
 * directory moves, because the answer is relative to it — see `lib/artifact.ts`.
 */
export function artifactOf(item: ToolItem, cwd: string, platform: Platform): Artifact | null {
  const cached = verdicts.get(item);
  if (cached !== undefined && cached.cwd === cwd && cached.platform === platform) {
    return cached.artifact;
  }
  const artifact =
    item.status === 'ok'
      ? detectArtifact(detectFileEdit(item.name, item.input), cwd, platform)
      : null;
  verdicts.set(item, { cwd, platform, artifact });
  return artifact;
}

/**
 * Fold the artifact calls of a conversation into its documents.
 *
 * `ids` is the model's artifacts snapshot and `lookup` its `getItem`. They are
 * passed rather than the model so the fold can be tested — and reasoned about
 * — as the pure function it is.
 */
export function collectDocuments(
  ids: readonly string[],
  lookup: (id: string) => TranscriptItem | undefined,
  cwd: string,
  platform: Platform,
): readonly Document[] {
  // Insertion order is the order documents were first made, which is what
  // makes a `Map` the right shape here rather than a convenience.
  const byPath = new Map<string, Document>();
  for (const id of ids) {
    const item = lookup(id);
    if (item?.kind !== 'tool') continue;
    const artifact = artifactOf(item, cwd, platform);
    if (artifact === null) continue;

    const key = pathKey(artifact.path, platform);
    const existing = byPath.get(key);
    // A whole write reports its size; an edit reports nothing, and retires the
    // number the previous write reported. See {@link Document.bytes}.
    const bytes = artifact.fresh && artifact.bytes !== undefined ? { bytes: artifact.bytes } : {};
    if (existing === undefined) {
      byPath.set(key, {
        path: artifact.path,
        title: artifact.title,
        kind: artifact.kind,
        extension: artifact.extension,
        madeBy: id,
        touchedBy: id,
        madeAt: item.ts,
        touchedAt: item.ts,
        revisions: 1,
        ...bytes,
      });
    } else {
      byPath.set(key, {
        path: existing.path,
        title: existing.title,
        kind: existing.kind,
        extension: existing.extension,
        madeBy: existing.madeBy,
        madeAt: existing.madeAt,
        touchedBy: id,
        touchedAt: item.ts,
        revisions: existing.revisions + 1,
        ...bytes,
      });
    }
  }
  return [...byPath.values()];
}

/**
 * The identity of a path, for folding.
 *
 * Separators unified and case folded on the two platforms whose filesystems
 * conventionally are — the accommodations `lib/artifact.ts` makes when it asks
 * whether a path is inside the project, and for the same reason: a tool call on
 * Windows mixes `/` and `\`, and `Report.md` and `report.md` are one file there.
 */
function pathKey(path: string, platform: Platform): string {
  const unified = path.replace(/[\/]/g, '/');
  return platform === 'linux' ? unified : unified.toLowerCase();
}
