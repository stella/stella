import { deriveBlockId } from "@stll/folio-core/server";

import { at, seedId } from "./seed-utils";

// The Export Review ("Project Atlas data room") matter's synthetic document
// model: file names, per-row metadata, the review-extract body text and the
// citation seeds that point into it. The dev seed writes these documents and
// their review table; the marketing agent thread cites the same rows, so both
// read one source of truth here.

export const EXPORT_TABLE_MATTER_LABEL = "ws-export-review";
const EXPORT_TABLE_FILE_COUNT = 72;
export const EXPORT_TABLE_FOLDER_COUNT = 6;

/**
 * The seeded ids of export-review row `index` (0-based): its document entity,
 * that entity's version, and the version's file field. The dev seed writes
 * rows under these ids; citations into a row are built from them.
 */
export const exportReviewDocumentIds = (index: number) => ({
  entityId: seedId<"entity">(`${EXPORT_TABLE_MATTER_LABEL}-doc-${index + 1}`),
  entityVersionId: seedId<"entityVersion">(
    `${EXPORT_TABLE_MATTER_LABEL}-doc-${index + 1}-v`,
  ),
  fileFieldId: seedId<"field">(
    `${EXPORT_TABLE_MATTER_LABEL}-field-file-${index}`,
  ),
});

export const EXPORT_REVIEW_FOLDERS = [
  "Corporate",
  "Commercial",
  "Employment",
  "Regulatory",
  "Finance",
  "Real Estate",
] as const;

export const EXPORT_REVIEW_DOCUMENT_TYPES = [
  "Shareholder Register",
  "Customer Contract",
  "Supplier Agreement",
  "Employment Agreement",
  "Permit",
  "Loan Agreement",
  "Lease",
  "Insurance Policy",
] as const;

const EXPORT_REVIEW_COUNTERPARTIES = [
  "Aurora Retail GmbH",
  "BluePeak Manufacturing s.r.o.",
  "Cedar Cloud Ltd.",
  "Delta Logistics Kft.",
  "Edison Bank plc",
  "Fjord Analytics AB",
  "Granite Properties B.V.",
  "Helios Energy a.s.",
] as const;

export const EXPORT_REVIEW_JURISDICTIONS = [
  "Czech Republic",
  "Germany",
  "Netherlands",
  "Hungary",
  "United Kingdom",
] as const;

export const EXPORT_REVIEW_RISK_LEVELS = [
  "Low",
  "Medium",
  "High",
  "Critical",
] as const;

const EXPORT_REVIEW_REVIEW_STATUSES = [
  "Not Started",
  "In Review",
  "Needs Partner",
  "Cleared",
] as const;

const EXPORT_REVIEW_EVIDENCE_QUALITY = [
  "Direct citation",
  "Needs source check",
  "Conflicting evidence",
] as const;

// File names read like a real data room: the row's counterparty and document
// type joined with a vintage year, e.g. Aurora_Retail_Shareholder_Register_2018.docx.
// The counterparty/type indices mirror buildExportReviewMetadata exactly so a
// row's name always matches its metadata columns, and the year advances once
// per full (type, counterparty) cycle so all names stay unique. The marketing
// recorder's content markers reference these names; keep them in sync
// (apps/web/e2e/marketing/record-product-story.ts) and the agent thread's
// citations (seed-marketing-agent-thread.ts).
const buildExportReviewDocNames = (): string[] => {
  const result: string[] = [];

  for (let i = 0; i < EXPORT_TABLE_FILE_COUNT; i++) {
    const documentType = at(
      EXPORT_REVIEW_DOCUMENT_TYPES,
      i % EXPORT_REVIEW_DOCUMENT_TYPES.length,
    );
    const counterparty = at(
      EXPORT_REVIEW_COUNTERPARTIES,
      (i * 3) % EXPORT_REVIEW_COUNTERPARTIES.length,
    );
    const counterpartyName = counterparty
      .split(" ")
      .slice(0, 2)
      .join("_")
      .replaceAll(/[^\w]/gu, "");
    const year = 2018 + Math.floor(i / EXPORT_REVIEW_DOCUMENT_TYPES.length);
    const extension = i % 9 === 0 ? "docx" : "pdf";
    result.push(
      `${counterpartyName}_${documentType.replaceAll(" ", "_")}_${year}.${extension}`,
    );
  }

  return result;
};

export const EXPORT_REVIEW_DOC_NAMES = buildExportReviewDocNames();

