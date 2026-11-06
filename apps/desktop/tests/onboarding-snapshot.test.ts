import { expect, test } from "bun:test";

import {
  isOnboardingSnapshot,
  ONBOARDING_STEPS,
} from "../src/onboarding/onboarding-types";

/** The snapshot the native side serialises, as JSON parses it. */
const nativeSnapshot = (trayLocation: unknown): unknown => ({
  activityAvailable: false,
  activityPermissions: [],
  documentApp: null,
  linked: false,
  mode: { type: "tour" },
  step: "done",
  steps: [...ONBOARDING_STEPS],
  trayLocation,
});

test("a snapshot carries the icon's place on a screen edge, or none", () => {
  for (const location of [
    null,
    { along: 0, edge: "top" },
    { along: 0.78, edge: "top" },
    { along: 1, edge: "bottom" },
    { along: 0.5, edge: "left" },
    { along: 0.5, edge: "right" },
  ]) {
    expect(isOnboardingSnapshot(nativeSnapshot(location))).toBe(true);
  }
});

test("a place off its edge or on an unknown edge is refused", () => {
  for (const location of [
    undefined,
    { along: -0.1, edge: "top" },
    { along: 1.1, edge: "bottom" },
    { along: Number.NaN, edge: "top" },
    { along: 0.5, edge: "middle" },
    { along: "0.5", edge: "top" },
    { edge: "top" },
  ]) {
    expect(isOnboardingSnapshot(nativeSnapshot(location))).toBe(false);
  }
});
