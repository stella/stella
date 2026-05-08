import { describe, expect, it } from "bun:test";

import {
  getNativeToolCatalog,
  isMcpConnectorRecommendedForPractice,
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
        iconUrl: "https://ares.gov.cz/logo-ares-new.ico",
        recommendedJurisdictions: ["CZ"],
      }),
    );
  });
});
