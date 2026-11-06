import { panic } from "better-result";

/** Where one of the reader's chats stands while it is still open. */
export type ActiveChatRunState = "needs-you" | "working";

type ActiveChatRunPlacement = {
  state: ActiveChatRunState;
  workspaceId: string | null;
};

/** How many of the reader's chats in one matter wait on them or are working. */
export type MatterRunStatus = {
  needsYou: number;
  working: number;
};

/**
 * Count the reader's open chats per matter. Chats outside any matter count
 * nowhere: the matter list is the only place these counts are shown.
 */
export const matterRunStatusByWorkspace = (
  runs: readonly ActiveChatRunPlacement[],
): ReadonlyMap<string, MatterRunStatus> => {
  const byWorkspace = new Map<string, MatterRunStatus>();
  for (const { state, workspaceId } of runs) {
    if (workspaceId === null) {
      continue;
    }
    const current = byWorkspace.get(workspaceId) ?? {
      needsYou: 0,
      working: 0,
    };
    switch (state) {
      case "needs-you":
        byWorkspace.set(workspaceId, {
          ...current,
          needsYou: current.needsYou + 1,
        });
        break;
      case "working":
        byWorkspace.set(workspaceId, {
          ...current,
          working: current.working + 1,
        });
        break;
      default:
        state satisfies never;
        panic("Unhandled active chat run state");
    }
  }
  return byWorkspace;
};

/**
 * The one state a matter shows where there is room for a single mark (the
 * collapsed rail): waiting on the reader outranks work in progress.
 */
export const topMatterRunState = (
  status: MatterRunStatus | undefined,
): ActiveChatRunState | null => {
  if (status === undefined) {
    return null;
  }
  if (status.needsYou > 0) {
    return "needs-you";
  }
  return status.working > 0 ? "working" : null;
};
