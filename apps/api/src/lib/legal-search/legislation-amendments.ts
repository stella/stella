import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { brand, custom, parse, pipe } from "valibot";
import type { Brand } from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { declareFingerprintFields } from "@stll/errors";
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
  LegislationAmendmentCoverage,
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
// An accepted observation that cannot be stored would roll back the statute it
// arrived with. The identities are bounded in UTF-8 bytes by their columns'
// declared lengths: bytes never undercount characters, and the indexes that
// hold them together stay under PostgreSQL's B-tree entry limit.
const columnLength = (column: { length: number | undefined; name: string }) =>
  column.length ??
  panic(`legislation_amendments.${column.name} needs a length`);
const AMENDMENT_IDENTITY_MAX_BYTES = {
  targetEli: columnLength(legislationAmendments.targetEli),
  publisherId: columnLength(legislationAmendments.publisherId),
  amendingEli: columnLength(legislationAmendments.amendingEli),
} as const;
const exceedsBytes = (text: string, maxBytes: number) =>
  Buffer.byteLength(text, "utf-8") > maxBytes;

export type SanitizedLegislationAmendmentSnapshot =
  LegislationAmendmentSnapshot & Brand<"SanitizedLegislationAmendmentSnapshot">;

export type LegislationAmendmentObservationErrorReason =
  | "duplicate_publisher_id"
  | "empty_affected_anchor"
  | "amending_eli_too_long"
  | "empty_amending_eli"
  | "empty_publisher_id"
  | "incomplete_coverage_without_reason"
  | "invalid_effective_date"
  | "invalid_observed_at"
  | "invalid_partial_unlocated_relations"
  | "publisher_id_too_long"
  | "target_eli_too_long"
  | "relation_limit_exceeded"
  | "unstated_coverage_with_relations";

export class LegislationAmendmentObservationError extends TaggedError(
  "LegislationAmendmentObservationError",
)<{
  message: string;
  reason: LegislationAmendmentObservationErrorReason;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const isLegislationAmendmentSnapshot = (
  value: unknown,
): value is LegislationAmendmentSnapshot =>
  typeof value === "object" && value !== null;

const sanitizedLegislationAmendmentSnapshotSchema = pipe(
  custom<LegislationAmendmentSnapshot>(isLegislationAmendmentSnapshot),
  brand("SanitizedLegislationAmendmentSnapshot"),
);

/**
 * Field by field: the publisher's object may carry keys the closed response
 * schemas refuse, and a stored one would break every read of the statute.
 */
const sanitizedCoverage = (
  coverage: LegislationAmendmentCoverage,
): LegislationAmendmentCoverage => {
  switch (coverage.type) {
    case "complete":
      return { type: "complete" };
    case "partial":
      return {
        type: "partial",
        unlocatedRelations: coverage.unlocatedRelations,
        reason: stripDangerousChars(coverage.reason),
      };
    case "not-stated":
      return {
        type: "not-stated",
        reason: stripDangerousChars(coverage.reason),
      };
    default:
      coverage satisfies never;
      return panic("Unhandled amendment coverage type");
  }
};

/** Sanitize before hashing, and reject identities whose effects would collide. */
/**
 * The amended work's own identity enters every amendment index entry beside
 * the relation identities, so it is bounded the same way; the statute itself
 * is still stored when its amendments are refused.
 */
export const admitLegislationAmendmentTarget = (
  targetEli: string,
): Result<void, LegislationAmendmentObservationError> =>
  exceedsBytes(targetEli, AMENDMENT_IDENTITY_MAX_BYTES.targetEli)
    ? Result.err(
        new LegislationAmendmentObservationError({
          message:
            "Legislation amendments target an ELI longer than can be stored",
          reason: "target_eli_too_long",
        }),
      )
    : Result.ok();

export const sanitizeLegislationAmendments = (
  snapshot: LegislationAmendmentSnapshot,
): Result<
  SanitizedLegislationAmendmentSnapshot,
  LegislationAmendmentObservationError
> => {
  const rejected = (
    reason: LegislationAmendmentObservationErrorReason,
    message: string,
  ) =>
    Result.err(new LegislationAmendmentObservationError({ message, reason }));
  const observedAt = Result.try(() =>
    Temporal.Instant.from(snapshot.observedAt),
  );
  if (Result.isError(observedAt)) {
    return rejected(
      "invalid_observed_at",
      "Invalid amendment observation time",
    );
  }
  if (snapshot.relations.length > LEGISLATION_AMENDMENT_SNAPSHOT_MAX) {
    return rejected(
      "relation_limit_exceeded",
      "Legislation amendment snapshot exceeds its relation limit",
    );
  }
  const seen = new Set<string>();
  const nullableText = (text: string | null) =>
    text === null ? null : stripDangerousChars(text);
  const relations: LegislationAmendmentRelation[] = [];
  for (const relation of snapshot.relations) {
    const publisherId = stripDangerousChars(relation.publisherId);
    const amendingEli = stripDangerousChars(relation.amendingEli);
    const affectedAnchor = stripDangerousChars(relation.affectedAnchor);
    if (publisherId === "") {
      return rejected(
        "empty_publisher_id",
        "Legislation amendment has an empty publisher identity",
      );
    }
    if (seen.has(publisherId)) {
      return rejected(
        "duplicate_publisher_id",
        "Legislation amendment snapshot has a duplicate publisher identity",
      );
    }
    if (amendingEli === "") {
      return rejected(
        "empty_amending_eli",
        "Legislation amendment has an empty amending ELI",
      );
    }
    if (exceedsBytes(publisherId, AMENDMENT_IDENTITY_MAX_BYTES.publisherId)) {
      return rejected(
        "publisher_id_too_long",
        "Legislation amendment has a publisher identity longer than can be stored",
      );
    }
    if (exceedsBytes(amendingEli, AMENDMENT_IDENTITY_MAX_BYTES.amendingEli)) {
      return rejected(
        "amending_eli_too_long",
        "Legislation amendment has an amending ELI longer than can be stored",
      );
    }
    if (affectedAnchor === "") {
      return rejected(
        "empty_affected_anchor",
        "Legislation amendment has an empty affected anchor",
      );
    }
    seen.add(publisherId);
    if (
      relation.effective.type === "date" &&
      parsePlainDate(relation.effective.on) === null
    ) {
      return rejected(
        "invalid_effective_date",
        "Legislation amendment has an invalid effective date",
      );
    }
    relations.push({
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
    });
  }
  relations.sort((left, right) =>
    compareCodeUnit(left.publisherId, right.publisherId),
  );
  const coverage = snapshot.coverage;
  if (
    coverage.type !== "complete" &&
    stripDangerousChars(coverage.reason).trim() === ""
  ) {
    return rejected(
      "incomplete_coverage_without_reason",
      "Incomplete legislation amendment coverage needs a reason",
    );
  }
  if (
    coverage.type === "partial" &&
    (!Number.isSafeInteger(coverage.unlocatedRelations) ||
      coverage.unlocatedRelations < 1)
  ) {
    return rejected(
      "invalid_partial_unlocated_relations",
      "Partial legislation amendment coverage needs an unlocated relation count",
    );
  }
  if (coverage.type === "not-stated" && relations.length > 0) {
    return rejected(
      "unstated_coverage_with_relations",
      "Unstated legislation amendments cannot carry relations",
    );
  }
  return Result.ok(
    parse(sanitizedLegislationAmendmentSnapshotSchema, {
      observedAt: observedAt.value.toString(),
      relations,
      coverage: sanitizedCoverage(coverage),
    }),
  );
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
