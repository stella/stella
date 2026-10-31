import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS,
  HOSTED_CUSTOMER_ERASURE_STATUS,
  hostedCustomerErasures,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { eraseHostedCustomer } from "@/api/lib/hosted-usage-provider/client";
import type { observeFailure } from "@/api/lib/observability/observe-failure";
import { completeOrganizationDeletion } from "@/api/lib/organization-storage-teardown";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { runHostedCustomerErasures } from "@/api/lib/scheduler/tasks/hosted-customer-erasure";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { hasRenewingHostedSubscription } from "@/api/lib/usage/renewing-hosted-subscription";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const credentials = {
  apiKey: "provider_test_key",
  baseUrl: "https://provider.test",
};
let db: TestDatabase;
let originalFetch: typeof fetch;

beforeAll(async () => {
  db = await getTestDb();
  originalFetch = globalThis.fetch;
});

beforeEach(async () => {
  await db.delete(hostedCustomerErasures).where(sql`true`);
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await releaseTestDb();
});

const context = (
  signal: AbortSignal = new AbortController().signal,
): SchedulerTaskContext =>
  asTestRaw<SchedulerTaskContext>({
    db,
    dueAt: DueSlot.of({ nextRunAt: NOW, lockedAt: NOW }),
    runId: toSafeId<"schedulerJobRun">(`run_${Bun.randomUUIDv7()}`),
    signal,
  });

const run = async ({
  observe = () => undefined,
  now = NOW,
}: {
  observe?: (...args: Parameters<typeof observeFailure>) => void;
  now?: Date;
} = {}) =>
  await runHostedCustomerErasures(context(), {
    credentials,
    provider: "polar",
    erase: eraseHostedCustomer,
    observe,
    now: () => now,
  });

