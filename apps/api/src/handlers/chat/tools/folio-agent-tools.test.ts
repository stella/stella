import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  ADD_COMMENT_TOOL_NAME,
  createFolioAgentDocTools,
  FIND_TEXT_TOOL_NAME,
  READ_CHANGES_TOOL_NAME,
  READ_COMMENTS_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
  REPLY_COMMENT_TOOL_NAME,
  RESOLVE_COMMENT_TOOL_NAME,
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

const READ_TOOL_NAMES = [
  READ_DOCUMENT_TOOL_NAME,
  FIND_TEXT_TOOL_NAME,
  READ_CHANGES_TOOL_NAME,
  READ_COMMENTS_TOOL_NAME,
];
const MUTATION_TOOL_NAMES = [
  ADD_COMMENT_TOOL_NAME,
  REPLY_COMMENT_TOOL_NAME,
  RESOLVE_COMMENT_TOOL_NAME,
];

// `createFolioAgentDocTools()` takes no gating input — it always builds the
// full live-editor tool set. The `hasActiveDocxFileClient`-gated registration
// (only the file overlay, never Template Studio) is exercised where the gate
// actually lives: `getChatTools` in `tool-schema.test.ts`.
describe("createFolioAgentDocTools", () => {
  test("registers the read tools and the comment-mutation tools", () => {
    const tools = createFolioAgentDocTools();
    expect(Object.keys(tools).sort()).toEqual(
      [...READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES].sort(),
    );
  });

  test("exposes the exact tool names @stll/folio-agents defines", () => {
    expect(READ_DOCUMENT_TOOL_NAME).toBe("read_document");
    expect(FIND_TEXT_TOOL_NAME).toBe("find_text");
    expect(READ_CHANGES_TOOL_NAME).toBe("read_changes");
    expect(READ_COMMENTS_TOOL_NAME).toBe("read_comments");
    expect(ADD_COMMENT_TOOL_NAME).toBe("add_comment");
    expect(REPLY_COMMENT_TOOL_NAME).toBe("reply_comment");
    expect(RESOLVE_COMMENT_TOOL_NAME).toBe("resolve_comment");
  });

  test("does not register suggest_changes or the navigation-only tools", () => {
    const tools = createFolioAgentDocTools();
    expect("suggest_changes" in tools).toBe(false);
    expect("read_page" in tools).toBe(false);
    expect("read_selection" in tools).toBe(false);
    expect("scroll_to_block" in tools).toBe(false);
  });

  test("read tools carry no needsApproval (auto-run, read-only)", () => {
    const tools = createFolioAgentDocTools();
    for (const name of READ_TOOL_NAMES) {
      expect(tools[name].needsApproval).toBeUndefined();
    }
  });

  test("comment-mutation tools carry needsApproval: true", () => {
    const tools = createFolioAgentDocTools();
    for (const name of MUTATION_TOOL_NAMES) {
      expect(tools[name].needsApproval).toBe(true);
    }
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
