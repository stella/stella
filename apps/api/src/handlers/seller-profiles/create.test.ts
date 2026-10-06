import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";

import createSellerProfile from "./create";

type CreateContext = Parameters<typeof createSellerProfile.handler>[0];

const organizationId = toSafeId<"organization">("org_test");

const createContext = ({
  body,
  safeDb,
  recordAuditEvent = async () => {},
}: {
  body: CreateContext["body"];
  safeDb: SafeDb;
  recordAuditEvent?: AuditRecorder;
}): CreateContext =>
  withTimeBillingEnrolment(
    asTestRaw<CreateContext>({
      body,
      request: new Request("https://example.test/v1/seller-profiles", {
        method: "POST",
      }),
      route: "/v1/seller-profiles",
      safeDb,
      session: { activeOrganizationId: organizationId },
      memberRole: sessionMemberRole("owner"),
      user: { id: toSafeId<"user">("user_test") },
      recordAuditEvent,
    }),
  );

describe("seller profile creation", () => {
  test("rejects an invalid IBAN before opening a database transaction", async () => {
    let transactionCount = 0;
    const safeDb = asTestRaw<SafeDb>(async () => {
      transactionCount += 1;
      return Result.ok(undefined);
    });

    const result = await createSellerProfile.handler(
      createContext({
        body: {
          legalName: "Example Legal GmbH",
          defaultCurrency: "EUR",
          iban: "GB82 WEST 1234 5698 7654 31",
        },
        safeDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid IBAN" },
    });
    expect(transactionCount).toBe(0);
  });

  test("makes the first profile default and audits in the same transaction without bank details", async () => {
    const profileId = toSafeId<"sellerProfile">("seller_profile_test");
    const tx = asTestRaw<Transaction>({
      execute: async () => {},
      query: {
        sellerProfiles: { findFirst: async () => undefined },
      },
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          expect(values["isDefault"]).toBe(true);
          expect(values["iban"]).toBe("GB82WEST12345698765432");
          expect(values["accountNumber"]).toBe("sensitive-account-number");
          return {
            returning: async () => [{ id: profileId, isDefault: true }],
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

    const result = await createSellerProfile.handler(
      createContext({
        body: {
          legalName: "Example Legal GmbH",
          defaultCurrency: "EUR",
          iban: "GB82 WEST 1234 5698 7654 32",
          accountNumber: "sensitive-account-number",
        },
        safeDb,
        recordAuditEvent,
      }),
    );

    expect(result).toEqual({ id: profileId, isDefault: true });
    expect(auditEvent).toMatchObject({
      action: "create",
      resourceType: "seller_profile",
      resourceId: profileId,
      workspaceId: null,
      metadata: { isDefault: true },
    });
    expect(JSON.stringify(auditEvent)).not.toContain("GB82WEST12345698765432");
    expect(JSON.stringify(auditEvent)).not.toContain(
      "sensitive-account-number",
    );
  });
});
