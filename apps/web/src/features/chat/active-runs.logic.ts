import { panic } from "better-result";

import type { ChatActiveRun } from "@stll/api-contract/chat";

/** Where one of the reader's chats stands while it is still open. */
export type ActiveChatRunState = ChatActiveRun["state"];

type WaitingChatRun = Extract<ChatActiveRun, { state: "needs-you" }>;
type WorkingChatRun = Extract<ChatActiveRun, { state: "working" }>;

/** The reader's open chats in one matter: waiting on them, and working. */
export type MatterRuns = {
  needsYou: readonly WaitingChatRun[];
  working: readonly WorkingChatRun[];
};

/**
 * Group the reader's open chats per matter, keeping the list's order. Chats
 * outside any matter count nowhere: the matter list is the only place these
 * runs are shown.
 */
export const matterRunsByWorkspace = (
  runs: readonly ChatActiveRun[],
): ReadonlyMap<string, MatterRuns> => {
  const byWorkspace = new Map<
    string,
    { needsYou: WaitingChatRun[]; working: WorkingChatRun[] }
  >();
  for (const run of runs) {
    if (run.workspaceId === null) {
      continue;
    }
    const current = byWorkspace.get(run.workspaceId) ?? {
      needsYou: [],
      working: [],
    };
    byWorkspace.set(run.workspaceId, current);
    switch (run.state) {
      case "needs-you":
        current.needsYou.push(run);
        break;
      case "working":
        current.working.push(run);
        break;
      default:
        run satisfies never;
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
  runs: MatterRuns | undefined,
): ActiveChatRunState | null => {
  if (runs === undefined) {
    return null;
  }
  if (runs.needsYou.length > 0) {
    return "needs-you";
  }
  return runs.working.length > 0 ? "working" : null;
};
