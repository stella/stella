import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawSources,
  softLawDocuments,
  softLawDocumentVersions,
  softLawDocumentLocators,
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
  SoftLawIngestionError,
} from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawEntry,
  SoftLawDocumentInput,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";

const LEASE_SECONDS = 300;
export type SoftLawObservation = {
  entry: SoftLawEntry;
  input: SoftLawDocumentInput;
  existingId: SafeId<"softLawDocument"> | undefined;
  documentId: SafeId<"softLawDocument">;
  identityKey: string;
  contentHash: string;
  rawObjects: { role: string; key: string; contentType: string }[];
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
const claimSoftLawSource = async ({
  sourceId,
  scopedDb,
  adapter,
  leaseToken,
}: SoftLawStoreContext) =>
  await scopedDb(async (tx) => {
    const row = (
      await tx
        .select()
        .from(softLawSources)
        .where(eq(softLawSources.id, sourceId))
        .for("update")
        .limit(1)
    ).at(0);
    if (!row) {
      throw new SoftLawIngestionError({ message: "Source does not exist" });
    }
    if (row.adapterKey !== adapter.key) {
      throw new SoftLawIngestionError({
        message: "Source adapter does not match",
      });
    }
    if (row.runState === "blocked") {
      return {
        type: "blocked" as const,
        reason: row.failureTag ?? panic("Blocked source has no reason"),
      };
    }
    const claimed = (
      await tx
        .update(softLawSources)
        .set({
          runState: "running",
          runId: row.runId ?? Bun.randomUUIDv7(),
          runStartedAt: row.runStartedAt ?? new Date(),
          leaseToken,
          leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
          failureTag: null,
        })
        .where(
          and(
            eq(softLawSources.id, sourceId),
            sql`(${softLawSources.leaseExpiresAt} IS NULL OR ${softLawSources.leaseExpiresAt} <= now())`,
          ),
        )
        .returning()
    ).at(0);
    return claimed
      ? { type: "claimed" as const, row: claimed }
      : { type: "busy" as const };
  });
const renewSoftLawLease = async ({
  scopedDb,
  ownsLease,
}: SoftLawStoreContext) => {
  const renewed = await scopedDb(
    async (tx) =>
      await tx
        .update(softLawSources)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
        })
        .where(ownsLease)
        .returning({ id: softLawSources.id }),
  );
  if (!renewed.at(0)) {
    throw new SoftLawIngestionError({
      message: "Ingestion lease was superseded",
    });
  }
};
const findSoftLawDocument = async (
  { sourceId, scopedDb }: SoftLawStoreContext,
  { identityKey, url }: { identityKey: string; url: string },
) =>
  await scopedDb(async (tx) => {
    const projection = {
      id: softLawDocuments.id,
      statedReferenceState: softLawDocuments.statedReferenceState,
      statedReference: softLawDocuments.statedReference,
    };
    const byIdentity = await tx
      .select(projection)
      .from(softLawDocuments)
      .where(
        and(
          eq(softLawDocuments.sourceId, sourceId),
          eq(softLawDocuments.identityKey, identityKey),
        ),
      )
      .limit(1);
    const byLocator = await tx
      .select(projection)
      .from(softLawDocumentLocators)
      .innerJoin(
        softLawDocuments,
        eq(softLawDocumentLocators.documentId, softLawDocuments.id),
      )
      .where(
        and(
          eq(softLawDocuments.sourceId, sourceId),
          eq(softLawDocumentLocators.url, url),
        ),
      )
      .limit(2);
    return byIdentity.concat(byLocator);
  });
