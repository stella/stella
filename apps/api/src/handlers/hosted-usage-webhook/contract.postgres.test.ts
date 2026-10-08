import { panic, TaggedError, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, TransactionRollbackError } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  hostedUsageWebhookEvents,
  usageAllocations,
  usageEntitlements,
  usagePolicies,
  USAGE_ENTITLEMENT_STATUSES,
} from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  HOSTED_USAGE_WEBHOOK_HEADERS,
  receiveHostedUsageWebhook,
} from "@/api/handlers/hosted-usage-webhook/receive";
import { replayProviderEventsBatch } from "@/api/handlers/hosted-usage-webhook/replay";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DEFAULT_POLAR_API_VERSION,
  POLAR_ENTITLEMENT_STATUSES,
  type PolarEntitlementStatus,
} from "@/api/lib/hosted-usage-provider/polar/contract";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { isEntitlementConsumableAt } from "@/api/lib/usage/usage-ledger";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  installRecordingAnalytics,
  installRecordingLogger,
  type RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const SECRET = "provider-contract-fixture-secret";
const START = "2026-06-01T00:00:00Z";
const END = "2026-07-01T00:00:00Z";

const withFixture = async (
  fn: (
    tx: Transaction,
    fixture: Awaited<ReturnType<typeof seedFixture>>,
  ) => Promise<void>,
) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  const previous = {
    feature: env.FEATURE_USAGE,
    secret: env.HOSTED_USAGE_WEBHOOK_SECRET,
    previousSecret: env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS,
    kind: env.HOSTED_USAGE_PROVIDER,
    version: env.HOSTED_USAGE_PROVIDER_API_VERSION,
  };
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  env.FEATURE_USAGE = true;
  env.HOSTED_USAGE_WEBHOOK_SECRET = SECRET;
  env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = undefined;
  env.HOSTED_USAGE_PROVIDER = "polar";
  env.HOSTED_USAGE_PROVIDER_API_VERSION = DEFAULT_POLAR_API_VERSION;
  try {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      try {
        await openClient().db.transaction(async (tx) => {
          await fn(tx, await seedFixture(tx));
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
    });
  } finally {
    env.FEATURE_USAGE = previous.feature;
    env.HOSTED_USAGE_WEBHOOK_SECRET = previous.secret;
    env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = previous.previousSecret;
    env.HOSTED_USAGE_PROVIDER = previous.kind;
    env.HOSTED_USAGE_PROVIDER_API_VERSION = previous.version;
    analytics.restore();
    logs.restore();
  }
};

const seedFixture = async (tx: Transaction) => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const policyRef = `policy_${Bun.randomUUIDv7()}`;
  await tx.insert(organization).values({
    id: organizationId,
    name: "Fixture",
    slug: organizationId,
    createdAt: new Date(START),
  });
  await tx.insert(usagePolicies).values({
    policyKey: `fixture_${Bun.randomUUIDv7()}`,
    displayName: "Fixture",
    monthlyUsageUnits: 17,
    hostedPolicyRef: policyRef,
  });
  return {
    organizationId,
    data: {
      id: `entitlement_${Bun.randomUUIDv7()}`,
      customer_id: `account_${Bun.randomUUIDv7()}`,
      product_id: policyRef,
      status: "active",
      seats: 2,
      created_at: START,
      modified_at: START,
      current_period_start: START,
      current_period_end: END,
      cancel_at_period_end: false,
      metadata: { organization_id: organizationId },
    },
  };
};

