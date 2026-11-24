import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { UI_LOCALES } from "@stll/locales";

import {
  appConfigFor,
  BAR_GLYPHS_FOLDER,
  copyBarGlyphs,
  copyKeyboardExtension,
  KEYBOARD_BRIDGE,
  KEYBOARD_DICTATE_ROUTE,
  KEYBOARD_EXTENSION_FOLDER,
  KEYBOARD_SETUP_ROUTE,
  keyboardStringsSwift,
  readKeyboardStrings,
  SHARE_EXTENSION_FOLDER,
  SHARE_ROUTE,
  UPDATE_SIGNING_CERTIFICATE,
} from "../app.config";
import manifest from "../package.json" with { type: "json" };
import { BAR_GLYPHS } from "./bar-glyphs.gen";
import {
  KEYBOARD_HANDOFF_WINDOW_MS,
  KEYBOARD_LANGUAGES,
  KEYBOARD_LAYOUTS,
} from "./state/keyboard-dictation";

const RUNTIME_VERSION = "2965817a6ba1e5b803427be6ba77a293ad958df4";

const SOURCE_ROOT = import.meta.dir;

/**
 * The device boundary of the connection layer: the only modules that may
 * reach Expo native modules or React. Everything else in `connection/` runs
 * unchanged under Bun, which is what lets the API's end-to-end test sign the
 * real app code in against the real server.
 */
const DEVICE_MODULES = new Set([
  "platform.ts",
  "restored-session.ts",
  "session-provider.tsx",
]);

