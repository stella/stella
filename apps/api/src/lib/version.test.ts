import { beforeEach, describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { resolveStamp } from "@/api/lib/version";

const state = createTestState({ file: import.meta.path, config: {} });

describe("resolveStamp", () => {
  beforeEach(() => {
    state.deleteEnv("RAILWAY_GIT_COMMIT_SHA");
  });

  test("explicit build-arg value wins over the Railway fallback", () => {
    state.setEnv("RAILWAY_GIT_COMMIT_SHA", "railway-sha");
    expect(resolveStamp("v1.2.3")).toBe("v1.2.3");
  });

  test("the Dockerfile default 'dev' defers to the Railway commit SHA", () => {
    state.setEnv("RAILWAY_GIT_COMMIT_SHA", "railway-sha");
    expect(resolveStamp("dev")).toBe("railway-sha");
    expect(resolveStamp(undefined)).toBe("railway-sha");
  });

  test("empty string is treated as absent, not as a version", () => {
    state.setEnv("RAILWAY_GIT_COMMIT_SHA", "railway-sha");
    expect(resolveStamp("")).toBe("railway-sha");

    state.setEnv("RAILWAY_GIT_COMMIT_SHA", "");
    expect(resolveStamp("")).toBe("dev");
  });

  test("falls back to 'dev' outside any release flow", () => {
    expect(resolveStamp(undefined)).toBe("dev");
    expect(resolveStamp("dev")).toBe("dev");
  });
});
