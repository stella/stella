import {
  CORRESPONDENCE_MAX_ATTACHMENTS,
  CORRESPONDENCE_MAX_BODY_CHARACTERS,
} from "@stll/api-contract/correspondence";

export const INBOUND_MAIL_LIMITS = {
  rawBytes: 25 * 1024 * 1024,
  bodyBytes: 2 * 1024 * 1024,
  bodyCharacters: CORRESPONDENCE_MAX_BODY_CHARACTERS,
  attachmentBytes: 10 * 1024 * 1024,
  attachmentCount: CORRESPONDENCE_MAX_ATTACHMENTS,
  recipients: 100,
  mimeDepth: 20,
  headerBytes: 64 * 1024,
  dnsQueries: 40,
  dnsTimeoutMs: 3000,
  authenticationTimeoutMs: 15_000,
  providerTimeoutMs: 30_000,
} as const;
