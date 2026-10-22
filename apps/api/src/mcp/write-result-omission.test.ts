import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { describe, expect, test } from "bun:test";

import { MCP_MODES } from "@/api/mcp/constants";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import {
  MCP_OMITTED_WRITE_RESULT,
  omittedWriteToolResult,
  withWriteResultOmission,
} from "@/api/mcp/write-result-omission";

// The validator the official v2 client compiles each advertised output schema
// with before it accepts a `tools/call` result.
const clientValidator = new AjvJsonSchemaValidator();

describe("omitted write results", () => {
  test("every write tool's advertised output schema accepts the omitted result", () => {
    const { structuredContent } = omittedWriteToolResult();
    const census: string[] = [];
    const rejected: string[] = [];
    for (const mode of MCP_MODES) {
      const definitions = listStaticMcpToolDefinitions(mode);
      const writeTools = new Set(
        definitions
          .filter((definition) => definition.access === "write")
          .map((definition) => definition.name),
      );
      for (const tool of toMcpTools(definitions, { mode })) {
        if (!writeTools.has(tool.name) || tool.outputSchema === undefined) {
          continue;
        }
        census.push(`${mode}/${tool.name}`);
        const validate = clientValidator.getValidator(tool.outputSchema);
        if (!validate(structuredContent).valid) {
          rejected.push(`${mode}/${tool.name}`);
        }
      }
    }

    // The census reaches the write surface of every audience that has one.
    expect(census.length).toBeGreaterThan(0);
    expect(census).toContain("default/save_filled_template");
    expect(census).toContain("documents/upload_document_version");
    expect(rejected).toEqual([]);
  });

  test("the advertised schema keeps the tool's own contract", () => {
    const own = {
      type: "object",
      properties: {
        entityId: { type: "string" },
        updated: { type: "boolean" },
      },
      required: ["entityId"],
      additionalProperties: false,
    };
    const advertised = withWriteResultOmission(own);
    const accepts = (value: unknown) =>
      clientValidator.getValidator(advertised)(value).valid;

    expect(advertised["type"]).toBe("object");
    expect(accepts({ entityId: "entity_1", updated: true })).toBe(true);
    expect(accepts({ ...MCP_OMITTED_WRITE_RESULT })).toBe(true);
    // Neither half of the contract is loosened: the tool's required fields,
    // the complete omission marker, its pinned values and the closed root all
    // still hold.
    expect(accepts({ updated: true })).toBe(false);
    expect(accepts({ applied: true })).toBe(false);
    expect(accepts({ ...MCP_OMITTED_WRITE_RESULT, applied: false })).toBe(
      false,
    );
    expect(accepts({ entityId: "entity_1", unexpected: 1 })).toBe(false);
  });
});
