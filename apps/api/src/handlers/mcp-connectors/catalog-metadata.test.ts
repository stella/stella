import { describe, expect, it } from "bun:test";

import {
  getDisabledNativeToolSlugs,
  getNativeToolCatalog,
  isMcpConnectorRecommendedForPractice,
  isNativeToolEnabledForOrg,
  mcpConnectorCatalogMetadata,
} from "@/api/handlers/mcp-connectors/catalog-metadata";

describe("mcpConnectorCatalogMetadata", () => {
  it("does not recommend third-party MCP connectors by name alone", () => {
    const connector = {
      slug: "salvia",
      displayName: "Salvia",
      url: "https://mcp.slv.cz/mcp",
    };

    expect(
      mcpConnectorCatalogMetadata(connector).recommendedJurisdictions,
    ).toEqual([]);
    expect(
      isMcpConnectorRecommendedForPractice({
        connector,
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      }),
    ).toBe(false);
    expect(
      isMcpConnectorRecommendedForPractice({
        connector,
        practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
      }),
    ).toBe(false);
  });

  it("does not recommend generic connectors without catalog metadata", () => {
    const connector = {
      slug: "global-legal-search",
      displayName: "Global Legal Search",
      url: "https://example.com/mcp",
    };

    expect(
      isMcpConnectorRecommendedForPractice({
        connector,
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      }),
    ).toBe(false);
  });

  it("recommends built-in ARES for Czech practice", () => {
    const tools = getNativeToolCatalog({
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    });

    expect(tools).toContainEqual(
      expect.objectContaining({
        slug: "ares",
        isRecommended: true,
        recommendedJurisdictions: ["CZ"],
      }),
    );
  });

  it("recommends built-in BOE for Spanish practice", () => {
    const tools = getNativeToolCatalog({
      practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
    });

    expect(tools).toContainEqual(
      expect.objectContaining({
        slug: "boe",
        isRecommended: true,
        recommendedJurisdictions: ["ES"],
      }),
    );
  });

  it("does not recommend BOE outside Spanish practice", () => {
    const tools = getNativeToolCatalog({
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    });

    expect(tools).toContainEqual(
      expect.objectContaining({ slug: "boe", isRecommended: false }),
    );
  });

  it("exposes Brreg as a chat-toggleable native tool", () => {
    const tools = getNativeToolCatalog({
      practiceJurisdictions: [{ countryCode: "NO", isPrimary: true }],
    });

    expect(tools).toContainEqual(
      expect.objectContaining({
        slug: "brreg",
        isRecommended: true,
      }),
    );
  });

  it("shows only native tools that the MCP settings page can toggle", () => {
    const toolSlugs = getNativeToolCatalog({
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    }).map((tool) => tool.slug);

    expect(toolSlugs).toContain("web-search");
    expect(toolSlugs).toContain("brreg");
    expect(toolSlugs).not.toContain("anonymize");
    expect(toolSlugs).not.toContain("create-docx");
  });

  it("hides deploy-unavailable native tools from the MCP settings page", () => {
    const toolSlugs = getNativeToolCatalog({
      nativeToolDeployAvailable: (backendSlug) => backendSlug !== "edgar",
      practiceJurisdictions: [{ countryCode: "US", isPrimary: true }],
    }).map((tool) => tool.slug);

    expect(toolSlugs).not.toContain("edgar");
  });
});

describe("isNativeToolEnabledForOrg", () => {
  it("defaults ARES on for Czech practice", () => {
    expect(
      isNativeToolEnabledForOrg({
        slug: "ares",
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        nativeToolOverrides: {},
      }),
    ).toBe(true);
  });

  it("defaults ARES off when CZ is not in practice jurisdictions", () => {
    expect(
      isNativeToolEnabledForOrg({
        slug: "ares",
        practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
        nativeToolOverrides: {},
      }),
    ).toBe(false);
  });

  it("respects an explicit enable override outside the recommended jurisdiction", () => {
    expect(
      isNativeToolEnabledForOrg({
        slug: "ares",
        practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
        nativeToolOverrides: { ares: true },
      }),
    ).toBe(true);
  });

  it("respects an explicit disable override inside the recommended jurisdiction", () => {
    expect(
      isNativeToolEnabledForOrg({
        slug: "ares",
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        nativeToolOverrides: { ares: false },
      }),
    ).toBe(false);
  });

  it("treats unknown slugs as disabled", () => {
    expect(
      isNativeToolEnabledForOrg({
        slug: "nonexistent",
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        nativeToolOverrides: {},
      }),
    ).toBe(false);
  });

  it("respects explicit disable overrides for globally defaulted Web Search", () => {
    expect(
      isNativeToolEnabledForOrg({
        slug: "web-search",
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        nativeToolOverrides: { "web-search": false },
      }),
    ).toBe(false);
  });
});

describe("getDisabledNativeToolSlugs", () => {
  it("returns ARES for an org with no Czech jurisdiction and no overrides", () => {
    expect(
      getDisabledNativeToolSlugs({
        practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
        nativeToolOverrides: {},
      }),
    ).toContain("ares");
  });

  it("does not disable ARES for an org with Czech jurisdiction", () => {
    expect(
      getDisabledNativeToolSlugs({
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        nativeToolOverrides: {},
      }),
    ).not.toContain("ares");
  });

  it("disables ARES when an explicit override turns it off in-jurisdiction", () => {
    expect(
      getDisabledNativeToolSlugs({
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        nativeToolOverrides: { ares: false },
      }),
    ).toContain("ares");
  });

  it("does not disable ARES when an explicit override turns it on out-of-jurisdiction", () => {
    expect(
      getDisabledNativeToolSlugs({
        practiceJurisdictions: [{ countryCode: "ES", isPrimary: true }],
        nativeToolOverrides: { ares: true },
      }),
    ).not.toContain("ares");
  });
});
