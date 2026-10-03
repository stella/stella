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
import { handleHostedAllocation } from "@/api/handlers/hosted-usage-webhook/dispatch";
import {
  HOSTED_USAGE_WEBHOOK_HEADERS,
  receiveHostedUsageWebhook,
} from "@/api/handlers/hosted-usage-webhook/receive";
import {
  replayProviderEvent,
  replayProviderEventsBatch,
} from "@/api/handlers/hosted-usage-webhook/replay";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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
    eventType?: "entitlement.created" | "allocation.created";
    processedAt?: string;
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
            eventType = "entitlement.created",
            processedAt = START,
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
                type: eventType,
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
              eventType,
              processedAt: new Date(processedAt),
              result,
              errorMessage: "Original ignored reason",
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

type RunReplayOptions = {
  tx: Transaction;
  eventId: string;
  mode?: "dry_run" | "apply";
  selectedEventIds?: readonly string[];
};

const runReplay = async ({
  tx,
  eventId,
  mode = "apply",
  selectedEventIds = [eventId],
}: RunReplayOptions) => {
  const runTransaction: WebhookTransactionRunner = async (fn) =>
    await tx.transaction(async (nested) => await fn(nested));
  const result = await replayProviderEvent({
    eventId,
    selectedEventIds,
    mode,
    requestedBy: "operator:fixture",
    performer: { type: "local", username: "fixture" },
    reason: "fixture replay",
    runTransaction,
  });
  return result.unwrap();
};

