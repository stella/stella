import { describe, expect, test } from "bun:test";

import { hasPostHogProject, shouldEnablePostHog } from "./index";

describe("hasPostHogProject", () => {
  test("rejects the placeholder key", () => {
    expect(
      hasPostHogProject({
        host: "https://eu.i.posthog.com",
        key: "phc_",
      }),
    ).toBeFalse();
  });

  test("rejects a missing host", () => {
    expect(
      hasPostHogProject({
        host: "",
        key: "phc_real_key",
      }),
    ).toBeFalse();
  });

  test("accepts a real key and host", () => {
    expect(
      hasPostHogProject({
        host: "https://eu.i.posthog.com",
        key: "phc_real_key",
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

  test("stays off in production without a real project", () => {
    expect(
      shouldEnablePostHog({
        key: "phc_",
        host: "https://eu.i.posthog.com",
        isDev: false,
        localDebug: false,
      }),
    ).toBeFalse();
  });
});
