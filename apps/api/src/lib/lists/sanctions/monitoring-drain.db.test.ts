import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { deepStrictEqual } from "node:assert/strict";
import { loadavg } from "node:os";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";
import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  SANCTIONS_SOURCES,
} from "@stll/sanctions";
import type { SanctionsEntry, SanctionsSource } from "@stll/sanctions";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  auditLogs,
  organizationSettings,
  sanctionsContactMarks,
  sanctionsMonitoringBackfills,
  sanctionsEditionFanouts,
  sanctionsOrganizationMarks,
  sanctionsContactScreenings,
  sanctionsContactMatches,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
  sanctionsScreeningEvents,
  systemAuditRuns,
  sanctionsSources,
  sanctionsEditions,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { advanceSanctionsMonitoringBackfill } from "@/api/lib/lists/sanctions/monitoring-backfill";
import { commitSanctionsMonitoringBatch } from "@/api/lib/lists/sanctions/monitoring-diff";
import {
  drainSanctionsContactMarks,
  SANCTIONS_MARK_LEASE_MS,
} from "@/api/lib/lists/sanctions/monitoring-drain";
import { queueSanctionsMonitoringBackfills } from "@/api/lib/lists/sanctions/monitoring-fanout";
import type { SanctionsMonitoringContact } from "@/api/lib/lists/sanctions/monitoring-input";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import { prepareSanctionsMonitoringRefresh } from "@/api/lib/lists/sanctions/monitoring-refresh";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import {
  createSanctionsIndexCache,
  sharedSanctionsIndexCache,
} from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubjects } from "@/api/lib/lists/sanctions/screening-service";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TIMEOUT = 120_000;
const orgId = toSafeId<"organization">("drain-org");
const otherOrg = toSafeId<"organization">("drain-other");
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
// PGlite raw execution returns { rows }; the production Bun driver returns the row array.
// Adapt once where the test hands the real transaction to production code.
const productionTransaction = (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) => {
  const { delete: deleteRows } = tx;
  return asTestRaw<Transaction>({
    select: tx.select.bind(tx),
    insert: tx.insert.bind(tx),
    update: tx.update.bind(tx),
    delete: deleteRows.bind(tx),
    execute: async (query: SQL) => (await tx.execute(query)).rows,
    rollback: tx.rollback.bind(tx),
    transaction: async (run: (nested: Transaction) => Promise<unknown>) =>
      await tx.transaction(
        async (nested) => await run(productionTransaction(nested)),
      ),
  });
};
const productionSchedulerDb = () =>
  asTestRaw<SchedulerDb>({
    select: db.select.bind(db),
    transaction: async (run: (tx: Transaction) => Promise<unknown>) =>
      await db.transaction(async (tx) => await run(productionTransaction(tx))),
  });
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
const scopedDb = scopedFor(orgId);
const drainSuccessfully = async (
  options: Parameters<typeof drainSanctionsContactMarks>[0],
) => (await drainSanctionsContactMarks(options)).unwrap();
const requestSanctionsMonitoringRefresh = async (
  tx: Transaction,
  options: Parameters<typeof prepareSanctionsMonitoringRefresh>[0],
) => {
  const request = prepareSanctionsMonitoringRefresh(options);
  switch (request.type) {
    case "organization":
      await tx
        .insert(sanctionsOrganizationMarks)
        .values(request.rows.at(0) ?? panic("Organization mark missing"))
        .onConflictDoNothing();
      return;
    case "contacts":
      if (request.rows.length === 0) {
        return;
      }
      await tx
        .insert(sanctionsContactMarks)
        .values(request.rows)
        .onConflictDoNothing();
      return;
  }
};
const futureNow = () => new Date(Date.now() + 1000);

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await client.exec(`GRANT SELECT, INSERT, UPDATE ON sanctions_edition_fanouts TO stella_ingestion;
    ALTER TABLE sanctions_edition_fanouts ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_edition_fanouts FORCE ROW LEVEL SECURITY;`);
  await client.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_monitoring_backfills TO stella;
    ALTER TABLE sanctions_monitoring_backfills ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_monitoring_backfills FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON sanctions_edition_fanouts FROM stella; GRANT SELECT ON sanctions_edition_fanouts TO stella;`);
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
    .values(
      sanctionsSourceIds().map((id) => ({
        id,
        issuer: SANCTIONS_SOURCE_CONFIG[id].issuer,
        markerUrl: SANCTIONS_SOURCE_CONFIG[id].markerUrl,
      })),
    )
    .onConflictDoNothing();
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
const errorMessages = (error: unknown): string =>
  error instanceof Error
    ? `${error.message} ${"cause" in error ? errorMessages(error.cause) : ""}`
    : String(error);

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
    const abortAfterClaim: ScopedDb = async (run) =>
      await scopedDb(async (tx) => {
        const value = await run(tx);
        controller.abort(new Error("synthetic drain crash"));
        controller.signal.throwIfAborted();
        return value;
      });
    const now = futureNow();
    const failedDrain = await drainSanctionsContactMarks({
      db: abortAfterClaim,
      organizationId: orgId,
      now,
      signal: controller.signal,
    });
    expect(failedDrain.isErr()).toBe(true);
    if (failedDrain.isErr()) {
      expect(errorMessages(failedDrain.error)).toContain(
        "synthetic drain crash",
      );
    }
    expect(await markFor(contact.id)).toBeDefined();
    await drainSuccessfully({
      db: scopedDb,
      organizationId: orgId,
      now: new Date(now.getTime() + 1),
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
    await drainSuccessfully({
      db: editAfterClaim,
      organizationId: orgId,
      now: futureNow(),
      signal: new AbortController().signal,
    });
    expect(await markFor(contact.id)).toBeDefined();
    await drainSuccessfully({
      db: scopedDb,
      organizationId: orgId,
      now: futureNow(),
      signal: new AbortController().signal,
    });
    expect(await markFor(contact.id)).toBeUndefined();
  },
  TIMEOUT,
);

test(
  "audits exactly one successful drain, none when idle, and rolls queue work back on audit failure",
  async () => {
    const organizationId = toSafeId<"organization">("drain-audit-org");
    await db.insert(organization).values({
      id: organizationId,
      name: "Drain audit fixture",
      slug: organizationId,
      createdAt: new Date(),
    });
    const scoped = scopedFor(organizationId);
    const now = futureNow();
    const audits = async () =>
      await scoped(
        async (tx) =>
          await tx
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId)),
      );
    const drain = async () =>
      await drainSuccessfully({
        db: scoped,
        organizationId,
        now,
        signal: new AbortController().signal,
      });

    expect(await drain()).toEqual({ claimed: 0, terminal: 0, hasMore: false });
    expect(await audits()).toHaveLength(0);

    const contact = await scoped(
      async (tx) =>
        (
          await tx
            .insert(contacts)
            .values({
              organizationId,
              type: "person",
              displayName: "Drain audit subject",
            })
            .returning()
        ).at(0) ?? panic("Drain audit contact missing"),
    );
    const queuedMark =
      (
        await scoped(
          async (tx) =>
            await tx
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, contact.id)),
        )
      ).at(0) ?? panic("Drain audit mark missing");

    await client.exec(`CREATE FUNCTION reject_drain_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = 'system:sanctions-monitoring-drain' THEN RAISE EXCEPTION 'synthetic drain audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_drain_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_drain_audit();`);
    try {
      const failedDrain = await drainSanctionsContactMarks({
        db: scoped,
        organizationId,
        now,
        signal: new AbortController().signal,
      });
      expect(failedDrain.isErr()).toBe(true);
      if (failedDrain.isErr()) {
        expect(errorMessages(failedDrain.error)).toContain(
          "synthetic drain audit failure",
        );
      }
      expect(await audits()).toHaveLength(0);
      expect(await markFor(contact.id)).toMatchObject({
        generation: queuedMark.generation,
        scheduledAt: queuedMark.scheduledAt,
      });
      expect(
        await scoped(
          async (tx) =>
            await tx
              .select()
              .from(sanctionsContactScreenings)
              .where(eq(sanctionsContactScreenings.contactId, contact.id)),
        ),
      ).toHaveLength(0);
    } finally {
      await client.exec(
        "DROP TRIGGER reject_drain_audit ON audit_logs; DROP FUNCTION reject_drain_audit();",
      );
    }

    expect(await drain()).toEqual({ claimed: 1, terminal: 1, hasMore: false });
    expect(await markFor(contact.id)).toBeUndefined();
    const events = await audits();
    expect(events).toHaveLength(1);
    expect(events.at(0)?.userId).toBe("system:sanctions-monitoring-drain");
  },
  TIMEOUT,
);

