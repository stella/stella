import { describe, expect, test } from "bun:test";

import {
  previewRouteAvailable,
  publicShellPreviewEntryVisible,
} from "@/lib/beta-features.logic";

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

describe("public shell preview entry", () => {
  test("shows only the deployment override until the shell mounts", () => {
    expect(
      publicShellPreviewEntryVisible({
        browserPreviewEnabled: true,
        deploymentEnabled: false,
        mounted: false,
      }),
    ).toBe(false);
    expect(
      publicShellPreviewEntryVisible({
        browserPreviewEnabled: false,
        deploymentEnabled: true,
        mounted: false,
      }),
    ).toBe(true);
  });

  test("hands over to the browser opt-in once mounted", () => {
    expect(
      publicShellPreviewEntryVisible({
        browserPreviewEnabled: true,
        deploymentEnabled: false,
        mounted: true,
      }),
    ).toBe(true);
    expect(
      publicShellPreviewEntryVisible({
        browserPreviewEnabled: false,
        deploymentEnabled: false,
        mounted: true,
      }),
    ).toBe(false);
  });
});