/** What a module imports or re-exports, including imports run only for their effect. */
const importsOf = (source: string): string[] =>
  [
    ...source.matchAll(
      /^\s*(?:(?:import|export)[^;]*?from\s+|import\s+)["']([^"']+)["']/gmu,
    ),
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
      expect(config.extra).toEqual({
        keyboardDictation: {
          appGroup: `group.${String(config.ios?.bundleIdentifier)}`,
        },
        liveActivities: true,
        pushNotifications: true,
        shareInbox: {
          appGroup: `group.${String(config.ios?.bundleIdentifier)}`,
          folder: "ShareInbox",
        },
        variant,
      });
      expect(config.ios?.bundleIdentifier).toBe(config.android?.package);
      expect(config.ios?.buildNumber).toBe("7");
      expect(config.android?.versionCode).toBe(7);
    },
  );

  // iOS opens an app only in a language its bundle declares, so every build
  // declares every interface language the app ships, and nothing else.
  test.each(configs)(
    "$variant declares every interface language to iOS",
    ({ config }) => {
      const declared: unknown =
        config.ios?.infoPlist?.["CFBundleLocalizations"];
      expect(declared).toEqual([...UI_LOCALES]);
    },
  );

  test("a signed release leaves out the Live Activity extension it cannot sign yet", () => {
    const signed = appConfigFor({
      buildNumber: 7,
      runtimeVersion: RUNTIME_VERSION,
      signing: { profileUuid: "profile", teamId: "TEAM" },
      signingCertificatePresent: true,
      variant: "preview",
    });
    expect(signed.extra).toEqual({
      keyboardDictation: null,
      liveActivities: false,
      pushNotifications: false,
      shareInbox: null,
      variant: "preview",
    });
    expect(signed.ios?.entitlements).toBeUndefined();
    expect(
      signed.plugins?.some(
        (plugin) =>
          (Array.isArray(plugin) ? plugin[0] : plugin) === "expo-widgets",
      ),
    ).toBe(false);
  });

  test("a release with the widgets profile carries the Live Activity extension", () => {
    const signed = appConfigFor({
      buildNumber: 7,
      runtimeVersion: RUNTIME_VERSION,
      signing: {
        profileUuid: "profile",
        teamId: "TEAM",
        widgetsProfileUuid: "widgets",
      },
      signingCertificatePresent: true,
      variant: "preview",
    });
    expect(signed.extra).toEqual({
      // The share extension and the keyboard wait for profiles of their own.
      keyboardDictation: null,
      liveActivities: true,
      pushNotifications: true,
      shareInbox: null,
      variant: "preview",
    });
    expect(signed.plugins).toContainEqual([
      "expo-widgets",
      {
        bundleIdentifier: "app.stll.mobile.preview.widgets",
        groupIdentifier: "group.app.stll.mobile.preview",
        enablePushNotifications: true,
      },
    ]);
  });

  test("a release with the share profile carries the share extension and its App Group", () => {
    const signed = appConfigFor({
      buildNumber: 7,
      runtimeVersion: RUNTIME_VERSION,
      signing: {
        profileUuid: "profile",
        shareProfileUuid: "share",
        teamId: "TEAM",
        widgetsProfileUuid: "widgets",
      },
      signingCertificatePresent: true,
      variant: "preview",
    });
    expect(signed.extra?.["shareInbox"]).toEqual({
      appGroup: "group.app.stll.mobile.preview",
      folder: "ShareInbox",
    });
    expect(signed.ios?.entitlements).toEqual({
      "com.apple.security.application-groups": [
        "group.app.stll.mobile.preview",
      ],
    });
  });

  test("the share extension opens a route the app has, and reads only settings the config sets", () => {
    expect(
      existsSync(path.join(SOURCE_ROOT, "app", SHARE_ROUTE, "[shareId].tsx")),
    ).toBe(true);
    const extension = path.join(SOURCE_ROOT, "..", SHARE_EXTENSION_FOLDER);
    const plist = readFileSync(
      path.join(extension, "StellaShare-Info.plist"),
      "utf-8",
    );
    const config = readFileSync(
      path.join(SOURCE_ROOT, "..", "app.config.ts"),
      "utf-8",
    );
    const settings = [
      ...plist.matchAll(/\$\((STELLA_[A-Z_]+)\)/gu),
      ...readFileSync(
        path.join(extension, "StellaShare.entitlements"),
        "utf-8",
      ).matchAll(/\$\((STELLA_[A-Z_]+)\)/gu),
    ].map((match) => match[1] ?? "");
    expect(settings.length).toBeGreaterThan(0);
    for (const setting of settings) {
      expect(config).toContain(`${setting}: `);
    }
    const keys = [
      ...readFileSync(
        path.join(extension, "ShareViewController.swift"),
        "utf-8",
      ).matchAll(/info\["(\w+)"\]/gu),
    ].map((match) => match[1] ?? "");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
  });

  test("a release with the keyboard profile carries the keyboard and its App Group", () => {
    const signed = appConfigFor({
      buildNumber: 7,
      runtimeVersion: RUNTIME_VERSION,
      signing: {
        keyboardProfileUuid: "keyboard",
        profileUuid: "profile",
        teamId: "TEAM",
        widgetsProfileUuid: "widgets",
      },
      signingCertificatePresent: true,
      variant: "preview",
    });
    expect(signed.extra?.["keyboardDictation"]).toEqual({
      appGroup: "group.app.stll.mobile.preview",
    });
    expect(signed.extra?.["shareInbox"]).toBeNull();
    expect(signed.ios?.entitlements).toEqual({
      "com.apple.security.application-groups": [
        "group.app.stll.mobile.preview",
      ],
    });
  });

  test("the keyboard opens routes the app has, and reads only settings the config sets", () => {
    for (const route of [KEYBOARD_DICTATE_ROUTE, KEYBOARD_SETUP_ROUTE]) {
      expect(existsSync(path.join(SOURCE_ROOT, "app", `${route}.tsx`))).toBe(
        true,
      );
    }
    const extension = path.join(SOURCE_ROOT, "..", KEYBOARD_EXTENSION_FOLDER);
    const plist = readFileSync(
      path.join(extension, "StellaKeyboard-Info.plist"),
      "utf-8",
    );
    expect(plist).toContain("<key>RequestsOpenAccess</key>\n\t\t\t<true/>");
    const config = readFileSync(
      path.join(SOURCE_ROOT, "..", "app.config.ts"),
      "utf-8",
    );
    const settings = [
      ...plist.matchAll(/\$\((STELLA_[A-Z_]+)\)/gu),
      ...readFileSync(
        path.join(extension, "StellaKeyboard.entitlements"),
        "utf-8",
      ).matchAll(/\$\((STELLA_[A-Z_]+)\)/gu),
    ].map((match) => match[1] ?? "");
    expect(settings.length).toBeGreaterThan(0);
    for (const setting of settings) {
      expect(config).toContain(`${setting}: `);
    }
    const keys = [
      ...readFileSync(
        path.join(extension, "KeyboardViewController.swift"),
        "utf-8",
      ).matchAll(/info\["(\w+)"\]/gu),
    ].map((match) => match[1] ?? "");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
  });

  test("the keyboard and the app agree on the languages and the link's window", () => {
    const bridge = readFileSync(
      path.join(SOURCE_ROOT, "..", KEYBOARD_BRIDGE),
      "utf-8",
    );
    const languages = /static let languages = \[([^\]]*)\]/u.exec(bridge)?.[1];
    expect(
      [...(languages ?? "").matchAll(/"(\w+)"/gu)].map((match) => match[1]),
    ).toEqual([...KEYBOARD_LANGUAGES]);
    const window = /static let handoffWindowMs: Int64 = ([\d_]+)/u.exec(
      bridge,
    )?.[1];
    expect(Number(window?.replaceAll("_", ""))).toBe(
      KEYBOARD_HANDOFF_WINDOW_MS,
    );
    const layouts = /enum KeyboardLayoutChoice[^{]*\{([^}]*)\}/u.exec(
      bridge,
    )?.[1];
    expect(
      [...(layouts ?? "").matchAll(/case (\w+)/gu)].map((match) => match[1]),
    ).toEqual([...KEYBOARD_LAYOUTS]);
  });

  test("the keyboard types every Czech and Slovak letter, from either layout", () => {
    const keys = readFileSync(
      path.join(
        SOURCE_ROOT,
        "..",
        KEYBOARD_EXTENSION_FOLDER,
        "KeyboardKeys.swift",
      ),
      "utf-8",
    );
    const accents = keys.slice(
      keys.indexOf("static let accents"),
      keys.indexOf("static let symbols"),
    );
    for (const letter of "ěščřžýáíéúůďťňäôľĺŕó") {
      expect(accents).toContain(`"${letter}"`);
    }
  });

  test("every message the keyboard shows is in the catalogs, in every locale", () => {
    const catalogs = readKeyboardStrings(path.join(SOURCE_ROOT, ".."));
    const source = Object.keys(catalogs["en"] ?? {}).toSorted();
    expect(Object.keys(catalogs).toSorted()).toEqual(
      [...UI_LOCALES].toSorted(),
    );
    for (const messages of Object.values(catalogs)) {
      expect(Object.keys(messages).toSorted()).toEqual(source);
    }
    const extension = path.join(SOURCE_ROOT, "..", KEYBOARD_EXTENSION_FOLDER);
    const named = new Set(
      readdirSync(extension)
        .filter((name) => name.endsWith(".swift"))
        .flatMap((name) =>
          [
            ...readFileSync(path.join(extension, name), "utf-8").matchAll(
              /strings\.(\w+)/gu,
            ),
          ].map((match) => match[1] ?? ""),
        ),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const key of named) {
      expect(source).toContain(key);
    }
  });

  test("the keyboard's messages compile to Swift literals that say exactly the message", () => {
    const swift = keyboardStringsSwift({
      en: { ready: 'Say "hi" \\ (twice)\nthen \\(stop)' },
      cs: { ready: "Řekněte\u0007ahoj" },
    });
    expect(swift).toContain("  let ready: String");
    expect(swift).toContain(
      'ready: "Say \\"hi\\" \\\\ (twice)\\u{a}then \\\\(stop)"',
    );
    expect(swift).toContain('ready: "Řekněte\\u{7}ahoj"');
    expect(() => keyboardStringsSwift({ en: { ready: "a" }, cs: {} })).toThrow(
      "cs lacks keyboard.ready",
    );
    expect(() => keyboardStringsSwift({ en: { "not-swift": "a" } })).toThrow(
      "keyboard.not-swift is no Swift name",
    );
  });

  test("prebuild copies the keyboard, the bridge and its messages into the native project", () => {
    const platformProjectRoot = mkdtempSync(
      path.join(tmpdir(), "stella-keyboard-"),
    );
    try {
      mkdirSync(path.join(platformProjectRoot, "StellaKeyboard", "stale"), {
        recursive: true,
      });
      copyKeyboardExtension({
        platformProjectRoot,
        projectRoot: path.join(SOURCE_ROOT, ".."),
      });
      expect(
        readdirSync(
          path.join(platformProjectRoot, "StellaKeyboard"),
        ).toSorted(),
      ).toEqual(
        [
          "KeyboardDictationBridge.swift",
          "KeyboardKeys.swift",
          "KeyboardStrings.swift",
          "KeyboardViewController.swift",
          "StellaKeyboard-Info.plist",
          "StellaKeyboard.entitlements",
        ].toSorted(),
      );
    } finally {
      rmSync(platformProjectRoot, { force: true, recursive: true });
    }
  });

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

