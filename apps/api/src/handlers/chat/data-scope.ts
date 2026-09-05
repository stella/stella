import { panic } from "better-result";

import {
  findCanonicalChatResourceHrefs,
  isSafeIdValue,
  RESOURCE_TYPE,
} from "@stll/api-contract";

import type { ChatMention, ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const isWorkspaceIdCandidate = (value: unknown): value is string =>
  typeof value === "string" && isSafeIdValue(value);

// Walks a parsed user-message mention list for any workspace IDs the
// message embeds — entity mentions carry a workspaceId; workspace
// mentions are a workspace ID themselves. Used to expand a chat
// thread's data scope when the user pastes/attaches workspace
// content into a global thread.
export const extractMentionWorkspaceIds = (
  mentions: readonly ChatMention[],
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  for (const mention of mentions) {
    if (mention.category === "workspace") {
      ids.add(mention.resource.id);
      continue;
    }
    if (
      mention.workspaceId !== null &&
      isWorkspaceIdCandidate(mention.workspaceId)
    ) {
      ids.add(brandPersistedWorkspaceId(mention.workspaceId));
    }
  }
  return Array.from(ids);
};

export const extractIncomingMessageWorkspaceIds = ({
  mentions,
  message,
}: {
  mentions: readonly ChatMention[];
  message: ChatMessage;
}): SafeId<"workspace">[] => {
  if (message.role === "user") {
    return extractMentionWorkspaceIds(mentions);
  }

  if (message.role === "assistant") {
    return extractAssistantWorkspaceIds(message.parts);
  }

  return [];
};

export const extractMessageWorkspaceIds = (
  message: ChatMessage,
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  for (const id of collectPartsWorkspaceIds(message.parts)) {
    ids.add(id);
  }
  collectStructuralWorkspaceIds(message.metadata?.sourceDocuments, ids);
  const refContext = message.metadata?.refContext;
  if (refContext !== undefined) {
    for (const context of refContext.entities) {
      ids.add(context.workspace.id);
    }
    for (const workspace of refContext.workspaceScope) {
      ids.add(workspace.id);
    }
  }
  return Array.from(ids);
};

export const extractThreadDataWorkspaceIds = (
  messages: readonly ChatMessage[],
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  for (const message of messages) {
    for (const id of extractMessageWorkspaceIds(message)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
};

// Walks an assistant message's parts for workspace-scoped data
// embedded by the model. Two complementary carriers are scanned:
//
//   1. **Structural fields** — any property at any depth named
//      `workspaceId` or `matterRef` whose value is a persisted opaque ID.
//      Covers tool output parts that include `matterRef` /
//      `workspaceId` (search hits, file lookups, property/entity
//      records), persisted source-document metadata, and any future
//      part shape that reuses these conventional field names.
//   2. **Resolved text refs** — `#stella-workspace=<uuid>` and
//      `#stella-entity=<workspace>:<entity>` produced by
//      `resolveAssistantTextRefs` after the stream finishes.
//      Without these, an assistant reply that links a workspace in
//      plain text would not widen `chat_threads.data_workspace_ids`.
//
// Accepts `readonly unknown[]` and narrows per-part so this also
// handles legacy/migrated message shapes without forcing callers to
// pre-validate against the live `ChatMessage` union.
export const extractAssistantWorkspaceIds = (
  parts: readonly unknown[],
): SafeId<"workspace">[] => collectPartsWorkspaceIds(parts);

const collectPartsWorkspaceIds = (
  parts: readonly unknown[],
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  for (const part of parts) {
    collectStructuralWorkspaceIds(part, ids);
    collectTextRefWorkspaceIds(part, ids);
  }
  return Array.from(ids);
};

// Conventional field names across tool inputs/outputs that carry
// a workspace ID. Adding a new field name here is the one place to
// extend coverage when a new tool output shape ships.
const WORKSPACE_KEY_FIELDS = new Set(["workspaceId", "matterRef"]);

const collectStructuralWorkspaceIds = (
  value: unknown,
  ids: Set<SafeId<"workspace">>,
): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuralWorkspaceIds(item, ids);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (WORKSPACE_KEY_FIELDS.has(key) && isWorkspaceIdCandidate(child)) {
      ids.add(brandPersistedWorkspaceId(child));
      continue;
    }
    collectStructuralWorkspaceIds(child, ids);
  }
};

const collectTextRefWorkspaceIds = (
  part: unknown,
  ids: Set<SafeId<"workspace">>,
): void => {
  if (typeof part !== "object" || part === null) {
    return;
  }
  if (!("type" in part) || part.type !== "text") {
    return;
  }
  if (!("content" in part) || typeof part.content !== "string") {
    return;
  }
  for (const { target } of findCanonicalChatResourceHrefs(part.content)) {
    switch (target.type) {
      case RESOURCE_TYPE.ENTITY:
        if (target.location.type === "workspace") {
          ids.add(target.location.workspace.id);
        }
        break;
      case RESOURCE_TYPE.WORKSPACE:
        ids.add(target.resource.id);
        break;
      case RESOURCE_TYPE.CASE_LAW_DECISION:
        break;
      default:
        target satisfies never;
        panic(`Unhandled target: ${String(target)}`);
    }
  }
};

type ComputeAssistantTurnWorkspaceIdsInput = {
  // The just-finished assistant message's parts (structural
  // `workspaceId`/`matterRef` fields plus resolved `#stella-*` text refs).
  responseParts: readonly unknown[];
  // Every workspace id the shared ref registry had already registered
  // before this turn's stream started (prompt-time pins, prior-turn
  // history refs). Excluded from the delta below so those don't fold
  // into scope on every later turn.
  workspaceIdsBeforeStream: ReadonlySet<SafeId<"workspace">>;
  // The registry's current registered-workspace snapshot, taken after the
  // stream finished.
  registeredWorkspaceIdsAfterStream: readonly SafeId<"workspace">[];
  // Only ids the caller can currently access widen scope — guards against
  // a hallucinated or stale UUID (from the model, or a workspace the
  // caller lost access to mid-turn) ever landing in `data_workspace_ids`.
  accessibleWorkspaceIds: ReadonlySet<string>;
  // Workspace-scoped reads performed outside the in-process ref registry.
  // Agent-sandbox MCP calls arrive as separate HTTP requests, so the chat
  // process cannot observe which subset the agent actually touched. Passing
  // the token's full workspace attenuation here conservatively prevents
  // persisted summaries from outliving access to any workspace the run could
  // have read.
  opaqueReadWorkspaceIds?: readonly SafeId<"workspace">[];
};

// Computes the workspace ids to fold into `chat_threads.data_workspace_ids`
// once an assistant turn finishes. Two complementary sources feed it:
//
//   1. Structural/text-ref ids embedded in the assistant's own response
//      parts (`extractAssistantWorkspaceIds`).
//   2. The ref-registry delta: matter/entity refs resolved DURING the
//      stream (by a tool, or by a subagent's nested tool loop) that were
//      not already registered before the stream started. A subagent can
//      read workspace-scoped content and only return a free-form text
//      summary — the structural scan in (1) never sees that read, but the
//      shared registry (passed into the subagent's own toolset) still
//      holds the resolved ref, so the delta here catches it.
//
// Both are intersected with `accessibleWorkspaceIds` so an out-of-set id
// never reaches the thread row (see `expandThreadDataScope`'s caller).
export const computeAssistantTurnWorkspaceIds = ({
  responseParts,
  workspaceIdsBeforeStream,
  registeredWorkspaceIdsAfterStream,
  accessibleWorkspaceIds,
  opaqueReadWorkspaceIds = [],
}: ComputeAssistantTurnWorkspaceIdsInput): SafeId<"workspace">[] => {
  const candidateIds = [
    ...opaqueReadWorkspaceIds,
    ...extractAssistantWorkspaceIds(responseParts),
    ...registeredWorkspaceIdsAfterStream.filter(
      (id) => !workspaceIdsBeforeStream.has(id),
    ),
  ];
  return [
    ...new Set(candidateIds.filter((id) => accessibleWorkspaceIds.has(id))),
  ];
};
