import { describe, expect, test } from "bun:test";

import { desktopPresenceSchema } from "@stll/api-contract/desktop-presence";
import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import {
  isCapabilityActionVisible,
  resolveActionCapabilities,
} from "./action-capabilities.logic";
import type {
  Capability,
  CapabilityReason,
  CapabilitySettingsRoute,
} from "./action-capabilities.logic";

const cases = {
  ai: { reason: "aiMissing", route: "/admin/ai" },
  deepl: { reason: "deeplMissing", route: "/admin/ai" },
  translation: {
    reason: "translationMissing",
    route: "/admin/ai",
  },
  ocr: { reason: "ocrUnavailable", route: "/admin/ai" },
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
const observedOcr = (enabled: boolean | undefined) => {
  if (enabled === undefined) {
    return undefined;
  }
  return enabled
    ? DOCUMENT_OCR_AVAILABILITY.live
    : DOCUMENT_OCR_AVAILABILITY.unconfigured;
};
const observations = (enabled: boolean | undefined) => ({
  role: "member",
  ai: enabled,
  deepl: enabled,
  ocr: observedOcr(enabled),
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
    test("missing prerequisites deny precisely while pending observations stay reserved", () => {
      expect(
        Object.entries(
          resolveActionCapabilities(observations(false)).capabilities,
        )
          .find(([key]) => key === capability)
          ?.at(1),
      ).toEqual(
        capability === "desktop"
          ? { type: "available" }
          : {
              type: "unavailable",
              reason: expected.reason,
              settingsLink: expected.route,
            },
      );
      expect(
        Object.entries(
          resolveActionCapabilities(observations(undefined)).capabilities,
        )
          .find(([key]) => key === capability)
          ?.at(1),
      ).toEqual({ type: "pending" });
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
      let expected: "available" | "pending" | "unavailable" = "unavailable";
      if (ai === true || deepl === true) {
        expected = "available";
      } else if (ai === undefined || deepl === undefined) {
        expected = "pending";
      }
      expect(result.type).toBe(expected);
      if (result.type === "unavailable") {
        expect(result.reason).toBe("translationMissing");
      }
    }
  }
});

test("translation remains available when either provider is ready", () => {
  const error = { status: "error" } as const;
  for (const [ai, deepl, expected] of [
    [true, error, "available"],
    [error, true, "available"],
    [undefined, error, "pending"],
    [false, true, "available"],
  ] as const) {
    expect(
      resolveActionCapabilities({
        ...observations(false),
        ai,
        deepl,
      }).capabilities.translation.type,
    ).toBe(expected);
  }
});

test("OCR admits live and batched deployments and keeps the status for the action", () => {
  for (const status of Object.values(DOCUMENT_OCR_AVAILABILITY)) {
    const resolved = resolveActionCapabilities({
      ...observations(false),
      ocr: status,
    });
    expect(resolved.documentOcr).toBe(status);
    expect(resolved.capabilities.ocr).toEqual(
      status === DOCUMENT_OCR_AVAILABILITY.unconfigured
        ? {
            type: "unavailable",
            reason: "ocrUnavailable",
            settingsLink: "/admin/ai",
          }
        : { type: "available" },
    );
  }
  expect(
    resolveActionCapabilities({ ...observations(false), ocr: undefined })
      .documentOcr,
  ).toBeUndefined();
});

test("every observed desktop state reaches the owning recovery gate", () => {
  for (const option of desktopPresenceSchema.options) {
    const desktop = option.entries.type.literal;
    expect(
      resolveActionCapabilities({ ...observations(false), desktop })
        .capabilities.desktop,
    ).toEqual({ type: "available" });
  }
});

test("capability visibility shares one role and availability policy", () => {
  for (const role of ORGANIZATION_ROLE_NAMES) {
    for (const enabled of [true, false, undefined]) {
      const resolved = resolveActionCapabilities({
        ...observations(enabled),
        role,
      });
      expect(isCapabilityActionVisible({ capability: null }, resolved)).toBe(
        true,
      );
      const isCapability = (value: string): value is Capability =>
        Object.hasOwn(resolved.capabilities, value);
      for (const [capability, availability] of Object.entries(
        resolved.capabilities,
      )) {
        if (!isCapability(capability)) {
          throw new Error("Unexpected capability");
        }
        expect(isCapabilityActionVisible({ capability }, resolved)).toBe(
          availability.type !== "pending" &&
            (resolved.role === "admin" || availability.type === "available"),
        );
      }
    }
  }
});
