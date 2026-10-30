import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { businessRegistryCallScope } from "@/api/handlers/chat/tools/source-scope";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type { RegistryHandler } from "@/api/lib/business-registries/dispatch";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

import {
  BUSINESS_REGISTRY_LOOKUP_TOOL_NAME,
  createBusinessRegistryTools,
} from "./business-registry-tools.js";
import type { BusinessRegistryCallScope } from "./business-registry-tools.js";

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
    const tools = createBusinessRegistryTools({
      organizationId: toSafeId<"organization">("fixture-org"),
      enabledHandlers: [],
    });
    expect(BUSINESS_REGISTRY_LOOKUP_TOOL_NAME in tools).toBe(false);
  });

  test("registers business_registry_lookup when at least one jurisdiction is enabled", () => {
    const tools = createBusinessRegistryTools({
      organizationId: toSafeId<"organization">("fixture-org"),
      enabledHandlers: [BUSINESS_REGISTRY_DISPATCH.ares],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("registers the tool with multiple jurisdictions in the picklist", () => {
    const tools = createBusinessRegistryTools({
      organizationId: toSafeId<"organization">("fixture-org"),
      enabledHandlers: [
        BUSINESS_REGISTRY_DISPATCH.ares,
        BUSINESS_REGISTRY_DISPATCH.brreg,
      ],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("accepts the EU pseudo-jurisdiction (VIES)", () => {
    const tools = createBusinessRegistryTools({
      organizationId: toSafeId<"organization">("fixture-org"),
      enabledHandlers: [BUSINESS_REGISTRY_DISPATCH.vies],
    });
    expect(tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]).toBeDefined();
  });

  test("tells the model which enabled registries require canonical identifiers", () => {
    const tools = createBusinessRegistryTools({
      organizationId: toSafeId<"organization">("fixture-org"),
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

  test("does not advertise verified KRS name search without web search", () => {
    const tools = createBusinessRegistryTools({
      organizationId: toSafeId<"organization">("fixture-org"),
      enabledHandlers: [BUSINESS_REGISTRY_DISPATCH.krs],
      webSearchProvider: null,
    });
    const lookupTool = tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME];

    expect(lookupTool?.description).not.toContain(
      "Company-name matches are verified",
    );
    expect(lookupTool?.description).toContain("PL/KRS requires the KRS number");
  });

  test.each([
    [BUSINESS_REGISTRY_DISPATCH.ares, false],
    [BUSINESS_REGISTRY_DISPATCH.krs, true],
  ] as const)(
    "advertises web verification only for enabled capable handlers: %s",
    (handler, advertised) => {
      const tools = createBusinessRegistryTools({
        organizationId: toSafeId<"organization">("fixture-org"),
        enabledHandlers: [handler],
        webSearchProvider: {
          name: "tavily",
          search: async () => ({ results: [] }),
        },
      });
      const lookupTool =
        tools[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME] ??
        panic("Expected registry tool");
      const querySchema = convertSchemaToJsonSchema(lookupTool.inputSchema);
      if (!hasToolInputJsonSchema(querySchema)) {
        panic("Expected lookup query schema");
      }
      const guidance =
        "Company-name matches are verified against the selected register";
      expect(lookupTool.description.includes(guidance)).toBe(advertised);
      expect(
        querySchema.properties?.query?.description?.includes(guidance),
      ).toBe(advertised);
      if (!advertised) {
        expect(lookupTool.description).not.toContain("KRS");
      }
    },
  );

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
      createBusinessRegistryTools({
        organizationId: toSafeId<"organization">("fixture-org"),
        enabledHandlers: [boundHandler],
      })[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME] ??
      panic("Expected a registry tool");
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

  const executorFor = (
    handlers: readonly RegistryHandler[],
    scopeCall?: BusinessRegistryCallScope,
  ) => {
    const tool =
      createBusinessRegistryTools({
        organizationId: toSafeId<"organization">("fixture-org"),
        enabledHandlers: handlers,
        scopeCall,
      })[BUSINESS_REGISTRY_LOOKUP_TOOL_NAME] ??
      panic("Expected a registry tool");
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

  test("holds a chip-scoped turn to the named register: pins it, refuses others", async () => {
    const calls: string[] = [];
    const rpo = recordingHandler(BUSINESS_REGISTRY_DISPATCH.rpo, calls);
    const { execute } = executorFor(
      [
        recordingHandler(BUSINESS_REGISTRY_DISPATCH.ares, calls),
        recordingHandler(BUSINESS_REGISTRY_DISPATCH.orsr, calls),
        rpo,
      ],
      businessRegistryCallScope([rpo]),
    );
    const context = { emitCustomEvent: () => undefined };
    // The tool's execute is typed loosely; a call here is always a promise.
    const call = async (
      input: Parameters<typeof execute>[0],
    ): Promise<unknown> => await execute(input, context);

    // The default SK register is orsr; the chip names rpo, so rpo answers.
    await call({ jurisdiction: "SK", query: "31333532" });
    expect(calls).toEqual(["rpo"]);

    const otherRegister = await rejectionOf(
      call({ jurisdiction: "SK", query: "31333532", registry: "orsr" }),
    );
    const otherJurisdiction = await rejectionOf(
      call({ jurisdiction: "CZ", query: "27082440" }),
    );

    expect(otherRegister).toBeInstanceOf(ChatToolError);
    expect(String(otherRegister)).toContain("Registry orsr is not one of them");
    expect(String(otherJurisdiction)).toContain("None of them serves CZ");
    expect(calls).toEqual(["rpo"]);
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
