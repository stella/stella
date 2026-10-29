import { expect, test } from "bun:test";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";

import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { httpFailureAnswer } from "@/api/lib/errors/http-failure-answer";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import {
  createInvoiceEmailAdmission,
  INVOICE_EMAIL_BUDGET,
} from "@/api/lib/rate-limit/invoice-email-admission";
import { LimiterStoreUnavailableError } from "@/api/lib/rate-limit/store-unavailable";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const now = new Date("2026-10-29T12:00:00Z");
const mature = new Date(
  now.getTime() - INVOICE_EMAIL_BUDGET.youngOrganizationAgeMs,
);
const options = () => ({
  organizationId: mintAuthProviderId<"organization">(),
  userId: mintAuthProviderId<"user">(),
  organizationCreatedAt: mature,
  recipientCount: 1,
  now,
});

/** Models request-scoped counter provenance, including an increment whose reply is lost. */
const createCounter = () => {
  let clock = now.getTime();
  let failAfterIncrement: string | undefined;
  const counters = new Map<
    string,
    { count: number; expiresAt: number; start: number }
  >();
  const attempts = new Map<string, { key: string; start: number }>();
  const counterKey = (key: string) => {
    const separator = key.lastIndexOf("\u001f");
    return separator === -1 ? key : key.slice(0, separator);
  };
  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    seed: (prefix: string, count: number) => {
      const key = [...counters.keys()].find((candidate) =>
        candidate.startsWith(prefix),
      );
      expect(key).toBeDefined();
      if (key === undefined) {
        return;
      }
      counters.set(key, {
        count,
        expiresAt: clock + INVOICE_EMAIL_BUDGET.durationMs,
        start: clock,
      });
    },
    failAfterIncrement: (prefix: string) => {
      failAfterIncrement = prefix;
    },
    outstandingAttempts: () => attempts.size,
    counts: () =>
      [...counters.entries()]
        .filter(([, value]) => value.count > 0 && value.expiresAt > clock)
        .map(([key, value]) => [key, value.count] as const)
        .toSorted(),
    context: {
      increment: async (
        requestKey: string,
        duration = INVOICE_EMAIL_BUDGET.durationMs,
      ) => {
        const key = counterKey(requestKey);
        const previous = counters.get(key);
        const current =
          previous !== undefined && previous.expiresAt > clock
            ? previous
            : { count: 0, expiresAt: clock + duration, start: clock };
        current.count += 1;
        counters.set(key, current);
        attempts.set(requestKey, { key, start: current.start });
        if (
          failAfterIncrement !== undefined &&
          key.startsWith(failAfterIncrement)
        ) {
          failAfterIncrement = undefined;
          throw new Error("Synthetic counter reply lost");
        }
        return {
          count: current.count,
          nextReset: new Date(current.expiresAt),
          start: current.start,
        };
      },
      decrement: async (requestKey: string) => {
        const attempt = attempts.get(requestKey);
        if (attempt === undefined) {
          return;
        }
        attempts.delete(requestKey);
        const current = counters.get(attempt.key);
        if (
          current !== undefined &&
          current.start === attempt.start &&
          current.expiresAt > clock &&
          current.count > 0
        ) {
          current.count -= 1;
        }
      },
      complete: async (requestKey: string) => {
        attempts.delete(requestKey);
      },
    },
  };
};

test("accepted delivery consumes one slot per recipient in every applicable daily budget", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  const request = {
    ...options(),
    organizationCreatedAt: now,
    recipientCount: 3,
  };
  const reservation = (await admit(request)).unwrap();
  expect(counter.counts()).toHaveLength(4);
  expect(counter.counts().map(([, count]) => count)).toEqual([3, 3, 3, 3]);
  await reservation.commit();
  expect(counter.outstandingAttempts()).toBe(0);
  expect(counter.counts().map(([, count]) => count)).toEqual([3, 3, 3, 3]);
  // Settlement is terminal: retries cannot charge again or refund delivered mail.
  await reservation.commit();
  await reservation.release();
  expect(counter.counts().map(([, count]) => count)).toEqual([3, 3, 3, 3]);
});

test("refusing before delivery releases every recipient reservation exactly once", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  const reservation = (
    await admit({ ...options(), organizationCreatedAt: now, recipientCount: 3 })
  ).unwrap();
  expect(counter.counts()).toHaveLength(4);
  await reservation.release();
  expect(counter.counts()).toEqual([]);
  expect(counter.outstandingAttempts()).toBe(0);
  await reservation.release();
  await reservation.commit();
  expect(counter.counts()).toEqual([]);
  expect(counter.outstandingAttempts()).toBe(0);
});

const exhaustedBudgets = [
  {
    label: "organization",
    prefix: "invoice-email:organization:",
    limit: INVOICE_EMAIL_BUDGET.organizationEmails,
    organizationCreatedAt: mature,
    observation: "api.invoice_email.organization",
    keyKind: "account",
  },
  {
    label: "young organization",
    prefix: "invoice-email:young-organization:",
    limit: INVOICE_EMAIL_BUDGET.youngOrganizationEmails,
    organizationCreatedAt: now,
    observation: "api.invoice_email.young_organization",
    keyKind: "account",
  },
  {
    label: "sender",
    prefix: "invoice-email:user:",
    limit: INVOICE_EMAIL_BUDGET.userEmails,
    organizationCreatedAt: mature,
    observation: "api.invoice_email.user",
    keyKind: "user",
  },
  {
    label: "platform",
    prefix: "invoice-email:platform",
    limit: INVOICE_EMAIL_BUDGET.platformEmails,
    organizationCreatedAt: mature,
    observation: "api.invoice_email.platform",
    keyKind: "account",
  },
] as const;

