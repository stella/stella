import { describe, expect, test } from "bun:test";

import {
  hasRealPostHogProject,
  shouldEnablePostHog,
} from "@/api/lib/analytics/config";

describe("hasRealPostHogProject", () => {
  test("rejects the placeholder key", () => {
    expect(
      hasRealPostHogProject({
        key: "phc_",
        host: "https://eu.i.posthog.com",
      }),
    ).toBeFalse();
  });

  test("accepts a real key and host", () => {
    expect(
      hasRealPostHogProject({
        key: "phc_real-project-key",
        host: "https://eu.i.posthog.com",
      }),
    ).toBeTrue();
  });
});

describe("shouldEnablePostHog", () => {
  test("stays disabled in dev without the local debug flag", () => {
    expect(
      shouldEnablePostHog({
        key: "phc_real-project-key",
        host: "https://eu.i.posthog.com",
        isDev: true,
        localDebug: false,
      }),
    ).toBeFalse();
  });

  test("turns on in dev with the local debug flag", () => {
    expect(
      shouldEnablePostHog({
        key: "phc_real-project-key",
        host: "https://eu.i.posthog.com",
        isDev: true,
        localDebug: true,
      }),
    ).toBeTrue();
  });

  test("stays on in production with a real project key", () => {
    expect(
      shouldEnablePostHog({
        key: "phc_real-project-key",
        host: "https://eu.i.posthog.com",
        isDev: false,
        localDebug: false,
      }),
    ).toBeTrue();
  });
});