export type ExportReviewMetadata = {
  documentType: (typeof EXPORT_REVIEW_DOCUMENT_TYPES)[number];
  counterparty: (typeof EXPORT_REVIEW_COUNTERPARTIES)[number];
  jurisdiction: (typeof EXPORT_REVIEW_JURISDICTIONS)[number];
  governingLaw: string;
  effectiveDate: string;
  expiryDate: string;
  contractValue: number;
  riskLevel: (typeof EXPORT_REVIEW_RISK_LEVELS)[number];
  reviewStatus: (typeof EXPORT_REVIEW_REVIEW_STATUSES)[number];
  evidenceQuality: (typeof EXPORT_REVIEW_EVIDENCE_QUALITY)[number];
  tags: string[];
  keyObligation: string;
  riskFinding: string;
  pageNumber: number;
};

const addDays = (date: Date, days: number): string => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy.toISOString().slice(0, 10);
};

export const buildExportReviewMetadata = (
  index: number,
): ExportReviewMetadata => {
  const documentType = at(
    EXPORT_REVIEW_DOCUMENT_TYPES,
    index % EXPORT_REVIEW_DOCUMENT_TYPES.length,
  );
  const counterparty = at(
    EXPORT_REVIEW_COUNTERPARTIES,
    (index * 3) % EXPORT_REVIEW_COUNTERPARTIES.length,
  );
  const jurisdiction = at(
    EXPORT_REVIEW_JURISDICTIONS,
    // Stride must stay coprime with the list length or the "cycle" is a
    // constant: the old *5 stride on this length-5 list pinned every row to
    // Netherlands, which read as filler on camera. *2 varies row by row and
    // keeps index 0 on Netherlands, which the review-citation recording's
    // paint predicate quotes verbatim.
    (index * 2 + 2) % EXPORT_REVIEW_JURISDICTIONS.length,
  );
  const riskLevel = at(
    EXPORT_REVIEW_RISK_LEVELS,
    (index * 7) % EXPORT_REVIEW_RISK_LEVELS.length,
  );
  const effectiveDate = addDays(new Date(2024, 0, 1), index * 11);
  const expiryDate = addDays(new Date(2026, 0, 1), index * 17);
  const contractValue = 50_000 + ((index * 137_500) % 4_950_000);
  const reviewStatus = at(
    EXPORT_REVIEW_REVIEW_STATUSES,
    index % EXPORT_REVIEW_REVIEW_STATUSES.length,
  );
  const evidenceQuality = at(
    EXPORT_REVIEW_EVIDENCE_QUALITY,
    index % EXPORT_REVIEW_EVIDENCE_QUALITY.length,
  );
  const tags = [
    at(["change of control", "termination", "data room", "renewal"], index % 4),
    at(["consent needed", "pricing", "privacy", "security"], (index + 1) % 4),
  ];

  return {
    documentType,
    counterparty,
    jurisdiction,
    governingLaw:
      jurisdiction === "United Kingdom" ? "England and Wales" : jurisdiction,
    effectiveDate,
    expiryDate,
    contractValue,
    riskLevel,
    reviewStatus,
    evidenceQuality,
    tags,
    keyObligation: `${counterparty} must provide written notice before any assignment, renewal, or material service change.`,
    riskFinding:
      riskLevel === "High" || riskLevel === "Critical"
        ? "Consent, notice, or termination rights require partner review before signing."
        : "No blocking issue identified; confirm ordinary-course compliance before closing.",
    pageNumber: (index % 4) + 1,
  };
};

export const buildExportReviewDocumentText = (
  fileName: string,
  index: number,
): string => {
  const metadata = buildExportReviewMetadata(index);
  return `${metadata.documentType.toUpperCase()} — REVIEW EXTRACT

${metadata.counterparty}, based in ${metadata.jurisdiction}, is party to this ${metadata.documentType.toLowerCase()} under review as part of the Project Atlas data room.

Key terms
Document: ${fileName}
Document type: ${metadata.documentType}
Counterparty: ${metadata.counterparty}
Jurisdiction: ${metadata.jurisdiction}
Governing law: ${metadata.governingLaw}
Effective date: ${metadata.effectiveDate}
Expiry date: ${metadata.expiryDate}
Contract value: EUR ${metadata.contractValue}
Risk level: ${metadata.riskLevel}
Review status: ${metadata.reviewStatus}
Evidence quality: ${metadata.evidenceQuality}
Tags: ${metadata.tags.join(", ")}

Key obligation
${metadata.keyObligation}

Risk finding
${metadata.riskFinding}

Extract under review:
"${metadata.counterparty} must comply with the obligation identified above and the governing law is ${metadata.governingLaw}."`;
};