const createEntitlementInsertBarrier = () => {
  const bothReady = Promise.withResolvers<undefined>();
  let arrivals = 0;
  const pausedBuilders = new WeakSet<object>();
  // Returning is the execution boundary: both dispatches have finished their
  // missing-row lookups, but neither INSERT has reached PostgreSQL yet.
  const pauseInsert = <Builder extends object>(builder: Builder): Builder => {
    if (pausedBuilders.has(builder)) {
      return builder;
    }
    const paused = new Proxy(builder, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver);
        if (typeof method !== "function") {
          return method;
        }
        if (property === "returning") {
          return new Proxy(method, {
            async apply(call, thisArg, args) {
              arrivals += 1;
              if (arrivals === 2) {
                bothReady.resolve(undefined);
              }
              await bothReady.promise;
              return await Reflect.apply(call, thisArg, args);
            },
          });
        }
        if (property === "values" || property === "onConflictDoNothing") {
          return new Proxy(method, {
            apply(call, thisArg, args) {
              return pauseInsert(Reflect.apply(call, thisArg, args));
            },
          });
        }
        return method;
      },
    });
    pausedBuilders.add(paused);
    return paused;
  };
  return {
    arrivals: () => arrivals,
    wrap: (tx: Transaction) =>
      new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "insert") {
            return Reflect.get(target, property, receiver);
          }
          return new Proxy(target.insert, {
            apply(call, thisArg, args) {
              const builder = Reflect.apply(call, thisArg, args);
              return args.at(0) === usageEntitlements
                ? pauseInsert(builder)
                : builder;
            },
          });
        },
      }),
  };
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
        const outcome = await runReplay({
          tx,
          eventId,
          mode: "dry_run",
        });
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

        const outcome = await runReplay({ tx, eventId });
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
          errorMessage: null,
          replayAudit: [
            {
              requestedBy: "operator:fixture",
              execution: { performer: { type: "local", username: "fixture" } },
              previousResult: "ignored",
              previousReason: "Original ignored reason",
              newResult: "ok",
              outcome: "applied",
              reason: "fixture replay",
              event: { resourceId: eventId },
            },
          ],
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
          firstPass.push(
            await runReplay({
              tx,
              eventId,
              selectedEventIds: eventIds,
            }),
          );
        }
        const secondPass = [];
        for (const eventId of eventIds) {
          secondPass.push(
            await runReplay({
              tx,
              eventId,
              selectedEventIds: eventIds,
            }),
          );
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

  test("an ignored attempt can be repaired and replayed to a terminal success", async () => {
    await withReplayFixture(async (tx, { seedReceipt, insertPolicy }) => {
      const eventId = `replay-${Bun.randomUUIDv7()}`;
      await seedReceipt({ eventId });
      const ignored = await runReplay({ tx, eventId });
      expect(ignored.kind).toBe("ignored");
      await insertPolicy();
      expect((await runReplay({ tx, eventId })).kind).toBe("applied");
      expect((await runReplay({ tx, eventId })).kind).toBe("already_replayed");
      const receipts = await tx
        .select()
        .from(hostedUsageWebhookEvents)
        .where(eq(hostedUsageWebhookEvents.eventId, eventId));
      expect(receipts.at(0)).toMatchObject({
        result: "ok",
        errorMessage: null,
        replayAudit: [
          { outcome: "ignored", previousReason: "Original ignored reason" },
          { outcome: "applied", previousReason: ignored.reason },
        ],
      });
    });
  });

  test("partial selection refuses related receipts in apply and dry run", async () => {
    await withReplayFixture(async (tx, { seedReceipt, insertPolicy }) => {
      await insertPolicy();
      const selectedId = `replay-${Bun.randomUUIDv7()}`;
      const omittedId = `replay-${Bun.randomUUIDv7()}`;
      const entityId = `entitlement_${Bun.randomUUIDv7()}`;
      await seedReceipt({ eventId: selectedId, data: { id: entityId } });
      await seedReceipt({ eventId: omittedId, data: { id: entityId } });
      const before = await tx.select().from(hostedUsageWebhookEvents);
      for (const mode of ["dry_run", "apply"] as const) {
        expect(
          await runReplay({ tx, eventId: selectedId, mode }),
        ).toMatchObject({
          kind: "related_receipts_unselected",
          unselectedEventIds: [omittedId],
        });
      }
      expect(await tx.select().from(hostedUsageWebhookEvents)).toEqual(before);
    });
  });

  test("batch dry run predicts ordered entitlement and add-on apply without retaining writes", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId, policyRef }) => {
        await insertPolicy();
        const addonRef = `addon_${Bun.randomUUIDv7()}`;
        await tx.insert(usagePolicies).values({
          policyKey: addonRef,
          displayName: "Replay add-on",
          kind: "addon",
          monthlyUsageUnits: 5,
          hostedPolicyRef: addonRef,
        });
        const eventIds = [
          `replay-${Bun.randomUUIDv7()}`,
          `replay-${Bun.randomUUIDv7()}`,
        ];
        for (const [index, eventId] of eventIds.entries()) {
          await seedReceipt({
            eventId,
            eventType:
              index === 0 ? "entitlement.created" : "allocation.created",
            data: {
              policy_ref: index === 0 ? policyRef : addonRef,
              allocation_reason: "addon",
            },
          });
        }
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
        const before = await snapshot();
        const batch = async (mode: "dry_run" | "apply") =>
          (
            await replayProviderEventsBatch({
              eventIds,
              mode,
              performer: { type: "local", username: "fixture" },
              requestedBy: "operator:fixture",
              reason: "batch fixture replay",
              runTransaction: async (fn) =>
                await tx.transaction(async (nested) => await fn(nested)),
            })
          ).unwrap();
        const dry = await batch("dry_run");
        expect(dry.map(({ kind }) => kind)).toEqual(["applied", "applied"]);
        expect(await snapshot()).toEqual(before);
        const applied = await batch("apply");
        expect(
          applied.map(({ id, kind, reason }) => ({ id, kind, reason })),
        ).toEqual(dry.map(({ id, kind, reason }) => ({ id, kind, reason })));
        expect((await snapshot()).allocations).toHaveLength(2);
      },
    );
  });

  for (const occurredAt of ["2026-07-02T00:00:00Z", undefined]) {
    test(`allocation replay refuses a receipt outside the current entitlement period using ${occurredAt === undefined ? "receipt time" : "provider time"}`, async () => {
      await withReplayFixture(async (tx, { seedReceipt, insertPolicy }) => {
        await insertPolicy();
        const entitlementId = `replay-${Bun.randomUUIDv7()}`;
        const allocationId = `replay-${Bun.randomUUIDv7()}`;
        await seedReceipt({ eventId: entitlementId });
        expect((await runReplay({ tx, eventId: entitlementId })).kind).toBe(
          "applied",
        );
        await seedReceipt({
          eventId: allocationId,
          eventType: "allocation.created",
          processedAt:
            occurredAt === undefined ? "2026-07-02T00:00:00Z" : START,
          data: { allocation_reason: "addon", occurred_at: occurredAt },
        });
        for (const mode of ["dry_run", "apply"] as const) {
          expect(
            (await runReplay({ tx, eventId: allocationId, mode })).kind,
          ).toBe("allocation_period_elapsed");
        }
        const receipt = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, allocationId));
        expect(receipt.at(0)?.replayAudit).toBeNull();
      });
    });
  }

  test("an already allocated ignored receipt becomes a terminal duplicate allocation", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId }) => {
        await insertPolicy();
        const entitlementId = `replay-${Bun.randomUUIDv7()}`;
        await seedReceipt({ eventId: entitlementId });
        expect((await runReplay({ tx, eventId: entitlementId })).kind).toBe(
          "applied",
        );
        const addonRef = `addon_${Bun.randomUUIDv7()}`;
        await tx.insert(usagePolicies).values({
          policyKey: addonRef,
          displayName: "Replay add-on",
          kind: "addon",
          monthlyUsageUnits: 5,
          hostedPolicyRef: addonRef,
        });
        const eventId = `replay-${Bun.randomUUIDv7()}`;
        const payload = {
          id: `allocation_${Bun.randomUUIDv7()}`,
          account_ref: `account_${organizationId}`,
          policy_ref: addonRef,
          allocation_reason: "addon",
          metadata: { organization_id: organizationId },
        };
        expect(
          (await handleHostedAllocation({ tx, eventId, payload })).kind,
        ).toBe("applied");
        await seedReceipt({
          eventId,
          eventType: "allocation.created",
          data: payload,
        });
        const before = await tx
          .select()
          .from(usageAllocations)
          .where(eq(usageAllocations.organizationId, organizationId));
        expect((await runReplay({ tx, eventId })).kind).toBe(
          "duplicate_allocation",
        );
        expect((await runReplay({ tx, eventId })).kind).toBe(
          "already_replayed",
        );
        expect(
          await tx
            .select()
            .from(usageAllocations)
            .where(eq(usageAllocations.organizationId, organizationId)),
        ).toEqual(before);
      },
    );
  });

  test("a dispatch failure rolls back simulated writes and produces a batch error row", async () => {
    await withReplayFixture(
      async (tx, { seedReceipt, insertPolicy, organizationId }) => {
        await insertPolicy();
        const eventId = `replay-${Bun.randomUUIDv7()}`;
        await seedReceipt({ eventId });
        const before = await tx.select().from(hostedUsageWebhookEvents);
        await tx.execute(sql`CREATE FUNCTION pg_temp.fail_replay_entitlement() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture dispatch failure'; END $$`);
        await tx.execute(sql`CREATE TRIGGER fail_replay_entitlement BEFORE INSERT ON usage_entitlements
        FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_replay_entitlement()`);
        const rows = (
          await replayProviderEventsBatch({
            eventIds: [eventId],
            mode: "dry_run",
            performer: { type: "local", username: "fixture" },
            requestedBy: "operator:fixture",
            reason: "failure fixture replay",
            runTransaction: async (fn) =>
              await tx.transaction(async (nested) => await fn(nested)),
          })
        ).unwrap();
        expect(rows).toMatchObject([{ id: eventId, kind: "error" }]);
        const singlePreview = await replayProviderEvent({
          eventId,
          selectedEventIds: [eventId],
          mode: "dry_run",
          performer: { type: "local", username: "fixture" },
          requestedBy: "operator:fixture",
          reason: "failure fixture replay",
          runTransaction: async (fn) => await fn(tx),
        });
        expect(singlePreview.isErr()).toBe(true);
        expect(await tx.select().from(hostedUsageWebhookEvents)).toEqual(
          before,
        );
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

      expect((await runReplay({ tx, eventId: completedId })).kind).toBe(
        "not_ignored",
      );
      expect((await runReplay({ tx, eventId: failedId })).kind).toBe(
        "not_ignored",
      );
      expect((await runReplay({ tx, eventId: purgedId })).kind).toBe(
        "payload_unavailable",
      );
      expect((await runReplay({ tx, eventId: incompleteId })).kind).toBe(
        "payload_unavailable",
      );
      expect((await runReplay({ tx, eventId: unsignedId })).kind).toBe(
        "payload_unavailable",
      );
      expect((await runReplay({ tx, eventId: minimalId })).kind).toBe(
        "payload_unavailable",
      );
      expect(
        (await runReplay({ tx, eventId: `missing-${Bun.randomUUIDv7()}` }))
          .kind,
      ).toBe("not_found");
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

        const selectedEventIds = [newerId, olderId];
        expect(
          (
            await runReplay({
              tx,
              eventId: newerId,
              selectedEventIds,
            })
          ).kind,
        ).toBe("applied");
        const olderOutcome = await runReplay({
          tx,
          eventId: olderId,
          selectedEventIds,
        });
        expect(olderOutcome.kind).toBe("ignored");
        expect(olderOutcome.reason).not.toBeNull();
        expect(olderOutcome.reason).not.toBe("Original ignored reason");
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
          errorMessage: olderOutcome.reason,
          replayAudit: [
            {
              outcome: "ignored",
              previousResult: "ignored",
              previousReason: "Original ignored reason",
            },
          ],
        });
        expect(
          (
            await runReplay({
              tx,
              eventId: olderId,
              selectedEventIds,
            })
          ).kind,
        ).toBe("ignored");
        const repeatedReceipt = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, olderId));
        expect(repeatedReceipt.at(0)?.replayAudit).toHaveLength(2);
        await redactCompletedWebhookEvents({
          db: tx,
          retentionDays: 1,
          now: new Date("2026-10-03T00:00:00Z"),
        });
        expect(
          (
            await runReplay({
              tx,
              eventId: newerId,
              selectedEventIds,
            })
          ).kind,
        ).toBe("already_replayed");
        const retainedReceipt = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, newerId));
        expect(retainedReceipt.at(0)?.payload).toEqual({});
        const retainedAttempts = retainedReceipt.at(0)?.replayAudit;
        expect(retainedAttempts).toMatchObject([
          { outcome: "applied", newResult: "ok" },
        ]);
        const retainedAttempt = retainedAttempts?.at(0);
        expect(retainedAttempt?.reason).toBeUndefined();
        expect(retainedAttempt?.previousReason).toBeUndefined();
        expect(retainedAttempt?.dispatchReason).toBeUndefined();
        expect(retainedAttempt?.event.metadata?.["reason"]).toBeUndefined();
        expect(
          retainedAttempt?.event.metadata?.["dispatchReason"],
        ).toBeUndefined();
      },
    );
  });

  test.each([
    {
      delivery: "replay",
      collision: "provider",
      name: "a committed dry run preserves state and applied replay racing live delivery keeps the newest event",
    },
    {
      delivery: "live",
      collision: "provider",
      name: "concurrent live first entitlement events both succeed and keep the newest event",
    },
    {
      delivery: "replay",
      collision: "organization",
      name: "applied replay racing a new live generation on the same organization keeps the newest event",
    },
    {
      delivery: "live",
      collision: "organization",
      name: "concurrent live first entitlement generations on the same organization both succeed and keep the newest event",
    },
  ] as const)("$name", async ({ delivery, collision }) => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    const previousFeatureUsage = env.FEATURE_USAGE;
    const previousSecret = env.HOSTED_USAGE_WEBHOOK_SECRET;
    const previousSecretPrevious = env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS;
    const testSecret = "test-replay-webhook-secret";
    env.FEATURE_USAGE = true;
    env.HOSTED_USAGE_WEBHOOK_SECRET = testSecret;
    env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = undefined;
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const owner = openClient({ max: 1 }).db;
        const worker = openClient({ max: 1 }).db;
        const schema = `provider_replay_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const eventId = `replay-${Bun.randomUUIDv7()}`;
        const liveId = `live-${Bun.randomUUIDv7()}`;
        const organizationId = toSafeId<"organization">(
          `org_${Bun.randomUUIDv7()}`,
        );
        const policyKey = `policy_${Bun.randomUUIDv7()}`;
        const payload = {
          id: `entitlement_${eventId}`,
          status: "active",
          account_ref: `account_${eventId}`,
          policy_ref: policyKey,
          current_period_start: START,
          current_period_end: END,
          metadata: { organization_id: organizationId },
          quantity: 2,
          occurred_at: START,
          created_at: START,
        };
        try {
          await owner.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
          await owner.execute(sql`CREATE TABLE ${sql.identifier(schema)}.usage_provider_webhook_events
            (LIKE public.usage_provider_webhook_events INCLUDING ALL)`);
          await owner.insert(organization).values({
            id: organizationId,
            name: "Replay race fixture",
            slug: organizationId,
            createdAt: new Date(START),
          });
          await owner.insert(usagePolicies).values({
            policyKey,
            displayName: "Replay race fixture",
            monthlyUsageUnits: 17,
            hostedPolicyRef: policyKey,
          });
          const runOnOwner: WebhookTransactionRunner = async (fn) =>
            await owner.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT set_config('search_path', ${`${schema},public`}, true)`,
              );
              return await fn(tx);
            });
          const runOnWorker: WebhookTransactionRunner = async (fn) =>
            await worker.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT set_config('search_path', ${`${schema},public`}, true)`,
              );
              return await fn(tx);
            });
          await runOnOwner(async (tx) => {
            await tx.insert(hostedUsageWebhookEvents).values({
              eventId,
              eventType: "entitlement.created",
              processedAt: new Date(START),
              result: "ignored",
              errorMessage: "Original ignored reason",
              payload: {
                type: "entitlement.created",
                data: payload,
                signatureVerified: true,
                payloadDigest: "fixture",
              },
            });
          });
          const snapshot = async () => ({
            receipts: await runOnOwner(
              async (tx) => await tx.select().from(hostedUsageWebhookEvents),
            ),
            entitlements: await owner
              .select()
              .from(usageEntitlements)
              .where(eq(usageEntitlements.organizationId, organizationId)),
            allocations: await owner
              .select()
              .from(usageAllocations)
              .where(eq(usageAllocations.organizationId, organizationId)),
            audits: await owner
              .select()
              .from(auditLogs)
              .where(eq(auditLogs.organizationId, organizationId)),
          });
          const before = await snapshot();
          const replay = async (
            mode: "dry_run" | "apply",
            runTransaction = runOnOwner,
          ) =>
            (
              await replayProviderEvent({
                eventId,
                selectedEventIds: [eventId],
                mode,
                performer: { type: "local", username: "fixture" },
                requestedBy: "operator:fixture",
                reason: "race fixture replay",
                runTransaction,
              })
            ).unwrap();
          if (delivery === "replay") {
            expect((await replay("dry_run")).kind).toBe("applied");
            expect(await snapshot()).toEqual(before);
          }
          const newest = "2026-06-03T00:00:00Z";
          const newerPayload =
            collision === "organization"
              ? {
                  ...payload,
                  id: `entitlement_${liveId}`,
                  account_ref: `account_${liveId}`,
                  created_at: newest,
                }
              : payload;
          const receive = async ({
            id,
            eventType,
            quantity,
            occurredAt,
            runTransaction,
            data = payload,
          }: {
            id: string;
            eventType: "entitlement.created" | "entitlement.updated";
            quantity: number;
            occurredAt: string;
            runTransaction: WebhookTransactionRunner;
            data?: typeof payload;
          }) => {
            const body = JSON.stringify({
              type: eventType,
              data: { ...data, quantity, occurred_at: occurredAt },
            });
            const timestamp = `${Math.floor(Date.now() / 1000)}`;
            const hasher = new Bun.CryptoHasher("sha256", testSecret);
            hasher.update(`${id}.${timestamp}.${body}`);
            const request = new Request(
              "http://api.test/usage/hosted/webhook",
              {
                method: "POST",
                headers: {
                  [HOSTED_USAGE_WEBHOOK_HEADERS.id]: id,
                  [HOSTED_USAGE_WEBHOOK_HEADERS.timestamp]: timestamp,
                  [HOSTED_USAGE_WEBHOOK_HEADERS.signature]: `v1,${hasher.digest("base64")}`,
                },
              },
            );
            return await receiveHostedUsageWebhook({
              request,
              body,
              runTransaction,
            });
          };
          const insertBarrier = createEntitlementInsertBarrier();
          const runRaceOnOwner: WebhookTransactionRunner = async (fn) =>
            await runOnOwner(async (tx) => await fn(insertBarrier.wrap(tx)));
          const runRaceOnWorker: WebhookTransactionRunner = async (fn) =>
            await runOnWorker(async (tx) => await fn(insertBarrier.wrap(tx)));
          const olderDelivery = async () => {
            if (delivery === "replay") {
              const replayed = await replay("apply", runRaceOnOwner);
              expect(["applied", "ignored"]).toContain(replayed.kind);
              return;
            }
            const received = await receive({
              id: `live-created-${Bun.randomUUIDv7()}`,
              eventType: "entitlement.created",
              quantity: 2,
              occurredAt: START,
              runTransaction: runRaceOnOwner,
            });
            expect(received.status).toBe(200);
          };
          const [, received] = await Promise.all([
            olderDelivery(),
            receive({
              id: liveId,
              eventType: "entitlement.updated",
              quantity: 3,
              occurredAt: newest,
              runTransaction: runRaceOnWorker,
              data: newerPayload,
            }),
          ]);
          expect(insertBarrier.arrivals()).toBe(2);
          expect(received.status).toBe(200);
          const entitlements = await owner
            .select()
            .from(usageEntitlements)
            .where(eq(usageEntitlements.organizationId, organizationId));
          expect(entitlements).toHaveLength(1);
          expect(entitlements.at(0)?.hostedLastEventAt).toEqual(
            new Date(newest),
          );
          expect(entitlements.at(0)?.seats).toBe(3);
          expect(entitlements.at(0)?.hostedEntitlementExternalId).toBe(
            newerPayload.id,
          );
          expect(entitlements.at(0)?.hostedAccountRef).toBe(
            newerPayload.account_ref,
          );
          expect(entitlements.at(0)?.hostedEntitlementCreatedAt).toEqual(
            new Date(newerPayload.created_at),
          );
          const audits = await owner
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId));
          expect(
            audits.filter(
              ({ action, resourceType }) =>
                action === AUDIT_ACTION.CREATE &&
                resourceType === AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
            ),
          ).toHaveLength(1);
        } finally {
          await owner
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await owner
            .delete(usagePolicies)
            .where(eq(usagePolicies.policyKey, policyKey));
          await owner.execute(
            sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`,
          );
        }
      });
    } finally {
      env.FEATURE_USAGE = previousFeatureUsage;
      env.HOSTED_USAGE_WEBHOOK_SECRET = previousSecret;
      env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = previousSecretPrevious;
    }
  });

  test("concurrent ignored replay operators preserve both attempts", async () => {
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
              errorMessage: "Original ignored reason",
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
              selectedEventIds: [eventId],
              mode: "apply",
              requestedBy: "operator:concurrent-fixture",
              performer: { type: "local", username: "concurrent-fixture" },
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
          ).toEqual(["ignored", "ignored"]);
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
            replayAudit: [
              {
                requestedBy: "operator:concurrent-fixture",
                execution: {
                  performer: { type: "local", username: "concurrent-fixture" },
                },
                outcome: "ignored",
                previousResult: "ignored",
                previousReason: "Original ignored reason",
              },
              { outcome: "ignored" },
            ],
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
