import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawDocumentLocators,
  softLawDocuments,
  softLawDocumentVersions,
  softLawIngestionAttempts,
  softLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import {
  SOFT_LAW_AUTHORITIES,
  SOFT_LAW_BATCH_LIMIT,
  SOFT_LAW_EXTRACTION_QUALITIES,
  SOFT_LAW_EXTRACTION_QUALITY_RANK,
  SoftLawIngestionError,
  storedSoftLawDiscoveryEntry,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawDiscoveryEntry,
  SoftLawDocumentInput,
  SoftLawEntry,
  SoftLawRawObject,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

const LEASE_SECONDS = 300;
const MINIMUM_LISTING_FRACTION = 0.8;
const extractionQualityRank = (quality: SQL) =>
  sqlCaseFragment({
    operand: quality,
    branches: SOFT_LAW_EXTRACTION_QUALITIES.map(
      (value) =>
        sql`WHEN ${value} THEN ${SOFT_LAW_EXTRACTION_QUALITY_RANK[value]}`,
    ),
    fallback: sql`-1`,
  });
export type SoftLawObservation = {
  entry: SoftLawEntry;
  input: SoftLawDocumentInput;
  documentId: SafeId<"softLawDocument">;
  identityKey: string;
  contentHash: string;
  rawObjects: SoftLawRawObject[];
  identityResolution:
    | { kind: "create" | "attach" }
    | {
        kind: "merge_repaired_placeholder";
        placeholderDocumentId: SafeId<"softLawDocument">;
      };
};
type SoftLawIngestionStoreOptions = {
  sourceId: SafeId<"softLawSource">;
  scopedDb: ScopedDb;
  adapter: SoftLawSourceAdapter;
};
type SoftLawStoreContext = SoftLawIngestionStoreOptions & {
  leaseToken: SafeId<"softLawIngestionLease">;
  ownsLease: SQL | undefined;
};
type SoftLawSourceClaim =
  | { type: "blocked"; reason: "forbidden" | "rate_limited" | "challenge" }
  | { type: "claimed"; row: typeof softLawSources.$inferSelect }
  | { type: "busy" };
const claimSoftLawSource = async ({
  sourceId,
  scopedDb,
  adapter,
  leaseToken,
}: SoftLawStoreContext): Promise<
  Result<SoftLawSourceClaim, SoftLawIngestionError>
> =>
  await scopedDb(async (tx) => {
    // audit: skip - ephemeral mutual-exclusion state for public ingestion
    const row = (
      await tx
        .select()
        .from(softLawSources)
        .where(eq(softLawSources.id, sourceId))
        .for("update")
        .limit(1)
    ).at(0);
    if (!row) {
      return Result.err(
        new SoftLawIngestionError({ message: "Source does not exist" }),
      );
    }
    if (row.adapterKey !== adapter.key) {
      return Result.err(
        new SoftLawIngestionError({
          message: "Source adapter does not match",
        }),
      );
    }
    if (row.runState === "blocked") {
      return Result.ok({
        type: "blocked" as const,
        reason:
          row.failureTag === "forbidden" ||
          row.failureTag === "rate_limited" ||
          row.failureTag === "challenge"
            ? row.failureTag
            : panic("Blocked source has no block reason"),
      });
    }
    const restart = row.runState === "listing_incomplete";
    const listed =
      row.runId && !restart
        ? row.listingBaseline
        : ((
            await tx
              .select({ count: sql<number>`count(*)::integer` })
              .from(softLawDocuments)
              .where(
                and(
                  eq(softLawDocuments.sourceId, sourceId),
                  eq(softLawDocuments.listingState, "listed"),
                ),
              )
          ).at(0)?.count ?? 0);
    const claimed = (
      await tx
        .update(softLawSources)
        .set({
          runState: "running",
          listingBaseline: listed,
          runId: restart
            ? Bun.randomUUIDv7()
            : (row.runId ?? Bun.randomUUIDv7()),
          runStartedAt: restart ? new Date() : (row.runStartedAt ?? new Date()),
          leaseToken,
          leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
          failureTag:
            restart || row.failureTag === "listing_incomplete"
              ? "listing_incomplete"
              : null,
        })
        .where(
          and(
            eq(softLawSources.id, sourceId),
            sql`(${softLawSources.leaseExpiresAt} IS NULL OR ${softLawSources.leaseExpiresAt} <= now())`,
          ),
        )
        .returning()
    ).at(0);
    return Result.ok(
      claimed
        ? { type: "claimed" as const, row: claimed }
        : { type: "busy" as const },
    );
  });
const renewSoftLawLease = async ({
  scopedDb,
  ownsLease,
}: SoftLawStoreContext) => {
  const renewed = await scopedDb(
    async (tx) =>
      // audit: skip - renews ephemeral ownership for public ingestion
      await tx
        .update(softLawSources)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
        })
        .where(ownsLease)
        .returning({ id: softLawSources.id }),
  );
  if (!renewed.at(0)) {
    return Result.err(
      new SoftLawIngestionError({
        message: "Ingestion lease was superseded",
      }),
    );
  }
  return Result.ok();
};
export type SoftLawAttempt = {
  entry: SoftLawDiscoveryEntry;
  count: number;
  /** Exact discovery snapshots are retained even when the instrument's content is unchanged. */
  rawObjects: SoftLawObservation["rawObjects"];
} & (
  | { status: "applied" | "unchanged" | "retryable"; tag: null }
  | { status: "rejected"; tag: "identity_collision"; identityKey: string }
  | {
      status: "rejected";
      tag: "ambiguous_locator" | "invalid_document" | "retry_exhausted";
    }
);
type LoadSoftLawMatchesOptions = {
  entries: readonly SoftLawEntry[];
  identityKeys: readonly string[];
};
type LoadSoftLawCollisionsOptions = {
  entries: readonly { url: string; identityKey: string }[];
};
const loadSoftLawCollisions = async (
  { sourceId, scopedDb }: SoftLawStoreContext,
  { entries }: LoadSoftLawCollisionsOptions,
) =>
  await scopedDb(
    async (tx) =>
      await tx
        .selectDistinct({
          url: softLawIngestionAttempts.url,
          identityKey: softLawIngestionAttempts.identityKey,
        })
        .from(softLawIngestionAttempts)
        .where(
          and(
            eq(softLawIngestionAttempts.sourceId, sourceId),
            sql`${softLawIngestionAttempts.tag} = 'identity_collision'`,
            or(
              ...entries.map(({ url, identityKey }) =>
                and(
                  eq(softLawIngestionAttempts.url, url),
                  eq(softLawIngestionAttempts.identityKey, identityKey),
                ),
              ),
            ),
          ),
        )
        .limit(SOFT_LAW_BATCH_LIMIT),
  );
