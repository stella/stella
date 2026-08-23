import type { AuditSafeResult } from "../local";

const textResult = {
  operation: "anonymize",
  format: "text",
  outputCreated: true,
  sessionId: "session",
  entityCount: 1,
} as const satisfies AuditSafeResult;

const pdfResult = {
  operation: "anonymize",
  format: "pdf",
  outputCreated: true,
  pageCount: 1,
  entityCount: 1,
  mappedRegionCount: 1,
  structurePixelRewriteVerified: true,
  piiCleanGuaranteed: false,
} as const satisfies AuditSafeResult;

const pollutedPdfResult = {
  ...pdfResult,
  sessionId: "session",
} as const;

// @ts-expect-error PDF results cannot carry reversible-session state, even after construction.
const invalidPdfResult: AuditSafeResult = pollutedPdfResult;

const invalidInspectionResult = {
  operation: "inspect",
  format: "docx",
  outputCreated: true,
  blockCount: 1,
  coverageStatus: "full",
  // @ts-expect-error Inspection never creates an output file.
} as const satisfies AuditSafeResult;

const partialExternalTextCandidate = {
  ...textResult,
  externalDetectionBatchStatus: "accepted",
} as const;

// @ts-expect-error External-detection results must carry the complete audit trio.
const partialExternalTextResult: AuditSafeResult = partialExternalTextCandidate;

type StandardTextResult = Exclude<
  Extract<AuditSafeResult, { operation: "anonymize"; format: "text" }>,
  { externalDetectionBatchStatus: "accepted" }
>;

const standardTextResult = textResult satisfies StandardTextResult;

const pollutedStandardTextResult = {
  ...textResult,
  externalDetectionCount: 1,
} as const;

// @ts-expect-error Standard text results cannot carry external-detection fields after construction.
const invalidStandardTextResult: StandardTextResult =
  pollutedStandardTextResult;

void [
  textResult,
  pdfResult,
  invalidPdfResult,
  invalidInspectionResult,
  partialExternalTextResult,
  standardTextResult,
  invalidStandardTextResult,
];
