import { panic } from "better-result";
import type { ConfigContext, ExpoConfig } from "expo/config";
import {
  IOSConfig,
  withDangerousMod,
  withPodfile,
  withXcodeProject,
} from "expo/config-plugins";
import type { ConfigPlugin, ExportedConfig } from "expo/config-plugins";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// The interface languages come from `@stll/locales` itself, so iOS is told
// exactly the languages the app ships.
import { UI_LOCALES } from "@stll/locales/languages";

// Evaluated by Node through Expo's config loader, which cannot follow a
// workspace package's extensionless TypeScript imports. So this file imports
// npm packages and only workspace modules that import nothing (as
// `@stll/locales/languages`), and `src/architecture.test.ts` pins every value
// below to `@stll/api-contract/mobile-client`.

const VARIANTS = ["development", "preview", "production"] as const;

/** The store version; `scripts/fingerprint.ts` hashes its release line. */
export const APP_VERSION = "0.1.0";

type Variant = (typeof VARIANTS)[number];

/**
 * One app, three installable builds. Each has its own name, store identity
 * and redirect scheme, so a development client, an internal preview and the
 * store release can sit side by side on one phone and each sign-in returns
 * to the build that started it.
 */
const VARIANT_CONFIG = {
  development: {
    name: "stella Dev",
    identifier: "app.stll.mobile.dev",
    scheme: "app.stll.dev",
  },
  preview: {
    name: "stella Preview",
    identifier: "app.stll.mobile.preview",
    scheme: "app.stll.preview",
  },
  production: {
    name: "stella",
    identifier: "app.stll.mobile",
    scheme: "app.stll",
  },
} as const satisfies Record<
  Variant,
  { name: string; identifier: string; scheme: string }
>;

/**
 * A release build's signing, set by the release workflow: the team and the
 * App Store profile it installed for this variant. Unset locally, where Xcode
 * signs development builds automatically.
 */
type ReleaseSigning = {
  profileUuid: string;
  teamId: string;
  /** The Live Activity extension's own profile; without it the release leaves the extension out. */
  widgetsProfileUuid?: string | undefined;
  /**
   * The share extension's own profile, granted the App Group; set only
   * beside the widgets profile, whose regeneration gave the app the App
   * Group. Without it the release leaves the share extension out.
   */
  shareProfileUuid?: string | undefined;
  /**
   * The keyboard extension's own profile, granted the App Group; set, like
   * the share profile, only beside the widgets profile. Without it the
   * release leaves the keyboard out.
   */
  keyboardProfileUuid?: string | undefined;
};

/** The target expo-widgets adds for the widget extension. */
const WIDGETS_TARGET = "ExpoWidgetsTarget";

/**
 * The share extension's target, built from `share-extension/`: the system
 * share sheet's way to hand files, links and text to the app. It copies them
 * into a folder of the App Group's inbox and opens the app on the share
 * route, which imports them and deletes the folder.
 */
const SHARE_TARGET = "StellaShare";

/** The share extension's sources, copied into the native project at prebuild. */
export const SHARE_EXTENSION_FOLDER = "share-extension";

/** The App Group folder the extension writes each share into. */
const SHARE_INBOX_FOLDER = "ShareInbox";

/** The app route a share opens on: `src/app/share/[shareId].tsx`. */
export const SHARE_ROUTE = "share";

/**
 * The stella keyboard's target, built from `keyboard-extension/`: dictation
 * into any app. A keyboard may not record, so the app records and
 * transcribes (`modules/keyboard-dictation`), and the two talk through the
 * App Group with the bridge both compile.
 */
const KEYBOARD_TARGET = "StellaKeyboard";

/** The keyboard's sources, copied into the native project at prebuild. */
export const KEYBOARD_EXTENSION_FOLDER = "keyboard-extension";

/** What the keyboard and the app say to each other; the prebuild copies it into the keyboard. */
export const KEYBOARD_BRIDGE =
  "modules/keyboard-dictation/ios/KeyboardDictationBridge.swift";

