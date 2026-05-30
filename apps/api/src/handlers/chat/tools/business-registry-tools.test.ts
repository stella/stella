import { describe, expect, test } from "bun:test";

import {
  BUSINESS_REGISTRY_LOOKUP_TOOL_NAME,
  createBusinessRegistryTools,
} from "./business-registry-tools.js";

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
});
