import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";

import archiveSellerProfile from "./archive";

type ArchiveContext = Parameters<typeof archiveSellerProfile.handler>[0];

describe("seller profile archiving", () => {
  test("archives the profile, clears its default state, and audits the archive", async () => {
    const organizationId = toSafeId<"organization">("org_test");
    const profileId = toSafeId<"sellerProfile">("seller_profile_test");
    let update: Record<string, unknown> | undefined;
    let auditEvent: Parameters<AuditRecorder>[1] | undefined;
    const tx = asTestRaw<Transaction>({
      execute: async () => {},
      update: () => ({
        set: (values: Record<string, unknown>) => {
          update = values;
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
    const recordAuditEvent: AuditRecorder = async (auditTx, event) => {
      expect(auditTx).toBe(tx);
      auditEvent = event;
    };
    const context = withTimeBillingEnrolment(
      asTestRaw<ArchiveContext>({
        params: { sellerProfileId: profileId },
        request: new Request(
          `https://example.test/v1/seller-profiles/${profileId}/archive`,
          { method: "POST" },
        ),
        route: "/v1/seller-profiles/:sellerProfileId/archive",
        safeDb,
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("owner"),
        user: { id: toSafeId<"user">("user_test") },
        recordAuditEvent,
      }),
    );

    const result = await archiveSellerProfile.handler(context);

    expect(result).toEqual({ id: profileId, archived: true });
    expect(update).toMatchObject({ isDefault: false });
    expect(update?.["archivedAt"]).toBeInstanceOf(Date);
    expect(auditEvent).toMatchObject({
      action: "delete",
      resourceType: "seller_profile",
      resourceId: profileId,
      workspaceId: null,
      metadata: { change: "archived" },
    });
  });
});
