import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  hostedUsageWebhookEvents,
  usageAllocations,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import type { UsageProviderWebhookResult } from "@/api/db/schema";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { replayProviderEvent } from "@/api/lib/hosted-usage-provider/replay";
import { redactCompletedWebhookEvents } from "@/api/lib/hosted-usage-provider/webhook-retention";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const START = "2026-06-01T00:00:00Z";
const END = "2026-07-01T00:00:00Z";

type ReplayFixture = {
  organizationId: SafeId<"organization">;
  policyRef: string;
  seedReceipt: (options: {
    eventId: string;
    data?: Record<string, unknown>;
    result?: UsageProviderWebhookResult;
    payloadUnavailable?: boolean;
    signatureVerified?: boolean;
    unrecognizedProjection?: boolean;
  }) => Promise<void>;
  insertPolicy: () => Promise<void>;
};

const withReplayFixture = async (
  fn: (tx: Transaction, fixture: ReplayFixture) => Promise<void>,
) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  const previousRetentionDays = env.HOSTED_USAGE_WEBHOOK_RETENTION_DAYS;
  const previousFeatureUsage = env.FEATURE_USAGE;
  env.HOSTED_USAGE_WEBHOOK_RETENTION_DAYS = undefined;
  env.FEATURE_USAGE = true;
  try {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      try {
        await openClient().db.transaction(async (tx) => {
          await tx.execute(sql`
            create temporary table usage_provider_webhook_events
            (like public.usage_provider_webhook_events including all) on commit drop
          `);
          const organizationId = toSafeId<"organization">(
            `org_${Bun.randomUUIDv7()}`,
          );
          const policyRef = `policy_${Bun.randomUUIDv7()}`;
          await tx.insert(organization).values({
            id: organizationId,
            name: "Replay fixture",
            slug: organizationId,
            createdAt: new Date(START),
          });
          const insertPolicy = async () => {
            await tx.insert(usagePolicies).values({
              policyKey: `fixture_${Bun.randomUUIDv7()}`,
              displayName: "Replay fixture",
              monthlyUsageUnits: 17,
              hostedPolicyRef: policyRef,
            });
          };
          const seedReceipt: ReplayFixture["seedReceipt"] = async ({
            eventId,
            data = {},
            result = "ignored",
            payloadUnavailable = false,
            signatureVerified = true,
            unrecognizedProjection = false,
          }) => {
            let payload: Record<string, unknown>;
            if (payloadUnavailable) {
              payload = {};
            } else if (unrecognizedProjection) {
              payload = {
                signatureVerified,
                payloadDigest: "fixture-digest",
              };
            } else {
              payload = {
                signatureVerified,
                payloadDigest: "fixture-digest",
                type: "entitlement.created",
                data: {
                  id: `entitlement_${eventId}`,
                  status: "active",
                  account_ref: `account_${organizationId}`,
                  policy_ref: policyRef,
                  current_period_start: START,
                  current_period_end: END,
                  metadata: { organization_id: organizationId },
                  quantity: 2,
                  occurred_at: START,
                  ...data,
                },
              };
            }
            await tx.insert(hostedUsageWebhookEvents).values({
              eventId,
              eventType: "entitlement.created",
              processedAt: new Date(START),
              result,
              payload,
            });
          };
          await fn(tx, {
            organizationId,
            policyRef,
            seedReceipt,
            insertPolicy,
          });
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
    });
  } finally {
    env.HOSTED_USAGE_WEBHOOK_RETENTION_DAYS = previousRetentionDays;
    env.FEATURE_USAGE = previousFeatureUsage;
  }
};

const runReplay = async (
  tx: Transaction,
  eventId: string,
  mode: "dry_run" | "apply" = "apply",
) => {
  const runTransaction: WebhookTransactionRunner = async (fn) =>
    await tx.transaction(async (nested) => await fn(nested));
  const result = await replayProviderEvent({
    eventId,
    mode,
    actor: "operator:fixture",
    reason: "fixture replay",
    runTransaction,
  });
  return result.unwrap();
};

