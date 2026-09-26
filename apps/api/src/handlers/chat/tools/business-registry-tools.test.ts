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

describe("a jurisdiction with more than one register", () => {
  const recordingHandler = (
    base: RegistryHandler,
    calls: string[],
  ): RegistryHandler => ({
    ...base,
    isDeployAvailable: () => true,
    lookup: async () => {
      calls.push(base.slug);
      return null;
    },
  });

  const executorFor = (handlers: readonly RegistryHandler[]) => {
    const tool =
      createBusinessRegistryTools({ enabledHandlers: handlers })[
        BUSINESS_REGISTRY_LOOKUP_TOOL_NAME
      ] ?? panic("Expected a registry tool");
    return {
      tool,
      execute: tool.execute ?? panic("Expected an executable registry tool"),
    };
  };

  test("routes to the default register unless another one is named", async () => {
    const calls: string[] = [];
    const { execute } = executorFor([
      recordingHandler(BUSINESS_REGISTRY_DISPATCH.orsr, calls),
      recordingHandler(BUSINESS_REGISTRY_DISPATCH.rpo, calls),
    ]);
    const context = { emitCustomEvent: () => undefined };

    await execute({ jurisdiction: "SK", query: "31333532" }, context);
    await execute(
      { jurisdiction: "SK", query: "31333532", registry: "rpo" },
      context,
    );

    expect(calls).toEqual(["orsr", "rpo"]);
  });

  test("uses the only enabled register when the default is off", async () => {
    const calls: string[] = [];
    const { execute } = executorFor([
      recordingHandler(BUSINESS_REGISTRY_DISPATCH.rpo, calls),
    ]);

    await execute(
      { jurisdiction: "SK", query: "31333532" },
      { emitCustomEvent: () => undefined },
    );

    expect(calls).toEqual(["rpo"]);
  });

  test("refuses a register that does not cover the jurisdiction", async () => {
    const calls: string[] = [];
    const { execute } = executorFor([
      recordingHandler(BUSINESS_REGISTRY_DISPATCH.ares, calls),
      recordingHandler(BUSINESS_REGISTRY_DISPATCH.rpo, calls),
    ]);

    const result = await execute(
      { jurisdiction: "CZ", query: "27082440", registry: "rpo" },
      { emitCustomEvent: () => undefined },
    );

    expect(calls).toEqual([]);
    expect(result).toEqual({
      error: "Registry 'rpo' does not cover jurisdiction CZ",
    });
  });

  test("lists each jurisdiction once and says what the extra register covers", () => {
    const { tool } = executorFor([
      BUSINESS_REGISTRY_DISPATCH.orsr,
      BUSINESS_REGISTRY_DISPATCH.rpo,
    ]);
    const schema: unknown = convertSchemaToJsonSchema(tool.inputSchema);
    expect(schema).toMatchObject({
      properties: {
        jurisdiction: { enum: ["SK"] },
        registry: { enum: ["orsr", "rpo"] },
      },
    });
    expect(JSON.stringify(schema)).toContain("rpo (SK) covers every Slovak");
  });
});