test.each(exhaustedBudgets)(
  "repeated requests refused by the $label cap leave every counter unchanged and report the exhausted scope",
  async ({ prefix, limit, organizationCreatedAt, observation, keyKind }) => {
    const counter = createCounter();
    const admit = createInvoiceEmailAdmission(counter.context);
    const request = { ...options(), organizationCreatedAt };
    await (await admit(request)).unwrap().release();
    counter.seed(prefix, limit);
    const before = counter.counts();
    const logger = installRecordingLogger();
    const metrics: string[] = [];
    setMetricLineSinkForTesting((line) => {
      metrics.push(line);
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = await admit({ ...request, recipientCount: 2 });
        expect(refused.isErr()).toBe(true);
        if (refused.isErr()) {
          expect(resolveHandlerError(refused.error)?.status).toBe(429);
          expect(refused.error.code).toBe("invoice_email_limit");
        }
        expect(counter.counts()).toEqual(before);
        expect(counter.outstandingAttempts()).toBe(0);
        expect(logger.records.at(-1)?.attributes).toEqual({
          budget: observation,
          "budget.keyKind": keyKind,
          "budget.windowMs": INVOICE_EMAIL_BUDGET.durationMs,
          "http.status_code": 429,
        });
        expect(JSON.parse(metrics.at(-1) ?? "{}")).toMatchObject({
          budgetName: observation,
          RateLimitRejected: 1,
        });
      }
      expect(metrics).toHaveLength(3);
    } finally {
      logger.restore();
      resetMetricLineSinkForTesting();
    }
  },
);

test("a partially reservable recipient batch refunds every slot so a smaller batch still fits", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  const request = { ...options(), organizationCreatedAt: now };
  await (await admit({ ...request, recipientCount: 9 })).unwrap().commit();
  const before = counter.counts();
  expect((await admit({ ...request, recipientCount: 2 })).isErr()).toBe(true);
  expect(counter.counts()).toEqual(before);
  expect(counter.outstandingAttempts()).toBe(0);
  await (await admit(request)).unwrap().commit();
  expect(counter.counts().map(([, count]) => count)).toEqual([10, 10, 10, 10]);
});

test("the sender cap spans organizations and the organization cap spans members", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  const request = options();
  await (await admit(request)).unwrap().release();
  counter.seed("invoice-email:user:", INVOICE_EMAIL_BUDGET.userEmails);
  const beforeUserRefusal = counter.counts();
  expect(
    (
      await admit({
        ...request,
        organizationId: mintAuthProviderId<"organization">(),
      })
    ).isErr(),
  ).toBe(true);
  expect(counter.counts()).toEqual(beforeUserRefusal);
  counter.seed("invoice-email:user:", 0);
  counter.seed(
    "invoice-email:organization:",
    INVOICE_EMAIL_BUDGET.organizationEmails,
  );
  const beforeOrganizationRefusal = counter.counts();
  expect(
    (await admit({ ...request, userId: mintAuthProviderId<"user">() })).isErr(),
  ).toBe(true);
  expect(counter.counts()).toEqual(beforeOrganizationRefusal);
  expect(counter.outstandingAttempts()).toBe(0);
});

test("concurrent senders cannot exceed platform capacity or leave refused reservations in narrower budgets", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  await (await admit(options())).unwrap().release();
  counter.seed(
    "invoice-email:platform",
    INVOICE_EMAIL_BUDGET.platformEmails - 1,
  );
  const results = await Promise.all([admit(options()), admit(options())]);
  const accepted = results.filter((result) => result.isOk());
  expect(accepted).toHaveLength(1);
  expect(results.filter((result) => result.isErr())).toHaveLength(1);
  await Promise.all(
    accepted.map(async (result) => await result.unwrap().commit()),
  );
  expect(counter.outstandingAttempts()).toBe(0);
  expect(
    counter
      .counts()
      .map(([, count]) => count)
      .toSorted((a, b) => a - b),
  ).toEqual([1, 1, INVOICE_EMAIL_BUDGET.platformEmails]);
});

test("the young-organization cap ends at exactly fourteen days and daily budgets reset after twenty-four hours", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  const request = { ...options(), organizationCreatedAt: now };
  await (await admit({ ...request, recipientCount: 10 })).unwrap().commit();
  expect((await admit(request)).isErr()).toBe(true);
  await (
    await admit({ ...request, organizationCreatedAt: mature })
  )
    .unwrap()
    .commit();
  counter.advance(INVOICE_EMAIL_BUDGET.durationMs);
  await (
    await admit({
      ...request,
      now: new Date(now.getTime() + INVOICE_EMAIL_BUDGET.durationMs),
    })
  )
    .unwrap()
    .commit();
  expect(counter.counts().map(([, count]) => count)).toEqual([1, 1, 1, 1]);
  expect(counter.outstandingAttempts()).toBe(0);
});

test("a lost counter reply fails closed and refunds even the increment whose acknowledgement was lost", async () => {
  const counter = createCounter();
  const admit = createInvoiceEmailAdmission(counter.context);
  const request = options();
  await (await admit(request)).unwrap().release();
  counter.failAfterIncrement("invoice-email:platform");
  const result = await admit({ ...request, recipientCount: 3 });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.cause).toBeInstanceOf(LimiterStoreUnavailableError);
    expect(httpFailureAnswer(result.error)).toEqual(LIMITER_STORE_UNAVAILABLE);
  }
  expect(counter.counts()).toEqual([]);
  expect(counter.outstandingAttempts()).toBe(0);
});
