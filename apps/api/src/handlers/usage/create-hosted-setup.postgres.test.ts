import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import { HOSTED_CHECKOUT_REFUSAL_CODE } from "@stll/api-contract/hosted-checkout";
import { assertProperty } from "@stll/property-testing";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  hostedCheckoutClaims,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  USAGE_ENTITLEMENT_STATUSES,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  HOSTED_USAGE_WEBHOOK_HEADERS,
  receiveHostedUsageWebhook,
} from "@/api/handlers/hosted-usage-webhook/receive";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_POLAR_API_VERSION } from "@/api/lib/hosted-usage-provider/polar/contract";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import createHostedSetup from "./create-hosted-setup";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const WEBHOOK_SECRET = "hosted-checkout-fixture-secret";
const PROVIDER_BASE_URL = "https://provider.test";
const HOUR_MS = 3_600_000;
const PROVIDER_SESSION_EXPIRY = new Date("2031-01-01T00:00:00.000Z");

type Fixture = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  policyId: SafeId<"usagePolicy">;
  policyRef: string;
  /** A per-seat subscription, so a start can carry a seat count. */
  seatPolicyId: SafeId<"usagePolicy">;
};

const seedFixture = async (
  tx: Pick<Transaction, "insert">,
): Promise<Fixture> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const policyId = createSafeId<"usagePolicy">();
  const policyRef = `product_${Bun.randomUUIDv7()}`;
  const seatPolicyId = createSafeId<"usagePolicy">();
  await tx.insert(organization).values({
    id: organizationId,
    name: "Hosted checkout fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await tx.insert(user).values({
    id: userId,
    name: "Hosted checkout fixture",
    email: `${userId}@example.test`,
  });
  await tx.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await tx.insert(usagePolicies).values({
    id: policyId,
    policyKey: `checkout_${Bun.randomUUIDv7()}`,
    displayName: "Hosted checkout fixture",
    kind: "subscription",
    monthlyUsageUnits: 100,
    hostedPolicyRef: policyRef,
    visibility: "public",
  });
  await tx.insert(usagePolicies).values({
    id: seatPolicyId,
    policyKey: `checkout_${Bun.randomUUIDv7()}`,
    displayName: "Hosted seat checkout fixture",
    kind: "subscription",
    monthlyUsageUnits: 100,
    hostedPolicyRef: `product_${Bun.randomUUIDv7()}`,
    visibility: "public",
    priceBasis: "per_seat",
  });
  return { organizationId, userId, policyId, policyRef, seatPolicyId };
};

type FakeProvider = {
  readonly calls: () => number;
  readonly restore: () => void;
};

const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]): string => {
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.href : input;
};

/** Replaces the provider's HTTP API; every other dependency is real. */
const installFakeProvider = (
  respond: (call: number) => Response,
): FakeProvider => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = requestUrl(input);
      if (new URL(url).origin !== new URL(PROVIDER_BASE_URL).origin) {
        return panic(`Unexpected outbound request to ${url}`);
      }
      calls += 1;
      return respond(calls);
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const sessionResponse = (call: number) =>
  Response.json({
    id: `checkout_${call}`,
    url: `https://buy.provider.test/${call}`,
    expires_at: PROVIDER_SESSION_EXPIRY.toISOString(),
  });

const FIRST_SESSION = {
  hostedSessionId: "checkout_1",
  url: "https://buy.provider.test/1",
};
const SECOND_SESSION = {
  hostedSessionId: "checkout_2",
  url: "https://buy.provider.test/2",
};

