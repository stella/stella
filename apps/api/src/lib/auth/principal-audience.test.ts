import { describe, expect, test } from "bun:test";

import {
  PRINCIPAL_AUDIENCE,
  principalAudience,
  productUsagePrincipal,
} from "@/api/lib/auth/principal-audience";
import { SYNTHETIC_PRINCIPAL } from "@/api/lib/synthetic-principal/constants";

const REVIEW_ACCOUNT = {
  email: "restricted@example.test",
  organizationId: "org_review",
};
const NO_REVIEW_ACCOUNT = { email: undefined, organizationId: undefined };

describe("principalAudience", () => {
  test("a customer's principal is a customer", () => {
    expect(
      principalAudience(
        { organizationId: "org_1", userId: "user_1" },
        REVIEW_ACCOUNT,
      ),
    ).toBe(PRINCIPAL_AUDIENCE.customer);
  });

  test("the synthetic principal is synthetic by its user or its organization", () => {
    expect(
      principalAudience(
        { organizationId: "org_1", userId: SYNTHETIC_PRINCIPAL.user.id },
        REVIEW_ACCOUNT,
      ),
    ).toBe(PRINCIPAL_AUDIENCE.synthetic);
    expect(
      principalAudience(
        { organizationId: SYNTHETIC_PRINCIPAL.org.id, userId: "user_1" },
        NO_REVIEW_ACCOUNT,
      ),
    ).toBe(PRINCIPAL_AUDIENCE.synthetic);
  });

  test("every principal in the configured review organization is review", () => {
    expect(
      principalAudience(
        { organizationId: "org_review", userId: "user_review" },
        REVIEW_ACCOUNT,
      ),
    ).toBe(PRINCIPAL_AUDIENCE.review);
  });

  test("no organization is review while the review account is unconfigured", () => {
    expect(
      principalAudience(
        { organizationId: "org_review", userId: "user_review" },
        NO_REVIEW_ACCOUNT,
      ),
    ).toBe(PRINCIPAL_AUDIENCE.customer);
  });
});

describe("productUsagePrincipal", () => {
  test("keeps a customer's ids", () => {
    const principal = productUsagePrincipal(
      { organizationId: "org_1", userId: "user_1" },
      REVIEW_ACCOUNT,
    );

    expect(
      principal && {
        ...principal,
        distinctId: principal.distinctId.toString(),
      },
    ).toEqual({ distinctId: "user_1", organizationId: "org_1" });
  });

  test("has no principal for the service's own identities", () => {
    expect(
      productUsagePrincipal(
        { organizationId: "org_review", userId: "user_review" },
        REVIEW_ACCOUNT,
      ),
    ).toBeNull();
    expect(
      productUsagePrincipal(
        {
          organizationId: SYNTHETIC_PRINCIPAL.org.id,
          userId: SYNTHETIC_PRINCIPAL.user.id,
        },
        REVIEW_ACCOUNT,
      ),
    ).toBeNull();
  });
});
