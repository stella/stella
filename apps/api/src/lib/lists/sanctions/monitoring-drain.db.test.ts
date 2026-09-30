import { panic, Result } from "better-result";
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
  sanctionsMonitoringBackfills,
  sanctionsEditionFanouts,
  sanctionsOrganizationMarks,
  sanctionsContactScreenings,
  sanctionsScreeningEvents,
  sanctionsSources,
  sanctionsEditions,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { advanceSanctionsMonitoringBackfill } from "@/api/lib/lists/sanctions/monitoring-backfill";
import {
  drainSanctionsContactMarks,
  SANCTIONS_MARK_LEASE_MS,
} from "@/api/lib/lists/sanctions/monitoring-drain";
import { queueSanctionsMonitoringBackfills } from "@/api/lib/lists/sanctions/monitoring-fanout";
import { requestSanctionsMonitoringRefresh } from "@/api/lib/lists/sanctions/monitoring-refresh";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
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
  const backfillMigration = readFileSync(
    new URL(
      "../../../../drizzle/20261003123000_sanctions_monitoring_backfills/migration.sql",
      import.meta.url,
    ),
    "utf-8",
  );
  await client.exec(`GRANT SELECT, INSERT, UPDATE ON sanctions_edition_fanouts TO stella_ingestion;
    ALTER TABLE sanctions_edition_fanouts ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_edition_fanouts FORCE ROW LEVEL SECURITY;`);
  await client.exec(
    backfillMigration
      .slice(backfillMigration.indexOf("CREATE FUNCTION"))
      .replaceAll("--> statement-breakpoint", "\n"),
  );
  await client.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON sanctions_monitoring_backfills TO stella;
    ALTER TABLE sanctions_monitoring_backfills ENABLE ROW LEVEL SECURITY; ALTER TABLE sanctions_monitoring_backfills FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON sanctions_edition_fanouts FROM stella; GRANT SELECT ON sanctions_edition_fanouts TO stella;`);
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

test(
  "durable refresh requests are idempotent, tenant scoped and atomic with caller rollback",
  async () => {
    const contact = await addContact();
    await db
      .delete(sanctionsContactMarks)
      .where(eq(sanctionsContactMarks.contactId, contact.id));
    await expect(
      scopedDb(async (tx) => {
        await requestSanctionsMonitoringRefresh(tx, {
          organizationId: orgId,
          contactIds: [contact.id],
        });
        throw new Error("synthetic audit rollback");
      }),
    ).rejects.toThrow("synthetic audit rollback");
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
    await expect(
      scopedDb(
        async (tx) =>
          await requestSanctionsMonitoringRefresh(tx, {
            organizationId: orgId,
            contactIds: Array.from({ length: 10_001 }, () => contact.id),
          }),
      ),
    ).rejects.toThrow("contact cap");
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

const errorMessages = (error: unknown): string =>
  error instanceof Error
    ? `${error.message} ${"cause" in error ? errorMessages(error.cause) : ""}`
    : String(error);

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
            state: "pending",
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
      (await db.select().from(sanctionsMonitoringBackfills)).at(0)?.state,
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
          state: "pending",
          scheduledAt: new Date(),
        })
        .where(eq(sanctionsMonitoringBackfills.organizationId, orgId));
    });
    let newerEdition: typeof nextEdition | undefined;
    const activateAfterClaim: ScopedDb = async (run) => {
      const value = await scopedDb(run);
      if (newerEdition === undefined) {
        newerEdition = await emptyEdition();
      }
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
  if (mode === "activation") {
    await db
      .update(sanctionsSources)
      .set({
        lastSuccessfulVerifiedAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      })
      .where(eq(sanctionsSources.id, "eu"));
  }
  await tenant(
    async (tx) =>
      await tx.insert(contacts).values({
        organizationId,
        type: "person",
        displayName: "Expired Worker",
      }),
  );
  const now = futureNow();
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
      } else {
        await db
          .update(sanctionsSources)
          .set({
            lastSuccessfulVerifiedAt: new Date(
              Date.now() - 49 * 60 * 60 * 1000,
            ),
          })
          .where(eq(sanctionsSources.id, "eu"));
      }
      await drainSanctionsContactMarks({
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
  const expired = await drainSanctionsContactMarks({
    db: stallAfterFreshnessRead,
    organizationId,
    now,
    signal: new AbortController().signal,
  });
  expect(replacement).toBeDefined();
  expect(expired.terminal).toBe(0);
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
    expect(firstPage.state).toBe("pending");
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
    expect((await job()).state).toBe("complete");
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
    const systemDb = asTestRaw<SchedulerDb>(db);
    const first = await queueSanctionsMonitoringBackfills({
      db: systemDb,
      now,
    });
    expect(first.fanned).toBe(100);
    const second = await queueSanctionsMonitoringBackfills({
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
      db: systemDb,
      now: new Date(now.getTime() + 49 * 60 * 60 * 1000),
    });
    expect((await eu()).freshnessStatus).toBe("unavailable");
    expect((await eu()).cursorOrganizationId).toBeNull();
    const denied = await Result.tryPromise(
      async () =>
        await scopedFor(organizationId)(
          async (tx) =>
            await tx
              .update(sanctionsEditionFanouts)
              .set({ state: "complete" })
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
  "measure statement-trigger cost for a 10000-contact import",
  async () => {
    const insert = async () =>
      await scopedDb(async (tx) => {
        const started = performance.now();
        await tx.execute(sql`INSERT INTO public.contacts (id, organization_id, type, display_name)
       SELECT gen_random_uuid(), ${orgId}, 'person', 'Import Person' FROM generate_series(1, 10000)`);
        return performance.now() - started;
      });
    await client.exec(
      "ALTER TABLE public.contacts DISABLE TRIGGER contacts_sanctions_mark_insert",
    );
    const baselineMs = await insert();
    await client.exec(
      "ALTER TABLE public.contacts ENABLE TRIGGER contacts_sanctions_mark_insert",
    );
    const markedMs = await insert();
    console.log(
      JSON.stringify({
        benchmark: "sanctions-contact-import",
        database: "pglite",
        contacts: 10_000,
        baselineMs,
        markedMs,
        overheadMs: markedMs - baselineMs,
        ratio: markedMs / baselineMs,
      }),
    );
    expect(markedMs).toBeGreaterThan(0);
  },
  TIMEOUT,
);
