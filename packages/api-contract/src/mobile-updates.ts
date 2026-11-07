// Over-the-air updates for the mobile app (the Expo Updates protocol, v1).
//
// A publish job signs each update's manifest with a key only it holds and
// uploads the bundle, its assets, the signed manifest and a per-build
// pointer to the downloads CDN under the layout below. The API's update
// route relays the newest signed manifest for the build that asks; a phone
// runs an update only when the signature verifies against the certificate
// its build embeds. Publisher and route read this module, so the layout
// cannot drift between them.

import type { MobileAppVariant } from "./mobile-client";

/** The route a build asks for updates, followed by its variant. */
export const MOBILE_UPDATES_PATH = "/v1/mobile/updates" as const;

/** The builds that take updates; the development client never does. */
export const MOBILE_UPDATE_VARIANTS = [
  "preview",
  "production",
] as const satisfies readonly MobileAppVariant[];

export const MOBILE_UPDATE_PLATFORMS = ["ios", "android"] as const;

export type MobileUpdatePlatform = (typeof MOBILE_UPDATE_PLATFORMS)[number];

/** A runtime version is the build's native fingerprint (`apps/mobile/scripts/fingerprint.ts`). */
export const MOBILE_RUNTIME_VERSION_PATTERN = /^[0-9a-f]{40}$/u;

/** The key id the signature names; the app's build pins the certificate. */
export const MOBILE_UPDATE_SIGNING_KEY_ID = "main" as const;

export type MobileUpdateTarget = {
  readonly variant: MobileAppVariant;
  readonly platform: MobileUpdatePlatform;
  readonly runtimeVersion: string;
};

/** Everything published for one build, under the CDN's `mobile/` prefix. */
export const mobileUpdatePrefix = ({
  platform,
  runtimeVersion,
  variant,
}: MobileUpdateTarget): string =>
  `mobile/${variant}/${platform}/${runtimeVersion}`;

/** The one mutable object per build: which update is current. */
export const mobileUpdatePointerKey = (target: MobileUpdateTarget): string =>
  `${mobileUpdatePrefix(target)}/latest.json`;

/** An update id: a UUID, as the protocol requires. */
export const MOBILE_UPDATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The pointer names the current update; everything else follows from it. */
export type MobileUpdatePointer = { readonly updateId: string };

/** The exact manifest text the publish job signed; immutable. */
export const mobileUpdateManifestKey = (
  target: MobileUpdateTarget,
  updateId: string,
): string => `${mobileUpdatePrefix(target)}/${updateId}/manifest.json`;

/** The manifest's RSA-SHA256 signature, base64; immutable. */
export const mobileUpdateSignatureKey = (
  target: MobileUpdateTarget,
  updateId: string,
): string => `${mobileUpdatePrefix(target)}/${updateId}/manifest.sig`;

/** Where the update's bundle and assets live, by content hash; immutable. */
export const mobileUpdateAssetKey = (
  target: MobileUpdateTarget,
  updateId: string,
  fileName: string,
): string => `${mobileUpdatePrefix(target)}/${updateId}/assets/${fileName}`;
