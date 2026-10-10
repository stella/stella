import { describe, expect, test } from "bun:test";
import { createFormatter } from "use-intl/core";

import {
  formatStatedWindow,
  formatValidityRange,
} from "@/lib/statutes/statute-format";

const format = createFormatter({ locale: "cs", timeZone: "UTC" });

const OPEN_ENDED = "současnost";

const range = (validFrom: string | null, validTo: string | null): string =>
  formatValidityRange({ format, openEnded: OPEN_ENDED, validFrom, validTo });

// The formatted day alone: an open-ended window minus its open end.
const day = (date: string): string =>
  range(date, null).replace(` – ${OPEN_ENDED}`, "");

describe("formatValidityRange", () => {
  test("closes a window on its last day in force, not the next version's first", () => {
    expect(range("2026-01-01", "2027-01-01")).toBe(
      `${day("2026-01-01")} – ${day("2026-12-31")}`,
    );
  });

  test("steps back across a month and a leap day", () => {
    expect(range("2024-01-01", "2024-03-01").split(" – ")[1]).toBe(
      day("2024-02-29"),
    );
  });

  test("leaves an open-ended window open", () => {
    expect(range("2026-01-01", null).endsWith(OPEN_ENDED)).toBe(true);
  });
});

describe("formatStatedWindow", () => {
  const stated = (validFrom: string | null, validTo: string | null): string =>
    formatStatedWindow({ format, openEnded: OPEN_ENDED, validFrom, validTo });

  test("shows both stored boundaries as stated, never a stepped-back end", () => {
    expect(stated("2022-01-01", "2023-01-01")).toBe(
      `${day("2022-01-01")} – ${day("2023-01-01")}`,
    );
  });

  test("keeps a zero-length window on the one day the publisher stated", () => {
    const window = stated("2022-01-01", "2022-01-01");
    expect(window).not.toContain(day("2021-12-31"));
    expect(window).toBe(`${day("2022-01-01")} – ${day("2022-01-01")}`);
  });

  test("leaves an unstated end open", () => {
    expect(stated("2022-01-01", null)).toBe(
      `${day("2022-01-01")} – ${OPEN_ENDED}`,
    );
  });
});
