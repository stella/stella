import { panic } from "better-result";

/** Inspector view kind for the playbook a chat thread is building. */
export const PLAYBOOK_DRAFT_VIEW = "playbook-draft";

/**
 * Plain values only: the payload crosses the inspector's structured-clone
 * boundary and is persisted. `pending` is the pane of a chat that has not
 * saved a playbook yet; the first save turns it into `playbook`.
 */
export type PlaybookDraftViewPayload =
  { type: "pending" } | { type: "playbook"; playbookId: string };

export const isPlaybookDraftViewPayload = (
  value: unknown,
): value is PlaybookDraftViewPayload => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "pending") {
    return true;
  }
  return (
    value.type === "playbook" &&
    "playbookId" in value &&
    typeof value.playbookId === "string" &&
    value.playbookId.length > 0
  );
};

/** What a reload restores: the payload's own fields, nothing else. */
export const projectPlaybookDraftViewPayload = (
  payload: PlaybookDraftViewPayload,
): PlaybookDraftViewPayload => {
  switch (payload.type) {
    case "pending":
      return { type: "pending" };
    case "playbook":
      return { type: "playbook", playbookId: payload.playbookId };
    default:
      payload satisfies never;
      return panic("Unhandled playbook pane payload");
  }
};

/** One pane per chat thread: a thread that moves on to another playbook
 *  points the same tab at it. */
export const playbookDraftTabId = (threadId: string): string =>
  `${PLAYBOOK_DRAFT_VIEW}:${threadId}`;
