import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { brand, custom, parse, pipe, safeParse } from "valibot";
import type { Brand } from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { declareFingerprintFields } from "@stll/errors";
import { Temporal } from "@stll/time";

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
  LegislationAmendmentChannelObservation,
  LegislationAmendmentChannelSnapshot,
  LegislationAmendmentCoverage,
  LegislationAmendmentRelation,
  LegislationAmendmentSnapshot,
  LegislationAmendmentStoredCoverage,
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

import { legislationAmendmentEffectSchema } from "./legislation-amendment-effect";
import {
  LEGISLATION_AMENDMENT_CHANNEL_LIMIT,
  LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES,
  LEGISLATION_AMENDMENT_LEGACY_CHANNEL,
  resolveLegislationAmendmentEffect,
  retainLegislationAmendmentCondition,
} from "./legislation-amendment-observations";

export const LEGISLATION_AMENDMENT_PAGE_MAX = 500;
/**
 * The most relations one observation of a work may carry. Not a page size:
 * the relations are written in batches and read back in pages, so this only
 * bounds one ingestion's memory and transaction. Set well above the largest
 * work a publisher states (134/1998 Sb.: 56,958 consolidation links), so every
 * stated relation is stored; an observation past it is refused and the
 * adapter records a typed `partial` coverage that reads show.
 */
