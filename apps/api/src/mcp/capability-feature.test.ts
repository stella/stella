import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { env } from "@/api/env";
import { isCapabilityFeatureEnabled } from "@/api/mcp/capability-feature";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

describe("capability deployment admission", () => {
  test("an untagged capability is always enabled", () => {
    expect(isCapabilityFeatureEnabled(undefined)).toBe(true);
  });

  test.each([RUNTIME_MODE.strict, RUNTIME_MODE.open])(
    "a capability follows the canonical deployment policy in %s mode",
    (mode) => {
      const restore = setRuntimeModeForTesting({ mode });
      try {
        testState.setConfig("FEATURE_PUBLIC_LAW", false);
        testState.setConfig("FEATURE_WEB_SEARCH", false);
        expect(isCapabilityFeatureEnabled("FEATURE_PUBLIC_LAW")).toBe(
          mode === RUNTIME_MODE.open,
        );
        expect(isCapabilityFeatureEnabled("FEATURE_WEB_SEARCH")).toBe(false);

        testState.setConfig("FEATURE_PUBLIC_LAW", true);
        testState.setConfig("FEATURE_WEB_SEARCH", true);
        expect(isCapabilityFeatureEnabled("FEATURE_PUBLIC_LAW")).toBe(true);
        expect(isCapabilityFeatureEnabled("FEATURE_WEB_SEARCH")).toBe(true);

        expect(isCapabilityFeatureEnabled("FEATURE_NO_SUCH_FLAG")).toBe(false);
        expect(isCapabilityFeatureEnabled("localDevOpen")).toBe(false);
        expect(isCapabilityFeatureEnabled("")).toBe(false);
      } finally {
        restore();
      }
    },
  );
});
