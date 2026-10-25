import { Result } from "better-result";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";

import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { aggregateExecutionRows } from "@/api/tests/fixtures/aggregate-lock-order";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";

import createExpense from "./create";

type CreateContext = Parameters<typeof createExpense.handler>[0];

test("concurrent creates serialize the workspace cap decision with the insert", async () => {
  const organizationId = toSafeId<"organization">(
    "019e7000-0000-7000-8000-000000000091",
  );
  const workspaceId = toSafeId<"workspace">(
    "019e7000-0000-7000-8000-000000000092",
  );
  const userId = toSafeId<"user">("019e7000-0000-7000-8000-000000000093");
  const matterId = toSafeId<"entity">("019e7000-0000-7000-8000-000000000094");
  let persistedCount = 9999;
  let auditCount = 0;
  let lockTail = Promise.resolve();

  const safeDb = asTestRaw<CreateContext["safeDb"]>(
    async (operation: (tx: unknown) => Promise<unknown>) => {
      const lockRelease = Promise.withResolvers<undefined>();
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ id: matterId }] }),
          }),
        }),
        execute: async (statement: SQL) => {
          const predecessor = lockTail;
          lockTail = lockRelease.promise;
          await predecessor;
          return aggregateExecutionRows(statement);
        },
        query: {
          entities: { findFirst: async () => ({ id: matterId }) },
        },
        $count: async () => {
          const observed = persistedCount;
          // Yield so a concurrent request can interleave between count and insert.
          await Promise.resolve();
          return observed;
        },
        insert: () => ({
          values: () => ({
            returning: async () => {
              persistedCount += 1;
              return [
                {
                  id: toSafeId<"expense">(
                    `019e7000-0000-7000-8000-${String(persistedCount).padStart(12, "0")}`,
                  ),
                },
              ];
            },
          }),
        }),
      };
      try {
        return Result.ok(await operation(tx));
      } finally {
        lockRelease.resolve(undefined);
      }
    },
  );
  const recordAuditEvent = async () => {
    auditCount += 1;
  };
  const context = (description: string) =>
    withTimeBillingEnrolment(
      asTestRaw<CreateContext>({
        request: new Request(`https://example.test/expenses/${workspaceId}`),
        route: "/expenses/:workspaceId",
        workspaceId,
        user: { id: userId, email: "intern@example.test" },
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("intern"),
        safeDb,
        recordAuditEvent,
        body: {
          matterId,
          dateIncurred: new Date().toISOString().slice(0, 10),
          timezoneId: "UTC",
          amount: 1,
          currency: "USD",
          category: "filing_fee",
          description,
        },
      }),
    );

  const responses = await Promise.all([
    createExpense.handler(context("RACE-A")),
    createExpense.handler(context("RACE-B")),
  ]);

  expect(responses.filter((response) => "id" in response)).toHaveLength(1);
  expect(responses).toContainEqual({
    code: 400,
    response: { message: "Expenses limit reached for this workspace" },
  });
  expect(persistedCount).toBe(10_000);
  expect(auditCount).toBe(1);
});
