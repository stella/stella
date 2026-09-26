import { CORRESPONDENCE_LIMITS } from "@stll/api-contract/correspondence";

export const INBOUND_MAIL_LIMITS = {
  rawBytes: 25 * 1024 * 1024,
  bodyBytes: 2 * 1024 * 1024,
  bodyCharacters: CORRESPONDENCE_LIMITS.bodyCharacters,
  attachmentBytes: 10 * 1024 * 1024,
  attachmentCount: CORRESPONDENCE_LIMITS.attachments,
  recipients: 100,
  mimeDepth: 20,
  headerBytes: 64 * 1024,
  dnsQueries: 40,
  dnsTimeoutMs: 3000,
  authenticationTimeoutMs: 15_000,
  providerTimeoutMs: 30_000,
} as const;