/** The catalogs whose `keyboard` messages the keyboard shows, compiled into it. */
const KEYBOARD_CATALOGS = "src/i18n/langs";

/** The app route the keyboard opens to start a dictation: `src/app/keyboard/dictate.tsx`. */
export const KEYBOARD_DICTATE_ROUTE = "keyboard/dictate";

/** The app route that sets the keyboard up: `src/app/keyboard/setup.tsx`. */
export const KEYBOARD_SETUP_ROUTE = "keyboard/setup";

/**
 * Signs the app target, and only it, with the release profile. Passed to
 * `xcodebuild`, the same settings would reach every CocoaPods target too, and
 * a resource bundle refuses a provisioning profile.
 */
const withReleaseSigning: ConfigPlugin<ReleaseSigning> = (
  config,
  {
    keyboardProfileUuid,
    profileUuid,
    shareProfileUuid,
    teamId,
    widgetsProfileUuid,
  },
) =>
  withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const sign = (buildConfigurationList: string, profile: string) => {
      for (const [
        ,
        configuration,
      ] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
        project,
        buildConfigurationList,
      )) {
        Object.assign(configuration.buildSettings, {
          CODE_SIGN_IDENTITY: '"Apple Distribution"',
          CODE_SIGN_STYLE: "Manual",
          DEVELOPMENT_TEAM: teamId,
          PROVISIONING_PROFILE_SPECIFIER: `"${profile}"`,
        });
      }
    };
    const [, target] = IOSConfig.Target.findFirstNativeTarget(project);
    sign(target.buildConfigurationList, profileUuid);
    // Registered before the plugins, this runs after expo-widgets has added
    // its target.
    if (widgetsProfileUuid !== undefined) {
      // Throws when the target is missing, which stops a release that would
      // otherwise ship an unsigned extension.
      const [, widgets] = IOSConfig.Target.findNativeTargetByName(
        project,
        WIDGETS_TARGET,
      );
      sign(widgets.buildConfigurationList, widgetsProfileUuid);
    }
    if (shareProfileUuid !== undefined) {
      // As above: the share target must be there to be signed.
      const [, share] = IOSConfig.Target.findNativeTargetByName(
        project,
        SHARE_TARGET,
      );
      sign(share.buildConfigurationList, shareProfileUuid);
    }
    if (keyboardProfileUuid !== undefined) {
      const [, keyboard] = IOSConfig.Target.findNativeTargetByName(
        project,
        KEYBOARD_TARGET,
      );
      sign(keyboard.buildConfigurationList, keyboardProfileUuid);
    }
    return mod;
  });

type ShareExtension = {
  appGroup: string;
  bundleIdentifier: string;
  displayName: string;
  scheme: string;
};

/**
 * Adds the share extension: its sources copied into the native project, and
 * a target that builds them, embedded in the app. What differs per build
 * (App Group, scheme, name) reaches the extension's Info.plist and
 * entitlements as build settings, so the sources are the same files in
 * every build.
 */
const withShareExtension: ConfigPlugin<ShareExtension> = (config, share) =>
  withXcodeProject(
    withDangerousMod(config, [
      "ios",
      (mod) => {
        copyShareExtension(mod.modRequest);
        return mod;
      },
    ]),
    (mod) => {
      addShareTarget(mod.modResults, {
        ...share,
        buildNumber: mod.ios?.buildNumber ?? "1",
        version: mod.version ?? APP_VERSION,
      });
      return mod;
    },
  );

/** Copies the extension's sources into the native project, replacing any earlier copy. */
export const copyShareExtension = ({
  platformProjectRoot,
  projectRoot,
}: {
  platformProjectRoot: string;
  projectRoot: string;
}) => {
  const destination = path.join(platformProjectRoot, SHARE_TARGET);
  rmSync(destination, { force: true, recursive: true });
  cpSync(path.join(projectRoot, SHARE_EXTENSION_FOLDER), destination, {
    recursive: true,
  });
};

/** The project the Xcode mod hands over, as Expo's own helpers type it (`xcode.d.ts`). */
type XcodeProject = Parameters<typeof IOSConfig.Target.getNativeTargets>[0];

