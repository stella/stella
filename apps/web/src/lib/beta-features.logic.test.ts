import { describe, expect, test } from "bun:test";

import { previewRouteAvailable } from "@/lib/beta-features.logic";

describe("preview route availability", () => {
  test("requires an explicit browser opt-in outside enabled deployments and beta hosts", () => {
    expect(
      previewRouteAvailable({
        browserPreviewEnabled: false,
        deploymentEnabled: false,
        hostDefaultEnabled: false,
      }),
    ).toBe(false);
    expect(
      previewRouteAvailable({
        browserPreviewEnabled: true,
        deploymentEnabled: false,
        hostDefaultEnabled: false,
      }),
    ).toBe(true);
  });

  test("keeps deployment and beta-host previews available during SSR", () => {
    expect(
      previewRouteAvailable({
        browserPreviewEnabled: false,
        deploymentEnabled: true,
        hostDefaultEnabled: false,
      }),
    ).toBe(true);
    expect(
      previewRouteAvailable({
        browserPreviewEnabled: false,
        deploymentEnabled: false,
        hostDefaultEnabled: true,
      }),
    ).toBe(true);
  });
});