export const LEGISLATION_AMENDMENT_SNAPSHOT_MAX = 250_000;
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
  | "invalid_effective_condition"
  | "invalid_channel"
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
  const channel = snapshot.channel ?? LEGISLATION_AMENDMENT_LEGACY_CHANNEL;
  if (
    channel.trim() !== channel ||
    channel.length === 0 ||
    stripDangerousChars(channel) !== channel ||
    exceedsBytes(channel, LEGISLATION_AMENDMENT_CHANNEL_MAX_BYTES)
  ) {
    return rejected("invalid_channel", "Invalid amendment publisher channel");
  }
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
    const effective = safeParse(
      legislationAmendmentEffectSchema,
      relation.effective,
    );
    if (!effective.success) {
      return rejected(
        relation.effective.type === "conditional"
          ? "invalid_effective_condition"
          : "invalid_effective_date",
        "Legislation amendment has an invalid publisher effect",
      );
    }
    relations.push({
      publisherId,
      amendingEli,
      amendingTitle: nullableText(relation.amendingTitle),
      amendingAnchor: nullableText(relation.amendingAnchor),
      affectedAnchor,
      changeKind: relation.changeKind,
      effective: effective.output,
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
      channel,
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

export const storedLegislationAmendmentRelation = (
  row: typeof legislationAmendments.$inferSelect,
): LegislationAmendmentRelation => ({
  publisherId: row.publisherId,
  amendingEli: row.amendingEli,
  amendingTitle: row.amendingTitle,
  amendingAnchor: row.amendingAnchor,
  affectedAnchor: row.affectedAnchor,
  changeKind: row.changeKind,
  publisherInstruction: row.publisherInstruction,
  effective:
    row.effectiveType === "date"
      ? {
          type: "date",
          on: row.effectiveDate ?? panic("Dated amendment has no date"),
        }
      : { type: "not-stated", text: row.effectiveText },
});

const combinedCoverage = (
  channels: readonly LegislationAmendmentChannelSnapshot[],
): LegislationAmendmentStoredCoverage => {
  const active = channels.filter((item) => item.status === "active");
  const partial = active.find(({ coverage }) => coverage.type === "partial");
  const representative =
    partial ??
    active.find(({ coverage }) => coverage.type === "complete") ??
    active.at(0) ??
    panic("A coverage projection needs a channel observation");
  const coverage = representative.coverage;
  if (active.length === 1) {
    return coverage;
  }
  const models = active.filter((item) => item.coverage.type !== "not-stated");
  let distinctUnlocatedTotal: NonNullable<
    LegislationAmendmentStoredCoverage["aggregation"]
  >["distinctUnlocatedTotal"];
  if (partial !== undefined && models.length > 1) {
    distinctUnlocatedTotal = { type: "unknown" };
  } else if (coverage.type === "partial") {
    distinctUnlocatedTotal = {
      type: "exact",
      count: coverage.unlocatedRelations,
    };
  } else if (coverage.type === "complete") {
    distinctUnlocatedTotal = { type: "exact", count: 0 };
  } else {
    distinctUnlocatedTotal = { type: "unknown" };
  }
  return {
    ...coverage,
    ...(coverage.type === "partial"
      ? { reason: `[${representative.channel}] ${coverage.reason}` }
      : {}),
    aggregation: {
      representativeChannel: representative.channel,
      channels: active.map(({ channel, coverage: report }) => ({
        channel,
        coverage: report,
      })),
      distinctUnlocatedTotal,
    },
  };
};

type TransitionAmendmentContributionOptions = {
  snapshot: SanitizedLegislationAmendmentSnapshot;
  incomingIds: ReadonlySet<string>;
  publisherId: string;
};

const transitionAmendmentContribution = (
  item: LegislationAmendmentChannelObservation,
  {
    snapshot,
    incomingIds,
    publisherId,
  }: TransitionAmendmentContributionOptions,
): LegislationAmendmentChannelObservation[] => {
  const channel = snapshot.channel ?? LEGISLATION_AMENDMENT_LEGACY_CHANNEL;
  const retiresLegacy =
    channel !== LEGISLATION_AMENDMENT_LEGACY_CHANNEL &&
    snapshot.coverage.type === "complete";
  if (item.channel === channel && incomingIds.has(publisherId)) {
    return [];
  }
  if (retiresLegacy && item.channel === LEGISLATION_AMENDMENT_LEGACY_CHANNEL) {
    if (item.status === "absent") {
      return [];
    }
    return [
      {
        status: "historical",
        channel: item.channel,
        observedAt: item.observedAt,
        relation: item.relation,
        ...(item.retainedConditional === undefined
          ? {}
          : { retainedConditional: item.retainedConditional }),
      },
    ];
  } else if (
    item.channel === channel &&
    snapshot.coverage.type === "complete"
  ) {
    return [
      {
        status: "absent",
        channel,
        observedAt: snapshot.observedAt,
        lastPositive:
          item.status === "absent"
            ? item.lastPositive
            : {
                observedAt: item.observedAt,
                relation: item.relation,
                ...(item.retainedConditional === undefined
                  ? {}
                  : { retainedConditional: item.retainedConditional }),
              },
      },
    ];
  }
  return [item];
};

type RetainAmendmentContributionsOptions = {
  previous: readonly (typeof legislationAmendments.$inferSelect)[];
  observedAt: Date | undefined;
  snapshot: SanitizedLegislationAmendmentSnapshot;
  channels: readonly LegislationAmendmentChannelSnapshot[];
};

const retainAmendmentContributions = ({
  previous,
  observedAt,
  snapshot,
  channels,
}: RetainAmendmentContributionsOptions) => {
  const channel = snapshot.channel ?? LEGISLATION_AMENDMENT_LEGACY_CHANNEL;
  const status =
    channels.find((item) => item.channel === channel)?.status ??
    panic("Incoming amendment channel has no snapshot");
  const previousById = new Map(previous.map((row) => [row.publisherId, row]));
  const retained = new Map<string, LegislationAmendmentChannelObservation[]>();
  const incomingIds = new Set(
    snapshot.relations.map(({ publisherId }) => publisherId),
  );
  for (const row of previous) {
    const observations: LegislationAmendmentChannelObservation[] =
      row.observations ?? [
        {
          status: "present",
          channel: LEGISLATION_AMENDMENT_LEGACY_CHANNEL,
          observedAt:
            observedAt?.toISOString() ??
            panic("An amendment row has no observation watermark"),
          relation: storedLegislationAmendmentRelation(row),
        },
      ];
    const next = observations.flatMap((item) =>
      transitionAmendmentContribution(item, {
        snapshot,
        incomingIds,
        publisherId: row.publisherId,
      }),
    );
    retained.set(row.publisherId, next);
  }
  for (const relation of snapshot.relations) {
    const old = previousById
      .get(relation.publisherId)
      ?.observations?.find((item) => item.channel === channel);
    const priorEvidence =
      old?.status === "absent" ? (old.lastPositive ?? undefined) : old;
    const retainedConditional = retainLegislationAmendmentCondition(
      priorEvidence,
      relation,
    );
    const observation = {
      status: status === "historical" ? "historical" : "present",
      channel,
      observedAt: snapshot.observedAt,
      relation,
      ...(retainedConditional === undefined ? {} : { retainedConditional }),
    } satisfies LegislationAmendmentChannelObservation;
    const existing = retained.get(relation.publisherId);
    if (existing === undefined) {
      retained.set(relation.publisherId, [observation]);
    } else {
      existing.push(observation);
    }
  }
  for (const observations of retained.values()) {
    for (const report of channels) {
      if (
        report.status === "active" &&
        report.channel !== LEGISLATION_AMENDMENT_LEGACY_CHANNEL &&
        report.coverage.type === "complete" &&
        !observations.some((item) => item.channel === report.channel)
      ) {
        observations.push({
          status: "absent",
          channel: report.channel,
          observedAt: report.observedAt,
          lastPositive: null,
        });
      }
    }
  }
  return retained;
};

const amendmentRowFromContributions = (
  observations: readonly LegislationAmendmentChannelObservation[],
  work: LegislationWorkRef,
) => {
  const ordered = observations.toSorted((left, right) =>
    compareCodeUnit(left.channel, right.channel),
  );
  const active = ordered.find((item) => item.status === "present");
  if (active === undefined || active.status !== "present") {
    return panic("Retained amendment has no active contribution");
  }
  const relation = active.relation;
  const effectDetails = resolveLegislationAmendmentEffect(ordered);
  let effectiveDate: string | null = null;
  let effectiveText: string | null = null;
  switch (effectDetails.type) {
    case "date":
      effectiveDate = effectDetails.on;
      break;
    case "conditional":
      effectiveDate = effectDetails.actualDate;
      effectiveText =
        effectiveDate === null ? effectDetails.condition.text : null;
      break;
    case "not-stated":
      effectiveText = effectDetails.text;
      break;
    case "conflicting":
      break;
    default:
      effectDetails satisfies never;
      return panic("Unhandled resolved amendment effect");
  }
  return {
    sourceId: work.sourceId,
    targetEli: work.eli,
    language: work.language,
    publisherId: relation.publisherId,
    amendingEli: relation.amendingEli,
    amendingTitle: relation.amendingTitle,
    amendingAnchor: relation.amendingAnchor,
    affectedAnchor: relation.affectedAnchor,
    changeKind: relation.changeKind,
    publisherInstruction: relation.publisherInstruction,
    effectiveType: effectiveDate === null ? "not-stated" : "date",
    effectiveDate,
    effectiveText,
    effectDetails,
    observations: ordered,
  } satisfies typeof legislationAmendments.$inferInsert;
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
        channelSnapshots: legislationAmendmentSnapshots.channelSnapshots,
      })
      .from(legislationAmendmentSnapshots)
      .where(snapshotWork(work))
      .limit(1)
  ).at(0);
  const channel = snapshot.channel ?? LEGISLATION_AMENDMENT_LEGACY_CHANNEL;
  const channels: LegislationAmendmentChannelSnapshot[] =
    stored?.channelSnapshots ??
    (stored === undefined
      ? []
      : [
          {
            channel: LEGISLATION_AMENDMENT_LEGACY_CHANNEL,
            status: "active",
            observedAt: stored.observedAt.toISOString(),
            coverage: stored.coverage,
          },
        ]);
  const prior = channels.find((item) => item.channel === channel);
  if (
    prior !== undefined &&
    prior.coverage.type !== "not-stated" &&
    snapshot.coverage.type === "not-stated"
  ) {
    return "not-observed";
  }
  if (
    prior !== undefined &&
    Temporal.Instant.compare(prior.observedAt, snapshot.observedAt) >= 0 &&
    !(
      channel === LEGISLATION_AMENDMENT_LEGACY_CHANNEL &&
      prior.coverage.type === "not-stated" &&
      snapshot.coverage.type !== "not-stated"
    )
  ) {
    return "superseded";
  }
  // Channel identifiers belong to adapter integrations, never publisher input.
  if (
    prior === undefined &&
    channels.length >= LEGISLATION_AMENDMENT_CHANNEL_LIMIT
  ) {
    return panic("An amendment source exceeded its publisher-channel contract");
  }
  const retiresLegacy =
    channel !== LEGISLATION_AMENDMENT_LEGACY_CHANNEL &&
    snapshot.coverage.type === "complete";
  const status = prior?.status ?? "active";
  const nextChannels: LegislationAmendmentChannelSnapshot[] = [
    ...channels
      .filter((item) => item.channel !== channel)
      .map((item) =>
        retiresLegacy && item.channel === LEGISLATION_AMENDMENT_LEGACY_CHANNEL
          ? {
              channel: item.channel,
              status: "historical" as const,
              observedAt: item.observedAt,
              coverage: item.coverage,
            }
          : item,
      ),
    {
      channel,
      status,
      observedAt: snapshot.observedAt,
      coverage: snapshot.coverage,
    },
  ].toSorted((left, right) => compareCodeUnit(left.channel, right.channel));
  const previous = await tx
    .select()
    .from(legislationAmendments)
    .where(
      and(
        eq(legislationAmendments.sourceId, work.sourceId),
        eq(legislationAmendments.targetEli, work.eli),
        eq(legislationAmendments.language, work.language),
      ),
    );
  const retained = retainAmendmentContributions({
    previous,
    observedAt: stored?.observedAt,
    snapshot,
    channels: nextChannels,
  });
  const rows = [...retained.entries()]
    .filter(([, observations]) =>
      observations.some((item) => item.status === "present"),
    )
    .toSorted(([left], [right]) => compareCodeUnit(left, right))
    .map(([, observations]) =>
      amendmentRowFromContributions(observations, work),
    );
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
    start < rows.length;
    start += AMENDMENT_INSERT_BATCH_SIZE
  ) {
    // audit: skip — publisher corpus snapshot, committed with its observed document
    await tx
      .insert(legislationAmendments)
      .values(rows.slice(start, start + AMENDMENT_INSERT_BATCH_SIZE));
  }
  const observedAt = new Date(
    Math.max(
      ...nextChannels.map(
        (item) => Temporal.Instant.from(item.observedAt).epochMilliseconds,
      ),
    ),
  );
  const coverage = combinedCoverage(nextChannels);
  // audit: skip — publisher corpus snapshot observation watermarks
  await tx
    .insert(legislationAmendmentSnapshots)
    .values({
      sourceId: work.sourceId,
      targetEli: work.eli,
      language: work.language,
      observedAt,
      coverage,
      channelSnapshots: nextChannels,
    })
    .onConflictDoUpdate({
      target: [
        legislationAmendmentSnapshots.sourceId,
        legislationAmendmentSnapshots.targetEli,
        legislationAmendmentSnapshots.language,
      ],
      set: { observedAt, coverage, channelSnapshots: nextChannels },
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
