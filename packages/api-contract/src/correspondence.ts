export const CORRESPONDENCE_CHANNELS = ["email"] as const;
export type CorrespondenceChannel = (typeof CORRESPONDENCE_CHANNELS)[number];

export const CORRESPONDENCE_DIRECTIONS = ["in", "out"] as const;
export type CorrespondenceDirection =
  (typeof CORRESPONDENCE_DIRECTIONS)[number];

export const CORRESPONDENCE_HANDLING_STATES = ["new", "handled"] as const;
export type CorrespondenceHandlingState =
  (typeof CORRESPONDENCE_HANDLING_STATES)[number];

export const CORRESPONDENCE_AUTH_RESULTS = [
  "pass",
  "fail",
  "none",
  "unknown",
] as const;
export type CorrespondenceAuthResult =
  (typeof CORRESPONDENCE_AUTH_RESULTS)[number];

export const CORRESPONDENCE_SCAN_VERDICTS = [
  "clean",
  "infected",
  "unknown",
] as const;
export type CorrespondenceScanVerdict =
  (typeof CORRESPONDENCE_SCAN_VERDICTS)[number];

export const CORRESPONDENCE_DROP_REASONS = [
  "unknown_recipient",
  "revoked_address",
  "unauthorized_sender",
  "authentication_failed",
  "message_too_large",
  "attachment_rejected",
  "malformed_message",
] as const;
export type CorrespondenceDropReason =
  (typeof CORRESPONDENCE_DROP_REASONS)[number];

export type CorrespondenceAddress = {
  address: string;
  name: string | null;
};

export type CorrespondenceAuthentication = {
  spf: CorrespondenceAuthResult;
  dkim: CorrespondenceAuthResult;
  dmarc: CorrespondenceAuthResult;
  alignedIdentifier: string | null;
};

/** The parser's output. The authenticated filer is supplied separately. */
export type ParsedCorrespondence = {
  direction: CorrespondenceDirection;
  channel: CorrespondenceChannel;
  messageId: string | null;
  contentHash: string;
  from: CorrespondenceAddress;
  to: CorrespondenceAddress[];
  cc: CorrespondenceAddress[];
  subject: string;
  sentAt: string | null;
  receivedAt: string;
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
  bodyHtml: string | null;
  authentication: CorrespondenceAuthentication;
};