test(
  "durable refresh requests are idempotent, tenant scoped and atomic with caller rollback",
  async () => {
    const contact = await addContact();
    await db
      .delete(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    expect(
      await rejectionOf(
        scopedDb(async (tx) => {
          await requestSanctionsMonitoringRefresh(tx, {
            organizationId: orgId,
            contactIds: [contact.id],
          });
          throw new Error("synthetic audit rollback");
        }),
      ),
    ).toMatchObject({ message: "synthetic audit rollback" });
    expect(await markFor(contact.id)).toBeUndefined();
    await scopedDb(async (tx) => {
      await requestSanctionsMonitoringRefresh(tx, {
        organizationId: orgId,
        contactIds: [contact.id, contact.id],
      });
      await requestSanctionsMonitoringRefresh(tx, {
        organizationId: orgId,
        contactIds: [contact.id],
      });
      await requestSanctionsMonitoringRefresh(tx, { organizationId: orgId });
      await requestSanctionsMonitoringRefresh(tx, { organizationId: orgId });
    });
    expect((await markFor(contact.id))?.generation).toBe(1n);
    expect(
      await rejectionOf(
        scopedDb(
          async (tx) =>
            await requestSanctionsMonitoringRefresh(tx, {
              organizationId: orgId,
              contactIds: Array.from({ length: 10_001 }, () => contact.id),
            }),
        ),
      ),
    ).toMatchObject({ message: expect.stringContaining("contact cap") });
    expect(
      await scopedFor(otherOrg)(
        async (tx) => await tx.select().from(sanctionsOrganizationMarks),
      ),
    ).toEqual([]);
  },
  TIMEOUT,
);

const emptyEdition = async () => {
  const editionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
  const hash = new Bun.CryptoHasher("sha256").update(editionId).digest("hex");
  await db.insert(sanctionsEditions).values({
    id: editionId,
    sourceId: "eu",
    markerKey: hash,
    contentHash: hash,
    state: "ready",
    publishedAt: "2026-09-30",
    entryCount: 0,
  });
  await db
    .update(sanctionsSources)
    .set({ activeEditionId: editionId, lastSuccessfulVerifiedAt: new Date() })
    .where(eq(sanctionsSources.id, "eu"));
  return editionId;
};

test(
  "backfill checkpoints roll back and replay; activation supersedes older work",
  async () => {
    const editionId = await emptyEdition();
    const contact = await addContact();
    await scopedDb(async (tx) => {
      await tx
        .insert(sanctionsMonitoringBackfills)
        .values({ organizationId: orgId, sourceId: "eu", editionId })
        .onConflictDoUpdate({
          target: [
            sanctionsMonitoringBackfills.organizationId,
            sanctionsMonitoringBackfills.sourceId,
          ],
          set: {
            editionId,
            cursorContactId: null,
            status: "pending",
            scheduledAt: new Date(),
          },
        });
    });
    await client.exec(`CREATE FUNCTION reject_backfill_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cursor failure'; END $$;
    CREATE TRIGGER backfill_checkpoint_failure BEFORE UPDATE ON sanctions_monitoring_backfills FOR EACH ROW WHEN (OLD.cursor_contact_id IS DISTINCT FROM NEW.cursor_contact_id) EXECUTE FUNCTION reject_backfill_checkpoint();`);
    const now = futureNow();
    const attempt = await Result.tryPromise(
      async () =>
        await advanceSanctionsMonitoringBackfill({
          db: scopedDb,
          organizationId: orgId,
          sourceId: "eu",
          now,
          signal: new AbortController().signal,
        }),
    );
    expect(attempt.isErr()).toBe(true);
    if (attempt.isErr()) {
      expect(errorMessages(attempt.error)).toContain(
        "synthetic cursor failure",
      );
    }
    expect(
      (await db.select().from(sanctionsMonitoringBackfills)).at(0)
        ?.cursorContactId,
    ).toBeNull();
    expect(
      await scopedDb(
        async (tx) =>
          await tx
            .select()
            .from(sanctionsContactScreenings)
            .where(eq(sanctionsContactScreenings.contactId, contact.id)),
      ),
    ).toEqual([]);
    await client.exec(
      "DROP TRIGGER backfill_checkpoint_failure ON sanctions_monitoring_backfills; DROP FUNCTION reject_backfill_checkpoint()",
    );
    expect(
      await advanceSanctionsMonitoringBackfill({
        db: scopedDb,
        organizationId: orgId,
        sourceId: "eu",
        now: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 1),
        signal: new AbortController().signal,
      }),
    ).toBe("advanced");
    expect(
      (await db.select().from(sanctionsMonitoringBackfills)).at(0)?.status,
    ).toBe("complete");
    expect(
      await scopedFor(otherOrg)(
        async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
      ),
    ).toEqual([]);
    const nextEdition = await emptyEdition();
    await scopedDb(async (tx) => {
      await tx
        .update(sanctionsMonitoringBackfills)
        .set({
          editionId: nextEdition,
          cursorContactId: null,
          status: "pending",
          scheduledAt: new Date(),
        })
        .where(eq(sanctionsMonitoringBackfills.organizationId, orgId));
    });
    let newerEdition: typeof nextEdition | undefined;
    const activateAfterClaim: ScopedDb = async (run) => {
      const value = await scopedDb(run);
      newerEdition ??= await emptyEdition();
      return value;
    };
    expect(
      await advanceSanctionsMonitoringBackfill({
        db: activateAfterClaim,
        organizationId: orgId,
        sourceId: "eu",
        now: futureNow(),
        signal: new AbortController().signal,
      }),
    ).toBe("superseded");
    expect(
      (await db.select().from(sanctionsMonitoringBackfills)).at(0)?.editionId,
    ).toBe(newerEdition);
    expect(
      (await db.select().from(sanctionsEditionFanouts)).find(
        ({ sourceId }) => sourceId === "eu",
      )?.editionId,
    ).toBe(newerEdition);
  },
  TIMEOUT,
);

const expiredWorkerRace = async (mode: "activation" | "stale") => {
  const organizationId = toSafeId<"organization">(`expired-${mode}`);
  await db.insert(organization).values({
    id: organizationId,
    name: mode,
    slug: organizationId,
    createdAt: new Date(),
  });
  const tenant = scopedFor(organizationId);
  await emptyEdition();
  await tenant(
    async (tx) =>
      await tx.insert(contacts).values({
        organizationId,
        type: "person",
        displayName: "Expired Worker",
      }),
  );
  const now =
    mode === "stale"
      ? new Date(Date.now() - SANCTIONS_MARK_LEASE_MS - 1)
      : futureNow();
  await db
    .update(sanctionsSources)
    .set({
      lastSuccessfulVerifiedAt: new Date(
        Date.now() -
          SANCTIONS_SOURCE_CONFIG.eu.freshnessMs -
          (mode === "stale" ? 1000 : 60_000),
      ),
    })
    .where(eq(sanctionsSources.id, "eu"));
  await tenant(
    async (tx) =>
      await tx
        .update(sanctionsContactMarks)
        .set({
          scheduledAt: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS),
        })
        .where(eq(sanctionsContactMarks.organizationId, organizationId)),
  );
  const claimedMarks = await tenant(
    async (tx) => await tx.select().from(sanctionsContactMarks),
  );
  if (claimedMarks.length === 0) {
    panic("Expired worker mark missing");
  }
  const contactRows = await tenant(
    async (tx) => await tx.select().from(contacts),
  );

  const snapshot = async () =>
    await tenant(async (tx) => ({
      coverage: await tx.select().from(sanctionsContactScreenings),
      events: await tx.select().from(sanctionsScreeningEvents),
    }));
  let replacement: Awaited<ReturnType<typeof snapshot>> | undefined;
  const stallAfterFreshnessRead: ScopedDb = async (run) => {
    const value = await tenant(run);
    const first = Array.isArray(value) ? value.at(0) : undefined;
    if (
      replacement === undefined &&
      typeof first === "object" &&
      first !== null &&
      "activeEditionId" in first
    ) {
      if (mode === "activation") {
        await emptyEdition();
      }
      await drainSuccessfully({
        db: tenant,
        organizationId,
        now: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 1),
        signal: new AbortController().signal,
      });
      replacement = await snapshot();
      expect(
        replacement.coverage.find(({ sourceId }) => sourceId === "eu")?.status,
      ).toBe(mode === "activation" ? "clear" : "unavailable");
    }
    return value;
  };
  const prepared = await prepareMonitoringContacts({
    sourceSelection: { type: "all" },
    db: stallAfterFreshnessRead,
    contactRows,
    now,
  });
  if (replacement === undefined) {
    panic("Replacement worker did not finish");
  }
  let committed = 0;
  for (const source of sanctionsSourceIds()) {
    const results = prepared.map(
      ({ contactId, contactFingerprint, lists }) => ({
        contactId,
        contactFingerprint,
        outcome:
          lists.find((list) => list.source === source) ??
          panic("Expired worker source outcome missing"),
      }),
    );
    committed += (
      await commitSanctionsMonitoringBatch({
        db: tenant,
        organizationId,
        source,
        results,
        now,
        claim: {
          leaseExpiresAt: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS),
          marks: claimedMarks.map(({ contactId, generation }) => ({
            contactId,
            generation,
          })),
        },
      })
    ).length;
  }
  expect(committed).toBe(0);
  expect(await snapshot()).toEqual(replacement);
  expect(
    await tenant(async (tx) => await tx.select().from(sanctionsContactMarks)),
  ).toEqual([]);
};

