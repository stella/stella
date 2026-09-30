import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  organizationSettings,
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
  sanctionsContactScreenings,
  sanctionsSources,
  sanctionsEditions,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  drainSanctionsContactMarks,
  SANCTIONS_MARK_LEASE_MS,
} from "@/api/lib/lists/sanctions/monitoring-drain";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TIMEOUT = 120_000;
const orgId = toSafeId<"organization">("drain-org");
const otherOrg = toSafeId<"organization">("drain-other");
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const scopedFor =
  (organizationId: typeof orgId): ScopedDb =>
  async (run) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      await tx.execute(
        sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
      );
      return await run(asTestRaw<Transaction>(tx));
    });
const scopedDb = scopedFor(orgId);
const futureNow = () => new Date(Date.now() + 1000);

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  const migration = readFileSync(
    new URL(
      "../../../../drizzle/20261003122900_sanctions_monitoring_marks/migration.sql",
      import.meta.url,
    ),
    "utf-8",
  );
  const triggers = migration.slice(migration.indexOf("CREATE FUNCTION"));
  await client.exec(triggers.replaceAll("--> statement-breakpoint", "\n"));
  await client.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON contacts, organization_settings, sanctions_contact_marks, sanctions_organization_marks, sanctions_contact_matches, sanctions_contact_screenings, sanctions_screening_events TO stella;
    REVOKE ALL ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads FROM stella;
    GRANT SELECT ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads TO stella;
    ALTER TABLE sanctions_contact_marks ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_marks FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_organization_marks ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_organization_marks FORCE ROW LEVEL SECURITY;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY; ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
    ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_contact_matches ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_matches FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_contact_screenings ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_screenings FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_screening_events ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_screening_events FORCE ROW LEVEL SECURITY;
  `);
  await db.insert(organization).values(
    [orgId, otherOrg].map((id) => ({
      id,
      name: id,
      slug: id,
      createdAt: new Date(),
    })),
  );
  await db
    .insert(sanctionsSources)
    .values({ id: "eu", issuer: "EU", markerUrl: "https://example.test/list" });
  const editionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
  await db.insert(sanctionsEditions).values({
    id: editionId,
    sourceId: "eu",
    markerKey: "1".repeat(64),
    contentHash: "2".repeat(64),
    state: "ready",
    publishedAt: "2026-09-30",
    entryCount: 0,
  });
  await db
    .update(sanctionsSources)
    .set({ activeEditionId: editionId, lastSuccessfulVerifiedAt: new Date() })
    .where(eq(sanctionsSources.id, "eu"));
}, TIMEOUT);
afterAll(async () => {
  await client.close();
});

const addContact = async () =>
  await scopedDb(
    async (tx) =>
      (
        await tx
          .insert(contacts)
          .values({
            organizationId: orgId,
            type: "person",
            displayName: "Synthetic Person",
          })
          .returning()
      ).at(0) ?? panic("Contact missing"),
  );
const markFor = async (contactId: typeof contacts.$inferSelect.id) =>
  (
    await db
      .select()
      .from(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contactId))
  ).at(0);

test(
  "statement triggers batch relevant changes and preserve tenant isolation",
  async () => {
    const contact = await addContact();
    expect((await markFor(contact.id))?.generation).toBe(1n);
    await scopedDb(async (tx) => {
      await tx
        .update(contacts)
        .set({ notes: "Unrelated" })
        .where(eq(contacts.id, contact.id));
    });
    expect((await markFor(contact.id))?.generation).toBe(1n);
    await scopedDb(async (tx) => {
      await tx
        .update(contacts)
        .set({ dateOfBirthYear: 1980 })
        .where(eq(contacts.id, contact.id));
    });
    expect((await markFor(contact.id))?.generation).toBe(2n);
    const batch = await scopedDb(
      async (tx) =>
        await tx
          .insert(contacts)
          .values(
            Array.from({ length: 3 }, () => ({
              organizationId: orgId,
              type: "person" as const,
              displayName: "Import Person",
            })),
          )
          .returning(),
    );
    expect(
      await scopedDb(
        async (tx) => await tx.select().from(sanctionsContactMarks),
      ),
    ).toHaveLength(4);
    expect(batch).toHaveLength(3);
    expect(
      await scopedFor(otherOrg)(
        async (tx) => await tx.select().from(sanctionsContactMarks),
      ),
    ).toEqual([]);
    await scopedDb(async (tx) => {
      await tx.insert(organizationSettings).values({ organizationId: orgId });
    });
    expect(
      (await db.select().from(sanctionsOrganizationMarks)).at(0)?.generation,
    ).toBe(1n);
    await scopedDb(async (tx) => {
      await tx
        .update(organizationSettings)
        .set({ sanctionsMonitoringMode: "disabled" })
        .where(eq(organizationSettings.organizationId, orgId));
    });
    expect(
      (await db.select().from(sanctionsOrganizationMarks)).at(0)?.generation,
    ).toBe(2n);
    await scopedDb(async (tx) => {
      await tx
        .update(organizationSettings)
        .set({ sanctionsMonitoringMode: "enabled" })
        .where(eq(organizationSettings.organizationId, orgId));
    });
  },
  TIMEOUT,
);

test(
  "a crash retains leased work; replay drains all sources without losing a concurrent edit",
  async () => {
    const contact = await addContact();
    const controller = new AbortController();
    let calls = 0;
    const abortAfterClaim: ScopedDb = async (run) => {
      const value = await scopedDb(run);
      calls += 1;
      if (calls === 1) {
        controller.abort(new Error("synthetic drain crash"));
      }
      return value;
    };
    const now = futureNow();
    await expect(
      drainSanctionsContactMarks({
        db: abortAfterClaim,
        organizationId: orgId,
        now,
        signal: controller.signal,
      }),
    ).rejects.toThrow("synthetic drain crash");
    expect(await markFor(contact.id)).toBeDefined();
    await drainSanctionsContactMarks({
      db: scopedDb,
      organizationId: orgId,
      now: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 1),
      signal: new AbortController().signal,
    });
    expect(await markFor(contact.id)).toBeUndefined();
    const screenings = await scopedDb(
      async (tx) =>
        await tx
          .select()
          .from(sanctionsContactScreenings)
          .where(eq(sanctionsContactScreenings.contactId, contact.id)),
    );
    expect(screenings.some(({ status }) => status === "clear")).toBe(true);
    expect(screenings.some(({ status }) => status === "unavailable")).toBe(
      true,
    );
    await scopedDb(async (tx) => {
      await tx
        .update(contacts)
        .set({ displayName: "Edited Person" })
        .where(eq(contacts.id, contact.id));
    });
    let edited = false;
    const editAfterClaim: ScopedDb = async (run) => {
      const value = await scopedDb(run);
      if (!edited) {
        edited = true;
        await scopedDb(async (tx) => {
          await tx
            .update(contacts)
            .set({ displayName: "Later Person" })
            .where(eq(contacts.id, contact.id));
        });
      }
      return value;
    };
    await drainSanctionsContactMarks({
      db: editAfterClaim,
      organizationId: orgId,
      now: futureNow(),
      signal: new AbortController().signal,
    });
    expect(await markFor(contact.id)).toBeDefined();
    await drainSanctionsContactMarks({
      db: scopedDb,
      organizationId: orgId,
      now: futureNow(),
      signal: new AbortController().signal,
    });
    expect(await markFor(contact.id)).toBeUndefined();
  },
  TIMEOUT,
);
