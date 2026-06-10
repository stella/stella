import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import {
  CHAT_TOOL_SCOPE,
  restrictChatToolsToScope,
} from "@/api/handlers/chat/tools/tool-scope";

const makeTool = () =>
  tool({
    description: "test tool",
    inputSchema: valibotSchema(v.object({ query: v.string() })),
    execute: ({ query }) => ({ query }),
  });

describe("restrictChatToolsToScope", () => {
  it("keeps only the suggest-template-fields allowlist", () => {
    const tools: ToolSet = {
      suggest_template_fields: makeTool(),
      "apply-active-docx-edits": makeTool(),
      search_history: makeTool(),
      web_search: makeTool(),
      "create-document": makeTool(),
      external_mcp_anything: makeTool(),
    };

    const restricted = restrictChatToolsToScope(
      tools,
      CHAT_TOOL_SCOPE.suggestTemplateFields,
    );

    expect(Object.keys(restricted).toSorted()).toEqual([
      "apply-active-docx-edits",
      "suggest_template_fields",
    ]);
  });

  it("returns an empty set when no registered tool is allowlisted", () => {
    const restricted = restrictChatToolsToScope(
      { search_history: makeTool() },
      CHAT_TOOL_SCOPE.suggestTemplateFields,
    );

    expect(Object.keys(restricted)).toEqual([]);
  });
});