test(
  "expired unavailable work cannot overwrite a replacement edition's success",
  async () => await expiredWorkerRace("activation"),
  TIMEOUT,
);
test(
  "expired clear work cannot overwrite same-edition stale coverage",
  async () => await expiredWorkerRace("stale"),
  TIMEOUT,
);

test(
  "a crash between contact pages preserves the cursor and resumes to completion",
  async () => {
    const organizationId = toSafeId<"organization">("cursor-org");
    await db.insert(organization).values({
      id: organizationId,
      name: "Cursor",
      slug: organizationId,
      createdAt: new Date(),
    });
    const tenant = scopedFor(organizationId);
    const editionId = await emptyEdition();
    await tenant(async (tx) => {
      await tx.insert(contacts).values(
        Array.from({ length: 105 }, () => ({
          organizationId,
          type: "person" as const,
          displayName: "Cursor Person",
        })),
      );
      await tx
        .insert(sanctionsMonitoringBackfills)
        .values({ organizationId, sourceId: "eu", editionId });
    });
    const advance = async (
      scoped: ScopedDb,
      now: Date,
      signal = new AbortController().signal,
    ) =>
      await advanceSanctionsMonitoringBackfill({
        db: scoped,
        organizationId,
        sourceId: "eu",
        now,
        signal,
      });
    const now = futureNow();
    expect(await advance(tenant, now)).toBe("advanced");
    const job = async () =>
      (
        await tenant(
          async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
        )
      ).at(0) ?? panic("Job missing");
    const firstPage = await job();
    expect(firstPage.status).toBe("pending");
    expect(firstPage.cursorContactId).not.toBeNull();
    const abort = new AbortController();
    const crashAfterClaim: ScopedDb = async (run) => {
      const result = await tenant(run);
      abort.abort(new Error("synthetic mid-cursor crash"));
      return result;
    };
    const crashed = await Result.tryPromise(
      async () => await advance(crashAfterClaim, now, abort.signal),
    );
    expect(crashed.isErr()).toBe(true);
    if (crashed.isErr()) {
      expect(errorMessages(crashed.error)).toContain(
        "synthetic mid-cursor crash",
      );
    }
    expect((await job()).cursorContactId).toBe(firstPage.cursorContactId);
    expect(
      await advance(
        tenant,
        new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 1),
      ),
    ).toBe("advanced");
    expect((await job()).status).toBe("complete");
    expect(
      await tenant(
        async (tx) => await tx.select().from(sanctionsContactScreenings),
      ),
    ).toHaveLength(105);
  },
  TIMEOUT,
);

test(
  "activation fans out bounded organization pages and refreshes unavailable coverage",
  async () => {
    const organizationId = toSafeId<"organization">("fanout-000");
    await db.insert(organization).values(
      Array.from({ length: 105 }, (_, i) => ({
        id: `fanout-${String(i).padStart(3, "0")}`,
        name: "Fanout",
        createdAt: new Date(),
        slug: `fanout-${String(i).padStart(3, "0")}`,
      })),
    );
    await scopedFor(organizationId)(
      async (tx) =>
        await requestSanctionsMonitoringRefresh(tx, { organizationId }),
    );
    const now = futureNow();
    const systemDb = productionSchedulerDb();
    const first = await queueSanctionsMonitoringBackfills({
      runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
      db: systemDb,
      now,
    });
    expect(first.fanned).toBe(100);
    const second = await queueSanctionsMonitoringBackfills({
      runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
      db: systemDb,
      now,
    });
    expect(second.fanned).toBeGreaterThan(0);
    expect(second.fanned).toBeLessThan(100);
    expect(
      await scopedFor(organizationId)(
        async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
      ),
    ).toHaveLength(sanctionsSourceIds().length);
    const eu = async () =>
      (
        await db
          .select()
          .from(sanctionsEditionFanouts)
          .where(eq(sanctionsEditionFanouts.sourceId, "eu"))
      ).at(0) ?? panic("Fanout missing");
    expect((await eu()).freshnessStatus).toBe("fresh");
    await queueSanctionsMonitoringBackfills({
      runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
      db: systemDb,
      now: new Date(now.getTime() + 49 * 60 * 60 * 1000),
    });
    expect((await eu()).freshnessStatus).toBe("unavailable");
    expect((await eu()).cursorOrganizationId).toBeNull();
    await queueSanctionsMonitoringBackfills({
      runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
      db: systemDb,
      now,
    });
    expect((await eu()).freshnessStatus).toBe("fresh");
    expect((await eu()).cursorOrganizationId).toBeNull();
    const denied = await Result.tryPromise(
      async () =>
        await scopedFor(organizationId)(
          async (tx) =>
            await tx
              .update(sanctionsEditionFanouts)
              .set({ status: "complete" })
              .where(eq(sanctionsEditionFanouts.sourceId, "eu")),
        ),
    );
    expect(denied.isErr()).toBe(true);
    if (denied.isErr()) {
      expect(errorMessages(denied.error)).toContain("permission denied");
    }
  },
  TIMEOUT,
);

