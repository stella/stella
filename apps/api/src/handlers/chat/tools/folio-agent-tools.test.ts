import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { DOCX_SUGGESTION_SURFACE } from "@stll/api-contract/chat-docx-suggestions";

import {
  ADD_COMMENT_TOOL_NAME,
  createFolioAgentDocTools,
  createSuggestChangesTools,
  FIND_TEXT_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
  SUGGEST_CHANGES_TOOL_NAME,
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

  test("registers exactly the 12 read/comment tool names", () => {
    const tools = createFolioAgentDocTools();
    expect(Object.keys(tools).toSorted()).toEqual(
      [
        "read_document",
        "get_document_outline",
        "read_section",
        "list_stories",
        "read_story",
        "find_text",
        "read_changes",
        "read_comments",
        "show_in_document",
        "add_comment",
        "reply_comment",
        "resolve_comment",
      ].toSorted(),
    );
  });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

type OperationItemSchema = {
  typeEnum: string[];
  requiredByVariant: string[][];
};

const readOperationItemSchema = (
  inputSchema: Parameters<typeof convertSchemaToJsonSchema>[0],
): OperationItemSchema => {
  const jsonSchema = convertSchemaToJsonSchema(inputSchema);
  if (!isRecord(jsonSchema) || !isRecord(jsonSchema.properties)) {
    throw new Error("Expected suggest_changes JSON schema with properties");
  }
  const operations = jsonSchema.properties["operations"];
  if (!isRecord(operations) || !isRecord(operations.items)) {
    throw new Error("Expected an `operations` array schema with `items`");
  }
  const variants = operations.items.anyOf;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error("Expected operation schema variants");
  }
  const typeEnum = new Set<string>();
  const requiredByVariant: string[][] = [];
  for (const variant of variants) {
    if (
      !isRecord(variant) ||
      !isRecord(variant.properties) ||
      !isRecord(variant.properties["type"])
    ) {
      throw new Error("Expected an operation variant with a type property");
    }
    const operationTypes = variant.properties["type"].enum;
    if (!isStringArray(operationTypes) || !isStringArray(variant.required)) {
      throw new Error("Expected operation types and required properties");
    }
    for (const operationType of operationTypes) {
      typeEnum.add(operationType);
    }
    requiredByVariant.push(variant.required);
  }
  return { typeEnum: [...typeEnum], requiredByVariant };
};

describe("createSuggestChangesTools", () => {
  test("file-overlay surface exposes the 15-type operation enum, no formatRange", () => {
    const tools = createSuggestChangesTools(
      DOCX_SUGGESTION_SURFACE.fileOverlay,
    );
    expect(Object.keys(tools)).toEqual([SUGGEST_CHANGES_TOOL_NAME]);

    const { typeEnum, requiredByVariant } = readOperationItemSchema(
      tools[SUGGEST_CHANGES_TOOL_NAME].inputSchema,
    );
    expect(typeEnum).toEqual([
      "replaceInBlock",
      "replaceRange",
      "commentOnRange",
      "insertAfterBlock",
      "insertBeforeBlock",
      "replaceBlock",
      "deleteBlock",
      "commentOnBlock",
      "insertSignatureTable",
      "insertTableRow",
      "deleteTableRow",
      "insertTableColumn",
      "deleteTableColumn",
      "mergeTableCells",
      "splitTableCell",
    ]);
    expect(typeEnum).not.toContain("formatRange");
    for (const required of requiredByVariant) {
      expect(required).toEqual(
        expect.arrayContaining(["type", "severity", "area"]),
      );
    }
  });

  test("template-studio surface exposes only the text-replacement operation types", () => {
    const tools = createSuggestChangesTools(
      DOCX_SUGGESTION_SURFACE.templateStudio,
    );
    expect(Object.keys(tools)).toEqual([SUGGEST_CHANGES_TOOL_NAME]);

    const { typeEnum, requiredByVariant } = readOperationItemSchema(
      tools[SUGGEST_CHANGES_TOOL_NAME].inputSchema,
    );
    expect(typeEnum).toEqual(["replaceInBlock", "replaceBlock", "deleteBlock"]);
    for (const required of requiredByVariant) {
      expect(required).toEqual(
        expect.arrayContaining(["type", "severity", "area"]),
      );
    }
  });
});