const SHARE_SOURCES = ["ShareViewController.swift"];

/** Adds the share target once; a project that has it is left as it is. */
export const addShareTarget = (
  project: XcodeProject,
  {
    appGroup,
    buildNumber,
    bundleIdentifier,
    displayName,
    scheme,
    version,
  }: ShareExtension & { buildNumber: string; version: string },
) => {
  addExtensionTarget(project, {
    name: SHARE_TARGET,
    bundleIdentifier,
    buildNumber,
    version,
    sources: SHARE_SOURCES,
    settings: {
      STELLA_APP_GROUP: appGroup,
      STELLA_APP_NAME: displayName,
      STELLA_APP_SCHEME: scheme,
      STELLA_SHARE_INBOX: SHARE_INBOX_FOLDER,
      STELLA_SHARE_ROUTE: SHARE_ROUTE,
    },
  });
};

type ExtensionTarget = {
  /** The target's name, its folder in the native project and its files' prefix. */
  name: string;
  bundleIdentifier: string;
  buildNumber: string;
  version: string;
  /** The Swift files in the target's folder. */
  sources: readonly string[];
  /** What differs per build, read by the target's Info.plist and entitlements. */
  settings: Readonly<Record<string, string>>;
};

/**
 * Adds an app extension target, embedded in the app, built from the folder
 * of its name: its sources, `<name>-Info.plist` and `<name>.entitlements`.
 * A project that has the target is left as it is.
 */
const addExtensionTarget = (
  project: XcodeProject,
  {
    buildNumber,
    bundleIdentifier,
    name,
    settings,
    sources,
    version,
  }: ExtensionTarget,
) => {
  if (
    IOSConfig.Target.getNativeTargets(project).some(
      ([, target]) => IOSConfig.XcodeUtils.unquote(target.name) === name,
    )
  ) {
    return;
  }
  const infoPlist = `${name}-Info.plist`;
  // The xcode package reuses a reference with the same file name, and Xcode
  // refuses one file in two groups, so every name here is the target's own.
  const group = project.addPbxGroup(
    [...sources, infoPlist, `${name}.entitlements`],
    name,
    name,
  );
  project.addToPbxGroup(
    group.uuid,
    project.getFirstProject().firstProject.mainGroup,
  );
  // A project of one target lacks the sections a second target's
  // dependency is written into.
  const objects = project.hash.project.objects;
  objects["PBXTargetDependency"] ??= {};
  objects["PBXContainerItemProxy"] ??= {};
  const target = project.addTarget(
    name,
    "app_extension",
    name,
    bundleIdentifier,
  );
  project.addBuildPhase(
    [...sources],
    "PBXSourcesBuildPhase",
    "Sources",
    target.uuid,
  );
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase(
    [],
    "PBXFrameworksBuildPhase",
    "Frameworks",
    target.uuid,
  );
  for (const [
    ,
    configuration,
  ] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
    project,
    target.pbxNativeTarget.buildConfigurationList,
  )) {
    Object.assign(configuration.buildSettings, {
      CLANG_ENABLE_MODULES: "YES",
      CODE_SIGN_ENTITLEMENTS: `"${name}/${name}.entitlements"`,
      CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `"${name}/${infoPlist}"`,
      MARKETING_VERSION: `"${version}"`,
      ...Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [key, `"${value}"`]),
      ),
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: `"1,2"`,
    });
  }
};

type KeyboardExtension = {
  appGroup: string;
  bundleIdentifier: string;
  displayName: string;
  scheme: string;
};

/** The keyboard's own sources, the bridge copied beside them and its generated messages. */
const KEYBOARD_STRINGS_FILE = "KeyboardStrings.swift";
const KEYBOARD_SOURCES = [
  "KeyboardViewController.swift",
  path.basename(KEYBOARD_BRIDGE),
  KEYBOARD_STRINGS_FILE,
];