test(
  "measure three quiet-load imports and unrelated updates with and without triggers",
  async () => {
    const organizationId = toSafeId<"organization">("trigger-benchmark");
    await db.insert(organization).values({
      id: organizationId,
      name: "Trigger benchmark",
      slug: organizationId,
      createdAt: new Date(),
    });
    const tenant = scopedFor(organizationId);
    const importRows = async (tx: Transaction) =>
      await tx.execute(sql`
      INSERT INTO public.contacts (id, organization_id, type, display_name)
      SELECT gen_random_uuid(), ${organizationId}, 'person', 'Import Person' FROM generate_series(1, 10000)
    `);
    const importSample = async () => {
      let elapsed: number | undefined;
      try {
        await tenant(async (tx) => {
          const started = performance.now();
          await importRows(tx);
          elapsed = performance.now() - started;
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
      return elapsed ?? panic("Import sample missing");
    };
    const updateSample = async () =>
      await tenant(async (tx) => {
        const started = performance.now();
        await tx.execute(
          sql`UPDATE public.contacts SET notes = gen_random_uuid()::text WHERE organization_id = ${organizationId}`,
        );
        return performance.now() - started;
      });
    const measure = async (operation: "import" | "unrelated-update") => {
      const trigger =
        operation === "import"
          ? "contacts_sanctions_mark_insert"
          : "contacts_sanctions_mark_update";
      const measureSample =
        operation === "import" ? importSample : updateSample;
      const runs: {
        baselineMs: number;
        triggeredMs: number;
        ratio: number;
        load: number | undefined;
      }[] = [];
      const setTrigger = async (enabled: boolean) =>
        await client.exec(
          `ALTER TABLE public.contacts ${enabled ? "ENABLE" : "DISABLE"} TRIGGER ${trigger}`,
        );
      const measureNextRun = async (index: number): Promise<void> => {
        if (index === 3) {
          return;
        }
        const load = loadavg().at(0);
        // Alternate ordering so a warmed cache does not always favor the same case.
        const triggeredFirst = index % 2 === 1;
        await setTrigger(triggeredFirst);
        const first = await measureSample();
        await setTrigger(!triggeredFirst);
        const second = await measureSample();
        const baselineMs = triggeredFirst ? second : first;
        const triggeredMs = triggeredFirst ? first : second;
        runs.push({
          baselineMs,
          triggeredMs,
          ratio: triggeredMs / baselineMs,
          load,
        });
        await measureNextRun(index + 1);
      };
      try {
        await measureNextRun(0);
      } finally {
        await setTrigger(true);
      }
      console.log(
        JSON.stringify({
          benchmark: `sanctions-contact-${operation}`,
          database: "pglite",
          contacts: 10_000,
          runs,
          medianRatio: runs
            .map(({ ratio }) => ratio)
            .toSorted((a, b) => a - b)
            .at(1),
        }),
      );
      expect(runs).toHaveLength(3);
    };
    await measure("import");
    await tenant(importRows);
    await measure("unrelated-update");
    const marks = await tenant(
      async (tx) =>
        await tx.execute<{
          count: number;
          minimum: string;
          maximum: string;
        }>(sql`
      SELECT count(*)::integer AS count, min(generation)::text AS minimum, max(generation)::text AS maximum
      FROM public.sanctions_contact_marks WHERE organization_id = ${organizationId}
    `),
    );
    expect(marks.at(0)).toEqual({ count: 10_000, minimum: "1", maximum: "1" });
  },
  TIMEOUT,
);

const isolatedMonitoringOrganization = async (name: string) => {
  const id = toSafeId<"organization">(name);
  await db.insert(organization).values({
    id,
    name,
    slug: name,
    createdAt: new Date(),
  });
  return { organizationId: id, scoped: scopedFor(id) };
};

const seedIdentityEdition = async (now: Date) => {
  const editionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
  const entries = [
    { sourceEntryId: "identity-a", name: "Alexandrov Zhuravlev" },
    { sourceEntryId: "identity-d", name: "Kwame Nkrumah" },
  ];
  const hash = new Bun.CryptoHasher("sha256").update(editionId).digest("hex");
  await db.insert(sanctionsEditions).values({
    id: editionId,
    sourceId: "eu",
    markerKey: hash,
    contentHash: hash,
    state: "ready",
    publishedAt: "2026-09-30",
    entryCount: entries.length,
  });
  for (const { sourceEntryId, name } of entries) {
    const payload = {
      source: "eu",
      issuer: "EU",
      sourceId: sourceEntryId,
      referenceNumber: null,
      entityType: "person",
      names: [{ name, quality: "strong" }],
      birthDates: [],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://example.test/identity",
    } satisfies SanctionsEntry;
    const contentHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    await db
      .insert(sanctionsEntryPayloads)
      .values({ contentHash, payload })
      .onConflictDoNothing();
    await db
      .insert(sanctionsEditionEntries)
      .values({ editionId, sourceEntryId, contentHash });
  }
  await db
    .update(sanctionsSources)
    .set({
      activeEditionId: editionId,
      lastSuccessfulVerifiedAt: now,
    })
    .where(eq(sanctionsSources.id, "eu"));
  return editionId;
};

test(
  "batched screening preserves subject identity across invalid slots and reordered batches",
  async () => {
    const { organizationId, scoped } =
      await isolatedMonitoringOrganization("drain-identity");
    const previousSource =
      (
        await db
          .select()
          .from(sanctionsSources)
          .where(eq(sanctionsSources.id, "eu"))
      ).at(0) ?? panic("EU source missing");
    try {
      const editionId = await seedIdentityEdition(futureNow());
      const subjects = [
        { displayName: "Alexandrov Zhuravlev", entryIds: ["identity-a"] },
        { displayName: "!!!", entryIds: [] },
        { displayName: "Marisol Benitez", entryIds: [] },
        { displayName: "Kwame Nkrumah", entryIds: ["identity-d"] },
      ];
      const rows = await scoped(
        async (tx) =>
          await tx
            .insert(contacts)
            .values(
              Array.from({ length: 104 }, (_, index) => ({
                organizationId,
                type: "person" as const,
                displayName:
                  subjects.at(index % subjects.length)?.displayName ??
                  panic("Identity fixture missing"),
              })),
            )
            .returning(),
      );
      const now = futureNow();
      const independent = await Promise.all(
        subjects.map(async (fixture) => {
          const contact =
            rows.find(
              ({ displayName }) => displayName === fixture.displayName,
            ) ?? panic("Identity contact missing");
          const result =
            (
              await screenSanctionsSubjects({
                sourceSelection: { type: "all" },
                db: scoped,
                subjects: [monitoringSubject(contact)],
                practiceJurisdictions: [],
                resultMode: "complete",
                now,
              })
            ).at(0) ?? panic("Independent screening missing");
          if (fixture.displayName === "!!!") {
            expect(result.isErr()).toBe(true);
            return { displayName: fixture.displayName, outcome: null };
          }
          expect(result.isOk()).toBe(true);
          if (result.isErr()) {
            panic("Valid independent subject rejected");
          }
          const outcome =
            result.value.lists.find(({ source }) => source === "eu") ??
            panic("Independent EU result missing");
          expect(
            outcome.possibleMatches
              .map(({ sourceEntryId }) => sourceEntryId)
              .toSorted(),
          ).toEqual(fixture.entryIds);
          return { displayName: fixture.displayName, outcome };
        }),
      );
      const reordered = rows.toReversed();
      const prepared = await prepareMonitoringContacts({
        sourceSelection: { type: "all" },
        db: scoped,
        contactRows: reordered.slice(0, 100),
        now,
      });
      prepared.push(
        ...(await prepareMonitoringContacts({
          sourceSelection: { type: "all" },
          db: scoped,
          contactRows: reordered.slice(100),
          now,
        })),
      );
      for (const contact of reordered) {
        const outcome =
          prepared
            .find(({ contactId }) => contactId === contact.id)
            ?.lists.find(({ source }) => source === "eu") ??
          panic("Prepared identity missing");
        const expected = (
          independent.find(
            ({ displayName }) => displayName === contact.displayName,
          ) ?? panic("Independent identity missing")
        ).outcome;
        if (expected === null) {
          expect(outcome).toMatchObject({
            status: "unavailable",
            reason: "load-failed",
            possibleMatches: [],
          });
        } else {
          expect(outcome).toEqual(expected);
        }
      }
      const drain = async () =>
        await drainSuccessfully({
          db: scoped,
          organizationId,
          now,
          signal: new AbortController().signal,
        });
      expect(await drain()).toEqual({
        claimed: 100,
        terminal: 100,
        hasMore: true,
      });
      expect(await drain()).toEqual({
        claimed: 4,
        terminal: 4,
        hasMore: false,
      });
      const census = async () =>
        await scoped(async (tx) => ({
          matches: await tx.select().from(sanctionsContactMatches),
          coverage: await tx.select().from(sanctionsContactScreenings),
          events: await tx.select().from(sanctionsScreeningEvents),
          marks: await tx.select().from(sanctionsContactMarks),
        }));
      const first = await census();
      expect(first.marks).toEqual([]);
      for (const contact of rows) {
        const fixture =
          subjects.find(
            ({ displayName }) => displayName === contact.displayName,
          ) ?? panic("Identity fixture missing");
        expect(
          first.matches
            .filter(({ contactId }) => contactId === contact.id)
            .map(({ sourceEntryId }) => sourceEntryId)
            .toSorted(),
        ).toEqual(fixture.entryIds);
        expect(
          first.events
            .filter(({ contactId }) => contactId === contact.id)
            .map(({ sourceId, sourceEntryId, type }) => ({
              sourceId,
              sourceEntryId,
              type,
            })),
        ).toEqual(
          fixture.entryIds.map((sourceEntryId) => ({
            sourceId: "eu",
            sourceEntryId,
            type: "new",
          })),
        );
        const coverage = first.coverage.filter(
          ({ contactId }) => contactId === contact.id,
        );
        expect(coverage.map(({ sourceId }) => sourceId).toSorted()).toEqual(
          sanctionsSourceIds().toSorted(),
        );
        expect(
          coverage.every(
            ({ contactFingerprint }) =>
              contactFingerprint === monitoringFingerprint(contact),
          ),
        ).toBe(true);
        const eu = coverage.find(({ sourceId }) => sourceId === "eu");
        expect(eu).toMatchObject(
          contact.displayName === "!!!"
            ? { status: "unavailable", reason: "load-failed", editionId }
            : {
                status: fixture.entryIds.length ? "possible-match" : "clear",
                reason: null,
                editionId,
              },
        );
        if (contact.displayName === "!!!") {
          expect(coverage.every(({ status }) => status === "unavailable")).toBe(
            true,
          );
        }
      }
      await scoped(
        async (tx) =>
          await requestSanctionsMonitoringRefresh(tx, {
            organizationId,
            contactIds: reordered.map(({ id }) => id),
          }),
      );
      const replayNow = futureNow();
      for (let batch = 0; batch < 2; batch += 1) {
        await drainSuccessfully({
          db: scoped,
          organizationId,
          now: replayNow,
          signal: new AbortController().signal,
        });
      }
      const replay = await census();
      expect(replay.marks).toEqual([]);
      expect(
        replay.matches
          .map(({ updatedAt: _updatedAt, ...row }) => row)
          .toSorted((a, b) => compareCodeUnit(a.contactId, b.contactId)),
      ).toEqual(
        first.matches
          .map(({ updatedAt: _updatedAt, ...row }) => row)
          .toSorted((a, b) => compareCodeUnit(a.contactId, b.contactId)),
      );
      expect(replay.events).toEqual(first.events);
      expect(
        replay.coverage
          .map(({ checkedAt: _checkedAt, ...row }) => row)
          .toSorted((a, b) =>
            compareCodeUnit(
              `${a.contactId}:${a.sourceId}`,
              `${b.contactId}:${b.sourceId}`,
            ),
          ),
      ).toEqual(
        first.coverage
          .map(({ checkedAt: _checkedAt, ...row }) => row)
          .toSorted((a, b) =>
            compareCodeUnit(
              `${a.contactId}:${a.sourceId}`,
              `${b.contactId}:${b.sourceId}`,
            ),
          ),
      );
    } finally {
      await db
        .update(sanctionsSources)
        .set({
          activeEditionId: previousSource.activeEditionId,
          lastSuccessfulVerifiedAt: previousSource.lastSuccessfulVerifiedAt,
        })
        .where(eq(sanctionsSources.id, "eu"));
    }
  },
  TIMEOUT,
);

test(
  "contact marks finish only after every configured source has terminal coverage and retry a later source failure",
  async () => {
    const { organizationId, scoped } = await isolatedMonitoringOrganization(
      "drain-source-census",
    );
    const now = futureNow();
    const sources = sanctionsSourceIds();
    expect(sources.length).toBeGreaterThan(2);
    const oldSources = await db.select().from(sanctionsSources);
    try {
      for (const sourceId of sources) {
        const id = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
        const hash = new Bun.CryptoHasher("sha256").update(id).digest("hex");
        await db.insert(sanctionsEditions).values({
          id,
          sourceId,
          markerKey: hash,
          contentHash: hash,
          state: "ready",
          publishedAt: "2026-09-30",
          entryCount: 0,
        });
        await db
          .update(sanctionsSources)
          .set({
            activeEditionId: id,
            lastSuccessfulVerifiedAt: now,
            lastFailureCode: null,
            lastFailureAt: null,
          })
          .where(eq(sanctionsSources.id, sourceId));
      }
      const contact =
        (
          await scoped(
            async (tx) =>
              await tx
                .insert(contacts)
                .values({
                  organizationId,
                  type: "person",
                  displayName: "Marisol Benitez",
                })
                .returning(),
          )
        ).at(0) ?? panic("Source census contact missing");
      const drain = async (attemptAt: Date) =>
        await drainSuccessfully({
          db: scoped,
          organizationId,
          now: attemptAt,
          signal: new AbortController().signal,
        });
      const census = async () =>
        await scoped(async (tx) => ({
          coverage: await tx.select().from(sanctionsContactScreenings),
          events: await tx.select().from(sanctionsScreeningEvents),
          marks: await tx.select().from(sanctionsContactMarks),
          audits: await tx
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId)),
        }));
      await drain(futureNow());
      const previous = await census();
      expect(
        previous.coverage.map(({ sourceId }) => sourceId).toSorted(),
      ).toEqual(sources.toSorted());
      expect(previous.coverage.every(({ status }) => status === "clear")).toBe(
        true,
      );
      await seedIdentityEdition(now);
      for (const [index, sourceId] of sources.entries()) {
        if (index % 3 === 1) {
          await db
            .update(sanctionsSources)
            .set({
              lastSuccessfulVerifiedAt: new Date(
                now.getTime() -
                  SANCTIONS_SOURCE_CONFIG[sourceId].freshnessMs -
                  SANCTIONS_MARK_LEASE_MS,
              ),
            })
            .where(eq(sanctionsSources.id, sourceId));
        }
        if (index % 3 === 2) {
          await db
            .update(sanctionsSources)
            .set({ activeEditionId: null, lastSuccessfulVerifiedAt: null })
            .where(eq(sanctionsSources.id, sourceId));
        }
      }
      const updated =
        (
          await scoped(
            async (tx) =>
              await tx
                .update(contacts)
                .set({ displayName: "Alexandrov Zhuravlev" })
                .where(eq(contacts.id, contact.id))
                .returning(),
          )
        ).at(0) ?? panic("Updated source census contact missing");
      const attemptNow = futureNow();
      const expected =
        (
          await screenSanctionsSubjects({
            sourceSelection: { type: "all" },
            db: scoped,
            subjects: [monitoringSubject(updated)],
            practiceJurisdictions: [],
            now: attemptNow,
            resultMode: "complete",
          })
        ).at(0) ?? panic("Source census screening missing");
      expect(expected.isOk()).toBe(true);
      if (expected.isErr()) {
        panic("Source census subject rejected");
      }
      expect(
        expected.value.lists.map(({ source }) => source).toSorted(),
      ).toEqual(sources.toSorted());
      expect(
        new Set(
          expected.value.lists.map(({ status, reason }) =>
            JSON.stringify([status, reason]),
          ),
        ).size,
      ).toBeGreaterThanOrEqual(4);
      const failingSource = sources.at(2) ?? panic("Later source missing");
      await client.exec(`CREATE FUNCTION reject_later_source_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic later source failure'; END $$;
      CREATE TRIGGER later_source_coverage_failure BEFORE INSERT OR UPDATE ON sanctions_contact_screenings FOR EACH ROW WHEN (NEW.contact_id = '${contact.id}' AND NEW.source_id = '${failingSource}') EXECUTE FUNCTION reject_later_source_coverage();`);
      try {
        const beforeAttempt = await census();
        const failed = await Result.tryPromise(
          async () => await drain(attemptNow),
        );
        expect(failed.isErr()).toBe(true);
        if (failed.isErr()) {
          expect(errorMessages(failed.error)).toContain(
            "synthetic later source failure",
          );
        }
        const afterFailure = await census();
        expect(afterFailure.coverage).toEqual(beforeAttempt.coverage);
        expect(afterFailure.events).toEqual(beforeAttempt.events);
        expect(afterFailure.marks).toHaveLength(beforeAttempt.marks.length);
        expect(afterFailure.marks.at(0)).toMatchObject({
          generation: beforeAttempt.marks.at(0)?.generation,
          scheduledAt: beforeAttempt.marks.at(0)?.scheduledAt,
          attemptCount: 1,
        });
        expect(
          afterFailure.marks.at(0)?.nextAttemptAt.getTime(),
        ).toBeGreaterThan(attemptNow.getTime());
        expect(afterFailure.audits).toHaveLength(
          beforeAttempt.audits.length + 1,
        );
        expect(afterFailure.audits.at(-1)?.metadata).toMatchObject({
          kind: "sanctions-monitoring-drain-attempt-failed",
          attempted: 1,
        });
      } finally {
        await client.exec(
          "DROP TRIGGER later_source_coverage_failure ON sanctions_contact_screenings; DROP FUNCTION reject_later_source_coverage();",
        );
      }
      expect(
        await drain(
          new Date(attemptNow.getTime() + SANCTIONS_MARK_LEASE_MS + 1),
        ),
      ).toEqual({ claimed: 1, terminal: 1, hasMore: false });
      const finished = await census();
      expect(finished.marks).toEqual([]);
      expect(
        finished.coverage.map(({ sourceId }) => sourceId).toSorted(),
      ).toEqual(sources.toSorted());
      for (const sourceId of sources) {
        const outcome =
          expected.value.lists.find(({ source }) => source === sourceId) ??
          panic("Expected final outcome missing");
        expect(
          finished.coverage.find((row) => row.sourceId === sourceId),
        ).toMatchObject({
          status: outcome.status,
          reason: outcome.reason,
          editionId: outcome.editionId,
          contactFingerprint: monitoringFingerprint(updated),
        });
      }
      expect(finished.events).toHaveLength(1);
      expect(
        await drain(
          new Date(attemptNow.getTime() + SANCTIONS_MARK_LEASE_MS + 2),
        ),
      ).toEqual({ claimed: 0, terminal: 0, hasMore: false });
      expect(await census()).toEqual(finished);
    } finally {
      for (const source of oldSources) {
        await db
          .update(sanctionsSources)
          .set({
            activeEditionId: source.activeEditionId,
            lastSuccessfulVerifiedAt: source.lastSuccessfulVerifiedAt,
            lastFailureCode: source.lastFailureCode,
            lastFailureAt: source.lastFailureAt,
          })
          .where(eq(sanctionsSources.id, source.id));
      }
    }
  },
  TIMEOUT,
);

test(
  "every monitored identity field schedules a new generation while unrelated and no-op edits do not",
  async () => {
    const { organizationId, scoped } = await isolatedMonitoringOrganization(
      "drain-identity-fields",
    );
    const cases = {
      type: {
        initial: {},
        update: {
          type: "organization",
          dateOfBirthYear: null,
          dateOfBirthMonth: null,
          dateOfBirthDay: null,
          nationalityCodes: [],
        },
      },
      displayName: { initial: {}, update: { displayName: "Edited Identity" } },
      organizationName: {
        initial: {
          type: "organization",
          organizationName: "Original Corporation",
        },
        update: { organizationName: "Edited Corporation" },
      },
      registrationNumber: {
        initial: { type: "organization" },
        update: { registrationNumber: "REG-200" },
      },
      taxId: {
        initial: { type: "organization" },
        update: { taxId: "TAX-200" },
      },
      dateOfBirthYear: { initial: {}, update: { dateOfBirthYear: 1981 } },
      dateOfBirthMonth: { initial: {}, update: { dateOfBirthMonth: 4 } },
      dateOfBirthDay: { initial: {}, update: { dateOfBirthDay: 6 } },
      nationalityCodes: { initial: {}, update: { nationalityCodes: ["SK"] } },
      sanctionsMonitoringMode: {
        initial: {},
        update: { sanctionsMonitoringMode: "excluded" },
      },
    } satisfies Record<
      Exclude<keyof SanctionsMonitoringContact, "id" | "organizationId">,
      {
        initial: Partial<SanctionsMonitoringContact>;
        update: Partial<SanctionsMonitoringContact>;
      }
    >;
    const ids = [];
    for (const { initial, update } of Object.values(cases)) {
      const contact =
        (
          await scoped(
            async (tx) =>
              await tx
                .insert(contacts)
                .values({
                  organizationId,
                  type: "person",
                  displayName: "Original Identity",
                  dateOfBirthYear: 1980,
                  dateOfBirthMonth: 3,
                  dateOfBirthDay: 5,
                  nationalityCodes: ["CZ"],
                  ...initial,
                  ...("type" in initial && {
                    dateOfBirthYear: null,
                    dateOfBirthMonth: null,
                    dateOfBirthDay: null,
                    nationalityCodes: [],
                  }),
                })
                .returning(),
          )
        ).at(0) ?? panic("Identity-field fixture missing");
      ids.push(contact.id);
      expect((await markFor(contact.id))?.generation).toBe(1n);
      const changed =
        (
          await scoped(
            async (tx) =>
              await tx
                .update(contacts)
                .set(update)
                .where(eq(contacts.id, contact.id))
                .returning(),
          )
        ).at(0) ?? panic("Edited identity-field fixture missing");
      expect(monitoringFingerprint(changed)).not.toBe(
        monitoringFingerprint(contact),
      );
      expect((await markFor(contact.id))?.generation).toBe(2n);
      await scoped(
        async (tx) =>
          await tx
            .update(contacts)
            .set(update)
            .where(eq(contacts.id, contact.id)),
      );
      expect((await markFor(contact.id))?.generation).toBe(2n);
      await scoped(
        async (tx) =>
          await tx
            .update(contacts)
            .set({ notes: "Unrelated contact edit" })
            .where(eq(contacts.id, contact.id)),
      );
      expect((await markFor(contact.id))?.generation).toBe(2n);
    }
    const firstChangedId = ids.at(1) ?? panic("First bulk identity missing");
    const secondChangedId = ids.at(8) ?? panic("Second bulk identity missing");
    const changedIds = [firstChangedId, secondChangedId];
    await scoped(
      async (tx) =>
        await tx
          .update(contacts)
          .set({
            notes: "Bulk unrelated edit",
            nationalityCodes: sql`CASE WHEN ${contacts.id} IN (${firstChangedId}, ${secondChangedId}) THEN ARRAY['DE']::text[] ELSE ${contacts.nationalityCodes} END`,
          })
          .where(eq(contacts.organizationId, organizationId)),
    );
    const marks = await scoped(
      async (tx) => await tx.select().from(sanctionsContactMarks),
    );
    expect(marks.map(({ contactId }) => contactId).toSorted()).toEqual(
      ids.toSorted(),
    );
    expect(
      marks
        .filter(({ generation }) => generation === 3n)
        .map(({ contactId }) => contactId)
        .toSorted(),
    ).toEqual(changedIds.toSorted());
    expect(marks.filter(({ generation }) => generation === 2n)).toHaveLength(
      ids.length - changedIds.length,
    );
  },
  TIMEOUT,
);

test(
  "invalid persisted identity retains prior hits without poisoning matching and clear neighbors",
  async () => {
    const { organizationId, scoped } = await isolatedMonitoringOrganization(
      "drain-invalid-recovery",
    );
    await seedIdentityEdition(futureNow());
    const original =
      (
        await scoped(
          async (tx) =>
            await tx
              .insert(contacts)
              .values({
                organizationId,
                type: "person",
                displayName: "Alexandrov Zhuravlev",
              })
              .returning(),
        )
      ).at(0) ?? panic("Invalid recovery contact missing");
    const drain = async () =>
      await drainSuccessfully({
        db: scoped,
        organizationId,
        now: futureNow(),
        signal: new AbortController().signal,
      });
    expect(await drain()).toEqual({ claimed: 1, terminal: 1, hasMore: false });
    const priorMatches = await scoped(
      async (tx) => await tx.select().from(sanctionsContactMatches),
    );
    const priorEvents = await scoped(
      async (tx) => await tx.select().from(sanctionsScreeningEvents),
    );
    expect(
      priorMatches.map(({ sourceEntryId, state }) => ({
        sourceEntryId,
        state,
      })),
    ).toEqual([{ sourceEntryId: "identity-a", state: "active" }]);
    const invalid =
      (
        await scoped(
          async (tx) =>
            await tx
              .update(contacts)
              .set({ displayName: "!!!" })
              .where(eq(contacts.id, original.id))
              .returning(),
        )
      ).at(0) ?? panic("Invalid contact missing");
    const validated =
      (
        await screenSanctionsSubjects({
          sourceSelection: { type: "all" },
          db: scoped,
          subjects: [monitoringSubject(invalid)],
          practiceJurisdictions: [],
          now: futureNow(),
          resultMode: "complete",
        })
      ).at(0) ?? panic("Invalid validation result missing");
    expect(validated.isErr()).toBe(true);
    const neighbors = await scoped(
      async (tx) =>
        await tx
          .insert(contacts)
          .values([
            { organizationId, type: "person", displayName: "Kwame Nkrumah" },
            { organizationId, type: "person", displayName: "Marisol Benitez" },
          ])
          .returning(),
    );
    expect(await drain()).toEqual({ claimed: 3, terminal: 3, hasMore: false });
    const matching =
      neighbors.find(({ displayName }) => displayName === "Kwame Nkrumah") ??
      panic("Matching neighbor missing");
    const clear =
      neighbors.find(({ displayName }) => displayName === "Marisol Benitez") ??
      panic("Clear neighbor missing");
    const snapshot = async () =>
      await scoped(async (tx) => ({
        matches: await tx.select().from(sanctionsContactMatches),
        coverage: await tx.select().from(sanctionsContactScreenings),
        events: await tx.select().from(sanctionsScreeningEvents),
        marks: await tx.select().from(sanctionsContactMarks),
      }));
    const state = await snapshot();
    expect(state.marks).toEqual([]);
    expect(
      state.matches.filter(({ contactId }) => contactId === invalid.id),
    ).toEqual(priorMatches);
    expect(
      state.events.filter(({ contactId }) => contactId === invalid.id),
    ).toEqual(priorEvents);
    expect(
      state.matches
        .filter(({ contactId }) => contactId === matching.id)
        .map(({ sourceEntryId }) => sourceEntryId),
    ).toEqual(["identity-d"]);
    expect(
      state.matches.filter(({ contactId }) => contactId === clear.id),
    ).toEqual([]);
    const invalidCoverage = state.coverage.filter(
      ({ contactId }) => contactId === invalid.id,
    );
    expect(invalidCoverage.map(({ sourceId }) => sourceId).toSorted()).toEqual(
      sanctionsSourceIds().toSorted(),
    );
    expect(
      invalidCoverage.every(
        ({ status, contactFingerprint }) =>
          status === "unavailable" &&
          contactFingerprint === monitoringFingerprint(invalid),
      ),
    ).toBe(true);
    expect(
      invalidCoverage.find(({ sourceId }) => sourceId === "eu"),
    ).toMatchObject({ status: "unavailable", reason: "load-failed" });
    expect(
      state.coverage.find(
        ({ contactId, sourceId }) =>
          contactId === matching.id && sourceId === "eu",
      )?.status,
    ).toBe("possible-match");
    expect(
      state.coverage.find(
        ({ contactId, sourceId }) =>
          contactId === clear.id && sourceId === "eu",
      )?.status,
    ).toBe("clear");
    expect(await drain()).toEqual({ claimed: 0, terminal: 0, hasMore: false });
    expect(await snapshot()).toEqual(state);
  },
  TIMEOUT,
);

test(
  "backfill retries without advancing its cursor when a contact changes after preparation",
  async () => {
    const { organizationId, scoped } = await isolatedMonitoringOrganization(
      "drain-backfill-edit",
    );
    const previousSource =
      (
        await db
          .select()
          .from(sanctionsSources)
          .where(eq(sanctionsSources.id, "eu"))
      ).at(0) ?? panic("Backfill EU source missing");
    try {
      const editionId = await emptyEdition();
      const contact =
        (
          await scoped(
            async (tx) =>
              await tx
                .insert(contacts)
                .values({
                  organizationId,
                  type: "person",
                  displayName: "Original Backfill Identity",
                })
                .returning(),
          )
        ).at(0) ?? panic("Backfill edit contact missing");
      await scoped(
        async (tx) =>
          await tx
            .insert(sanctionsMonitoringBackfills)
            .values({ organizationId, sourceId: "eu", editionId }),
      );
      const now = futureNow();
      // Warm the full source set so preparation only reads freshness before the commit transaction.
      const warm = await prepareMonitoringContacts({
        sourceSelection: { type: "all" },
        db: scoped,
        contactRows: [contact],
        now,
      });
      expect(
        warm
          .at(0)
          ?.lists.map(({ source }) => source)
          .toSorted(),
      ).toEqual(sanctionsSourceIds().toSorted());
      let calls = 0;
      let edited = false;
      const editBeforeCommit: ScopedDb = async (run) => {
        calls += 1;
        if (calls === 3) {
          expect(
            await scoped(
              async (tx) => await tx.select().from(sanctionsContactScreenings),
            ),
          ).toEqual([]);
          await scoped(
            async (tx) =>
              await tx
                .update(contacts)
                .set({ displayName: "Edited Backfill Identity" })
                .where(eq(contacts.id, contact.id)),
          );
          edited = true;
        }
        return await scoped(run);
      };
      expect(
        await advanceSanctionsMonitoringBackfill({
          db: editBeforeCommit,
          organizationId,
          sourceId: "eu",
          now,
          signal: new AbortController().signal,
        }),
      ).toBe("retry");
      expect(edited).toBe(true);
      expect(calls).toBe(3);
      const jobs = await scoped(
        async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
      );
      expect(jobs).toHaveLength(1);
      expect(jobs.at(0)).toMatchObject({
        cursorContactId: null,
        status: "pending",
        editionId,
        scheduledAt: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS),
      });
      expect(
        await scoped(
          async (tx) => await tx.select().from(sanctionsContactScreenings),
        ),
      ).toEqual([]);
      expect(
        await advanceSanctionsMonitoringBackfill({
          db: scoped,
          organizationId,
          sourceId: "eu",
          now: new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 1),
          signal: new AbortController().signal,
        }),
      ).toBe("advanced");
      const completed =
        (
          await scoped(
            async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
          )
        ).at(0) ?? panic("Completed backfill job missing");
      expect(completed).toMatchObject({
        cursorContactId: contact.id,
        status: "complete",
        editionId,
      });
      const updated =
        (await scoped(async (tx) => await tx.select().from(contacts))).at(0) ??
        panic("Updated backfill contact missing");
      const coverage = await scoped(
        async (tx) => await tx.select().from(sanctionsContactScreenings),
      );
      expect(coverage).toHaveLength(1);
      expect(coverage.at(0)).toMatchObject({
        contactId: contact.id,
        sourceId: "eu",
        status: "clear",
        contactFingerprint: monitoringFingerprint(updated),
      });
      expect(
        await advanceSanctionsMonitoringBackfill({
          db: scoped,
          organizationId,
          sourceId: "eu",
          now: futureNow(),
          signal: new AbortController().signal,
        }),
      ).toBe("idle");
      expect(
        await scoped(
          async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
        ),
      ).toEqual([completed]);
    } finally {
      await db
        .update(sanctionsSources)
        .set({
          activeEditionId: previousSource.activeEditionId,
          lastSuccessfulVerifiedAt: previousSource.lastSuccessfulVerifiedAt,
        })
        .where(eq(sanctionsSources.id, "eu"));
    }
  },
  TIMEOUT,
);

