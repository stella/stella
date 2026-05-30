import { describe, expect, test } from "bun:test";

import { computeCatalogueInstallState } from "@/api/handlers/catalogue/install-state";

const baseOptions = {
  installedMcpUrls: new Set<string>(),
  installedSkillSlugs: new Set<string>(),
  nativeToolBackendSet: new Set(["ares", "web-search"]),
  nativeToolOverrides: {},
  practiceJurisdictions: [],
};

describe("catalogue install state", () => {
  test("marks Web Search unavailable when the deployment has no provider", () => {
    expect(
      computeCatalogueInstallState({
        ...baseOptions,
        entry: {
          backendSlug: "web-search",
          kind: "native-tool",
        },
        nativeToolOverrides: { "web-search": true },
        webSearchDeployAvailable: false,
      }),
    ).toBe("unavailable");
  });

  test("keeps org-disabled Web Search installable when the deployment supports it", () => {
    expect(
      computeCatalogueInstallState({
        ...baseOptions,
        entry: {
          backendSlug: "web-search",
          kind: "native-tool",
        },
        nativeToolOverrides: { "web-search": false },
        webSearchDeployAvailable: true,
      }),
    ).toBe("available");
  });

  test("uses effective native-tool enablement for ordinary native tools", () => {
    expect(
      computeCatalogueInstallState({
        ...baseOptions,
        entry: {
          backendSlug: "ares",
          kind: "native-tool",
        },
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        webSearchDeployAvailable: false,
      }),
    ).toBe("installed");
  });
});
