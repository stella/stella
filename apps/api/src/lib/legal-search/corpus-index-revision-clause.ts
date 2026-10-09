import { panic } from "better-result";

import { isUuid } from "@stll/uuid-codec";

import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";

/** The projection intent that wrote a document's copy into the index. */
export type CorpusProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

export type CorpusProjectionRevisionField =
  CorpusIndexManifest["projection"]["projectionRevisionField"];

type CorpusRevisionClauseOptions = {
  /** A clause addressing one document or passage, e.g. `document_id:"…"`. */
  clause: string;
  field: CorpusProjectionRevisionField;
  revision: CorpusProjectionRevision;
};

/**
 * Narrow a clause to the copy one revision wrote.
 *
 * A refresh appends the new revision's documents and deletes the previous
 * revision's asynchronously; the engine applies deletes to mature splits
 * only, so both copies answer a query until then. A read that hands stored
 * text or an anchor to a reader or a model addresses the revision Postgres
 * records as applied, so the copy it returns is the current one by
 * construction rather than by rank.
 */
export const corpusRevisionClause = ({
  clause,
  field,
  revision,
}: CorpusRevisionClauseOptions): string =>
  isUuid(revision)
    ? `(${clause} AND ${field}:"${revision}")`
    : panic(`invalid corpus projection revision: ${revision}`);