/** Adds the keyboard extension, as `withShareExtension` adds the share extension. */
const withKeyboardExtension: ConfigPlugin<KeyboardExtension> = (
  config,
  { appGroup, bundleIdentifier, displayName, scheme },
) =>
  withXcodeProject(
    withDangerousMod(config, [
      "ios",
      (mod) => {
        copyKeyboardExtension(mod.modRequest);
        return mod;
      },
    ]),
    (mod) => {
      addExtensionTarget(mod.modResults, {
        name: KEYBOARD_TARGET,
        bundleIdentifier,
        buildNumber: mod.ios?.buildNumber ?? "1",
        version: mod.version ?? APP_VERSION,
        sources: KEYBOARD_SOURCES,
        settings: {
          STELLA_APP_GROUP: appGroup,
          STELLA_APP_NAME: displayName,
          STELLA_APP_SCHEME: scheme,
          STELLA_KEYBOARD_DICTATE_ROUTE: KEYBOARD_DICTATE_ROUTE,
          STELLA_KEYBOARD_SETUP_ROUTE: KEYBOARD_SETUP_ROUTE,
        },
      });
      return mod;
    },
  );

/**
 * Copies the keyboard's sources and the bridge into the native project,
 * replacing any earlier copy, and writes its messages beside them.
 */
export const copyKeyboardExtension = ({
  platformProjectRoot,
  projectRoot,
}: {
  platformProjectRoot: string;
  projectRoot: string;
}) => {
  const destination = path.join(platformProjectRoot, KEYBOARD_TARGET);
  rmSync(destination, { force: true, recursive: true });
  cpSync(path.join(projectRoot, KEYBOARD_EXTENSION_FOLDER), destination, {
    recursive: true,
  });
  cpSync(
    path.join(projectRoot, KEYBOARD_BRIDGE),
    path.join(destination, path.basename(KEYBOARD_BRIDGE)),
  );
  writeFileSync(
    path.join(destination, KEYBOARD_STRINGS_FILE),
    keyboardStringsSwift(readKeyboardStrings(projectRoot)),
  );
};

/** Each catalog's `keyboard` messages, by locale. */
export const readKeyboardStrings = (
  projectRoot: string,
): Record<string, Record<string, string>> => {
  const folder = path.join(projectRoot, KEYBOARD_CATALOGS);
  return Object.fromEntries(
    readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => {
        const catalog: unknown = JSON.parse(
          readFileSync(path.join(folder, name), "utf-8"),
        );
        const messages =
          typeof catalog === "object" &&
          catalog !== null &&
          "keyboard" in catalog
            ? catalog.keyboard
            : undefined;
        if (typeof messages !== "object" || messages === null) {
          return panic(`${name} has no keyboard messages`);
        }
        return [
          path.basename(name, ".json"),
          Object.fromEntries(
            Object.entries(messages).map(([key, value]) =>
              typeof value === "string"
                ? [key, value]
                : panic(`${name}: keyboard.${key} is not a message`),
            ),
          ),
        ];
      }),
  );
};

/** A Swift string literal of `value`: no interpolation, every control character escaped. */
const swiftLiteral = (value: string) =>
  `"${value.replaceAll(/[\\"\p{Cc}]/gu, (character) =>
    character === "\\" || character === '"'
      ? `\\${character}`
      : `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  )}"`;

/**
 * The keyboard's messages as Swift: one property per message, so a message
 * the keyboard names and the catalogs lack fails its build, and every
 * locale the app ships, picked by the person's languages as iOS lists them.
 */
