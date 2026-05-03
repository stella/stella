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
// embedded by tools (search hits, document references, etc.). Today
// the only persisted carrier is `data-stella-source-document`; new
// workspace-scoped part types must be added here so a thread that
// embeds them widens its data scope correctly.
//
// Accepts `readonly unknown[]` and narrows per-part so this also
// handles legacy/migrated message shapes without forcing callers to
// pre-validate against the live `ChatMessage` union.
export const extractAssistantWorkspaceIds = (
  parts: readonly unknown[],
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  for (const part of parts) {
    const workspaceId = sourceDocumentWorkspaceId(part);
    if (workspaceId !== null) {
      ids.add(workspaceId);
    }
  }
  return Array.from(ids);
};

const sourceDocumentWorkspaceId = (
  part: unknown,
): SafeId<"workspace"> | null => {
  if (typeof part !== "object" || part === null) {
    return null;
  }
  if (!("type" in part) || part.type !== "data-stella-source-document") {
    return null;
  }
  if (
    !("data" in part) ||
    typeof part.data !== "object" ||
    part.data === null
  ) {
    return null;
  }
  if (!("workspaceId" in part.data)) {
    return null;
  }
  const workspaceId = part.data.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return null;
  }
  return brandPersistedWorkspaceId(workspaceId);
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
