import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  organization,
  organizationSettings,
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsScreeningEvents,
  sanctionsEditions,
  sanctionsSources,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { commitSanctionsMonitoringBatch } from "@/api/lib/lists/sanctions/monitoring-diff";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TIMEOUT = 120_000;
const now = new Date("2026-09-29T12:00:00Z");
const orgId = toSafeId<"organization">("monitoring-org");
const otherOrg = toSafeId<"organization">("monitoring-other");
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
const indexCache = createSanctionsIndexCache();

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (run) =>
    await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));
  // Derive trigger installation from the production migration itself.
  const migration = readFileSync(
    new URL(
      "../../../../drizzle/20261003122000_sanctions_monitoring/migration.sql",
      import.meta.url,
    ),
    "utf-8",
  );
  const triggers = migration.slice(
    migration.indexOf("CREATE FUNCTION mark_sanctions_contact"),
  );
  for (const statement of triggers.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      await client.exec(statement);
    }
  }
  for (const tableName of [
    "sanctions_contact_marks",
    "sanctions_organization_marks",
    "sanctions_contact_matches",
    "sanctions_contact_screenings",
    "sanctions_screening_events",
  ]) {
    await client.exec(
      `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;`,
    );
  }
  await db.insert(organization).values([
    {
      id: orgId,
      name: "Monitoring test",
      slug: "monitoring-test",
      createdAt: now,
    },
    {
      id: otherOrg,
      name: "Other test",
      slug: "monitoring-other",
      createdAt: now,
    },
  ]);
  await db
    .insert(sanctionsSources)
    .values({ id: "eu", issuer: "EU", markerUrl: "https://example.test/list" });
}, TIMEOUT);

afterAll(async () => {
  await client.close();
});

const failureMessages = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return `${error.message} ${"cause" in error ? failureMessages(error.cause) : ""}`;
};

const expectFailure = async (
  operation: () => Promise<unknown>,
  message: string,
) => {
  const result = await Result.tryPromise(operation);
  if (result.isOk()) {
    panic("Expected synthetic operation to fail");
  }
  expect(failureMessages(result.error)).toContain(message);
};

const addContact = async (organizationId = orgId) => {
  const row = (
    await db
      .insert(contacts)
      .values({
        organizationId,
        type: "person",
        displayName: "Synthetic Person",
        dateOfBirthYear: 1980,
        nationalityCodes: ["CZ"],
      })
      .returning()
  ).at(0);
  return row ?? panic("Test contact missing");
};

const activate = async (hash: string, entries = 1) => {
  const editionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
  const payload: SanctionsEntry = {
    source: "eu",
    issuer: SANCTIONS_SOURCES.eu.issuer,
    sourceId: "one",
    referenceNumber: null,
    entityType: "person",
    names: [{ name: "Synthetic Person", quality: "strong" }],
    birthDates: [],
    nationalities: [],
    identifiers: [],
    addresses: [],
    programme: hash,
    legalBasis: null,
    listedOn: null,
    sourceUrl: "https://example.test/one",
  };
  await db.insert(sanctionsEditions).values({
    id: editionId,
    sourceId: "eu",
    markerKey: createHash("sha256").update(editionId).digest("hex"),
    contentHash: hash.repeat(64),
    publishedAt: "2026-09-29",
    state: "ready",
    entryCount: entries,
  });
  if (entries > 0) {
    await db
      .insert(sanctionsEntryPayloads)
      .values({ contentHash: hash.repeat(64), payload })
      .onConflictDoNothing();
    await db.insert(sanctionsEditionEntries).values({
      editionId,
      sourceEntryId: "one",
      contentHash: hash.repeat(64),
    });
  }
  await db
    .update(sanctionsSources)
    .set({ activeEditionId: editionId, lastSuccessfulVerifiedAt: now })
    .where(eq(sanctionsSources.id, "eu"));
  return editionId;
};

const prepare = async (contact: typeof contacts.$inferSelect) => {
  const screened = await screenSanctionsSubject({
    db: scopedDb,
    subject: monitoringSubject(contact),
    practiceJurisdictions: [],
    now,
    indexCache,
    resultMode: "complete",
  });
  if (screened.isErr()) {
    panic("Synthetic subject rejected");
  }
  const outcome =
    screened.value.lists.find((list) => list.source === "eu") ??
    panic("EU outcome missing");
  return {
    contactId: contact.id,
    contactFingerprint: monitoringFingerprint(contact),
    outcome,
  };
};

const commit = async (
  result: Awaited<ReturnType<typeof prepare>>,
  organizationId = orgId,
) =>
  await commitSanctionsMonitoringBatch({
    db: scopedDb,
    organizationId,
    source: "eu",
    results: [result],
    now,
  });

