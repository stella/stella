import { panic } from "better-result";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { brand, custom, parse, pipe } from "valibot";
import type { Brand } from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { parsePlainDate, Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  legislationAmendments,
  legislationAmendmentSnapshots,
  legislationSources,
} from "@/api/db/schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { stripDangerousChars } from "@/api/lib/legal-search/corpus-sanitize";
import type {
  LegislationAmendmentRelation,
  LegislationAmendmentSnapshot,
} from "@/api/lib/legal-search/legislation-ingestion-types";
import { redistributableLegislationSourceFor } from "@/api/lib/legal-search/legislation-redistribution-sql";
import type { LegislationWorkRef } from "@/api/lib/legal-search/legislation-work-names";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { isRecord } from "@/api/lib/type-guards";

export const LEGISLATION_AMENDMENT_PAGE_MAX = 500;
export const LEGISLATION_AMENDMENT_SNAPSHOT_MAX = 50_000;
const AMENDMENT_INSERT_BATCH_SIZE = 1000;

export type SanitizedLegislationAmendmentSnapshot =
  LegislationAmendmentSnapshot & Brand<"SanitizedLegislationAmendmentSnapshot">;

const isLegislationAmendmentSnapshot = (
  value: unknown,
): value is LegislationAmendmentSnapshot =>
  typeof value === "object" && value !== null;

const sanitizedLegislationAmendmentSnapshotSchema = pipe(
  custom<LegislationAmendmentSnapshot>(isLegislationAmendmentSnapshot),
  brand("SanitizedLegislationAmendmentSnapshot"),
);

/** Sanitize before hashing, and reject identities whose effects would collide. */
export const sanitizeLegislationAmendments = (
  snapshot: LegislationAmendmentSnapshot,
): SanitizedLegislationAmendmentSnapshot => {
  Temporal.Instant.from(snapshot.observedAt);
  if (snapshot.relations.length > LEGISLATION_AMENDMENT_SNAPSHOT_MAX) {
    return panic("Legislation amendment snapshot exceeds its relation limit");
  }
  const seen = new Set<string>();
  const nullableText = (text: string | null) =>
    text === null ? null : stripDangerousChars(text);
  const relations = snapshot.relations
    .map((relation) => {
      const publisherId = stripDangerousChars(relation.publisherId);
      const amendingEli = stripDangerousChars(relation.amendingEli);
      const affectedAnchor = stripDangerousChars(relation.affectedAnchor);
      if (
        publisherId === "" ||
        amendingEli === "" ||
        affectedAnchor === "" ||
        seen.has(publisherId)
      ) {
        return panic(
          "Legislation amendment snapshot has an empty or duplicate identity",
        );
      }
      seen.add(publisherId);
      if (
        relation.effective.type === "date" &&
        parsePlainDate(relation.effective.on) === null
      ) {
        return panic("Legislation amendment has an invalid effective date");
      }
      return {
        publisherId,
        amendingEli,
        amendingTitle: nullableText(relation.amendingTitle),
        amendingAnchor: nullableText(relation.amendingAnchor),
        affectedAnchor,
        changeKind: relation.changeKind,
        effective:
          relation.effective.type === "date"
            ? { type: "date", on: relation.effective.on }
            : {
                type: "not-stated",
                text: nullableText(relation.effective.text),
              },
        publisherInstruction: nullableText(relation.publisherInstruction),
      } satisfies LegislationAmendmentRelation;
    })
    .toSorted((left, right) =>
      compareCodeUnit(left.publisherId, right.publisherId),
    );
  const coverage = snapshot.coverage;
  if (
    coverage.type !== "complete" &&
    stripDangerousChars(coverage.reason).trim() === ""
  ) {
    return panic("Incomplete legislation amendment coverage needs a reason");
  }
  if (
    coverage.type === "partial" &&
    (!Number.isSafeInteger(coverage.unlocatedRelations) ||
      coverage.unlocatedRelations < 1)
  ) {
    return panic(
      "Partial legislation amendment coverage needs an unlocated relation count",
    );
  }
  if (coverage.type === "not-stated" && relations.length > 0) {
    return panic("Unstated legislation amendments cannot carry relations");
  }
  return parse(sanitizedLegislationAmendmentSnapshotSchema, {
    observedAt: Temporal.Instant.from(snapshot.observedAt).toString(),
    relations,
    coverage:
      coverage.type === "complete"
        ? { type: "complete" }
        : { ...coverage, reason: stripDangerousChars(coverage.reason) },
  });
};

