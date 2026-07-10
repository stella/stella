import { describe, expect, test } from "bun:test";

import { organizationAnonymizationBlacklistOptions } from "./anonymization-blacklist";

describe("organization anonymization blacklist query identity", () => {
  test("INVARIANT: different organizations cannot share cached deny-list data", () => {
    const organizationIds = ["org-a", "org-b", "org-c", "org-with-unicode-ž"];

    for (const organizationId of organizationIds) {
      for (const otherOrganizationId of organizationIds) {
        if (organizationId === otherOrganizationId) {
          continue;
        }

        expect(
          organizationAnonymizationBlacklistOptions({ organizationId })
            .queryKey,
        ).not.toEqual(
          organizationAnonymizationBlacklistOptions({
            organizationId: otherOrganizationId,
          }).queryKey,
        );
      }
    }
  });
});
