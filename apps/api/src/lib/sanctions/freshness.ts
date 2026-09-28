import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";

import type { SanctionsSource } from "@stll/sanctions";

import type { ScopedDb } from "@/api/db/safe-db";
import { sanctionsEditions, sanctionsSources } from "@/api/db/schema";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/sanctions/source-config";

type FailureCode = NonNullable<
  typeof sanctionsSources.$inferSelect.lastFailureCode
>;

const isHeldUpdate = (code: FailureCode): boolean => {
  switch (code) {
    case "replacement-below-minimum":
    case "replacement-contracted":
    case "replacement-stale":
    case "replacement-source-mismatch":
      return true;
    case "access-denied":
    case "fetch-failed":
    case "metadata-invalid":
    case "parse-failed":
      return false;
    default: {
      code satisfies never;
      return panic("Unknown sanctions refresh failure");
    }
  }
};

export type SanctionsSourceFreshness = {
  source: SanctionsSource;
  issuer: string;
  licence: string | null;
  status: "fresh" | "unavailable";
  reason:
    | "not-loaded"
    | "access-denied"
    | "stale"
    | "list-update-held-for-review"
    | null;
  edition: {
    id: typeof sanctionsEditions.$inferSelect.id;
    publishedAt: string;
    fileId: string | null;
    entryCount: number;
  } | null;
  lastCheckedAt: Date | null;
  lastSuccessfulVerifiedAt: Date | null;
  heldUpdate: {
    code: FailureCode;
    at: Date;
    previousCount: number | null;
    nextCount: number | null;
  } | null;
};

type FreshnessReason = SanctionsSourceFreshness["reason"];

const freshnessReason = ({
  hasEdition,
  lastVerified,
  failureCode,
  heldUpdate,
  now,
  freshnessMs,
}: {
  hasEdition: boolean;
  lastVerified: Date | null;
  failureCode: FailureCode | null;
  heldUpdate: SanctionsSourceFreshness["heldUpdate"];
  now: Date;
  freshnessMs: number;
}): FreshnessReason => {
  if (!hasEdition || lastVerified === null) {return "not-loaded";}
  if (failureCode === "access-denied") {return "access-denied";}
  if (now.getTime() - lastVerified.getTime() <= freshnessMs) {return null;}
  return heldUpdate === null ? "stale" : "list-update-held-for-review";
};

const loadSanctionsRows = async (db: ScopedDb, ids: SanctionsSource[]) => 
  await db(
    async (tx) =>
      await tx
        .select({
          source: sanctionsSources.id,
          issuer: sanctionsSources.issuer,
          licence: sanctionsSources.licence,
          activeEditionId: sanctionsSources.activeEditionId,
          lastCheckedAt: sanctionsSources.lastCheckedAt,
          lastSuccessfulVerifiedAt: sanctionsSources.lastSuccessfulVerifiedAt,
          lastFailureAt: sanctionsSources.lastFailureAt,
          lastFailureCode: sanctionsSources.lastFailureCode,
          lastFailurePreviousCount: sanctionsSources.lastFailurePreviousCount,
          lastFailureNextCount: sanctionsSources.lastFailureNextCount,
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
  )
;

type SanctionsSourceRow = Awaited<ReturnType<typeof loadSanctionsRows>>[number];

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
  if (
    row?.activeEditionId !== null &&
    row?.activeEditionId !== undefined &&
    (row.editionId !== row.activeEditionId || row.editionState !== "ready")
  ) {
    return panic("Sanctions active edition is missing or not ready");
  }
  let edition: SanctionsSourceFreshness["edition"] = null;
  if (row?.activeEditionId !== null && row?.activeEditionId !== undefined) {
    if (
      row.editionId === null ||
      row.publishedAt === null ||
      row.entryCount === null
    ) {
      return panic("Sanctions active edition fields are missing");
    }
    edition = {
      id: row.editionId,
      publishedAt: row.publishedAt,
      fileId: row.fileId,
      entryCount: row.entryCount,
    };
  }
  const failureCode = row?.lastFailureCode ?? null;
  const heldUpdate =
    failureCode !== null && row?.lastFailureAt && isHeldUpdate(failureCode)
      ? {
          code: failureCode,
          at: row.lastFailureAt,
          previousCount: row.lastFailurePreviousCount,
          nextCount: row.lastFailureNextCount,
        }
      : null;
  const lastVerified = row?.lastSuccessfulVerifiedAt ?? null;
  const reason = freshnessReason({
    hasEdition: edition !== null,
    lastVerified,
    failureCode,
    heldUpdate,
    now,
    freshnessMs: config.freshnessMs,
  });
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
  };
};

export const readSanctionsFreshness = async ({
  db,
  now = new Date(),
}: {
  db: ScopedDb;
  now?: Date | undefined;
}): Promise<SanctionsSourceFreshness[]> => {
  const ids = sanctionsSourceIds();
  const rows = await loadSanctionsRows(db, ids);
  const bySource = new Map(rows.map((row) => [row.source, row]));
  return ids.map((source) =>
    toSourceFreshness({ source, row: bySource.get(source), now }),
  );
};
