// Push notifications for the stella mobile app: how the app registers the
// device it runs on, and what an alert it receives carries.
//
// Alerts travel through Apple, so they never carry privileged content: the
// text is a fixed sentence per notification kind, in the device's language,
// and the data names only opaque ids the app resolves through the API after
// the person opens it.

import * as v from "valibot";

import {
  NOTIFICATION_ENTITY_TYPES,
  NOTIFICATION_KIND,
  NOTIFICATION_KINDS,
} from "./notifications";
import type { NotificationEntityType, NotificationKind } from "./notifications";

/** Platforms a device can register for. Android joins with its own sender. */
export const PUSH_DEVICE_PLATFORMS = ["ios"] as const;
export type PushDevicePlatform = (typeof PUSH_DEVICE_PLATFORMS)[number];

/**
 * Which APNs gateway serves the device: a development build holds a sandbox
 * token, a TestFlight or App Store build a production one. A token sent to
 * the other gateway is refused as a bad token.
 */
export const APNS_ENVIRONMENTS = ["sandbox", "production"] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/**
 * The app's bundle ids, one per build variant (`apps/mobile/app.config.ts`).
 * A registration names the build it came from, which is the APNs topic its
 * alerts are addressed to; nothing else may be named, so a registration cannot
 * point stella's signing key at another app.
 */
export const MOBILE_APP_BUNDLE_IDS = [
  "app.stll.mobile.dev",
  "app.stll.mobile.preview",
  "app.stll.mobile",
] as const;
export type MobileAppBundleId = (typeof MOBILE_APP_BUNDLE_IDS)[number];

/** How many devices one person may keep registered; the oldest go first. */
export const PUSH_DEVICES_PER_USER_MAX = 10;

/**
 * An APNs device token as lowercase hex. Apple issues 32 bytes today and
 * reserves the right to lengthen them, so up to 100 bytes is accepted.
 */
export const PUSH_DEVICE_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){32,100}$/u;

export const pushDeviceTokenSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.regex(PUSH_DEVICE_TOKEN_PATTERN, "Expected an APNs device token in hex."),
);

const PUSH_DEVICE_LOCALE_MAX_LENGTH = 35;
const PUSH_DEVICE_APP_VERSION_MAX_LENGTH = 64;

/** `PUT /v1/me/push-devices`: register this device, or refresh it. */
export const pushDeviceRegistrationSchema = v.strictObject({
  platform: v.picklist(PUSH_DEVICE_PLATFORMS),
  token: pushDeviceTokenSchema,
  environment: v.picklist(APNS_ENVIRONMENTS),
  bundleId: v.picklist(MOBILE_APP_BUNDLE_IDS),
  appVersion: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(PUSH_DEVICE_APP_VERSION_MAX_LENGTH),
    v.regex(/^[\w.+() -]+$/u, "Expected an app version such as 1.4.0 (212)."),
  ),
  /** The device's preferred language as a BCP 47 tag (`cs`, `en-GB`). */
  locale: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(2),
    v.maxLength(PUSH_DEVICE_LOCALE_MAX_LENGTH),
    v.regex(
      /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/u,
      "Expected a BCP 47 language tag.",
    ),
  ),
});

export type PushDeviceRegistration = v.InferOutput<
  typeof pushDeviceRegistrationSchema
>;

/** A registered device, as the registration answers it. */
export type PushDevice = {
  platform: PushDevicePlatform;
  token: string;
  environment: ApnsEnvironment;
  bundleId: MobileAppBundleId;
  appVersion: string;
  locale: string;
  createdAt: string;
  lastSeenAt: string;
};

export type PushDeviceRegistrationResponse = { device: PushDevice };

/**
 * `DELETE /v1/me/push-devices/:token`, sent on sign-out. Removing a device
 * that is not registered succeeds with `removed: false`, so a retried
 * sign-out never fails.
 */
export type PushDeviceRemovalResponse = { removed: boolean };

/**
 * The notifications that reach a phone: those that ask something of the
 * person. Exports, finished or failed runs and announcements stay in the
 * app's inbox, so a phone buzzes only when someone needs them.
 */
export const MOBILE_PUSH_KINDS = [
  NOTIFICATION_KIND.MENTION,
  NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL,
] as const satisfies readonly NotificationKind[];

export const isMobilePushKind = (kind: NotificationKind): boolean =>
  (MOBILE_PUSH_KINDS as readonly NotificationKind[]).includes(kind);

/** The key the stella data sits under in an APNs payload, beside `aps`. */
export const MOBILE_PUSH_DATA_KEY = "stella" as const;

/** Version of {@link MobilePushData}; the app ignores versions it does not know. */
export const MOBILE_PUSH_DATA_VERSION = 1 as const;

/**
 * What the app needs to open the notification: opaque ids only. The app reads
 * the notification itself through the API, which applies the person's current
 * access, before it shows anything.
 */
export type MobilePushData = {
  v: typeof MOBILE_PUSH_DATA_VERSION;
  kind: NotificationKind;
  notificationId: string;
  organizationId: string;
  workspaceId: string | null;
  entityType: NotificationEntityType | null;
  entityId: string | null;
};

export type MobilePushPayload = {
  aps: {
    alert: { body: string };
    sound: "default";
    /** The person's unread notifications in this organization. */
    badge?: number;
  };
  [MOBILE_PUSH_DATA_KEY]: MobilePushData;
};

/** Reads {@link MobilePushData} from a received payload's custom data. */
export const mobilePushDataSchema = v.object({
  v: v.literal(MOBILE_PUSH_DATA_VERSION),
  kind: v.picklist(NOTIFICATION_KINDS),
  notificationId: v.pipe(v.string(), v.minLength(1)),
  organizationId: v.pipe(v.string(), v.minLength(1)),
  workspaceId: v.nullable(v.pipe(v.string(), v.minLength(1))),
  entityType: v.nullable(v.picklist(NOTIFICATION_ENTITY_TYPES)),
  entityId: v.nullable(v.pipe(v.string(), v.minLength(1))),
});