const eventsFor = async (contactId: typeof contacts.$inferSelect.id) =>
  await db
    .select()
    .from(sanctionsScreeningEvents)
    .where(eq(sanctionsScreeningEvents.contactId, contactId));

const matchFor = async (contactId: typeof contacts.$inferSelect.id) =>
  (
    await db
      .select()
      .from(sanctionsContactMatches)
      .where(eq(sanctionsContactMatches.contactId, contactId))
  ).at(0) ?? panic("Expected current match");

test(
  "full-edition diff converges across replay, unchanged review, changed entries, lapse and reopen",
  async () => {
    const contact = await addContact();
    const firstEdition = await activate("a");
    const initial = await prepare(contact);
    expect(initial.outcome.status).toBe("possible-match");
    expect(await commit(initial)).toEqual([contact.id]);
    await commit(initial);
    expect((await eventsFor(contact.id)).map(({ type }) => type)).toEqual([
      "new",
    ]);
    await db
      .update(sanctionsContactMatches)
      .set({ disposition: "dismissed", reviewReason: "Reviewed" })
      .where(eq(sanctionsContactMatches.contactId, contact.id));
    const sameEdition = await activate("a");
    await commit(await prepare(contact));
    expect((await matchFor(contact.id)).disposition).toBe("dismissed");
    expect((await matchFor(contact.id)).editionId).toBe(sameEdition);
    expect(await eventsFor(contact.id)).toHaveLength(1);
    await activate("b");
    const edited = await prepare(contact);
    await commit(edited);
    await commit(edited);
    expect((await matchFor(contact.id)).disposition).toBe("needs-review");
    expect((await eventsFor(contact.id)).map(({ type }) => type)).toEqual([
      "new",
      "reopened",
    ]);
    const emptyEdition = await activate("c", 0);
    const empty = await prepare(contact);
    await commit(empty);
    await commit(empty);
    const lapsed = (await eventsFor(contact.id)).find(
      ({ type }) => type === "lapsed",
    );
    expect(lapsed?.newEditionId).toBe(emptyEdition);
    expect(lapsed?.oldEditionId).not.toBe(firstEdition);
    expect((await matchFor(contact.id)).state).toBe("lapsed");
    await activate("b");
    await commit(await prepare(contact));
    expect((await eventsFor(contact.id)).map(({ type }) => type)).toEqual([
      "new",
      "reopened",
      "lapsed",
      "reopened",
    ]);
    expect(
      (
        await db
          .select()
          .from(sanctionsContactScreenings)
          .where(eq(sanctionsContactScreenings.contactId, contact.id))
      ).at(0)?.editionId,
    ).toBe((await matchFor(contact.id)).editionId);
  },
  TIMEOUT,
);

test(
  "changed contact fingerprints reopen dismissed hits and reject old work",
  async () => {
    await activate("d");
    const contact = await addContact();
    const oldWork = await prepare(contact);
    await commit(oldWork);
    await db
      .update(sanctionsContactMatches)
      .set({ disposition: "dismissed" })
      .where(eq(sanctionsContactMatches.contactId, contact.id));
    const edited =
      (
        await db
          .update(contacts)
          .set({ dateOfBirthYear: 1981 })
          .where(eq(contacts.id, contact.id))
          .returning()
      ).at(0) ?? panic("Edited contact missing");
    expect(await commit(oldWork)).toEqual([]);
    expect((await matchFor(contact.id)).disposition).toBe("dismissed");
    await commit(await prepare(edited));
    expect((await matchFor(contact.id)).disposition).toBe("needs-review");
    expect((await eventsFor(contact.id)).map(({ type }) => type)).toEqual([
      "new",
      "reopened",
    ]);
  },
  TIMEOUT,
);

