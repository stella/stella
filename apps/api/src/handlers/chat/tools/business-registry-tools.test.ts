import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type { RegistryHandler } from "@/api/lib/business-registries/dispatch";

import {
  BUSINESS_REGISTRY_LOOKUP_TOOL_NAME,
  createBusinessRegistryTools,
} from "./business-registry-tools.js";

type ToolInputJsonSchema = {
  properties?: {
    query?: {
      description?: string;
    };
  };
};

const hasToolInputJsonSchema = (
  schema: unknown,
): schema is ToolInputJsonSchema =>
  typeof schema === "object" && schema !== null && "properties" in schema;

describe("createBusinessRegistryTools", () => {
  test("does not register the tool when no jurisdictions are enabled", () => {
    const tools = createBusinessRegistryTools({ enabledHandlers: [] });
    expect(BUSINESS_REGISTRY_LOOKUP_TOOL_NAME in tools).toBe(false);
  });

  test("registers business_registry_lookup when at least one jurisdiction is enabled", () => {
    const tools = createBusinessRegistryTools({
      enabledHandlers: [BUSINESS_REGISTRY_DISPATCH.ares],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("registers the tool with multiple jurisdictions in the picklist", () => {
    const tools = createBusinessRegistryTools({
      enabledHandlers: [
        BUSINESS_REGISTRY_DISPATCH.ares,
        BUSINESS_REGISTRY_DISPATCH.brreg,
      ],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("accepts the EU pseudo-jurisdiction (VIES)", () => {
    const tools = createBusinessRegistryTools({
      enabledHandlers: [BUSINESS_REGISTRY_DISPATCH.vies],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("tells the model which enabled registries require canonical identifiers", () => {
    const tools = createBusinessRegistryTools({
      enabledHandlers: [
        BUSINESS_REGISTRY_DISPATCH.edgar,
        BUSINESS_REGISTRY_DISPATCH.vies,
        BUSINESS_REGISTRY_DISPATCH.ares,
      ],
    });
    const lookupTool = tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME];

    expect(lookupTool?.description).toContain("US/EDGAR requires the SEC CIK");
    expect(lookupTool?.description).toContain(
      "EU/VIES requires a fully-qualified VAT number",
    );
    expect(lookupTool?.description).not.toContain("CZ/ARES");
    const inputJsonSchema = lookupTool
      ? convertSchemaToJsonSchema(lookupTool.inputSchema)
      : undefined;
    if (!hasToolInputJsonSchema(inputJsonSchema)) {
      throw new Error("Expected lookup tool JSON schema");
    }
    expect(inputJsonSchema.properties?.query?.description).toContain(
      "Ask the user for the canonical identifier",
    );
  });

  test("executes with the same organization-bound handler it advertises", async () => {
    let lookupCalls = 0;
    const boundHandler = {
      ...BUSINESS_REGISTRY_DISPATCH["companies-house"],
      isDeployAvailable: () => true,
      lookup: async () => {
        lookupCalls += 1;
        return null;
      },
    } satisfies RegistryHandler;
    const tool =
      createBusinessRegistryTools({ enabledHandlers: [boundHandler] })[
        BUSINESS_REGISTRY_LOOKUP_TOOL_NAME
      ] ?? panic("Expected a registry tool");
    const execute =
      tool.execute ?? panic("Expected an executable registry tool");

    const result = await execute(
      { jurisdiction: "GB", query: "12345678" },
      { emitCustomEvent: () => undefined },
    );

    expect(lookupCalls).toBe(1);
    expect(result).toEqual({
      type: "lookup",
      registry: "companies-house",
      hit: null,
    });
  });
});
