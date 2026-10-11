import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";

export type CitationTextRevision = {
  contentHash: string | null;
  sections: readonly { text: string }[] | null;
};

type CitationTextRevisionFenceArgs = {
  citingDecisionId: SQLWrapper;
  expectedContentHash: SQLWrapper;
  expectedSections: SQLWrapper;
};

type RevisionFenceArgs = { citingDecisionId: SQLWrapper; predicate: SQL };

/** Graph-admitted writers compare the revision in the same statement as their mutation. */
const revisionFenceSql = ({
  citingDecisionId,
  predicate,
}: RevisionFenceArgs) => sql`EXISTS (
  SELECT 1 FROM ${caseLawDecisions} AS citation_text_revision
   WHERE citation_text_revision.id = ${citingDecisionId}
     AND ${sql.raw(publishedCaseLawDecisionSqlFor("citation_text_revision"))}
     AND ${predicate}
)`;

export const citationTextRevisionFence = ({
  citingDecisionId,
  expectedContentHash,
  expectedSections,
}: CitationTextRevisionFenceArgs) =>
  revisionFenceSql({
    citingDecisionId,
    predicate: sql`citation_text_revision.content_hash IS NOT DISTINCT FROM ${expectedContentHash}
    AND citation_text_revision.sections IS NOT DISTINCT FROM ${expectedSections}`,
  });

type CitationTextRevisionFingerprintArgs = {
  contentHash: SQLWrapper;
  sections: SQLWrapper;
};

/** PostgreSQL JSONB canonicalization binds the digest to both stored text and its corpus revision. */
export const citationTextRevisionFingerprintSql = ({
  contentHash,
  sections,
}: CitationTextRevisionFingerprintArgs) =>
  sql<string>`encode(sha256(convert_to(jsonb_build_array(${contentHash}, ${sections})::text, 'UTF8')), 'hex')`;

type CitationTextRevisionFingerprintFenceArgs = {
  citingDecisionId: SQLWrapper;
  expectedFingerprint: SQLWrapper;
};

export const citationTextRevisionFingerprintFence = ({
  citingDecisionId,
  expectedFingerprint,
}: CitationTextRevisionFingerprintFenceArgs) =>
  revisionFenceSql({
    citingDecisionId,
    predicate: sql`${citationTextRevisionFingerprintSql({
      contentHash: sql.raw("citation_text_revision.content_hash"),
      sections: sql.raw("citation_text_revision.sections"),
    })} = ${expectedFingerprint}`,
  });
