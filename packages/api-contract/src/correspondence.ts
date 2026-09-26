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

export const CORRESPONDENCE_MAX_ATTACHMENTS = 25;

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

export const CORRESPONDENCE_INTAKES = [
  "direct",
  "forwarded_inline",
  "forwarded_attachment",
] as const;

export type CorrespondenceAuthenticatedSender = CorrespondenceAuthentication & {
  address: string;
};

export type CorrespondenceOriginalSignature =
  | { status: "unverified" }
  | { status: "verified"; domain: string };

/** Extracted headers are assertions; only the outer delivery is authenticated. */
export type CorrespondenceProvenance = {
  authenticatedSender: CorrespondenceAuthenticatedSender;
} & (
  | { intake: "direct"; originalSignature: null }
  | { intake: "forwarded_inline"; originalSignature: { status: "unverified" } }
  | {
      intake: "forwarded_attachment";
      originalSignature: CorrespondenceOriginalSignature;
    }
);

export const CORRESPONDENCE_SENDER_KINDS = [
  "verified_alias",
  "shared_mailbox",
] as const;
export type CorrespondenceSenderKind =
  (typeof CORRESPONDENCE_SENDER_KINDS)[number];

export const CORRESPONDENCE_SENDER_SCOPES = [
  "organization",
  "matters",
] as const;
export type CorrespondenceSenderScope =
  (typeof CORRESPONDENCE_SENDER_SCOPES)[number];

export type CorrespondenceFiler =
  | {
      type: "user";
      userId: string;
      userName: string | null;
      userStatus: "active" | "deleted";
      filedAt: string;
    }
  | {
      type: "shared_mailbox";
      allowedSenderId: string;
      address: string;
      approvedBy: string;
      approvedByName: string | null;
      approvedByStatus: "active" | "deleted";
      filedAt: string;
    };

/** The parser's output. The authenticated filer is supplied separately. */
export type ParsedCorrespondence = CorrespondenceProvenance & {
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
};
