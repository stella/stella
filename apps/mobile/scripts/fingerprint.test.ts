import { describe, expect, test } from "bun:test";

import {
  hashesExpoModules,
  portableFingerprint,
  portablePath,
  releaseLine,
} from "./fingerprint";

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

describe("portable fingerprint", () => {
  test("a path through any package store names the package's own path", () => {
    expect(
      portablePath(
        "../../node_modules/.bun/expo@57.0.27+8a680045d048c42d/node_modules/expo/Expo.podspec",
      ),
    ).toBe("node_modules/expo/Expo.podspec");
    expect(
      portablePath(
        "../../../root/.bun/install/cache/links/expo-eas-client@57.0.5-a46f43dae06678d1/node_modules/expo-eas-client/ios",
      ),
    ).toBe("node_modules/expo-eas-client/ios");
    expect(portablePath("patches/x.patch")).toBe("patches/x.patch");
  });

  type Install = { podspec?: string; swift?: string };

  /** The same packages, linked from `store` as one install or another does. */
  const installedFrom = (
    store: string,
    { podspec = "expo-1", swift = "swift-1" }: Install = {},
  ) => {
    const ios = `${store}expo-eas-client@57.0.5-abc/node_modules/expo-eas-client/ios`;
    return {
      sources: [
        {
          type: "dir" as const,
          filePath: ios,
          reasons: ["expoAutolinkingIos"],
          // Expo's own directory hash names files by their store paths.
          hash: `dir-${store}`,
          debugInfo: {
            path: ios,
            hash: `dir-${store}`,
            children: [
              { path: `${ios}/EASClient.podspec`, hash: "podspec-1" },
              {
                path: `${ios}/EASClient`,
                hash: `sub-${store}`,
                children: [
                  { path: `${ios}/EASClient/Client.swift`, hash: swift },
                ],
              },
            ],
          },
        },
        {
          type: "contents" as const,
          id: "expoAutolinkingConfig:ios",
          contents: JSON.stringify({
            podspecDir: `${store}expo@57.0.27-def/node_modules/expo`,
            podspec,
          }),
          reasons: ["expoAutolinkingIos"],
          hash: "raw",
        },
        {
          type: "file" as const,
          filePath: "patches/x.patch",
          reasons: [],
          hash: null,
        },
        {
          type: "file" as const,
          filePath: "app.config.ts",
          reasons: ["expoConfigPlugins"],
          hash: "config-1",
        },
        {
          type: "file" as const,
          filePath: `${store}convert-source-map@2.0.0-x/node_modules/convert-source-map/index.js`,
          reasons: ["expoConfigPlugins"],
          hash: "helper-1",
        },
      ],
    };
  };

  const FULL = "../../node_modules/.bun/";
  const FILTERED = "../../../root/.bun/install/cache/links/";

  test("one commit fingerprints alike from a full install and CI's filtered one", () => {
    const full = portableFingerprint(installedFrom(FULL));
    const filtered = portableFingerprint(installedFrom(FILTERED));
    expect(filtered).toEqual(full);
    expect(full.hash).toMatch(/^[0-9a-f]{40}$/u);
    expect(full.sources.map(({ source }) => source)).toEqual([
      "app.config.ts",
      "expoAutolinkingConfig:ios",
      "node_modules/expo-eas-client/ios",
      "patches/x.patch",
    ]);
  });

  test("a change in what is hashed still moves the fingerprint", () => {
    const base = portableFingerprint(installedFrom(FULL)).hash;
    expect(
      portableFingerprint(installedFrom(FULL, { podspec: "expo-2" })).hash,
    ).not.toBe(base);
    expect(
      portableFingerprint(installedFrom(FULL, { swift: "swift-2" })).hash,
    ).not.toBe(base);
  });
});