const withHostedEnv = async (fn: () => Promise<void>) => {
  const previous = {
    FEATURE_USAGE: env.FEATURE_USAGE,
    HOSTED_USAGE_PROVIDER: env.HOSTED_USAGE_PROVIDER,
    HOSTED_USAGE_PROVIDER_API_VERSION: env.HOSTED_USAGE_PROVIDER_API_VERSION,
    HOSTED_USAGE_PROVIDER_API_KEY: env.HOSTED_USAGE_PROVIDER_API_KEY,
    HOSTED_USAGE_PROVIDER_BASE_URL: env.HOSTED_USAGE_PROVIDER_BASE_URL,
    HOSTED_USAGE_WEBHOOK_SECRET: env.HOSTED_USAGE_WEBHOOK_SECRET,
    HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS:
      env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS,
  };
  env.FEATURE_USAGE = true;
  env.HOSTED_USAGE_PROVIDER = "polar";
  env.HOSTED_USAGE_PROVIDER_API_VERSION = DEFAULT_POLAR_API_VERSION;
  env.HOSTED_USAGE_PROVIDER_API_KEY = "provider_fixture_key";
  env.HOSTED_USAGE_PROVIDER_BASE_URL = PROVIDER_BASE_URL;
  env.HOSTED_USAGE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = undefined;
  try {
    await fn();
  } finally {
    Object.assign(env, previous);
  }
};

type CheckoutRequest = {
  usagePolicyId: SafeId<"usagePolicy">;
  seats?: number;
};

type StartCheckoutOptions = {
  fixture: Fixture;
  safeDb: SafeDb;
  /** Defaults to the fixture's flat subscription without a seat count. */
  request?: CheckoutRequest;
};

const startCheckout = async ({
  fixture,
  safeDb,
  request = { usagePolicyId: fixture.policyId },
}: StartCheckoutOptions) =>
  await createHostedSetup.handler(
    createTestHandlerContext<Parameters<typeof createHostedSetup.handler>[0]>({
      recordAuditEvent: auditRecorderDouble(),
      body: request,
      session: { activeOrganizationId: fixture.organizationId },
      user: { id: fixture.userId },
      safeDb,
    }),
  );

const startedSession = (response: unknown) =>
  typeof response === "object" &&
  response !== null &&
  "hostedSessionId" in response &&
  "url" in response
    ? response
    : null;

const refusal = (code: string) => ({ code: 409, response: { code } });

const readClaims = async (
  tx: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
) =>
  await tx
    .select()
    .from(hostedCheckoutClaims)
    .where(eq(hostedCheckoutClaims.organizationId, organizationId));

/**
 * Runs `fn` against a seeded organization inside one owner transaction that
 * is rolled back afterwards. The handler's scoped transactions nest inside it,
 * so the case is the last thing that reads through the owner connection.
 */
const withRolledBackFixture = async (
  fn: (tx: Transaction, fixture: Fixture) => Promise<void>,
) => {
  const url = databaseUrl ?? panic("DATABASE_URL required");
  await withHostedEnv(async () => {
    await withGatedTestClients(url, async ({ openClient }) => {
      const { db } = openClient();
      await db
        .transaction(async (tx) => {
          await fn(tx, await seedFixture(tx));
          tx.rollback();
        })
        .then(
          () => panic("Hosted checkout fixture unexpectedly committed"),
          (error: unknown) => {
            if (!(error instanceof TransactionRollbackError)) {
              throw error;
            }
          },
        );
    });
  });
};

const scopedSafeDb = (tx: Transaction, fixture: Fixture) =>
  createSafeDb(markRlsDatabase(tx), [], fixture.organizationId, fixture.userId);

const insertEntitlement = async ({
  tx,
  fixture,
  status,
}: {
  tx: Transaction;
  fixture: Fixture;
  status: UsageEntitlementStatus;
}) => {
  const now = Date.now();
  await tx.insert(usageEntitlements).values({
    organizationId: fixture.organizationId,
    usagePolicyId: fixture.policyId,
    status,
    seats: 1,
    currentPeriodStart: new Date(now - HOUR_MS),
    currentPeriodEnd: new Date(now + HOUR_MS),
    hostedAccountRef: `customer_${Bun.randomUUIDv7()}`,
    hostedEntitlementExternalId: `subscription_${Bun.randomUUIDv7()}`,
    source: "hosted",
  });
};

