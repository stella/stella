import { describe, expect, test } from "bun:test";

import { parseNip } from "./nip";

describe("parseNip", () => {
  test("reads a NIP as people write it", () => {
    expect(parseNip("5260001246")).toBe("5260001246");
    expect(parseNip("PL 526-000-12-46")).toBe("5260001246");
    expect(parseNip("pl725-001-85-13")).toBe("7250018513");
  });

  test("refuses a wrong checksum, a checksum of 10 and other shapes", () => {
    expect(parseNip("5260001247")).toBeNull();
    // 1·6 + 2·5 + … + 9·7 = 230, and 230 mod 11 = 10: no NIP ends in 10.
    expect(parseNip("1234567890")).toBeNull();
    expect(parseNip("526000124")).toBeNull();
    expect(parseNip("CZ27082440")).toBeNull();
    expect(parseNip("")).toBeNull();
  });
});