type DeliveryOptions = {
  tx: Transaction;
  type: string;
  data: Record<string, unknown>;
  eventId?: string;
  version?: string | null;
  headerVersion?: string;
  runTransaction?: WebhookTransactionRunner;
  expectedStatus?: 200 | 400 | 500;
};
const deliver = async ({
  tx,
  type,
  data,
  eventId = `event_${Bun.randomUUIDv7()}`,
  version = DEFAULT_POLAR_API_VERSION,
  headerVersion,
  runTransaction,
  expectedStatus = 200,
}: DeliveryOptions) => {
  const body = JSON.stringify({
    type,
    api_version: version ?? undefined,
    data,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = new Bun.CryptoHasher("sha256", SECRET)
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64");
  const headers = new Headers({
    [HOSTED_USAGE_WEBHOOK_HEADERS.id]: eventId,
    [HOSTED_USAGE_WEBHOOK_HEADERS.timestamp]: timestamp,
    [HOSTED_USAGE_WEBHOOK_HEADERS.signature]: `v1,${signature}`,
  });
  if (headerVersion !== undefined) {
    headers.set(HOSTED_USAGE_WEBHOOK_HEADERS.apiVersion, headerVersion);
  }
  const response = await receiveHostedUsageWebhook({
    body,
    request: new Request("https://api.test/usage/hosted/webhook", {
      method: "POST",
      headers,
    }),
    runTransaction:
      runTransaction ??
      (async (fn) => await tx.transaction(async (nested) => await fn(nested))),
  });
  expect(response.status).toBe(expectedStatus);
  return eventId;
};

const readState = async (
  tx: Transaction,
  organizationId: Awaited<ReturnType<typeof seedFixture>>["organizationId"],
) => ({
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

type ReplayBatchOptions = {
  tx: Transaction;
  eventIds: string[];
  mode: "dry_run" | "apply";
};
const replayBatch = async ({ tx, eventIds, mode }: ReplayBatchOptions) =>
  (
    await replayProviderEventsBatch({
      eventIds,
      mode,
      performer: { type: "local", username: "fixture" },
      requestedBy: "operator:fixture",
      reason: "contract fixture replay",
      runTransaction: async (fn) =>
        await tx.transaction(async (nested) => await fn(nested)),
    })
  ).unwrap();

const readReceipts = async (tx: Transaction, eventIds: string[]) =>
  await tx
    .select({
      eventId: hostedUsageWebhookEvents.eventId,
      result: hostedUsageWebhookEvents.result,
      errorMessage: hostedUsageWebhookEvents.errorMessage,
    })
    .from(hostedUsageWebhookEvents)
    .where(inArray(hostedUsageWebhookEvents.eventId, eventIds));

const ORGANIZATION_ABSENT_REASON = "organization does not exist";

const statusExpectations = {
  incomplete: "past_due",
  incomplete_expired: "cancelled",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "cancelled",
  unpaid: "past_due",
  paused: "paused",
} as const satisfies Record<PolarEntitlementStatus, UsageEntitlementStatus>;

// CI runs this through test:postgres against committed migrations.
describe.skipIf(!runPostgresTests)("provider contract on Postgres", () => {
  for (const type of [
    "subscription.created",
    "subscription.active",
    "subscription.updated",
    "subscription.past_due",
    "subscription.uncanceled",
    "subscription.cycled",
    "subscription.resumed",
  ]) {
    test(`null end rejects non-closed ${type} before recording a receipt`, async () => {
      await withFixture(async (tx, fixture) => {
        const eventId = await deliver({
          tx,
          type,
          data: { ...fixture.data, current_period_end: null },
          expectedStatus: 400,
        });
        expect(
          await tx
            .select()
            .from(hostedUsageWebhookEvents)
            .where(eq(hostedUsageWebhookEvents.eventId, eventId)),
        ).toHaveLength(0);
        expect(
          (await readState(tx, fixture.organizationId)).entitlements,
        ).toHaveLength(0);
        await deliver({ tx, type, data: fixture.data, eventId });
        expect(
          (await readState(tx, fixture.organizationId)).entitlements.at(0)
            ?.status,
        ).toBe("active");
      });
    });
  }

  for (const order of [
    ["subscription.paused", "subscription.created"],
    ["subscription.created", "subscription.paused"],
  ]) {
    test(`replacement pause respects generation in order ${order.join(", ")}`, async () => {
      await withFixture(async (tx, fixture) => {
        await deliver({
          tx,
          type: "subscription.created",
          data: { ...fixture.data, modified_at: "2026-06-03T00:00:00Z" },
        });
        const replacement = {
          ...fixture.data,
          id: `entitlement_${Bun.randomUUIDv7()}`,
          created_at: "2026-06-02T00:00:00Z",
          modified_at: "2026-06-02T00:00:00Z",
        };
        let pauseId = "";
        for (const type of order) {
          const eventId = await deliver({
            tx,
            type,
            data:
              type === "subscription.paused"
                ? { ...replacement, status: "paused", current_period_end: null }
                : replacement,
          });
          if (type === "subscription.paused") {
            pauseId = eventId;
          }
        }
        const paused = await readState(tx, fixture.organizationId);
        expect(paused.entitlements).toHaveLength(1);
        expect(paused.entitlements.at(0)).toMatchObject({
          hostedEntitlementExternalId: replacement.id,
          hostedEntitlementCreatedAt: new Date(replacement.created_at),
          status: "paused",
        });
        expect(
          await tx
            .select()
            .from(hostedUsageWebhookEvents)
            .where(eq(hostedUsageWebhookEvents.eventId, pauseId)),
        ).toMatchObject([{ result: "ok" }]);
        await deliver({ tx, type: "subscription.active", data: replacement });
        await deliver({
          tx,
          type: "subscription.paused",
          eventId: pauseId,
          data: { ...replacement, status: "paused", current_period_end: null },
        });
        expect(await readState(tx, fixture.organizationId)).toEqual(paused);
      });
    });
  }

  for (const status of POLAR_ENTITLEMENT_STATUSES) {
    test(`native status ${status} has an explicit state and replay is a fixed point`, async () => {
      await withFixture(async (tx, fixture) => {
        const eventId = await deliver({
          tx,
          type: "subscription.created",
          data: { ...fixture.data, status },
        });
        const first = await readState(tx, fixture.organizationId);
        expect(first.entitlements).toHaveLength(1);
        expect(first.entitlements.at(0)?.status).toBe(
          statusExpectations[status],
        );
        expect(first.audits.length).toBeGreaterThan(0);
        await deliver({
          tx,
          type: "subscription.created",
          data: { ...fixture.data, status },
          eventId,
        });
        expect(await readState(tx, fixture.organizationId)).toEqual(first);
      });
    });
  }

  const closedNativeStatuses = POLAR_ENTITLEMENT_STATUSES.filter(
    (status) =>
      statusExpectations[status] === "paused" ||
      statusExpectations[status] === "cancelled",
  );
  const denyingDeliveries = [
    { type: "subscription.paused", status: "paused", expected: "paused" },
    {
      type: "subscription.revoked",
      status: "canceled",
      expected: "cancelled",
    },
    ...["subscription.created", "subscription.updated"].flatMap((type) =>
      closedNativeStatuses.map((status) => ({
        type,
        status,
        expected: statusExpectations[status],
      })),
    ),
  ];
  for (const { type, status, expected } of denyingDeliveries) {
    test(`fresh denying ${type} ${status} never allocates a positive period`, async () => {
      await withFixture(async (tx, fixture) => {
        const data = { ...fixture.data, status, current_period_end: END };
        expect(new Date(END).getTime()).toBeGreaterThan(
          new Date(START).getTime(),
        );
        const eventId = await deliver({ tx, type, data });
        const first = await readState(tx, fixture.organizationId);
        expect(first.entitlements).toHaveLength(1);
        expect(first.entitlements.at(0)).toMatchObject({
          status: expected,
          currentPeriodStart: new Date(START),
          currentPeriodEnd: new Date(END),
        });
        expect(
          first.entitlements.some((entitlement) =>
            isEntitlementConsumableAt(
              entitlement,
              new Date("2026-06-15T00:00:00Z"),
            ),
          ),
        ).toBe(false);
        expect(first.allocations).toHaveLength(0);
        expect(
          first.audits.filter(
            ({ triggerSourceId }) => triggerSourceId === eventId,
          ),
        ).toMatchObject([
          { action: "create", resourceType: "usage_entitlement" },
        ]);
        await deliver({ tx, type, data, eventId });
        expect(await readState(tx, fixture.organizationId)).toEqual(first);
      });
    });
  }

  const revokedSnapshots = [...POLAR_ENTITLEMENT_STATUSES, "UNKNOWN"].flatMap(
    (status) =>
      ["absent", "active"].flatMap((priorState) =>
        [END, null].map((periodEnd) => ({ status, priorState, periodEnd })),
      ),
  );
  for (const { status, priorState, periodEnd } of revokedSnapshots) {
    test(`revoked snapshot ${status} denies ${priorState} state with ${periodEnd ?? "null"} end and applies once`, async () => {
      await withFixture(async (tx, fixture) => {
        if (priorState === "active") {
          await deliver({
            tx,
            type: "subscription.created",
            data: fixture.data,
          });
        }
        const before = await readState(tx, fixture.organizationId);
        if (priorState === "active") {
          expect(before.entitlements).toHaveLength(1);
          expect(
            before.entitlements.some((entitlement) =>
              isEntitlementConsumableAt(
                entitlement,
                new Date("2026-06-15T00:00:00Z"),
              ),
            ),
          ).toBe(true);
          expect(before.allocations).toHaveLength(1);
        }
        const logs = installRecordingLogger();
        const analytics = installRecordingAnalytics();
        try {
          const data = {
            ...fixture.data,
            status,
            seats: 7,
            modified_at: "2026-06-03T00:00:00Z",
            current_period_end: periodEnd,
          };
          const eventId = await deliver({
            tx,
            type: "subscription.revoked",
            data,
          });
          const first = await readState(tx, fixture.organizationId);
          expect(first.entitlements).toHaveLength(1);
          expect(first.entitlements.at(0)).toMatchObject({
            status: "cancelled",
            cancelAtPeriodEnd: false,
          });
          expect(
            first.entitlements.some((entitlement) =>
              isEntitlementConsumableAt(
                entitlement,
                new Date("2026-06-15T00:00:00Z"),
              ),
            ),
          ).toBe(false);
          expect(first.allocations).toEqual(before.allocations);
          expect(first.audits).toHaveLength(before.audits.length + 1);
          expect(
            first.audits.filter(
              ({ triggerSourceId }) => triggerSourceId === eventId,
            ),
          ).toMatchObject([
            {
              action: priorState === "active" ? "update" : "create",
              resourceType: "usage_entitlement",
              performerType: "service",
              triggerType: "webhook",
              organizationId: fixture.organizationId,
            },
          ]);
          expect(
            logs
              .at("ERROR")
              .filter(
                ({ message }) =>
                  message === "usage_provider.webhook.unknown_status",
              ),
          ).toHaveLength(status === "UNKNOWN" ? 1 : 0);
          expect(analytics.exceptions()).toHaveLength(
            status === "UNKNOWN" ? 1 : 0,
          );
          expect(
            await tx
              .select()
              .from(hostedUsageWebhookEvents)
              .where(eq(hostedUsageWebhookEvents.eventId, eventId)),
          ).toMatchObject([{ result: "ok" }]);
          await deliver({
            tx,
            type: "subscription.revoked",
            data,
            eventId,
          });
          expect(await readState(tx, fixture.organizationId)).toEqual(first);
          expect(
            logs
              .at("ERROR")
              .filter(
                ({ message }) =>
                  message === "usage_provider.webhook.unknown_status",
              ),
          ).toHaveLength(status === "UNKNOWN" ? 1 : 0);
          expect(analytics.exceptions()).toHaveLength(
            status === "UNKNOWN" ? 1 : 0,
          );
        } finally {
          logs.restore();
          analytics.restore();
        }
      });
    });
  }

  const reconciliationCases = [
    {
      type: "subscription.migrated",
      status: "active",
      alert: "usage_provider.webhook.contract_mismatch",
    },
    {
      type: "subscription.updated",
      status: "UNRECOGNISED",
      alert: "usage_provider.webhook.unknown_status",
    },
  ] as const;
  for (const { type, status, alert } of reconciliationCases) {
    for (const priorStatus of [null, ...POLAR_ENTITLEMENT_STATUSES]) {
      test(`${type} reconciliation preserves ${priorStatus ?? "absent"} state and audits exactly once`, async () => {
        await withFixture(async (tx, fixture) => {
          if (priorStatus !== null) {
            await deliver({
              tx,
              type: "subscription.created",
              data: { ...fixture.data, status: priorStatus },
            });
          }
          const before = await readState(tx, fixture.organizationId);
          const logs = installRecordingLogger();
          const analytics = installRecordingAnalytics();
          try {
            const data = {
              ...fixture.data,
              status,
              seats: 7,
              modified_at: "2026-06-03T00:00:00Z",
              metadata: {
                organization_id:
                  priorStatus === null
                    ? fixture.organizationId
                    : "org_unrelated",
              },
            };
            const eventId = await deliver({ tx, type, data });
            const after = await readState(tx, fixture.organizationId);
            expect(after.entitlements).toEqual(before.entitlements);
            expect(after.allocations).toEqual(before.allocations);
            expect(after.audits).toHaveLength(before.audits.length + 1);
            expect(
              after.audits.filter(
                ({ triggerSourceId }) => triggerSourceId === eventId,
              ),
            ).toMatchObject([
              {
                action: "review",
                performerType: "service",
                triggerType: "webhook",
                organizationId: fixture.organizationId,
              },
            ]);
            expect(
              logs.at("ERROR").filter(({ message }) => message === alert),
            ).toHaveLength(1);
            expect(analytics.exceptions()).toHaveLength(1);
            const receipts = await tx
              .select()
              .from(hostedUsageWebhookEvents)
              .where(eq(hostedUsageWebhookEvents.eventId, eventId));
            expect(receipts.at(0)?.result).toBe("ignored");
            await deliver({ tx, type, data, eventId });
            expect(await readState(tx, fixture.organizationId)).toEqual(after);
          } finally {
            logs.restore();
            analytics.restore();
          }
        });
      });
    }
  }

  const lifecycle = [
    { type: "subscription.cycled", status: "active", expected: "active" },
    { type: "subscription.paused", status: "paused", expected: "paused" },
    { type: "subscription.resumed", status: "active", expected: "active" },
    { type: "subscription.migrated", status: "active", expected: "active" },
  ] as const;
  for (const { type, status, expected } of lifecycle) {
    test(`${type} writes an attributed audit once and applies its disposition`, async () => {
      await withFixture(async (tx, fixture) => {
        await deliver({
          tx,
          type: "subscription.created",
          data: {
            ...fixture.data,
            status: type === "subscription.resumed" ? "paused" : "active",
          },
        });
        const before = await readState(tx, fixture.organizationId);
        const data = {
          ...fixture.data,
          status,
          modified_at: "2026-06-02T00:00:00Z",
          current_period_end: type === "subscription.paused" ? null : END,
        };
        const eventId = await deliver({ tx, type, data });
        const first = await readState(tx, fixture.organizationId);
        expect(first.entitlements.at(0)?.status).toBe(expected);
        const eventAudits = first.audits.filter(
          ({ triggerSourceId }) => triggerSourceId === eventId,
        );
        expect(eventAudits.length).toBeGreaterThan(0);
        expect(
          eventAudits.every(
            ({ performerType, triggerType, userId }) =>
              performerType === "service" &&
              triggerType === "webhook" &&
              userId === "system:usage-provider",
          ),
        ).toBe(true);
        expect(first.audits.length).toBeGreaterThan(before.audits.length);
        await deliver({ tx, type, data, eventId });
        expect(await readState(tx, fixture.organizationId)).toEqual(first);
      });
    });
  }

  test("same-version active replay cannot undo a pause; a newer resume can", async () => {
    await withFixture(async (tx, fixture) => {
      await deliver({ tx, type: "subscription.created", data: fixture.data });
      await deliver({
        tx,
        type: "subscription.paused",
        data: { ...fixture.data, status: "paused", current_period_end: null },
      });
      await deliver({ tx, type: "subscription.active", data: fixture.data });
      expect(
        (await readState(tx, fixture.organizationId)).entitlements.at(0)
          ?.status,
      ).toBe("paused");
      await deliver({
        tx,
        type: "subscription.resumed",
        data: { ...fixture.data, modified_at: "2026-06-02T00:00:00Z" },
      });
      expect(
        (await readState(tx, fixture.organizationId)).entitlements.at(0)
          ?.status,
      ).toBe("active");
    });
  });

  for (const order of [
    ["subscription.paused", "subscription.revoked"],
    ["subscription.revoked", "subscription.paused"],
  ]) {
    test(`same-version termination dominates pause in order ${order.join(", ")}`, async () => {
      await withFixture(async (tx, fixture) => {
        await deliver({ tx, type: "subscription.created", data: fixture.data });
        for (const type of order) {
          await deliver({
            tx,
            type,
            data: {
              ...fixture.data,
              status: type === "subscription.paused" ? "paused" : "canceled",
              modified_at: "2026-06-02T00:00:00Z",
            },
          });
        }
        expect(
          (await readState(tx, fixture.organizationId)).entitlements.at(0)
            ?.status,
        ).toBe("cancelled");
      });
    });
  }

  test("a pause delivered before creation fences same-version activation without allocating", async () => {
    await withFixture(async (tx, fixture) => {
      await deliver({
        tx,
        type: "subscription.paused",
        data: { ...fixture.data, status: "paused", current_period_end: null },
      });
      const paused = await readState(tx, fixture.organizationId);
      expect(paused.entitlements.at(0)?.status).toBe("paused");
      expect(paused.allocations).toHaveLength(0);
      expect(paused.audits.length).toBeGreaterThan(0);
      await deliver({ tx, type: "subscription.created", data: fixture.data });
      expect(await readState(tx, fixture.organizationId)).toEqual(paused);
      const resumedId = await deliver({
        tx,
        type: "subscription.resumed",
        data: { ...fixture.data, modified_at: "2026-06-02T00:00:00Z" },
      });
      const resumed = await readState(tx, fixture.organizationId);
      expect(resumed.entitlements.at(0)?.status).toBe("active");
      expect(resumed.entitlements.at(0)?.currentPeriodEnd).toEqual(
        new Date(END),
      );
      expect(resumed.allocations).toHaveLength(1);
      expect(resumed.allocations.at(0)?.units).toBe(34);
      expect(
        resumed.audits.some(
          ({ triggerSourceId, resourceType }) =>
            triggerSourceId === resumedId &&
            resourceType === "usage_allocation",
        ),
      ).toBe(true);
      await deliver({
        tx,
        type: "subscription.resumed",
        data: { ...fixture.data, modified_at: "2026-06-02T00:00:00Z" },
      });
      const replayed = await readState(tx, fixture.organizationId);
      expect(replayed.entitlements).toHaveLength(1);
      expect(replayed.entitlements.at(0)).toMatchObject({
        ...resumed.entitlements.at(0),
        updatedAt: expect.any(Date),
      });
      expect(replayed.allocations).toEqual(resumed.allocations);
    });
  });

  test("a matching header cannot hide a mismatched envelope version", async () => {
    await withFixture(async (tx, fixture) => {
      const logs = installRecordingLogger();
      try {
        await deliver({
          tx,
          type: "subscription.created",
          data: fixture.data,
          version: "2026-10",
          headerVersion: DEFAULT_POLAR_API_VERSION,
        });
        expect(
          logs
            .at("ERROR")
            .filter(
              ({ message }) =>
                message === "usage_provider.webhook.contract_mismatch",
            ),
        ).toHaveLength(1);
        expect(
          (await readState(tx, fixture.organizationId)).entitlements.at(0)
            ?.status,
        ).toBe("active");
      } finally {
        logs.restore();
      }
    });
  });

  test("matching versions do not raise a reconciliation alert", async () => {
    await withFixture(async (tx, fixture) => {
      const logs = installRecordingLogger();
      try {
        await deliver({
          tx,
          type: "subscription.created",
          data: fixture.data,
          headerVersion: DEFAULT_POLAR_API_VERSION,
        });
        expect(
          logs
            .at("ERROR")
            .filter(
              ({ message }) =>
                message === "usage_provider.webhook.contract_mismatch",
            ),
        ).toHaveLength(0);
      } finally {
        logs.restore();
      }
    });
  });

  test("a failure after dispatch rolls state, audit and receipt back together", async () => {
    await withFixture(async (tx, fixture) => {
      class FixtureCommitFailure extends TaggedError("FixtureCommitFailure")<{
        message: string;
      }> {}
      const eventId = `event_${Bun.randomUUIDv7()}`;
      const auditsBeforeFailure: number[] = [];
      await deliver({
        tx,
        type: "subscription.created",
        data: fixture.data,
        eventId,
        expectedStatus: 500,
        runTransaction: async (fn) =>
          await tx.transaction(async (nested) => {
            await fn(nested);
            auditsBeforeFailure.push(
              (await readState(nested, fixture.organizationId)).audits.length,
            );
            throw new FixtureCommitFailure({
              message: "Fixture transaction failed before commit",
            });
          }),
      });
      expect(auditsBeforeFailure).toHaveLength(1);
      expect(auditsBeforeFailure.at(0)).toBeGreaterThan(0);
      expect(await readState(tx, fixture.organizationId)).toEqual({
        entitlements: [],
        allocations: [],
        audits: [],
      });
      expect(
        await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, eventId)),
      ).toHaveLength(0);
      await deliver({
        tx,
        type: "subscription.created",
        data: fixture.data,
        eventId,
      });
      const applied = await readState(tx, fixture.organizationId);
      expect(applied.entitlements).toHaveLength(1);
      expect(applied.allocations).toHaveLength(1);
      expect(applied.audits.length).toBeGreaterThan(0);
    });
  });

  test("unknown authentic event types are recorded once without state or audit changes", async () => {
    await withFixture(async (tx, fixture) => {
      const eventId = await deliver({
        tx,
        type: "subscription.unrecognised",
        data: fixture.data,
      });
      await deliver({
        tx,
        type: "subscription.unrecognised",
        data: fixture.data,
        eventId,
      });
      expect(await readState(tx, fixture.organizationId)).toEqual({
        entitlements: [],
        allocations: [],
        audits: [],
      });
      const receipts = await tx
        .select()
        .from(hostedUsageWebhookEvents)
        .where(eq(hostedUsageWebhookEvents.eventId, eventId));
      expect(receipts).toHaveLength(1);
      expect(receipts.at(0)?.result).toBe("ignored");
    });
  });

  test("missing version is reported and retained without dropping a valid event", async () => {
    await withFixture(async (tx, fixture) => {
      const logs = installRecordingLogger();
      try {
        const eventId = await deliver({
          tx,
          type: "subscription.created",
          data: fixture.data,
          version: null,
        });
        expect(
          logs
            .at("ERROR")
            .filter(
              ({ message }) =>
                message === "usage_provider.webhook.contract_mismatch",
            ),
        ).toHaveLength(1);
        const receipts = await tx
          .select()
          .from(hostedUsageWebhookEvents)
          .where(eq(hostedUsageWebhookEvents.eventId, eventId));
        expect(receipts.at(0)?.payload).toMatchObject({
          delivery_api_version: null,
        });
        expect(
          (await readState(tx, fixture.organizationId)).entitlements.at(0)
            ?.status,
        ).toBe("active");
      } finally {
        logs.restore();
      }
    });
  });

  test("Postgres accepts closed periods only for the explicit denying states", async () => {
    await withFixture(async (tx, fixture) => {
      await deliver({
        tx,
        type: "subscription.paused",
        data: { ...fixture.data, status: "paused", current_period_end: null },
      });
      for (const status of USAGE_ENTITLEMENT_STATUSES) {
        const result = await Result.tryPromise({
          try: async () =>
            await tx.transaction(
              async (nested) =>
                await nested
                  .update(usageEntitlements)
                  .set({ status })
                  .where(
                    eq(
                      usageEntitlements.organizationId,
                      fixture.organizationId,
                    ),
                  ),
            ),
          catch: (cause) => cause,
        });
        if (status === "paused" || status === "cancelled") {
          expect(Result.isOk(result)).toBe(true);
          continue;
        }
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(getPgErrorCode(result.error)).toBe("23514");
        }
      }
    });
  });

  test("Postgres rejects inverted periods for every persisted status", async () => {
    await withFixture(async (tx, fixture) => {
      await deliver({ tx, type: "subscription.created", data: fixture.data });
      for (const status of USAGE_ENTITLEMENT_STATUSES) {
        const result = await Result.tryPromise({
          try: async () =>
            await tx.transaction(
              async (nested) =>
                await nested
                  .update(usageEntitlements)
                  .set({
                    status,
                    currentPeriodStart: new Date(END),
                    currentPeriodEnd: new Date(START),
                  })
                  .where(
                    eq(
                      usageEntitlements.organizationId,
                      fixture.organizationId,
                    ),
                  ),
            ),
          catch: (cause) => cause,
        });
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(getPgErrorCode(result.error)).toBe("23514");
        }
      }
    });
  });

  for (const headerVersion of [undefined, "2026-10"]) {
    test(`version mismatch (${headerVersion ?? "envelope"}) is recorded and reported while valid state applies`, async () => {
      await withFixture(async (tx, fixture) => {
        const logs = installRecordingLogger();
        const analytics = installRecordingAnalytics();
        try {
          const eventId = await deliver({
            tx,
            type: "subscription.created",
            data: fixture.data,
            version: "2026-10",
            ...(headerVersion === undefined ? {} : { headerVersion }),
          });
          expect(
            (await readState(tx, fixture.organizationId)).entitlements.at(0)
              ?.status,
          ).toBe("active");
          const receipts = await tx
            .select()
            .from(hostedUsageWebhookEvents)
            .where(eq(hostedUsageWebhookEvents.eventId, eventId));
          expect(receipts.at(0)?.payload).toMatchObject({
            api_version: "2026-10",
            delivery_api_version: "2026-10",
          });
          expect(
            logs
              .at("ERROR")
              .filter(
                ({ message }) =>
                  message === "usage_provider.webhook.contract_mismatch",
              ),
          ).toHaveLength(1);
          expect(analytics.exceptions()).toHaveLength(1);
        } finally {
          logs.restore();
          analytics.restore();
        }
      });
    });
  }
  const ownerlessEvents = [
    {
      type: "subscription.created",
      status: "active",
      cancelAtPeriodEnd: false,
    },
    {
      type: "subscription.updated",
      status: "active",
      cancelAtPeriodEnd: false,
    },
    {
      type: "subscription.canceled",
      status: "active",
      cancelAtPeriodEnd: true,
    },
    {
      type: "subscription.revoked",
      status: "canceled",
      cancelAtPeriodEnd: false,
    },
  ] as const;
  for (const { type, status, cancelAtPeriodEnd } of ownerlessEvents) {
    test(`${type} for an absent organization is an ignored, replayable receipt`, async () => {
      await withFixture(async (tx, fixture) => {
        const organizationId = toSafeId<"organization">(
          `org_${Bun.randomUUIDv7()}`,
        );
        const data = {
          ...fixture.data,
          status,
          cancel_at_period_end: cancelAtPeriodEnd,
          metadata: { organization_id: organizationId },
        };
        const eventId = await deliver({ tx, type, data });
        expect(await readReceipts(tx, [eventId])).toEqual([
          {
            eventId,
            result: "ignored",
            errorMessage: ORGANIZATION_ABSENT_REASON,
          },
        ]);
        expect(await readState(tx, organizationId)).toEqual({
          entitlements: [],
          allocations: [],
          audits: [],
        });
        await deliver({ tx, type, data, eventId });
        expect(
          await replayBatch({ tx, eventIds: [eventId], mode: "dry_run" }),
        ).toMatchObject([
          { id: eventId, kind: "ignored", reason: ORGANIZATION_ABSENT_REASON },
        ]);

        await tx.insert(organization).values({
          id: organizationId,
          name: "Fixture",
          slug: organizationId,
          createdAt: new Date(START),
        });
        expect(
          await replayBatch({ tx, eventIds: [eventId], mode: "apply" }),
        ).toMatchObject([{ id: eventId, kind: "applied" }]);
        expect(
          (await readState(tx, organizationId)).entitlements,
        ).toMatchObject([
          {
            hostedEntitlementExternalId: fixture.data.id,
            cancelAtPeriodEnd,
          },
        ]);
      });
    });
  }

  test("events after the organization is deleted are ignored receipts without state", async () => {
    await withFixture(async (tx, fixture) => {
      await deliver({ tx, type: "subscription.created", data: fixture.data });
      expect(
        (await readState(tx, fixture.organizationId)).entitlements,
      ).toHaveLength(1);
      await tx
        .delete(organization)
        .where(eq(organization.id, fixture.organizationId));

      const renewal = await deliver({
        tx,
        type: "subscription.updated",
        data: {
          ...fixture.data,
          modified_at: END,
          current_period_start: END,
          current_period_end: "2026-08-01T00:00:00Z",
        },
      });
      const cancellation = await deliver({
        tx,
        type: "subscription.canceled",
        data: {
          ...fixture.data,
          cancel_at_period_end: true,
          modified_at: "2026-07-02T00:00:00Z",
        },
      });
      const revocation = await deliver({
        tx,
        type: "subscription.revoked",
        data: {
          ...fixture.data,
          status: "canceled",
          modified_at: "2026-07-03T00:00:00Z",
        },
      });
      const eventIds = [renewal, cancellation, revocation];

      const receipts = await readReceipts(tx, eventIds);
      expect(
        eventIds.map((eventId) =>
          receipts.find((receipt) => receipt.eventId === eventId),
        ),
      ).toEqual(
        eventIds.map((eventId) => ({
          eventId,
          result: "ignored",
          errorMessage: ORGANIZATION_ABSENT_REASON,
        })),
      );
      expect(await readState(tx, fixture.organizationId)).toEqual({
        entitlements: [],
        allocations: [],
        audits: [],
      });
      expect(
        await tx
          .select({ id: usageEntitlements.id })
          .from(usageEntitlements)
          .where(
            eq(usageEntitlements.hostedEntitlementExternalId, fixture.data.id),
          ),
      ).toEqual([]);
      expect(
        await replayBatch({ tx, eventIds, mode: "dry_run" }),
      ).toMatchObject(
        eventIds.map((id) => ({
          id,
          kind: "ignored",
          reason: ORGANIZATION_ABSENT_REASON,
        })),
      );
    });
  });
});