test(
  "fanout audits changed runs once, skips idle runs, and rolls back when audit fails",
  async () => {
    const now = new Date();
    const runId = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
    await db
      .update(sanctionsEditionFanouts)
      .set({ status: "pending", cursorOrganizationId: null })
      .where(inArray(sanctionsEditionFanouts.sourceId, sanctionsSourceIds()));
    await queueSanctionsMonitoringBackfills({
      db: productionSchedulerDb(),
      now,
      runId,
    });
    const audit = await db
      .select()
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.subject, runId));
    expect(audit).toHaveLength(1);
    expect(audit.at(0)?.actor).toBe("system:sanctions-monitoring-fanout");
    await db
      .update(sanctionsEditionFanouts)
      .set({ status: "complete" })
      .where(inArray(sanctionsEditionFanouts.sourceId, sanctionsSourceIds()));
    await db.delete(sanctionsOrganizationMarks).where(sql`true`);
    const idleRun = toSafeId<"schedulerJobRun">(Bun.randomUUIDv7());
    await queueSanctionsMonitoringBackfills({
      db: productionSchedulerDb(),
      now,
      runId: idleRun,
    });
    expect(
      await db
        .select()
        .from(systemAuditRuns)
        .where(eq(systemAuditRuns.subject, idleRun)),
    ).toHaveLength(0);

    await db
      .update(sanctionsEditionFanouts)
      .set({ status: "pending", cursorOrganizationId: null })
      .where(eq(sanctionsEditionFanouts.sourceId, "eu"));
    const before = await db
      .select()
      .from(sanctionsEditionFanouts)
      .where(eq(sanctionsEditionFanouts.sourceId, "eu"));
    await client.exec(`CREATE FUNCTION reject_fanout_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fanout audit failure'; END $$;
    CREATE TRIGGER reject_fanout_audit BEFORE INSERT ON system_audit_runs FOR EACH ROW EXECUTE FUNCTION reject_fanout_audit();`);
    try {
      const rejected = await rejectionOf(
        queueSanctionsMonitoringBackfills({
          db: productionSchedulerDb(),
          now,
          runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
        }),
      );
      expect(errorMessages(rejected)).toContain(
        "synthetic fanout audit failure",
      );
      expect(
        await db
          .select()
          .from(sanctionsEditionFanouts)
          .where(eq(sanctionsEditionFanouts.sourceId, "eu")),
      ).toEqual(before);
    } finally {
      await client.exec(
        "DROP TRIGGER reject_fanout_audit ON system_audit_runs; DROP FUNCTION reject_fanout_audit();",
      );
    }
  },
  TIMEOUT,
);

