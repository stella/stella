import { describe, expect, test } from "bun:test";

import { normalizeApprovalFilters } from "./filters.logic";

describe("approval filter boundaries", () => {
  test("cleared filters are absent, selected values survive, and normalization is a fixed point", () => {
    for (let combination = 0; combination < 16; combination += 1) {
      const filters = {
        from: combination % 2 === 1 ? "2026-09-01" : undefined,
        to: Math.floor(combination / 2) % 2 === 1 ? "2026-09-30" : undefined,
        member: Math.floor(combination / 4) % 2 === 1 ? "member-1" : undefined,
        matter: Math.floor(combination / 8) % 2 === 1 ? "matter-1" : undefined,
      };
      const normalized = normalizeApprovalFilters(filters);

      for (const [key, value] of Object.entries(filters)) {
        expect(Object.hasOwn(normalized, key)).toBe(value !== undefined);
      }
      expect(
        Object.entries(filters).filter(([, value]) => value !== undefined),
      ).toEqual(Object.entries(normalized));
      expect(normalizeApprovalFilters(normalized)).toEqual(normalized);
    }
  });
});
