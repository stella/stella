import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { hostedUsageWebhookEvents } from "@/api/db/schema";
import { setSharedLockTimeout } from "@/api/db/shared-pool-timeouts";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  redactCompletedWebhookEvents,
  WEBHOOK_RETENTION_BATCH_SIZE,
} from "./webhook-retention";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)("completed provider event retention", () => {
  test("redaction skips a locked receipt and resumes after its owner releases it", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const owner = openClient().db;
      const worker = openClient().db;
      const schema = `webhook_retention_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const now = new Date("2026-06-01T00:00:00Z");
      const payload = { customer: { email: "fixture@example.test" } };
      await owner.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
      try {
        await owner.execute(sql`
          CREATE TABLE ${sql.identifier(schema)}.usage_provider_webhook_events
          (LIKE public.usage_provider_webhook_events INCLUDING ALL)
        `);
        await owner.transaction(async (db) => {
          await db.execute(
            sql`SELECT set_config('search_path', ${schema}, true)`,
          );
          await db.insert(hostedUsageWebhookEvents).values(
            ["locked", "available"].map((eventId) => ({
              eventId,
              eventType: "fixture",
              processedAt: new Date("2026-01-01T00:00:00Z"),
              result: "ok" as const,
              payload,
            })),
          );
        });
        await owner.transaction(async (db) => {
          await db.execute(
            sql`SELECT set_config('search_path', ${schema}, true)`,
          );
          await db.execute(sql`
            SELECT event_id FROM usage_provider_webhook_events
            WHERE event_id = 'locked' FOR UPDATE
          `);
          await worker.transaction(async (workerDb) => {
            await workerDb.execute(
              sql`SELECT set_config('search_path', ${schema}, true)`,
            );
            // A missing SKIP LOCKED must fail rather than hang behind the owner.
            await setSharedLockTimeout(workerDb, 1000);
            expect(
              await redactCompletedWebhookEvents({
                db: workerDb,
                retentionDays: 1,
                now,
              }),
            ).toBe(1);
            const rows = await workerDb.select().from(hostedUsageWebhookEvents);
            expect(
              rows.find(({ eventId }) => eventId === "locked")?.payload,
            ).toEqual(payload);
            expect(
              rows.find(({ eventId }) => eventId === "available")?.payload,
            ).toEqual({});
          });
        });
        await worker.transaction(async (db) => {
          await db.execute(
            sql`SELECT set_config('search_path', ${schema}, true)`,
          );
          expect(
            await redactCompletedWebhookEvents({ db, retentionDays: 1, now }),
          ).toBe(1);
          expect(
            await redactCompletedWebhookEvents({ db, retentionDays: 1, now }),
          ).toBe(0);
        });
      } finally {
        await owner.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
      }
    });
  });

  test("redaction preserves unresolved and recent receipts and converges within the batch bound", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      await openClient().db.transaction(async (db) => {
        // Shadow the production relation so retention cannot touch shared fixtures.
        await db.execute(sql`
          create temporary table usage_provider_webhook_events
          (like public.usage_provider_webhook_events including all) on commit drop
        `);
        const now = new Date("2026-06-01T00:00:00Z");
        const old = new Date("2026-01-01T00:00:00Z");
        const payload = { customer: { email: "fixture@example.test" } };
        await db.insert(hostedUsageWebhookEvents).values([
          ...Array.from(
            { length: WEBHOOK_RETENTION_BATCH_SIZE + 1 },
            (_, i) => ({
              eventId: `completed-${i}`,
              eventType: "fixture",
              processedAt: old,
              result: "ok" as const,
              payload,
              errorMessage: "fixture detail",
            }),
          ),
          ...(["ignored", "error"] as const).map((result) => ({
            eventId: result,
            eventType: "fixture",
            processedAt: old,
            result,
            payload,
            errorMessage: "unresolved detail",
          })),
          {
            eventId: "recent",
            eventType: "fixture",
            processedAt: now,
            result: "ok",
            payload,
          },
          {
            eventId: "cutoff",
            eventType: "fixture",
            processedAt: new Date("2026-05-31T00:00:00Z"),
            result: "ok",
            payload,
          },
          {
            eventId: "error-only",
            eventType: "fixture",
            processedAt: old,
            result: "ok",
            payload: {},
            errorMessage: "fixture detail",
          },
        ]);
        const redact = async () =>
          await redactCompletedWebhookEvents({ db, retentionDays: 1, now });
        expect(await redact()).toBe(WEBHOOK_RETENTION_BATCH_SIZE);
        expect(await redact()).toBe(3);
        expect(await redact()).toBe(0);
        const rows = await db.select().from(hostedUsageWebhookEvents);
        expect(rows).toHaveLength(WEBHOOK_RETENTION_BATCH_SIZE + 6);
        for (const row of rows) {
          if (
            row.eventId.startsWith("completed-") ||
            row.eventId === "error-only" ||
            row.eventId === "ignored"
          ) {
            expect(row.payload).toEqual({});
            expect(row.errorMessage).toBeNull();
            expect(row.result).toBe(
              row.eventId === "ignored" ? "ignored" : "ok",
            );
            expect(row.eventType).toBe("fixture");
            expect(row.processedAt).toEqual(old);
          } else {
            expect(row.payload).toEqual(payload);
            if (row.eventId === "error") {
              expect(row.result).toBe("error");
              expect(row.errorMessage).toBe("unresolved detail");
            }
          }
        }
      });
    });
  });
});
