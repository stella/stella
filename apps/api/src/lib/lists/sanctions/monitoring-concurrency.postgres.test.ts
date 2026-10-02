import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsEditions,
  sanctionsEditionFanouts,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
  sanctionsScreeningEvents,
  sanctionsSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { commitSanctionsMonitoringBatch } from "@/api/lib/lists/sanctions/monitoring-diff";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const now = new Date("2026-09-29T12:00:00Z");
const GATE_SETTING = "test.monitoring_write_gate";
const BLOCK_OBSERVATION_ATTEMPTS = 200;

const backendPid = async (db: GatedTestDb) =>
  (await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).at(0)
    ?.pid ?? panic("Missing monitoring test backend");

// Observing the server's lock graph proves the competing operation reached its fence.
// The bounded wait only diagnoses a missing barrier; elapsed time is never the oracle.
const blockersFor = async (db: GatedTestDb, pid: number) => {
  for (let attempt = 0; attempt < BLOCK_OBSERVATION_ATTEMPTS; attempt += 1) {
    const row =
      (
        await db.execute<{ blockers: number[] }>(sql`
      SELECT pg_blocking_pids(${pid}) AS blockers
    `)
      ).at(0) ?? panic("Missing lock observation");
    if (row.blockers.length > 0) {
      return row.blockers;
    }
    await Bun.sleep(10);
  }
  panic("Monitoring operation did not reach its database barrier");
};

type InstallGateOptions = {
  db: GatedTestDb;
  table: "sanctions_contact_matches" | "sanctions_monitoring_backfills";
  suffix: string;
};

