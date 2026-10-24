import { describe, expect, test } from "bun:test";

import { hashesExpoModules, releaseLine } from "./fingerprint";

describe("release line", () => {
  test("updates stay within a major version", () => {
    expect(releaseLine("2.0.0")).toBe("2");
    expect(releaseLine("2.7.3")).toBe("2");
    expect(releaseLine("3.0.0")).toBe("3");
  });

  test("below 1.0 every minor version is its own line", () => {
    expect(releaseLine("0.1.0")).toBe("0.1");
    expect(releaseLine("0.1.9")).toBe("0.1");
    expect(releaseLine("0.2.0")).toBe("0.2");
  });

  test("a version that is not major.minor.patch is refused", () => {
    expect(() => releaseLine("1.0")).toThrow("not major.minor.patch");
    expect(() => releaseLine("1.0.0-beta.1")).toThrow("not major.minor.patch");
  });
});

describe("autolinking guard", () => {
  test("a fingerprint must hash the platform's autolinked modules", () => {
    const ios = [{ reasons: ["expoAutolinkingIos"] }];
    expect(hashesExpoModules("ios", ios)).toBe(true);
    expect(hashesExpoModules("android", ios)).toBe(false);
    expect(hashesExpoModules("ios", [{ reasons: ["expoConfig"] }])).toBe(false);
    expect(hashesExpoModules("ios", [])).toBe(false);
  });
});
