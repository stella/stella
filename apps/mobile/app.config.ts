import { panic } from "better-result";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { IOSConfig, withXcodeProject } from "expo/config-plugins";
import type { ConfigPlugin } from "expo/config-plugins";
import { existsSync } from "node:fs";
import path from "node:path";

// Evaluated by Node through Expo's config loader, which cannot follow a
// workspace package's extensionless TypeScript imports; so this file imports
// only npm packages, and `src/architecture.test.ts` pins every value below to
// `@stll/api-contract/mobile-client`.

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
type ReleaseSigning = { profileUuid: string; teamId: string };

/**
 * Signs the app target, and only it, with the release profile. Passed to
 * `xcodebuild`, the same settings would reach every CocoaPods target too, and
 * a resource bundle refuses a provisioning profile.
 */
const withReleaseSigning: ConfigPlugin<ReleaseSigning> = (
  config,
  { profileUuid, teamId },
) =>
  withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const [, target] = IOSConfig.Target.findFirstNativeTarget(project);
    for (const [
      ,
      configuration,
    ] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
      project,
      target.buildConfigurationList,
    )) {
      Object.assign(configuration.buildSettings, {
        CODE_SIGN_IDENTITY: '"Apple Distribution"',
        CODE_SIGN_STYLE: "Manual",
        DEVELOPMENT_TEAM: teamId,
        PROVISIONING_PROFILE_SPECIFIER: `"${profileUuid}"`,
      });
    }
    return mod;
  });

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
): ExpoConfig["updates"] =>
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
  /** The native fingerprint (`scripts/fingerprint.ts`); updates target it. */
  runtimeVersion: string;
  signingCertificatePresent: boolean;
  variant: Variant;
};

const appConfigBase = ({
  buildNumber,
  runtimeVersion,
  signingCertificatePresent,
  variant,
}: AppConfigInputs): ExpoConfig => ({
  name: VARIANT_CONFIG[variant].name,
  slug: "stella",
  version: APP_VERSION,
  orientation: "default",
  scheme: VARIANT_CONFIG[variant].scheme,
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: VARIANT_CONFIG[variant].identifier,
    buildNumber: String(buildNumber),
    supportsTablet: true,
    // The app's only cryptography is HTTPS and the platform keychain, which
    // are exempt; declaring it spares every TestFlight upload the question.
    config: { usesNonExemptEncryption: false },
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
  plugins: ["expo-router"],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: { variant },
});

export const appConfigFor = ({
  signing,
  ...inputs
}: AppConfigInputs & {
  signing?: ReleaseSigning | undefined;
}): ExpoConfig => {
  const config = appConfigBase(inputs);
  return signing === undefined ? config : withReleaseSigning(config, signing);
};

/** `APP_VARIANT`: `development` (default), `preview` or `production`. */
const readVariant = (value: string | undefined): Variant =>
  value === undefined
    ? "development"
    : (VARIANTS.find((variant) => variant === value) ??
      panic(`APP_VARIANT must be one of ${VARIANTS.join(", ")}`));

/** `MOBILE_BUILD_NUMBER`: the store build number; the release workflow passes its run number. */
const readBuildNumber = (value: string | undefined): number => {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : panic("MOBILE_BUILD_NUMBER must be a positive integer");
};

/** `APPLE_TEAM_ID` and `MOBILE_PROFILE_UUID`: both or neither. */
const readSigning = (
  teamId: string | undefined,
  profileUuid: string | undefined,
): ReleaseSigning | undefined => {
  if (teamId === undefined && profileUuid === undefined) {
    return undefined;
  }
  return teamId !== undefined && profileUuid !== undefined
    ? { profileUuid, teamId }
    : panic("APPLE_TEAM_ID and MOBILE_PROFILE_UUID sign a release together");
};

const appConfig = ({ projectRoot }: ConfigContext): ExpoConfig =>
  appConfigFor({
    buildNumber: readBuildNumber(process.env["MOBILE_BUILD_NUMBER"]),
    // The release workflows stamp the fingerprint. A build made without one
    // names no published runtime, so no update ever reaches it.
    runtimeVersion: process.env["MOBILE_RUNTIME_VERSION"] ?? "unpublished",
    signing: readSigning(
      process.env["APPLE_TEAM_ID"],
      process.env["MOBILE_PROFILE_UUID"],
    ),
    signingCertificatePresent: existsSync(
      path.join(projectRoot, UPDATE_SIGNING_CERTIFICATE),
    ),
    variant: readVariant(process.env["APP_VARIANT"]),
  });

export default appConfig;
