import { describe, expect, test } from "bun:test";

import { generateHexId, MAX_HEX_ID_EXCLUSIVE } from "./hexId";

describe("generateHexId", () => {
  test("returns an 8-character uppercase hex string", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateHexId()).toMatch(/^[0-9A-F]{8}$/u);
    }
  });

  test("stays strictly below MAX_HEX_ID_EXCLUSIVE so Word doesn't reject", () => {
    for (let i = 0; i < 200; i++) {
      const id = Number.parseInt(generateHexId(), 16);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(MAX_HEX_ID_EXCLUSIVE);
    }
  });

  test("produces unique ids in a small sample (sanity check on the rng)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateHexId());
    }
    expect(seen.size).toBeGreaterThan(95);
  });
});
