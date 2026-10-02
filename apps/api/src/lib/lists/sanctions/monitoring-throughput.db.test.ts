import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";

import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  sanctionsSources,
  sanctionsEditions,
  sanctionsEntryPayloads,
  sanctionsEditionEntries,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  commitSanctionsMonitoringBatch,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const CONTACT_COUNT = 10_000;
const ENTRY_COUNT = 20_000;
const SEED_BATCH_SIZE = 1000;
const syntheticName = (index: number) =>
  createHash("sha256")
    .update(`synthetic-person-${index}`)
    .digest("hex")
    .slice(0, 32)
    .replaceAll(/[0-9a-f]/gu, (hex) =>
      String.fromCodePoint(97 + Number.parseInt(hex, 16)),
    )
    .replace(/^(.{16})/u, "$1 ");

test("measure full-index screening and scoped commit throughput for 10000 contacts and 20000 entries", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const orgId = toSafeId<"organization">("throughput-org");
  const editionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
  const now = new Date();
  await db.insert(organization).values({
    id: orgId,
    name: "Synthetic benchmark",
    slug: "synthetic-benchmark",
    createdAt: now,
  });
  await db
    .insert(sanctionsSources)
    .values({ id: "eu", issuer: "EU", markerUrl: "https://example.test/list" });
  await db.insert(sanctionsEditions).values({
    id: editionId,
    sourceId: "eu",
    markerKey: "3".repeat(64),
    contentHash: "4".repeat(64),
    publishedAt: "2026-09-30",
    state: "ready",
    entryCount: ENTRY_COUNT,
  });
  const payloads = Array.from({ length: ENTRY_COUNT }, (_, index) => {
    const payload = {
      source: "eu",
      issuer: "EU",
      sourceId: String(index),
      referenceNumber: null,
      entityType: "person",
      names: [{ name: syntheticName(index), quality: "strong" }],
      birthDates: [],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://example.test/entry",
    } satisfies SanctionsEntry;
    return {
      contentHash: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      payload,
    };
  });
  const seedAt = async (offset: number): Promise<void> => {
    const batch = payloads.slice(offset, offset + SEED_BATCH_SIZE);
    if (batch.length === 0) {
      return;
    }
    await db.insert(sanctionsEntryPayloads).values(batch);
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
          { length: Math.min(SEED_BATCH_SIZE, CONTACT_COUNT - offset) },
          (_, index) => ({
            organizationId: orgId,
            type: "person" as const,
            displayName: syntheticName(offset + index),
          }),
        ),
      );
    }
    await seedAt(offset + SEED_BATCH_SIZE);
  };
  await seedAt(0);
  await db
    .update(sanctionsSources)
    .set({ activeEditionId: editionId, lastSuccessfulVerifiedAt: now })
    .where(eq(sanctionsSources.id, "eu"));
  await client.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON contacts, organization_settings, sanctions_contact_matches, sanctions_contact_screenings, sanctions_screening_events TO stella;
    REVOKE ALL ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads FROM stella;
    GRANT SELECT ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads TO stella;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY; ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
    ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_contact_matches ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_matches FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_contact_screenings ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_screenings FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_screening_events ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_screening_events FORCE ROW LEVEL SECURITY;
  `);
  const scopedDb: ScopedDb = async (run) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      await tx.execute(
        sql`SELECT set_config('app.organization_id', ${orgId}, true)`,
      );
      return await run(asTestRaw<Transaction>(tx));
    });
  const contactRows = await scopedDb(
    async (tx) =>
      await tx
        .select()
        .from(contacts)
        .where(eq(contacts.organizationId, orgId))
        .orderBy(contacts.id)
        .limit(CONTACT_COUNT),
  );
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-09-30", fileId: null },
      entries: payloads.map(({ payload }) => payload),
    },
  ]);
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
  // Warm the shared service's edition index; report steady-state batch cost separately from construction.
  await prepareMonitoringContacts({
    db: scopedDb,
    contactRows: contactRows.slice(0, 1),
    now,
  });
  const combinedStarted = performance.now();
  const commitAt = async (offset: number): Promise<void> => {
    const batch = contactRows.slice(
      offset,
      offset + SANCTIONS_MONITORING_BATCH_SIZE,
    );
    if (batch.length === 0) {
      return;
    }
    const prepared = await prepareMonitoringContacts({
      db: scopedDb,
      contactRows: batch,
      now,
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
      organizationId: orgId,
      source: "eu",
      results,
      now,
    });
    expect(terminal).toHaveLength(batch.length);
    await commitAt(offset + SANCTIONS_MONITORING_BATCH_SIZE);
  };
  await commitAt(0);
  const combinedMs = performance.now() - combinedStarted;
  console.log(
    JSON.stringify({
      benchmark: "sanctions-monitoring",
      database: "pglite",
      contacts: CONTACT_COUNT,
      entries: ENTRY_COUNT,
      hits,
      screeningContactsPerSecond: (CONTACT_COUNT * 1000) / screeningMs,
      screeningAndCommitContactsPerSecond: (CONTACT_COUNT * 1000) / combinedMs,
      screeningMs,
      combinedMs,
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
  await client.close();
}, 300_000);