test(
  "tenant backfill audits lifecycle changes but not progress, and audit failure rolls completion back",
  async () => {
    const organizationId = toSafeId<"organization">("backfill-audit-org");
    const now = new Date();
    await db.insert(organization).values({
      id: organizationId,
      name: "Backfill audit fixture",
      slug: organizationId,
      createdAt: now,
    });
    const scoped = scopedFor(organizationId);
    const editionId =
      (
        await db
          .select()
          .from(sanctionsSources)
          .where(eq(sanctionsSources.id, "eu"))
      ).at(0)?.activeEditionId ?? panic("EU edition missing");
    await scoped(async (tx) => {
      await tx.insert(contacts).values(
        Array.from({ length: 105 }, () => ({
          organizationId,
          type: "person" as const,
          displayName: "Backfill audit subject",
        })),
      );
      await tx.insert(sanctionsMonitoringBackfills).values({
        organizationId,
        sourceId: "eu",
        editionId,
        scheduledAt: now,
      });
    });
    const advance = async (at: Date) =>
      await advanceSanctionsMonitoringBackfill({
        db: scoped,
        organizationId,
        sourceId: "eu",
        now: at,
        signal: new AbortController().signal,
      });
    const audits = async () =>
      await scoped(
        async (tx) =>
          await tx
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId)),
      );
    const job = async () =>
      (
        await scoped(
          async (tx) => await tx.select().from(sanctionsMonitoringBackfills),
        )
      ).at(0) ?? panic("Audit backfill missing");
    expect(await advance(now)).toBe("advanced");
    const progress = await job();
    expect(progress.status).toBe("pending");
    expect(progress.cursorContactId).not.toBeNull();
    expect(await audits()).toHaveLength(1);
    await client.exec(`CREATE FUNCTION reject_backfill_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = 'system:sanctions-monitoring-backfill' THEN RAISE EXCEPTION 'synthetic backfill audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_backfill_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_backfill_audit();`);
    try {
      expect(
        errorMessages(await rejectionOf(advance(new Date(now.getTime() + 1)))),
      ).toContain("synthetic backfill audit failure");
      expect((await job()).status).toBe("pending");
      expect((await job()).cursorContactId).toBe(progress.cursorContactId);
      expect(await audits()).toHaveLength(1);
      expect(
        await scoped(
          async (tx) => await tx.select().from(sanctionsContactScreenings),
        ),
      ).toHaveLength(100);
    } finally {
      await client.exec(
        "DROP TRIGGER reject_backfill_audit ON audit_logs; DROP FUNCTION reject_backfill_audit();",
      );
    }
    expect(
      await advance(new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 2)),
    ).toBe("advanced");
    expect((await job()).status).toBe("complete");
    const events = await audits();
    expect(events).toHaveLength(2);
    expect(events.at(0)?.changes).toBeNull();
    expect(events.at(0)?.metadata).toMatchObject({ updatedScreenings: 100 });
    expect(events.at(0)?.userId).toBe("system:sanctions-monitoring-backfill");
    expect(events.at(1)?.changes).toEqual({
      status: { old: "pending", new: "complete" },
    });
    expect(
      await advance(new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 3)),
    ).toBe("idle");
    expect(await audits()).toHaveLength(2);
    await scoped(async (tx) => {
      await tx
        .update(sanctionsMonitoringBackfills)
        .set({
          status: "pending",
          cursorContactId: null,
        })
        .where(eq(sanctionsMonitoringBackfills.organizationId, organizationId));
    });
    expect(
      await advance(new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS + 4)),
    ).toBe("advanced");
    expect((await job()).status).toBe("pending");
    expect((await job()).cursorContactId).not.toBeNull();
    expect(await audits()).toHaveLength(2);
  },
  TIMEOUT,
);