export const keyboardStringsSwift = (
  catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string => {
  const source =
    catalogs["en"] ?? panic("The keyboard needs the English catalog");
  const keys = Object.keys(source).toSorted();
  const instance = (
    locale: string,
    messages: Readonly<Record<string, string>>,
  ) =>
    [
      "KeyboardStrings(",
      keys
        .map(
          (key) =>
            `      ${key}: ${swiftLiteral(messages[key] ?? panic(`${locale} lacks keyboard.${key}`))}`,
        )
        .join(",\n"),
      "    )",
    ].join("\n");
  for (const key of keys) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(key)) {
      return panic(`keyboard.${key} is no Swift name`);
    }
  }
  return [
    "// Generated at prebuild from the app's catalogs (their `keyboard`",
    "// messages): edit those, not this file.",
    "import Foundation",
    "",
    "struct KeyboardStrings {",
    ...keys.map((key) => `  let ${key}: String`),
    "",
    `  static let source = ${instance("en", source)}`,
    "",
    "  static let catalogs: [String: KeyboardStrings] = [",
    ...Object.entries(catalogs).map(
      ([locale, messages]) =>
        `    ${swiftLiteral(locale)}: ${instance(locale, messages)},`,
    ),
    "  ]",
    "",
    "  /// The first of the person's languages the app ships, else English.",
    "  static let current: KeyboardStrings = {",
    "    for preferred in Locale.preferredLanguages {",
    "      if let exact = catalogs[preferred] {",
    "        return exact",
    "      }",
    '      let language = String(preferred.prefix { $0 != "-" })',
    "      if let match = catalogs.first(where: {",
    '        $0.key == language || $0.key.hasPrefix("\\(language)-")',
    "      }) {",
    "        return match.value",
    "      }",
    "    }",
    "    return source",
    "  }()",
    "}",
    "",
  ].join("\n");
};

/**
 * lucide's glyphs for the platform's own bars (the header's buttons, the tab
 * bar) as an asset catalog folder, generated by
 * `scripts/generate-mobile-icons.ts`. UIKit loads an asset catalog image by
 * name, synchronously, as it builds a bar, so a button never stands as its
 * text label while its glyph is drawn. `scripts/fingerprint.ts` hashes the
 * folder, so no update names a glyph a build lacks.
 */
export const BAR_GLYPHS_FOLDER = "assets/bar-glyphs";

/** Copies the bar glyphs into a prebuilt app's asset catalog, replacing any earlier copy. */
export const copyBarGlyphs = (projectRoot: string) => {
  const destination = path.join(
    IOSConfig.Paths.getSourceRoot(projectRoot),
    "Images.xcassets",
    "BarGlyphs",
  );
  rmSync(destination, { force: true, recursive: true });
  cpSync(path.join(projectRoot, BAR_GLYPHS_FOLDER), destination, {
    recursive: true,
  });
};

const withBarGlyphs: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    "ios",
    (mod) => {
      copyBarGlyphs(mod.modRequest.projectRoot);
      return mod;
    },
  ]);

/** CocoaPods owns the widget bundle phase; keep its entry point in the app. */
export const WIDGETS_BUNDLE_HOOK = `
post_integrate do |installer|
  phases = installer.pods_project.targets.flat_map(&:shell_script_build_phases).select do |phase|
    phase.name == '[CP-User] Build ExpoWidgets Bundle'
  end
  raise 'ExpoWidgets bundle phase missing' if phases.empty?
  phases.each do |phase|
    phase.shell_script = 'bash "$PODS_ROOT/../../scripts/xcode-widget-bundle.sh"'
  end
  installer.pods_project.save
end
`;

export const configureWidgetsPodfile: Parameters<typeof withPodfile>[1] = (
  mod,
) => {
  if (!mod.modResults.contents.includes(WIDGETS_BUNDLE_HOOK)) {
    mod.modResults.contents += WIDGETS_BUNDLE_HOOK;
  }
  return mod;
};

const withWidgetsBundle: ConfigPlugin = (config) =>
  withPodfile(config, configureWidgetsPodfile);

/** stella's API, whose update route relays the signed updates every build runs. */
const UPDATES_ORIGIN = "https://api.stll.app";

/**
 * The certificate every update must be signed against. Public; its private
 * key exists only in the publish workflow's secrets. Without it a build
 * ships with updates off rather than accepting unsigned ones.
 */
export const UPDATE_SIGNING_CERTIFICATE = "./certs/mobile-update-signing.pem";

