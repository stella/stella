/** Inspector view kind for one inbox signal's evidence. */
export const INBOX_SIGNAL_VIEW = "inbox-signal";

/** Plain values only: the payload crosses the inspector's structured-clone boundary. */
export type InboxSignalViewPayload = {
  signalId: string;
};

export const isInboxSignalViewPayload = (
  value: unknown,
): value is InboxSignalViewPayload =>
  typeof value === "object" &&
  value !== null &&
  "signalId" in value &&
  typeof value.signalId === "string" &&
  value.signalId.length > 0;

export const inboxSignalTabId = (signalId: string): string =>
  `${INBOX_SIGNAL_VIEW}:${signalId}`;
