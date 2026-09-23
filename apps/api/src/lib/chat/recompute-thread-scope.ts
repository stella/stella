/**
 * Recomputes a stored chat thread's data scope from its persisted messages
 * with the same extractor the live turn uses (`extractThreadDataWorkspaceIds`),
 * so stored scope and runtime scope follow one rule. Scope only ever widens:
 * a recompute adds workspaces the messages carry and never removes one.
 */
import { extractThreadDataWorkspaceIds } from "@/api/handlers/chat/data-scope";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";

type StoredThread = {
  id: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  dataWorkspaceIds: readonly SafeId<"workspace">[];
};

type PlanThreadScopeAdditionsInput = {
  threads: readonly StoredThread[];
  messagesByThreadId: ReadonlyMap<string, readonly ChatMessage[]>;
  /** Organization of every workspace id the messages mention that exists. */
  workspaceOrganizationById: ReadonlyMap<string, string>;
};

export type ThreadScopeAddition = {
  threadId: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  additions: SafeId<"workspace">[];
};

/**
 * Workspace ids each thread's messages carry that its stored scope lacks.
 * An id is only added when the workspace exists in the thread's own
 * organization; anything else is not a workspace this thread can scope to.
 */
export const planThreadScopeAdditions = ({
  messagesByThreadId,
  threads,
  workspaceOrganizationById,
}: PlanThreadScopeAdditionsInput): ThreadScopeAddition[] => {
  const planned: ThreadScopeAddition[] = [];
  for (const thread of threads) {
    const stored = new Set<string>(thread.dataWorkspaceIds);
    const additions = extractThreadDataWorkspaceIds(
      messagesByThreadId.get(thread.id) ?? [],
    ).filter(
      (candidate) =>
        !stored.has(candidate) &&
        workspaceOrganizationById.get(candidate) === thread.organizationId,
    );
    if (additions.length > 0) {
      planned.push({
        threadId: thread.id,
        organizationId: thread.organizationId,
        additions,
      });
    }
  }
  return planned;
};

/** Every workspace id any of the given messages carries, for one lookup. */
export const collectMessageWorkspaceIds = (
  messagesByThreadId: ReadonlyMap<string, readonly ChatMessage[]>,
): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  for (const messages of messagesByThreadId.values()) {
    for (const candidate of extractThreadDataWorkspaceIds(messages)) {
      ids.add(candidate);
    }
  }
  return [...ids];
};