const updatesFor = (
  variant: Variant,
  signingCertificatePresent: boolean,
): NonNullable<ExpoConfig["updates"]> =>
  variant === "development" || !signingCertificatePresent
    ? { enabled: false }
    : {
        enabled: true,
        url: `${UPDATES_ORIGIN}/v1/mobile/updates/${variant}`,
        checkAutomatically: "ON_LOAD",
        // Launch on the bundle at hand; a downloaded update runs next launch.
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: UPDATE_SIGNING_CERTIFICATE,
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      };

type AppConfigInputs = {
  buildNumber: number;
  /**
   * Whether the build carries the stella keyboard, which needs the App
   * Group in the app's profile and a profile of its own.
   */
  keyboardExtension: boolean;
  /**
   * Whether the build carries the widget extension that draws Live
   * Activities. A release signs the app target alone, so it leaves the
   * extension out until the release signs that too.
   */
  liveActivities: boolean;
  /**
   * Whether the build carries the push entitlement, which a release profile
   * must grant; releases take it with the profiles that grant both.
   */
  pushNotifications: boolean;
  /** The native fingerprint (`scripts/fingerprint.ts`); updates target it. */
  runtimeVersion: string;
  /**
   * Whether the build carries the share extension, which needs the App
   * Group in the app's profile and a profile of its own.
   */
  shareExtension: boolean;
  signingCertificatePresent: boolean;
  variant: Variant;
};

/** The App Group the app shares with its extensions. */
const appGroupFor = (variant: Variant) =>
  `group.${VARIANT_CONFIG[variant].identifier}`;

const appConfigBase = ({
  buildNumber,
  keyboardExtension,
  liveActivities,
  pushNotifications,
  runtimeVersion,
  shareExtension,
  signingCertificatePresent,
  variant,
}: AppConfigInputs): ExpoConfig => ({
  name: VARIANT_CONFIG[variant].name,
  slug: "stella",
  version: APP_VERSION,
  orientation: "default",
  scheme: VARIANT_CONFIG[variant].scheme,
  // The web's favicon edge to edge (`scripts/generate-mobile-app-icon.ts`).
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: VARIANT_CONFIG[variant].identifier,
    buildNumber: String(buildNumber),
    supportsTablet: true,
    // The app's only cryptography is HTTPS and the platform keychain, which
    // are exempt; declaring it spares every TestFlight upload the question.
    config: { usesNonExemptEncryption: false },
    // What the App Store's privacy report and review read. The app tracks no
    // one and carries no analytics; it keeps the account's email and name and
    // what the person writes, scans and uploads, all to run the app. The
    // reasons are the platform APIs React Native and Expo call for the app
    // itself: settings it stores, file dates and free disk space it reads
    // for its own files, and the system clock it measures time with.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [
        ...[
          "NSPrivacyCollectedDataTypeEmailAddress",
          "NSPrivacyCollectedDataTypeName",
          "NSPrivacyCollectedDataTypeOtherUserContent",
        ].map((type) => ({
          NSPrivacyCollectedDataType: type,
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: [
            "NSPrivacyCollectedDataTypePurposeAppFunctionality",
          ],
        })),
      ],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
          NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
          NSPrivacyAccessedAPITypeReasons: ["0A2A.1", "3B52.1", "C617.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
          NSPrivacyAccessedAPITypeReasons: ["E174.1", "85F4.1"],
        },
        {
          NSPrivacyAccessedAPIType:
            "NSPrivacyAccessedAPICategorySystemBootTime",
          NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
        },
      ],
    },
    infoPlist: {
      // The document camera (modules/document-scanner) scans paper into a
      // matter's documents.
      NSCameraUsageDescription:
        "stella scans paper documents with the camera to add them to a matter.",
      // iOS runs an app only in a language its bundle declares: without the
      // list the app's locale is English on every phone, so the catalogs it
      // ships for the device's language never load.
      CFBundleLocalizations: [...UI_LOCALES],
    },
    // The share extension hands what was shared over in the App Group, and
    // the keyboard talks to the app there.
    ...(shareExtension || keyboardExtension
      ? {
          entitlements: {
            "com.apple.security.application-groups": [appGroupFor(variant)],
          },
        }
      : {}),
  },
  android: {
    package: VARIANT_CONFIG[variant].identifier,
    versionCode: buildNumber,
    predictiveBackGestureEnabled: false,
  },
  web: {
    bundler: "metro",
    output: "static",
  },
  runtimeVersion,
  updates: updatesFor(variant, signingCertificatePresent),
  plugins: [
    "expo-router",
    // DM Sans, the web's typeface, embedded in the build.
    [
      "expo-font",
      {
        fonts: [
          "@expo-google-fonts/dm-sans/300Light/DMSans_300Light.ttf",
          "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
          "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
          "@expo-google-fonts/dm-sans/600SemiBold/DMSans_600SemiBold.ttf",
          "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
        ],
      },
    ],
    // The composer's microphone dictates a message
    // (src/components/use-dictation.ts). A dictation the person started goes
    // on while the screen is locked or another app is open, until they
    // finish it or it reaches its limit (background audio mode). The same
    // mode keeps the microphone warm for the stella keyboard
    // (modules/keyboard-dictation).
    [
      "expo-audio",
      {
        microphonePermission:
          "stella records your voice while you dictate, in the app or with the stella keyboard, to type it for you.",
        recordAudioAndroid: true,
        enableBackgroundRecording: true,
      },
    ] satisfies [string, unknown],
    // Notifications from the server: mentions, approvals, finished exports
    // (src/components/push-registration.tsx).
    ...(pushNotifications
      ? [
          [
            "expo-notifications",
            { mode: variant === "development" ? "development" : "production" },
          ] satisfies [string, unknown],
        ]
      : []),
    // A running timer on the Lock Screen and in the Dynamic Island
    // (src/widgets/timer-activity.ios.tsx). With the push entitlement the
    // activity takes tokens, so a timer changed on another device reaches it.
    ...(liveActivities
      ? [
          [
            "expo-widgets",
            {
              bundleIdentifier: `${VARIANT_CONFIG[variant].identifier}.widgets`,
              groupIdentifier: appGroupFor(variant),
              enablePushNotifications: pushNotifications,
            },
          ] satisfies [string, unknown],
        ]
      : []),
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    liveActivities,
    pushNotifications,
    // The App Group the app and the stella keyboard share; null in a build
    // without the keyboard.
    keyboardDictation: keyboardExtension
      ? { appGroup: appGroupFor(variant) }
      : null,
    // Where the app reads what the share extension hands over; null in a
    // build without the extension.
    shareInbox: shareExtension
      ? { appGroup: appGroupFor(variant), folder: SHARE_INBOX_FOLDER }
      : null,
    variant,
  },
});

