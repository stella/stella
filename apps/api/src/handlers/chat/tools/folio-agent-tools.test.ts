import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
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

// `createFolioAgentDocTools()` takes no gating input — it always builds
// both tools. The `hasActiveDocxFileClient`-gated registration (only the
// file overlay, never Template Studio) is exercised where the gate
// actually lives: `getChatTools` in `tool-schema.test.ts` ("registers the
// folio-agents read_document/find_text tools only when the file-overlay
// docx client is active").
describe("createFolioAgentDocTools", () => {
  test("registers exactly read_document and find_text", () => {
    const tools = createFolioAgentDocTools();
    expect(Object.keys(tools).sort()).toEqual(
      [FIND_TEXT_TOOL_NAME, READ_DOCUMENT_TOOL_NAME].sort(),
    );
  });

  test("exposes the exact tool names @stll/folio-agents defines", () => {
    expect(READ_DOCUMENT_TOOL_NAME).toBe("read_document");
    expect(FIND_TEXT_TOOL_NAME).toBe("find_text");
  });

  test("does not register any other folio-agents tool (comments/changes/mutations/live-editor)", () => {
    const tools = createFolioAgentDocTools();
    expect("read_comments" in tools).toBe(false);
    expect("read_changes" in tools).toBe(false);
    expect("add_comment" in tools).toBe(false);
    expect("suggest_changes" in tools).toBe(false);
    expect("reply_comment" in tools).toBe(false);
    expect("resolve_comment" in tools).toBe(false);
    expect("read_page" in tools).toBe(false);
    expect("read_selection" in tools).toBe(false);
    expect("scroll_to_block" in tools).toBe(false);
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

  test("no `.server()` is applied — tools are client-executed with no execute fn", () => {
    const tools = createFolioAgentDocTools();
    for (const tool of Object.values(tools)) {
      expect(tool.execute).toBeUndefined();
    }
  });

  test("no needsApproval is set on either tool (read-only, no-approval)", () => {
    const tools = createFolioAgentDocTools();
    for (const tool of Object.values(tools)) {
      expect(tool.needsApproval).toBeUndefined();
    }
  });
});
