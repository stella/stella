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

export const findInboundHeaderEnd = (raw: Uint8Array): number | null => {
  const searchEnd = Math.min(
    raw.byteLength,
    INBOUND_MAIL_LIMITS.headerBytes + 4,
  );
  let headerEnd = -1;
  for (let index = 0; index < searchEnd - 1; index += 1) {
    if (raw[index] === 10 && raw[index + 1] === 10) {
      headerEnd = index;
      break;
    }
    if (
      raw[index] === 13 &&
      raw[index + 1] === 10 &&
      raw[index + 2] === 13 &&
      raw[index + 3] === 10
    ) {
      headerEnd = index;
      break;
    }
  }
  if (headerEnd >= 0) {
    return headerEnd;
  }
  // RFC 5322 allows a message with headers and no body, so no separator line.
  return raw.byteLength <= INBOUND_MAIL_LIMITS.headerBytes
    ? raw.byteLength
    : null;
};
