import { describe, expect, test } from "bun:test";

import { normalizeEntityName } from "@/api/lib/entities/entity-name";

describe("normalizeEntityName", () => {
  test("removes format characters", () => {
    expect(String(normalizeEntityName("a\u202Eb\u200F\u2066c"))).toBe("abc");
  });

  test("keeps characters a file name would refuse, because a task may use them", () => {
    expect(String(normalizeEntityName("Review: A/B?"))).toBe("Review: A/B?");
  });

  test("keeps diacritics and right-to-left letters", () => {
    for (const name of ["Příloha č. 1", "שלום", "عقد الإيجار"]) {
      expect(String(normalizeEntityName(name))).toBe(name);
    }
  });

  test("never produces an empty name from format characters alone", () => {
    expect(String(normalizeEntityName("\u202E\u200F"))).toBe("Untitled");
  });
});