test(
  "source-scoped backfills build only their source and preserve complete outcomes; drain screens every source",
  async () => {
    const { organizationId, scoped } = await isolatedMonitoringOrganization(
      "monitoring-source-scope",
    );
    const now = new Date(Date.now() + 60_000);
    const sources = sanctionsSourceIds();
    expect(sources.length).toBeGreaterThan(1);
    const previousSources = await db.select().from(sanctionsSources);
    const builds: SanctionsSource[] = [];
    const cache = createSanctionsIndexCache({
      build: (lists) => {
        builds.push(...lists.map(({ version }) => version.source));
        return buildScreeningIndex(lists);
      },
    });
    const get = spyOn(sharedSanctionsIndexCache, "get").mockImplementation(
      cache.get,
    );
    try {
      const editions = new Map<
        SanctionsSource,
        typeof sanctionsEditions.$inferSelect.id
      >();
      for (const source of sources) {
        const editionId = toSafeId<"sanctionsEdition">(Bun.randomUUIDv7());
        editions.set(source, editionId);
        const hash = new Bun.CryptoHasher("sha256")
          .update(editionId)
          .digest("hex");
        const entries = Array.from(
          { length: 13 },
          (_, index) =>
            ({
              source,
              issuer: SANCTIONS_SOURCES[source].issuer,
              sourceId: `scoped-${index}`,
              referenceNumber: null,
              entityType: "person",
              names: [
                { name: "Marisol Benitez", quality: "strong" },
                { name: "Marisol Benítez", quality: "strong" },
              ],
              birthDates: [{ precision: "year", year: 1980, circa: false }],
              nationalities: [{ code: "ES", name: "Spain" }],
              identifiers: [],
              addresses: [],
              programme: "Synthetic programme",
              legalBasis: null,
              listedOn: "2026-09-30",
              sourceUrl: `https://example.test/${source}/${index}`,
            }) satisfies SanctionsEntry,
        );
        await db.insert(sanctionsEditions).values({
          id: editionId,
          sourceId: source,
          markerKey: hash,
          contentHash: hash,
          state: "ready",
          publishedAt: "2026-09-30",
          entryCount: entries.length,
        });
        const payloads = entries.map((payload) => ({
          contentHash: new Bun.CryptoHasher("sha256")
            .update(JSON.stringify(payload))
            .digest("hex"),
          payload,
        }));
        await db
          .insert(sanctionsEntryPayloads)
          .values(payloads)
          .onConflictDoNothing();
        await db.insert(sanctionsEditionEntries).values(
          payloads.map(({ contentHash, payload }) => ({
            editionId,
            contentHash,
            sourceEntryId: payload.sourceId,
          })),
        );
        await db
          .update(sanctionsSources)
          .set({
            activeEditionId: editionId,
            lastSuccessfulVerifiedAt: now,
            lastFailureCode: null,
            lastFailureAt: null,
            heldEditionId: null,
            heldGuardCode: null,
            heldAt: null,
            heldPreviousCount: null,
            heldNextCount: null,
          })
          .where(eq(sanctionsSources.id, source));
      }
      const contact =
        (
          await scoped(
            async (tx) =>
              await tx
                .insert(contacts)
                .values({
                  organizationId,
                  type: "person",
                  displayName: "Marisol Benítez",
                  dateOfBirthYear: 1980,
                  nationalityCodes: ["ES"],
                })
                .returning(),
          )
        ).at(0) ?? panic("Scoped screening contact missing");
      const baseline = await prepareMonitoringContacts({
        db: scoped,
        contactRows: [contact],
        now,
        sourceSelection: { type: "all" },
        indexCache: createSanctionsIndexCache(),
      });
      const expected = baseline.at(0) ?? panic("All-source outcome missing");
      deepStrictEqual(
        expected.lists.map(({ source: listSource }) => listSource),
        sources,
      );
      expect(
        expected.lists.every(
          (list) =>
            list.status === "possible-match" &&
            list.totalMatches === 13 &&
            !list.truncated,
        ),
      ).toBe(true);
      for (const source of sources) {
        const editionId =
          editions.get(source) ?? panic("Scoped edition missing");
        await scoped(
          async (tx) =>
            await tx.insert(sanctionsMonitoringBackfills).values({
              organizationId,
              sourceId: source,
              editionId,
            }),
        );
        get.mockClear();
        const buildCount = builds.length;
        expect(
          await advanceSanctionsMonitoringBackfill({
            db: scoped,
            organizationId,
            sourceId: source,
            now,
            signal: new AbortController().signal,
          }),
        ).toBe("advanced");
        expect(get.mock.calls.map(([props]) => props.source)).toEqual([source]);
        expect(builds.slice(buildCount)).toEqual([source]);
        const prepared = await prepareMonitoringContacts({
          db: scoped,
          contactRows: [contact],
          now,
          sourceSelection: { type: "selected", sources: [source] },
          indexCache: cache,
        });
        expect(prepared).toEqual([
          {
            ...expected,
            lists: expected.lists.filter((list) => list.source === source),
          },
        ]);
        const persisted = await scoped(
          async (tx) =>
            await tx
              .select()
              .from(sanctionsContactMatches)
              .where(eq(sanctionsContactMatches.sourceId, source)),
        );
        expect(
          persisted.map(({ sourceEntryId }) => sourceEntryId).toSorted(),
        ).toEqual(
          Array.from(
            { length: 13 },
            (_, index) => `scoped-${index}`,
          ).toSorted(),
        );
        const invalid = await prepareMonitoringContacts({
          db: scoped,
          contactRows: [{ ...contact, displayName: "" }],
          now,
          sourceSelection: { type: "selected", sources: [source] },
          indexCache: cache,
        });
        expect(
          invalid.at(0)?.lists.map(({ source: listSource, status }) => ({
            source: listSource,
            status,
          })),
        ).toEqual([{ source, status: "unavailable" }]);
        const matchedSources: SanctionsSource[] = [];
        const matched = await screenSanctionsSubjects({
          db: scoped,
          subjects: [monitoringSubject(contact)],
          practiceJurisdictions: [],
          now,
          sourceSelection: { type: "selected", sources: [source] },
          matcher: ({ source: matchedSource, edition }) => {
            matchedSources.push(matchedSource);
            return Result.ok({
              cutoff: DEFAULT_CUTOFF,
              versions: [
                {
                  source: matchedSource,
                  publishedAt: edition.publishedAt,
                  fileId: edition.fileId,
                },
              ],
              possibleMatches: [],
              totalMatches: 0,
              truncated: false,
            });
          },
        });
        expect(matchedSources).toEqual([source]);
        expect(
          matched
            .at(0)
            ?.unwrap()
            .lists.map(({ source: listSource }) => listSource),
        ).toEqual([source]);
      }
      get.mockClear();
      expect(
        await drainSuccessfully({
          db: scoped,
          organizationId,
          now,
          signal: new AbortController().signal,
        }),
      ).toEqual({ claimed: 1, terminal: 1, hasMore: false });
      deepStrictEqual(
        get.mock.calls.map(([props]) => props.source),
        sources,
      );
      const coverage = await scoped(
        async (tx) => await tx.select().from(sanctionsContactScreenings),
      );
      expect(coverage.map(({ sourceId }) => sourceId).toSorted()).toEqual(
        sources.toSorted(),
      );
    } finally {
      get.mockRestore();
      for (const row of previousSources) {
        await db
          .update(sanctionsSources)
          .set(row)
          .where(eq(sanctionsSources.id, row.id));
      }
    }
  },
  TIMEOUT,
);
