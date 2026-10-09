import type { LinkProps } from "@tanstack/react-router";

import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import type { TranslationKey } from "@/i18n/types";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import type { OrganizationSettings } from "@/queries/organization-settings";

import { callerFeatureEnabled } from "./access.logic";
import { CALLER_FEATURE } from "./surfaces";

export type Capability =
  | "ai"
  | "deepl"
  | "translation"
  | "ocr"
  | "desktop"
  | "verification"
  | "legalLists";
export type CapabilityReason =
  | "aiMissing"
  | "deeplMissing"
  | "translationMissing"
  | "ocrUnavailable"
  | "desktopUnavailable"
  | "featureUnavailable"
  | "availabilityUnknown";
const CAPABILITY_SETTINGS_ROUTES = {
  ai: "/settings/organization/ai",
  desktop: "/settings/account/desktop",
  features: "/settings/account/beta",
} as const satisfies Record<string, NonNullable<LinkProps["to"]>>;
export type CapabilitySettingsRoute =
  (typeof CAPABILITY_SETTINGS_ROUTES)[keyof typeof CAPABILITY_SETTINGS_ROUTES];
export type CapabilityAvailability =
  | { type: "available" }
  | {
      type: "unavailable";
      reason: CapabilityReason;
      settingsLink: CapabilitySettingsRoute;
    };
export type ActionDescriptor = { capability: Capability | null };
export type ActionCapabilities = {
  role: "admin" | "member";
  capabilities: Record<Capability, CapabilityAvailability>;
};
export const CAPABILITY_REASON_KEYS = {
  aiMissing: "capabilityActions.aiMissing",
  deeplMissing: "capabilityActions.deeplMissing",
  translationMissing: "capabilityActions.translationMissing",
  ocrUnavailable: "capabilityActions.ocrUnavailable",
  desktopUnavailable: "capabilityActions.desktopUnavailable",
  featureUnavailable: "capabilityActions.featureUnavailable",
  availabilityUnknown: "capabilityActions.availabilityUnknown",
} as const satisfies Record<CapabilityReason, TranslationKey>;

type ResolveActionCapabilitiesOptions = {
  role: string | undefined;
  ai: boolean | undefined;
  deepl: boolean | undefined;
  ocr: boolean | undefined;
  desktop: DesktopPresence["type"] | undefined;
  settings:
    | Pick<
        OrganizationSettings,
        "capabilities" | "declaredFeatureIds" | "deploymentFeatures"
      >
    | undefined;
};
const availability = (
  enabled: boolean | undefined,
  {
    reason,
    settingsLink,
  }: { reason: CapabilityReason; settingsLink: CapabilitySettingsRoute },
): CapabilityAvailability =>
  enabled === true
    ? { type: "available" }
    : {
        type: "unavailable",
        reason: enabled === undefined ? "availabilityUnknown" : reason,
        settingsLink,
      };

/** Unknown observations never advertise a flow whose prerequisite was not established. */
export const resolveActionCapabilities = ({
  role,
  ai,
  deepl,
  ocr,
  desktop,
  settings,
}: ResolveActionCapabilitiesOptions): ActionCapabilities => ({
  role: hasOrganizationManagementAccess(role) ? "admin" : "member",
  capabilities: {
    ai: availability(ai, {
      reason: "aiMissing",
      settingsLink: CAPABILITY_SETTINGS_ROUTES.ai,
    }),
    deepl: availability(deepl, {
      reason: "deeplMissing",
      settingsLink: CAPABILITY_SETTINGS_ROUTES.ai,
    }),
    translation: availability(
      ai === true || deepl === true || (ai === false && deepl === false)
        ? ai === true || deepl === true
        : undefined,
      {
        reason: "translationMissing",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.ai,
      },
    ),
    ocr: availability(ocr, {
      reason: "ocrUnavailable",
      settingsLink: CAPABILITY_SETTINGS_ROUTES.ai,
    }),
    desktop: availability(
      desktop === undefined ? undefined : desktop === "current",
      {
        reason: "desktopUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.desktop,
      },
    ),
    verification: availability(
      settings === undefined
        ? undefined
        : callerFeatureEnabled(settings, CALLER_FEATURE.verification),
      {
        reason: "featureUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.features,
      },
    ),
    legalLists: availability(
      settings === undefined
        ? undefined
        : callerFeatureEnabled(settings, CALLER_FEATURE.legalLists),
      {
        reason: "featureUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.features,
      },
    ),
  } as const satisfies Record<Capability, CapabilityAvailability>,
});
