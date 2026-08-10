export const OFFICE_EVIDENCE_FORMATS = ["xlsx", "pptx"] as const;

export const OFFICE_EVIDENCE_FORMAT = {
  pptx: OFFICE_EVIDENCE_FORMATS[1],
  xlsx: OFFICE_EVIDENCE_FORMATS[0],
} as const;

export type OfficeEvidenceFormat = (typeof OFFICE_EVIDENCE_FORMATS)[number];

export const OFFICE_EVIDENCE_LIMITS = {
  blockTextMaxChars: 500,
  blocksMax: 160,
  verificationParserVersionsMax: 8,
  workerOutputMaxBytes: 512 * 1024,
  workerTimeoutMs: 30_000,
} as const;

export const OFFICE_EVIDENCE_STATUSES = [
  "processing",
  "available",
  "unavailable",
] as const;

export const OFFICE_EVIDENCE_STATUS = {
  available: OFFICE_EVIDENCE_STATUSES[1],
  processing: OFFICE_EVIDENCE_STATUSES[0],
  unavailable: OFFICE_EVIDENCE_STATUSES[2],
} as const;

export type OfficeEvidenceStatus = (typeof OFFICE_EVIDENCE_STATUSES)[number];

export const OFFICE_EVIDENCE_UNAVAILABLE_CODES = [
  "parse_failed",
  "resource_limit",
] as const;

export const OFFICE_EVIDENCE_UNAVAILABLE_CODE = {
  parseFailed: OFFICE_EVIDENCE_UNAVAILABLE_CODES[0],
  resourceLimit: OFFICE_EVIDENCE_UNAVAILABLE_CODES[1],
} as const;

export type OfficeEvidenceUnavailableCode =
  (typeof OFFICE_EVIDENCE_UNAVAILABLE_CODES)[number];
