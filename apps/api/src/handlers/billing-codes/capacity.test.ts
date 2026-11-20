import { Result } from "better-result";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";

import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { aggregateExecutionRows } from "@/api/tests/fixtures/aggregate-lock-order";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

import createBillingCode from "./create";

type CreateContext = Parameters<typeof createBillingCode.handler>[0];

test("concurrent creates serialize the cap decision with the insert", async () => {
  const organizationId = toSafeId<"organization">(
    "019e7000-0000-7000-8000-000000000081",
  );
  const workspaceId = toSafeId<"workspace">(
    "019e7000-0000-7000-8000-000000000082",
  );
  const userId = toSafeId<"user">("019e7000-0000-7000-8000-000000000083");
  let persistedCount = 499;
  let auditCount = 0;
  let lockTail = Promise.resolve();

  const safeDb = asTestRaw<CreateContext["safeDb"]>(
    async (operation: (tx: unknown) => Promise<unknown>) => {
      const lockRelease = Promise.withResolvers<undefined>();
      const tx = {
        execute: async (statement: SQL) => {
          const predecessor = lockTail;
          lockTail = lockRelease.promise;
          await predecessor;
          return aggregateExecutionRows(statement);
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
                  id: toSafeId<"billingCode">(
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
  const audit = async () => {
    auditCount += 1;
  };
  const context = (code: string) =>
    asTestRaw<CreateContext>({
      request: new Request(`https://example.test/billing-codes/${workspaceId}`),
      route: "/billing-codes/:workspaceId/",
      workspaceId,
      user: { id: userId, email: "member@example.test" },
      session: { activeOrganizationId: organizationId },
      memberRole: sessionMemberRole("member"),
      safeDb,
      scopedDb: async () => {
        throw new Error("unexpected scopedDb");
      },
      getActiveWorkspaceIds: async () => [workspaceId],
      getAccessibleWorkspaces: async () => [
        { id: workspaceId, status: "active" },
      ],
      getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
      pinServerValidatedWorkspaceId: () => true,
      orgAIConfig: null,
      orgAIConfigStatus: "ok",
      managedAIResidency: "eu",
      promptCachingEnabled: false,
      recordAuditEvent: audit,
      createAuditRecorder: () => audit,
      featureAccessSnapshot: enrolledTimeBillingSnapshot({
        userId,
        organizationId,
      }),
      body: { type: "task", code, label: code },
    });

  const responses = await Promise.all([
    createBillingCode.handler(context("RACE-A")),
    createBillingCode.handler(context("RACE-B")),
  ]);

  expect(responses.filter((response) => "id" in response)).toHaveLength(1);
  expect(responses).toContainEqual({
    code: 400,
    response: { message: "Billing codes limit reached for this workspace" },
  });
  expect(persistedCount).toBe(500);
  expect(auditCount).toBe(1);
});
