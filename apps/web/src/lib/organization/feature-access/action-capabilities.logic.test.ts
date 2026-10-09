import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { resolveActionCapabilities } from "./action-capabilities.logic";
import type {
  Capability,
  CapabilityReason,
  CapabilitySettingsRoute,
} from "./action-capabilities.logic";

const cases = {
  ai: { reason: "aiMissing", route: "/settings/organization/ai" },
  deepl: { reason: "deeplMissing", route: "/settings/organization/ai" },
  translation: {
    reason: "translationMissing",
    route: "/settings/organization/ai",
  },
  ocr: { reason: "ocrUnavailable", route: "/settings/organization/ai" },
  desktop: { reason: "desktopUnavailable", route: "/settings/account/desktop" },
  verification: {
    reason: "featureUnavailable",
    route: "/settings/account/beta",
  },
  legalLists: { reason: "featureUnavailable", route: "/settings/account/beta" },
} as const satisfies Record<
  Capability,
  { reason: CapabilityReason; route: CapabilitySettingsRoute }
>;
const observedDesktop = (enabled: boolean | undefined) => {
  if (enabled === undefined) {
    return undefined;
  }
  return enabled ? ("current" as const) : ("none" as const);
};
const observations = (enabled: boolean | undefined) => ({
  role: "member",
  ai: enabled,
  deepl: enabled,
  ocr: enabled,
  desktop: observedDesktop(enabled),
  settings:
    enabled === undefined
      ? undefined
      : {
          capabilities: {
            "legal-lists": {
              status: enabled ? ("enabled" as const) : ("hidden" as const),
            },
            "list-verification": {
              status: enabled ? ("enabled" as const) : ("hidden" as const),
            },
          },
          declaredFeatureIds: ["legal-lists", "list-verification"],
          deploymentFeatures: { legalLists: enabled },
        },
});
for (const [capability, expected] of Object.entries(cases)) {
  describe(`${capability} admission`, () => {
    test("explicitly available prerequisites admit the flow", () => {
      expect(
        Object.entries(
          resolveActionCapabilities(observations(true)).capabilities,
        )
          .find(([key]) => key === capability)
          ?.at(1),
      ).toEqual({ type: "available" });
    });
    test("missing and unknown prerequisites deny with the precise settings destination", () => {
      expect(
        Object.entries(
          resolveActionCapabilities(observations(false)).capabilities,
        )
          .find(([key]) => key === capability)
          ?.at(1),
      ).toEqual({
        type: "unavailable",
        reason: expected.reason,
        settingsLink: expected.route,
      });
      expect(
        Object.entries(
          resolveActionCapabilities(observations(undefined)).capabilities,
        )
          .find(([key]) => key === capability)
          ?.at(1),
      ).toEqual({
        type: "unavailable",
        reason: "availabilityUnknown",
        settingsLink: expected.route,
      });
    });
  });
}
test("only organization owners and administrators receive configuration controls", () => {
  for (const role of [...ORGANIZATION_ROLE_NAMES, "guest", undefined]) {
    expect(
      resolveActionCapabilities({ ...observations(false), role }).role,
    ).toBe(role === "owner" || role === "admin" ? "admin" : "member");
  }
});
test("translation accepts either configured provider but never assumes an unknown provider is available", () => {
  for (const ai of [true, false, undefined]) {
    for (const deepl of [true, false, undefined]) {
      const result = resolveActionCapabilities({
        ...observations(false),
        ai,
        deepl,
      }).capabilities.translation;
      expect(result.type).toBe(
        ai === true || deepl === true ? "available" : "unavailable",
      );
      if (result.type === "unavailable") {
        expect(result.reason).toBe(
          ai === undefined || deepl === undefined
            ? "availabilityUnknown"
            : "translationMissing",
        );
      }
    }
  }
});
