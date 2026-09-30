import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";

import { organization, user } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsScreeningEvents,
  sanctionsEditions,
  sanctionsSources,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
} from "@/api/db/schema";
import type { AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { commitSanctionsMonitoringBatch } from "@/api/lib/lists/sanctions/monitoring-diff";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  excludeSanctionsContact,
  includeSanctionsContact,
  enableSanctionsMonitoring,
  disableSanctionsMonitoring,
} from "./monitoring-opt-out";
import {
  readContactSanctions,
  listOpenSanctionsMatches,
  listSanctionsMonitoringEvents,
} from "./monitoring-read";
import { reviewSanctionsMatch } from "./monitoring-review";
import { SANCTIONS_SOURCE_CONFIG, sanctionsSourceIds } from "./source-config";

const TIMEOUT = 120_000;
const now = new Date("2026-09-29T12:00:00Z");
const orgId = toSafeId<"organization">("monitoring-org");
const otherOrg = toSafeId<"organization">("monitoring-other");
const reviewerId = toSafeId<"user">("monitoring-reviewer");
let client: Awaited<ReturnType<typeof createTestPglite>>;
const openDb = (connection: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client: connection, relations: databaseRelations });
let db: ReturnType<typeof openDb>;
let scopedDb: ScopedDb;
const indexCache = createSanctionsIndexCache();

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

