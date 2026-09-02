import { toolDefinition } from "@tanstack/ai";
import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import { SUGGEST_CHANGES_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  CHAT_TOOL_SCOPE,
  restrictChatToolsToScope,
} from "@/api/handlers/chat/tools/tool-scope";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";

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
      [SUGGEST_CHANGES_TOOL_NAME]: makeTool(SUGGEST_CHANGES_TOOL_NAME),
      search_history: makeTool("search_history"),
      web_search: makeTool("web_search"),
      "create-document": makeTool("create-document"),
      external_mcp_anything: makeTool("external_mcp_anything"),
    };

    const restricted = restrictChatToolsToScope(
      tools,
      CHAT_TOOL_SCOPE.suggestTemplateFields,
    );

    expect(Object.keys(restricted).toSorted()).toEqual(
      [SUGGEST_CHANGES_TOOL_NAME, "suggest_template_fields"].toSorted(),
    );
  });

  it("returns an empty set when no registered tool is allowlisted", () => {
    const restricted = restrictChatToolsToScope(
      { search_history: makeTool("search_history") },
      CHAT_TOOL_SCOPE.suggestTemplateFields,
    );

    expect(Object.keys(restricted)).toEqual([]);
  });
});
