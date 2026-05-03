import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { chatThreads } from "@/api/db/schema";
import type { ChatMention } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

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
      ids.add(brandPersistedWorkspaceId(mention.id));
      continue;
    }
    if (mention.workspaceId !== null) {
      ids.add(brandPersistedWorkspaceId(mention.workspaceId));
    }
  }
  return Array.from(ids);
};

// Walks an assistant message's parts for workspace-scoped data
// embedded by the model. Two complementary carriers are scanned:
//
//   1. **Structural fields** — any property at any depth named
//      `workspaceId` or `matterRef` whose value is a UUID string.
//      Covers `data-stella-source-document` parts
//      (`data.workspaceId`), tool output parts that include
//      `matterRef` / `workspaceId` (search hits, file lookups,
//      property/entity records), and any future part shape that
//      reuses these conventional field names.
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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (
      WORKSPACE_KEY_FIELDS.has(key) &&
      typeof child === "string" &&
      UUID_REGEX.test(child)
    ) {
      ids.add(brandPersistedWorkspaceId(child));
      continue;
    }
    collectStructuralWorkspaceIds(child, ids);
  }
};

// Captures the workspace UUID from `#stella-workspace=<uuid>` and
// the leading workspace UUID from `#stella-entity=<workspace>:<entity>`.
// The entity form's second segment (the entity UUID) is intentionally
// not captured — only the workspace it belongs to gates RLS.
const STELLA_TEXT_REF_WORKSPACE_REGEX =
  /#stella-(?:workspace|entity)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

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
  if (!("text" in part) || typeof part.text !== "string") {
    return;
  }
  for (const match of part.text.matchAll(STELLA_TEXT_REF_WORKSPACE_REGEX)) {
    const captured = match[1];
    if (captured) {
      ids.add(brandPersistedWorkspaceId(captured));
    }
  }
};

type ExpandThreadDataScopeInput = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  // Workspaces already recorded on the thread row — this is the
  // local view we compare against to skip the UPDATE when nothing
  // would change. The DB source of truth still wins under
  // concurrent writes (the SQL appends + dedupes atomically).
  currentDataWorkspaceIds: readonly SafeId<"workspace">[];
  // Workspaces newly observed in the message about to be persisted.
  // May overlap with the current set; only genuinely new IDs cause
  // an UPDATE.
  newWorkspaceIds: readonly SafeId<"workspace">[];
};

type ExpandThreadDataScopeResult = Result<SafeId<"workspace">[], SafeDbError>;

// Atomically widens a chat thread's `data_workspace_ids` to include
// any workspaces a new message references. The append-and-dedupe
// happens in SQL so two concurrent message persists cannot lose
// entries. Returns the union (best effort, since we don't re-read
// the row) so callers can keep their local view in sync.
export const expandThreadDataScope = async ({
  safeDb,
  threadId,
  currentDataWorkspaceIds,
  newWorkspaceIds,
}: ExpandThreadDataScopeInput): Promise<ExpandThreadDataScopeResult> => {
  if (newWorkspaceIds.length === 0) {
    return Result.ok([...currentDataWorkspaceIds]);
  }
  const currentSet = new Set<SafeId<"workspace">>(currentDataWorkspaceIds);
  const additions = newWorkspaceIds.filter((id) => !currentSet.has(id));
  if (additions.length === 0) {
    return Result.ok([...currentDataWorkspaceIds]);
  }

  const updateResult = await safeDb((tx) =>
    tx
      .update(chatThreads)
      .set({
        // Append-and-dedupe in SQL so concurrent persists on the
        // same thread cannot lose entries. Postgres handles the
        // uniqueness; the local return value below is best-effort
        // for callers that want to keep their view in sync.
        dataWorkspaceIds: sql`(
          SELECT ARRAY(
            SELECT DISTINCT unnest(
              ${chatThreads.dataWorkspaceIds} || ${additions}::uuid[]
            )
          )
        )`,
      })
      .where(eq(chatThreads.id, threadId)),
  );

  if (Result.isError(updateResult)) {
    return Result.err(updateResult.error);
  }
  return Result.ok([...currentSet, ...additions]);
};
