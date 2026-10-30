import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createOrganizationScopedTestDb } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import createSellerProfile from "./create";

type CreateContext = Parameters<typeof createSellerProfile.handler>[0];

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(releaseRlsFixture);

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
      route: "/v1/seller-profiles" satisfies ApiRoutePath,
      safeDb,
      scopedDb: createOrganizationScopedTestDb(fixture.testDb, {
        organizationId: fixture.ids.orgA,
        userId: fixture.ids.userA1,
      }),
      session: { activeOrganizationId: fixture.ids.orgA },
      memberRole: sessionMemberRole("owner"),
      user: { id: fixture.ids.userA1 },
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

  test("refuses a VAT payer without a VAT ID before opening a transaction", async () => {
    let transactionCount = 0;
    const safeDb = asTestRaw<SafeDb>(async () => {
      transactionCount += 1;
      return Result.ok(undefined);
    });

    const result = await createSellerProfile.handler(
      createContext({
        body: {
          legalName: "Example Legal s.r.o.",
          defaultCurrency: "CZK",
          vatPayer: true,
          vatId: "  ",
        },
        safeDb,
      }),
    );

    expect(result).toMatchObject({
      code: 400,
      response: { code: "vat_payer_requires_vat_id" },
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
          expect(values["taxId"]).toBe("2120123456");
          expect(values["registerEntry"]).toBe("Oddiel Sro, vložka 12345/B");
          expect(values["barRegistration"]).toBe("SAK 0000");
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
          taxId: "2120123456",
          registerEntry: "Oddiel Sro, vložka 12345/B",
          barRegistration: "SAK 0000",
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