describe.skipIf(!runPostgresTests)("provider event replay on Postgres", () => {
  test("dry run dispatches against PostgreSQL and rolls back receipt and usage writes", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId }) => {
        const eventId = `replay-${Bun.randomUUIDv7()}`;
        await seedReceipt({ eventId });
        await insertPolicy();
        const before = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, eventId));
        const outcome = await runReplay(tx, eventId, "dry_run");
        expect(outcome).toMatchObject({
          id: eventId,
          previousResult: "ignored",
          kind: "applied",
          mode: "dry_run",
        });
        expect(
          await tx
            .select()
            .from(hostedUsageWebhookEvents)
            .where(eq(hostedUsageWebhookEvents.eventId, eventId)),
        ).toEqual(before);
        expect(
          await tx
            .select()
            .from(usageEntitlements)
            .where(eq(usageEntitlements.organizationId, organizationId)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(usageAllocations)
            .where(eq(usageAllocations.organizationId, organizationId)),
        ).toHaveLength(0);
        expect(
          await tx
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId)),
        ).toHaveLength(0);
      },
    );
  });

  test("applies a stored ignored event once the policy is resolvable with retention unset", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId }) => {
        const eventId = `replay-${Bun.randomUUIDv7()}`;
        await seedReceipt({ eventId });
        await insertPolicy();

        const outcome = await runReplay(tx, eventId);
        expect(outcome).toMatchObject({
          id: eventId,
          previousResult: "ignored",
          kind: "applied",
          mode: "apply",
        });
        const receipt = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, eventId));
        expect(receipt.at(0)).toMatchObject({
          result: "ok",
          replayAudit: {
            actor: "operator:fixture",
            previousResult: "ignored",
            newResult: "ok",
            outcome: "applied",
            reason: "fixture replay",
            event: { resourceId: eventId },
          },
        });
        expect(
          await tx
            .select()
            .from(usageEntitlements)
            .where(eq(usageEntitlements.organizationId, organizationId)),
        ).toHaveLength(1);
        expect(
          await tx
            .select()
            .from(usageAllocations)
            .where(eq(usageAllocations.organizationId, organizationId)),
        ).toHaveLength(1);
      },
    );
  });

  test("replay reaches a fixed point across several receipts and writes one audit per receipt", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId }) => {
        await insertPolicy();
        const eventIds = Array.from(
          { length: 4 },
          () => `replay-${Bun.randomUUIDv7()}`,
        );
        const entitlementId = `entitlement_${Bun.randomUUIDv7()}`;
        for (const [index, eventId] of eventIds.entries()) {
          await seedReceipt({
            eventId,
            data: {
              id: entitlementId,
              occurred_at: `2026-06-0${index + 1}T00:00:00Z`,
            },
          });
        }

        const firstPass = [];
        for (const eventId of eventIds) {
          firstPass.push(await runReplay(tx, eventId));
        }
        const secondPass = [];
        for (const eventId of eventIds) {
          secondPass.push(await runReplay(tx, eventId));
        }

        expect(firstPass.map(({ kind }) => kind)).toEqual(
          eventIds.map(() => "applied"),
        );
        expect(secondPass.map(({ kind }) => kind)).toEqual(
          eventIds.map(() => "already_replayed"),
        );
        const snapshot = async () => ({
          receipts: await tx.select().from(hostedUsageWebhookEvents),
          entitlements: await tx
            .select()
            .from(usageEntitlements)
            .where(eq(usageEntitlements.organizationId, organizationId)),
          allocations: await tx
            .select()
            .from(usageAllocations)
            .where(eq(usageAllocations.organizationId, organizationId)),
          audits: await tx
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId)),
        });
        const afterFirstPass = await snapshot();
        expect(afterFirstPass.receipts).toHaveLength(eventIds.length);
        expect(
          afterFirstPass.receipts.every(
            ({ replayAudit }) => replayAudit !== null,
          ),
        ).toBe(true);
        expect(afterFirstPass.entitlements).toHaveLength(1);
        expect(
          eventIds.every((eventId) =>
            afterFirstPass.audits.some(
              ({ triggerSourceId }) => triggerSourceId === eventId,
            ),
          ),
        ).toBe(true);
        expect(await snapshot()).toEqual(afterFirstPass);
      },
    );
  });

  test("non-ignored, purged, and incomplete receipts return typed skips", async () => {
    await withReplayFixture(async (tx, { seedReceipt, organizationId }) => {
      const completedId = `replay-${Bun.randomUUIDv7()}`;
      const failedId = `replay-${Bun.randomUUIDv7()}`;
      const purgedId = `replay-${Bun.randomUUIDv7()}`;
      const incompleteId = `replay-${Bun.randomUUIDv7()}`;
      const unsignedId = `replay-${Bun.randomUUIDv7()}`;
      const minimalId = `replay-${Bun.randomUUIDv7()}`;
      await seedReceipt({ eventId: completedId, result: "ok" });
      await seedReceipt({ eventId: failedId, result: "error" });
      await seedReceipt({ eventId: purgedId, payloadUnavailable: true });
      await seedReceipt({
        eventId: incompleteId,
        data: { current_period_end: null },
      });
      await seedReceipt({ eventId: unsignedId, signatureVerified: false });
      await seedReceipt({
        eventId: minimalId,
        unrecognizedProjection: true,
      });
      const before = await tx.select().from(hostedUsageWebhookEvents);

      expect((await runReplay(tx, completedId)).kind).toBe("not_ignored");
      expect((await runReplay(tx, failedId)).kind).toBe("not_ignored");
      expect((await runReplay(tx, purgedId)).kind).toBe("payload_unavailable");
      expect((await runReplay(tx, incompleteId)).kind).toBe(
        "payload_unavailable",
      );
      expect((await runReplay(tx, unsignedId)).kind).toBe(
        "payload_unavailable",
      );
      expect((await runReplay(tx, minimalId)).kind).toBe("payload_unavailable");
      expect((await runReplay(tx, `missing-${Bun.randomUUIDv7()}`)).kind).toBe(
        "not_found",
      );
      expect(await tx.select().from(hostedUsageWebhookEvents)).toEqual(before);
      expect(
        await tx
          .select()
          .from(usageEntitlements)
          .where(eq(usageEntitlements.organizationId, organizationId)),
      ).toHaveLength(0);
      expect(
        await tx
          .select()
          .from(usageAllocations)
          .where(eq(usageAllocations.organizationId, organizationId)),
      ).toHaveLength(0);
    });
  });

  test("an older event stays ignored after a newer event updates the entitlement", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId }) => {
        await insertPolicy();
        const externalId = `entitlement_${Bun.randomUUIDv7()}`;
        const newerId = `replay-${Bun.randomUUIDv7()}`;
        const olderId = `replay-${Bun.randomUUIDv7()}`;
        await seedReceipt({
          eventId: newerId,
          data: { id: externalId, occurred_at: "2026-06-03T00:00:00Z" },
        });
        await seedReceipt({
          eventId: olderId,
          data: { id: externalId, occurred_at: "2026-06-02T00:00:00Z" },
        });

        expect((await runReplay(tx, newerId)).kind).toBe("applied");
        expect((await runReplay(tx, olderId)).kind).toBe("ignored");
        const entitlements = await tx
          .select()
          .from(usageEntitlements)
          .where(eq(usageEntitlements.organizationId, organizationId));
        expect(entitlements).toHaveLength(1);
        expect(entitlements.at(0)?.hostedLastEventAt).toEqual(
          new Date("2026-06-03T00:00:00Z"),
        );
        const olderReceipt = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, olderId));
        expect(olderReceipt.at(0)).toMatchObject({
          result: "ignored",
          replayAudit: { outcome: "ignored", previousResult: "ignored" },
        });
        const receiptBeforeSecondApply = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, olderId));
        expect((await runReplay(tx, olderId)).kind).toBe("already_replayed");
        expect(
          await tx
            .select()
            .from(hostedUsageWebhookEvents)
            .where(eq(hostedUsageWebhookEvents.eventId, olderId)),
        ).toEqual(receiptBeforeSecondApply);
        await redactCompletedWebhookEvents({
          db: tx,
          retentionDays: 1,
          now: new Date("2026-10-03T00:00:00Z"),
        });
        expect((await runReplay(tx, olderId)).kind).toBe("already_replayed");
        const retainedAudit = await tx
          .select({
            payload: hostedUsageWebhookEvents.payload,
            replayAudit: hostedUsageWebhookEvents.replayAudit,
          })
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, olderId));
        expect(retainedAudit.at(0)?.replayAudit).not.toBeNull();
        expect(retainedAudit.at(0)?.payload).toEqual({});
      },
    );
  });

  test("concurrent replay operators audit a receipt once", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    const previousFeatureUsage = env.FEATURE_USAGE;
    env.FEATURE_USAGE = true;
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const owner = openClient({ max: 1 }).db;
        const worker = openClient({ max: 1 }).db;
        const schema = `provider_replay_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const eventId = `replay-${Bun.randomUUIDv7()}`;
        try {
          await owner.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
          await owner.execute(sql`
          CREATE TABLE ${sql.identifier(schema)}.usage_provider_webhook_events
          (LIKE public.usage_provider_webhook_events INCLUDING ALL)
        `);
          await owner.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('search_path', ${`${schema},public`}, true)`,
            );
            await tx.insert(hostedUsageWebhookEvents).values({
              eventId,
              eventType: "entitlement.created",
              processedAt: new Date(START),
              result: "ignored",
              payload: {
                signatureVerified: true,
                payloadDigest: "fixture-digest",
                type: "entitlement.created",
                data: {
                  id: `entitlement_${eventId}`,
                  status: "active",
                  account_ref: `account_${eventId}`,
                  policy_ref: `unconfigured_${eventId}`,
                  current_period_start: START,
                  current_period_end: END,
                  metadata: { organization_id: "org_replay_fixture" },
                  occurred_at: START,
                },
              },
            });
          });

          const replayOn = async (db: typeof owner) =>
            await replayProviderEvent({
              eventId,
              mode: "apply",
              actor: "operator:concurrent-fixture",
              reason: "concurrent fixture replay",
              runTransaction: async (fn) =>
                await db.transaction(async (tx) => {
                  await tx.execute(
                    sql`SELECT set_config('search_path', ${`${schema},public`}, true)`,
                  );
                  return await fn(tx);
                }),
            });

          const outcomes = await Promise.all([
            replayOn(owner),
            replayOn(worker),
          ]);
          expect(
            outcomes.map((outcome) => outcome.unwrap().kind).toSorted(),
          ).toEqual(["already_replayed", "ignored"]);
          const rows = await owner.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('search_path', ${`${schema},public`}, true)`,
            );
            return await tx
              .select()
              .from(hostedUsageWebhookEvents)
              .where(eq(hostedUsageWebhookEvents.eventId, eventId));
          });
          expect(rows).toHaveLength(1);
          expect(rows.at(0)).toMatchObject({
            result: "ignored",
            replayAudit: {
              actor: "operator:concurrent-fixture",
              outcome: "ignored",
              previousResult: "ignored",
            },
          });
        } finally {
          await owner.execute(
            sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`,
          );
        }
      });
    } finally {
      env.FEATURE_USAGE = previousFeatureUsage;
    }
  });
});
