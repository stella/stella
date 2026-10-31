import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { checkRestrictedAccountOperation } from "@/api/lib/auth/review-account";
import { REVIEW_ACCOUNT_OPERATION } from "@/api/lib/auth/review-account-policy";
import { decidePinnedSessionLifetime } from "@/api/lib/auth/session-lifetime";
import { SYNTHETIC_PRINCIPAL } from "@/api/lib/synthetic-principal/constants";
import {
  checkSyntheticPrincipalAccess,
  SYNTHETIC_PRINCIPAL_POLICY,
} from "@/api/lib/synthetic-principal/policy";

describe("synthetic principal access", () => {
  test("keeps monitoring sessions fixed for 30 minutes", () => {
    const createdAt = new Date("2026-10-19T12:00:00.000Z");

    expect(
      decidePinnedSessionLifetime({
        id: "synthetic-session-example",
        createdAt,
      }),
    ).toEqual({
      refreshMode: "fixed",
      expiresAt: new Date("2026-10-19T12:30:00.000Z"),
    });
  });

  test("refuses every operation classified as unavailable", () => {
    for (const operation of Object.values(REVIEW_ACCOUNT_OPERATION)) {
      if (SYNTHETIC_PRINCIPAL_POLICY[operation] !== "refused") {
        continue;
      }
      const result = checkSyntheticPrincipalAccess({
        email: SYNTHETIC_PRINCIPAL.user.email,
        operation,
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toMatchObject({
          status: 403,
          code: "account_access_unavailable",
        });
      }
    }
  });

  test("allows the synthetic principal only in its own organization", () => {
    expect(
      Result.isOk(
        checkSyntheticPrincipalAccess({
          email: SYNTHETIC_PRINCIPAL.user.email,
          operation: "session",
          organizationId: SYNTHETIC_PRINCIPAL.org.id,
        }),
      ),
    ).toBe(true);

    const otherOrganization = checkSyntheticPrincipalAccess({
      email: SYNTHETIC_PRINCIPAL.user.email,
      operation: "session",
      organizationId: "org_other",
    });
    expect(Result.isError(otherOrganization)).toBe(true);
    if (Result.isError(otherOrganization)) {
      expect(otherOrganization.error.status).toBe(403);
    }

    const missingOrganization = checkSyntheticPrincipalAccess({
      email: SYNTHETIC_PRINCIPAL.user.email,
      operation: "session",
    });
    expect(Result.isError(missingOrganization)).toBe(true);
  });

  test("leaves ordinary accounts available", () => {
    expect(
      Result.isOk(
        checkSyntheticPrincipalAccess({
          email: "member@example.test",
          operation: "delete-account",
        }),
      ),
    ).toBe(true);
  });

  test("refuses account-control operations through the shared access check", () => {
    const result = checkRestrictedAccountOperation(
      SYNTHETIC_PRINCIPAL.user.email,
      ACCOUNT_ACCESS.accountControl,
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 403,
        code: "account_access_unavailable",
      });
    }
  });
});
