import { describe, expect, test } from "bun:test";

import { featureEnabledIn } from "@/api/mcp/capability-feature";

// The pure core is tested directly (no env/module mocking): the bound
// `isCapabilityFeatureEnabled` only injects the deployment env, and module
// mocks would bleed across test files in the same bun process.

const PROD = {
  isDev: false,
  flags: { FEATURE_TIME_BILLING: true, FEATURE_PUBLIC_LAW: false },
};

describe("featureEnabledIn", () => {
  test("an untagged capability is always enabled", () => {
    expect(featureEnabledIn(undefined, PROD)).toBe(true);
  });

  test("a tagged capability follows its flag", () => {
    expect(featureEnabledIn("FEATURE_TIME_BILLING", PROD)).toBe(true);
    expect(featureEnabledIn("FEATURE_PUBLIC_LAW", PROD)).toBe(false);
  });

  test("dev deployments see everything", () => {
    expect(
      featureEnabledIn("FEATURE_PUBLIC_LAW", { ...PROD, isDev: true }),
    ).toBe(true);
  });

  test("an unknown or malformed flag fails closed", () => {
    // A stale/mistyped flag in the generated artifact must disable, never
    // silently un-gate.
    expect(featureEnabledIn("FEATURE_NO_SUCH_FLAG", PROD)).toBe(false);
    expect(featureEnabledIn("isDev", { ...PROD, flags: { isDev: true } })).toBe(
      false,
    );
    expect(featureEnabledIn("", PROD)).toBe(false);
    // A non-boolean flag value (e.g. the string "true" from a raw env) is not
    // an enabled flag.
    expect(
      featureEnabledIn("FEATURE_X", {
        isDev: false,
        flags: { FEATURE_X: "true" },
      }),
    ).toBe(false);
  });
});