test(
  "stale sources, superseded editions and opt-outs retain coverage and matches",
  async () => {
    await activate("e");
    const contact = await addContact();
    const work = await prepare(contact);
    await commit(work);
    const initial = await matchFor(contact.id);
    await db
      .update(sanctionsSources)
      .set({
        lastSuccessfulVerifiedAt: new Date(now.getTime() - 72 * 3_600_000),
      })
      .where(eq(sanctionsSources.id, "eu"));
    expect(await commit(work)).toEqual([]);
    expect(await matchFor(contact.id)).toEqual(initial);
    await activate("f");
    expect(await commit(work)).toEqual([]);
    const fresh = await prepare(contact);
    await db
      .update(contacts)
      .set({ sanctionsMonitoringMode: "excluded" })
      .where(eq(contacts.id, contact.id));
    expect(await commit(fresh)).toEqual([]);
    await db
      .update(contacts)
      .set({ sanctionsMonitoringMode: "included" })
      .where(eq(contacts.id, contact.id));
    await db
      .insert(organizationSettings)
      .values({ organizationId: orgId, sanctionsMonitoringMode: "disabled" });
    expect(await commit(fresh)).toEqual([]);
    expect(await eventsFor(contact.id)).toHaveLength(1);
    await db
      .update(organizationSettings)
      .set({ sanctionsMonitoringMode: "enabled" })
      .where(eq(organizationSettings.organizationId, orgId));
    expect(
      await db
        .select()
        .from(sanctionsOrganizationMarks)
        .where(eq(sanctionsOrganizationMarks.organizationId, orgId)),
    ).toHaveLength(1);
    expect(await commit(fresh)).toEqual([contact.id]);
  },
  TIMEOUT,
);

test(
  "transactional marks cover rollback, bulk imports and opt-out edits",
  async () => {
    const contact = await addContact();
    const generation = (
      await db
        .select()
        .from(sanctionsContactMarks)
        .where(eq(sanctionsContactMarks.contactId, contact.id))
    ).at(0)?.generation;
    expect(generation).toBe(1n);
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(contacts)
          .set({ sanctionsMonitoringMode: "excluded" })
          .where(eq(contacts.id, contact.id));
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(
      (
        await db
          .select()
          .from(sanctionsContactMarks)
          .where(eq(sanctionsContactMarks.contactId, contact.id))
      ).at(0)?.generation,
    ).toBe(generation);
    await db
      .update(contacts)
      .set({ sanctionsMonitoringMode: "excluded" })
      .where(eq(contacts.id, contact.id));
    expect(
      (
        await db
          .select()
          .from(sanctionsContactMarks)
          .where(eq(sanctionsContactMarks.contactId, contact.id))
      ).at(0)?.generation,
    ).toBe(2n);
    const batch = await db
      .insert(contacts)
      .values(
        Array.from({ length: 3 }, () => ({
          organizationId: orgId,
          type: "person" as const,
          displayName: "Import synthetic",
        })),
      )
      .returning();
    for (const row of batch) {
      expect(
        (
          await db
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, row.id))
        ).at(0)?.generation,
      ).toBe(1n);
    }
  },
  TIMEOUT,
);

test(
  "tenant predicates and RLS prevent cross-organization state access",
  async () => {
    await activate("9");
    const contact = await addContact(otherOrg);
    const result = await prepare(contact);
    expect(await commit(result, orgId)).toEqual([]);
    await commit(result, otherOrg);
    await scopedDb(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      await tx.execute(
        sql`SELECT set_config('app.organization_id', ${orgId}, true)`,
      );
      expect(
        await tx
          .select()
          .from(sanctionsContactMatches)
          .where(eq(sanctionsContactMatches.contactId, contact.id)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(sanctionsScreeningEvents)
          .where(eq(sanctionsScreeningEvents.contactId, contact.id)),
      ).toEqual([]);
    });
    await expectFailure(
      async () =>
        await scopedDb(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella`);
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${orgId}, true)`,
          );
          await tx.insert(sanctionsContactScreenings).values({
            organizationId: orgId,
            contactId: contact.id,
            sourceId: "eu",
            editionId: toSafeId<"sanctionsEdition">(
              result.outcome.editionId ?? panic("Edition missing"),
            ),
            contactFingerprint: result.contactFingerprint,
            checkedAt: now,
          });
        }),
      "foreign key",
    );
  },
  TIMEOUT,
);

test(
  "checkpoint failure rolls back match and event persistence",
  async () => {
    await activate("8");
    const contact = await addContact();
    const result = await prepare(contact);
    await client.exec(
      `CREATE FUNCTION reject_synthetic_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic coverage failure'; END $$; CREATE TRIGGER synthetic_coverage_failure BEFORE INSERT ON sanctions_contact_screenings FOR EACH ROW EXECUTE FUNCTION reject_synthetic_coverage();`,
    );
    await expectFailure(
      async () => await commit(result),
      "synthetic coverage failure",
    );
    expect(await eventsFor(contact.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(sanctionsContactMatches)
        .where(eq(sanctionsContactMatches.contactId, contact.id)),
    ).toEqual([]);
    await client.exec(
      "DROP TRIGGER synthetic_coverage_failure ON sanctions_contact_screenings; DROP FUNCTION reject_synthetic_coverage();",
    );
    await commit(result);
    expect(await eventsFor(contact.id)).toHaveLength(1);
  },
  TIMEOUT,
);
