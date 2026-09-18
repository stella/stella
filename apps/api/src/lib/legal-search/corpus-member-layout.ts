/**
 * How a case-law ingestion batch lays its corpus payloads out in object
 * storage.
 *
 * - `objects` One object per payload, as the corpus has always been written.
 * - `packs`   One pack per batch: the batch's payloads are members of a
 *             single immutable object, addressed by byte range.
 *
 * Packing is selected rather than assumed. Its bytes are only reclaimed when
 * a pack is rewritten, and nothing in this repository rewrites one, so a
 * deployment turns it on when it has somewhere for that debt to go. The
 * tombstone table records the packs that owe a rewrite.
 *
 * Resolved once in `env-base`; every consumer reads that single value.
 */
export const CORPUS_MEMBER_LAYOUTS = ["objects", "packs"] as const;

export type CorpusMemberLayout = (typeof CORPUS_MEMBER_LAYOUTS)[number];

export const resolveCorpusMemberLayout = (
  layout: CorpusMemberLayout | undefined,
): CorpusMemberLayout => layout ?? "objects";