beforeAll(async () => {
  client = await createTestPglite();
  db = openDb(client);
  scopedDb = scopedFor(orgId);
  await client.exec(`
    REVOKE ALL ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads FROM stella;
    GRANT SELECT ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads TO stella;
    GRANT SELECT, INSERT, UPDATE ON sanctions_contact_marks, sanctions_organization_marks TO stella;
    GRANT SELECT, INSERT, UPDATE, DELETE ON contacts, organization_settings, sanctions_contact_matches, sanctions_contact_screenings, sanctions_screening_events TO stella;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY; ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
    ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE organization_settings FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_contact_matches ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_matches FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_contact_screenings ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_contact_screenings FORCE ROW LEVEL SECURITY;
    ALTER TABLE sanctions_screening_events ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_screening_events FORCE ROW LEVEL SECURITY;
  `);
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
  await db.insert(user).values({
    id: reviewerId,
    name: "Synthetic Reviewer",
    email: "reviewer@example.test",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sanctionsSources).values(
    sanctionsSourceIds().map((id) => ({
      id,
      issuer: SANCTIONS_SOURCES[id].issuer,
      markerUrl: "https://example.test/list",
    })),
  );
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
    db: scopedFor(organizationId),
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

const screeningFor = async (contactId: typeof contacts.$inferSelect.id) =>
  (
    await db
      .select()
      .from(sanctionsContactScreenings)
      .where(eq(sanctionsContactScreenings.contactId, contactId))
  ).at(0) ?? panic("Expected screening status");

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
  "stale sources and opt-outs persist explicit status without changing matches",
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
    expect(await commit(work)).toEqual([contact.id]);
    expect((await screeningFor(contact.id)).status).toBe("unavailable");
    expect((await screeningFor(contact.id)).reason).toBe("stale");
    expect(await matchFor(contact.id)).toEqual(initial);
    await activate("f");
    expect(await commit(work)).toEqual([]);
    const fresh = await prepare(contact);
    await db
      .update(contacts)
      .set({ sanctionsMonitoringMode: "excluded" })
      .where(eq(contacts.id, contact.id));
    expect(await commit(fresh)).toEqual([contact.id]);
    expect((await screeningFor(contact.id)).status).toBe("excluded");
    await db
      .update(contacts)
      .set({ sanctionsMonitoringMode: "included" })
      .where(eq(contacts.id, contact.id));
    await db
      .insert(organizationSettings)
      .values({ organizationId: orgId, sanctionsMonitoringMode: "disabled" });
    expect(await commit(fresh)).toEqual([contact.id]);
    expect((await screeningFor(contact.id)).status).toBe("excluded");
    expect(await eventsFor(contact.id)).toHaveLength(1);
    await db
      .update(organizationSettings)
      .set({ sanctionsMonitoringMode: "enabled" })
      .where(eq(organizationSettings.organizationId, orgId));
    expect(await commit(fresh)).toEqual([contact.id]);
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
            status: "possible-match",
            reason: null,
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

test(
  "bulk persistence converges and unknown nationalities retain name-only screening",
  async () => {
    await activate("7");
    const first = await addContact();
    const second = await addContact();
    const updated =
      (
        await db
          .update(contacts)
          .set({ nationalityCodes: ["ZZ"] })
          .where(eq(contacts.id, second.id))
          .returning()
      ).at(0) ?? panic("Contact missing");
    const subject = monitoringSubject(updated);
    expect(subject.type).toBe("person");
    if (subject.type === "person") {
      expect(subject.nationalityCodes).toEqual([]);
    }
    const results = await Promise.all([prepare(first), prepare(updated)]);
    const options = {
      db: scopedDb,
      organizationId: orgId,
      source: "eu",
      results,
      now,
    } as const;
    expect(await commitSanctionsMonitoringBatch(options)).toEqual([
      first.id,
      second.id,
    ]);
    await commitSanctionsMonitoringBatch(options);
    expect(await eventsFor(first.id)).toHaveLength(1);
    expect(await eventsFor(second.id)).toHaveLength(1);
    await activate("6", 0);
    await commit(await prepare(first));
    expect((await screeningFor(first.id)).status).toBe("clear");
    await expectFailure(
      async () =>
        await scopedDb(async (tx) => {
          await tx
            .update(sanctionsContactScreenings)
            .set({ editionId: null })
            .where(eq(sanctionsContactScreenings.contactId, first.id));
        }),
      "sanctions_contact_screenings_clear_edition_check",
    );
  },
  TIMEOUT,
);

const audited: string[] = [];
const recordAuditEvent = async (
  _tx: Transaction,
  event: AuditEvent | AuditEvent[],
) => {
  audited.push(
    ...(Array.isArray(event) ? event : [event]).map((row) => row.resourceId),
  );
};

test.each(["dismissed", "confirmed"] as const)(
  "%s review is tenant-isolated, replay-safe, and reopens on either fingerprint",
  async (disposition) => {
    await activate("f");
    const contact = await addContact();
    await commit(await prepare(contact));
    const initial = await matchFor(contact.id);
    const read = await scopedDb(
      async (tx) =>
        await readContactSanctions(tx, {
          organizationId: orgId,
          contactId: contact.id,
          now,
        }),
    );
    if (read.isErr()) {
      panic("Synthetic contact read failed");
    }
    const target =
      read.value.matches.items.find((row) => row.sourceId === "eu")
        ?.reviewTarget ?? panic("Synthetic review target missing");
    expect(target.expectedContactFingerprint).toBe(initial.contactFingerprint);
    expect(target.expectedEntryHash).toBe(initial.entryHash);
    const options = {
      organizationId: orgId,
      contactId: contact.id,
      ...target,
      disposition,
      reason: "Synthetic review",
      reviewerId,
      recordAuditEvent,
      clock: () => now,
    } as const;
    const denied = await scopedFor(otherOrg)(
      async (tx) => await reviewSanctionsMatch(tx, options),
    );
    expect(denied.isErr()).toBe(true);
    expect((await matchFor(contact.id)).disposition).toBe("needs-review");
    const reviewed = await scopedDb(
      async (tx) => await reviewSanctionsMatch(tx, options),
    );
    expect(reviewed.isOk()).toBe(true);
    await scopedDb(async (tx) => await reviewSanctionsMatch(tx, options));
    expect((await eventsFor(contact.id)).map((row) => row.type)).toEqual([
      "new",
      disposition,
    ]);
    expect(await matchFor(contact.id)).toMatchObject({
      disposition,
      reviewedContactFingerprint: initial.contactFingerprint,
      reviewedEntryHash: initial.entryHash,
      reviewedBy: reviewerId,
    });
    await activate("f");
    await commit(await prepare(contact));
    expect((await matchFor(contact.id)).disposition).toBe(disposition);
    await activate("e");
    await commit(await prepare(contact));
    expect(await matchFor(contact.id)).toMatchObject({
      disposition: "needs-review",
      reviewedContactFingerprint: null,
      reviewedEntryHash: null,
    });
    expect((await eventsFor(contact.id)).at(-1)?.type).toBe("reopened");
    const staleReview = await scopedDb(
      async (tx) => await reviewSanctionsMatch(tx, options),
    );
    expect(staleReview.isErr() && staleReview.error.status).toBe(409);
    const current = await matchFor(contact.id);
    const refreshedOptions = {
      ...options,
      expectedContactFingerprint: current.contactFingerprint,
      expectedEntryHash: current.entryHash,
    };
    const refreshedReview = await scopedDb(
      async (tx) => await reviewSanctionsMatch(tx, refreshedOptions),
    );
    expect(refreshedReview.isOk()).toBe(true);
    const edited =
      (
        await db
          .update(contacts)
          .set({ nationalityCodes: ["DE"] })
          .where(eq(contacts.id, contact.id))
          .returning()
      ).at(0) ?? panic("Contact missing");
    await commit(await prepare(edited));
    expect((await matchFor(contact.id)).disposition).toBe("needs-review");
    expect((await eventsFor(contact.id)).at(-1)?.type).toBe("reopened");
    const staleContactReview = await scopedDb(
      async (tx) => await reviewSanctionsMatch(tx, refreshedOptions),
    );
    expect(staleContactReview.isErr() && staleContactReview.error.status).toBe(
      409,
    );
    expect((await matchFor(contact.id)).disposition).toBe("needs-review");
  },
  TIMEOUT,
);

test(
  "opt-out hides current hits, preserves history, and fences a concurrent prepared commit",
  async () => {
    await activate("d");
    const contact = await addContact();
    const prepared = await prepare(contact);
    await commit(prepared);
    await db
      .delete(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    const initialRead = await scopedDb(
      async (tx) =>
        await readContactSanctions(tx, {
          organizationId: orgId,
          contactId: contact.id,
          now,
        }),
    );
    expect(
      initialRead.unwrap().lists.find((row) => row.source === "eu")?.status,
    ).toBe("possible-match");
    const firstEvents = await eventsFor(contact.id);
    await Promise.all([
      scopedDb(
        async (tx) =>
          await excludeSanctionsContact(tx, {
            organizationId: orgId,
            contactId: contact.id,
            recordAuditEvent,
            now,
          }),
      ),
      commit(prepared),
    ]);
    expect((await matchFor(contact.id)).state).toBe("lapsed");
    const excluded = (
      await scopedDb(
        async (tx) =>
          await readContactSanctions(tx, {
            organizationId: orgId,
            contactId: contact.id,
            now,
          }),
      )
    ).unwrap();
    expect(excluded.lists.every((row) => row.status === "excluded")).toBe(true);
    expect(excluded.matches.items).toEqual([]);
    expect(excluded.matches.nextCursor).toBeNull();
    expect(await eventsFor(contact.id)).toHaveLength(firstEvents.length);
    expect(
      (
        await scopedDb(
          async (tx) =>
            await listOpenSanctionsMatches(tx, { organizationId: orgId, now }),
        )
      )
        .unwrap()
        .items.some((row) => row.contactId === contact.id),
    ).toBe(false);
    expect(
      (
        await scopedDb(
          async (tx) =>
            await listSanctionsMonitoringEvents(tx, { organizationId: orgId }),
        )
      )
        .unwrap()
        .items.some((row) => row.contactId === contact.id),
    ).toBe(false);
    const otherRead = await scopedFor(otherOrg)(
      async (tx) =>
        await readContactSanctions(tx, {
          organizationId: orgId,
          contactId: contact.id,
          now,
        }),
    );
    expect(otherRead.isErr()).toBe(true);
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId));
    const included = await addContact();
    const firmPrepared = await prepare(included);
    await commit(firmPrepared);
    await Promise.all([
      scopedDb(
        async (tx) =>
          await disableSanctionsMonitoring(tx, {
            organizationId: orgId,
            recordAuditEvent,
            now,
          }),
      ),
      commit(firmPrepared),
    ]);
    expect((await matchFor(included.id)).state).toBe("lapsed");
    expect(
      (
        await scopedDb(
          async (tx) =>
            await readContactSanctions(tx, {
              organizationId: orgId,
              contactId: included.id,
              now,
            }),
        )
      )
        .unwrap()
        .lists.every((row) => row.status === "excluded"),
    ).toBe(true);
  },
  TIMEOUT,
);

test(
  "an audit failure rolls back review state and its append-only event",
  async () => {
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId));
    await activate("9");
    const contact = await addContact();
    await commit(await prepare(contact));
    const current = await matchFor(contact.id);
    await expectFailure(
      async () =>
        await scopedDb(
          async (tx) =>
            await reviewSanctionsMatch(tx, {
              organizationId: orgId,
              contactId: contact.id,
              reviewerId,
              source: "eu",
              sourceEntryId: "one",
              disposition: "dismissed",
              reason: "Synthetic review",
              expectedContactFingerprint: current.contactFingerprint,
              expectedEntryHash: current.entryHash,
              clock: () => now,
              recordAuditEvent: async () => panic("synthetic audit failure"),
            }),
        ),
      "synthetic audit failure",
    );
    expect((await matchFor(contact.id)).disposition).toBe("needs-review");
    expect((await eventsFor(contact.id)).map((row) => row.type)).toEqual([
      "new",
    ]);
  },
  TIMEOUT,
);

