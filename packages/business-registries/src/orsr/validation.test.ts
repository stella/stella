import { describe, expect, test } from "bun:test";

import { normalizeIco, validateIco } from "./validation.js";

describe("normalizeIco", () => {
  test("strips spaces and dashes", () => {
    expect(normalizeIco(" 31 333 532 ")).toBe("31333532");
    expect(normalizeIco("31-333-532")).toBe("31333532");
  });
});

describe("validateIco", () => {
  test("accepts known-valid Slovak IČOs", () => {
    // ESET, spol. s r.o.
    expect(validateIco("31333532")).toBe(true);
    // VOLKSWAGEN SLOVAKIA, a.s.
    expect(validateIco("35757442")).toBe(true);
    // Slovak Telekom, a.s.
    expect(validateIco("35763469")).toBe(true);
  });

  test("rejects wrong-length / non-digit inputs", () => {
    expect(validateIco("3133353")).toBe(false);
    expect(validateIco("313335322")).toBe(false);
    expect(validateIco("abcdefgh")).toBe(false);
    expect(validateIco("")).toBe(false);
  });

  test("rejects bad MOD-11 checksums", () => {
    // 31333532 is valid; bump the last digit.
    expect(validateIco("31333531")).toBe(false);
    expect(validateIco("31333533")).toBe(false);
  });
});
