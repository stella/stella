import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { copyChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";

/**
 * Projects the full chat tool map down to the subset a subagent's
 * nested `chat()` loop (see `runSubagent` in `tanstack-ai-agent.ts`)
 * is allowed to use. Two exclusions matter:
 *
 *  - `spawn_subagents` itself is dropped so a subagent cannot spawn
 *    further subagents. Nesting depth is already capped in
 *    `chat-tools.ts` via `SUBAGENT_DELEGATION_DEPTH_CAP`; this is a
 *    second, local guarantee that the projected set never contains it.
 *  - Any tool with no server `execute` (e.g. `create-document`,
 *    `ask-user`, `apply-active-docx-edits`) is client-executed: the
 *    real chat client resolves it via `ChatClient.addToolResult`. A
 *    nested loop has no client attached, so calling one of these
 *    would hang forever waiting for a result that never arrives.
 *
 * Every surviving tool is cloned with `needsApproval` stripped:
 * approval already happened once, up front, when the user approved
 * the `spawn_subagents` call itself. A nested loop has no client to
 * answer a pause, so a per-call approval on a projected tool would
 * deadlock the subagent.
 */
const hasServerExecute = (tool: ChatTool): boolean =>
  typeof tool.execute === "function";

const cloneWithoutApprovalGate = (tool: ChatTool): ChatTool => {
  const clone = { ...tool };
  delete clone.needsApproval;
  // Spreading gives the clone a new identity the policy WeakMap wouldn't
  // recognize; preserve the original policy so anonymization still treats
  // public tools as public (no input de-anon to an external provider).
  copyChatToolPolicy(tool, clone);
  return clone;
};

export const projectToolMapForSubagent = (tools: ChatToolMap): ChatToolMap => {
  const projected: ChatToolMap = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool) {
      continue;
    }
    if (name === SPAWN_SUBAGENTS_TOOL_NAME) {
      continue;
    }
    // Defense-in-depth: external MCP tools are also excluded by the
    // `hasServerExecute` check below (they carry no server `execute` until
    // the client resolves them), but that's an incidental property of how
    // MCP tools are wired today. Excluding by name here is explicit: a
    // subagent gets no MCP client of its own, so one of these tools would
    // hang forever, and it would also bypass the external-tool consent
    // approval a user gives when the top-level model calls it directly.
    if (name.startsWith("mcp__")) {
      continue;
    }
    if (!hasServerExecute(tool)) {
      continue;
    }
    projected[name] = cloneWithoutApprovalGate(tool);
  }
  return projected;
};
