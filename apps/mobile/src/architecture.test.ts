import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  MOBILE_APP_VARIANTS,
  MOBILE_REDIRECT_SCHEMES,
  mobileRedirectUri,
} from "@stll/api-contract/mobile-client";
import {
  MOBILE_UPDATE_SIGNING_KEY_ID,
  MOBILE_UPDATES_PATH,
} from "@stll/api-contract/mobile-updates";

import { appConfigFor, UPDATE_SIGNING_CERTIFICATE } from "../app.config";

const RUNTIME_VERSION = "2965817a6ba1e5b803427be6ba77a293ad958df4";

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
    config: appConfigFor({
      buildNumber: 7,
      runtimeVersion: RUNTIME_VERSION,
      signingCertificatePresent: true,
      variant,
    }),
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

  test("only preview and production take updates, each from its own route, signed", () => {
    for (const { config, variant } of configs) {
      expect(config.runtimeVersion).toBe(RUNTIME_VERSION);
      if (variant === "development") {
        expect(config.updates).toEqual({ enabled: false });
        continue;
      }
      expect(config.updates).toMatchObject({
        enabled: true,
        url: `https://api.stll.app${MOBILE_UPDATES_PATH}/${variant}`,
        codeSigningCertificate: UPDATE_SIGNING_CERTIFICATE,
        codeSigningMetadata: { keyid: MOBILE_UPDATE_SIGNING_KEY_ID },
      });
    }
  });

  test("a build without the signing certificate takes no updates at all", () => {
    for (const variant of MOBILE_APP_VARIANTS) {
      expect(
        appConfigFor({
          buildNumber: 1,
          runtimeVersion: RUNTIME_VERSION,
          signingCertificatePresent: false,
          variant,
        }).updates,
      ).toEqual({ enabled: false });
    }
  });
});

/** Every module the app bundles: tests run under Bun, never on the phone. */
const appModules = readdirSync(SOURCE_ROOT, { recursive: true })
  .map(String)
  .filter((name) => /\.tsx?$/u.test(name) && !name.includes(".test."))
  .toSorted();

describe("the app's JavaScript engine", () => {
  test("finds the app's modules to scan", () => {
    expect(appModules).toContain(path.join("state", "chat-threads.ts"));
  });

  test.each(appModules)(
    "%s calls no array method Hermes lacks (toSorted, toReversed, toSpliced)",
    (name) => {
      const source = readFileSync(path.join(SOURCE_ROOT, name), "utf-8");
      expect(
        source.match(/\.(?:toSorted|toReversed|toSpliced)\(/gu) ?? [],
      ).toEqual([]);
    },
  );
});

describe("the app's dates", () => {
  test("finds the app's modules to scan", () => {
    expect(appModules).toContain(path.join("components", "matter-row.tsx"));
  });

  // Hermes has no Intl.RelativeTimeFormat; use-intl then logs an error per
  // call and shows the raw date.
  test.each(appModules)("%s formats no relative time", (name) => {
    const source = readFileSync(path.join(SOURCE_ROOT, name), "utf-8");
    expect(source.match(/relativeTime\(|RelativeTimeFormat/gu) ?? []).toEqual(
      [],
    );
  });
});

describe("the app's colours", () => {
  /** Every bundled module but the generated theme, which is where colours live. */
  const painted = readdirSync(SOURCE_ROOT, { recursive: true })
    .map(String)
    .filter(
      (name) =>
        /\.tsx?$/u.test(name) &&
        !name.includes(".test.") &&
        name !== "ui-theme.gen.ts",
    )
    .toSorted();

  test("finds the theme that maps the web's colours", () => {
    expect(painted).toContain("theme.ts");
  });

  // A colour written into the app would drift from @stll/ui; every colour
  // comes from the web theme through ui-theme.gen.ts.
  test.each(painted)("%s writes no colour of its own", (name) => {
    const source = readFileSync(path.join(SOURCE_ROOT, name), "utf-8");
    expect(
      source.match(/["'`]#[\da-f]{3,8}["'`]|\b(?:rgba?|hsla?|oklch)\(/giu) ??
        [],
    ).toEqual([]);
  });
});

describe("the app's text", () => {
  const screens = readdirSync(SOURCE_ROOT, { recursive: true })
    .map(String)
    .filter(
      (name) =>
        name.endsWith(".tsx") &&
        !name.includes(".test.") &&
        name !== path.join("components", "ui", "text.tsx"),
    )
    .toSorted();

  test("finds the screens to scan", () => {
    expect(screens).toContain(path.join("app", "sign-in.tsx"));
  });

  // React Native's own Text has neither the web's typeface nor its colours;
  // the app's Text (components/ui/text.tsx) has both.
  test.each(screens)("%s sets text through the app's Text", (name) => {
    const source = readFileSync(path.join(SOURCE_ROOT, name), "utf-8");
    const fromReactNative = [
      ...source.matchAll(/import \{([^}]*)\} from "react-native";/gu),
    ].flatMap((match) =>
      (match[1] ?? "").split(",").map((part) => part.trim()),
    );
    expect(
      fromReactNative.filter(
        (imported) => imported === "Text" || imported === "TextInput",
      ),
    ).toEqual([]);
  });
});