// Operator alerting matches this exact message; renaming it silences the alarm.
const SECOND_LIVE_SUBSCRIPTION_EVENT =
  "usage_provider.webhook.second_live_subscription";

const secondLiveSubscriptionSignals = (logs: RecordingLogger) =>
  logs.records.filter(
    ({ message }) => message === SECOND_LIVE_SUBSCRIPTION_EVENT,
  );

// Oracle: the provider status that creates each local status, and whether a
// further subscription for the organization is an operator signal there.
const firstSubscriptionByLocalStatus = {
  trialing: { providerStatus: "trialing", signal: "silent" },
  active: { providerStatus: "active", signal: "emitted" },
  past_due: { providerStatus: "past_due", signal: "emitted" },
  cancelled: { providerStatus: "canceled", signal: "silent" },
  paused: { providerStatus: "paused", signal: "emitted" },
} as const satisfies Record<
  UsageEntitlementStatus,
  { providerStatus: PolarEntitlementStatus; signal: "emitted" | "silent" }
>;

const SECOND_CREATED_AT = "2026-06-02T00:00:00Z";

const withRecordedLogs = async (
  fn: (logs: RecordingLogger) => Promise<void>,
) => {
  const logs = installRecordingLogger();
  try {
    await fn(logs);
  } finally {
    logs.restore();
  }
};

