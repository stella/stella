import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";

/**
 * Where a legislation version's canonical payload lives: the object-storage
 * key the row records, or the Postgres copy. Every reader and projection of a
 * version's payload decides through the functions below, so no two of them
 * can read a row from different copies.
 */
type CanonicalLegislationPayloadSource =
  | { type: "object_storage"; key: string }
  | { type: "database" };

const canonicalPayloadSource = (
  storedKey: string | null,
  mode: CorpusStorageMode,
): CanonicalLegislationPayloadSource =>
  mode !== "off" && storedKey !== null
    ? { type: "object_storage", key: storedKey }
    : { type: "database" };

/** Where a version's canonical AST is read from. */
export const canonicalLegislationAstSource = (
  { astS3Key }: { astS3Key: string | null },
  mode: CorpusStorageMode,
) => canonicalPayloadSource(astS3Key, mode);

/** Where a version's canonical text is read from. */
export const canonicalLegislationTextSource = (
  { textS3Key }: { textS3Key: string | null },
  mode: CorpusStorageMode,
) => canonicalPayloadSource(textS3Key, mode);