export const appConfigFor = ({
  signing,
  ...inputs
}: Omit<
  AppConfigInputs,
  | "keyboardExtension"
  | "liveActivities"
  | "pushNotifications"
  | "shareExtension"
> & {
  signing?: ReleaseSigning | undefined;
}): ExportedConfig => {
  // The widgets profile comes with the profiles regenerated for the App
  // Group and push capabilities, so it stands for both.
  const storeCapabilities =
    signing === undefined || signing.widgetsProfileUuid !== undefined;
  // `readSigning` takes a share profile only beside the widgets profile.
  const shareExtension =
    signing === undefined || signing.shareProfileUuid !== undefined;
  // And a keyboard profile, likewise.
  const keyboardExtension =
    signing === undefined || signing.keyboardProfileUuid !== undefined;
  const config = withBarGlyphs(
    appConfigBase({
      ...inputs,
      keyboardExtension,
      liveActivities: storeCapabilities,
      pushNotifications: storeCapabilities,
      shareExtension,
    }),
  );
  // The native module is autolinked even when the extension is omitted.
  const bundled = withWidgetsBundle(config);
  const signed =
    signing === undefined ? bundled : withReleaseSigning(bundled, signing);
  const { identifier, name, scheme } = VARIANT_CONFIG[inputs.variant];
  // Registered after the release signing, so their targets exist by the
  // time the signing's mod runs.
  const shared = shareExtension
    ? withShareExtension(signed, {
        appGroup: appGroupFor(inputs.variant),
        bundleIdentifier: `${identifier}.share`,
        displayName: name,
        scheme,
      })
    : signed;
  return keyboardExtension
    ? withKeyboardExtension(shared, {
        appGroup: appGroupFor(inputs.variant),
        bundleIdentifier: `${identifier}.keyboard`,
        displayName: name,
        scheme,
      })
    : shared;
};

