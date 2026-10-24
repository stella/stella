import { isCaseLawJurisdiction } from "./case-law-jurisdictions";
import type { CaseLawJurisdiction } from "./case-law-jurisdictions";

export type ProvisionLinkCapability =
  | { type: "supported"; languages: readonly string[] }
  | {
      type: "notSupportedYet";
      reason:
        | "no_profile"
        | "no_multilingual_profile"
        | "language_not_supported"
        | "unknown_jurisdiction";
    };

export const PROVISION_LINK_CAPABILITIES = {
  AUT: { type: "notSupportedYet", reason: "no_profile" },
  CZE: { type: "supported", languages: ["cs"] },
  EU: { type: "notSupportedYet", reason: "no_multilingual_profile" },
  GBR: { type: "notSupportedYet", reason: "no_profile" },
  HUN: { type: "notSupportedYet", reason: "no_profile" },
  POL: { type: "notSupportedYet", reason: "no_profile" },
  SVK: { type: "supported", languages: ["sk"] },
  USA: { type: "notSupportedYet", reason: "no_profile" },
} as const satisfies Record<CaseLawJurisdiction, ProvisionLinkCapability>;

export const provisionLinkCapability = (
  country: string,
  language: string,
): ProvisionLinkCapability => {
  if (!isCaseLawJurisdiction(country)) {
    return { type: "notSupportedYet", reason: "unknown_jurisdiction" };
  }
  const capability = PROVISION_LINK_CAPABILITIES[country];
  if (capability.type === "notSupportedYet") {
    return capability;
  }
  if (!capability.languages.some((supported) => supported === language)) {
    return { type: "notSupportedYet", reason: "language_not_supported" };
  }
  return capability;
};

export type ProvisionPendingCount =
  | {
      type: "available";
      pendingCount: string;
      oldestPendingAt: string | null;
      sampledAt: string;
      revision: number;
      scopeGeneration: number;
    }
  | Extract<ProvisionLinkCapability, { type: "notSupportedYet" }>
  | {
      type: "unavailable";
      reason:
        | "state_not_seeded"
        | "scope_inactive"
        | "revision_unavailable"
        | "read_failed";
      lastSampledAt: string | null;
    };
