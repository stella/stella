import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";

import updateSellerProfile from "./update";

type UpdateContext = Parameters<typeof updateSellerProfile.handler>[0];

describe("seller profile updates", () => {
  test("returns 404 when the active organization does not own the profile", async () => {
    let auditCalled = false;
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: async () => [] }),
          }),
        }),
      }),
    });
    const safeDb = asTestRaw<SafeDb>(
      async <T>(operation: (tx: Transaction) => Promise<T>) =>
        Result.ok(await operation(tx)),
    );
    const recordAuditEvent: AuditRecorder = async () => {
      auditCalled = true;
    };
    const context = withTimeBillingEnrolment(
      asTestRaw<UpdateContext>({
        params: { sellerProfileId: toSafeId<"sellerProfile">("profile_other") },
        body: { legalName: "Updated Name" },
        request: new Request(
          "https://example.test/v1/seller-profiles/profile_other",
          {
            method: "PATCH",
          },
        ),
        route: "/v1/seller-profiles/:sellerProfileId",
        safeDb,
        session: {
          activeOrganizationId: toSafeId<"organization">("org_test"),
        },
        memberRole: sessionMemberRole("owner"),
        user: { id: toSafeId<"user">("user_test") },
        recordAuditEvent,
      }),
    );

    const result = await updateSellerProfile.handler(context);

    expect(result).toEqual({
      code: 404,
      response: { message: "Seller profile not found" },
    });
    expect(auditCalled).toBe(false);
  });

  test("records changed field names without copying sensitive bank values", async () => {
    const profileId = toSafeId<"sellerProfile">("profile_test");
    let persistedUpdate: Record<string, unknown> | undefined;
    const tx = asTestRaw<Transaction>({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: async () => [{ id: profileId }] }),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          persistedUpdate = values;
          return {
            where: () => ({ returning: async () => [{ id: profileId }] }),
          };
        },
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
      asTestRaw<UpdateContext>({
        params: { sellerProfileId: profileId },
        body: {
          iban: "GB82 WEST 1234 5698 7654 32",
          accountNumber: "sensitive-account-number",
          footerNotes: null,
        },
        request: new Request(
          `https://example.test/v1/seller-profiles/${profileId}`,
          { method: "PATCH" },
        ),
        route: "/v1/seller-profiles/:sellerProfileId",
        safeDb,
        session: {
          activeOrganizationId: toSafeId<"organization">("org_test"),
        },
        memberRole: sessionMemberRole("owner"),
        user: { id: toSafeId<"user">("user_test") },
        recordAuditEvent,
      }),
    );

    const result = await updateSellerProfile.handler(context);

    expect(result).toEqual({ id: profileId });
    expect(persistedUpdate).toMatchObject({
      iban: "GB82WEST12345698765432",
      accountNumber: "sensitive-account-number",
      footerNotes: null,
    });
    expect(auditEvent).toMatchObject({
      action: "update",
      resourceType: "seller_profile",
      resourceId: profileId,
      metadata: { changedFields: ["iban", "accountNumber", "footerNotes"] },
    });
    expect(JSON.stringify(auditEvent)).not.toContain("GB82WEST12345698765432");
    expect(JSON.stringify(auditEvent)).not.toContain(
      "sensitive-account-number",
    );
  });
});
