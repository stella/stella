import { and, eq, isNull, sql } from "drizzle-orm";

import { publishedCaseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";

export type DecisionPayloadVersion = {
  id: SafeId<"caseLawDecision">;
  updatedAt: Date;
  contentHash: string | null;
  astS3Key: string | null;
};

type DecisionPayloadColumn = "documentAst" | "fulltext" | "sections";
type DecisionPayloadValue = {
  documentAst: unknown;
  fulltext: string | null;
  sections: (typeof publishedCaseLawDecisions.$inferSelect)["sections"];
};

export type DecisionPayloadRead<K extends DecisionPayloadColumn> =
  | { kind: "found"; value: DecisionPayloadValue[K] }
  | { kind: "version-changed" };

/**
 * Reads one lazy payload only when the live row still has the admitted
 * identity. Callers retry their whole multi-column operation after a
 * `version-changed` result, so no cache can associate bytes with a version
 * that did not name them.
 */
export const readDecisionVersionedPayload = async <
  K extends DecisionPayloadColumn,
>(
  tx: CaseLawPublicReadTransaction,
  version: DecisionPayloadVersion,
  column: K,
): Promise<DecisionPayloadRead<K>> => {
  const selection = {
    documentAst: { value: publishedCaseLawDecisions.documentAst },
    fulltext: { value: publishedCaseLawDecisions.fulltext },
    sections: { value: publishedCaseLawDecisions.sections },
  }[column];
  const [row] = await tx
    .select(selection)
    .from(publishedCaseLawDecisions)
    .where(
      and(
        eq(publishedCaseLawDecisions.id, version.id),
        eq(
          publishedCaseLawDecisions.updatedAt,
          sql`${version.updatedAt}::timestamptz`,
        ),
        version.contentHash === null
          ? isNull(publishedCaseLawDecisions.contentHash)
          : eq(publishedCaseLawDecisions.contentHash, version.contentHash),
        version.astS3Key === null
          ? isNull(publishedCaseLawDecisions.astS3Key)
          : eq(publishedCaseLawDecisions.astS3Key, version.astS3Key),
      ),
    )
    .limit(1);
  return row === undefined
    ? { kind: "version-changed" }
    : { kind: "found", value: row.value };
};
