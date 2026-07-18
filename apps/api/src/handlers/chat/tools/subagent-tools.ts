import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import {
  createSubagentProposalBuffer,
  SPAWN_SUBAGENTS_TOOL_NAME,
  type SubagentProposalBuffer,
  type SubagentProposalSink,
  type SubagentWriteProposal,
} from "@/api/handlers/chat/tools/subagent-tool-shared";
import {
  copyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";

// Re-exported for callers that only need the proposal-buffer primitives
// (`spawn-subagents-tool.ts`, tests); the canonical definitions live in
// `subagent-tool-shared.ts` so this module and `spawn-subagents-tool.ts`
// don't have to import each other.
export {
  createSubagentProposalBuffer,
  type SubagentProposalBuffer,
  type SubagentProposalSink,
  type SubagentWriteProposal,
};

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

const buildQueuedResultMessage = (toolName: string): string =>
  `Queued "${toolName}" for user approval. It was NOT executed and had no ` +
  `effect. The proposed action is returned to the top-level assistant, which ` +
  `will re-issue it so the user can approve it. Do not retry it and do not ` +
  `assume it completed.`;

/**
 * Wraps an approval-requiring tool as a non-executing proposal: same
 * name/description/inputSchema, but `execute` records the proposed call and
 * returns a synthetic acknowledgement instead of running the side effect.
 * The `outputSchema` is dropped so TanStack does not validate the synthetic
 * acknowledgement against the real write's output contract (it validates
 * server results against `outputSchema` when it is a Standard Schema).
 */
const buildProposalWrapper = (
  tool: ChatTool,
  proposalSink: SubagentProposalSink,
): ChatTool => {
  const wrapper = { ...tool };
  delete wrapper.needsApproval;
  delete wrapper.outputSchema;
  wrapper.execute = (args) => {
    proposalSink.record({ toolName: tool.name, args });
    return buildQueuedResultMessage(tool.name);
  };
  // Keep the original policy so anonymization/consent classification stays
  // consistent, even though the wrapper itself performs no third-party call.
  copyChatToolPolicy(tool, wrapper);
  return wrapper;
};

/**
 * Projects the full chat tool map down to the subset a subagent's
 * nested `chat()` loop (see `runSubagent` in `tanstack-ai-agent.ts`)
 * is allowed to use. Exclusions and transforms:
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
 *  - `mcp__` external tools are dropped by name (see below).
 *
 * Approval handling ("buffered approval"): a subagent runs autonomously
 * with no client to answer a per-call approval pause, so it must never
 * execute an approval-requiring tool (any `mutation` / `external` /
 * `publicUnofficial` policy) inline. Prompt-injected text in a document
 * the subagent reads could otherwise drive an irreversible delete/write
 * the user never approved. Classification is by the authoritative policy
 * WeakMap (`getChatToolPolicy`), not the raw `needsApproval` field:
 *
 *  - policy `needsApproval === false` (internal / publicOfficial reads):
 *    cloned as-is (approval was never required for these), with the
 *    policy preserved so anonymization still treats a public tool as
 *    public.
 *  - policy `needsApproval === true`: replaced by a non-executing
 *    proposal wrapper with the SAME name/description/inputSchema. Its
 *    `execute` performs no side effect; it records the proposed
 *    operation (tool name + validated args) into the run's proposal
 *    buffer and returns a synthetic "queued for approval" result. The
 *    caller of `runSubagent` drains the buffer and surfaces the proposed
 *    writes to the top-level chat loop, where the existing top-level
 *    `needsApproval` mechanism gates the real execution behind the user.
 *
 * This makes "a subagent silently executes an unapproved side-effecting
 * tool" structurally impossible: an approval-requiring tool can only ever
 * enter the projection as a non-executing wrapper.
 */
export const projectToolMapForSubagent = (
  tools: ChatToolMap,
  proposalSink: SubagentProposalSink,
): ChatToolMap => {
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
    // Authoritative classification is the policy WeakMap, not the raw
    // `needsApproval` field: an approval-requiring tool never gets a live
    // server `execute` inside a subagent, only a non-executing proposal.
    if (getChatToolPolicy(tool).needsApproval) {
      projected[name] = buildProposalWrapper(tool, proposalSink);
      continue;
    }
    projected[name] = cloneWithoutApprovalGate(tool);
  }
  return projected;
};
