import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { checkStandardAccountOperation } from "@/api/lib/auth/review-account";
import {
  checkReviewAccountAccess,
  narrowReviewOrganizationScopes,
  REVIEW_ACCOUNT_EXCLUDED_SCOPES,
  REVIEW_ACCOUNT_OPERATION,
  REVIEW_ACCOUNT_POLICY,
  resolveReviewAccountBodyEmailOperation,
  resolveReviewAccountSessionOperation,
} from "@/api/lib/auth/review-account-policy";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";

const reviewEmail = "review@example.test";
const organizationId = "org_review";
const config = { email: reviewEmail, organizationId };
const operations = Object.values(REVIEW_ACCOUNT_OPERATION);

const allowedOperations = (options: {
  email: string;
  config: { email: string | undefined; organizationId: string | undefined };
  organizationId: string;
}) =>
  operations.filter((operation) =>
    Result.isOk(checkReviewAccountAccess({ ...options, operation })),
  );

describe("restricted review account policy", () => {
  test("every operation has a disposition", () => {
    expect(Object.keys(REVIEW_ACCOUNT_POLICY).toSorted()).toEqual(
      operations.toSorted(),
    );
  });

  test("allows only sign-in, MCP and its own organization's session", () => {
    expect(
      allowedOperations({ email: reviewEmail, config, organizationId }),
    ).toEqual([
      REVIEW_ACCOUNT_OPERATION.passwordSignIn,
      REVIEW_ACCOUNT_OPERATION.session,
      REVIEW_ACCOUNT_OPERATION.mcp,
    ]);
    expect(
      allowedOperations({
        email: " Review@Example.Test ",
        config,
        organizationId: "org_other",
      }),
    ).toEqual([
      REVIEW_ACCOUNT_OPERATION.passwordSignIn,
      REVIEW_ACCOUNT_OPERATION.mcp,
    ]);
  });

  test("refuses with one neutral answer", () => {
    for (const operation of operations) {
      const access = checkReviewAccountAccess({
        email: reviewEmail,
        config,
        operation,
        organizationId: "org_other",
      });
      if (Result.isError(access)) {
        expect(access.error).toMatchObject({
          status: 403,
          code: "account_access_unavailable",
          message: "This operation is unavailable for this account.",
        });
      }
    }
  });

  test("refuses everything when the account has no organization", () => {
    expect(
      allowedOperations({
        email: reviewEmail,
        config: { email: reviewEmail, organizationId: undefined },
        organizationId,
      }),
    ).toEqual([]);
  });

  test("leaves every other account and an unconfigured deployment alone", () => {
    for (const [email, accountConfig] of [
      ["member@example.test", config],
      [reviewEmail, { email: undefined, organizationId: undefined }],
    ] as const) {
      expect(
        allowedOperations({
          email,
          config: accountConfig,
          organizationId: "org_other",
        }),
      ).toEqual(operations);
    }
  });
});

describe("restricted review account auth endpoints", () => {
  test.each([
    [
      "/organization/create",
      "POST",
      REVIEW_ACCOUNT_OPERATION.createOrganization,
    ],
    [
      "/organization/invite-member",
      "POST",
      REVIEW_ACCOUNT_OPERATION.sendInvitation,
    ],
    [
      "/organization/accept-invitation",
      "POST",
      REVIEW_ACCOUNT_OPERATION.acceptInvitation,
    ],
    [
      "/organization/update",
      "POST",
      REVIEW_ACCOUNT_OPERATION.manageOrganization,
    ],
    [
      "/organization/delete",
      "POST",
      REVIEW_ACCOUNT_OPERATION.manageOrganization,
    ],
    ["/change-email", "POST", REVIEW_ACCOUNT_OPERATION.changeEmail],
    ["/email-otp/change-email", "POST", REVIEW_ACCOUNT_OPERATION.changeEmail],
    ["/change-password", "POST", REVIEW_ACCOUNT_OPERATION.changePassword],
    ["/two-factor/enable", "POST", REVIEW_ACCOUNT_OPERATION.enrollTwoFactor],
    ["/api-key/create", "POST", REVIEW_ACCOUNT_OPERATION.createApiKey],
    ["/link-social", "POST", REVIEW_ACCOUNT_OPERATION.linkIdentity],
    ["/delete-user", "POST", REVIEW_ACCOUNT_OPERATION.deleteAccount],
    ["/organization/set-active", "POST", null],
    ["/organization/list", "GET", null],
    ["/oauth2/consent", "POST", null],
    ["/update-user", "POST", null],
    ["/sign-out", "POST", null],
  ] as const)("%s %s performs %p", (path, method, operation) => {
    expect(resolveReviewAccountSessionOperation({ path, method })).toBe(
      operation,
    );
  });

  test.each([
    [
      "/request-password-reset",
      undefined,
      REVIEW_ACCOUNT_OPERATION.changePassword,
    ],
    [
      "/email-otp/reset-password",
      undefined,
      REVIEW_ACCOUNT_OPERATION.changePassword,
    ],
    ["/sign-up/email", undefined, REVIEW_ACCOUNT_OPERATION.changePassword],
    [
      "/email-otp/send-verification-otp",
      "forget-password",
      REVIEW_ACCOUNT_OPERATION.changePassword,
    ],
    ["/email-otp/send-verification-otp", "sign-in", null],
    ["/sign-in/email", undefined, null],
  ] as const)("%s (%p) performs %p", (path, otpType, operation) => {
    expect(resolveReviewAccountBodyEmailOperation({ path, otpType })).toBe(
      operation,
    );
  });
});

describe("restricted review account scopes", () => {
  test("drops the excluded scopes only for the review organization", () => {
    const scopes = [...MCP_OAUTH_SCOPES];
    const narrowed = narrowReviewOrganizationScopes(
      { organizationId, scopes },
      config,
    );
    expect(narrowed.scopes).toEqual(
      scopes.filter(
        (scope) =>
          !(REVIEW_ACCOUNT_EXCLUDED_SCOPES as readonly string[]).includes(
            scope,
          ),
      ),
    );
    expect(
      narrowReviewOrganizationScopes(
        { organizationId: "org_other", scopes },
        config,
      ).scopes,
    ).toEqual(scopes);
    expect(
      narrowReviewOrganizationScopes(
        { organizationId, scopes },
        { organizationId: undefined },
      ).scopes,
    ).toEqual(scopes);
  });
});

describe("standard account operations", () => {
  test("refuse the demo and the review account and allow everyone else", () => {
    const previous = {
      demoEmail: env.DEMO_ACCOUNT_EMAIL,
      reviewEmail: env.APP_REVIEW_ACCOUNT_EMAIL,
      reviewOrganization: env.APP_REVIEW_ORGANIZATION_ID,
    };
    env.DEMO_ACCOUNT_EMAIL = "limited@example.test";
    env.APP_REVIEW_ACCOUNT_EMAIL = reviewEmail;
    env.APP_REVIEW_ORGANIZATION_ID = organizationId;
    try {
      expect(
        Object.fromEntries(
          ["limited@example.test", reviewEmail, "member@example.test"].map(
            (email) => [
              email,
              Result.isOk(checkStandardAccountOperation(email)),
            ],
          ),
        ),
      ).toEqual({
        "limited@example.test": false,
        [reviewEmail]: false,
        "member@example.test": true,
      });
    } finally {
      env.DEMO_ACCOUNT_EMAIL = previous.demoEmail;
      env.APP_REVIEW_ACCOUNT_EMAIL = previous.reviewEmail;
      env.APP_REVIEW_ORGANIZATION_ID = previous.reviewOrganization;
    }
  });
});
