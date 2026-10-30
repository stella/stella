import type { LinkProps } from "@tanstack/react-router";
import { panic } from "better-result";

import type { DesktopPresence } from "@stll/api-contract/desktop-presence";
import { acceptsDocumentOcrRequests } from "@stll/api-contract/document-ocr-availability";
import type { DocumentOcrAvailability } from "@stll/api-contract/document-ocr-availability";

import type { TranslationKey } from "@/i18n/types";
import { anyAvailable } from "@/lib/organization/feature-access/availability";
import type { Availability } from "@/lib/organization/feature-access/availability";
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
  ai: "/admin/ai",
  desktop: "/settings/account/desktop",
  features: "/settings/account/beta",
} as const satisfies Record<string, NonNullable<LinkProps["to"]>>;
export type CapabilitySettingsRoute =
  (typeof CAPABILITY_SETTINGS_ROUTES)[keyof typeof CAPABILITY_SETTINGS_ROUTES];
type CapabilityAvailability =
  | { type: "available" }
  | { type: "pending" }
  | { type: "error" }
  | {
      type: "unavailable";
      reason: CapabilityReason;
      settingsLink: CapabilitySettingsRoute;
    };
export type ActionDescriptor = { capability: Capability | null };
export type ActionCapabilities = {
  role: "admin" | "member";
  capabilities: Record<Capability, CapabilityAvailability>;
  /** Whether a worker is live or requests wait for a batch; unknown until observed. */
  documentOcr: DocumentOcrAvailability | undefined;
};
export const isCapabilityActionVisible = (
  action: ActionDescriptor,
  resolved: ActionCapabilities,
): boolean =>
  action.capability === null ||
  (resolved.capabilities[action.capability].type !== "pending" &&
    (resolved.role === "admin" ||
      resolved.capabilities[action.capability].type === "available"));

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
  ai: boolean | undefined | { status: "error" };
  deepl: boolean | undefined | { status: "error" };
  ocr: DocumentOcrAvailability | undefined | { status: "error" };
  desktop: DesktopPresence["type"] | undefined | { status: "error" };
  settings:
    | Pick<
        OrganizationSettings,
        "capabilities" | "declaredFeatureIds" | "deploymentFeatures"
      >
    | undefined
    | { status: "error" };
};
const availability = (
  enabled: boolean | undefined | { status: "error" },
  {
    reason,
    settingsLink,
  }: { reason: CapabilityReason; settingsLink: CapabilitySettingsRoute },
): CapabilityAvailability => {
  if (enabled === undefined) {
    return { type: "pending" };
  }
  if (typeof enabled === "object") {
    return {
      type: "unavailable",
      reason: "availabilityUnknown",
      settingsLink,
    };
  }
  if (enabled) {
    return { type: "available" };
  }
  return { type: "unavailable", reason, settingsLink };
};

type BooleanObservation = boolean | undefined | { status: "error" };
const mapObservation = <T>(
  observation: T | undefined | { status: "error" },
  project: (value: T) => boolean,
): BooleanObservation => {
  if (observation === undefined) {
    return undefined;
  }
  if (
    observation !== null &&
    typeof observation === "object" &&
    "status" in observation
  ) {
    return { status: "error" };
  }
  return project(observation);
};

const translationObservation = (
  ai: BooleanObservation,
  deepl: BooleanObservation,
): BooleanObservation => {
  const toAvailability = (state: BooleanObservation): Availability<void> => {
    if (state === undefined) {
      return { status: "pending" };
    }
    if (typeof state === "object") {
      return { status: "error", error: state };
    }
    return state
      ? { status: "ready", value: undefined }
      : { status: "disabled" };
  };
  const combined = anyAvailable(toAvailability(ai), toAvailability(deepl));
  switch (combined.status) {
    case "ready":
      return true;
    case "disabled":
      return false;
    case "pending":
      return undefined;
    case "error":
      return { status: "error" };
    default:
      combined satisfies never;
      return panic("Unknown translation availability");
  }
};

/** Unknown observations never advertise a flow whose prerequisite was not established. */
export const resolveActionCapabilities = ({
  role,
  ai,
  deepl,
  ocr,
  desktop,
  settings,
}: ResolveActionCapabilitiesOptions): ActionCapabilities => {
  const ocrObservation = mapObservation(ocr, acceptsDocumentOcrRequests);
  const desktopObservation = mapObservation(desktop, () => true);
  const verificationObservation = mapObservation(settings, (value) =>
    callerFeatureEnabled(value, CALLER_FEATURE.verification),
  );
  const legalListsObservation = mapObservation(settings, (value) =>
    callerFeatureEnabled(value, CALLER_FEATURE.legalLists),
  );
  const ocrValue = typeof ocr === "object" && "status" in ocr ? undefined : ocr;
  return {
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
      translation: availability(translationObservation(ai, deepl), {
        reason: "translationMissing",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.ai,
      }),
      ocr: availability(ocrObservation, {
        reason: "ocrUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.ai,
      }),
      // Installation, linking, and updating belong to the desktop action gate.
      desktop: availability(desktopObservation, {
        reason: "desktopUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.desktop,
      }),
      verification: availability(verificationObservation, {
        reason: "featureUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.features,
      }),
      legalLists: availability(legalListsObservation, {
        reason: "featureUnavailable",
        settingsLink: CAPABILITY_SETTINGS_ROUTES.features,
      }),
    } as const satisfies Record<Capability, CapabilityAvailability>,
    documentOcr: ocrValue,
  };
};