const insertIntent = async ({
  attempts = 0,
  externalCustomerRef = `stella_org_${Bun.randomUUIDv7()}`,
  status = HOSTED_CUSTOMER_ERASURE_STATUS.pending,
}: {
  attempts?: number;
  externalCustomerRef?: string;
  status?: (typeof HOSTED_CUSTOMER_ERASURE_STATUS)[keyof typeof HOSTED_CUSTOMER_ERASURE_STATUS];
} = {}) => {
  const id = Bun.randomUUIDv7();
  await db.insert(hostedCustomerErasures).values({
    id,
    externalCustomerRef,
    status,
    attempts,
    nextAttemptAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  return { id, externalCustomerRef };
};

const installFetch = (
  handler: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): void => {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
};

const urlString = (url: string | URL | Request): string => {
  if (typeof url === "string") {
    return url;
  }
  return url instanceof URL ? url.href : url.url;
};

describe("hosted customer erasure task", () => {
  // A 204 carries no body by the Fetch standard; the 404 carries the private
  // body that must never be stored.
  test.each([
    { status: 204, body: null },
    { status: 404, body: "provider private response" },
  ])(
    "marks a $status response erased without storing its body",
    async ({ status, body }) => {
      const intent = await insertIntent({
        externalCustomerRef: "stella_org_org/a b",
      });
      let requestUrl = "";
      installFetch(async (url, init) => {
        requestUrl = urlString(url);
        expect(init?.method).toBe("DELETE");
        return new Response(body, { status });
      });

      await run();

      const row = (
        await db
          .select()
          .from(hostedCustomerErasures)
          .where(eq(hostedCustomerErasures.id, intent.id))
      ).at(0);
      expect(row?.status).toBe(HOSTED_CUSTOMER_ERASURE_STATUS.erased);
      expect(JSON.stringify(row)).not.toContain("provider private response");
      expect(requestUrl).toBe(
        "https://provider.test/v1/customers/external/stella_org_org%2Fa%20b?anonymize=true",
      );
    },
  );

  test("retries failures with growing backoff and observes only the final failure", async () => {
    const intent = await insertIntent();
    const observations: unknown[][] = [];
    installFetch(async () => new Response("sensitive", { status: 500 }));

    for (
      let attempts = 1;
      attempts <= HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS;
      attempts += 1
    ) {
      const attemptNow = new Date(NOW.getTime() + attempts * 86_400_000);
      await db
        .update(hostedCustomerErasures)
        .set({ nextAttemptAt: new Date("2020-01-01T00:00:00.000Z") })
        .where(eq(hostedCustomerErasures.id, intent.id));
      await run({
        now: attemptNow,
        observe: (...args) => {
          observations.push(args);
        },
      });
      const row = (
        await db
          .select()
          .from(hostedCustomerErasures)
          .where(eq(hostedCustomerErasures.id, intent.id))
      ).at(0);
      expect(row?.attempts).toBe(attempts);
      expect(row?.status).toBe(HOSTED_CUSTOMER_ERASURE_STATUS.failed);
      expect(row?.lastErrorCode).toBe("http_500");
      expect(row?.nextAttemptAt.getTime()).toBe(
        attemptNow.getTime() + 60_000 * 2 ** (attempts - 1),
      );
    }
    expect(observations).toHaveLength(1);
    expect(observations[0]?.[1]).toMatchObject({ ctx: { jobId: intent.id } });
  });

  test("one batch keeps each failure's own code and backoff", async () => {
    const first = await insertIntent({ attempts: 0 });
    const sibling = await insertIntent({ attempts: 0 });
    const third = await insertIntent({
      attempts: 2,
      status: HOSTED_CUSTOMER_ERASURE_STATUS.failed,
    });
    const last = await insertIntent({
      attempts: HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS - 1,
      status: HOSTED_CUSTOMER_ERASURE_STATUS.failed,
    });
    const erased = await insertIntent({ attempts: 1 });
    const statuses = new Map([
      [first.externalCustomerRef, 500],
      [sibling.externalCustomerRef, 502],
      [third.externalCustomerRef, 503],
      [last.externalCustomerRef, 429],
      [erased.externalCustomerRef, 204],
    ]);
    installFetch(async (url) => {
      const ref = decodeURIComponent(
        urlString(url).split("/external/")[1]?.split("?")[0] ?? "",
      );
      return new Response(null, { status: statuses.get(ref) ?? 204 });
    });
    const observations: unknown[][] = [];

    await run({
      observe: (...args) => {
        observations.push(args);
      },
    });

    const read = async (id: string) =>
      (
        await db
          .select()
          .from(hostedCustomerErasures)
          .where(eq(hostedCustomerErasures.id, id))
      ).at(0);
    const expectFailed = async (
      id: string,
      attempts: number,
      code: string,
    ): Promise<void> => {
      const row = await read(id);
      expect(row?.status).toBe(HOSTED_CUSTOMER_ERASURE_STATUS.failed);
      expect(row?.attempts).toBe(attempts);
      expect(row?.lastErrorCode).toBe(code);
      expect(row?.nextAttemptAt.getTime()).toBe(
        NOW.getTime() + 60_000 * 2 ** (attempts - 1),
      );
    };
    await expectFailed(first.id, 1, "http_500");
    await expectFailed(sibling.id, 1, "http_502");
    await expectFailed(third.id, 3, "http_503");
    await expectFailed(
      last.id,
      HOSTED_CUSTOMER_ERASURE_MAX_ATTEMPTS,
      "http_429",
    );
    expect((await read(erased.id))?.status).toBe(
      HOSTED_CUSTOMER_ERASURE_STATUS.erased,
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]?.[1]).toMatchObject({ ctx: { jobId: last.id } });
  });

  test("an interrupted run leases the row without spending an attempt", async () => {
    const intent = await insertIntent({ attempts: 2 });
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    });
    const aborted = new AbortController();
    aborted.abort();

    await runHostedCustomerErasures(context(aborted.signal), {
      credentials,
      provider: "polar",
      erase: eraseHostedCustomer,
      observe: () => undefined,
      now: () => NOW,
    });

    const row = (
      await db
        .select()
        .from(hostedCustomerErasures)
        .where(eq(hostedCustomerErasures.id, intent.id))
    ).at(0);
    expect(calls).toBe(0);
    expect(row?.status).toBe(HOSTED_CUSTOMER_ERASURE_STATUS.pending);
    expect(row?.attempts).toBe(2);
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("an overlapping run cannot claim a leased row", async () => {
    await insertIntent();
    let calls = 0;
    const held = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    installFetch(async () => {
      calls += 1;
      started.resolve(undefined);
      await held.promise;
      return new Response(null, { status: 204 });
    });

    const first = run();
    await started.promise;
    await run();
    expect(calls).toBe(1);
    held.resolve(undefined);
    await first;
  });

  test("does nothing for the neutral provider", async () => {
    await insertIntent();
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    });
    await runHostedCustomerErasures(context(), {
      credentials,
      provider: "neutral",
      erase: eraseHostedCustomer,
      observe: () => undefined,
      now: () => NOW,
    });
    expect(calls).toBe(0);
  });
});

