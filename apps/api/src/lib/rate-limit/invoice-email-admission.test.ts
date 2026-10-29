import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  createInvoiceEmailAdmission,
  INVOICE_EMAIL_BUDGET,
} from "@/api/lib/rate-limit/invoice-email-admission";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";

const now = new Date("2026-10-29T12:00:00Z");
const mature = new Date(
  now.getTime() - INVOICE_EMAIL_BUDGET.youngOrganizationAgeMs,
);
const options = () => ({
  organizationId: createSafeId<"organization">(),
  userId: createSafeId<"user">(),
  organizationCreatedAt: mature,
  recipientCount: 10,
  now,
});

test.each([
  ["young organization", INVOICE_EMAIL_BUDGET.youngOrganizationEmails, now],
  ["sender", INVOICE_EMAIL_BUDGET.userEmails, mature],
] as const)(
  "repeated requests refused by the %s cap cannot consume platform capacity",
  async (_name, limit, organizationCreatedAt) => {
    const context = new InMemoryRateLimitContext(() => now.getTime());
    const admit = createInvoiceEmailAdmission(context);
    const request = { ...options(), organizationCreatedAt };
    try {
      for (let filled = 0; filled < limit; filled += 10) {
        expect((await admit(request)).isOk()).toBe(true);
      }
      expect(context.read("invoice-email:platform")?.count).toBe(limit);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await admit({ ...request, recipientCount: 1 })).isErr()).toBe(
          true,
        );
        expect(context.read("invoice-email:platform")?.count).toBe(limit);
      }
      const unrelated = { ...options(), recipientCount: 1 };
      expect((await admit(unrelated)).isOk()).toBe(true);
      expect(context.read("invoice-email:platform")?.count).toBe(limit + 1);
    } finally {
      context.kill();
    }
  },
);

test("the sender's daily cap counts recipients across organizations, not send calls", async () => {
  const context = new InMemoryRateLimitContext(() => now.getTime());
  const admit = createInvoiceEmailAdmission(context);
  const request = options();
  try {
    for (
      let attempt = 0;
      attempt < INVOICE_EMAIL_BUDGET.userEmails / 10;
      attempt++
    ) {
      expect(
        (
          await admit({
            ...request,
            organizationId: createSafeId<"organization">(),
          })
        ).isOk(),
      ).toBe(true);
    }
    const refused = await admit({ ...request, recipientCount: 1 });
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) {
      expect(refused.error.status).toBe(429);
    }
    expect(
      (
        await admit({
          ...request,
          userId: createSafeId<"user">(),
          recipientCount: 1,
        })
      ).isOk(),
    ).toBe(true);
  } finally {
    context.kill();
  }
});

test("the platform cap is shared across senders and organizations, and concurrent attempts cannot exceed it", async () => {
  const context = new InMemoryRateLimitContext(() => now.getTime());
  const admit = createInvoiceEmailAdmission(context);
  try {
    for (
      let count = 0;
      count < INVOICE_EMAIL_BUDGET.platformEmails - 1;
      count++
    ) {
      context.increment(
        "invoice-email:platform",
        INVOICE_EMAIL_BUDGET.durationMs,
      );
    }
    const results = await Promise.all([
      admit({ ...options(), recipientCount: 1 }),
      admit({ ...options(), recipientCount: 1 }),
    ]);
    expect(results.filter((result) => result.isOk())).toHaveLength(1);
    expect(results.filter((result) => result.isErr())).toHaveLength(1);
  } finally {
    context.kill();
  }
});

test("organizations younger than fourteen days have a ten-email cap shared across members", async () => {
  const context = new InMemoryRateLimitContext(() => now.getTime());
  const admit = createInvoiceEmailAdmission(context);
  const request = { ...options(), organizationCreatedAt: now };
  try {
    expect((await admit(request)).isOk()).toBe(true);
    expect(
      (
        await admit({
          ...request,
          userId: createSafeId<"user">(),
          recipientCount: 1,
        })
      ).isErr(),
    ).toBe(true);
    // The age boundary is exact: a fourteen-day-old organization no longer draws this cap.
    expect(
      (
        await admit({
          ...request,
          organizationCreatedAt: mature,
          recipientCount: 1,
        })
      ).isOk(),
    ).toBe(true);
  } finally {
    context.kill();
  }
});

test("a reservation beyond the remaining recipient capacity is refused as a whole, then resets after twenty-four hours", async () => {
  let clock = now.getTime();
  const context = new InMemoryRateLimitContext(() => clock);
  const admit = createInvoiceEmailAdmission(context);
  const request = { ...options(), organizationCreatedAt: now };
  try {
    expect((await admit({ ...request, recipientCount: 9 })).isOk()).toBe(true);
    expect((await admit({ ...request, recipientCount: 2 })).isErr()).toBe(true);
    expect((await admit({ ...request, recipientCount: 1 })).isErr()).toBe(true);
    clock += INVOICE_EMAIL_BUDGET.durationMs;
    expect(
      (
        await admit({ ...request, now: new Date(clock), recipientCount: 1 })
      ).isOk(),
    ).toBe(true);
  } finally {
    context.kill();
  }
});

test("an unavailable shared counter fails closed", async () => {
  const admit = createInvoiceEmailAdmission({
    increment: () => {
      throw new Error("Counter unavailable");
    },
  });
  const result = await admit(options());
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.status).toBe(503);
  }
});
