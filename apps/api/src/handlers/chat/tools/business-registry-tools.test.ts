import { describe, expect, test } from "bun:test";

import {
  BUSINESS_REGISTRY_LOOKUP_TOOL_NAME,
  createBusinessRegistryTools,
} from "./business-registry-tools.js";

type ToolInputJsonSchema = {
  jsonSchema: {
    properties?: {
      query?: {
        description?: string;
      };
    };
  };
};

const hasToolInputJsonSchema = (
  schema: unknown,
): schema is ToolInputJsonSchema =>
  typeof schema === "object" && schema !== null && "jsonSchema" in schema;

describe("createBusinessRegistryTools", () => {
  test("does not register the tool when no jurisdictions are enabled", () => {
    const tools = createBusinessRegistryTools({ enabledJurisdictions: [] });
    expect(BUSINESS_REGISTRY_LOOKUP_TOOL_NAME in tools).toBe(false);
  });

  test("registers business_registry_lookup when at least one jurisdiction is enabled", () => {
    const tools = createBusinessRegistryTools({
      enabledJurisdictions: ["CZ"],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("registers the tool with multiple jurisdictions in the picklist", () => {
    const tools = createBusinessRegistryTools({
      enabledJurisdictions: ["CZ", "NO"],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("accepts the EU pseudo-jurisdiction (VIES)", () => {
    const tools = createBusinessRegistryTools({
      enabledJurisdictions: ["EU"],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("tells the model which enabled registries require canonical identifiers", () => {
    const tools = createBusinessRegistryTools({
      enabledJurisdictions: ["US", "EU", "CZ"],
    });
    const lookupTool = tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME];

    expect(lookupTool?.description).toContain("US/EDGAR requires the SEC CIK");
    expect(lookupTool?.description).toContain(
      "EU/VIES requires a fully-qualified VAT number",
    );
    expect(lookupTool?.description).not.toContain("CZ/ARES");
    if (!lookupTool || !hasToolInputJsonSchema(lookupTool.inputSchema)) {
      throw new Error("Expected lookup tool JSON schema");
    }
    expect(
      lookupTool.inputSchema.jsonSchema.properties?.query?.description,
    ).toContain("Ask the user for the canonical identifier");
  });
});
