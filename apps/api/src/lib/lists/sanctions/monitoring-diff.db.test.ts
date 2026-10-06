import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createHash } from "node:crypto";

import { compareCodeUnit } from "@stll/collation";
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
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { commitSanctionsMonitoringBatch } from "@/api/lib/lists/sanctions/monitoring-diff";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import type { SanctionsPossibleMatch } from "@/api/lib/lists/sanctions/screening-service";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { drainSanctionsContactMarks } from "./monitoring-drain";
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
import { prepareSanctionsMonitoringRefresh } from "./monitoring-refresh";
import { reviewSanctionsMatch } from "./monitoring-review";
import { SANCTIONS_SOURCE_CONFIG, sanctionsSourceIds } from "./source-config";

const TIMEOUT = 120_000;
type ScreeningEventType = typeof sanctionsScreeningEvents.$inferSelect.type;
const sortedEventTypes = (...types: ScreeningEventType[]) => types.toSorted();
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

const scopedFor = (organizationId: typeof orgId): ScopedDb =>
  executeRowsScopedDb(
    async (run) =>
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella`);
        await tx.execute(
          sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
        );
        return await run(tx);
      }),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = openDb(client);
  scopedDb = scopedFor(orgId);
  await client.exec(`
    REVOKE ALL ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads FROM stella;
    GRANT SELECT ON organization, sanctions_sources, sanctions_editions, sanctions_edition_entries, sanctions_entry_payloads TO stella;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_contact_marks, sanctions_organization_marks TO stella;
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
    .where(eq(sanctionsScreeningEvents.contactId, contactId))
    .orderBy(sanctionsScreeningEvents.id);

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

const stateFor = async (contactId: typeof contacts.$inferSelect.id) => ({
  matches: await db
    .select()
    .from(sanctionsContactMatches)
    .where(eq(sanctionsContactMatches.contactId, contactId))
    .orderBy(sanctionsContactMatches.sourceEntryId),
  events: await db
    .select()
    .from(sanctionsScreeningEvents)
    .where(eq(sanctionsScreeningEvents.contactId, contactId))
    .orderBy(sanctionsScreeningEvents.id),
  coverage: await screeningFor(contactId),
});

test(
  "incomplete monitoring outcomes preserve matches events and coverage at the result bound",
  async () => {
    const editionId = await activate("5");
    const contact = await addContact();
    const work = await prepare(contact);
    const outcome = work.outcome;
    if (outcome.status !== "possible-match") {
      panic("Expected matching fixture");
    }
    const hit = outcome.possibleMatches.at(0) ?? panic("Expected matching hit");
    const outcomeWithHits = (
      possibleMatches: [SanctionsPossibleMatch, ...SanctionsPossibleMatch[]],
      truncated = false,
    ) => ({
      ...outcome,
      possibleMatches,
      truncated,
      totalMatches: possibleMatches.length,
    });
    const hits = Array.from({ length: 1001 }, (_, index) => ({
      ...hit,
      sourceEntryId: `bound-${index.toString().padStart(4, "0")}`,
    }));
    const payload =
      (
        await db
          .select()
          .from(sanctionsEntryPayloads)
          .where(eq(sanctionsEntryPayloads.contentHash, "5".repeat(64)))
      ).at(0)?.payload ?? panic("Bound fixture payload missing");
    const entries = hits.map(({ sourceEntryId }) => {
      const entry = { ...payload, sourceId: sourceEntryId };
      return {
        sourceEntryId,
        payload: entry,
        contentHash: createHash("sha256")
          .update(JSON.stringify(entry))
          .digest("hex"),
      };
    });
    await db.insert(sanctionsEntryPayloads).values(
      entries.map(({ payload: entry, contentHash }) => ({
        payload: entry,
        contentHash,
      })),
    );
    await db
      .delete(sanctionsEditionEntries)
      .where(eq(sanctionsEditionEntries.editionId, editionId));
    await db.insert(sanctionsEditionEntries).values(
      entries.slice(0, 2).map(({ sourceEntryId, contentHash }) => ({
        editionId,
        sourceEntryId,
        contentHash,
      })),
    );
    await db
      .update(sanctionsEditions)
      .set({ entryCount: 2 })
      .where(eq(sanctionsEditions.id, editionId));
    const first = hits.at(0) ?? panic("First hit missing");
    const second = hits.at(1) ?? panic("Second hit missing");
    expect(
      await commit({ ...work, outcome: outcomeWithHits([first, second]) }),
    ).toEqual([contact.id]);
    const initial = await stateFor(contact.id);
    expect(initial.matches.map(({ state }) => state)).toEqual([
      "active",
      "active",
    ]);
    expect(initial.events).toHaveLength(2);
    for (const incompleteOutcome of [
      outcomeWithHits([first], true),
      outcomeWithHits([first, ...hits.slice(1)]),
    ]) {
      await expectFailure(
        async () => await commit({ ...work, outcome: incompleteOutcome }),
        "Monitoring requires the complete sanctions result set",
      );
      expect(await stateFor(contact.id)).toEqual(initial);
    }
    await db.insert(sanctionsEditionEntries).values(
      entries.slice(2, 1000).map(({ sourceEntryId, contentHash }) => ({
        editionId,
        sourceEntryId,
        contentHash,
      })),
    );
    await db
      .update(sanctionsEditions)
      .set({ entryCount: 1000 })
      .where(eq(sanctionsEditions.id, editionId));
    const complete = {
      ...work,
      outcome: outcomeWithHits([first, ...hits.slice(1, 1000)]),
    };
    expect(await commit(complete)).toEqual([contact.id]);
    const boundary = await stateFor(contact.id);
    expect(boundary.matches).toHaveLength(1000);
    expect(boundary.events).toHaveLength(1000);
    expect(boundary.coverage.status).toBe("possible-match");
    await commit(complete);
    expect(await stateFor(contact.id)).toEqual(boundary);
  },
  TIMEOUT,
);

test(
  "full-edition diff converges across replay, unchanged review, changed entries, lapse and reopen",
  async () => {
    const contact = await addContact();
    const firstEdition = await activate("a");
    const initial = await prepare(contact);
    expect(initial.outcome.status).toBe("possible-match");
    expect(await commit(initial)).toEqual([contact.id]);
    await commit(initial);
    expect(
      (await eventsFor(contact.id)).map(({ type }) => type).toSorted(),
    ).toEqual(sortedEventTypes("new"));
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
    expect(
      (await eventsFor(contact.id)).map(({ type }) => type).toSorted(),
    ).toEqual(sortedEventTypes("new", "reopened"));
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
    expect(
      (await eventsFor(contact.id)).map(({ type }) => type).toSorted(),
    ).toEqual(sortedEventTypes("new", "reopened", "lapsed", "reopened"));
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
    expect(
      (await eventsFor(contact.id)).map(({ type }) => type).toSorted(),
    ).toEqual(sortedEventTypes("new", "reopened"));
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
const recordAuditEvent = async (...[, event]: Parameters<AuditRecorder>) => {
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
    expect(
      (await eventsFor(contact.id)).map((row) => row.type).toSorted(),
    ).toEqual(sortedEventTypes("new", disposition));
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
    expect(
      (await eventsFor(contact.id)).filter(({ type }) => type === "reopened"),
    ).toHaveLength(1);
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
    expect(
      (await eventsFor(contact.id)).filter(({ type }) => type === "reopened"),
    ).toHaveLength(2);
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
    expect(excluded.lists).toHaveLength(sanctionsSourceIds().length);
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
    const firmRead = (
      await scopedDb(
        async (tx) =>
          await readContactSanctions(tx, {
            organizationId: orgId,
            contactId: included.id,
            now,
          }),
      )
    ).unwrap();
    expect(firmRead.lists).toHaveLength(sanctionsSourceIds().length);
    expect(firmRead.lists.every((row) => row.status === "excluded")).toBe(true);
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
    expect(
      (await eventsFor(contact.id)).map((row) => row.type).toSorted(),
    ).toEqual(sortedEventTypes("new"));
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
    expect(nextEvents.items).toHaveLength(2);
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

test.each(
  (["dismissed", "confirmed"] as const).flatMap((disposition) =>
    (["advisory", "settings", "contact", "match"] as const).map((lock) => ({
      disposition,
      lock,
    })),
  ),
)(
  "rejects $disposition when evidence expires after the $lock lock",
  async ({ disposition, lock }) => {
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, orgId));
    await db.insert(organizationSettings).values({
      id: toSafeId<"organizationSettings">(Bun.randomUUIDv7()),
      organizationId: orgId,
      sanctionsMonitoringMode: "enabled",
    });
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
      let lockedSelections = 0;
      const pauseAfterLock = async (step: typeof lock) => {
        if (step === lock) {
          waiting.resolve(undefined);
          await acquired.promise;
        }
      };
      const waitingTransaction = new Proxy(tx, {
        get(handle, property) {
          if (property === "execute") {
            return async (query: Parameters<Transaction["execute"]>[0]) => {
              const result = await handle.execute(query);
              if (firstStatement) {
                firstStatement = false;
                await pauseAfterLock("advisory");
              }
              return result;
            };
          }
          if (property === "select") {
            return (...args: Parameters<Transaction["select"]>) => {
              const query = handle.select(...args);
              const from = query.from.bind(query);
              return Object.assign(query, {
                from: (table: Parameters<typeof query.from>[0]) => {
                  const selected = from(table);
                  const takeLock = selected.for.bind(selected);
                  return Object.assign(selected, {
                    for: async (...options: Parameters<typeof selected.for>) =>
                      await takeLock(...options).then(async (rows) => {
                        const step = (
                          ["settings", "contact", "match"] as const
                        ).at(lockedSelections);
                        lockedSelections += 1;
                        if (step === undefined) {
                          panic("Unexpected review row lock");
                        }
                        await pauseAfterLock(step);
                        return rows;
                      }),
                  });
                },
              });
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
    expect(
      (await eventsFor(contact.id)).map((event) => event.type).toSorted(),
    ).toEqual(sortedEventTypes("new"));
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
    const extraMatches = Array.from({ length: 99 }, (_, index) => {
      const sourceEntryId = `entry-${String(index).padStart(3, "0")}`;
      return {
        ...match,
        sourceEntryId,
        match: { ...match.match, sourceEntryId },
      };
    });
    await db.insert(sanctionsContactMatches).values(extraMatches);
    const unEditionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
    const editionHash = createHash("sha256").update(unEditionId).digest("hex");
    await db.insert(sanctionsEditions).values({
      id: unEditionId,
      sourceId: "un",
      markerKey: editionHash,
      contentHash: editionHash,
      publishedAt: "2026-09-29",
      state: "ready",
      entryCount: 0,
    });
    await db
      .update(sanctionsSources)
      .set({ activeEditionId: unEditionId, lastSuccessfulVerifiedAt: now })
      .where(eq(sanctionsSources.id, "un"));
    const unMatches = Array.from({ length: 101 }, (_, index) => {
      const sourceEntryId = `entry-${String(index).padStart(3, "0")}`;
      return {
        ...match,
        sourceId: "un",
        sourceEntryId,
        editionId: unEditionId,
        match: { ...match.match, sourceEntryId, editionId: unEditionId },
      };
    });
    await db.insert(sanctionsContactMatches).values(unMatches);
    await db.insert(sanctionsContactScreenings).values({
      organizationId: orgId,
      contactId: contact.id,
      sourceId: "un",
      editionId: unEditionId,
      status: "possible-match",
      reason: null,
      contactFingerprint: match.contactFingerprint,
      checkedAt: now,
    });
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
    expect(first.matches.items.every((row) => row.sourceId === "eu")).toBe(
      true,
    );
    expect(first.matches.items.at(-1)?.sourceEntryId).toBe("one");
    expect(second.matches.items.at(0)?.sourceEntryId).toBe("entry-000");
    expect(second.matches.items).toHaveLength(100);
    expect(second.matches.items.every((row) => row.sourceId === "un")).toBe(
      true,
    );
    expect(third.matches.items.at(0)?.sourceId).toBe("un");
    expect(third.matches.items).toHaveLength(1);
    expect(third.truncated).toBe(false);
    expect(third.matches.nextCursor).toBeNull();
    const ids = [
      ...first.matches.items,
      ...second.matches.items,
      ...third.matches.items,
    ].map((row) => `${row.sourceId}:${row.sourceEntryId}`);
    expect(ids).toEqual(
      [...extraMatches, match, ...unMatches]
        .map((row) => `${row.sourceId}:${row.sourceEntryId}`)
        .toSorted(),
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

test(
  "active evidence changes append one changed event and preserve unchanged reviews",
  async () => {
    await activate("3");
    const contact = await addContact();
    const work = await prepare(contact);
    if (work.outcome.status !== "possible-match") {
      panic("Expected active matching fixture");
    }
    await commit(work);
    const old = await matchFor(contact.id);
    const newEdition = await activate("4");
    const changed = await prepare(contact);
    if (changed.outcome.status !== "possible-match") {
      panic("Expected changed matching fixture");
    }
    await commit(changed);
    await commit(changed);
    const history = await eventsFor(contact.id);
    expect(history.map(({ type }) => type).toSorted()).toEqual([
      "changed",
      "new",
    ]);
    expect(history.find(({ type }) => type === "changed")).toMatchObject({
      oldMatch: old.match,
      newMatch: changed.outcome.possibleMatches[0],
      oldEditionId: old.editionId,
      newEditionId: newEdition,
      reason: "evidence-changed",
    });
    const reviewer = toSafeId<"user">("monitoring-evidence-reviewer");
    await db.insert(user).values({
      id: reviewer,
      name: "Reviewer",
      email: "monitoring-reviewer@example.test",
    });
    await db
      .update(sanctionsContactMatches)
      .set({
        disposition: "dismissed",
        reviewedBy: reviewer,
        reviewReason: "Confirmed distinct identity",
      })
      .where(eq(sanctionsContactMatches.contactId, contact.id));
    const before = await matchFor(contact.id);
    const hit = changed.outcome.possibleMatches[0];
    const evidenceOnly = {
      ...changed,
      outcome: {
        ...changed.outcome,
        possibleMatches: [
          {
            ...hit,
            evidence: { ...hit.evidence, matchedName: "Synthetic Alternate" },
          },
        ],
      } satisfies typeof changed.outcome,
    };
    await commit(evidenceOnly);
    const after = await matchFor(contact.id);
    expect(after).toMatchObject({
      disposition: before.disposition,
      reviewedBy: reviewer,
      reviewReason: before.reviewReason,
      entryHash: before.entryHash,
      contactFingerprint: before.contactFingerprint,
      match: evidenceOnly.outcome.possibleMatches[0],
    });
    const evidenceHistory = await eventsFor(contact.id);
    expect(evidenceHistory.map(({ type }) => type).toSorted()).toEqual([
      "changed",
      "changed",
      "new",
    ]);
    expect(
      evidenceHistory.find(
        ({ newMatch }) =>
          newMatch?.evidence.matchedName === "Synthetic Alternate",
      ),
    ).toMatchObject({
      oldMatch: before.match,
      newMatch: evidenceOnly.outcome.possibleMatches[0],
      oldEditionId: newEdition,
      newEditionId: newEdition,
      reason: "evidence-changed",
    });
    await commit(evidenceOnly);
    expect(await eventsFor(contact.id)).toEqual(evidenceHistory);
    expect(await matchFor(contact.id)).toEqual(after);
  },
  TIMEOUT,
);

test(
  "batch bounds and source mismatches reject work without writes",
  async () => {
    await activate("2");
    const contact = await addContact();
    const work = await prepare(contact);
    await commit(work);
    const initial = await stateFor(contact.id);
    const options = {
      db: scopedDb,
      organizationId: orgId,
      source: "eu",
      now,
    } as const;
    await expectFailure(
      async () =>
        await commitSanctionsMonitoringBatch({
          ...options,
          results: [work, work],
        }),
      "Sanctions monitoring batch contains duplicate contacts",
    );
    expect(await stateFor(contact.id)).toEqual(initial);
    const contactRows = await db
      .insert(contacts)
      .values(
        Array.from({ length: 101 }, () => ({
          organizationId: orgId,
          type: "person" as const,
          displayName: "Bound Contact",
        })),
      )
      .returning();
    await expectFailure(
      async () =>
        await commitSanctionsMonitoringBatch({
          ...options,
          results: contactRows.map(({ id }) => ({ ...work, contactId: id })),
        }),
      "Sanctions monitoring batch exceeds its bound",
    );
    expect(await stateFor(contact.id)).toEqual(initial);
    const ids = contactRows.map(({ id }) => id);
    expect(
      await db
        .select()
        .from(sanctionsScreeningEvents)
        .where(inArray(sanctionsScreeningEvents.contactId, ids)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(sanctionsContactMatches)
        .where(inArray(sanctionsContactMatches.contactId, ids)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(sanctionsContactScreenings)
        .where(inArray(sanctionsContactScreenings.contactId, ids)),
    ).toEqual([]);
    expect(
      await commit({ ...work, outcome: { ...work.outcome, source: "un" } }),
    ).toEqual([]);
    expect(await stateFor(contact.id)).toEqual(initial);
  },
  TIMEOUT,
);

test(
  "contact birth precision and registration numbers reach the real screening evidence",
  async () => {
    const editionId = await activate("0", 0);
    const base: SanctionsEntry = {
      source: "eu",
      issuer: SANCTIONS_SOURCES.eu.issuer,
      sourceId: "precision-person",
      referenceNumber: null,
      entityType: "person",
      names: [{ name: "Čeněk Šťastný", quality: "strong" }],
      birthDates: [
        { precision: "day", year: 1980, month: 4, day: 3, circa: false },
      ],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://example.test/precision",
    };
    const listedOrganization: SanctionsEntry = {
      ...base,
      sourceId: "registration-organization",
      entityType: "organisation",
      names: [{ name: "Listed Enterprise", quality: "strong" }],
      birthDates: [],
      identifiers: [
        {
          kind: "registration",
          status: "listed",
          label: "Registration",
          number: "REG123",
          country: null,
        },
      ],
    };
    const entries = [base, listedOrganization].map((payload) => ({
      payload,
      contentHash: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
    }));
    await db.insert(sanctionsEntryPayloads).values(entries);
    await db.insert(sanctionsEditionEntries).values(
      entries.map(({ payload, contentHash }) => ({
        editionId,
        sourceEntryId: payload.sourceId,
        contentHash,
      })),
    );
    await db
      .update(sanctionsEditions)
      .set({ entryCount: entries.length })
      .where(eq(sanctionsEditions.id, editionId));
    const person = await addContact();
    const full = {
      ...person,
      displayName: "Čeněk Šťastný",
      dateOfBirthMonth: 4,
      dateOfBirthDay: 3,
    };
    const matching = await prepare(full);
    const dayMismatch = await prepare({ ...full, dateOfBirthDay: 4 });
    const monthMismatch = await prepare({ ...full, dateOfBirthMonth: 5 });
    const yearOnly = await prepare({
      ...full,
      dateOfBirthMonth: null,
      dateOfBirthDay: null,
    });
    const hitFor = (work: Awaited<ReturnType<typeof prepare>>) =>
      work.outcome.possibleMatches.find(
        ({ sourceEntryId }) => sourceEntryId === "precision-person",
      ) ?? panic("Precision fixture not matched");
    expect(hitFor(matching).evidence.birthDate).toBe("match");
    expect(hitFor(yearOnly).evidence.birthDate).toBe("match");
    for (const mismatch of [dayMismatch, monthMismatch]) {
      expect(hitFor(mismatch).evidence.birthDate).toBe("mismatch");
      expect(hitFor(mismatch).score).toBeLessThan(hitFor(matching).score);
    }
    const contact = {
      ...person,
      type: "organization" as const,
      displayName: "Other Display",
      organizationName: "Distinct Trading",
      registrationNumber: "REG123",
    };
    const byRegistration = await prepare(contact);
    expect(
      byRegistration.outcome.possibleMatches.map(
        ({ sourceEntryId }) => sourceEntryId,
      ),
    ).toEqual(["registration-organization"]);
    expect(
      byRegistration.outcome.possibleMatches.at(0)?.evidence.identifier,
    ).toBe("match");
    const withoutRegistration = await prepare({
      ...contact,
      registrationNumber: null,
    });
    expect(withoutRegistration.outcome.possibleMatches).toEqual([]);
  },
  TIMEOUT,
);

const isolatedOrganization = async () => {
  const id = mintAuthProviderId<"organization">();
  await db
    .insert(organization)
    .values({ id, name: "Isolated monitoring", slug: id, createdAt: now });
  return id;
};

test(
  "event pages enumerate every eligible event exactly once including timestamp ties",
  async () => {
    const organizationId = await isolatedOrganization();
    const tenantDb = scopedFor(organizationId);
    const editionId = await activate("4");
    const contact = await addContact(organizationId);
    const excluded = await addContact(organizationId);
    await db
      .update(contacts)
      .set({ sanctionsMonitoringMode: "excluded" })
      .where(eq(contacts.id, excluded.id));
    const eligible = Array.from({ length: 7 }, (_, index) => ({
      id: toSafeId<"sanctionsScreeningEvent">(Bun.randomUUIDv7()),
      organizationId,
      contactId: contact.id,
      sourceId: "eu",
      sourceEntryId: `page-${index}`,
      type: index % 2 === 0 ? ("new" as const) : ("reopened" as const),
      newEditionId: editionId,
      reason: "synthetic event",
      createdAt: new Date(now.getTime() + Math.floor(index / 3) * 1000),
    }));
    await db.insert(sanctionsScreeningEvents).values(eligible);
    await db.insert(sanctionsScreeningEvents).values([
      ...(["changed", "dismissed", "confirmed", "lapsed"] as const).map(
        (type) => ({
          organizationId,
          contactId: contact.id,
          sourceId: "eu",
          sourceEntryId: `hidden-${type}`,
          type,
          newEditionId: editionId,
          reason: "ineligible type",
          createdAt: now,
        }),
      ),
      {
        organizationId,
        contactId: excluded.id,
        sourceId: "eu",
        sourceEntryId: "excluded",
        type: "new",
        newEditionId: editionId,
        reason: "excluded contact",
        createdAt: now,
      },
    ]);
    const expectedIds = eligible
      .toSorted(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          compareCodeUnit(a.id, b.id),
      )
      .map(({ id }) => id);
    const seen: string[] = [];
    let cursor: string | undefined;
    let finished = false;
    for (const size of [2, 2, 2, 1]) {
      const currentCursor = cursor;
      const page = (
        await tenantDb(
          async (tx) =>
            await listSanctionsMonitoringEvents(tx, {
              organizationId,
              limit: 2,
              cursor: currentCursor,
            }),
        )
      ).unwrap();
      expect(page.items).toHaveLength(size);
      seen.push(...page.items.map(({ id }) => id));
      if (size === 1) {
        expect(page.nextCursor).toBeNull();
        finished = true;
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor ?? panic("Expected event cursor");
    }
    expect(finished).toBe(true);
    expect(seen).toEqual(expectedIds);
    expect(new Set(seen).size).toBe(eligible.length);
    for (const invalidCursor of [
      "not-a-cursor",
      encodePaginationCursor([
        otherOrg,
        now.toISOString(),
        expectedIds.at(0) ?? panic("Missing event"),
      ]),
      encodePaginationCursor([
        organizationId,
        "not-a-date",
        expectedIds.at(0) ?? panic("Missing event"),
      ]),
      encodePaginationCursor([organizationId, now.toISOString(), "not-a-uuid"]),
    ]) {
      const result = await tenantDb(
        async (tx) =>
          await listSanctionsMonitoringEvents(tx, {
            organizationId,
            cursor: invalidCursor,
          }),
      );
      expect(result.isErr() && result.error.code).toBe("invalid_cursor");
    }
    await db
      .insert(organizationSettings)
      .values({ organizationId, sanctionsMonitoringMode: "disabled" });
    const disabledPage = (
      await tenantDb(
        async (tx) =>
          await listSanctionsMonitoringEvents(tx, { organizationId }),
      )
    ).unwrap();
    expect(disabledPage.items).toEqual([]);
    expect(disabledPage.nextCursor).toBeNull();
  },
  TIMEOUT,
);

test(
  "review records complete decision evidence and audit exactly once",
  async () => {
    const organizationId = await isolatedOrganization();
    const tenantDb = scopedFor(organizationId);
    await activate("6");
    const contact = await addContact(organizationId);
    await commit(await prepare(contact), organizationId);
    const initial = await matchFor(contact.id);
    const audits: AuditEvent[] = [];
    const record: AuditRecorder = async (...[, event]) => {
      audits.push(...(Array.isArray(event) ? event : [event]));
    };
    const options = {
      organizationId,
      contactId: contact.id,
      reviewerId,
      source: "eu" as const,
      sourceEntryId: "one",
      disposition: "dismissed" as const,
      reason: "  Reviewed evidence  ",
      expectedContactFingerprint: initial.contactFingerprint,
      expectedEntryHash: initial.entryHash,
      clock: () => now,
      recordAuditEvent: record,
    };
    const reviewed = (
      await tenantDb(async (tx) => await reviewSanctionsMatch(tx, options))
    ).unwrap();
    expect(reviewed).toMatchObject({
      disposition: "dismissed",
      reviewedBy: reviewerId,
      reviewedAt: now,
      reviewReason: "Reviewed evidence",
      reviewedContactFingerprint: initial.contactFingerprint,
      reviewedEntryHash: initial.entryHash,
    });
    const audit = {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: contact.id,
      workspaceId: null,
      changes: {
        sanctionsReview: { old: "needs-review", new: "dismissed" },
        sanctionsReviewReason: { old: null, new: "Reviewed evidence" },
        sanctionsReviewEntry: { old: null, new: "eu:one" },
      },
    } satisfies AuditEvent;
    expect(audits).toEqual([audit]);
    const firstEvents = await eventsFor(contact.id);
    expect(firstEvents).toHaveLength(2);
    const decision =
      firstEvents.find(({ type }) => type === "dismissed") ??
      panic("Dismissal event missing");
    expect(decision).toEqual({
      id: decision.id,
      organizationId,
      contactId: contact.id,
      sourceId: "eu",
      sourceEntryId: "one",
      type: "dismissed",
      oldEditionId: initial.editionId,
      newEditionId: initial.editionId,
      reason: "Reviewed evidence",
      reviewerId,
      contactFingerprint: initial.contactFingerprint,
      entryHash: initial.entryHash,
      oldMatch: initial.match,
      newMatch: initial.match,
      createdAt: now,
    });
    await tenantDb(async (tx) => await reviewSanctionsMatch(tx, options));
    expect(await eventsFor(contact.id)).toEqual(firstEvents);
    expect(audits).toEqual([audit]);
    const changedReason = (
      await tenantDb(
        async (tx) =>
          await reviewSanctionsMatch(tx, {
            ...options,
            reason: "Second assessment",
          }),
      )
    ).unwrap();
    expect(changedReason.reviewReason).toBe("Second assessment");
    expect(audits).toHaveLength(2);
    expect(audits.at(-1)).toEqual({
      ...audit,
      changes: {
        sanctionsReview: { old: "dismissed", new: "dismissed" },
        sanctionsReviewReason: {
          old: "Reviewed evidence",
          new: "Second assessment",
        },
        sanctionsReviewEntry: { old: null, new: "eu:one" },
      },
    });
    const secondReviewer = mintAuthProviderId<"user">();
    await db.insert(user).values({
      id: secondReviewer,
      name: "Second Reviewer",
      email: `${secondReviewer}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    const changedActor = (
      await tenantDb(
        async (tx) =>
          await reviewSanctionsMatch(tx, {
            ...options,
            reason: "Second assessment",
            reviewerId: secondReviewer,
          }),
      )
    ).unwrap();
    expect(changedActor.reviewedBy).toBe(secondReviewer);
    expect(audits).toHaveLength(3);
    expect(audits.at(-1)).toEqual({
      ...audit,
      changes: {
        sanctionsReview: { old: "dismissed", new: "dismissed" },
        sanctionsReviewReason: {
          old: "Second assessment",
          new: "Second assessment",
        },
        sanctionsReviewEntry: { old: null, new: "eu:one" },
      },
    });
    const decisions = await eventsFor(contact.id);
    expect(decisions).toHaveLength(4);
    expect(
      decisions.find(
        (event) =>
          event.reason === "Second assessment" &&
          event.reviewerId === reviewerId,
      ),
    ).toMatchObject({
      reason: "Second assessment",
      reviewerId,
      type: "dismissed",
    });
    expect(
      decisions.find(
        (event) =>
          event.reason === "Second assessment" &&
          event.reviewerId === secondReviewer,
      ),
    ).toMatchObject({
      reason: "Second assessment",
      reviewerId: secondReviewer,
      type: "dismissed",
    });
    await tenantDb(
      async (tx) =>
        await reviewSanctionsMatch(tx, {
          ...options,
          reason: "Second assessment",
          reviewerId: secondReviewer,
        }),
    );
    expect(await eventsFor(contact.id)).toEqual(decisions);
    expect(audits).toHaveLength(3);
    for (const reason of [" \n \t", "x".repeat(2001)]) {
      const before = await stateFor(contact.id);
      const rejected = await tenantDb(
        async (tx) => await reviewSanctionsMatch(tx, { ...options, reason }),
      );
      expect(rejected.isErr() && rejected.error.status).toBe(400);
      expect(await stateFor(contact.id)).toEqual(before);
      expect(audits).toHaveLength(3);
    }
    const boundary = (
      await tenantDb(
        async (tx) =>
          await reviewSanctionsMatch(tx, {
            ...options,
            reason: `  ${"x".repeat(2000)}  `,
          }),
      )
    ).unwrap();
    expect(boundary.reviewReason).toBe("x".repeat(2000));
    expect(audits).toHaveLength(4);
    expect(await eventsFor(contact.id)).toHaveLength(5);
  },
  TIMEOUT,
);

const scopedDrainFor = (organizationId: typeof orgId): ScopedDb =>
  scopedFor(organizationId);

test.each([
  "edited identity",
  "explicit refresh",
  "expired lease",
  "edition switch",
] as const)(
  "open-hit feed suppresses pending %s work until current screening commits",
  async (cause) => {
    const organizationId = await isolatedOrganization();
    const tenantDb = scopedFor(organizationId);
    await activate("7");
    const contact = await addContact(organizationId);
    await commit(await prepare(contact), organizationId);
    await db
      .delete(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    const open = async (readNow = now) =>
      (
        await tenantDb(
          async (tx) =>
            await listOpenSanctionsMatches(tx, {
              organizationId,
              now: readNow,
            }),
        )
      ).unwrap();
    expect((await open()).items.map(({ contactId }) => contactId)).toEqual([
      contact.id,
    ]);
    const initialMatch = await matchFor(contact.id);
    const initialCoverage = await screeningFor(contact.id);
    if (cause === "edited identity") {
      await db
        .update(contacts)
        .set({ dateOfBirthYear: 1981 })
        .where(eq(contacts.id, contact.id));
    } else {
      await tenantDb(async (tx) => {
        const request = prepareSanctionsMonitoringRefresh({
          organizationId,
          contactIds: [contact.id],
        });
        if (request.type !== "contacts") {
          panic("Contact fixture requires contact refresh marks");
        }
        await tx
          .insert(sanctionsContactMarks)
          .values(request.rows)
          .onConflictDoNothing();
      });
    }
    if (cause === "expired lease") {
      await db
        .update(sanctionsContactMarks)
        .set({ scheduledAt: new Date(now.getTime() - 1000) })
        .where(eq(sanctionsContactMarks.contactId, contact.id));
    }
    const marks = await db
      .select()
      .from(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    expect(marks).toHaveLength(1);
    expect((await open()).items).toEqual([]);
    expect(await matchFor(contact.id)).toEqual(initialMatch);
    expect(await screeningFor(contact.id)).toEqual(initialCoverage);
    // Prove the mark itself suppresses still-current evidence before changing the edition.
    if (cause === "edition switch") {
      await activate("8");
    }
    const drainNow = new Date(Date.now() + 1000);
    await db
      .update(sanctionsSources)
      .set({ lastSuccessfulVerifiedAt: drainNow })
      .where(eq(sanctionsSources.id, "eu"));
    await db
      .update(sanctionsContactMarks)
      .set({ scheduledAt: new Date(drainNow.getTime() - 1000) })
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    const drained = await drainSanctionsContactMarks({
      db: scopedDrainFor(organizationId),
      organizationId,
      now: drainNow,
      signal: new AbortController().signal,
    });
    expect(drained).toEqual(
      Result.ok({ claimed: 1, terminal: 1, hasMore: false }),
    );
    expect(
      await db
        .select()
        .from(sanctionsContactMarks)
        .where(eq(sanctionsContactMarks.contactId, contact.id)),
    ).toEqual([]);
    const currentContact =
      (await db.select().from(contacts).where(eq(contacts.id, contact.id))).at(
        0,
      ) ?? panic("Contact missing");
    const currentMatch = await matchFor(contact.id);
    expect(currentMatch.contactFingerprint).toBe(
      monitoringFingerprint(currentContact),
    );
    expect((await screeningFor(contact.id)).contactFingerprint).toBe(
      currentMatch.contactFingerprint,
    );
    const activeEdition =
      (
        await db
          .select()
          .from(sanctionsSources)
          .where(eq(sanctionsSources.id, "eu"))
      ).at(0)?.activeEditionId ?? panic("EU active edition missing");
    expect(currentMatch.editionId).toBe(activeEdition);
    const freshOpen = await open(drainNow);
    expect(freshOpen.items).toHaveLength(1);
    expect(freshOpen.items.at(0) ?? panic("Open match missing")).toMatchObject({
      contactId: contact.id,
      evidence: currentMatch.match,
    });
    for (const disposition of ["dismissed", "confirmed"] as const) {
      await db
        .update(sanctionsContactMatches)
        .set({ disposition })
        .where(eq(sanctionsContactMatches.contactId, contact.id));
      expect((await open(drainNow)).items).toEqual([]);
    }
  },
  TIMEOUT,
);

test.each(["contact", "firm"] as const)(
  "%s opt-out rolls back every persisted effect on audit failure and audits duplicate requests once",
  async (scope) => {
    const organizationId = await isolatedOrganization();
    const tenantDb = scopedFor(organizationId);
    await activate("a");
    const contact = await addContact(organizationId);
    await commit(await prepare(contact), organizationId);
    await db
      .insert(organizationSettings)
      .values({ organizationId, sanctionsMonitoringMode: "enabled" });
    const snapshot = async () => ({
      contacts: await db
        .select()
        .from(contacts)
        .where(eq(contacts.organizationId, organizationId))
        .orderBy(contacts.id),
      settings: await db
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId)),
      coverage: await db
        .select()
        .from(sanctionsContactScreenings)
        .where(eq(sanctionsContactScreenings.organizationId, organizationId))
        .orderBy(
          sanctionsContactScreenings.contactId,
          sanctionsContactScreenings.sourceId,
        ),
      matches: await db
        .select()
        .from(sanctionsContactMatches)
        .where(eq(sanctionsContactMatches.organizationId, organizationId))
        .orderBy(
          sanctionsContactMatches.contactId,
          sanctionsContactMatches.sourceId,
          sanctionsContactMatches.sourceEntryId,
        ),
      events: await db
        .select()
        .from(sanctionsScreeningEvents)
        .where(eq(sanctionsScreeningEvents.organizationId, organizationId))
        .orderBy(sanctionsScreeningEvents.id),
      contactMarks: await db
        .select()
        .from(sanctionsContactMarks)
        .where(eq(sanctionsContactMarks.organizationId, organizationId))
        .orderBy(sanctionsContactMarks.contactId),
      organizationMarks: await db
        .select()
        .from(sanctionsOrganizationMarks)
        .where(eq(sanctionsOrganizationMarks.organizationId, organizationId)),
    });
    const before = await snapshot();
    expect(before.coverage).toHaveLength(1);
    expect(before.matches).toHaveLength(1);
    const failAudit = async () => panic("synthetic opt-out audit failure");
    await expectFailure(
      async () =>
        await tenantDb(async (tx) => {
          const options = {
            organizationId,
            contactId: contact.id,
            now,
            recordAuditEvent: failAudit,
          };
          if (scope === "contact") {
            return (await excludeSanctionsContact(tx, options)).unwrap();
          }
          return await disableSanctionsMonitoring(tx, options);
        }),
      "synthetic opt-out audit failure",
    );
    expect(await snapshot()).toEqual(before);
    const audits: AuditEvent[] = [];
    const record: AuditRecorder = async (...[, event]) => {
      audits.push(...(Array.isArray(event) ? event : [event]));
    };
    const run = async () =>
      await tenantDb(async (tx) => {
        const options = {
          organizationId,
          contactId: contact.id,
          now,
          recordAuditEvent: record,
        };
        if (scope === "contact") {
          return (await excludeSanctionsContact(tx, options)).unwrap();
        }
        return await disableSanctionsMonitoring(tx, options);
      });
    expect(await run()).toEqual({
      mode: scope === "contact" ? "excluded" : "disabled",
    });
    const first = await snapshot();
    expect(first.coverage).toHaveLength(
      scope === "contact" ? sanctionsSourceIds().length : 1,
    );
    expect(first.coverage.map(({ sourceId }) => sourceId).toSorted()).toEqual(
      scope === "contact" ? sanctionsSourceIds().toSorted() : ["eu"],
    );
    expect(
      first.coverage.every(
        ({ status, editionId, reason, checkedAt }) =>
          status === "excluded" &&
          editionId === null &&
          reason ===
            (scope === "contact"
              ? "contact-excluded"
              : "monitoring-disabled") &&
          checkedAt.getTime() === now.getTime(),
      ),
    ).toBe(true);
    expect(first.events).toEqual(before.events);
    expect(
      first.matches.map(({ contactId, sourceId, sourceEntryId, state }) => ({
        contactId,
        sourceId,
        sourceEntryId,
        state,
      })),
    ).toEqual([
      {
        contactId: contact.id,
        sourceId: "eu",
        sourceEntryId: "one",
        state: "lapsed",
      },
    ]);
    const audit = {
      action: AUDIT_ACTION.UPDATE,
      resourceType:
        scope === "contact"
          ? AUDIT_RESOURCE_TYPE.CONTACT
          : AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: scope === "contact" ? contact.id : organizationId,
      workspaceId: null,
      changes: {
        sanctionsMonitoringMode: {
          old: scope === "contact" ? "included" : "enabled",
          new: scope === "contact" ? "excluded" : "disabled",
        },
      },
    } satisfies AuditEvent;
    expect(audits).toEqual([audit]);
    await run();
    const replay = await snapshot();
    expect(replay.coverage).toEqual(first.coverage);
    expect(replay.matches).toEqual(first.matches);
    expect(replay.events).toEqual(first.events);
    expect(replay.contactMarks).toEqual(first.contactMarks);
    expect(replay.organizationMarks).toEqual(first.organizationMarks);
    expect(
      replay.contacts.map(({ updatedAt: _updatedAt, ...row }) => row),
    ).toEqual(first.contacts.map(({ updatedAt: _updatedAt, ...row }) => row));
    expect(replay.settings).toEqual(first.settings);
    expect(audits).toEqual([audit]);
  },
  TIMEOUT,
);