test(
  "open-hit and durable-event pages advance without overlap and reject cross-tenant cursors",
  async () => {
    await activate("3");
    const contactRows = await db
      .insert(contacts)
      .values(
        Array.from({ length: 3 }, () => ({
          organizationId: orgId,
          type: "person" as const,
          displayName: "Synthetic Person",
        })),
      )
      .returning();
    const results = await Promise.all(contactRows.map(prepare));
    await commitSanctionsMonitoringBatch({
      db: scopedDb,
      organizationId: orgId,
      source: "eu",
      results,
      now,
    });
    await db.delete(sanctionsContactMarks).where(
      inArray(
        sanctionsContactMarks.contactId,
        contactRows.map((row) => row.id),
      ),
    );
    const first = (
      await scopedDb(
        async (tx) =>
          await listOpenSanctionsMatches(tx, {
            organizationId: orgId,
            limit: 2,
            now,
          }),
      )
    ).unwrap();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await scopedDb(
        async (tx) =>
          await listOpenSanctionsMatches(tx, {
            organizationId: orgId,
            limit: 2,
            now,
            cursor: first.nextCursor ?? panic("Missing cursor"),
          }),
      )
    ).unwrap();
    const allIds = [...first.items, ...second.items].map(
      (row) => row.contactId,
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.toSorted()).toEqual(
      contactRows.map((row) => row.id).toSorted(),
    );
    const invalid = await scopedDb(
      async (tx) =>
        await listOpenSanctionsMatches(tx, {
          organizationId: orgId,
          cursor: encodePaginationCursor([
            otherOrg,
            contactRows.at(0)?.id ?? panic("Missing contact"),
            "eu",
            "one",
          ]),
          now,
        }),
    );
    expect(invalid.isErr() && invalid.error.code).toBe("invalid_cursor");
    const foreign = (
      await scopedFor(otherOrg)(
        async (tx) =>
          await listOpenSanctionsMatches(tx, { organizationId: otherOrg, now }),
      )
    ).unwrap();
    expect(foreign.items).toEqual([]);
    const eventPage = (
      await scopedDb(
        async (tx) =>
          await listSanctionsMonitoringEvents(tx, {
            organizationId: orgId,
            limit: 2,
          }),
      )
    ).unwrap();
    expect(eventPage.items).toHaveLength(2);
    expect(
      eventPage.items.every(
        (row) => row.type === "new" || row.type === "reopened",
      ),
    ).toBe(true);
    const nextEvents = (
      await scopedDb(
        async (tx) =>
          await listSanctionsMonitoringEvents(tx, {
            organizationId: orgId,
            limit: 2,
            cursor: eventPage.nextCursor ?? panic("Missing event cursor"),
          }),
      )
    ).unwrap();
    expect(
      nextEvents.items.every(
        (row) => !eventPage.items.some((previous) => previous.id === row.id),
      ),
    ).toBe(true);
  },
  TIMEOUT,
);

