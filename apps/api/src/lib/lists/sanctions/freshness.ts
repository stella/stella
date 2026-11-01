import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";

import type { SanctionsSource } from "@stll/sanctions";

import { sanctionsEditions, sanctionsSources } from "@/api/db/schema";
import type { SanctionsReadDb } from "@/api/lib/lists/sanctions/read-db";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";

type FailureCode = NonNullable<
  typeof sanctionsSources.$inferSelect.lastFailureCode
>;
type GuardCode = NonNullable<
  typeof sanctionsSources.$inferSelect.heldGuardCode
>;

export type SanctionsSourceFreshness = {
  source: SanctionsSource;
  issuer: string;
  licence: string | null;
  status: "fresh" | "unavailable";
  reason: "not-loaded" | "access-denied" | "stale" | null;
  edition: {
    id: typeof sanctionsEditions.$inferSelect.id;
    publishedAt: string;
    fileId: string | null;
    entryCount: number;
  } | null;
  lastCheckedAt: Date | null;
  lastSuccessfulVerifiedAt: Date | null;
  heldUpdate: {
    editionId: typeof sanctionsEditions.$inferSelect.id;
    code: GuardCode;
    at: Date;
    previousCount: number | null;
    nextCount: number | null;
  } | null;
  annotation:
    | { type: "held-for-review"; code: GuardCode }
    | { type: "transport-failure"; code: FailureCode; at: Date }
    | null;
};

const freshnessReason = ({
  hasEdition,
  lastVerified,
  failureCode,
  now,
  freshnessMs,
}: {
  hasEdition: boolean;
  lastVerified: Date | null;
  failureCode: FailureCode | null;
  now: Date;
  freshnessMs: number;
}): SanctionsSourceFreshness["reason"] => {
  if (!hasEdition || lastVerified === null) {
    return failureCode === "access-denied" ? "access-denied" : "not-loaded";
  }
  if (now.getTime() - lastVerified.getTime() > freshnessMs) {
    return "stale";
  }
  return null;
};

const loadSanctionsRows = async (
  db: SanctionsReadDb,
  ids: readonly SanctionsSource[],
) =>
  await db(
    async (tx) =>
      await tx
        .select({
          source: sanctionsSources.id,
          issuer: sanctionsSources.issuer,
          licence: sanctionsSources.licence,
          activeEditionId: sanctionsSources.activeEditionId,
          heldEditionId: sanctionsSources.heldEditionId,
          heldGuardCode: sanctionsSources.heldGuardCode,
          heldAt: sanctionsSources.heldAt,
          heldPreviousCount: sanctionsSources.heldPreviousCount,
          heldNextCount: sanctionsSources.heldNextCount,
          lastCheckedAt: sanctionsSources.lastCheckedAt,
          lastSuccessfulVerifiedAt: sanctionsSources.lastSuccessfulVerifiedAt,
          lastFailureAt: sanctionsSources.lastFailureAt,
          lastFailureCode: sanctionsSources.lastFailureCode,
          editionId: sanctionsEditions.id,
          editionState: sanctionsEditions.state,
          publishedAt: sanctionsEditions.publishedAt,
          fileId: sanctionsEditions.fileId,
          entryCount: sanctionsEditions.entryCount,
        })
        .from(sanctionsSources)
        .leftJoin(
          sanctionsEditions,
          eq(sanctionsSources.activeEditionId, sanctionsEditions.id),
        )
        .where(inArray(sanctionsSources.id, ids))
        .limit(ids.length),
  );

type SanctionsSourceRow = Awaited<ReturnType<typeof loadSanctionsRows>>[number];

const activeEditionFromRow = (
  row: SanctionsSourceRow | undefined,
): SanctionsSourceFreshness["edition"] => {
  if (row?.activeEditionId === null || row?.activeEditionId === undefined) {
    return null;
  }
  if (
    row.editionId === null ||
    row.editionId !== row.activeEditionId ||
    row.editionState !== "ready"
  ) {
    return panic("Sanctions active edition is missing or not ready");
  }
  if (row.publishedAt === null || row.entryCount === null) {
    return panic("Sanctions active edition fields are missing");
  }
  return {
    id: row.editionId,
    publishedAt: row.publishedAt,
    fileId: row.fileId,
    entryCount: row.entryCount,
  };
};

const heldUpdateFromRow = (
  row: SanctionsSourceRow | undefined,
): SanctionsSourceFreshness["heldUpdate"] => {
  if (row?.heldGuardCode === null || row?.heldGuardCode === undefined) {
    return null;
  }
  if (row.heldEditionId === null || row.heldAt === null) {
    return panic("Sanctions held update fields are missing");
  }
  return {
    editionId: row.heldEditionId,
    code: row.heldGuardCode,
    at: row.heldAt,
    previousCount: row.heldPreviousCount,
    nextCount: row.heldNextCount,
  };
};

type ToFreshnessOptions = {
  source: SanctionsSource;
  row: SanctionsSourceRow | undefined;
  now: Date;
};

const toSourceFreshness = ({
  source,
  row,
  now,
}: ToFreshnessOptions): SanctionsSourceFreshness => {
  const config = SANCTIONS_SOURCE_CONFIG[source];
  const edition = activeEditionFromRow(row);
  const heldUpdate = heldUpdateFromRow(row);

  const failureCode = row?.lastFailureCode ?? null;
  const failureAt = row?.lastFailureAt ?? null;
  if ((failureCode === null) !== (failureAt === null)) {
    return panic("Sanctions transport failure fields are inconsistent");
  }
  const lastVerified = row?.lastSuccessfulVerifiedAt ?? null;
  const reason = freshnessReason({
    hasEdition: edition !== null,
    lastVerified,
    failureCode,
    now,
    freshnessMs: config.freshnessMs,
  });
  let annotation: SanctionsSourceFreshness["annotation"] = null;
  if (heldUpdate !== null) {
    annotation = { type: "held-for-review", code: heldUpdate.code };
  } else if (failureCode !== null && failureAt !== null) {
    annotation = {
      type: "transport-failure",
      code: failureCode,
      at: failureAt,
    };
  }
  return {
    source,
    issuer: row?.issuer ?? config.issuer,
    licence: row?.licence ?? null,
    status: reason === null ? "fresh" : "unavailable",
    reason,
    edition,
    lastCheckedAt: row?.lastCheckedAt ?? null,
    lastSuccessfulVerifiedAt: lastVerified,
    heldUpdate,
    annotation,
  };
};

export const readSanctionsFreshness = async ({
  db,
  now = new Date(),
}: {
  db: SanctionsReadDb;
  now?: Date | undefined;
}): Promise<SanctionsSourceFreshness[]> => {
  const ids = sanctionsSourceIds();
  const rows = await loadSanctionsRows(db, ids);
  const bySource = new Map(rows.map((row) => [row.source, row]));
  return ids.map((source) =>
    toSourceFreshness({ source, row: bySource.get(source), now }),
  );
};
