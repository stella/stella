/** Inspector view kind for the playbook a chat thread is building. */
export const PLAYBOOK_DRAFT_VIEW = "playbook-draft";

/**
 * Plain values only: the payload crosses the inspector's structured-clone
 * boundary and is persisted. `type` names the kind of pane, so a stored tab
 * keeps validating when a second kind is added.
 */
export type PlaybookDraftViewPayload = { type: "playbook"; playbookId: string };

export const isPlaybookDraftViewPayload = (
  value: unknown,
): value is PlaybookDraftViewPayload =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "playbook" &&
  "playbookId" in value &&
  typeof value.playbookId === "string" &&
  value.playbookId.length > 0;

/** What a reload restores: the payload's own fields, nothing else. */
export const projectPlaybookDraftViewPayload = ({
  playbookId,
}: PlaybookDraftViewPayload): PlaybookDraftViewPayload => ({
  type: "playbook",
  playbookId,
});

/** One pane per chat thread: a thread that moves on to another playbook
 *  points the same tab at it. */
export const playbookDraftTabId = (threadId: string): string =>
  `${PLAYBOOK_DRAFT_VIEW}:${threadId}`;