test(
  "re-enabling queues durable contact and firm refreshes, replays safely, and rolls back on audit failure",
  async () => {
    const contact = await addContact();
    await scopedDb(
      async (tx) =>
        await excludeSanctionsContact(tx, {
          organizationId: orgId,
          contactId: contact.id,
          recordAuditEvent,
          now,
        }),
    );
    await db
      .delete(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    const options = {
      organizationId: orgId,
      contactId: contact.id,
      recordAuditEvent,
    };
    const denied = await scopedFor(otherOrg)(
      async (tx) => await includeSanctionsContact(tx, options),
    );
    expect(denied.isErr() && denied.error.status).toBe(404);
    await expectFailure(
      async () =>
        await scopedDb(
          async (tx) =>
            await includeSanctionsContact(tx, {
              ...options,
              recordAuditEvent: async () =>
                panic("synthetic re-enable audit failure"),
            }),
        ),
      "synthetic re-enable audit failure",
    );
    expect(
      (
        await db
          .select()
          .from(sanctionsContactMarks)
          .where(eq(sanctionsContactMarks.contactId, contact.id))
      ).length,
    ).toBe(0);
    expect(
      (await db.select().from(contacts).where(eq(contacts.id, contact.id))).at(
        0,
      )?.sanctionsMonitoringMode,
    ).toBe("excluded");
    const included = await scopedDb(
      async (tx) => await includeSanctionsContact(tx, options),
    );
    expect(included.isOk()).toBe(true);
    const mark = (
      await db
        .select()
        .from(sanctionsContactMarks)
        .where(eq(sanctionsContactMarks.contactId, contact.id))
    ).at(0);
    expect(mark).toBeDefined();
    await scopedDb(async (tx) => await includeSanctionsContact(tx, options));
    expect(
      (
        await db
          .select()
          .from(sanctionsContactMarks)
          .where(eq(sanctionsContactMarks.contactId, contact.id))
      ).at(0),
    ).toEqual(mark);
    await scopedDb(
      async (tx) =>
        await disableSanctionsMonitoring(tx, {
          organizationId: orgId,
          recordAuditEvent,
          now,
        }),
    );
    await db
      .delete(sanctionsOrganizationMarks)
      .where(eq(sanctionsOrganizationMarks.organizationId, orgId));
    await expectFailure(
      async () =>
        await scopedDb(
          async (tx) =>
            await enableSanctionsMonitoring(tx, {
              organizationId: orgId,
              recordAuditEvent: async () =>
                panic("synthetic firm audit failure"),
            }),
        ),
      "synthetic firm audit failure",
    );
    expect(
      (
        await db
          .select()
          .from(sanctionsOrganizationMarks)
          .where(eq(sanctionsOrganizationMarks.organizationId, orgId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, orgId))
      ).at(0)?.sanctionsMonitoringMode,
    ).toBe("disabled");
    await scopedDb(
      async (tx) =>
        await enableSanctionsMonitoring(tx, {
          organizationId: orgId,
          recordAuditEvent,
        }),
    );
    const orgMark = (
      await db
        .select()
        .from(sanctionsOrganizationMarks)
        .where(eq(sanctionsOrganizationMarks.organizationId, orgId))
    ).at(0);
    expect(orgMark).toBeDefined();
    await scopedDb(
      async (tx) =>
        await enableSanctionsMonitoring(tx, {
          organizationId: orgId,
          recordAuditEvent,
        }),
    );
    expect(
      (
        await db
          .select()
          .from(sanctionsOrganizationMarks)
          .where(eq(sanctionsOrganizationMarks.organizationId, orgId))
      ).at(0),
    ).toEqual(orgMark);
  },
  TIMEOUT,
);

test.each(["dismissed", "confirmed"] as const)(
  "rejects %s when evidence expires during advisory-lock acquisition",
  async (disposition) => {
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId));
    await activate("b");
    const contact = await addContact();
    await commit(await prepare(contact));
    const match = await matchFor(contact.id);
    const beforeExpiry = new Date(
      now.getTime() + SANCTIONS_SOURCE_CONFIG.eu.freshnessMs - 1,
    );
    const afterExpiry = new Date(beforeExpiry.getTime() + 2);
    const current = (
      await scopedDb(
        async (tx) =>
          await readContactSanctions(tx, {
            organizationId: orgId,
            contactId: contact.id,
            now: beforeExpiry,
          }),
      )
    ).unwrap();
    expect(current.matches.items).toHaveLength(1);
    const target =
      current.matches.items.at(0)?.reviewTarget ??
      panic("Review target missing");
    const waiting = Promise.withResolvers<undefined>();
    const acquired = Promise.withResolvers<undefined>();
    let clockValue = beforeExpiry;
    let audits = 0;
    const operation = scopedDb(async (tx) => {
      let firstStatement = true;
      const waitingTransaction = new Proxy(tx, {
        get(handle, property) {
          if (property === "execute") {
            return async (query: Parameters<Transaction["execute"]>[0]) => {
              if (firstStatement) {
                firstStatement = false;
                waiting.resolve(undefined);
                await acquired.promise;
              }
              return await handle.execute(query);
            };
          }
          return Reflect.get(handle, property);
        },
      });
      return await reviewSanctionsMatch(waitingTransaction, {
        organizationId: orgId,
        contactId: contact.id,
        reviewerId,
        ...target,
        disposition,
        reason: "Synthetic review",
        clock: () => clockValue,
        recordAuditEvent: async () => {
          audits += 1;
        },
      });
    });
    try {
      await waiting.promise;
      clockValue = afterExpiry;
    } finally {
      acquired.resolve(undefined);
    }
    const result = await operation;
    expect(result.isErr() && result.error.status).toBe(409);
    expect(await matchFor(contact.id)).toEqual(match);
    expect((await eventsFor(contact.id)).map((event) => event.type)).toEqual([
      "new",
    ]);
    expect(audits).toBe(0);
  },
  TIMEOUT,
);

