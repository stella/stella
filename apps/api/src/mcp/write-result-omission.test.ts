import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { MCP_MODES } from "@/api/mcp/constants";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { defineMcpToolOutput } from "@/api/mcp/valibot-tool-definition";
import {
  advertisedMcpOutputSchema,
  MCP_OMITTED_WRITE_RESULT,
  omittedWriteToolResult,
} from "@/api/mcp/write-result-omission";
import { compileClientWireSchema } from "@/api/tests/helpers/wire-json-schema";

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
        const validate = compileClientWireSchema(
          clientValidator,
          tool.outputSchema,
        );
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

  test.each(["equivalent", "none"] as const)(
    "the advertised schema keeps the tool's own contract with %s compaction",
    (compaction) => {
      const own = defineMcpToolOutput(
        v.strictObject({
          entityId: v.string(),
          updated: v.optional(v.boolean()),
          details: v.optional(
            v.strictObject({
              payload: v.strictObject({ count: v.number() }),
            }),
          ),
        }),
      );
      const advertised = advertisedMcpOutputSchema({
        contract: own,
        access: "write",
        compaction,
      });
      const accepts = (value: unknown) =>
        compileClientWireSchema(clientValidator, advertised)(value).valid;

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
      expect(accepts({ ...MCP_OMITTED_WRITE_RESULT, reason: "other" })).toBe(
        false,
      );
      expect(accepts({ ...MCP_OMITTED_WRITE_RESULT, unexpected: 1 })).toBe(
        false,
      );
      expect(accepts({ entityId: "entity_1", updated: "yes" })).toBe(false);
      expect(accepts({ entityId: "entity_1", unexpected: 1 })).toBe(false);
      expect(
        accepts({ entityId: "entity_1", details: { payload: { count: 1 } } }),
      ).toBe(true);
      expect(accepts({ entityId: "entity_1", details: { payload: {} } })).toBe(
        false,
      );
      expect(
        accepts({ entityId: "entity_1", details: { payload: { count: "1" } } }),
      ).toBe(false);
    },
  );

  test.each(["equivalent", "none"] as const)(
    "recursive write outputs keep document-root references with %s compaction",
    (compaction) => {
      type OutputNode = { label: string; children: OutputNode[] };
      const node: v.GenericSchema<OutputNode> = v.strictObject({
        label: v.string(),
        children: v.array(v.lazy(() => node)),
      });
      const contract = defineMcpToolOutput(v.strictObject({ root: node }));
      const advertised = advertisedMcpOutputSchema({
        contract,
        access: "write",
        compaction,
      });
      const validate = compileClientWireSchema(clientValidator, advertised);

      expect(advertised["type"]).toBe("object");
      expect(
        validate({
          root: { label: "root", children: [{ label: "child", children: [] }] },
        }).valid,
      ).toBe(true);
      expect(validate(MCP_OMITTED_WRITE_RESULT).valid).toBe(true);
      expect(
        validate({
          root: { label: "root", children: [{ label: 7, children: [] }] },
        }).valid,
      ).toBe(false);
      expect(validate({ root: { label: "root" } }).valid).toBe(false);
      expect(
        validate({ root: { label: "root", children: [], extra: true } }).valid,
      ).toBe(false);
      expect(validate({ applied: true }).valid).toBe(false);
      expect(validate({ ...MCP_OMITTED_WRITE_RESULT, extra: true }).valid).toBe(
        false,
      );
    },
  );

  test("read advertisements retain their exact output schema", () => {
    const contract = defineMcpToolOutput(v.strictObject({ value: v.string() }));
    expect(advertisedMcpOutputSchema({ contract, access: "read" })).toBe(
      contract.outputSchema,
    );
  });
});