const snapshotWork = (work: LegislationWorkRef) =>
  and(
    eq(legislationAmendmentSnapshots.sourceId, work.sourceId),
    eq(legislationAmendmentSnapshots.targetEli, work.eli),
    eq(legislationAmendmentSnapshots.language, work.language),
  );

type SyncLegislationAmendmentsOptions = {
  work: LegislationWorkRef;
  snapshot: SanitizedLegislationAmendmentSnapshot | undefined;
};

/** Work-level lock precedes expression locks in the ingestion transaction. */
export const syncLegislationAmendmentsTx = async (
  tx: Transaction,
  { work, snapshot }: SyncLegislationAmendmentsOptions,
) => {
  if (snapshot === undefined) {
    return "not-observed";
  }
  await withAggregateLock({
    aggregate: "legislationAmendmentWork",
    id: work,
    tx,
  });
  const stored = (
    await tx
      .select({
        observedAt: legislationAmendmentSnapshots.observedAt,
        coverage: legislationAmendmentSnapshots.coverage,
      })
      .from(legislationAmendmentSnapshots)
      .where(snapshotWork(work))
      .limit(1)
  ).at(0);
  // A channel with no relation model cannot retract a richer observation
  // fetched through the publisher's relation-bearing channel.
  if (
    stored !== undefined &&
    stored.coverage.type !== "not-stated" &&
    snapshot.coverage.type === "not-stated"
  ) {
    return "not-observed";
  }
  const observedAt = new Date(
    Temporal.Instant.from(snapshot.observedAt).epochMilliseconds,
  );
  // Absence in a channel without a relation model is not a relation snapshot;
  // the first relation-bearing observation replaces it even if fetched earlier.
  if (
    stored !== undefined &&
    stored.observedAt >= observedAt &&
    (stored.coverage.type !== "not-stated" ||
      snapshot.coverage.type === "not-stated")
  ) {
    return "superseded";
  }
  // audit: skip — publisher corpus snapshot, committed with its observed document
  await tx
    .delete(legislationAmendments)
    .where(
      and(
        eq(legislationAmendments.sourceId, work.sourceId),
        eq(legislationAmendments.targetEli, work.eli),
        eq(legislationAmendments.language, work.language),
      ),
    );
  for (
    let start = 0;
    start < snapshot.relations.length;
    start += AMENDMENT_INSERT_BATCH_SIZE
  ) {
    // db-await-in-loop: bounded chunks stay below the PostgreSQL parameter ceiling in one atomic snapshot
    // audit: skip — publisher corpus snapshot, committed with its observed document
    await tx.insert(legislationAmendments).values(
      snapshot.relations
        .slice(start, start + AMENDMENT_INSERT_BATCH_SIZE)
        .map((relation) => ({
          sourceId: work.sourceId,
          targetEli: work.eli,
          language: work.language,
          publisherId: relation.publisherId,
          amendingEli: relation.amendingEli,
          amendingTitle: relation.amendingTitle,
          amendingAnchor: relation.amendingAnchor,
          affectedAnchor: relation.affectedAnchor,
          changeKind: relation.changeKind,
          effectiveType: relation.effective.type,
          effectiveDate:
            relation.effective.type === "date" ? relation.effective.on : null,
          effectiveText:
            relation.effective.type === "not-stated"
              ? relation.effective.text
              : null,
          publisherInstruction: relation.publisherInstruction,
        })),
    );
  }
  // audit: skip — publisher corpus snapshot observation watermark
  await tx
    .insert(legislationAmendmentSnapshots)
    .values({
      sourceId: work.sourceId,
      targetEli: work.eli,
      language: work.language,
      observedAt,
      coverage: snapshot.coverage,
    })
    .onConflictDoUpdate({
      target: [
        legislationAmendmentSnapshots.sourceId,
        legislationAmendmentSnapshots.targetEli,
        legislationAmendmentSnapshots.language,
      ],
      set: { observedAt, coverage: snapshot.coverage },
    });
  return "applied";
};