/** `APP_VARIANT`: `development` (default), `preview` or `production`. */
const readVariant = (value: string | undefined): Variant =>
  value === undefined
    ? "development"
    : (VARIANTS.find((variant) => variant === value) ??
      panic(`APP_VARIANT must be one of ${VARIANTS.join(", ")}`));

/** `MOBILE_BUILD_NUMBER`: the store build number; the release workflow passes its run number plus 100. */
const readBuildNumber = (value: string | undefined): number => {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : panic("MOBILE_BUILD_NUMBER must be a positive integer");
};

/**
 * `APPLE_TEAM_ID` and `MOBILE_PROFILE_UUID`: both or neither; with them,
 * `MOBILE_WIDGETS_PROFILE_UUID` when the release also signs the Live
 * Activity extension, and beside it `MOBILE_SHARE_PROFILE_UUID` and
 * `MOBILE_KEYBOARD_PROFILE_UUID` when the release also signs the share
 * extension and the keyboard.
 */
const readSigning = ({
  keyboardProfileUuid,
  profileUuid,
  shareProfileUuid,
  teamId,
  widgetsProfileUuid,
}: {
  keyboardProfileUuid: string | undefined;
  profileUuid: string | undefined;
  shareProfileUuid: string | undefined;
  teamId: string | undefined;
  widgetsProfileUuid: string | undefined;
}): ReleaseSigning | undefined => {
  if (shareProfileUuid !== undefined && widgetsProfileUuid === undefined) {
    return panic(
      "MOBILE_SHARE_PROFILE_UUID signs only beside MOBILE_WIDGETS_PROFILE_UUID",
    );
  }
  if (keyboardProfileUuid !== undefined && widgetsProfileUuid === undefined) {
    return panic(
      "MOBILE_KEYBOARD_PROFILE_UUID signs only beside MOBILE_WIDGETS_PROFILE_UUID",
    );
  }
  if (teamId === undefined && profileUuid === undefined) {
    return widgetsProfileUuid === undefined
      ? undefined
      : panic("MOBILE_WIDGETS_PROFILE_UUID signs only alongside a release");
  }
  return teamId !== undefined && profileUuid !== undefined
    ? {
        keyboardProfileUuid,
        profileUuid,
        shareProfileUuid,
        teamId,
        widgetsProfileUuid,
      }
    : panic("APPLE_TEAM_ID and MOBILE_PROFILE_UUID sign a release together");
};

/** A release workflow's setting; Node's environment holds only strings. */
const readEnv = (name: string): string | undefined => {
  const value: unknown = process.env[name];
  return typeof value === "string" ? value : undefined;
};

const appConfig = ({ projectRoot }: ConfigContext): ExpoConfig =>
  appConfigFor({
    buildNumber: readBuildNumber(readEnv("MOBILE_BUILD_NUMBER")),
    // The release workflows stamp the fingerprint. A build made without one
    // names no published runtime, so no update ever reaches it.
    runtimeVersion: readEnv("MOBILE_RUNTIME_VERSION") ?? "unpublished",
    signing: readSigning({
      keyboardProfileUuid: readEnv("MOBILE_KEYBOARD_PROFILE_UUID"),
      profileUuid: readEnv("MOBILE_PROFILE_UUID"),
      shareProfileUuid: readEnv("MOBILE_SHARE_PROFILE_UUID"),
      teamId: readEnv("APPLE_TEAM_ID"),
      widgetsProfileUuid: readEnv("MOBILE_WIDGETS_PROFILE_UUID"),
    }),
    signingCertificatePresent: existsSync(
      path.join(projectRoot, UPDATE_SIGNING_CERTIFICATE),
    ),
    variant: readVariant(readEnv("APP_VARIANT")),
  });

export default appConfig;