describe("the bar glyphs", () => {
  test("prebuild puts every one in the app's asset catalog, replacing an earlier copy", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "stella-bar-glyphs-"));
    try {
      const sourceRoot = path.join(projectRoot, "ios", "stella");
      const catalog = path.join(sourceRoot, "Images.xcassets", "BarGlyphs");
      mkdirSync(path.join(catalog, "lucide-dropped.imageset"), {
        recursive: true,
      });
      writeFileSync(path.join(sourceRoot, "AppDelegate.swift"), "");
      cpSync(
        path.join(SOURCE_ROOT, "..", BAR_GLYPHS_FOLDER),
        path.join(projectRoot, BAR_GLYPHS_FOLDER),
        { recursive: true },
      );

      copyBarGlyphs(projectRoot);

      expect(readdirSync(catalog).toSorted()).toEqual(
        [
          "Contents.json",
          ...Object.values(BAR_GLYPHS).map((name) => `${name}.imageset`),
        ].toSorted(),
      );
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
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

describe("the app's plurals", () => {
  // Hermes has no Intl.PluralRules either. Without it use-intl cannot format
  // an ICU plural and shows the message's key: a scan's page count read
  // "scan.pages", which looks like a file in Apple's Pages format.
  test("installs plural rules before the catalogues format a message", () => {
    expect(
      importsOf(
        readFileSync(path.join(SOURCE_ROOT, "i18n", "index.tsx"), "utf-8"),
      )[0],
    ).toBe("@/i18n/plural-rules");
  });

  test("has the plural rules of every UI locale", () => {
    const loaded = importsOf(
      readFileSync(path.join(SOURCE_ROOT, "i18n", "plural-rules.ts"), "utf-8"),
    );
    expect(loaded).toContain("@formatjs/intl-pluralrules/polyfill.js");
    expect(
      UI_LOCALES.map(
        (locale) =>
          `@formatjs/intl-pluralrules/locale-data/${locale.split("-")[0] ?? locale}.js`,
      ).filter((data) => !loaded.includes(data)),
    ).toEqual([]);
  });
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

describe("the app's dependencies", () => {
  /** Test helpers run under Bun beside the tests and may use dev dependencies. */
  const bundled = appModules.filter(
    (name) => !name.split(path.sep).includes("test-support"),
  );

  /** `@scope/name/sub` and `name/sub` name the packages `@scope/name` and `name`. */
  const packageOf = (specifier: string): string =>
    specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");

  test("reads a scoped package's name from a subpath import", () => {
    expect(packageOf("@stll/ui/matter-colors")).toBe("@stll/ui");
    expect(packageOf("expo-router/stack")).toBe("expo-router");
  });

  // The release jobs install only `@stll/mobile...`, so a package that is
  // linked at the workspace root but missing here type-checks and bundles
  // locally, then fails the TestFlight archive.
  test.each(bundled)("%s imports only packages the app depends on", (name) => {
    const source = readFileSync(path.join(SOURCE_ROOT, name), "utf-8");
    expect(
      importsOf(source)
        .filter(
          (specifier) =>
            !specifier.startsWith(".") && !specifier.startsWith("@/"),
        )
        .map(packageOf)
        .filter((pkg) => !Object.hasOwn(manifest.dependencies, pkg)),
    ).toEqual([]);
  });
});

describe("the app's colours", () => {
  /**
   * Every bundled module but the generated theme, which is where colours
   * live, and the sign-in backdrop, whose blue the web writes outside its
   * theme (auth-backdrop.test.ts holds it to the web's).
   */
  const painted = appModules.filter(
    (name) =>
      name !== "ui-theme.gen.ts" &&
      name !== path.join("components", "auth-backdrop.ts"),
  );

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

describe("the app's links", () => {
  /**
   * The modules that may hand a link to the system: the opener, which opens
   * only what `state/links.ts` accepted and shows a web link's host first,
   * and the decision reader, which opens the court's own web pages through
   * `isWebUrl` from the same module.
   */
  const OPENERS = new Set([
    path.join("components", "open-link.ts"),
    path.join("components", "decision-reader.tsx"),
  ]);

  const opensLinks = (source: string): string[] =>
    source.match(/\bopenURL\s*\(|\bopenURL\b(?=\s*[,}])/gu) ?? [];

  test("finds the opener, and the scan sees the calls it forbids elsewhere", () => {
    for (const name of OPENERS) {
      expect(appModules).toContain(name);
      expect(
        opensLinks(readFileSync(path.join(SOURCE_ROOT, name), "utf-8")),
      ).not.toEqual([]);
    }
    expect(opensLinks("const { openURL } = Linking;")).not.toEqual([]);
  });

  // A link from an answer or a document can name any scheme: a call, a
  // message, another app. Opening one anywhere else would skip the rule.
  test.each(appModules.filter((name) => !OPENERS.has(name)))(
    "%s opens no link itself",
    (name) => {
      expect(
        opensLinks(readFileSync(path.join(SOURCE_ROOT, name), "utf-8")),
      ).toEqual([]);
    },
  );
});

describe("the app's text", () => {
  const screens = readdirSync(SOURCE_ROOT, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .toSorted();

  test("finds the screens to scan", () => {
    expect(screens).toContain(path.join("app", "sign-in.tsx"));
  });

  // React Native's own Text has neither the web's typeface nor its colours;
  // @stll/ui's Text, Input and Textarea have both.
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

describe("the app's transcriptions", () => {
  /**
   * The one module that sends a recording to a model by name. Everything
   * else goes through `transcribeWithinClass`, so a server that cannot serve
   * the picked model hands the audio only to one of its provider, region
   * side and retention, never to the server's default.
   */
  const SENDER = path.join("state", "dictation.ts");

  const sendsDirectly = (source: string): string[] =>
    source.match(/\btranscribeRecording\b/gu) ?? [];

  test("finds the sender, and the scan sees the call it forbids elsewhere", () => {
    expect(appModules).toContain(SENDER);
    expect(
      sendsDirectly(readFileSync(path.join(SOURCE_ROOT, SENDER), "utf-8")),
    ).not.toEqual([]);
  });

  test.each(appModules.filter((name) => name !== SENDER))(
    "%s transcribes only within the picked model's class",
    (name) => {
      expect(
        sendsDirectly(readFileSync(path.join(SOURCE_ROOT, name), "utf-8")),
      ).toEqual([]);
    },
  );
});