export type ExportReviewCitationSeed = {
  fieldSuffix: string;
  statement: string;
  quote: string;
  /**
   * The citation's 1-based position in folio's non-empty-block walk
   * (`getSequentialFolioBlockIdIndex`/`deriveBlockId` in
   * `@stll/folio-core/types/block-id`), fixed to this field's line in the
   * `createMockDocx(title, buildExportReviewDocumentText(...))` layout: a
   * leading title block (1), then one block per non-blank line of
   * `buildExportReviewDocumentText`'s template, blank lines uncounted.
   * Keep this in sync with that template — every docx-folio citation below
   * only resolves to an exact-passage highlight (vs. a degraded block
   * flash) when this points at the paragraph that actually contains
   * `quote`.
   */
  blockIndex: number;
};

export const buildExportReviewCitationSeeds = (
  metadata: ExportReviewMetadata,
): ExportReviewCitationSeed[] => [
  {
    fieldSuffix: "document-type",
    statement: `Document type extracted as ${metadata.documentType}.`,
    quote: `Document type: ${metadata.documentType}`,
    blockIndex: 6,
  },
  {
    fieldSuffix: "counterparty",
    statement: `Counterparty extracted as ${metadata.counterparty}.`,
    quote: `Counterparty: ${metadata.counterparty}`,
    blockIndex: 7,
  },
  {
    fieldSuffix: "jurisdiction",
    statement: `Jurisdiction extracted as ${metadata.jurisdiction}.`,
    quote: `Jurisdiction: ${metadata.jurisdiction}`,
    blockIndex: 8,
  },
  {
    fieldSuffix: "governing-law",
    statement: `Governing law extracted as ${metadata.governingLaw}.`,
    quote: `Governing law: ${metadata.governingLaw}`,
    blockIndex: 9,
  },
  {
    fieldSuffix: "effective-date",
    statement: `Effective date extracted as ${metadata.effectiveDate}.`,
    quote: `Effective date: ${metadata.effectiveDate}`,
    blockIndex: 10,
  },
  {
    fieldSuffix: "expiry-date",
    statement: `Expiry date extracted as ${metadata.expiryDate}.`,
    quote: `Expiry date: ${metadata.expiryDate}`,
    blockIndex: 11,
  },
  {
    fieldSuffix: "contract-value",
    statement: `Contract value extracted as EUR ${metadata.contractValue}.`,
    quote: `Contract value: EUR ${metadata.contractValue}`,
    blockIndex: 12,
  },
  {
    fieldSuffix: "risk-level",
    statement: `Risk level classified as ${metadata.riskLevel}.`,
    quote: `Risk level: ${metadata.riskLevel}`,
    blockIndex: 13,
  },
  {
    fieldSuffix: "evidence-quality",
    statement: `Evidence quality classified as ${metadata.evidenceQuality}.`,
    quote: `Evidence quality: ${metadata.evidenceQuality}`,
    // Position 14 is "Review status: ..." (not a citation field); evidence
    // quality is the next line.
    blockIndex: 15,
  },
  {
    fieldSuffix: "tags",
    statement: `Tags extracted as ${metadata.tags.join(", ")}.`,
    quote: `Tags: ${metadata.tags.join(", ")}`,
    blockIndex: 16,
  },
  {
    fieldSuffix: "key-obligation",
    statement: "Key obligation extracted from the obligation section.",
    quote: metadata.keyObligation,
    // Position 17 is the "Key obligation" heading; the obligation text
    // itself is the next line.
    blockIndex: 18,
  },
  {
    fieldSuffix: "risk-finding",
    statement: "Risk finding extracted from the risk section.",
    quote: metadata.riskFinding,
    // Position 19 is the "Risk finding" heading; the finding text itself
    // is the next line.
    blockIndex: 20,
  },
];

/** The folio block id a DOCX citation seed resolves to. */
export const exportReviewCitationBlockId = (
  citationSeed: Pick<ExportReviewCitationSeed, "blockIndex">,
): string =>
  deriveBlockId({
    paraId: null,
    index: citationSeed.blockIndex,
    taken: new Set(),
  });
