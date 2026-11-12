import { panic } from "better-result";

import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import type { ChatActiveRunState } from "@stll/api-contract/chat";

type ActiveChatRunPlacement = {
  state: ChatActiveRunState;
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
      case CHAT_ACTIVE_RUN_STATE.needsYou:
        byWorkspace.set(workspaceId, {
          ...current,
          needsYou: current.needsYou + 1,
        });
        break;
      case CHAT_ACTIVE_RUN_STATE.working:
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
): ChatActiveRunState | null => {
  if (status === undefined) {
    return null;
  }
  if (status.needsYou > 0) {
    return CHAT_ACTIVE_RUN_STATE.needsYou;
  }
  return status.working > 0 ? CHAT_ACTIVE_RUN_STATE.working : null;
};
