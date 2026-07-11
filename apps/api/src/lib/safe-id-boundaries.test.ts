import { describe, expect, test } from "bun:test";

import { parseExternalOrganizationId } from "@/api/lib/safe-id-boundaries";

describe("external organization id parsing", () => {
  test("accepts UUID organization ids", () => {
    expect(
      String(
        parseExternalOrganizationId("0191d14d-9a63-7d2e-a021-06053e542c85"),
      ),
    ).toBe("0191d14d-9a63-7d2e-a021-06053e542c85");
  });

  test("rejects malformed provider metadata before database access", () => {
    expect(parseExternalOrganizationId("not/an/organization/id")).toBeNull();
  });
});
