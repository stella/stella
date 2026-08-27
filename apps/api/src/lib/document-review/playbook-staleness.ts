/**
 * Whether a completed run still reflects today's playbook.
 *
 * Derived on read, never stored. A stored flag would have to be invalidated by
 * every approval of every playbook, across every run that ever pinned it; the
 * comparison it stands for is a single equality between two ids the reader
 * already has. Document-version staleness is the same argument one level up
 * and is left to the client, which knows the document's current version.
 */

import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";

export type PlaybookStaleness = {
  /** An approved version exists that this run did not measure against. */
  playbookStale: boolean;
  /** The pinned definition is gone. The run stays readable — the snapshot is
   *  embedded — but there is nothing left to be newer than it. */
  playbookMissing: boolean;
};

type ResolvePlaybookStalenessArgs = {
  /** The playbook the run pinned. */
  pinned: PinnedPlaybook;
  /** The newest approved version of the pinned definition, or null when the
   *  definition has none. Null with `definitionExists: false` when the
   *  definition itself was deleted. */
  latestVersionId: string | null;
  definitionExists: boolean;
};

/**
 * Staleness is "a newer approval happened", which needs something to compare
 * against on both sides:
 *
 *  - an ephemeral pin (no definition id): neither stale nor missing — nothing
 *    was ever saved for a later approval to be newer than;
 *  - definition deleted: reported as missing, never as stale — a run cannot be
 *    behind a playbook that no longer exists;
 *  - run pinned a draft (no version id): stale as soon as any approved version
 *    exists, since the reviewer measured against something never approved;
 *  - run pinned an approved version: stale when that is no longer the newest.
 *
 * A definition with no approved version at all leaves an approved pin
 * unstale: there is no later approval to be behind.
 */
export const resolvePlaybookStaleness = ({
  pinned,
  latestVersionId,
  definitionExists,
}: ResolvePlaybookStalenessArgs): PlaybookStaleness => {
  if (pinned.definitionId === null) {
    return { playbookStale: false, playbookMissing: false };
  }
  if (!definitionExists) {
    return { playbookStale: false, playbookMissing: true };
  }
  if (latestVersionId === null) {
    return { playbookStale: false, playbookMissing: false };
  }
  return {
    playbookStale: pinned.versionId !== latestVersionId,
    playbookMissing: false,
  };
};