type PersistSoftLawPageOptions = {
  observations: readonly SoftLawObservation[];
  expectedCursor: string | null;
  nextCursor: string | null;
  runId: string;
  runStartedAt: Date;
};
const persistSoftLawPage = async (
  { sourceId, scopedDb, adapter, leaseToken, ownsLease }: SoftLawStoreContext,
  {
    observations,
    expectedCursor,
    nextCursor,
    runId,
    runStartedAt,
  }: PersistSoftLawPageOptions,
) =>
  await commitReplaySafeIngestionBatch({
    items: observations,
    checkpoint: nextCursor,
    runInTransaction: scopedDb,
    persistItems: async (tx, items) => {
      const locked = (
        await tx
          .select({ id: softLawSources.id })
          .from(softLawSources)
          .where(ownsLease)
          .for("update")
          .limit(1)
      ).at(0);
      if (!locked) {
        throw new SoftLawIngestionError({
          message: "Ingestion lease was superseded",
        });
      }
      for (const item of items) {
        const { metadata } = item.input;
        const fields = {
          title: metadata.title,
          kind: metadata.kind,
          statedReferenceState: metadata.statedReference.state,
          statedReference:
            metadata.statedReference.state === "stated"
              ? metadata.statedReference.value
              : null,
          issuedOnState: metadata.issuedOn.state,
          issuedOn:
            metadata.issuedOn.state === "stated"
              ? metadata.issuedOn.value
              : null,
          validityState: metadata.validity.state,
          validityBasis: metadata.validity.basis,
          listingState: "listed" as const,
          lastSeenAt: runStartedAt,
          lastSeenRun: runId,
        };
        const doc = item.existingId
          ? ((
              await tx
                .update(softLawDocuments)
                .set(fields)
                .where(eq(softLawDocuments.id, item.existingId))
                .returning({ id: softLawDocuments.id })
            ).at(0) ?? panic("Document update returned no row"))
          : ((
              await tx
                .insert(softLawDocuments)
                .values({
                  id: item.documentId,
                  sourceId,
                  identityKey: item.identityKey,
                  authority: adapter.authority,
                  jurisdiction:
                    SOFT_LAW_AUTHORITIES[adapter.authority].jurisdiction,
                  firstSeenAt: runStartedAt,
                  ...fields,
                })
                .onConflictDoUpdate({
                  target: [
                    softLawDocuments.sourceId,
                    softLawDocuments.identityKey,
                  ],
                  set: fields,
                })
                .returning({ id: softLawDocuments.id })
            ).at(0) ?? panic("Document upsert returned no row"));
        await tx
          .insert(softLawDocumentLocators)
          .values({
            documentId: doc.id,
            url: item.entry.url,
            firstSeenAt: runStartedAt,
            lastSeenAt: runStartedAt,
          })
          .onConflictDoUpdate({
            target: [
              softLawDocumentLocators.documentId,
              softLawDocumentLocators.url,
            ],
            set: { lastSeenAt: runStartedAt },
          });
        const latest = (
          await tx
            .select()
            .from(softLawDocumentVersions)
            .where(
              and(
                eq(softLawDocumentVersions.documentId, doc.id),
                sql`${softLawDocumentVersions.observedTo} IS NULL`,
              ),
            )
            .limit(1)
        ).at(0);
        if (latest?.contentHash === item.contentHash) {
          continue;
        }
        if (latest) {
          await tx
            .update(softLawDocumentVersions)
            .set({ observedTo: runStartedAt })
            .where(eq(softLawDocumentVersions.id, latest.id));
        }
        await tx.insert(softLawDocumentVersions).values({
          documentId: doc.id,
          sequence: (latest?.sequence ?? 0) + 1,
          contentHash: item.contentHash,
          metadata,
          rawObjects: item.rawObjects,
          extractedText: item.input.text,
          extractionQuality: item.input.extractionQuality,
          sourceDates: item.input.sourceDates,
          observedFrom: runStartedAt,
        });
      }
    },
    persistCheckpoint: async (tx, checkpointCursor) => {
      const result = await advanceCorpusIngestionCheckpoint({
        scopedDb: async (fn) => await fn(tx),
        source: { type: CORPUS_SOURCE_TYPE.SOFT_LAW, id: sourceId, leaseToken },
        expectedCursor,
        nextCursor: checkpointCursor,
      });
      if (result.status !== INGESTION_CHECKPOINT_STATUS.ADVANCED) {
        throw new SoftLawIngestionError({
          message: "Checkpoint was superseded",
        });
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
        .update(softLawSources)
        .set({
          runState: "idle",
          runId: null,
          runStartedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(ownsLease);
    },
  });
type SoftLawSettlement =
  | { status: "paused" }
  | { status: "failed" }
  | { status: "blocked"; reason: string };
const settleSoftLawSource = async (
  { scopedDb, ownsLease }: SoftLawStoreContext,
  state: SoftLawSettlement,
) =>
  await scopedDb(async (tx) => {
    switch (state.status) {
      case "paused":
        await tx
          .update(softLawSources)
          .set({ leaseToken: null, leaseExpiresAt: null })
          .where(ownsLease);
        return;
      case "failed":
        await tx
          .update(softLawSources)
          .set({
            runState: "failed",
            failureTag: "ingestion_failed",
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(ownsLease);
        return;
      case "blocked":
        await tx
          .update(softLawSources)
          .set({
            runState: "blocked",
            failureTag: state.reason,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(ownsLease);
        return;
      default:
        state satisfies never;
        return panic("Unknown ingestion settlement");
    }
  });
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
    claim: async () => await claimSoftLawSource(context),
    renew: async () => await renewSoftLawLease(context),
    findDocument: async (query: { identityKey: string; url: string }) =>
      await findSoftLawDocument(context, query),
    persistPage: async (page: PersistSoftLawPageOptions) =>
      await persistSoftLawPage(context, page),
    settle: async (state: SoftLawSettlement) =>
      await settleSoftLawSource(context, state),
  };
};
