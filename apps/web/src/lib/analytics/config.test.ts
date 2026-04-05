import { describe, expect, it } from "bun:test";

import { hasPostHogConfig } from "@/lib/analytics/config";

describe("hasPostHogConfig", () => {
  it("returns false for the local placeholder key", () => {
    expect(
      hasPostHogConfig({
        host: "https://eu.i.posthog.com",
        key: "phc_",
      }),
    ).toBeFalse();
  });

  it("returns false when the host is missing", () => {
    expect(
      hasPostHogConfig({
        host: "",
        key: "phc_real_key",
      }),
    ).toBeFalse();
  });

  it("returns true for a real key and host", () => {
    expect(
      hasPostHogConfig({
        host: "https://eu.i.posthog.com",
        key: "phc_real_key",
      }),
    ).toBeTrue();
  });
});
