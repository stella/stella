import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { isRecord } from "@/api/lib/type-guards";
import { MCP_MODES } from "@/api/mcp/constants";
import { openDecisionArgs } from "@/api/mcp/decision-reader-contract";
import { DYNAMIC_TOOL_FAMILY_POLICIES } from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  getStaticMcpToolDefinition,
  getStaticMcpToolOutputContract,
  listStaticMcpToolDefinitions,
} from "@/api/mcp/static-tool-definitions";
import { deriveUncompactedMcpOutputSchema } from "@/api/mcp/valibot-tool-definition";

/**
 * Tool definitions convert their Valibot schemas to JSON Schema when their
 * module loads, so importing every registry entry point here builds every
 * registered input and output schema; a non-convertible schema fails this
 * file. Output contracts are converted again so each failure names its tool.
 */
describe("every registered MCP tool schema converts to JSON Schema", () => {
  test.each([...MCP_MODES])("%s tools", (mode) => {
    const definitions = listStaticMcpToolDefinitions(mode);
    expect(definitions.length).toBeGreaterThan(0);
    for (const tool of definitions) {
      expect(tool.inputSchema.type, `${tool.name} inputSchema`).toBe("object");
      const contract = getStaticMcpToolOutputContract(tool.name, mode);
      if (contract === undefined) {
        continue;
      }
      expect(contract.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      expect(
        deriveUncompactedMcpOutputSchema(contract.outputSchemaSource),
        `${tool.name} outputSchema`,
      ).toBeDefined();
    }
  });

  test("Stella-owned dynamic tool families", () => {
    for (const [family, policy] of Object.entries(
      DYNAMIC_TOOL_FAMILY_POLICIES,
    )) {
      if (policy.owner !== "stella") {
        continue;
      }
      expect(
        deriveUncompactedMcpOutputSchema(policy.output.outputSchemaSource),
        `${family} outputSchema`,
      ).toBeDefined();
    }
  });

  test("a check without a declared JSON Schema projection still fails conversion", () => {
    expect(() =>
      toJsonSchema(
        v.pipe(
          v.string(),
          v.check(() => true),
        ),
        { errorMode: "throw" },
      ),
    ).toThrow('The "check" action cannot be converted to JSON Schema.');
  });
});

describe("decision paragraph range input", () => {
  test("publishes a bounded patterned string and keeps semantic checks at runtime", () => {
    const published = getStaticMcpToolDefinition("open_case_law_decision")
      ?.inputSchema.properties?.["paragraphs"];
    expect(published).toMatchObject({
      type: "string",
      maxLength: 33,
      description: expect.stringContaining("Court paragraph"),
    });
    const pattern =
      isRecord(published) && typeof published["pattern"] === "string"
        ? new RegExp(published["pattern"], "u")
        : null;
    expect(pattern).not.toBeNull();
    for (const input of ["48", "48-53", "48–53", "53-48", "1-501"]) {
      expect(pattern?.test(input), input).toBe(true);
    }
    for (const input of ["", "48—53", "48 ", "-48", "48.5"]) {
      expect(pattern?.test(input), input).toBe(false);
    }

    const decisionId = "0198c1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f";
    const parse = (paragraphs: string) =>
      v.safeParse(openDecisionArgs, { decision_id: decisionId, paragraphs });
    expect(parse("48–53")).toMatchObject({
      success: true,
      output: { paragraphs: { from: 48, to: 53 } },
    });
    for (const [input, message] of [
      ["53-48", "Paragraph range ends before it starts"],
      ["1-501", "Paragraph range may span at most 500 numbers"],
      ["0", "Expected a positive safe paragraph number or range"],
    ] as const) {
      const parsed = parse(input);
      expect(parsed.success, input).toBe(false);
      expect(
        parsed.issues?.map((issue) => issue.message),
        input,
      ).toContain(message);
    }
  });
});