describe.skipIf(!runPostgresTests)("second live subscription signal", () => {
  for (const localStatus of USAGE_ENTITLEMENT_STATUSES) {
    for (const customer of ["same_customer", "new_customer"] as const) {
      const { providerStatus, signal } =
        firstSubscriptionByLocalStatus[localStatus];
      test(`${localStatus} entitlement receiving another subscription (${customer}) is ${signal}`, async () => {
        await withFixture(async (tx, fixture) => {
          await withRecordedLogs(async (logs) => {
            const first = { ...fixture.data, status: providerStatus };
            await deliver({ tx, type: "subscription.created", data: first });
            expect(
              (await readState(tx, fixture.organizationId)).entitlements.at(0)
                ?.status,
            ).toBe(localStatus);
            expect(secondLiveSubscriptionSignals(logs)).toHaveLength(0);

            const second = {
              ...fixture.data,
              id: `entitlement_${Bun.randomUUIDv7()}`,
              customer_id:
                customer === "same_customer"
                  ? fixture.data.customer_id
                  : `account_${Bun.randomUUIDv7()}`,
              created_at: SECOND_CREATED_AT,
              modified_at: SECOND_CREATED_AT,
            };
            const eventId = await deliver({
              tx,
              type: "subscription.created",
              data: second,
            });
            expect(secondLiveSubscriptionSignals(logs)).toEqual(
              signal === "emitted"
                ? [
                    {
                      severityText: "ERROR",
                      message: SECOND_LIVE_SUBSCRIPTION_EVENT,
                      attributes: {
                        organizationId: fixture.organizationId,
                        liveSubscriptionId: first.id,
                        incomingSubscriptionId: second.id,
                      },
                    },
                  ]
                : [],
            );
            // The signal leaves the entitlement to the replacement rule.
            const after = await readState(tx, fixture.organizationId);
            expect(after.entitlements).toHaveLength(1);
            expect(after.entitlements.at(0)).toMatchObject({
              hostedEntitlementExternalId: second.id,
              hostedAccountRef: second.customer_id,
              status: "active",
            });
            expect(
              await tx
                .select({ result: hostedUsageWebhookEvents.result })
                .from(hostedUsageWebhookEvents)
                .where(eq(hostedUsageWebhookEvents.eventId, eventId)),
            ).toEqual([{ result: "ok" }]);

            const signalled = secondLiveSubscriptionSignals(logs).length;
            await deliver({
              tx,
              type: "subscription.updated",
              data: { ...second, modified_at: "2026-06-03T00:00:00Z" },
            });
            expect(secondLiveSubscriptionSignals(logs)).toHaveLength(signalled);
          });
        });
      });
    }
  }

  test("further events for the mapped subscription are silent", async () => {
    await withFixture(async (tx, fixture) => {
      await withRecordedLogs(async (logs) => {
        await deliver({ tx, type: "subscription.created", data: fixture.data });
        await deliver({
          tx,
          type: "subscription.updated",
          data: { ...fixture.data, modified_at: "2026-06-02T00:00:00Z" },
        });
        expect(secondLiveSubscriptionSignals(logs)).toHaveLength(0);
      });
    });
  });

  test("a terminal event for another subscription is silent", async () => {
    await withFixture(async (tx, fixture) => {
      await withRecordedLogs(async (logs) => {
        await deliver({ tx, type: "subscription.created", data: fixture.data });
        const before = await readState(tx, fixture.organizationId);
        await deliver({
          tx,
          type: "subscription.created",
          data: {
            ...fixture.data,
            id: `entitlement_${Bun.randomUUIDv7()}`,
            status: "canceled",
            created_at: SECOND_CREATED_AT,
            modified_at: SECOND_CREATED_AT,
          },
        });
        expect(secondLiveSubscriptionSignals(logs)).toHaveLength(0);
        expect(
          (await readState(tx, fixture.organizationId)).entitlements,
        ).toEqual(before.entitlements);
      });
    });
  });

  test("an older live subscription reappearing after replacement signals", async () => {
    await withFixture(async (tx, fixture) => {
      await withRecordedLogs(async (logs) => {
        await deliver({ tx, type: "subscription.created", data: fixture.data });
        const second = {
          ...fixture.data,
          id: `entitlement_${Bun.randomUUIDv7()}`,
          created_at: SECOND_CREATED_AT,
          modified_at: SECOND_CREATED_AT,
        };
        await deliver({ tx, type: "subscription.created", data: second });
        const replaced = await readState(tx, fixture.organizationId);
        await deliver({
          tx,
          type: "subscription.updated",
          data: { ...fixture.data, modified_at: "2026-06-03T00:00:00Z" },
        });
        expect(
          secondLiveSubscriptionSignals(logs).map(
            ({ attributes }) => attributes,
          ),
        ).toEqual([
          {
            organizationId: fixture.organizationId,
            liveSubscriptionId: fixture.data.id,
            incomingSubscriptionId: second.id,
          },
          {
            organizationId: fixture.organizationId,
            liveSubscriptionId: second.id,
            incomingSubscriptionId: fixture.data.id,
          },
        ]);
        expect(
          (await readState(tx, fixture.organizationId)).entitlements,
        ).toEqual(replaced.entitlements);
      });
    });
  });

  for (const { status, signal } of [
    { status: "active", signal: "emitted" },
    { status: "canceled", signal: "silent" },
  ] as const) {
    test(`a ${status} subscription naming another organization's live account is ${signal}`, async () => {
      await withFixture(async (tx, fixture) => {
        await withRecordedLogs(async (logs) => {
          const other = await seedFixture(tx);
          await deliver({
            tx,
            type: "subscription.created",
            data: fixture.data,
          });
          await deliver({ tx, type: "subscription.created", data: other.data });
          const before = {
            own: await readState(tx, fixture.organizationId),
            other: await readState(tx, other.organizationId),
          };
          const eventId = await deliver({
            tx,
            type: "subscription.updated",
            data: {
              ...fixture.data,
              status,
              customer_id: other.data.customer_id,
              modified_at: "2026-06-02T00:00:00Z",
            },
          });
          expect(
            secondLiveSubscriptionSignals(logs).map(
              ({ attributes }) => attributes,
            ),
          ).toEqual(
            signal === "emitted"
              ? [
                  {
                    organizationId: other.organizationId,
                    liveSubscriptionId: other.data.id,
                    incomingSubscriptionId: fixture.data.id,
                  },
                ]
              : [],
          );
          expect(
            (await readState(tx, fixture.organizationId)).entitlements,
          ).toEqual(before.own.entitlements);
          expect(
            (await readState(tx, other.organizationId)).entitlements,
          ).toEqual(before.other.entitlements);
          expect(
            await tx
              .select({ result: hostedUsageWebhookEvents.result })
              .from(hostedUsageWebhookEvents)
              .where(eq(hostedUsageWebhookEvents.eventId, eventId)),
          ).toEqual([{ result: "ignored" }]);
        });
      });
    });
  }
});
