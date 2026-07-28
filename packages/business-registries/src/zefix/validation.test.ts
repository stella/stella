import { describe, expect, test } from "bun:test";

import {
  formatUid,
  normalizeUid,
  parseUid,
  validateUid,
} from "./validation.js";

describe("Swiss UID validation", () => {
  test("normalizes common registry spellings", () => {
    expect(normalizeUid("CHE-191.546.434")).toBe("191546434");
    expect(normalizeUid("CHE 191 546 434")).toBe("191546434");
    expect(normalizeUid("191546434")).toBe("191546434");
  });

  test("checks the modulo-11 digit", () => {
    expect(validateUid("CHE-191.546.434")).toBe(true);
    expect(validateUid("CHE-191.546.435")).toBe(false);
    expect(validateUid("not-a-uid-191546434")).toBe(false);
  });

  test("brands only checksum-valid canonical values", () => {
    expect(String(parseUid("CHE-191.546.434"))).toBe("191546434");
    expect(parseUid("CHE-191.546.435")).toBeNull();
  });

  test("formats canonical digits", () => {
    expect(formatUid("191546434")).toBe("CHE-191.546.434");
  });
});
