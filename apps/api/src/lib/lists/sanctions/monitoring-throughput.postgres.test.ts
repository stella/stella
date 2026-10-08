import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "@stll/sanctions";
import type { ScreeningIndex } from "@stll/sanctions";
import {
  syntheticMonitoringEntry,
  syntheticMonitoringName,
  MONITORING_CONTACT_COUNT,
  MONITORING_ENTRY_COUNT,
} from "@stll/sanctions/test-fixtures/monitoring-corpus";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { organization } from "@/api/db/auth-schema";
import {
  contacts,
  sanctionsSources,
  sanctionsEditions,
  sanctionsEntryPayloads,
  sanctionsEditionEntries,
  sanctionsEditionFanouts,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  commitSanctionsMonitoringBatch,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { createRootOrganizationBackgroundDb } from "@/api/lib/root-scoped-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const SEED_BATCH_SIZE = 100;
const BENCHMARK_PROFILES = [
  {
    name: "sanctions monitoring correctness slice",
    contacts: 200,
    entries: 400,
  },
  {
    name: "sanctions monitoring full-volume",
    contacts: MONITORING_CONTACT_COUNT,
    entries: MONITORING_ENTRY_COUNT,
  },
] as const;
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgresTests) {
  describe.skip("sanctions monitoring throughput on PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("DATABASE_URL is required");
  for (const {
    name,
    contacts: CONTACT_COUNT,
    entries: ENTRY_COUNT,
  } of BENCHMARK_PROFILES) {
    test(
      name,
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const editionId = createSafeId<"sanctionsEdition">();
          const now = new Date();
          const sourceBefore =
            (
              await db
                .select()
                .from(sanctionsSources)
                .where(eq(sanctionsSources.id, "eu"))
            ).at(0) ?? panic("EU sanctions source is not seeded");
          const fanoutBefore = (
            await db
              .select()
              .from(sanctionsEditionFanouts)
              .where(eq(sanctionsEditionFanouts.sourceId, "eu"))
          ).at(0);
          await db.insert(organization).values({
            id: organizationId,
            name: "Synthetic benchmark",
            slug: `synthetic-benchmark-${organizationId}`,
            createdAt: now,
          });
          try {
            await db.insert(sanctionsEditions).values({
              id: editionId,
              sourceId: "eu",
              markerKey: hashSha256Hex(editionId),
              contentHash: hashSha256Hex(`content-${editionId}`),
              publishedAt: "2026-09-30",
              state: "ready",
              entryCount: ENTRY_COUNT,
            });
            const seedAt = async (offset: number): Promise<void> => {
              if (offset >= ENTRY_COUNT) {
                return;
              }
              const batch = Array.from(
                { length: Math.min(SEED_BATCH_SIZE, ENTRY_COUNT - offset) },
                (_, batchIndex) => {
                  const index = offset + batchIndex;
                  const payload = syntheticMonitoringEntry(index);
                  return {
                    contentHash: hashSha256Hex(JSON.stringify(payload)),
                    payload,
                  };
                },
              );
              await db
                .insert(sanctionsEntryPayloads)
                .values(batch)
                .onConflictDoNothing();
              await db.insert(sanctionsEditionEntries).values(
                batch.map(({ contentHash, payload }) => ({
                  editionId,
                  sourceEntryId: payload.sourceId,
                  contentHash,
                })),
              );
              if (offset < CONTACT_COUNT) {
                await db.insert(contacts).values(
                  Array.from(
                    {
                      length: Math.min(SEED_BATCH_SIZE, CONTACT_COUNT - offset),
                    },
                    (_, index) => ({
                      organizationId,
                      type: "person" as const,
                      displayName: syntheticMonitoringName(offset + index),
                    }),
                  ),
                );
              }
            };
            for (
              let offset = 0;
              offset < ENTRY_COUNT;
              offset += SEED_BATCH_SIZE
            ) {
              // db-await-in-loop: bounded fixture batches must finish and release their buffers before allocating the next batch
              await seedAt(offset);
            }
            await db
              .update(sanctionsSources)
              .set({
                activeEditionId: editionId,
                lastSuccessfulVerifiedAt: now,
              })
              .where(eq(sanctionsSources.id, "eu"));

            const scopedDb = createRootOrganizationBackgroundDb(
              organizationId,
              markRlsDatabase(db),
            );
            const contactRows = await scopedDb(
              async (tx) =>
                await tx
                  .select()
                  .from(contacts)
                  .where(eq(contacts.organizationId, organizationId))
                  .orderBy(contacts.id)
                  .limit(CONTACT_COUNT),
            );
            const captured: { index: ScreeningIndex | null } = { index: null };
            const indexCache = createSanctionsIndexCache({
              build: (lists) => {
                expect(lists).toHaveLength(1);
                expect(lists.at(0)?.entries).toHaveLength(ENTRY_COUNT);
                const index = buildScreeningIndex(lists);
                captured.index = index;
                return index;
              },
            });
            await prepareMonitoringContacts({
              db: scopedDb,
              contactRows: contactRows.slice(0, 1),
              now,
              indexCache,
            });
            const index = captured.index ?? panic("Benchmark index missing");
            const screenStarted = performance.now();
            let hits = 0;
            for (const contact of contactRows) {
              const result = screen(
                index,
                { name: contact.displayName, entityType: "person" },
                { cutoff: DEFAULT_CUTOFF, limit: ENTRY_COUNT },
              );
              if (result.isErr()) {
                panic("Synthetic benchmark subject rejected");
              }
              hits += result.value.totalMatches;
            }
            const screeningMs = performance.now() - screenStarted;
            const combinedStarted = performance.now();
            const itemBatches = chunkItems(
              contactRows,
              SANCTIONS_MONITORING_BATCH_SIZE,
            )[Symbol.iterator]();
            const commitAt = async (): Promise<void> => {
              const nextBatch = itemBatches.next();
              if (nextBatch.done) {
                return;
              }
              const batch = nextBatch.value;
              const prepared = await prepareMonitoringContacts({
                db: scopedDb,
                contactRows: batch,
                now,
                indexCache,
              });
              const results = prepared.map(
                ({ contactId, contactFingerprint, lists }) => ({
                  contactId,
                  contactFingerprint,
                  outcome:
                    lists.find(({ source }) => source === "eu") ??
                    panic("Benchmark outcome missing"),
                }),
              );
              const terminal = await commitSanctionsMonitoringBatch({
                db: scopedDb,
                organizationId,
                source: "eu",
                results,
                now,
              });
              expect(terminal).toHaveLength(batch.length);
            };
            for (
              let offset = 0;
              offset < CONTACT_COUNT;
              offset += SANCTIONS_MONITORING_BATCH_SIZE
            ) {
              // db-await-in-loop: sequential bounded pages measure scoped commit throughput without retaining previous page results
              await commitAt();
            }
            const combinedMs = performance.now() - combinedStarted;
            if (CONTACT_COUNT < MONITORING_CONTACT_COUNT) {
              expect(hits).toBe(CONTACT_COUNT);
              const totals =
                (
                  await scopedDb(
                    async (tx) =>
                      await tx.execute<{
                        matches: number;
                        screenings: number;
                        events: number;
                      }>(sql`
            SELECT
              (SELECT count(*)::integer FROM sanctions_contact_matches WHERE organization_id = ${organizationId}) AS matches,
              (SELECT count(*)::integer FROM sanctions_contact_screenings WHERE organization_id = ${organizationId}) AS screenings,
              (SELECT count(*)::integer FROM sanctions_screening_events WHERE organization_id = ${organizationId}) AS events
          `),
                  )
                ).at(0) ?? panic("Monitoring fixture totals missing");
              expect(totals).toEqual({
                matches: CONTACT_COUNT,
                screenings: CONTACT_COUNT,
                events: CONTACT_COUNT,
              });
            }
            console.log(
              JSON.stringify({
                benchmark: "sanctions-monitoring",
                database: "postgres",
                contacts: CONTACT_COUNT,
                entries: ENTRY_COUNT,
                hits,
                screeningContactsPerSecond:
                  (CONTACT_COUNT * 1000) / screeningMs,
                screeningAndCommitContactsPerSecond:
                  (CONTACT_COUNT * 1000) / combinedMs,
                screeningMs,
                combinedMs,
              }),
            );
          } finally {
            await db.transaction(async (tx) => {
              await tx
                .update(sanctionsSources)
                .set({
                  activeEditionId: sourceBefore.activeEditionId,
                  lastSuccessfulVerifiedAt:
                    sourceBefore.lastSuccessfulVerifiedAt,
                })
                .where(eq(sanctionsSources.id, "eu"));
              await tx
                .delete(contacts)
                .where(eq(contacts.organizationId, organizationId));
              await tx
                .delete(organization)
                .where(eq(organization.id, organizationId));
              await tx.execute(sql`
            CREATE TEMP TABLE monitoring_benchmark_payloads ON COMMIT DROP AS
            SELECT content_hash
            FROM sanctions_edition_entries
            WHERE edition_id = ${editionId}
          `);
              await tx
                .delete(sanctionsEditionEntries)
                .where(eq(sanctionsEditionEntries.editionId, editionId));
              await tx.execute(sql`
            DELETE FROM sanctions_entry_payloads AS payload
            WHERE payload.content_hash IN (
              SELECT content_hash FROM monitoring_benchmark_payloads
            )
            AND NOT EXISTS (
              SELECT 1
              FROM sanctions_edition_entries AS entry
              WHERE entry.content_hash = payload.content_hash
            )
          `);
              await tx
                .delete(sanctionsEditions)
                .where(eq(sanctionsEditions.id, editionId));
              if (fanoutBefore) {
                await tx
                  .insert(sanctionsEditionFanouts)
                  .values(fanoutBefore)
                  .onConflictDoUpdate({
                    target: sanctionsEditionFanouts.sourceId,
                    set: {
                      editionId: fanoutBefore.editionId,
                      cursorOrganizationId: fanoutBefore.cursorOrganizationId,
                      freshnessStatus: fanoutBefore.freshnessStatus,
                      status: fanoutBefore.status,
                    },
                  });
              } else {
                await tx
                  .delete(sanctionsEditionFanouts)
                  .where(eq(sanctionsEditionFanouts.sourceId, "eu"));
              }
            });
          }
        });
      },
      300_000,
    );
  }
}
