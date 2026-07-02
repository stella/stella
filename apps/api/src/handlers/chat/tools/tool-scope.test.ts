import { toolDefinition } from "@tanstack/ai";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  CHAT_TOOL_SCOPE,
  restrictChatToolsToScope,
} from "@/api/handlers/chat/tools/tool-scope";

const makeTool = (name: string) =>
  toolDefinition({
    name,
    description: "test tool",
    inputSchema: toTanStackToolSchema(v.object({ query: v.string() })),
  });

describe("restrictChatToolsToScope", () => {
  it("keeps only the suggest-template-fields allowlist", () => {
    const tools: ChatToolMap = {
      suggest_template_fields: makeTool("suggest_template_fields"),
      "apply-active-docx-edits": makeTool("apply-active-docx-edits"),
      search_history: makeTool("search_history"),
      web_search: makeTool("web_search"),
      "create-document": makeTool("create-document"),
      external_mcp_anything: makeTool("external_mcp_anything"),
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
      { search_history: makeTool("search_history") },
      CHAT_TOOL_SCOPE.suggestTemplateFields,
    );

    expect(Object.keys(restricted)).toEqual([]);
  });
});
