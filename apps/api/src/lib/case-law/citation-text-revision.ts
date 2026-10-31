import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

type CitationTextRevisionFingerprintArgs = {
  contentHash: SQLWrapper;
  sections: SQLWrapper;
};

/** PostgreSQL JSONB canonicalization binds the digest to stored text and its corpus revision. */
export const citationTextRevisionFingerprintSql = ({
  contentHash,
  sections,
}: CitationTextRevisionFingerprintArgs) =>
  sql<string>`encode(sha256(convert_to(jsonb_build_array(${contentHash}, ${sections})::text, 'UTF8')), 'hex')`;