const loadSoftLawAttempts = async (
  { sourceId, scopedDb }: SoftLawStoreContext,
  {
    runId,
    entries,
  }: { runId: string; entries: readonly SoftLawDiscoveryEntry[] },
) =>
  (
    await scopedDb(
      async (tx) =>
        await tx
          .select()
          .from(softLawIngestionAttempts)
          .where(
            and(
              eq(softLawIngestionAttempts.sourceId, sourceId),
              eq(softLawIngestionAttempts.runId, runId),
              or(
                inArray(
                  softLawIngestionAttempts.url,
                  entries.map((entry) => entry.url),
                ),
                eq(softLawIngestionAttempts.status, "retryable"),
              ),
            ),
          )
          .orderBy(softLawIngestionAttempts.url)
          .limit(SOFT_LAW_BATCH_LIMIT * 2),
    )
  ).map((attempt) => ({
    ...attempt,
    entry: storedSoftLawDiscoveryEntry(attempt.entry),
  }));
const loadSoftLawMatches = async (
  { sourceId, scopedDb }: SoftLawStoreContext,
  { entries, identityKeys }: LoadSoftLawMatchesOptions,
) =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({
          document: softLawDocuments,
          version: softLawDocumentVersions,
          locator: softLawDocumentLocators,
        })
        .from(softLawDocuments)
        .leftJoin(
          softLawDocumentVersions,
          and(
            eq(softLawDocumentVersions.documentId, softLawDocuments.id),
            sql`${softLawDocumentVersions.observedTo} IS NULL`,
          ),
        )
        .leftJoin(
          softLawDocumentLocators,
          and(
            eq(softLawDocumentLocators.documentId, softLawDocuments.id),
            or(
              eq(softLawDocumentLocators.state, "current"),
              inArray(
                softLawDocumentLocators.url,
                entries.map((entry) => entry.url),
              ),
            ),
          ),
        )
        .where(
          and(
            eq(softLawDocuments.sourceId, sourceId),
            or(
              inArray(softLawDocuments.identityKey, identityKeys),
              inArray(
                softLawDocumentLocators.url,
                entries.map((entry) => entry.url),
              ),
            ),
          ),
        ),
  );
