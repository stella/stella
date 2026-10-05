import { panic } from "better-result";
import { describe, expect, test, setSystemTime } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { SETTING_ORGANIZATION_ID, stella } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationConfiguredAccess,
  usagePolicies,
  usageEntitlements,
  usageSeatAssignments,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  HOSTED_USAGE_WEBHOOK_HEADERS,
  receiveHostedUsageWebhook,
} from "@/api/handlers/hosted-usage-webhook/receive";
import getAccess from "@/api/handlers/usage/get-access";
import getLane from "@/api/handlers/usage/get-lane";
import { toSafeId } from "@/api/lib/branded-types";
import {
  POLAR_ENTITLEMENT_STATUSES,
  DEFAULT_POLAR_API_VERSION,
} from "@/api/lib/hosted-usage-provider/polar/contract";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import {
  CONFIGURED_ACCESS_STATE,
  configuredPaymentRetry,
} from "@/api/lib/usage/configured-access";
import { decideChatUsageLane } from "@/api/lib/usage/lane-routing";
import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "@/api/lib/usage/organization-access";
import { readOrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";
import {
  allowsInstanceModels,
  mayUseInstanceModels,
} from "@/api/lib/usage/organization-access-state";
import { resolveOrganizationActionBudget } from "@/api/lib/usage/organization-action-budget";
import {
  allocateUsage,
  assertUsageAvailable,
} from "@/api/lib/usage/usage-ledger";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const START = new Date("2026-06-01T00:00:00Z");
const END = new Date(START.getTime() + 67_000);
const RETRY_MS = 13_000;
const PROFILE = 17;
const SECRET = "configured-access-fixture-secret";
const at = (offset: number) => new Date(START.getTime() + offset);
const priors = [
  "absent",
  ...Object.values(ORGANIZATION_ACCESS_STATE),
  CONFIGURED_ACCESS_STATE,
  "ending",
  "payment_retry",
  "disabled",
] as const;
type Prior = (typeof priors)[number];

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
    FEATURE_USAGE: env.FEATURE_USAGE,
    FEATURE_CONFIGURED_ACCESS: env.FEATURE_CONFIGURED_ACCESS,
    FEATURE_ORG_ACCESS_STATE: env.FEATURE_ORG_ACCESS_STATE,
    PAYMENT_RETRY_WINDOW_MS: env.PAYMENT_RETRY_WINDOW_MS,
    HOSTED_USAGE_WEBHOOK_SECRET: env.HOSTED_USAGE_WEBHOOK_SECRET,
    HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS:
      env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS,
    HOSTED_USAGE_PROVIDER: env.HOSTED_USAGE_PROVIDER,
    HOSTED_USAGE_PROVIDER_API_VERSION: env.HOSTED_USAGE_PROVIDER_API_VERSION,
  };
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  env.FEATURE_USAGE = true;
  env.FEATURE_CONFIGURED_ACCESS = true;
  env.PAYMENT_RETRY_WINDOW_MS = RETRY_MS;
  env.HOSTED_USAGE_WEBHOOK_SECRET = SECRET;
  env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = undefined;
  env.HOSTED_USAGE_PROVIDER = "polar";
  env.HOSTED_USAGE_PROVIDER_API_VERSION = DEFAULT_POLAR_API_VERSION;
  setSystemTime(START);
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
    Object.assign(env, previous);
    setSystemTime();
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
    createdAt: START,
  });
  await tx.insert(usagePolicies).values({
    policyKey: `fixture_${Bun.randomUUIDv7()}`,
    displayName: "Fixture",
    monthlyUsageUnits: 23,
    serviceActionsPerPeriod: PROFILE,
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
      created_at: START.toISOString(),
      modified_at: START.toISOString(),
      current_period_start: START.toISOString(),
      current_period_end: END.toISOString(),
      cancel_at_period_end: false,
      metadata: { organization_id: organizationId },
    },
  };
};

