import { describe, expect, test } from "bun:test";

import { normalizeIco, validateIco } from "./validation.js";

describe("normalizeIco", () => {
  test("strips whitespace and dashes", () => {
    expect(normalizeIco(" 35763469 ")).toBe("35763469");
    expect(normalizeIco("35-763-469")).toBe("35763469");
  });
});

describe("validateIco", () => {
  test("accepts known-valid Slovak IČOs", () => {
    // Slovak Telekom, a.s.
    expect(validateIco("35763469")).toBe(true);
    // ESET, spol. s r.o.
    expect(validateIco("31333532")).toBe(true);
    // BTK unit s.r.o. (now DOTYKY PRÍRODY s.r.o.)
    expect(validateIco("35895420")).toBe(true);
  });

  test("rejects wrong-format strings", () => {
    expect(validateIco("3576346")).toBe(false);
    expect(validateIco("357634690")).toBe(false);
    expect(validateIco("ABCDEFGH")).toBe(false);
    expect(validateIco("")).toBe(false);
  });

  test("rejects bad checksum", () => {
    // Bump the check digit of a real IČO.
    expect(validateIco("35763460")).toBe(false);
    expect(validateIco("31333530")).toBe(false);
    expect(validateIco("12345678")).toBe(false);
  });
});