const installGate = async ({ db, table, suffix }: InstallGateOptions) => {
  const name = `monitoring_gate_${suffix}`;
  await db.execute(sql`
    CREATE FUNCTION ${sql.identifier(name)}() RETURNS trigger
    LANGUAGE plpgsql AS $gate$
    BEGIN
      IF NULLIF(current_setting('test.monitoring_write_gate', true), '') IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(current_setting('test.monitoring_write_gate')::bigint);
      END IF;
      RETURN NEW;
    END
    $gate$
  `);
  await db.execute(sql`
    CREATE TRIGGER ${sql.identifier(name)} BEFORE INSERT ON ${sql.identifier(table)}
    FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(name)}()
  `);
  return async () => {
    await db.execute(
      sql`DROP TRIGGER IF EXISTS ${sql.identifier(name)} ON ${sql.identifier(table)}`,
    );
    await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.identifier(name)}()`);
  };
};

type ScopedForOptions = {
  db: GatedTestDb;
  organizationId: typeof contacts.$inferSelect.organizationId;
  gate?: bigint;
};

const scopedFor =
  ({ db, organizationId, gate }: ScopedForOptions): ScopedDb =>
  async (run) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      await tx.execute(
        sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
      );
      if (gate !== undefined) {
        await tx.execute(
          sql`SELECT set_config(${GATE_SETTING}, ${String(gate)}, true)`,
        );
      }
      return await run(asTestRaw<Transaction>(tx));
    });

const contactState = async (
  db: GatedTestDb,
  contactId: typeof contacts.$inferSelect.id,
) => ({
  matches: await db
    .select()
    .from(sanctionsContactMatches)
    .where(eq(sanctionsContactMatches.contactId, contactId)),
  screenings: await db
    .select()
    .from(sanctionsContactScreenings)
    .where(eq(sanctionsContactScreenings.contactId, contactId)),
  events: await db
    .select()
    .from(sanctionsScreeningEvents)
    .where(eq(sanctionsScreeningEvents.contactId, contactId)),
});

if (!databaseUrl || !runPostgresTests) {
  describe.skip("monitoring concurrency on PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("concurrent identical monitoring batches converge to one transition", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: firstDb } = openClient({
        connection: { statement_timeout: 10_000 },
      });
      const { db: secondDb } = openClient({
        connection: { statement_timeout: 10_000 },
      });
      const { db: controlDb } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const editionId = createSafeId<"sanctionsEdition">();
      const suffix = editionId.replaceAll("-", "");
      const gate = BigInt(`0x${suffix.slice(-15)}`);
      const hash = suffix.repeat(2);
      const sourceBefore =
        (
          await controlDb
            .select()
            .from(sanctionsSources)
            .where(eq(sanctionsSources.id, "eu"))
        ).at(0) ?? panic("Missing committed EU source");
      const sourceFanout = await controlDb.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
        return (
          (
            await tx
              .select()
              .from(sanctionsEditionFanouts)
              .where(eq(sanctionsEditionFanouts.sourceId, "eu"))
          ).at(0) ?? panic("Missing committed EU fanout")
        );
      });
      const running: Promise<unknown>[] = [];
      const removeGate = await installGate({
        db: controlDb,
        table: "sanctions_contact_matches",
        suffix,
      });
      let gateHeld = false;
      try {
        await controlDb.insert(organization).values({
          id: organizationId,
          name: "Monitoring concurrency",
          slug: `monitoring-${suffix}`,
          createdAt: now,
        });
        // Absence of settings matters: an organization-settings lock cannot mask a missing contact fence.
        expect(
          await controlDb
            .select()
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId)),
        ).toEqual([]);
        const contact =
          (
            await controlDb
              .insert(contacts)
              .values({
                organizationId,
                type: "person",
                displayName: "Synthetic Concurrent Person",
              })
              .returning()
          ).at(0) ?? panic("Missing concurrent contact");
        const payload = {
          source: "eu",
          issuer: SANCTIONS_SOURCES.eu.issuer,
          sourceId: suffix,
          referenceNumber: null,
          entityType: "person",
          names: [{ name: contact.displayName, quality: "strong" }],
          birthDates: [],
          nationalities: [],
          identifiers: [],
          addresses: [],
          programme: null,
          legalBasis: null,
          listedOn: null,
          sourceUrl: "https://example.test/monitoring-concurrency",
        } satisfies SanctionsEntry;
        await controlDb.insert(sanctionsEditions).values({
          id: editionId,
          sourceId: "eu",
          markerKey: suffix,
          contentHash: hash,
          publishedAt: "2026-09-29",
          state: "ready",
          entryCount: 1,
        });
        await controlDb
          .insert(sanctionsEntryPayloads)
          .values({ contentHash: hash, payload });
        await controlDb
          .insert(sanctionsEditionEntries)
          .values({ editionId, sourceEntryId: suffix, contentHash: hash });
        await controlDb
          .update(sanctionsSources)
          .set({ activeEditionId: editionId, lastSuccessfulVerifiedAt: now })
          .where(eq(sanctionsSources.id, "eu"));
        const screened = await screenSanctionsSubject({
          db: scopedFor({ db: controlDb, organizationId }),
          subject: monitoringSubject(contact),
          practiceJurisdictions: [],
          now,
          indexCache: createSanctionsIndexCache(),
          resultMode: "complete",
        });
        if (screened.isErr()) {
          panic("Concurrent subject rejected");
        }
        const outcome =
          screened.value.lists.find(({ source }) => source === "eu") ??
          panic("Missing concurrent EU outcome");
        expect(outcome.status).toBe("possible-match");
        expect(
          outcome.possibleMatches.map(({ sourceEntryId }) => sourceEntryId),
        ).toEqual([suffix]);
        const result = {
          contactId: contact.id,
          contactFingerprint: monitoringFingerprint(contact),
          outcome,
        };
        const commit = (db: GatedTestDb) =>
          commitSanctionsMonitoringBatch({
            db: scopedFor({ db, organizationId, gate }),
            organizationId,
            source: "eu",
            results: [result],
            now,
          });
        const firstPid = await backendPid(firstDb);
        const secondPid = await backendPid(secondDb);
        const controlPid = await backendPid(controlDb);
        await controlDb.execute(
          sql`SELECT pg_advisory_lock(${String(gate)}::bigint)`,
        );
        gateHeld = true;
        const first = commit(firstDb);
        running.push(first);
        expect(await blockersFor(controlDb, firstPid)).toContain(controlPid);
        const second = commit(secondDb);
        running.push(second);
        // First writer has read the empty old matches and reached INSERT. The second
        // must wait on the contact row, rather than read that same empty state.
        expect(await blockersFor(controlDb, secondPid)).toContain(firstPid);
        await controlDb.execute(
          sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
        );
        gateHeld = false;
        expect(await first).toEqual([contact.id]);
        expect(await second).toEqual([contact.id]);
        const state = await contactState(controlDb, contact.id);
        expect(state.matches).toHaveLength(1);
        expect(state.screenings).toHaveLength(1);
        expect(state.events.map(({ type }) => type)).toEqual(["new"]);
        await commit(firstDb);
        expect(await contactState(controlDb, contact.id)).toEqual(state);

        // An edit that owns the contact fence while a prepared commit starts wins.
        const edited = Promise.withResolvers<undefined>();
        const releaseEdit = Promise.withResolvers<undefined>();
        const edit = firstDb.transaction(async (tx) => {
          await tx
            .update(contacts)
            .set({ displayName: "Updated Concurrent Person" })
            .where(eq(contacts.id, contact.id));
          edited.resolve(undefined);
          await releaseEdit.promise;
        });
        running.push(edit);
        void edit.catch(edited.reject);
        await edited.promise;
        const stale = commit(secondDb);
        running.push(stale);
        try {
          expect(await blockersFor(controlDb, secondPid)).toContain(firstPid);
        } finally {
          releaseEdit.resolve(undefined);
        }
        await edit;
        expect(await stale).toEqual([]);
        expect(await contactState(controlDb, contact.id)).toEqual(state);

        const excluded = Promise.withResolvers<undefined>();
        const releaseExclusion = Promise.withResolvers<undefined>();
        const exclude = firstDb.transaction(async (tx) => {
          await tx
            .update(contacts)
            .set({ sanctionsMonitoringMode: "excluded" })
            .where(eq(contacts.id, contact.id));
          excluded.resolve(undefined);
          await releaseExclusion.promise;
        });
        running.push(exclude);
        void exclude.catch(excluded.reject);
        await excluded.promise;
        const optedOut = commit(secondDb);
        running.push(optedOut);
        try {
          expect(await blockersFor(controlDb, secondPid)).toContain(firstPid);
        } finally {
          releaseExclusion.resolve(undefined);
        }
        await exclude;
        expect(await optedOut).toEqual([contact.id]);
        const currentContact =
          (
            await controlDb
              .select()
              .from(contacts)
              .where(eq(contacts.id, contact.id))
          ).at(0) ?? panic("Missing excluded contact");
        expect(monitoringFingerprint(currentContact)).not.toBe(
          result.contactFingerprint,
        );
        const excludedState = await contactState(controlDb, contact.id);
        expect(excludedState.matches).toEqual(state.matches);
        expect(excludedState.events).toEqual(state.events);
        expect(excludedState.screenings).toHaveLength(1);
        expect(excludedState.screenings.at(0)).toMatchObject({
          status: "excluded",
          reason: "contact-excluded",
          contactFingerprint: monitoringFingerprint(currentContact),
          editionId: null,
        });
      } finally {
        if (gateHeld) {
          await controlDb.execute(
            sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
          );
        }
        await Promise.allSettled(running);
        await removeGate();
        await controlDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await controlDb
          .update(sanctionsSources)
          .set({
            activeEditionId: sourceBefore.activeEditionId,
            lastSuccessfulVerifiedAt: sourceBefore.lastSuccessfulVerifiedAt,
          })
          .where(eq(sanctionsSources.id, "eu"));
        await controlDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          await tx
            .update(sanctionsEditionFanouts)
            .set(sourceFanout)
            .where(eq(sanctionsEditionFanouts.sourceId, "eu"));
        });
        await controlDb
          .delete(sanctionsEditions)
          .where(eq(sanctionsEditions.id, editionId));
        await controlDb
          .delete(sanctionsEntryPayloads)
          .where(eq(sanctionsEntryPayloads.contentHash, hash));
      }
    });
  }, 120_000);
}
