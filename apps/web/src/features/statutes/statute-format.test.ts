import { describe, expect, test } from "bun:test";
import { createFormatter } from "use-intl/core";

import { formatValidityRange } from "@/features/statutes/statute-format";

const format = createFormatter({ locale: "cs", timeZone: "UTC" });

const range = (validFrom: string | null, validTo: string | null): string =>
  formatValidityRange({ format, openEnded: "současnost", validFrom, validTo });

describe("formatValidityRange", () => {
  test("closes a window on its last day in force, not the next version's first", () => {
    expect(range("2026-01-01", "2027-01-01")).toBe(
      `${range("2026-01-01", null).split(" – ")[0]} – ${
        range("2026-12-31", null).split(" – ")[0]
      }`,
    );
  });

  test("steps back across a month and a leap day", () => {
    expect(range("2024-01-01", "2024-03-01").split(" – ")[1]).toBe(
      range("2024-02-29", null).split(" – ")[0],
    );
  });

  test("leaves an open-ended window open", () => {
    expect(range("2026-01-01", null).endsWith("současnost")).toBe(true);
  });
});