test(
  "contact evidence pages are bounded, ordered, complete and bound to both tenant and contact",
  async () => {
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId));
    await activate("a");
    const contact = await addContact();
    await commit(await prepare(contact));
    const match = await matchFor(contact.id);
    const extraMatches = Array.from({ length: 200 }, (_, index) => {
      const sourceEntryId = `entry-${String(index).padStart(3, "0")}`;
      return {
        ...match,
        sourceEntryId,
        match: { ...match.match, sourceEntryId },
      };
    });
    await db.insert(sanctionsContactMatches).values(extraMatches);
    const options = { organizationId: orgId, contactId: contact.id, now };
    const first = (
      await scopedDb(async (tx) => await readContactSanctions(tx, options))
    ).unwrap();
    expect(first.matches.limit).toBe(100);
    expect(first.matches.items).toHaveLength(100);
    expect(first.truncated).toBe(true);
    const second = (
      await scopedDb(
        async (tx) =>
          await readContactSanctions(tx, {
            ...options,
            cursor: first.matches.nextCursor ?? panic("First cursor missing"),
          }),
      )
    ).unwrap();
    const third = (
      await scopedDb(
        async (tx) =>
          await readContactSanctions(tx, {
            ...options,
            cursor: second.matches.nextCursor ?? panic("Second cursor missing"),
          }),
      )
    ).unwrap();
    expect(second.matches.items).toHaveLength(100);
    expect(third.matches.items).toHaveLength(1);
    expect(third.truncated).toBe(false);
    expect(third.matches.nextCursor).toBeNull();
    const ids = [
      ...first.matches.items,
      ...second.matches.items,
      ...third.matches.items,
    ].map((row) => row.sourceEntryId);
    expect(ids).toEqual(
      [
        ...extraMatches.map((row) => row.sourceEntryId),
        match.sourceEntryId,
      ].toSorted(),
    );
    expect(new Set(ids).size).toBe(201);
    expect(
      first.matches.items.every(
        (row) => row.reviewTarget.expectedEntryHash === match.entryHash,
      ),
    ).toBe(true);
    const otherContact = await addContact();
    const wrongContact = await scopedDb(
      async (tx) =>
        await readContactSanctions(tx, {
          ...options,
          contactId: otherContact.id,
          cursor: first.matches.nextCursor ?? panic("First cursor missing"),
        }),
    );
    expect(wrongContact.isErr() && wrongContact.error.code).toBe(
      "invalid_cursor",
    );
    const wrongTenant = await scopedFor(otherOrg)(
      async (tx) =>
        await readContactSanctions(tx, {
          ...options,
          organizationId: otherOrg,
          cursor: first.matches.nextCursor ?? panic("First cursor missing"),
        }),
    );
    expect(wrongTenant.isErr() && wrongTenant.error.code).toBe(
      "invalid_cursor",
    );
  },
  TIMEOUT,
);