const deliverSubscription = async ({
  tx,
  fixture,
}: {
  tx: Transaction;
  fixture: Fixture;
}) => {
  const now = Date.now();
  const eventId = `event_${Bun.randomUUIDv7()}`;
  const body = JSON.stringify({
    type: "subscription.active",
    api_version: DEFAULT_POLAR_API_VERSION,
    data: {
      id: `subscription_${Bun.randomUUIDv7()}`,
      customer_id: `customer_${Bun.randomUUIDv7()}`,
      product_id: fixture.policyRef,
      status: "active",
      seats: 1,
      created_at: new Date(now).toISOString(),
      modified_at: new Date(now).toISOString(),
      current_period_start: new Date(now - HOUR_MS).toISOString(),
      current_period_end: new Date(now + HOUR_MS).toISOString(),
      cancel_at_period_end: false,
      metadata: { organization_id: fixture.organizationId },
    },
  });
  const timestamp = String(Math.floor(now / 1000));
  const signature = new Bun.CryptoHasher("sha256", WEBHOOK_SECRET)
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
    runTransaction: async (run) =>
      await tx.transaction(async (nested) => await run(nested)),
  });
  expect(response.status).toBe(200);
};

/** Releases every waiter once `parties` callers have arrived. */
const createBarrier = (parties: number) => {
  const released = Promise.withResolvers<undefined>();
  let arrived = 0;
  return async () => {
    arrived += 1;
    if (arrived === parties) {
      released.resolve(undefined);
    }
    await released.promise;
  };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("hosted subscription checkout claims (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(true);
    });
  });
} else {
  describe("hosted subscription checkout claims (postgres)", () => {
    test("concurrent identical starts share exactly one provider session", async () => {
      await withHostedEnv(async () => {
        await assertProperty(
          "concurrent identical starts share exactly one provider session",
          fc.asyncProperty(
            fc.integer({ min: 2, max: 6 }),
            fc.constantFrom("none", "expired"),
            fc.constantFrom("created", "failed"),
            async (starters, priorClaim, providerOutcome) => {
              await withGatedTestClients(
                databaseUrl,
                async ({ openClient }) => {
                  const setup = openClient();
                  const fixture = await setup.db.transaction(
                    async (tx) => await seedFixture(tx),
                  );
                  const provider = installFakeProvider((call) =>
                    providerOutcome === "created"
                      ? sessionResponse(call)
                      : new Response("unavailable", { status: 503 }),
                  );
                  try {
                    const staleClaimId = createSafeId<"hostedCheckoutClaim">();
                    if (priorClaim === "expired") {
                      await setup.db.insert(hostedCheckoutClaims).values({
                        organizationId: fixture.organizationId,
                        claimId: staleClaimId,
                        hostedSessionId: "checkout_expired",
                        expiresAt: sql`now() - interval '1 minute'`,
                      });
                    }
                    // Every start holds an open transaction at the barrier, so
                    // all of them reach the claim against the same state.
                    const arrive = createBarrier(starters);
                    const responses = await Promise.all(
                      Array.from({ length: starters }, async () => {
                        const scoped = createSafeDb(
                          markRlsDatabase(openClient().db),
                          [],
                          fixture.organizationId,
                          fixture.userId,
                        );
                        let firstTransaction = true;
                        const gated: SafeDb = async (work, retry) =>
                          await scoped(async (tx) => {
                            if (firstTransaction) {
                              firstTransaction = false;
                              await arrive();
                            }
                            return await work(tx);
                          }, retry);
                        return await startCheckout({ fixture, safeDb: gated });
                      }),
                    );

                    const claims = await readClaims(
                      setup.db,
                      fixture.organizationId,
                    );
                    if (providerOutcome === "failed") {
                      // A start that reaches the claim after a failed one
                      // released it may try the provider again itself.
                      expect(provider.calls()).toBeGreaterThanOrEqual(1);
                      expect(provider.calls()).toBeLessThanOrEqual(starters);
                      for (const response of responses) {
                        expect(response).toMatchObject({ code: 502 });
                      }
                      expect(claims).toEqual([]);
                      return;
                    }
                    expect(provider.calls()).toBe(1);
                    expect(responses).toEqual(
                      Array.from({ length: starters }, () => FIRST_SESSION),
                    );
                    expect(claims).toHaveLength(1);
                    expect(claims.at(0)).toMatchObject({
                      hostedSessionId: FIRST_SESSION.hostedSessionId,
                      hostedCheckoutUrl: FIRST_SESSION.url,
                      usagePolicyId: fixture.policyId,
                      seats: null,
                      expiresAt: PROVIDER_SESSION_EXPIRY,
                    });
                    expect(claims.at(0)?.claimId).not.toBe(staleClaimId);
                  } finally {
                    provider.restore();
                    await setup.db
                      .delete(organization)
                      .where(eq(organization.id, fixture.organizationId));
                    await setup.db
                      .delete(user)
                      .where(eq(user.id, fixture.userId));
                    await setup.db
                      .delete(usagePolicies)
                      .where(
                        inArray(usagePolicies.id, [
                          fixture.policyId,
                          fixture.seatPolicyId,
                        ]),
                      );
                  }
                },
              );
            },
          ),
          { numRuns: 8 },
        );
      });
    }, 120_000);

    test("a repeated start reopens the open session without calling the provider", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        const provider = installFakeProvider(sessionResponse);
        try {
          const safeDb = scopedSafeDb(tx, fixture);
          expect(await startCheckout({ fixture, safeDb })).toEqual(
            FIRST_SESSION,
          );
          const opened = await readClaims(tx, fixture.organizationId);
          expect(opened).toHaveLength(1);
          expect(await startCheckout({ fixture, safeDb })).toEqual(
            FIRST_SESSION,
          );
          expect(provider.calls()).toBe(1);
          expect(await readClaims(tx, fixture.organizationId)).toEqual(opened);
        } finally {
          provider.restore();
        }
      });
    });

    const SUPERSEDING_REQUESTS = {
      "another policy": (fixture: Fixture) => ({
        first: { usagePolicyId: fixture.policyId },
        second: { usagePolicyId: fixture.seatPolicyId, seats: 1 },
      }),
      "another seat count": (fixture: Fixture) => ({
        first: { usagePolicyId: fixture.seatPolicyId, seats: 2 },
        second: { usagePolicyId: fixture.seatPolicyId, seats: 3 },
      }),
      "a seat count where none was given": (fixture: Fixture) => ({
        first: { usagePolicyId: fixture.seatPolicyId },
        second: { usagePolicyId: fixture.seatPolicyId, seats: 1 },
      }),
    } satisfies Record<
      string,
      (fixture: Fixture) => { first: CheckoutRequest; second: CheckoutRequest }
    >;

    test.each(Object.entries(SUPERSEDING_REQUESTS))(
      "a start for %s supersedes the open session",
      async (_name, requestsFor) => {
        await withRolledBackFixture(async (tx, fixture) => {
          const requests = requestsFor(fixture);
          const provider = installFakeProvider(sessionResponse);
          try {
            const safeDb = scopedSafeDb(tx, fixture);
            expect(
              await startCheckout({ fixture, safeDb, request: requests.first }),
            ).toEqual(FIRST_SESSION);
            const [first] = await readClaims(tx, fixture.organizationId);
            expect(
              await startCheckout({
                fixture,
                safeDb,
                request: requests.second,
              }),
            ).toEqual(SECOND_SESSION);
            expect(provider.calls()).toBe(2);
            const claims = await readClaims(tx, fixture.organizationId);
            expect(claims).toHaveLength(1);
            expect(claims.at(0)).toMatchObject({
              hostedSessionId: SECOND_SESSION.hostedSessionId,
              hostedCheckoutUrl: SECOND_SESSION.url,
              usagePolicyId: requests.second.usagePolicyId,
              seats: requests.second.seats,
            });
            expect(claims.at(0)?.claimId).not.toBe(first?.claimId);
          } finally {
            provider.restore();
          }
        });
      },
    );

    // A claim without a session is a start whose provider call is in flight.
    const IN_FLIGHT_CLAIMS = {
      "for another request": {
        policy: "seat",
        createdAt: sql`now()`,
      },
      "past the wait for its provider call": {
        policy: "flat",
        createdAt: sql`now() - interval '1 minute'`,
      },
    } as const;

    test.each(Object.entries(IN_FLIGHT_CLAIMS))(
      "a claim in flight %s refuses the start without calling the provider",
      async (_name, claim) => {
        await withRolledBackFixture(async (tx, fixture) => {
          const claimId = createSafeId<"hostedCheckoutClaim">();
          await tx.insert(hostedCheckoutClaims).values({
            organizationId: fixture.organizationId,
            claimId,
            usagePolicyId:
              claim.policy === "seat" ? fixture.seatPolicyId : fixture.policyId,
            expiresAt: sql`now() + interval '1 minute'`,
            createdAt: claim.createdAt,
          });
          const provider = installFakeProvider(sessionResponse);
          try {
            const response = await startCheckout({
              fixture,
              safeDb: scopedSafeDb(tx, fixture),
            });
            expect(response).toMatchObject(
              refusal(HOSTED_CHECKOUT_REFUSAL_CODE.checkoutOpen),
            );
            expect(provider.calls()).toBe(0);
            const claims = await readClaims(tx, fixture.organizationId);
            expect(claims.map((row) => row.claimId)).toEqual([claimId]);
          } finally {
            provider.restore();
          }
        });
      },
    );

    test("an expired claim gives the same request a new session", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        const expiredClaimId = createSafeId<"hostedCheckoutClaim">();
        await tx.insert(hostedCheckoutClaims).values({
          organizationId: fixture.organizationId,
          claimId: expiredClaimId,
          hostedSessionId: "checkout_expired",
          hostedCheckoutUrl: "https://buy.provider.test/expired",
          usagePolicyId: fixture.policyId,
          expiresAt: sql`now() - interval '1 minute'`,
        });
        const provider = installFakeProvider(sessionResponse);
        try {
          expect(
            await startCheckout({ fixture, safeDb: scopedSafeDb(tx, fixture) }),
          ).toEqual(FIRST_SESSION);
          expect(provider.calls()).toBe(1);
          const claims = await readClaims(tx, fixture.organizationId);
          expect(claims).toHaveLength(1);
          expect(claims.at(0)?.claimId).not.toBe(expiredClaimId);
          expect(claims.at(0)?.hostedCheckoutUrl).toBe(FIRST_SESSION.url);
        } finally {
          provider.restore();
        }
      });
    });

    test("an organization in its evaluation period starts a checkout", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        await tx.insert(organizationAccessStates).values({
          organizationId: fixture.organizationId,
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationStartedAt: sql`now()`,
          evaluationEndsAt: sql`now() + interval '14 days'`,
        });
        const provider = installFakeProvider(sessionResponse);
        try {
          const response = await startCheckout({
            fixture,
            safeDb: scopedSafeDb(tx, fixture),
          });
          expect(startedSession(response)).not.toBeNull();
          expect(provider.calls()).toBe(1);
        } finally {
          provider.restore();
        }
      });
    });

    test("a created session reaches the caller when the claim update fails", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        const provider = installFakeProvider(sessionResponse);
        try {
          const scoped = scopedSafeDb(tx, fixture);
          // Database work after the provider call fails, so only the claim
          // update is affected.
          const failingAfterProvider: SafeDb = async (run, retry) =>
            provider.calls() === 0
              ? await scoped(run, retry)
              : await scoped(async () => {
                  throw new Error("claim update unavailable");
                });
          expect(
            await startCheckout({ fixture, safeDb: failingAfterProvider }),
          ).toEqual({
            hostedSessionId: "checkout_1",
            url: "https://buy.provider.test/1",
          });
          expect(provider.calls()).toBe(1);
        } finally {
          provider.restore();
        }
      });
    });

    test("a failed provider call releases the claim for the next start", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        const provider = installFakeProvider((call) =>
          call === 1
            ? new Response("unavailable", { status: 503 })
            : sessionResponse(call),
        );
        try {
          const safeDb = scopedSafeDb(tx, fixture);
          expect(await startCheckout({ fixture, safeDb })).toMatchObject({
            code: 502,
          });
          expect(await readClaims(tx, fixture.organizationId)).toEqual([]);

          expect(await startCheckout({ fixture, safeDb })).toEqual({
            hostedSessionId: "checkout_2",
            url: "https://buy.provider.test/2",
          });
          expect(provider.calls()).toBe(2);
        } finally {
          provider.restore();
        }
      });
    });

    test("a session without a reported expiry keeps the claim's own expiry", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        const provider = installFakeProvider((call) =>
          Response.json({
            id: `checkout_${call}`,
            url: `https://buy.provider.test/${call}`,
          }),
        );
        try {
          await startCheckout({ fixture, safeDb: scopedSafeDb(tx, fixture) });
        } finally {
          provider.restore();
        }
        const rows = await tx.execute<{ remaining_seconds: number }>(
          sql`SELECT extract(epoch FROM expires_at - now())::int AS remaining_seconds FROM hosted_checkout_claims WHERE organization_id = ${fixture.organizationId}`,
        );
        expect(rows.at(0)?.remaining_seconds).toBe(HOUR_MS / 1000);
      });
    });

    // Independent oracle: trials and ended subscriptions upgrade through
    // checkout; paid subscriptions change through hosted management.
    const CHECKOUT_EXPECTATION_BY_STATUS = {
      trialing: "starts",
      active: "refused",
      past_due: "refused",
      cancelled: "starts",
      paused: "refused",
    } as const satisfies Record<UsageEntitlementStatus, "starts" | "refused">;

    test.each(USAGE_ENTITLEMENT_STATUSES)(
      "an existing %s subscription decides whether a new one may start",
      async (status) => {
        await withRolledBackFixture(async (tx, fixture) => {
          await insertEntitlement({ tx, fixture, status });
          const provider = installFakeProvider(sessionResponse);
          try {
            const response = await startCheckout({
              fixture,
              safeDb: scopedSafeDb(tx, fixture),
            });
            if (CHECKOUT_EXPECTATION_BY_STATUS[status] === "starts") {
              expect(startedSession(response)).not.toBeNull();
              expect(provider.calls()).toBe(1);
              return;
            }
            expect(response).toMatchObject(
              refusal(HOSTED_CHECKOUT_REFUSAL_CODE.subscriptionLive),
            );
            expect(provider.calls()).toBe(0);
            expect(await readClaims(tx, fixture.organizationId)).toEqual([]);
          } finally {
            provider.restore();
          }
        });
      },
    );

    test("the subscription event completes the open checkout", async () => {
      await withRolledBackFixture(async (tx, fixture) => {
        await tx.insert(hostedCheckoutClaims).values({
          organizationId: fixture.organizationId,
          claimId: createSafeId<"hostedCheckoutClaim">(),
          hostedSessionId: "checkout_open",
          expiresAt: sql`now() + interval '1 minute'`,
        });
        await deliverSubscription({ tx, fixture });
        expect(await readClaims(tx, fixture.organizationId)).toEqual([]);

        const provider = installFakeProvider(sessionResponse);
        try {
          expect(
            await startCheckout({ fixture, safeDb: scopedSafeDb(tx, fixture) }),
          ).toMatchObject(
            refusal(HOSTED_CHECKOUT_REFUSAL_CODE.subscriptionLive),
          );
          expect(provider.calls()).toBe(0);
        } finally {
          provider.restore();
        }
      });
    });
  });
}
