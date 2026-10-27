import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  MOBILE_APP_VARIANTS,
  MOBILE_REDIRECT_SCHEMES,
  mobileRedirectUri,
} from "@stll/api-contract/mobile-client";

import { appConfigFor } from "../app.config";

const SOURCE_ROOT = import.meta.dir;

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

describe("the app's builds", () => {
  const configs = MOBILE_APP_VARIANTS.map((variant) => ({
    variant,
    config: appConfigFor({ buildNumber: 7, variant }),
  }));

  test.each(configs)(
    "$variant registers its own redirect scheme and tells the app which build it is",
    ({ config, variant }) => {
      expect(config.scheme).toBe(MOBILE_REDIRECT_SCHEMES[variant]);
      expect(
        mobileRedirectUri(variant).startsWith(`${String(config.scheme)}:`),
      ).toBe(true);
      expect(config.extra).toEqual({ variant });
      expect(config.ios?.bundleIdentifier).toBe(config.android?.package);
      expect(config.ios?.buildNumber).toBe("7");
      expect(config.android?.versionCode).toBe(7);
    },
  );

  test("no two builds share a store identity, a scheme or a name", () => {
    for (const read of [
      ({ config }: (typeof configs)[number]) => config.ios?.bundleIdentifier,
      ({ config }: (typeof configs)[number]) => config.scheme,
      ({ config }: (typeof configs)[number]) => config.name,
    ]) {
      expect(new Set(configs.map(read)).size).toBe(configs.length);
    }
  });
});