type PersistSoftLawPageOptions = {
  observations: readonly SoftLawObservation[];
  attempts: readonly SoftLawAttempt[];
  expectedCursor: string | null;
  nextCursor: string | null;
  runId: string;
  expectedTotal: number | null;
  pendingRetries: boolean;
};
export type SoftLawPageResult =
  | { status: "persisted" }
  | {
      status: "listing_incomplete";
      seen: number;
      baseline: number;
      expectedTotal: number | null;
    };
type PersistSoftLawRowsOptions = {
  items: readonly SoftLawObservation[];
  sourceId: SafeId<"softLawSource">;
  adapter: SoftLawSourceAdapter;
  runId: string;
  observedAt: Date;
};
const persistSoftLawRows = async (
  tx: Transaction,
  { items, sourceId, adapter, runId, observedAt }: PersistSoftLawRowsOptions,
) => {
  // audit: skip - background ingestion of public documents and locator history
  const rows = items.map((item) => {
    const { metadata } = item.input;
    return {
      id: item.documentId,
      sourceId,
      identityKey: item.identityKey,
      authority: adapter.authority,
      jurisdiction: SOFT_LAW_AUTHORITIES[adapter.authority].jurisdiction,
      title: metadata.title,
      kind: metadata.kind,
      statedReferenceState: metadata.statedReference.state,
      statedReference:
        metadata.statedReference.state === "stated"
          ? metadata.statedReference.value
          : null,
      issuedOnState: metadata.issuedOn.state,
      issuedOn:
        metadata.issuedOn.state === "stated" ? metadata.issuedOn.value : null,
      validityState: metadata.validity.state,
      validityBasis: metadata.validity.basis,
      listingState: "listed" as const,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      lastSeenRun: runId,
    };
  });
  if (rows.length) {
    // One row per identity; multiple equal-content locators share that row.
    const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
    await tx
      .insert(softLawDocuments)
      .values(uniqueRows)
      .onConflictDoUpdate({
        target: softLawDocuments.id,
        set: {
          identityKey: sql`excluded.identity_key`,
          title: sql`excluded.title`,
          kind: sql`excluded.kind`,
          statedReference: sql`excluded.stated_reference`,
          statedReferenceState: sql`excluded.stated_reference_state`,
          issuedOn: sql`excluded.issued_on`,
          issuedOnState: sql`excluded.issued_on_state`,
          validityState: sql`excluded.validity_state`,
          validityBasis: sql`excluded.validity_basis`,
          listingState: sql`excluded.listing_state`,
          lastSeenAt: sql`excluded.last_seen_at`,
          lastSeenRun: sql`excluded.last_seen_run`,
        },
      });
    // A repaired placeholder may merge into an owner inserted just above on
    // this page, so its versions and locators move only once that row exists.
    // db-await-in-loop-disable: only repaired placeholders merge, rarely and one at a time; each merge's steps must run in order inside this transaction
    for (const item of items) {
      switch (item.identityResolution.kind) {
        case "create":
        case "attach":
          break;
        case "merge_repaired_placeholder": {
          const { placeholderDocumentId } = item.identityResolution;
          const maximumSequence = (
            await tx
              .select({
                value: sql<number>`coalesce(max(${softLawDocumentVersions.sequence}), 0)::integer`,
              })
              .from(softLawDocumentVersions)
              .where(eq(softLawDocumentVersions.documentId, item.documentId))
          ).at(0)?.value;
          if (maximumSequence === undefined) {
            panic("Could not read repaired document version sequence");
          }
          await tx
            .update(softLawDocumentVersions)
            .set({ observedTo: observedAt })
            .where(
              and(
                eq(softLawDocumentVersions.documentId, placeholderDocumentId),
                sql`${softLawDocumentVersions.observedTo} IS NULL`,
              ),
            );
          await tx
            .update(softLawDocumentVersions)
            .set({
              documentId: item.documentId,
              sequence: sql`${softLawDocumentVersions.sequence} + ${maximumSequence}`,
            })
            .where(
              eq(softLawDocumentVersions.documentId, placeholderDocumentId),
            );
          await tx
            .update(softLawDocumentLocators)
            .set({ documentId: item.documentId })
            .where(
              eq(softLawDocumentLocators.documentId, placeholderDocumentId),
            );
          await tx
            .delete(softLawDocuments)
            .where(eq(softLawDocuments.id, placeholderDocumentId));
          break;
        }
        default:
          item.identityResolution satisfies never;
          panic("Unknown soft-law identity resolution");
      }
    }
    // db-await-in-loop-enable
    await tx
      .insert(softLawDocumentLocators)
      .values(
        items.map((item) => ({
          sourceId,
          documentId: item.documentId,
          url: item.entry.url,
          state: "current" as const,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          lastSeenRun: runId,
        })),
      )
      .onConflictDoUpdate({
        target: [
          softLawDocumentLocators.documentId,
          softLawDocumentLocators.url,
        ],
        set: { state: "current", lastSeenAt: observedAt, lastSeenRun: runId },
      });
  }
};
type PersistSoftLawVersionsOptions = {
  items: readonly SoftLawObservation[];
  observedAt: Date;
};
const persistSoftLawVersions = async (
  tx: Transaction,
  { items, observedAt }: PersistSoftLawVersionsOptions,
) => {
  // audit: skip - public corpus versions retain their own observation history
  if (!items.length) {
    return;
  }
  const ids = items.map((item) => item.documentId);
  const latest = await tx
    .select()
    .from(softLawDocumentVersions)
    .where(
      and(
        inArray(softLawDocumentVersions.documentId, ids),
        sql`${softLawDocumentVersions.observedTo} IS NULL`,
      ),
    );
  const byDocument = new Map(latest.map((row) => [row.documentId, row]));
  const maximumSequences = new Map(
    (
      await tx
        .select({
          documentId: softLawDocumentVersions.documentId,
          sequence: sql<number>`max(${softLawDocumentVersions.sequence})::integer`,
        })
        .from(softLawDocumentVersions)
        .where(inArray(softLawDocumentVersions.documentId, ids))
        .groupBy(softLawDocumentVersions.documentId)
    ).map((row) => [row.documentId, row.sequence]),
  );
  const changes = [
    ...new Map(items.map((item) => [item.documentId, item])).values(),
  ].filter(
    (item) => byDocument.get(item.documentId)?.contentHash !== item.contentHash,
  );
  const closing = changes.flatMap((item) => {
    const old = byDocument.get(item.documentId);
    return old ? [old.id] : [];
  });
  if (closing.length) {
    await tx
      .update(softLawDocumentVersions)
      .set({ observedTo: observedAt })
      .where(inArray(softLawDocumentVersions.id, closing));
  }
  const currentObservations = [
    ...new Map(items.map((item) => [item.documentId, item])).values(),
  ];
  if (currentObservations.length) {
    // Quality rank decides: a worse extraction never replaces a better one,
    // and a textless one never replaces stored text of equal rank. A failed
    // extraction still yields to a later textless parse (needs_ocr), which
    // clears the stale failure.
    const incomingRank = extractionQualityRank(
      sql`excluded.extraction_quality`,
    );
    const storedRank = extractionQualityRank(
      sql`${softLawDocumentVersions.extractionQuality}`,
    );
    const preserveStoredExtraction = sql`(${incomingRank} < ${storedRank} OR (${incomingRank} = ${storedRank} AND excluded.extracted_text IS NULL))`;
    await tx
      .insert(softLawDocumentVersions)
      .values(
        currentObservations.map((item) => ({
          documentId: item.documentId,
          sequence:
            byDocument.get(item.documentId)?.contentHash === item.contentHash
              ? (byDocument.get(item.documentId)?.sequence ??
                panic("Unchanged expression has no version"))
              : (maximumSequences.get(item.documentId) ?? 0) + 1,
          contentHash: item.contentHash,
          metadata: item.input.metadata,
          rawObjects: item.rawObjects,
          extractedText: item.input.text,
          extractionFailure: item.input.extractionFailure ?? null,
          extractionQuality: item.input.extractionQuality,
          sourceDates: item.input.sourceDates,
          observedFrom:
            byDocument.get(item.documentId)?.contentHash === item.contentHash
              ? (byDocument.get(item.documentId)?.observedFrom ??
                panic("Unchanged expression has no observation date"))
              : observedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          softLawDocumentVersions.documentId,
          softLawDocumentVersions.sequence,
        ],
        set: {
          extractedText: sql`CASE WHEN ${preserveStoredExtraction} THEN ${softLawDocumentVersions.extractedText} ELSE excluded.extracted_text END`,
          extractionQuality: sql`CASE WHEN ${preserveStoredExtraction} THEN ${softLawDocumentVersions.extractionQuality} ELSE excluded.extraction_quality END`,
          extractionFailure: sql`CASE WHEN ${preserveStoredExtraction} THEN ${softLawDocumentVersions.extractionFailure} ELSE excluded.extraction_failure END`,
        },
      });
  }
};
type PersistRejectedSoftLawListingsOptions = {
  attempts: readonly SoftLawAttempt[];
  sourceId: SafeId<"softLawSource">;
  runId: string;
  observedAt: Date;
};
const persistRejectedSoftLawListings = async (
  tx: Transaction,
  {
    attempts,
    sourceId,
    runId,
    observedAt,
  }: PersistRejectedSoftLawListingsOptions,
) => {
  // audit: skip - public source listing evidence is ingestion bookkeeping
  // A rejected body is still evidence that its current locator was listed.
  const rejectedUrls = attempts
    .filter((attempt) => attempt.status === "rejected")
    .map((attempt) => attempt.entry.url);
  if (rejectedUrls.length) {
    await tx
      .update(softLawDocuments)
      .set({
        listingState: "listed",
        lastSeenAt: observedAt,
        lastSeenRun: runId,
      })
      .where(
        and(
          eq(softLawDocuments.sourceId, sourceId),
          inArray(
            softLawDocuments.id,
            tx
              .select({ id: softLawDocumentLocators.documentId })
              .from(softLawDocumentLocators)
              .where(
                and(
                  eq(softLawDocumentLocators.sourceId, sourceId),
                  eq(softLawDocumentLocators.state, "current"),
                  inArray(softLawDocumentLocators.url, rejectedUrls),
                ),
              ),
          ),
        ),
      );
    await tx
      .update(softLawDocumentLocators)
      .set({ lastSeenAt: observedAt, lastSeenRun: runId })
      .where(
        and(
          eq(softLawDocumentLocators.sourceId, sourceId),
          eq(softLawDocumentLocators.state, "current"),
          inArray(softLawDocumentLocators.url, rejectedUrls),
        ),
      );
  }
};
type ReadSoftLawListingCountsOptions = {
  sourceId: SafeId<"softLawSource">;
  runId: string;
};
const readSoftLawListingCounts = async (
  tx: Transaction,
  { sourceId, runId }: ReadSoftLawListingCountsOptions,
) => {
  const source =
    (
      await tx
        .select({
          baseline: softLawSources.listingBaseline,
          listingSeen: softLawSources.listingSeen,
        })
        .from(softLawSources)
        .where(eq(softLawSources.id, sourceId))
        .limit(1)
    ).at(0) ?? panic("Source vanished");
  const totals = (
    await tx
      .select({
        count: sql<number>`count(*)::integer`,
        retryable: sql<number>`count(*) FILTER (WHERE status = 'retryable')::integer`,
      })
      .from(softLawIngestionAttempts)
      .where(
        and(
          eq(softLawIngestionAttempts.sourceId, sourceId),
          eq(softLawIngestionAttempts.runId, runId),
        ),
      )
  ).at(0);
  return {
    baseline: source.baseline,
    listingSeen: source.listingSeen,
    seen: totals?.count ?? 0,
    retryable: totals?.retryable ?? 0,
  };
};
const persistSoftLawPage = async (
  { sourceId, scopedDb, adapter, leaseToken, ownsLease }: SoftLawStoreContext,
  {
    observations,
    attempts,
    expectedCursor,
    nextCursor,
    runId,
    expectedTotal,
    pendingRetries,
  }: PersistSoftLawPageOptions,
): Promise<Result<SoftLawPageResult, SoftLawIngestionError>> => {
  let result: Result<SoftLawPageResult, SoftLawIngestionError> = Result.ok({
    status: "persisted",
  });
  await commitReplaySafeIngestionBatch({
    items: observations,
    checkpoint: nextCursor,
    runInTransaction: scopedDb,
    persistItems: async (tx, items) => {
      // audit: skip - public ingestion outcomes persist in the attempt ledger
      const locked = (
        await tx
          .select({ id: softLawSources.id, now: sql<Date>`now()` })
          .from(softLawSources)
          .where(
            and(
              ownsLease,
              eq(softLawSources.runId, runId),
              sql`${softLawSources.syncCursor} IS NOT DISTINCT FROM ${expectedCursor}`,
            ),
          )
          .for("update")
          .limit(1)
      ).at(0);
      if (!locked) {
        result = Result.err(
          new SoftLawIngestionError({
            message: "Ingestion lease was superseded",
          }),
        );
        return;
      }
      const observedAt = locked.now;
      await persistSoftLawRows(tx, {
        items,
        sourceId,
        adapter,
        runId,
        observedAt,
      });
      await persistSoftLawVersions(tx, { items, observedAt });
      await persistRejectedSoftLawListings(tx, {
        attempts,
        sourceId,
        runId,
        observedAt,
      });
      if (attempts.length) {
        await tx
          .insert(softLawIngestionAttempts)
          .values(
            attempts.map((attempt) => {
              const { sourceRaw: _sourceRaw, ...entryWithoutRaw } =
                attempt.entry;
              return {
                sourceId,
                runId,
                url: attempt.entry.url,
                entry:
                  attempt.status === "applied" || attempt.status === "unchanged"
                    ? entryWithoutRaw
                    : attempt.entry,
                rawObjects: attempt.rawObjects,
                status: attempt.status,
                tag: attempt.tag,
                identityKey:
                  attempt.tag === "identity_collision"
                    ? attempt.identityKey
                    : null,
                count: attempt.count,
                observedAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: [
              softLawIngestionAttempts.sourceId,
              softLawIngestionAttempts.runId,
              softLawIngestionAttempts.url,
            ],
            set: {
              status: sql`excluded.status`,
              entry: sql`excluded.entry`,
              rawObjects: sql`excluded.raw_objects`,
              tag: sql`excluded.tag`,
              identityKey: sql`excluded.identity_key`,
              count: sql`excluded.count`,
              observedAt: sql`excluded.observed_at`,
            },
          });
      }
    },
    persistCheckpoint: async (tx, checkpointCursor) => {
      // audit: skip - public corpus listing reconciliation and run lifecycle bookkeeping
      if (Result.isError(result) || pendingRetries) {
        return;
      }
      if (checkpointCursor === null) {
        const { baseline, listingSeen, seen, retryable } =
          await readSoftLawListingCounts(tx, { sourceId, runId });
        if (
          retryable ||
          listingSeen !== null ||
          seen < Math.ceil(baseline * MINIMUM_LISTING_FRACTION) ||
          (expectedTotal !== null && seen < expectedTotal)
        ) {
          const checkpoint = await advanceCorpusIngestionCheckpoint({
            scopedDb: async (fn) => await fn(tx),
            source: {
              type: CORPUS_SOURCE_TYPE.SOFT_LAW,
              id: sourceId,
              leaseToken,
            },
            expectedCursor,
            nextCursor: null,
          });
          if (checkpoint.status !== INGESTION_CHECKPOINT_STATUS.ADVANCED) {
            panic("Locked source checkpoint changed inside its transaction");
          }
          await tx
            .update(softLawSources)
            .set({
              runState: "listing_incomplete",
              failureTag: "listing_incomplete",
              listingSeen: seen,
              listingExpectedTotal: expectedTotal,
              leaseToken: null,
              leaseExpiresAt: null,
            })
            .where(ownsLease);
          result = Result.ok({
            status: "listing_incomplete",
            seen,
            baseline,
            expectedTotal,
          });
          return;
        }
      }
      const checkpointResult = await advanceCorpusIngestionCheckpoint({
        scopedDb: async (fn) => await fn(tx),
        source: { type: CORPUS_SOURCE_TYPE.SOFT_LAW, id: sourceId, leaseToken },
        expectedCursor,
        nextCursor: checkpointCursor,
      });
      if (checkpointResult.status !== INGESTION_CHECKPOINT_STATUS.ADVANCED) {
        panic("Locked source checkpoint changed inside its transaction");
      }
      if (checkpointCursor !== null) {
        return;
      }
      await tx
        .update(softLawDocuments)
        .set({ listingState: "no_longer_listed" })
        .where(
          and(
            eq(softLawDocuments.sourceId, sourceId),
            sql`${softLawDocuments.lastSeenRun} <> ${runId}`,
          ),
        );
      await tx
        .update(softLawDocumentLocators)
        .set({ state: "historical" })
        .where(
          and(
            eq(softLawDocumentLocators.sourceId, sourceId),
            sql`${softLawDocumentLocators.lastSeenRun} <> ${runId}`,
          ),
        );
      await tx
        .update(softLawSources)
        .set({
          runState: "idle",
          runId: null,
          runStartedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          listingBaseline: 0,
          listingSeen: null,
          listingExpectedTotal: null,
        })
        .where(ownsLease);
    },
  });
  return result;
};
type SoftLawSettlement =
  | { status: "paused"; reason?: "deferred_window" }
  | { status: "failed"; reason: "ingestion_failed" | "listing_incomplete" }
  | { status: "blocked"; reason: "forbidden" | "rate_limited" | "challenge" };
const settleSoftLawSource = async (
  { scopedDb, ownsLease, sourceId, leaseToken }: SoftLawStoreContext,
  state: SoftLawSettlement,
) =>
  await scopedDb(async (tx) => {
    // audit: skip - public ingestion lease and failure lifecycle bookkeeping
    switch (state.status) {
      case "paused":
        await tx
          .update(softLawSources)
          .set({
            leaseToken: null,
            leaseExpiresAt: null,
            failureTag: state.reason ?? null,
          })
          .where(ownsLease);
        return;
      case "failed":
        await tx
          .update(softLawSources)
          .set({
            runState: "failed",
            failureTag: state.reason,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(ownsLease);
        return;
      case "blocked":
        // Publisher refusal is source-wide evidence, including a response received after takeover.
        await tx
          .update(softLawSources)
          .set({
            runState: "blocked",
            runId: sql`coalesce(${softLawSources.runId}, ${leaseToken}::uuid)`,
            runStartedAt: sql`coalesce(${softLawSources.runStartedAt}, now())`,
            failureTag: state.reason,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(softLawSources.id, sourceId));
        return;
      default:
        state satisfies never;
        panic("Unknown ingestion settlement");
    }
  });
const storeResult = async <Value>(
  work: () => Promise<Result<Value, SoftLawIngestionError>>,
) => {
  const attempted = await Result.tryPromise({
    try: work,
    catch: (cause) =>
      new SoftLawIngestionError({
        message: "Guidance persistence failed",
        cause,
      }),
  });
  return attempted.andThen((result) => result);
};
/** A per-source capability; every write is fenced by this run's lease. */
export const createSoftLawIngestionStore = (
  options: SoftLawIngestionStoreOptions,
) => {
  const leaseToken = createSafeId<"softLawIngestionLease">();
  const ownsLease = and(
    eq(softLawSources.id, options.sourceId),
    eq(softLawSources.leaseToken, leaseToken),
    sql`${softLawSources.leaseExpiresAt} > now()`,
  );
  const context = { ...options, leaseToken, ownsLease };
  return {
    claim: async () =>
      await storeResult(async () => await claimSoftLawSource(context)),
    renew: async () =>
      await storeResult(async () => await renewSoftLawLease(context)),
    loadAttempts: async (query: {
      runId: string;
      entries: readonly SoftLawDiscoveryEntry[];
    }) => await loadSoftLawAttempts(context, query),
    loadMatches: async (query: LoadSoftLawMatchesOptions) =>
      await loadSoftLawMatches(context, query),
    loadCollisions: async (query: LoadSoftLawCollisionsOptions) =>
      await loadSoftLawCollisions(context, query),
    persistPage: async (page: PersistSoftLawPageOptions) =>
      await storeResult(async () => await persistSoftLawPage(context, page)),
    settle: async (state: SoftLawSettlement) =>
      await settleSoftLawSource(context, state),
  };
};
