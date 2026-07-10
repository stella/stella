import { toolDefinition } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { projectToolMapForSubagent } from "@/api/handlers/chat/tools/subagent-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";

const inputSchema = toTanStackToolSchema(v.strictObject({}));

const serverTool = (name: string, needsApproval = false) => {
  const tool = toolDefinition({ name, description: name, inputSchema }).server(
    async () => ({}),
  );
  return needsApproval ? Object.assign(tool, { needsApproval: true }) : tool;
};

// A client-executed tool: schema-only, no server `execute`.
const clientTool = (name: string) =>
  toolDefinition({ name, description: name, inputSchema }).client();

describe("projectToolMapForSubagent", () => {
  test("drops client-executed tools (no server execute) so a nested loop cannot hang", () => {
    const tools: ChatToolMap = {
      list_matters: serverTool("list_matters"),
      "create-document": clientTool("create-document"),
      "ask-user": clientTool("ask-user"),
      "apply-active-docx-edits": clientTool("apply-active-docx-edits"),
    };

    const projected = projectToolMapForSubagent(tools);

    expect(Object.keys(projected).sort()).toEqual(["list_matters"]);
  });

  test("strips needsApproval from surviving tools (delegation was approved once, up front)", () => {
    const tools: ChatToolMap = {
      save_matter: serverTool("save_matter", true),
    };

    const projected = projectToolMapForSubagent(tools);

    const survived = projected["save_matter"];
    expect(survived).toBeDefined();
    expect(survived?.needsApproval).toBeUndefined();
    // Execution capability is preserved so the subagent can still run the write.
    expect(typeof survived?.execute).toBe("function");
  });

  test("never lets a subagent re-spawn subagents", () => {
    const tools: ChatToolMap = {
      [SPAWN_SUBAGENTS_TOOL_NAME]: serverTool(SPAWN_SUBAGENTS_TOOL_NAME),
      list_matters: serverTool("list_matters"),
    };

    const projected = projectToolMapForSubagent(tools);

    expect(projected[SPAWN_SUBAGENTS_TOOL_NAME]).toBeUndefined();
    expect(projected["list_matters"]).toBeDefined();
  });

  test("does not mutate the source tool's approval gate", () => {
    const source = serverTool("save_matter", true);
    const tools: ChatToolMap = { save_matter: source };

    projectToolMapForSubagent(tools);

    // The parent's tool object must keep its approval gate.
    expect(source.needsApproval).toBe(true);
  });

  test("skips undefined entries", () => {
    const tools: ChatToolMap = {
      list_matters: serverTool("list_matters"),
      absent: undefined,
    };

    const projected = projectToolMapForSubagent(tools);

    expect(Object.keys(projected)).toEqual(["list_matters"]);
  });

  test("preserves the original tool's chat-tool policy across the clone, so anonymization does not treat a public tool as internal", () => {
    const source = serverTool("lookup_company_registry");
    applyChatToolPolicy(source, CHAT_TOOL_POLICY_KIND.publicOfficial);

    const tools: ChatToolMap = { lookup_company_registry: source };
    const projected = projectToolMapForSubagent(tools);

    const survived = projected["lookup_company_registry"];
    if (!survived) {
      throw new Error("expected lookup_company_registry to survive projection");
    }

    // Same policy object as the original, not the internal fallback a new
    // WeakMap entry would produce.
    expect(getChatToolPolicy(survived)).toBe(getChatToolPolicy(source));
    expect(getChatToolPolicy(survived).kind).toBe(
      CHAT_TOOL_POLICY_KIND.publicOfficial,
    );
    // The approval gate is still stripped independently of the policy copy.
    expect(survived.needsApproval).toBeUndefined();
  });

  test("drops external MCP tools by name even when they carry a server execute", () => {
    const mcpTool = serverTool("mcp__slack__send");
    const tools: ChatToolMap = {
      mcp__slack__send: mcpTool,
      list_matters: serverTool("list_matters"),
    };

    const projected = projectToolMapForSubagent(tools);

    expect(projected["mcp__slack__send"]).toBeUndefined();
    expect(projected["list_matters"]).toBeDefined();
  });
});
