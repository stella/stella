import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  normalizeAnonymizationBlacklistEntries,
  normalizeAnonymizationBlacklistEntry,
} from "@/api/lib/anonymization-blacklist";

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

  test("rejects entries that become blank after normalization", () => {
    const result = normalizeAnonymizationBlacklistEntries([
      {
        canonical: "   ",
        label: "person",
      },
    ]);

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected blank term rejection");
    }

    expect(result.error.status).toBe(400);
  });
});
