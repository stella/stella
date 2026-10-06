import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  organizationSettings,
  sanctionsContactMarks,
  sanctionsContactMatches,
  sanctionsContactScreenings,
  sanctionsEditions,
  sanctionsEditionFanouts,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
  sanctionsMonitoringBackfills,
  sanctionsOrganizationMarks,
  sanctionsScreeningEvents,
  sanctionsSources,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { commitSanctionsMonitoringBatch } from "@/api/lib/lists/sanctions/monitoring-diff";
import { drainSanctionsContactMarks } from "@/api/lib/lists/sanctions/monitoring-drain";
import { queueSanctionsMonitoringBackfills } from "@/api/lib/lists/sanctions/monitoring-fanout";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import { lockSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-lock";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import { screenSanctionsSubject } from "@/api/lib/lists/sanctions/screening-service";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
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
  return panic("Monitoring operation did not reach its database barrier");
};

type InstallGateOptions = {
  db: GatedTestDb;
  table:
    | "sanctions_contact_matches"
    | "sanctions_contact_screenings"
    | "sanctions_monitoring_backfills";
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
  onTransactionPid?: (pid: number) => void;
};

const scopedFor =
  ({
    db,
    organizationId,
    gate,
    onTransactionPid,
  }: ScopedForOptions): ScopedDb =>
  async (run) =>
    await db.transaction(async (tx) => {
      const pid =
        (
          await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
        ).at(0)?.pid ?? panic("Missing scoped transaction backend");
      onTransactionPid?.(pid);
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

const failureMessages = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return `${error.message} ${"cause" in error ? failureMessages(error.cause) : ""}`;
};

// Organization-consumption tests own only their request. Keep unrelated edition
// pages quiescent, and put their exact state back before closing the fixture.
const pauseEditionFanouts = async (db: GatedTestDb) => {
  const snapshot = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    const fanouts = await tx.select().from(sanctionsEditionFanouts);
    const freshness = await readSanctionsFreshness({
      db: async (read) => await read(asTestRaw<Transaction>(tx)),
      now,
    });
    const fixtureRows = freshness.map(({ source, status, edition }) => ({
      sourceId: source,
      editionId: edition?.id ?? null,
      cursorOrganizationId: null,
      freshnessStatus: status,
      status: "complete" as const,
    }));
    await tx
      .insert(sanctionsEditionFanouts)
      .values(fixtureRows)
      .onConflictDoUpdate({
        target: sanctionsEditionFanouts.sourceId,
        set: {
          editionId: sql`excluded.edition_id`,
          cursorOrganizationId: sql`excluded.cursor_organization_id`,
          freshnessStatus: sql`excluded.freshness_status`,
          status: "complete",
        },
      });
    const savedSources = new Set(fanouts.map(({ sourceId }) => sourceId));
    const createdSourceIds = fixtureRows
      .filter(({ sourceId }) => !savedSources.has(sourceId))
      .map(({ sourceId }) => sourceId);
    return { fanouts, createdSourceIds };
  });
  return async () =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      if (snapshot.createdSourceIds.length > 0) {
        await tx
          .delete(sanctionsEditionFanouts)
          .where(
            inArray(
              sanctionsEditionFanouts.sourceId,
              snapshot.createdSourceIds,
            ),
          );
      }
      if (snapshot.fanouts.length > 0) {
        await tx
          .insert(sanctionsEditionFanouts)
          .values(snapshot.fanouts)
          .onConflictDoUpdate({
            target: sanctionsEditionFanouts.sourceId,
            set: {
              editionId: sql`excluded.edition_id`,
              cursorOrganizationId: sql`excluded.cursor_organization_id`,
              freshnessStatus: sql`excluded.freshness_status`,
              status: sql`excluded.state`,
            },
          });
      }
    });
};

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
      const hash = new Bun.CryptoHasher("sha256").update(suffix).digest("hex");
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
          await tx
            .select()
            .from(sanctionsEditionFanouts)
            .where(eq(sanctionsEditionFanouts.sourceId, "eu"))
        ).at(0);
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
          markerKey: hash,
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
        const commit = async (db: GatedTestDb) =>
          await commitSanctionsMonitoringBatch({
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
        expect(excludedState.matches).toEqual(
          state.matches.map((match) => ({
            ...match,
            state: "lapsed",
            updatedAt: now,
          })),
        );
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
          if (sourceFanout === undefined) {
            await tx
              .delete(sanctionsEditionFanouts)
              .where(eq(sanctionsEditionFanouts.sourceId, "eu"));
          } else {
            await tx
              .insert(sanctionsEditionFanouts)
              .values(sourceFanout)
              .onConflictDoUpdate({
                target: sanctionsEditionFanouts.sourceId,
                set: {
                  editionId: sql`excluded.edition_id`,
                  cursorOrganizationId: sql`excluded.cursor_organization_id`,
                  freshnessStatus: sql`excluded.freshness_status`,
                  status: sql`excluded.state`,
                },
              });
          }
        });
        await controlDb
          .delete(sanctionsEditionEntries)
          .where(eq(sanctionsEditionEntries.editionId, editionId));
        await controlDb
          .delete(sanctionsEditions)
          .where(eq(sanctionsEditions.id, editionId));
        await controlDb
          .delete(sanctionsEntryPayloads)
          .where(eq(sanctionsEntryPayloads.contentHash, hash));
      }
    });
  }, 120_000);

  test("contact edits and opt-out serialize with a tenant contact drain", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: drainDb } = openClient({
        connection: { statement_timeout: 20_000 },
      });
      const { db: editDb } = openClient({
        connection: { statement_timeout: 20_000 },
      });
      const { db: controlDb } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const gate = BigInt(`0x${suffix.slice(-15)}`);
      const removeGate = await installGate({
        db: controlDb,
        table: "sanctions_contact_screenings",
        suffix,
      });
      const controllers = new AbortController();
      const running: Promise<unknown>[] = [];
      let gateHeld = false;
      let controlGatePid: number | undefined;
      let editedContactId: typeof contacts.$inferSelect.id | undefined;
      let drainFirstEditedContactId:
        | typeof contacts.$inferSelect.id
        | undefined;
      let optedOutContactId: typeof contacts.$inferSelect.id | undefined;
      try {
        await controlDb.insert(organization).values({
          id: organizationId,
          name: "Monitoring drain lock order",
          slug: `monitoring-drain-lock-${suffix}`,
          createdAt: new Date(),
        });
        const created = await controlDb
          .insert(contacts)
          .values([
            {
              organizationId,
              type: "person",
              displayName: "Edit first subject",
            },
            {
              organizationId,
              type: "person",
              displayName: "Drain first edit subject",
            },
            {
              organizationId,
              type: "person",
              displayName: "Opt-out subject",
            },
          ])
          .returning();
        editedContactId = created.at(0)?.id;
        drainFirstEditedContactId = created.at(1)?.id;
        optedOutContactId = created.at(2)?.id;
        if (
          editedContactId === undefined ||
          drainFirstEditedContactId === undefined ||
          optedOutContactId === undefined
        ) {
          panic("Monitoring drain lock-order contacts missing");
        }
        const editedId = editedContactId;
        const drainFirstEditId = drainFirstEditedContactId;
        const optedOutId = optedOutContactId;
        await controlDb
          .update(sanctionsContactMarks)
          .set({ scheduledAt: new Date(Date.now() + 60 * 60_000) })
          .where(
            inArray(sanctionsContactMarks.contactId, [
              drainFirstEditId,
              optedOutId,
            ]),
          );

        let captureDrainPid: ((pid: number) => void) | undefined;
        const scopedDrainDb = scopedFor({
          db: drainDb,
          organizationId,
          onTransactionPid: (pid) => captureDrainPid?.(pid),
        });
        const drain = async () =>
          (
            await drainSanctionsContactMarks({
              db: scopedDrainDb,
              organizationId,
              now: new Date(),
              signal: controllers.signal,
            })
          ).unwrap();
        const startDrain = () => {
          const started = Promise.withResolvers<number>();
          captureDrainPid = started.resolve;
          const operation = drain();
          void operation.catch(started.reject);
          return { operation, pid: started.promise };
        };

        const editStarted = Promise.withResolvers<undefined>();
        const releaseEdit = Promise.withResolvers<undefined>();
        const editPidReady = Promise.withResolvers<number>();
        const editFirst = editDb.transaction(async (tx) => {
          const pid =
            (
              await tx.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`,
              )
            ).at(0)?.pid ?? panic("Missing edit transaction backend");
          editPidReady.resolve(pid);
          await tx
            .update(contacts)
            .set({ displayName: "Edit wins before drain" })
            .where(eq(contacts.id, editedId));
          editStarted.resolve(undefined);
          await releaseEdit.promise;
        });
        running.push(editFirst);
        void editFirst.catch(editStarted.reject);
        const editPid = await editPidReady.promise;
        await editStarted.promise;
        const drainAfterEditRun = startDrain();
        const drainPid = await drainAfterEditRun.pid;
        const drainAfterEdit = drainAfterEditRun.operation;
        running.push(drainAfterEdit);
        expect(await blockersFor(controlDb, drainPid)).toContain(editPid);
        releaseEdit.resolve(undefined);
        await editFirst;
        await drainAfterEdit;
        expect(
          await controlDb
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, editedId)),
        ).toEqual([]);
        const editedScreenings = await controlDb
          .select()
          .from(sanctionsContactScreenings)
          .where(eq(sanctionsContactScreenings.contactId, editedId));
        const editedContact =
          (
            await controlDb
              .select()
              .from(contacts)
              .where(eq(contacts.id, editedId))
          ).at(0) ?? panic("Edited monitoring contact missing");
        expect(editedScreenings).toHaveLength(sanctionsSourceIds().length);
        expect(
          editedScreenings.every(
            ({ status, contactFingerprint }) =>
              status !== "excluded" &&
              contactFingerprint === monitoringFingerprint(editedContact),
          ),
        ).toBe(true);

        await controlDb
          .update(sanctionsContactMarks)
          .set({ scheduledAt: new Date(Date.now() - 1000) })
          .where(eq(sanctionsContactMarks.contactId, drainFirstEditId));
        await drainDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, ${String(gate)}, false)`,
        );
        controlGatePid =
          (
            await controlDb.execute<{ pid: number }>(sql`
              SELECT pg_advisory_lock(${String(gate)}::bigint), pg_backend_pid() AS pid
            `)
          ).at(0)?.pid ?? panic("Missing advisory lock holder backend");
        gateHeld = true;
        const blockedDrainRun = startDrain();
        const blockedDrainPid = await blockedDrainRun.pid;
        const blockedDrain = blockedDrainRun.operation;
        running.push(blockedDrain);
        expect(await blockersFor(controlDb, blockedDrainPid)).toContain(
          controlGatePid,
        );
        const reverseEditStarted = Promise.withResolvers<undefined>();
        const releaseReverseEdit = Promise.withResolvers<undefined>();
        const reverseEditPidReady = Promise.withResolvers<number>();
        const reverseEdit = editDb.transaction(async (tx) => {
          const pid =
            (
              await tx.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`,
              )
            ).at(0)?.pid ?? panic("Missing reverse edit transaction backend");
          reverseEditPidReady.resolve(pid);
          await tx
            .update(contacts)
            .set({ displayName: "Drain wins before edit" })
            .where(eq(contacts.id, drainFirstEditId));
          reverseEditStarted.resolve(undefined);
          await releaseReverseEdit.promise;
        });
        running.push(reverseEdit);
        void reverseEdit.catch(reverseEditStarted.reject);
        const reverseEditPid = await reverseEditPidReady.promise;
        expect(await blockersFor(controlDb, reverseEditPid)).toContain(
          blockedDrainPid,
        );
        await controlDb.execute(
          sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
        );
        gateHeld = false;
        await blockedDrain;
        await reverseEditStarted.promise;
        releaseReverseEdit.resolve(undefined);
        await reverseEdit;
        await drainDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, '', false)`,
        );
        const pendingEdit =
          (
            await controlDb
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, drainFirstEditId))
          ).at(0) ?? panic("Edit did not queue a fresh monitoring generation");
        expect(pendingEdit.generation).toBe(1n);
        await drain();
        expect(
          await controlDb
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, drainFirstEditId)),
        ).toEqual([]);
        const refreshedEditScreenings = await controlDb
          .select()
          .from(sanctionsContactScreenings)
          .where(eq(sanctionsContactScreenings.contactId, drainFirstEditId));
        const drainFirstEditedContact =
          (
            await controlDb
              .select()
              .from(contacts)
              .where(eq(contacts.id, drainFirstEditId))
          ).at(0) ?? panic("Drain-first edited contact missing");
        expect(refreshedEditScreenings).toHaveLength(
          sanctionsSourceIds().length,
        );
        expect(
          refreshedEditScreenings.every(
            ({ contactFingerprint }) =>
              contactFingerprint ===
              monitoringFingerprint(drainFirstEditedContact),
          ),
        ).toBe(true);

        await controlDb
          .update(sanctionsContactMarks)
          .set({ scheduledAt: new Date(Date.now() - 1000) })
          .where(eq(sanctionsContactMarks.contactId, optedOutId));
        await drainDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, ${String(gate)}, false)`,
        );
        controlGatePid =
          (
            await controlDb.execute<{ pid: number }>(sql`
              SELECT pg_advisory_lock(${String(gate)}::bigint), pg_backend_pid() AS pid
            `)
          ).at(0)?.pid ?? panic("Missing opt-out advisory lock holder backend");
        gateHeld = true;
        const blockedOptOutDrainRun = startDrain();
        const blockedOptOutDrainPid = await blockedOptOutDrainRun.pid;
        const blockedOptOutDrain = blockedOptOutDrainRun.operation;
        running.push(blockedOptOutDrain);
        expect(await blockersFor(controlDb, blockedOptOutDrainPid)).toContain(
          controlGatePid,
        );
        const optOutPidReady = Promise.withResolvers<number>();
        const optOut = editDb.transaction(async (tx) => {
          const pid =
            (
              await tx.execute<{ pid: number }>(
                sql`SELECT pg_backend_pid() AS pid`,
              )
            ).at(0)?.pid ?? panic("Missing opt-out transaction backend");
          optOutPidReady.resolve(pid);
          await lockSanctionsMonitoring(
            asTestRaw<Transaction>(tx),
            organizationId,
          );
          await tx
            .update(contacts)
            .set({
              displayName: "Drain first, opt-out second",
              sanctionsMonitoringMode: "excluded",
            })
            .where(eq(contacts.id, optedOutId));
        });
        running.push(optOut);
        const optOutPid = await optOutPidReady.promise;
        expect(await blockersFor(controlDb, optOutPid)).toContain(
          blockedOptOutDrainPid,
        );
        await controlDb.execute(
          sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
        );
        gateHeld = false;
        await blockedOptOutDrain;
        await optOut;
        await drainDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, '', false)`,
        );
        const pendingOptOut =
          (
            await controlDb
              .select()
              .from(sanctionsContactMarks)
              .where(eq(sanctionsContactMarks.contactId, optedOutId))
          ).at(0) ??
          panic("Opt-out did not queue a fresh monitoring generation");
        expect(pendingOptOut.generation).toBe(1n);
        await drain();
        expect(
          await controlDb
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, optedOutId)),
        ).toEqual([]);
        const optedOutScreenings = await controlDb
          .select()
          .from(sanctionsContactScreenings)
          .where(eq(sanctionsContactScreenings.contactId, optedOutId));
        expect(optedOutScreenings).toHaveLength(sanctionsSourceIds().length);
        expect(
          optedOutScreenings.every(
            ({ status, reason }) =>
              status === "excluded" && reason === "contact-excluded",
          ),
        ).toBe(true);
      } finally {
        if (gateHeld) {
          await controlDb.execute(
            sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
          );
        }
        await drainDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, '', false)`,
        );
        controllers.abort();
        await Promise.allSettled(running);
        await removeGate();
        await controlDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  }, 120_000);

  test("organization refresh consumption preserves a newer settings generation", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: consumerDb } = openClient({
        connection: { statement_timeout: 10_000 },
      });
      const { db: settingsDb } = openClient({
        connection: { statement_timeout: 10_000 },
      });
      const organizationId = mintAuthProviderId<"organization">();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const gate = BigInt(`0x${suffix.slice(-15)}`);
      const removeGate = await installGate({
        db: settingsDb,
        table: "sanctions_monitoring_backfills",
        suffix,
      });
      const faultName = `monitoring_delete_fault_${suffix}`;
      const restoreFanouts = await pauseEditionFanouts(settingsDb);
      const running: Promise<unknown>[] = [];
      let gateHeld = false;
      try {
        // The isolated gated database must not have another organization's request
        // ahead of this fixture; do not silently consume a different test's work.
        expect(
          await settingsDb.select().from(sanctionsOrganizationMarks),
        ).toEqual([]);
        await settingsDb.insert(organization).values({
          id: organizationId,
          name: "Monitoring settings concurrency",
          slug: `monitoring-settings-${suffix}`,
          createdAt: now,
        });
        await settingsDb
          .insert(organizationSettings)
          .values({ organizationId, sanctionsMonitoringMode: "enabled" });
        const mark =
          (
            await settingsDb
              .select()
              .from(sanctionsOrganizationMarks)
              .where(
                eq(sanctionsOrganizationMarks.organizationId, organizationId),
              )
          ).at(0) ?? panic("Missing initial organization mark");
        expect(mark.generation).toBe(1n);
        const consumerPid = await backendPid(consumerDb);
        const settingsPid = await backendPid(settingsDb);
        await settingsDb.execute(
          sql`SELECT pg_advisory_lock(${String(gate)}::bigint)`,
        );
        gateHeld = true;
        await consumerDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, ${String(gate)}, false)`,
        );
        const consume = queueSanctionsMonitoringBackfills({
          runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
          db: consumerDb,
          now,
        });
        running.push(consume);
        // The production INSERT happens after discovery and before deleting the mark.
        expect(await blockersFor(settingsDb, consumerPid)).toContain(
          settingsPid,
        );
        await settingsDb
          .update(organizationSettings)
          .set({ sanctionsMonitoringMode: "disabled" })
          .where(eq(organizationSettings.organizationId, organizationId));
        const newer =
          (
            await settingsDb
              .select()
              .from(sanctionsOrganizationMarks)
              .where(
                eq(sanctionsOrganizationMarks.organizationId, organizationId),
              )
          ).at(0) ?? panic("Missing newer organization mark");
        expect(newer.generation).toBe(mark.generation + 1n);
        await settingsDb.execute(
          sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
        );
        gateHeld = false;
        expect((await consume).requested).toBe(1);
        expect((await consume).fanned).toBe(0);
        expect(
          await settingsDb
            .select()
            .from(sanctionsOrganizationMarks)
            .where(
              eq(sanctionsOrganizationMarks.organizationId, organizationId),
            ),
        ).toEqual([newer]);
        await settingsDb
          .update(sanctionsMonitoringBackfills)
          .set({ status: "complete", cursorContactId: null })
          .where(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
          );
        expect(
          (
            await queueSanctionsMonitoringBackfills({
              runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
              db: consumerDb,
              now,
            })
          ).requested,
        ).toBe(1);
        expect(
          await settingsDb
            .select()
            .from(sanctionsOrganizationMarks)
            .where(
              eq(sanctionsOrganizationMarks.organizationId, organizationId),
            ),
        ).toEqual([]);
        const jobs = await settingsDb
          .select()
          .from(sanctionsMonitoringBackfills)
          .where(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
          );
        expect(jobs.map(({ sourceId }) => sourceId).toSorted()).toEqual(
          sanctionsSourceIds().toSorted(),
        );
        expect(
          jobs.every(
            ({ status, cursorContactId }) =>
              status === "pending" && cursorContactId === null,
          ),
        ).toBe(true);
        expect(
          (
            await settingsDb
              .select()
              .from(organizationSettings)
              .where(eq(organizationSettings.organizationId, organizationId))
          ).at(0)?.sanctionsMonitoringMode,
        ).toBe("disabled");

        // A failed final deletion must roll back enqueued jobs and their cursors.
        await settingsDb
          .update(organizationSettings)
          .set({ sanctionsMonitoringMode: "enabled" })
          .where(eq(organizationSettings.organizationId, organizationId));
        const cursor = createSafeId<"contact">();
        await settingsDb
          .update(sanctionsMonitoringBackfills)
          .set({ status: "complete", cursorContactId: cursor })
          .where(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
          );
        const jobsBeforeFault = await settingsDb
          .select()
          .from(sanctionsMonitoringBackfills)
          .where(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
          );
        const marksBeforeFault = await settingsDb
          .select()
          .from(sanctionsOrganizationMarks)
          .where(eq(sanctionsOrganizationMarks.organizationId, organizationId));
        expect(
          jobsBeforeFault.every(
            ({ cursorContactId }) => cursorContactId === cursor,
          ),
        ).toBe(true);
        await settingsDb.execute(sql`
          CREATE FUNCTION ${sql.identifier(faultName)}() RETURNS trigger
          LANGUAGE plpgsql AS $fault$
          BEGIN
            IF NULLIF(current_setting('test.monitoring_write_gate', true), '') IS NOT NULL THEN
              RAISE EXCEPTION 'Monitoring organization checkpoint rejected';
            END IF;
            RETURN OLD;
          END
          $fault$
        `);
        await settingsDb.execute(sql`
          CREATE TRIGGER ${sql.identifier(faultName)} BEFORE DELETE ON sanctions_organization_marks
          FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(faultName)}()
        `);
        const failed = await Result.tryPromise(
          async () =>
            await queueSanctionsMonitoringBackfills({
              runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
              db: consumerDb,
              now,
            }),
        );
        if (failed.isOk()) {
          panic("Expected organization checkpoint failure");
        }
        expect(failureMessages(failed.error)).toContain(
          "Monitoring organization checkpoint rejected",
        );
        expect(
          await settingsDb
            .select()
            .from(sanctionsOrganizationMarks)
            .where(
              eq(sanctionsOrganizationMarks.organizationId, organizationId),
            ),
        ).toEqual(marksBeforeFault);
        expect(
          await settingsDb
            .select()
            .from(sanctionsMonitoringBackfills)
            .where(
              eq(sanctionsMonitoringBackfills.organizationId, organizationId),
            ),
        ).toEqual(jobsBeforeFault);
        await settingsDb.execute(
          sql`DROP TRIGGER ${sql.identifier(faultName)} ON sanctions_organization_marks`,
        );
        await settingsDb.execute(
          sql`DROP FUNCTION ${sql.identifier(faultName)}()`,
        );
        expect(
          (
            await queueSanctionsMonitoringBackfills({
              runId: toSafeId<"schedulerJobRun">(Bun.randomUUIDv7()),
              db: consumerDb,
              now,
            })
          ).requested,
        ).toBe(1);
        expect(
          await settingsDb
            .select()
            .from(sanctionsOrganizationMarks)
            .where(
              eq(sanctionsOrganizationMarks.organizationId, organizationId),
            ),
        ).toEqual([]);
        const retriedJobs = await settingsDb
          .select()
          .from(sanctionsMonitoringBackfills)
          .where(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
          );
        expect(retriedJobs.map(({ sourceId }) => sourceId).toSorted()).toEqual(
          sanctionsSourceIds().toSorted(),
        );
        expect(
          retriedJobs.every(
            ({ status, cursorContactId }) =>
              status === "pending" && cursorContactId === null,
          ),
        ).toBe(true);
      } finally {
        if (gateHeld) {
          await settingsDb.execute(
            sql`SELECT pg_advisory_unlock(${String(gate)}::bigint)`,
          );
        }
        await Promise.allSettled(running);
        await consumerDb.execute(
          sql`SELECT set_config(${GATE_SETTING}, '', false)`,
        );
        await settingsDb.execute(
          sql`DROP TRIGGER IF EXISTS ${sql.identifier(faultName)} ON sanctions_organization_marks`,
        );
        await settingsDb.execute(
          sql`DROP FUNCTION IF EXISTS ${sql.identifier(faultName)}()`,
        );
        await removeGate();
        await settingsDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await restoreFanouts();
      }
    });
  }, 120_000);
}
