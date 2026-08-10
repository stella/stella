import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  ADD_COMMENT_TOOL_NAME,
  createFolioAgentDocTools,
  FIND_TEXT_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
} from "./folio-agent-tools.js";

type ToolInputJsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
};

const hasToolInputJsonSchema = (
  schema: unknown,
): schema is ToolInputJsonSchema =>
  typeof schema === "object" && schema !== null;

// `createFolioAgentDocTools()` takes no gating input — it always builds the
// full live-editor tool set. The `hasActiveDocxFileClient`-gated registration
// (only the file overlay, never Template Studio) is exercised where the gate
// actually lives: `getChatTools` in `tool-schema.test.ts`.
describe("createFolioAgentDocTools", () => {
  test("does not register suggest_changes or the navigation-only tools", () => {
    const tools = createFolioAgentDocTools();
    expect("suggest_changes" in tools).toBe(false);
    expect("read_page" in tools).toBe(false);
    expect("read_selection" in tools).toBe(false);
    expect("scroll_to_block" in tools).toBe(false);
  });

  test("no `.server()` is applied — every tool is client-executed", () => {
    const tools = createFolioAgentDocTools();
    for (const tool of Object.values(tools)) {
      expect(tool.execute).toBeUndefined();
    }
  });

  test("survives JSON-Schema conversion for read_document (empty object schema)", () => {
    const tools = createFolioAgentDocTools();
    const jsonSchema = convertSchemaToJsonSchema(
      tools[READ_DOCUMENT_TOOL_NAME].inputSchema,
    );
    if (!hasToolInputJsonSchema(jsonSchema)) {
      throw new Error("Expected read_document JSON schema");
    }
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toEqual({});
    expect(jsonSchema.additionalProperties).toBe(false);
  });

  test("survives JSON-Schema conversion for find_text (query + matchCase)", () => {
    const tools = createFolioAgentDocTools();
    const jsonSchema = convertSchemaToJsonSchema(
      tools[FIND_TEXT_TOOL_NAME].inputSchema,
    );
    if (!hasToolInputJsonSchema(jsonSchema)) {
      throw new Error("Expected find_text JSON schema");
    }
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toBeDefined();
    expect(jsonSchema.properties?.["query"]).toBeDefined();
    expect(jsonSchema.properties?.["matchCase"]).toBeDefined();
    expect(jsonSchema.additionalProperties).toBe(false);
  });

  test("survives JSON-Schema conversion for add_comment (has a schema)", () => {
    const tools = createFolioAgentDocTools();
    const jsonSchema = convertSchemaToJsonSchema(
      tools[ADD_COMMENT_TOOL_NAME].inputSchema,
    );
    if (!hasToolInputJsonSchema(jsonSchema)) {
      throw new Error("Expected add_comment JSON schema");
    }
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toBeDefined();
  });
});
