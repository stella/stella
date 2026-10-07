import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";

import updateSellerProfileDefault from "./update";

type DefaultContext = Parameters<typeof updateSellerProfileDefault.handler>[0];

describe("changing the default seller profile", () => {
  test("switches the default and audits the prior default id", async () => {
    const profileId = toSafeId<"sellerProfile">("profile_next");
    const previousDefaultId = toSafeId<"sellerProfile">("profile_current");
    let updateCount = 0;
    const tx = asTestRaw<Transaction>({
      execute: async () => {},
      query: {
        sellerProfiles: {
          findFirst: async () => ({ id: profileId, isDefault: false }),
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              updateCount += 1;
              return updateCount === 1
                ? [{ id: previousDefaultId }]
                : [{ id: profileId }];
            },
          }),
        }),
      }),
    });
    const safeDb = asTestRaw<SafeDb>(
      async <T>(operation: (tx: Transaction) => Promise<T>) =>
        Result.ok(await operation(tx)),
    );
    let auditEvent: Parameters<AuditRecorder>[1] | undefined;
    const recordAuditEvent: AuditRecorder = async (auditTx, event) => {
      expect(auditTx).toBe(tx);
      auditEvent = event;
    };
    const context = withTimeBillingEnrolment(
      asTestRaw<DefaultContext>({
        params: { sellerProfileId: profileId },
        request: new Request(
          `https://example.test/v1/seller-profiles/${profileId}/default`,
          { method: "POST" },
        ),
        route: "/v1/seller-profiles/:sellerProfileId/default",
        safeDb,
        session: {
          activeOrganizationId: toSafeId<"organization">("org_test"),
        },
        memberRole: sessionMemberRole("owner"),
        user: { id: toSafeId<"user">("user_test") },
        recordAuditEvent,
      }),
    );

    const result = await updateSellerProfileDefault.handler(context);

    expect(result).toEqual({ id: profileId, isDefault: true });
    expect(updateCount).toBe(2);
    expect(auditEvent).toMatchObject({
      action: "update",
      resourceType: "seller_profile",
      resourceId: profileId,
      metadata: {
        change: "set_default",
        previousDefaultId,
      },
    });
  });
});
