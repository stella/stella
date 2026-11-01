import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  requireReviewOrganizationConfig,
  ReviewOrganizationConfigurationMissing,
} from "./config";

const configured = {
  APP_REVIEW_ACCOUNT_EMAIL: "review@example.com",
  APP_REVIEW_ORGANIZATION_ID: "review-organization",
};

describe("review organization migration configuration", () => {
  test("requires the complete configured identity", () => {
    for (const source of [
      {},
      { APP_REVIEW_ACCOUNT_EMAIL: configured.APP_REVIEW_ACCOUNT_EMAIL },
      { APP_REVIEW_ORGANIZATION_ID: configured.APP_REVIEW_ORGANIZATION_ID },
      { ...configured, APP_REVIEW_ACCOUNT_EMAIL: "invalid" },
    ]) {
      const result = requireReviewOrganizationConfig(source);
      if (Result.isOk(result)) {
        expect.unreachable("Missing identity must refuse");
      }
      expect(result.error).toBeInstanceOf(
        ReviewOrganizationConfigurationMissing,
      );
    }
  });

  test("returns the validated identity", () => {
    const result = requireReviewOrganizationConfig(configured);
    if (Result.isError(result)) {
      expect.unreachable("Configured identity must succeed");
    }
    expect(result.value).toMatchObject({
      email: configured.APP_REVIEW_ACCOUNT_EMAIL,
      organizationId: configured.APP_REVIEW_ORGANIZATION_ID,
    });
  });
});