test(
  "contact and organization reads share classification as practice jurisdictions change",
  async () => {
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId));
    await activate("8");
    const contact = await addContact();
    await commit(await prepare(contact));
    await db
      .delete(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    const readBoth = async () => {
      const details = (
        await scopedDb(
          async (tx) =>
            await readContactSanctions(tx, {
              organizationId: orgId,
              contactId: contact.id,
              now,
            }),
        )
      ).unwrap();
      const open = (
        await scopedDb(
          async (tx) =>
            await listOpenSanctionsMatches(tx, {
              organizationId: orgId,
              now,
            }),
        )
      ).unwrap();
      return {
        list: details.lists.find((row) => row.source === "eu")?.classification,
        match: details.matches.items.at(0)?.classification,
        open: open.items.find((row) => row.contactId === contact.id)
          ?.classification,
      };
    };
    expect(await readBoth()).toEqual({
      list: "informational",
      match: "informational",
      open: "informational",
    });
    await db.insert(organizationSettings).values({
      id: toSafeId<"organizationSettings">(Bun.randomUUIDv7()),
      organizationId: orgId,
      practiceJurisdictions: [{ countryCode: "DE", isPrimary: true }],
    });
    expect(await readBoth()).toEqual({
      list: "binding",
      match: "binding",
      open: "binding",
    });
    await db
      .update(organizationSettings)
      .set({ practiceJurisdictions: [{ countryCode: "US", isPrimary: true }] })
      .where(eq(organizationSettings.organizationId, orgId));
    expect(await readBoth()).toEqual({
      list: "informational",
      match: "informational",
      open: "informational",
    });
  },
  TIMEOUT,
);