type Delivery = {
  tx: Transaction;
  data: Record<string, unknown>;
  type?: string;
  eventId?: string;
  expectedStatus?: number;
};
const deliver = async ({
  tx,
  data,
  type = "subscription.updated",
  eventId = `event_${Bun.randomUUIDv7()}`,
  expectedStatus = 200,
}: Delivery) => {
  const body = JSON.stringify({
    type,
    api_version: DEFAULT_POLAR_API_VERSION,
    data,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = new Bun.CryptoHasher("sha256", SECRET)
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64");
  const response = await receiveHostedUsageWebhook({
    body,
    request: new Request("https://api.test/usage/hosted/webhook", {
      method: "POST",
      headers: {
        [HOSTED_USAGE_WEBHOOK_HEADERS.id]: eventId,
        [HOSTED_USAGE_WEBHOOK_HEADERS.timestamp]: timestamp,
        [HOSTED_USAGE_WEBHOOK_HEADERS.signature]: `v1,${signature}`,
      },
    }),
    runTransaction: async (fn) =>
      await tx.transaction(async (nested) => await fn(nested)),
  });
  expect(response.status).toBe(expectedStatus);
  return eventId;
};

const readAccess = async (
  tx: Transaction,
  organizationId: Awaited<ReturnType<typeof seedFixture>>["organizationId"],
) => {
  const row = await tx
    .select()
    .from(organizationConfiguredAccess)
    .where(eq(organizationConfiguredAccess.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));
  const original = await tx
    .select()
    .from(organizationAccessStates)
    .where(eq(organizationAccessStates.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));
  return {
    row,
    original,
    snapshot: await readOrganizationAccessSnapshot(tx, organizationId),
  };
};

const seedPrior = async (
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  prior: Prior,
) => {
  switch (prior) {
    case "absent":
      return;
    case "self_managed_keys":
      await tx
        .insert(organizationAccessStates)
        .values({ organizationId: fixture.organizationId, state: prior });
      return;
    case "evaluation_period":
    case "evaluation_ended":
      await tx.insert(organizationAccessStates).values({
        organizationId: fixture.organizationId,
        state: prior,
        evaluationStartedAt: START,
        evaluationEndsAt: END,
        evaluationEndedAt: prior === "evaluation_ended" ? START : null,
      });
      return;
    case "configured_access":
    case "ending":
    case "payment_retry":
    case "disabled":
      await deliver({ tx, data: fixture.data, type: "subscription.active" });
      if (prior === "configured_access") {
        return;
      }
      await deliver({
        tx,
        data: {
          ...fixture.data,
          modified_at: at(100).toISOString(),
          status: prior === "payment_retry" ? "past_due" : "active",
          cancel_at_period_end: prior === "ending",
        },
        type: (
          {
            ending: "subscription.canceled",
            disabled: "subscription.revoked",
            payment_retry: "subscription.updated",
          } as const
        )[prior],
      });
      return;
    default:
      prior satisfies never;
      panic("Unhandled fixture access state");
  }
};

const seedReader = async (
  tx: Transaction,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) => {
  const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
  await tx
    .insert(user)
    .values({ id: userId, name: "Fixture", email: `${userId}@test.local` });
  await tx.insert(member).values({
    id: `member_${Bun.randomUUIDv7()}`,
    organizationId: fixture.organizationId,
    userId,
    role: "member",
    createdAt: START,
  });
  await tx
    .insert(usageSeatAssignments)
    .values({ organizationId: fixture.organizationId, userId });
  await tx
    .update(usagePolicies)
    .set({ dailyAllowanceMicroUnits: 1000, fallbackWeeklyMicroUnits: 2000 })
    .where(eq(usagePolicies.hostedPolicyRef, fixture.data.product_id));
  return userId;
};

type ReadLaneBudgetsOptions = {
  tx: Transaction;
  organizationId: Awaited<ReturnType<typeof seedFixture>>["organizationId"];
  userId: Awaited<ReturnType<typeof seedReader>>;
  asOf: Date;
};
const readLaneBudgets = async ({
  tx,
  organizationId,
  userId,
  asOf,
}: ReadLaneBudgetsOptions) => {
  setSystemTime(asOf);
  let enabled = false;
  await tx
    .transaction(async (nested) => {
      const context = createTestHandlerContext<
        Parameters<typeof getLane.handler>[0]
      >({
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
        safeDb: createSafeDb(
          markRlsDatabase(nested),
          [],
          organizationId,
          userId,
        ),
      });
      const response = await getLane.handler(context);
      if (!("budgets" in response)) {
        panic("Lane read returned an unexpected error response");
      }
      enabled = response.budgets !== null;
      nested.rollback();
    })
    .then(
      () => panic("Read fixture unexpectedly committed"),
      (error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      },
    );
  return enabled;
};

const accessOf = (
  snapshot: Awaited<ReturnType<typeof readOrganizationAccessSnapshot>>,
  now: Date,
) => resolveOrganizationAccess({ snapshot, now, freeTier: FREE_TIER_OFF });

const expectEnabled = (
  snapshot: Awaited<ReturnType<typeof readAccess>>["snapshot"],
  now: Date,
  enabled: boolean,
) => {
  expect(allowsInstanceModels(accessOf(snapshot, now))).toBe(enabled);
  const resolved = resolveOrganizationActionBudget({
    access: accessOf(snapshot, now),
    periodMs: 23_000,
    evaluationActions: 7,
    selfManagedActions: 19,
  });
  expect(resolved.status).toBe(enabled ? "resolved" : "not_enabled");
  if (resolved.status === "resolved") {
    expect(resolved.policy.limit).toBe(PROFILE);
  }
};

// Independent oracle: only a confirmed activation can grant the initial profile;
// continuation events require a previously usable mapping.
const hasConfiguredAccess = (prior: Prior) =>
  prior === "configured_access" ||
  prior === "ending" ||
  prior === "payment_retry";

describe.skipIf(!runPostgresTests)(
  "configured access provider lifecycle",
  () => {
    for (const prior of priors) {
      for (const status of POLAR_ENTITLEMENT_STATUSES) {
        test(`${status} from ${prior} resolves access and repeated snapshots converge`, async () => {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, prior);
            const data = {
              ...fixture.data,
              status,
              modified_at: at(1000).toISOString(),
            };
            await deliver({ tx, data });
            const first = await readAccess(tx, fixture.organizationId);
            expectEnabled(
              first.snapshot,
              at(1000),
              status === "active" ||
                (status === "past_due" && hasConfiguredAccess(prior)),
            );
            await deliver({ tx, data });
            expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
              first.row,
            );
          });
        });
      }
      for (const type of ["subscription.canceled", "subscription.revoked"]) {
        test(`${type} from ${prior} preserves its deadline or denies immediately`, async () => {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, prior);
            const data = {
              ...fixture.data,
              modified_at: at(1000).toISOString(),
              status: "canceled",
              current_period_end: at(99_000).toISOString(),
              cancel_at_period_end: type === "subscription.canceled",
            };
            const eventId = await deliver({ tx, data, type });
            const first = await readAccess(tx, fixture.organizationId);
            const enabled =
              type === "subscription.canceled" && hasConfiguredAccess(prior);
            expectEnabled(first.snapshot, at(1000), enabled);
            if (enabled) {
              const deadline =
                prior === "payment_retry" ? at(100 + RETRY_MS) : END;
              for (const offset of [-1, 0, 1]) {
                expectEnabled(
                  first.snapshot,
                  new Date(deadline.getTime() + offset),
                  offset < 0,
                );
              }
            }
            await deliver({ tx, data, type, eventId });
            await deliver({ tx, data, type });
            expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
              first.row,
            );
          });
        });
      }
      for (const type of ["subscription.updated", "subscription.migrated"]) {
        test(`unrecognized ${type} from ${prior} retains the exact prior access state`, async () => {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, prior);
            const before = await readAccess(tx, fixture.organizationId);
            const data = {
              ...fixture.data,
              status: "provider_future_state",
              modified_at: at(1000).toISOString(),
            };
            const eventId = await deliver({ tx, data, type });
            await deliver({ tx, data, type, eventId });
            expect(await readAccess(tx, fixture.organizationId)).toEqual(
              before,
            );
          });
        });
      }
    }

    test("status and cancellation flags determine access across future and past period ends", async () => {
      for (const type of ["subscription.updated", "subscription.canceled"]) {
        for (const status of ["active", "canceled"]) {
          for (const cancelAtPeriodEnd of [false, true]) {
            for (const now of [at(1000), at(99_000)]) {
              await withFixture(async (tx, fixture) => {
                await seedPrior(tx, fixture, "configured_access");
                setSystemTime(now);
                await deliver({
                  tx,
                  type,
                  data: {
                    ...fixture.data,
                    status,
                    cancel_at_period_end: cancelAtPeriodEnd,
                    modified_at: now.toISOString(),
                  },
                });
                const result = await readAccess(tx, fixture.organizationId);
                const scheduled = status === "active" || cancelAtPeriodEnd;
                expectEnabled(result.snapshot, now, scheduled && now < END);
                expectEnabled(result.snapshot, END, false);
                expectEnabled(result.snapshot, at(99_000), false);
                const continuation = cancelAtPeriodEnd ? "ending" : "active";
                expect(result.row?.configuredAccessStatus).toBe(
                  scheduled ? continuation : "disabled",
                );
              });
            }
          }
        }
      }
    });

    test("retry boundary, recovery, new window and stale events preserve accepted versions", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "configured_access");
        const retryData = {
          ...fixture.data,
          status: "past_due",
          modified_at: at(1000).toISOString(),
        };
        await deliver({ tx, data: retryData });
        const first = await readAccess(tx, fixture.organizationId);
        const retryEnd = at(1000 + RETRY_MS);
        for (const offset of [-1, 0, 1]) {
          const now = new Date(retryEnd.getTime() + offset);
          expectEnabled(first.snapshot, now, offset < 0);
          expect(
            configuredPaymentRetry(
              first.snapshot?.state === "configured_access"
                ? first.snapshot.configuredAccess
                : null,
              now,
            ),
          ).toEqual(
            offset < 0
              ? { status: "payment_retry", endsAt: retryEnd.toISOString() }
              : { status: "none" },
          );
        }
        await deliver({
          tx,
          data: { ...retryData, modified_at: at(4000).toISOString() },
        });
        const repeated = await readAccess(tx, fixture.organizationId);
        expect(repeated.snapshot).toEqual(first.snapshot);
        expect(repeated.row?.sourceEventAt).toEqual(at(4000));
        // Equal-version and older activation cannot erase the payment failure.
        for (const offset of [500, 4000]) {
          await deliver({
            tx,
            type: "subscription.active",
            data: { ...fixture.data, modified_at: at(offset).toISOString() },
          });
          expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
            repeated.row,
          );
        }
        await deliver({
          tx,
          type: "subscription.active",
          data: { ...fixture.data, modified_at: at(5000).toISOString() },
        });
        const recovered = await readAccess(tx, fixture.organizationId);
        expect(recovered.row?.configuredAccessStatus).toBe("active");
        expect(recovered.row?.paymentRetryEndsAt).toBeNull();
        await deliver({ tx, data: retryData });
        expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
          recovered.row,
        );
        await deliver({
          tx,
          data: { ...retryData, modified_at: at(6000).toISOString() },
        });
        const next = await readAccess(tx, fixture.organizationId);
        expect(next.row?.paymentRetryEndsAt).toEqual(at(6000 + RETRY_MS));
        expectEnabled(next.snapshot, retryEnd, true);
        await deliver({
          tx,
          type: "subscription.revoked",
          data: {
            ...fixture.data,
            status: "provider_future_state",
            modified_at: at(7000).toISOString(),
          },
        });
        expectEnabled(
          (await readAccess(tx, fixture.organizationId)).snapshot,
          at(7000),
          false,
        );
        await deliver({
          tx,
          type: "subscription.active",
          data: { ...fixture.data, modified_at: at(7000).toISOString() },
        });
        expectEnabled(
          (await readAccess(tx, fixture.organizationId)).snapshot,
          at(7000),
          false,
        );
      });
    });

    test("equal-version retry and cancellation converge in either delivery order", async () => {
      for (const offset of [1000, 66_000]) {
        const snapshots: Awaited<ReturnType<typeof readAccess>>["snapshot"][] =
          [];
        for (const order of [
          ["subscription.updated", "subscription.canceled"],
          ["subscription.canceled", "subscription.updated"],
        ]) {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, "configured_access");
            for (const type of order) {
              await deliver({
                tx,
                type,
                data: {
                  ...fixture.data,
                  status:
                    type === "subscription.updated" ? "past_due" : "active",
                  cancel_at_period_end: type === "subscription.canceled",
                  modified_at: at(offset).toISOString(),
                },
              });
            }
            const snapshot = (await readAccess(tx, fixture.organizationId))
              .snapshot;
            const deadline = new Date(
              Math.min(END.getTime(), at(offset + RETRY_MS).getTime()),
            );
            expectEnabled(snapshot, new Date(deadline.getTime() - 1), true);
            expectEnabled(snapshot, deadline, false);
            snapshots.push(snapshot);
            await deliver({
              tx,
              type: "subscription.active",
              data: { ...fixture.data, modified_at: at(offset).toISOString() },
            });
            expect(
              (await readAccess(tx, fixture.organizationId)).snapshot,
            ).toEqual(snapshot);
          });
        }
        expect(snapshots.at(1)).toEqual(snapshots.at(0));
      }
    });

    test("access notification is member-readable, scoped, expires exactly and disappears on recovery", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "payment_retry");
        const expectNotice = async (
          organizationId: typeof fixture.organizationId,
          expected: Awaited<ReturnType<typeof getAccess.handler>>,
        ) => {
          await tx
            .transaction(async (nested) => {
              const context = createTestHandlerContext<
                Parameters<typeof getAccess.handler>[0]
              >({
                memberRole: sessionMemberRole("member"),
                session: { activeOrganizationId: organizationId },
                safeDb: createSafeDb(
                  markRlsDatabase(nested),
                  [],
                  organizationId,
                  null,
                ),
              });
              expect(await getAccess.handler(context)).toEqual(expected);
              // Scope SET LOCAL values must roll back with the savepoint before
              // the fixture's owner connection writes its next provider event.
              nested.rollback();
            })
            .then(
              () => panic("Read fixture unexpectedly committed"),
              (error: unknown) => {
                if (!(error instanceof TransactionRollbackError)) {
                  throw error;
                }
              },
            );
        };
        const deadline = at(100 + RETRY_MS);
        setSystemTime(new Date(deadline.getTime() - 1));
        await expectNotice(fixture.organizationId, {
          paymentRetry: {
            status: "payment_retry",
            endsAt: deadline.toISOString(),
          },
        });
        setSystemTime(deadline);
        await expectNotice(fixture.organizationId, {
          paymentRetry: { status: "none" },
        });
        setSystemTime(at(1000));
        await deliver({
          tx,
          data: { ...fixture.data, modified_at: at(1000).toISOString() },
          type: "subscription.active",
        });
        await expectNotice(fixture.organizationId, {
          paymentRetry: { status: "none" },
        });
        await deliver({
          tx,
          data: {
            ...fixture.data,
            status: "past_due",
            modified_at: at(2000).toISOString(),
          },
        });
        const other = await seedFixture(tx);
        await expectNotice(other.organizationId, {
          paymentRetry: { status: "none" },
        });
        env.FEATURE_CONFIGURED_ACCESS = false;
        // The unconfigured SafeDb from the helper panics if queried: off must not read.
        expect(
          await getAccess.handler(
            createTestHandlerContext<Parameters<typeof getAccess.handler>[0]>(),
          ),
        ).toEqual({ paymentRetry: { status: "none" } });
      });
    });

    test.each(["ledger", "lane-routing", "get-lane"] as const)(
      "configured consumption preserves the paid period start: %s",
      async (reader) => {
        await withFixture(async (tx, fixture) => {
          await seedPrior(tx, fixture, CONFIGURED_ACCESS_STATE);
          const userId = await seedReader(tx, fixture);
          const currentPeriodStart = at(1000);
          await tx
            .update(usageEntitlements)
            .set({ currentPeriodStart })
            .where(
              eq(usageEntitlements.organizationId, fixture.organizationId),
            );
          const snapshot = await readOrganizationAccessSnapshot(
            tx,
            fixture.organizationId,
          );
          expect(snapshot?.state).toBe(CONFIGURED_ACCESS_STATE);
          expect(allowsInstanceModels(accessOf(snapshot, at(999)))).toBe(true);
          for (const configuredAccess of [false, true]) {
            env.FEATURE_CONFIGURED_ACCESS = configuredAccess;
            for (const asOf of [at(999), currentPeriodStart]) {
              const options = {
                tx,
                organizationId: fixture.organizationId,
                asOf,
              };
              const started = asOf >= currentPeriodStart;
              switch (reader) {
                case "lane-routing":
                  expect(
                    await decideChatUsageLane({ ...options, userId }),
                  ).toBe(started ? "allowance" : "pool");
                  break;
                case "get-lane":
                  expect(await readLaneBudgets({ ...options, userId })).toBe(
                    started,
                  );
                  break;
                case "ledger": {
                  const ledger = await assertUsageAvailable({
                    ...options,
                    required: 1,
                  });
                  // The original ledger is status-only; configured access preserves the start.
                  expect(ledger.ok).toBe(!configuredAccess || started);
                  if (!ledger.ok) {
                    expect(ledger.error.reason).toBe("entitlement_inactive");
                  }
                  break;
                }
                default:
                  reader satisfies never;
              }
            }
          }
        });
      },
    );

    for (const prior of ["ending", "payment_retry", "disabled"] as const) {
      test(`ledger and lane readers follow ${prior} deadlines and retain disabled-feature behavior`, async () => {
        await withFixture(async (tx, fixture) => {
          await seedPrior(tx, fixture, prior);
          const userId = await seedReader(tx, fixture);
          const deadline = prior === "payment_retry" ? at(100 + RETRY_MS) : END;
          const options = { tx, organizationId: fixture.organizationId };
          for (const asOf of [new Date(deadline.getTime() - 1), deadline]) {
            const enabled = prior !== "disabled" && asOf < deadline;
            const before = await readAccess(tx, fixture.organizationId);
            const result = await assertUsageAvailable({
              ...options,
              required: 1,
              asOf,
            });
            expect(result.ok).toBe(enabled);
            if (!result.ok) {
              expect(result.error.reason).toBe("entitlement_inactive");
            }
            expect(
              await decideChatUsageLane({ ...options, userId, asOf }),
            ).toBe(enabled ? "allowance" : "pool");
            expect(await readLaneBudgets({ ...options, userId, asOf })).toBe(
              enabled,
            );
            expect(await readAccess(tx, fixture.organizationId)).toEqual(
              before,
            );
          }
          env.FEATURE_CONFIGURED_ACCESS = false;
          const asOf = at(101);
          expect(
            (await assertUsageAvailable({ ...options, required: 1, asOf })).ok,
          ).toBe(prior === "ending");
          expect(await decideChatUsageLane({ ...options, userId, asOf })).toBe(
            prior === "ending" ? "allowance" : "pool",
          );
          env.FEATURE_CONFIGURED_ACCESS = true;
          setSystemTime(at(1000));
          await deliver({
            tx,
            data: { ...fixture.data, modified_at: at(1000).toISOString() },
            type: "subscription.active",
          });
          const recoveryAsOf = at(1001);
          expect(
            (
              await assertUsageAvailable({
                ...options,
                required: 1,
                asOf: recoveryAsOf,
              })
            ).ok,
          ).toBe(true);
          const exhausted = await assertUsageAvailable({
            ...options,
            required: 999,
            asOf: recoveryAsOf,
          });
          expect(exhausted.ok).toBe(false);
          if (!exhausted.ok) {
            expect(exhausted.error.reason).toBe("usage_limit_exceeded");
          }
          if (prior === "payment_retry") {
            const retryAt = new Date(END.getTime() + 100);
            setSystemTime(retryAt);
            await deliver({
              tx,
              data: {
                ...fixture.data,
                status: "past_due",
                modified_at: retryAt.toISOString(),
              },
            });
            expect(
              await decideChatUsageLane({ ...options, userId, asOf: retryAt }),
            ).toBe("allowance");
            // Grace changes standing, never renews an expired allocation.
            const balance = await assertUsageAvailable({
              ...options,
              required: 1,
              asOf: retryAt,
            });
            expect(balance.ok).toBe(false);
            if (!balance.ok) {
              expect(balance.error.reason).toBe("usage_limit_exceeded");
            }
          }
        });
      });
    }

    test("disabled-feature ledger retains active status with an unexpired add-on after the paid period", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "configured_access");
        const userId = await seedReader(tx, fixture);
        await allocateUsage({
          tx,
          organizationId: fixture.organizationId,
          units: 5,
          reason: "addon",
          sourceType: "hosted_allocation",
          sourceRef: `addon_${Bun.randomUUIDv7()}`,
          period: { start: START, end: at(99_000) },
        });
        const asOf = new Date(END.getTime() + 1);
        const options = { tx, organizationId: fixture.organizationId, asOf };
        for (const enabled of [false, true]) {
          env.FEATURE_CONFIGURED_ACCESS = enabled;
          const result = await assertUsageAvailable({
            ...options,
            required: 1,
          });
          expect(result.ok).toBe(!enabled);
          if (!result.ok) {
            expect(result.error.reason).toBe("entitlement_inactive");
          }
          expect(await decideChatUsageLane({ ...options, userId })).toBe(
            "pool",
          );
          expect(await readLaneBudgets({ ...options, userId })).toBe(false);
        }
      });
    });

    test("all consumption readers fall back to original standing for a stale overlay", async () => {
      for (const status of ["active", "cancelled"] as const) {
        await withFixture(async (tx, fixture) => {
          await seedPrior(tx, fixture, "disabled");
          const userId = await seedReader(tx, fixture);
          await tx
            .update(usageEntitlements)
            .set({
              status,
              cancelAtPeriodEnd: false,
              hostedLastEventAt: at(1000),
            })
            .where(
              eq(usageEntitlements.organizationId, fixture.organizationId),
            );
          const options = {
            tx,
            organizationId: fixture.organizationId,
            asOf: at(1001),
          };
          const before = await readAccess(tx, fixture.organizationId);
          for (const enabled of [false, true]) {
            env.FEATURE_CONFIGURED_ACCESS = enabled;
            const result = await assertUsageAvailable({
              ...options,
              required: 1,
            });
            expect(result.ok).toBe(status === "active");
            if (!result.ok) {
              expect(result.error.reason).toBe("entitlement_inactive");
            }
            expect(await decideChatUsageLane({ ...options, userId })).toBe(
              status === "active" ? "allowance" : "pool",
            );
            expect(await readLaneBudgets({ ...options, userId })).toBe(
              status === "active",
            );
          }
          expect(await readAccess(tx, fixture.organizationId)).toEqual(before);
        });
      }
    });

    test("superseded generations cannot alter a newer mapping's access", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "configured_access");
        const newer = {
          ...fixture.data,
          id: `entitlement_${Bun.randomUUIDv7()}`,
          created_at: at(1000).toISOString(),
          modified_at: at(1000).toISOString(),
        };
        await deliver({ tx, data: newer, type: "subscription.active" });
        const before = await readAccess(tx, fixture.organizationId);
        for (const type of [
          "subscription.canceled",
          "subscription.revoked",
          "subscription.updated",
        ]) {
          await deliver({
            tx,
            type,
            data: {
              ...fixture.data,
              status: "past_due",
              modified_at: at(2000).toISOString(),
            },
          });
          expect(await readAccess(tx, fixture.organizationId)).toEqual(before);
        }
      });
    });

    test("replacement snapshots cannot inherit the previous generation's retry window", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "configured_access");
        await deliver({
          tx,
          data: {
            ...fixture.data,
            id: `entitlement_${Bun.randomUUIDv7()}`,
            status: "past_due",
            created_at: at(1000).toISOString(),
            modified_at: at(1000).toISOString(),
          },
        });
        expectEnabled(
          (await readAccess(tx, fixture.organizationId)).snapshot,
          at(1000),
          false,
        );
      });
    });

    test("disabled feature preserves access rows and the existing equal-version ordering", async () => {
      await withFixture(async (tx, fixture) => {
        env.FEATURE_CONFIGURED_ACCESS = false;
        await seedPrior(tx, fixture, "evaluation_period");
        const before = await readAccess(tx, fixture.organizationId);
        for (const status of POLAR_ENTITLEMENT_STATUSES) {
          await deliver({ tx, data: { ...fixture.data, status } });
          expect(await readAccess(tx, fixture.organizationId)).toEqual(before);
        }
        for (const type of ["subscription.canceled", "subscription.revoked"]) {
          await deliver({ tx, type, data: fixture.data });
          expect(await readAccess(tx, fixture.organizationId)).toEqual(before);
        }
        // The previous contract permits an equal-version recovery from past_due.
        const next = { ...fixture.data, modified_at: at(1000).toISOString() };
        await deliver({ tx, data: { ...next, status: "past_due" } });
        await deliver({ tx, type: "subscription.active", data: next });
        const rows = await tx
          .select({ status: usageEntitlements.status })
          .from(usageEntitlements)
          .where(eq(usageEntitlements.organizationId, fixture.organizationId))
          .limit(1);
        expect(rows.at(0)?.status).toBe("active");
        expect(await readAccess(tx, fixture.organizationId)).toEqual(before);
      });
    });

    test("feature toggles retain original standing and reevaluate stored deadlines without writes", async () => {
      for (const prior of [
        "self_managed_keys",
        "evaluation_period",
        "evaluation_ended",
      ] as const) {
        for (const type of [
          "subscription.updated",
          "subscription.canceled",
          "subscription.revoked",
        ]) {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, prior);
            env.FEATURE_ORG_ACCESS_STATE = true;
            const before = await readAccess(tx, fixture.organizationId);
            const modelBefore = await mayUseInstanceModels(
              tx,
              fixture.organizationId,
            );
            const budgetBefore = resolveOrganizationActionBudget({
              access: accessOf(before.snapshot, START),
              periodMs: 23_000,
              evaluationActions: 7,
              selfManagedActions: 19,
            });
            await deliver({
              tx,
              type: "subscription.active",
              data: fixture.data,
            });
            await deliver({
              tx,
              type,
              data: {
                ...fixture.data,
                status: type === "subscription.updated" ? "past_due" : "active",
                modified_at: at(100).toISOString(),
              },
            });
            const configured = await readAccess(tx, fixture.organizationId);
            expect(configured.original).toEqual(before.original);
            expect(configured.row).toBeDefined();
            env.FEATURE_CONFIGURED_ACCESS = false;
            const off = await readAccess(tx, fixture.organizationId);
            expect(off.snapshot).toEqual(before.snapshot);
            expect(off.original).toEqual(before.original);
            expect(off.row).toEqual(configured.row);
            expect(await mayUseInstanceModels(tx, fixture.organizationId)).toBe(
              modelBefore,
            );
            expect(
              resolveOrganizationActionBudget({
                access: accessOf(off.snapshot, START),
                periodMs: 23_000,
                evaluationActions: 7,
                selfManagedActions: 19,
              }),
            ).toEqual(budgetBefore);
            setSystemTime(at(99_000));
            env.FEATURE_CONFIGURED_ACCESS = true;
            const on = await readAccess(tx, fixture.organizationId);
            expectEnabled(on.snapshot, at(99_000), false);
            expect(on.row).toEqual(configured.row);
            expect(on.original).toEqual(before.original);
          });
        }
      }
    });

    test("events applied while disabled supersede stale overlays without extending their windows", async () => {
      for (const type of [
        "subscription.active",
        "subscription.updated",
        "subscription.revoked",
      ]) {
        for (const offset of [100, 5000]) {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, "evaluation_period");
            const original = (await readAccess(tx, fixture.organizationId))
              .snapshot;
            await deliver({
              tx,
              type: "subscription.active",
              data: fixture.data,
            });
            await deliver({
              tx,
              data: {
                ...fixture.data,
                status: "past_due",
                modified_at: at(100).toISOString(),
              },
            });
            const overlay = (await readAccess(tx, fixture.organizationId)).row;
            env.FEATURE_CONFIGURED_ACCESS = false;
            await deliver({
              tx,
              type,
              data: {
                ...fixture.data,
                status: type === "subscription.updated" ? "past_due" : "active",
                modified_at: at(offset).toISOString(),
              },
            });
            expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
              overlay,
            );
            env.FEATURE_CONFIGURED_ACCESS = true;
            const on = await readAccess(tx, fixture.organizationId);
            expect(on.row).toEqual(overlay);
            if (type === "subscription.revoked") {
              expectEnabled(on.snapshot, at(1000), false);
            } else if (offset > 100 || type === "subscription.active") {
              expect(on.snapshot).toEqual(original);
            } else {
              // An exact source replay contains no newer or different fact.
              expect(on.snapshot?.state).toBe(CONFIGURED_ACCESS_STATE);
              expect(on.row?.paymentRetryEndsAt).toEqual(at(100 + RETRY_MS));
            }
          });
        }
      }
    });

    test("unversioned source changes invalidate overlays while unchanged replays retain them", async () => {
      for (const prior of ["configured_access", "payment_retry"] as const) {
        for (const type of [
          "subscription.active",
          "subscription.updated",
          "subscription.canceled",
          "subscription.revoked",
        ]) {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, "evaluation_period");
            const original = (await readAccess(tx, fixture.organizationId))
              .snapshot;
            await seedPrior(tx, fixture, prior);
            const before = await readAccess(tx, fixture.organizationId);
            env.FEATURE_CONFIGURED_ACCESS = false;
            await deliver({
              tx,
              type,
              data: {
                ...fixture.data,
                modified_at: undefined,
                created_at: undefined,
                status: type === "subscription.updated" ? "past_due" : "active",
              },
            });
            env.FEATURE_CONFIGURED_ACCESS = true;
            const after = await readAccess(tx, fixture.organizationId);
            expect(after.row).toEqual(before.row);
            if (type === "subscription.revoked") {
              expectEnabled(after.snapshot, at(1000), false);
            } else if (
              (prior === "configured_access" &&
                type === "subscription.active") ||
              (prior === "payment_retry" && type === "subscription.updated")
            ) {
              expect(after.snapshot).toEqual(before.snapshot);
            } else {
              expect(after.snapshot).toEqual(original);
            }
          });
        }
      }
    });

    test("only evaluated standing and lifecycle provenance invalidate a configured overlay", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "evaluation_period");
        await seedPrior(tx, fixture, "ending");
        const before = await readAccess(tx, fixture.organizationId);
        await tx
          .update(organizationAccessStates)
          .set({ updatedAt: at(5000) })
          .where(
            eq(organizationAccessStates.organizationId, fixture.organizationId),
          );
        await tx
          .update(usageEntitlements)
          .set({ updatedAt: at(5000), seats: 3 })
          .where(eq(usageEntitlements.organizationId, fixture.organizationId));
        const unrelated = await readAccess(tx, fixture.organizationId);
        expect(unrelated.snapshot).toEqual(before.snapshot);
        expect(unrelated.row).toEqual(before.row);
        expectEnabled(unrelated.snapshot, at(66_999), true);
        await tx
          .update(organizationAccessStates)
          .set({ evaluationEndsAt: at(60_000) })
          .where(
            eq(organizationAccessStates.organizationId, fixture.organizationId),
          );
        const changedEnd = await readAccess(tx, fixture.organizationId);
        expect(changedEnd.snapshot).toEqual({
          state: "evaluation_period",
          evaluationEndsAt: at(60_000),
        });
        expectEnabled(changedEnd.snapshot, at(66_999), false);
        await tx
          .update(organizationAccessStates)
          .set({
            evaluationEndsAt: END,
            state: "evaluation_ended",
            evaluationEndedAt: at(5000),
          })
          .where(
            eq(organizationAccessStates.organizationId, fixture.organizationId),
          );
        const changedState = await readAccess(tx, fixture.organizationId);
        expect(changedState.snapshot).toEqual({
          state: "evaluation_ended",
          evaluationEndsAt: END,
        });
        expectEnabled(changedState.snapshot, at(6000), false);
        expect(changedState.row).toEqual(before.row);
      });
    });

    test("a continuation cannot revive an overlay invalidated while the feature was disabled", async () => {
      for (const offType of ["subscription.revoked", "subscription.active"]) {
        await withFixture(async (tx, fixture) => {
          await seedPrior(
            tx,
            fixture,
            offType === "subscription.revoked"
              ? "configured_access"
              : "payment_retry",
          );
          env.FEATURE_CONFIGURED_ACCESS = false;
          await deliver({
            tx,
            type: offType,
            data: { ...fixture.data, modified_at: at(5000).toISOString() },
          });
          env.FEATURE_CONFIGURED_ACCESS = true;
          await deliver({
            tx,
            data: {
              ...fixture.data,
              status: "past_due",
              modified_at: at(20_000).toISOString(),
            },
          });
          const after = await readAccess(tx, fixture.organizationId);
          expect(after.row?.configuredAccessStatus).toBe("disabled");
          expectEnabled(after.snapshot, at(20_000), false);
          await deliver({
            tx,
            type: "subscription.active",
            data: { ...fixture.data, modified_at: at(21_000).toISOString() },
          });
          await deliver({
            tx,
            data: {
              ...fixture.data,
              status: "past_due",
              modified_at: at(22_000).toISOString(),
            },
          });
          expect(
            (await readAccess(tx, fixture.organizationId)).row
              ?.paymentRetryEndsAt,
          ).toEqual(at(22_000 + RETRY_MS));
        });
      }
    });

    test("a replacement accepted while disabled cannot authenticate the old generation with an earlier event clock", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "evaluation_ended");
        const original = (await readAccess(tx, fixture.organizationId))
          .snapshot;
        await deliver({
          tx,
          type: "subscription.active",
          data: { ...fixture.data, modified_at: at(5000).toISOString() },
        });
        const overlay = (await readAccess(tx, fixture.organizationId)).row;
        env.FEATURE_CONFIGURED_ACCESS = false;
        await deliver({
          tx,
          type: "subscription.active",
          data: {
            ...fixture.data,
            id: `replacement_${Bun.randomUUIDv7()}`,
            created_at: at(1000).toISOString(),
            modified_at: at(2000).toISOString(),
          },
        });
        env.FEATURE_CONFIGURED_ACCESS = true;
        const after = await readAccess(tx, fixture.organizationId);
        expect(after.row).toEqual(overlay);
        expect(after.snapshot).toEqual(original);
        expectEnabled(after.snapshot, START, false);
      });
    });

    test("an unknown original entitlement status cannot authenticate a configured overlay", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "evaluation_ended");
        const original = (await readAccess(tx, fixture.organizationId))
          .snapshot;
        await seedPrior(tx, fixture, "configured_access");
        const overlay = (await readAccess(tx, fixture.organizationId)).row;
        await tx.execute(
          sql`UPDATE ${usageEntitlements} SET status = 'unknown_fixture' WHERE organization_id = ${fixture.organizationId}`,
        );
        const after = await readAccess(tx, fixture.organizationId);
        expect(after.snapshot).toEqual(original);
        expect(after.row).toEqual(overlay);
        expectEnabled(after.snapshot, START, false);
      });
    });

    test("a failed enclosing transaction cannot persist access independently of its event", async () => {
      await withFixture(async (tx, fixture) => {
        const result = await tx
          .transaction(async (nested) => {
            await deliver({
              tx: nested,
              type: "subscription.active",
              data: fixture.data,
            });
            expect(
              (await readAccess(nested, fixture.organizationId)).row
                ?.configuredAccessStatus,
            ).toBe("active");
            nested.rollback();
          })
          .then(
            () => "committed",
            (error: unknown) => {
              if (!(error instanceof TransactionRollbackError)) {
                throw error;
              }
              return "rolled_back";
            },
          );
        expect(result).toBe("rolled_back");
        expect(
          (await readAccess(tx, fixture.organizationId)).row,
        ).toBeUndefined();
      });
    });
    test("a replacement with matching lifecycle fields invalidates the old overlay", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "evaluation_ended");
        const original = (await readAccess(tx, fixture.organizationId))
          .snapshot;
        await deliver({
          tx,
          type: "subscription.active",
          data: { ...fixture.data, modified_at: at(5000).toISOString() },
        });
        const before = await readAccess(tx, fixture.organizationId);
        expectEnabled(before.snapshot, at(6000), true);
        const replacementId = `replacement_${Bun.randomUUIDv7()}`;
        env.FEATURE_CONFIGURED_ACCESS = false;
        await deliver({
          tx,
          type: "subscription.active",
          data: {
            ...fixture.data,
            id: replacementId,
            created_at: at(1000).toISOString(),
            modified_at: at(5000).toISOString(),
            current_period_end: at(99_000).toISOString(),
          },
        });
        const source = await tx
          .select()
          .from(usageEntitlements)
          .where(eq(usageEntitlements.organizationId, fixture.organizationId))
          .limit(1)
          .then((rows) => rows.at(0));
        // Prove replacement acceptance and the collision, not an ignored event.
        expect(source?.hostedEntitlementExternalId).toBe(replacementId);
        expect(source?.hostedLastEventAt).toEqual(before.row?.sourceEventAt);
        expect(source?.status).toBe(before.row?.sourceEntitlementStatus);
        expect(source?.cancelAtPeriodEnd).toBe(
          before.row?.sourceCancelAtPeriodEnd,
        );
        env.FEATURE_CONFIGURED_ACCESS = true;
        const after = await readAccess(tx, fixture.organizationId);
        expect(after.row).toEqual(before.row);
        expect(after.snapshot).toEqual(original);
        expectEnabled(after.snapshot, at(6000), false);
      });
    });

    test("a retry snapshot carrying scheduled cancellation cannot exceed the paid end", async () => {
      await withFixture(async (tx, fixture) => {
        await seedPrior(tx, fixture, "configured_access");
        await deliver({
          tx,
          data: {
            ...fixture.data,
            status: "past_due",
            cancel_at_period_end: true,
            modified_at: at(66_000).toISOString(),
          },
        });
        const result = await readAccess(tx, fixture.organizationId);
        expect(result.row?.sourceCancelAtPeriodEnd).toBe(true);
        expect(result.row?.configuredAccessStatus).toBe("payment_retry");
        expect(result.row?.paymentRetryEndsAt).toEqual(END);
        for (const delta of [-1, 0, 1]) {
          expectEnabled(
            result.snapshot,
            new Date(END.getTime() + delta),
            delta < 0,
          );
        }
        expect(
          configuredPaymentRetry(
            result.snapshot?.state === CONFIGURED_ACCESS_STATE
              ? result.snapshot.configuredAccess
              : null,
            new Date(END.getTime() - 1),
          ),
        ).toEqual({ status: "payment_retry", endsAt: END.toISOString() });
      });
    });

    test("canceled snapshots without a cancellation flag deny immediately", async () => {
      for (const type of ["subscription.updated", "subscription.canceled"]) {
        for (const prior of [
          "absent",
          "configured_access",
          "ending",
        ] as const) {
          await withFixture(async (tx, fixture) => {
            await seedPrior(tx, fixture, prior);
            const data = {
              ...fixture.data,
              status: "canceled",
              cancel_at_period_end: undefined,
              modified_at: at(1000).toISOString(),
            };
            expect(JSON.stringify(data)).not.toContain("cancel_at_period_end");
            await deliver({ tx, type, data });
            const first = await readAccess(tx, fixture.organizationId);
            expect(first.row?.configuredAccessStatus).toBe("disabled");
            expectEnabled(first.snapshot, at(1000), false);
            await deliver({ tx, type, data });
            expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
              first.row,
            );
          });
        }
      }
    });

    test("application scopes see only their configured access and cannot write it", async () => {
      await withFixture(async (tx, fixture) => {
        const other = await seedFixture(tx);
        await seedPrior(tx, fixture, "configured_access");
        await seedPrior(tx, other, "payment_retry");
        const beforeA = (await readAccess(tx, fixture.organizationId)).row;
        const beforeB = (await readAccess(tx, other.organizationId)).row;
        expect(beforeA).toBeDefined();
        expect(beforeB).toBeDefined();
        await tx
          .transaction(async (nested) => {
            await nested.execute(sql`SELECT
        set_config('role', ${stella.name}, true),
        set_config(${SETTING_ORGANIZATION_ID}, ${fixture.organizationId}, true)`);
            expect(
              await nested
                .select({
                  organizationId: organizationConfiguredAccess.organizationId,
                })
                .from(organizationConfiguredAccess),
            ).toEqual([{ organizationId: fixture.organizationId }]);
            expect(
              await nested
                .select()
                .from(organizationConfiguredAccess)
                .where(
                  eq(
                    organizationConfiguredAccess.organizationId,
                    other.organizationId,
                  ),
                ),
            ).toEqual([]);
            expect(
              await nested
                .update(organizationConfiguredAccess)
                .set({
                  configuredAccessStatus: "disabled",
                  configuredPeriodEndsAt: null,
                  paymentRetryEndsAt: null,
                  serviceActionsPerPeriod: null,
                })
                .where(
                  eq(
                    organizationConfiguredAccess.organizationId,
                    fixture.organizationId,
                  ),
                )
                .returning(),
            ).toEqual([]);
            expect(
              await nested
                .delete(organizationConfiguredAccess)
                .where(
                  eq(
                    organizationConfiguredAccess.organizationId,
                    fixture.organizationId,
                  ),
                )
                .returning(),
            ).toEqual([]);
            const rejected = await nested
              .transaction(async (write) => {
                await write.insert(organizationConfiguredAccess).values({
                  organizationId: fixture.organizationId,
                  sourceSignature: "null",
                  sourceEntitlementExternalId: "fixture-generation",
                  sourceEntitlementStatus: "active",
                  sourceCancelAtPeriodEnd: false,
                  configuredAccessStatus: "disabled",
                });
              })
              .then(
                () => null,
                (error: unknown) => error,
              );
            // RLS rejects before the duplicate primary key; savepoint restores scope.
            expect(getPgErrorCode(rejected)).toBe(
              PG_ERROR.INSUFFICIENT_PRIVILEGE,
            );
            nested.rollback();
          })
          .then(
            () => panic("Read fixture unexpectedly committed"),
            (error: unknown) => {
              if (!(error instanceof TransactionRollbackError)) {
                throw error;
              }
            },
          );
        expect((await readAccess(tx, fixture.organizationId)).row).toEqual(
          beforeA,
        );
        expect((await readAccess(tx, other.organizationId)).row).toEqual(
          beforeB,
        );
      });
    });
  },
);
