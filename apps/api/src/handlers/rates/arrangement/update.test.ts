import { expect, test } from "bun:test";

import { billingArrangements } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import updateBillingArrangement from "./update";

test("a stale billing arrangement revision returns VERSION_CONFLICT before any write", async () => {
  const workspaceId = createSafeId<"workspace">();
  const storedRevision = 2;
  const expectedRevision = 1;
  expect(expectedRevision).not.toBe(storedRevision);
  let writes = 0;
  const { safeDb, scopedDb } = createScopedDbMock({
    select: (selection: unknown) => ({
      from: (table: unknown) => {
        if (table === billingArrangements) {
          return createSelectQueryMock(
            selection === undefined ? [{ revision: storedRevision }] : [],
          ).from();
        }
        return Promise.resolve([
          {
            billedAmount: "0",
            approvedAmount: "0",
            billedMismatchCount: "0",
            approvedMismatchCount: "0",
          },
        ]);
      },
    }),
    query: { workspaces: { findFirst: async () => ({ id: workspaceId }) } },
    insert: () => {
      writes += 1;
      return {
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: async () => [
              {
                mode: "hourly",
                currency: "USD",
                flatFeeAmount: null,
                capAmount: null,
                alertThresholdBps: null,
                revision: storedRevision + 1,
              },
            ],
          }),
        }),
      };
    },
  });
  const result = await updateBillingArrangement.handler(
    withTimeBillingEnrolment(
      createTestHandlerContext<
        Parameters<typeof updateBillingArrangement.handler>[0]
      >({
        safeDb,
        scopedDb,
        workspaceId,
        audit: auditRecorderDouble(),
        body: { mode: "hourly", currency: "USD", revision: expectedRevision },
      }),
    ),
  );
  expect(result).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
  expect(writes).toBe(0);
});
