import { describe, expect, test } from "bun:test";

import { hashesExpoModules, releaseLine, sourceHashes } from "./fingerprint";

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

describe("source hashes", () => {
  test("each source is named by its file, or by its id when it has none", () => {
    expect(
      sourceHashes({
        sources: [
          {
            type: "dir",
            filePath: "ios",
            reasons: ["bareNativeDir"],
            hash: "a",
          },
          {
            type: "contents",
            id: "releaseLine",
            contents: "0.1",
            reasons: ["releaseLine"],
            hash: "b",
          },
          {
            type: "file",
            filePath: "patches/x.patch",
            reasons: [],
            hash: null,
          },
        ],
      }),
    ).toEqual([
      { source: "ios", type: "dir", hash: "a" },
      { source: "releaseLine", type: "contents", hash: "b" },
      { source: "patches/x.patch", type: "file", hash: null },
    ]);
  });
});
