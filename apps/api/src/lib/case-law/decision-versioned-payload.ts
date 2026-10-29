import { and, eq, isNull, or, sql } from "drizzle-orm";

import { publishedCaseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";

export type DecisionPayloadVersion = {
  id: SafeId<"caseLawDecision">;
  versionTimestamp: string;
  contentHash: string | null;
  astS3Key: string | null;
};

/** One identity for both AST and section caches, preserving stored precision. */
export const decisionPayloadKey = (version: DecisionPayloadVersion): string =>
  JSON.stringify([
    version.id,
    version.versionTimestamp,
    version.contentHash,
    version.astS3Key,
  ]);

export type DecisionPayloadColumn = "documentAst" | "fulltext" | "sections";
type DecisionPayloadValue = Pick<
  typeof publishedCaseLawDecisions.$inferSelect,
  DecisionPayloadColumn
>;

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
  const rows = await readDecisionVersionedPayloads({
    tx,
    versions: [version],
    column,
  });
  return rows.get(version.id) ?? { kind: "version-changed" };
};

type DecisionPayloadBatchOptions<K extends DecisionPayloadColumn> = {
  tx: CaseLawPublicReadTransaction;
  versions: readonly DecisionPayloadVersion[];
  column: K;
};

/** One query for a bounded window, qualified by each admitted payload identity. */
export const readDecisionVersionedPayloads = async <
  K extends DecisionPayloadColumn,
>({
  tx,
  versions,
  column,
}: DecisionPayloadBatchOptions<K>): Promise<
  Map<string, DecisionPayloadRead<K>>
> => {
  if (versions.length === 0) {
    return new Map();
  }
  const selection = { value: publishedCaseLawDecisions[column] };
  const rows = await tx
    .select({ id: publishedCaseLawDecisions.id, ...selection })
    .from(publishedCaseLawDecisions)
    .where(
      or(
        ...versions.map((version) =>
          and(
            eq(publishedCaseLawDecisions.id, version.id),
            eq(
              publishedCaseLawDecisions.updatedAt,
              sql`${version.versionTimestamp}::timestamptz`,
            ),
            version.contentHash === null
              ? isNull(publishedCaseLawDecisions.contentHash)
              : eq(publishedCaseLawDecisions.contentHash, version.contentHash),
            version.astS3Key === null
              ? isNull(publishedCaseLawDecisions.astS3Key)
              : eq(publishedCaseLawDecisions.astS3Key, version.astS3Key),
          ),
        ),
      ),
    );
  return new Map(
    rows.map((row) => [row.id, { kind: "found", value: row.value }]),
  );
};
