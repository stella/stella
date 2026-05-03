import { describe, expect, test } from "bun:test";

import { normalizeAnonymizationBlacklistEntry } from "@/api/lib/anonymization-blacklist";

describe("anonymization blacklist normalization", () => {
  test("trims terms and removes duplicate empty variants", () => {
    expect(
      normalizeAnonymizationBlacklistEntry({
        canonical: "  Acme GmbH  ",
        label: " organization ",
        variants: [" Acme ", "", "Acme", "ACME GmbH "],
      }),
    ).toEqual({
      canonical: "Acme GmbH",
      enabled: true,
      label: "organization",
      variants: ["Acme", "ACME GmbH"],
    });
  });
});
