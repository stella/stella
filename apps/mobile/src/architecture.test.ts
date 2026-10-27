import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { MOBILE_REDIRECT_SCHEME } from "@stll/api-contract/mobile-client";

const SOURCE_ROOT = import.meta.dir;
const APP_ROOT = path.dirname(SOURCE_ROOT);

/**
 * The device boundary of the connection layer: the only modules that may
 * reach Expo native modules or React. Everything else in `connection/` runs
 * unchanged under Bun, which is what lets the API's end-to-end test sign the
 * real app code in against the real server.
 */
const DEVICE_MODULES = new Set(["platform.ts", "session-provider.tsx"]);

const importsOf = (source: string): string[] =>
  [
    ...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gmu),
  ].map((match) => match[1] ?? "");

const connectionModules = readdirSync(path.join(SOURCE_ROOT, "connection"))
  .filter((name) => /\.tsx?$/u.test(name) && !name.includes(".test."))
  .toSorted();

describe("the connection layer", () => {
  test("lists a device boundary that exists, which the import scan reads", () => {
    for (const name of DEVICE_MODULES) {
      expect(connectionModules).toContain(name);
    }
    // The detector must see the imports it forbids elsewhere, or every
    // module below would pass vacuously.
    expect(
      importsOf(
        readFileSync(
          path.join(SOURCE_ROOT, "connection", "platform.ts"),
          "utf-8",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "expo-crypto",
        "expo-secure-store",
        "expo-web-browser",
      ]),
    );
  });

  test.each(connectionModules.filter((name) => !DEVICE_MODULES.has(name)))(
    "%s imports no Expo, React or app alias, so it runs under Bun and the API",
    (name) => {
      const imports = importsOf(
        readFileSync(path.join(SOURCE_ROOT, "connection", name), "utf-8"),
      );
      expect(
        imports.filter(
          (specifier) =>
            specifier.startsWith("@/") ||
            specifier.startsWith("expo") ||
            specifier.startsWith("react"),
        ),
      ).toEqual([]);
    },
  );
});

describe("the app's redirect", () => {
  test("is the only scheme the app registers", () => {
    const config: unknown = JSON.parse(
      readFileSync(path.join(APP_ROOT, "app.json"), "utf-8"),
    );
    expect(config).toMatchObject({ expo: { scheme: MOBILE_REDIRECT_SCHEME } });
  });
});