const seedOrganization = async (hosted: boolean) => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  await db.insert(organization).values({
    id: organizationId,
    name: "Erasure test",
    slug: organizationId,
    createdAt: NOW,
  });
  if (hosted) {
    const usagePolicyId = createSafeId<"usagePolicy">();
    await db.insert(usagePolicies).values({
      id: usagePolicyId,
      policyKey: `erasure_${Bun.randomUUIDv7()}`,
      displayName: "Erasure policy",
      monthlyUsageUnits: 1,
    });
    await db.insert(usageEntitlements).values({
      id: createSafeId<"usageEntitlement">(),
      organizationId,
      usagePolicyId,
      status: "cancelled",
      seats: 1,
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-11-25T12:00:00.000Z"),
      cancelAtPeriodEnd: true,
      source: "hosted",
    });
  }
  return organizationId;
};

describe("organization deletion erasure intent", () => {
  test("records one idempotent intent for every deleted organization", async () => {
    const hostedId = await seedOrganization(true);
    const replayId = await seedOrganization(true);
    const neutralId = await seedOrganization(false);
    await db.insert(hostedCustomerErasures).values({
      externalCustomerRef: `stella_org_${replayId}`,
    });

    await db.transaction(async (tx) => {
      await completeOrganizationDeletion({
        organizationId: hostedId,
        tx: asTestRaw<Transaction>(tx),
      });
      await completeOrganizationDeletion({
        organizationId: neutralId,
        tx: asTestRaw<Transaction>(tx),
      });
      await completeOrganizationDeletion({
        organizationId: replayId,
        tx: asTestRaw<Transaction>(tx),
      });
    });

    const rows = await db.select().from(hostedCustomerErasures);
    expect(
      rows.map(({ externalCustomerRef }) => externalCustomerRef).toSorted(),
    ).toEqual(
      [
        `stella_org_${hostedId}`,
        `stella_org_${neutralId}`,
        `stella_org_${replayId}`,
      ].toSorted(),
    );
  });

  test("a refused renewing deletion and a rolled-back deletion leave no intent", async () => {
    const renewingId = await seedOrganization(true);
    await db
      .update(usageEntitlements)
      .set({ status: "active", cancelAtPeriodEnd: false })
      .where(eq(usageEntitlements.organizationId, renewingId));
    expect(
      await hasRenewingHostedSubscription(
        asTestRaw<Transaction>(db),
        renewingId,
      ),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(hostedCustomerErasures)
        .where(
          eq(
            hostedCustomerErasures.externalCustomerRef,
            `stella_org_${renewingId}`,
          ),
        ),
    ).toEqual([]);

    const rollbackId = await seedOrganization(true);
    const rollbackError = await db
      .transaction(async (tx) => {
        await completeOrganizationDeletion({
          organizationId: rollbackId,
          tx: asTestRaw<Transaction>(tx),
        });
        tx.rollback();
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rollbackError).toBeInstanceOf(TransactionRollbackError);
    expect(
      await db
        .select()
        .from(hostedCustomerErasures)
        .where(
          eq(
            hostedCustomerErasures.externalCustomerRef,
            `stella_org_${rollbackId}`,
          ),
        ),
    ).toEqual([]);
    await db.execute(
      sql`DELETE FROM organization WHERE id IN (${renewingId}, ${rollbackId})`,
    );
  });
});