type ReadLegislationAmendmentsOptions = {
  work: LegislationWorkRef;
  direction: "incoming" | "outgoing";
  limit: number;
  cursor?: string | null;
  /** Known dates after this day, plus publisher effects whose effective date is unstated. */
  effectiveAfter?: string;
  /** Exact stated effect dates for a bounded page of consolidation starts. */
  effectiveDates?: readonly string[];
};

/** One owner for pending incoming changes and the acts amended by a Work. */
export const readLegislationAmendments = async (
  tx: LegislationReadTransaction,
  {
    work,
    direction,
    limit,
    cursor = null,
    effectiveAfter,
    effectiveDates,
  }: ReadLegislationAmendmentsOptions,
) => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LEGISLATION_AMENDMENT_PAGE_MAX
  ) {
    return panic("Invalid legislation amendment page limit");
  }
  const after = cursor === null ? null : decodePaginationCursor(cursor);
  if (
    cursor !== null &&
    (after?.length !== 2 ||
      typeof after.at(0) !== "string" ||
      typeof after.at(1) !== "string")
  ) {
    return panic("Invalid legislation amendment cursor");
  }
  const afterTarget = after?.at(0);
  const afterPublisher = after?.at(1);
  const rows = await tx
    .select({ relation: legislationAmendments })
    .from(legislationAmendments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationAmendments.sourceId),
    )
    .where(
      and(
        eq(legislationAmendments.sourceId, work.sourceId),
        eq(legislationAmendments.language, work.language),
        eq(
          direction === "incoming"
            ? legislationAmendments.targetEli
            : legislationAmendments.amendingEli,
          work.eli,
        ),
        redistributableLegislationSourceFor(legislationSources.descriptor),
        effectiveDates === undefined
          ? undefined
          : inArray(legislationAmendments.effectiveDate, [...effectiveDates]),
        effectiveAfter === undefined
          ? undefined
          : or(
              gt(legislationAmendments.effectiveDate, effectiveAfter),
              eq(legislationAmendments.effectiveType, "not-stated"),
            ),
        typeof afterTarget === "string" && typeof afterPublisher === "string"
          ? or(
              gt(legislationAmendments.targetEli, afterTarget),
              and(
                eq(legislationAmendments.targetEli, afterTarget),
                gt(legislationAmendments.publisherId, afterPublisher),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(legislationAmendments.targetEli),
      asc(legislationAmendments.publisherId),
    )
    .limit(limit + 1);
  return createCursorPage({
    rows: rows.map(({ relation }) => relation),
    limit,
    cursorForItem: (row) =>
      encodePaginationCursor([row.targetEli, row.publisherId]),
  });
};

export const readLegislationAmendmentSnapshot = async (
  tx: LegislationReadTransaction,
  work: LegislationWorkRef,
) => {
  const capability = await tx.execute<{ available: boolean }>(sql`
    SELECT COALESCE(
      has_column_privilege(
        current_user,
        to_regclass('public.legislation_amendment_snapshots'),
        'coverage',
        'SELECT'
      )
      AND has_column_privilege(
        current_user,
        to_regclass('public.legislation_amendments'),
        'publisher_id',
        'SELECT'
      ),
      false
    ) AS available
  `);
  const capabilityRow = executedRows(capability).at(0);
  if (!isRecord(capabilityRow) || capabilityRow["available"] !== true) {
    return null;
  }

  return (
    (
      await tx
        .select({
          observedAt: legislationAmendmentSnapshots.observedAt,
          coverage: legislationAmendmentSnapshots.coverage,
        })
        .from(legislationAmendmentSnapshots)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationAmendmentSnapshots.sourceId),
        )
        .where(
          and(
            snapshotWork(work),
            redistributableLegislationSourceFor(legislationSources.descriptor),
          ),
        )
        .limit(1)
    ).at(0) ?? null
  );
};
