import { toolDefinition } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import {
  createSubagentProposalBuffer,
  projectToolMapForSubagent,
} from "@/api/handlers/chat/tools/subagent-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
  type ChatToolPolicyKind,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";

const inputSchema = toTanStackToolSchema(v.strictObject({}));

const serverTool = (name: string, needsApproval = false) => {
  const tool = toolDefinition({ name, description: name, inputSchema }).server(
    async () => ({}),
  );
  return needsApproval ? Object.assign(tool, { needsApproval: true }) : tool;
};

// A server tool whose real handler performs an observable side effect. Used to
// prove the projection never lets an approval-requiring tool run its write.
const writingTool = (name: string, sideEffects: string[]) =>
  toolDefinition({ name, description: name, inputSchema }).server(async () => {
    sideEffects.push(name);
    return {};
  });

const withPolicy = <TTool extends ChatTool>(
  tool: TTool,
  kind: ChatToolPolicyKind,
): TTool => applyChatToolPolicy(tool, kind);

// A client-executed tool: schema-only, no server `execute`.
const clientTool = (name: string) =>
  toolDefinition({ name, description: name, inputSchema }).client();

const sink = () => createSubagentProposalBuffer().sink;

describe("projectToolMapForSubagent", () => {
  test("drops client-executed tools (no server execute) so a nested loop cannot hang", () => {
    const tools: ChatToolMap = {
      list_matters: serverTool("list_matters"),
      "create-document": clientTool("create-document"),
      "ask-user": clientTool("ask-user"),
      "apply-active-docx-edits": clientTool("apply-active-docx-edits"),
    };

    const projected = projectToolMapForSubagent(tools, sink());

    expect(Object.keys(projected).sort()).toEqual(["list_matters"]);
  });

  test("no surviving tool both requires approval and can run a real write; writes become non-executing proposals", async () => {
    const sideEffects: string[] = [];
    const tools: ChatToolMap = {
      // reads (policy.needsApproval === false): survive with a live execute.
      read_document: withPolicy(
        serverTool("read_document"),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
      lookup_company_registry: withPolicy(
        serverTool("lookup_company_registry"),
        CHAT_TOOL_POLICY_KIND.publicOfficial,
      ),
      // approval-requiring tools (policy.needsApproval === true): must NOT run.
      save_matter: withPolicy(
        writingTool("save_matter", sideEffects),
        CHAT_TOOL_POLICY_KIND.mutation,
      ),
      delete_matter: withPolicy(
        writingTool("delete_matter", sideEffects),
        CHAT_TOOL_POLICY_KIND.mutation,
      ),
      web_search: withPolicy(
        writingTool("web_search", sideEffects),
        CHAT_TOOL_POLICY_KIND.external,
      ),
    };

    const buffer = createSubagentProposalBuffer();
    const projected = projectToolMapForSubagent(tools, buffer.sink);

    // Every tool survives the projection (reads live, writes as wrappers).
    expect(Object.keys(projected).sort()).toEqual([
      "delete_matter",
      "lookup_company_registry",
      "read_document",
      "save_matter",
      "web_search",
    ]);

    // Structural invariant: invoke every surviving approval-requiring tool.
    // None may run its real write; each must record a proposal instead.
    for (const tool of Object.values(projected)) {
      if (!tool || !getChatToolPolicy(tool).needsApproval) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- test executes wrappers to assert they perform no side effect
      await tool.execute?.({}, undefined);
    }

    // The real write handlers never ran.
    expect(sideEffects).toEqual([]);
    // Instead, each approval-requiring call was buffered as a proposal.
    expect(
      buffer
        .list()
        .map((proposal) => proposal.toolName)
        .sort(),
    ).toEqual(["delete_matter", "save_matter", "web_search"]);
  });

  test("a mutation tool's projected wrapper records the proposed call instead of executing it", async () => {
    const sideEffects: string[] = [];
    const source = withPolicy(
      writingTool("save_matter", sideEffects),
      CHAT_TOOL_POLICY_KIND.mutation,
    );
    const tools: ChatToolMap = { save_matter: source };

    const buffer = createSubagentProposalBuffer();
    const projected = projectToolMapForSubagent(tools, buffer.sink);

    const wrapper = projected["save_matter"];
    if (!wrapper) {
      throw new Error("expected save_matter to survive as a proposal wrapper");
    }
    // Same schema/name contract the model sees, but not the real handler.
    expect(wrapper.name).toBe("save_matter");
    expect(wrapper.inputSchema).toBe(source.inputSchema);
    expect(typeof wrapper.execute).toBe("function");
    // No approval gate on the wrapper (a subagent has no client to answer one).
    expect(wrapper.needsApproval).toBeUndefined();

    const result = await wrapper.execute?.({ name: "Acme" }, undefined);

    // The real handler never ran; the call was buffered for later approval.
    expect(sideEffects).toEqual([]);
    expect(buffer.list()).toEqual([
      { toolName: "save_matter", args: { name: "Acme" } },
    ]);
    expect(String(result)).toContain("approval");
  });

  test("never lets a subagent re-spawn subagents", () => {
    const tools: ChatToolMap = {
      [SPAWN_SUBAGENTS_TOOL_NAME]: serverTool(SPAWN_SUBAGENTS_TOOL_NAME),
      list_matters: serverTool("list_matters"),
    };

    const projected = projectToolMapForSubagent(tools, sink());

    expect(projected[SPAWN_SUBAGENTS_TOOL_NAME]).toBeUndefined();
    expect(projected["list_matters"]).toBeDefined();
  });

  test("does not mutate the source tool's approval gate", () => {
    const source = withPolicy(
      serverTool("save_matter", true),
      CHAT_TOOL_POLICY_KIND.mutation,
    );
    const tools: ChatToolMap = { save_matter: source };

    projectToolMapForSubagent(tools, sink());

    // The parent's tool object must keep its approval gate.
    expect(source.needsApproval).toBe(true);
  });

  test("skips undefined entries", () => {
    const tools: ChatToolMap = {
      list_matters: serverTool("list_matters"),
      absent: undefined,
    };

    const projected = projectToolMapForSubagent(tools, sink());

    expect(Object.keys(projected)).toEqual(["list_matters"]);
  });

  test("preserves the original tool's chat-tool policy across the clone, so anonymization does not treat a public tool as internal", () => {
    const source = serverTool("lookup_company_registry");
    applyChatToolPolicy(source, CHAT_TOOL_POLICY_KIND.publicOfficial);

    const tools: ChatToolMap = { lookup_company_registry: source };
    const projected = projectToolMapForSubagent(tools, sink());

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

    const projected = projectToolMapForSubagent(tools, sink());

    expect(projected["mcp__slack__send"]).toBeUndefined();
    expect(projected["list_matters"]).toBeDefined();
  });
});
