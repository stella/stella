import { deriveBlockId } from "@stll/folio-core/server";
import { stripDiacritics } from "@stll/text-normalize";

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

type Four<T> = readonly [T, T, T, T];
type Five<T> = readonly [T, T, T, T, T];
type Six<T> = readonly [T, T, T, T, T, T];
type Eight<T> = readonly [T, T, T, T, T, T, T, T];

/** Every review extract line a table cell cites, by citation field. */
type ExportReviewCitationField =
  | "document-type"
  | "counterparty"
  | "jurisdiction"
  | "governing-law"
  | "effective-date"
  | "expiry-date"
  | "contract-value"
  | "risk-level"
  | "evidence-quality"
  | "tags"
  | "key-obligation"
  | "risk-finding";

type ExportReviewColumn = { name: string; prompt: string };

/**
 * The data room's words in one locale. Lists are positional: a row's values
 * are picked by index, so every locale's room has the same shape, and the
 * agent thread that cites it tells the same story. Counterparty 3 and 7 hold
 * the two Critical customer and loan agreements the agent answers name.
 */
export type ExportReviewCopy = {
  folders: Six<string>;
  documentTypes: Eight<string>;
  counterparties: Eight<string>;
  jurisdictions: Five<string>;
  /** The governing law each jurisdiction's agreements state, by index. */
  governingLaws: Five<string>;
  /** Low, medium, high and critical, least severe first. */
  riskLevels: Four<string>;
  reviewStatuses: Four<string>;
  evidenceQuality: readonly [string, string, string];
  /** First tag of a row: change of control, termination, data room, renewal. */
  primaryTags: Four<string>;
  /** Second tag of a row: consent needed, pricing, privacy, security. */
  secondaryTags: Four<string>;
  keyObligation: (counterparty: string) => string;
  /** High and Critical rows get the elevated finding. */
  riskFinding: { elevated: string; ordinary: string };
  /** The contract value as the extract states it, e.g. "EUR 50000". */
  formatContractValue: (value: number) => string;
  /**
   * The review extract body. Its line layout is fixed (the citation block
   * indexes below count its lines), so a locale changes words, not lines.
   */
  extract: {
    heading: (documentType: string) => string;
    intro: (row: {
      counterparty: string;
      documentType: string;
      jurisdiction: string;
    }) => string;
    keyTerms: string;
    labels: {
      document: string;
      documentType: string;
      counterparty: string;
      jurisdiction: string;
      governingLaw: string;
      effectiveDate: string;
      expiryDate: string;
      contractValue: string;
      riskLevel: string;
      reviewStatus: string;
      evidenceQuality: string;
      tags: string;
    };
    keyObligation: string;
    riskFinding: string;
    underReview: string;
    clause: (row: { counterparty: string; governingLaw: string }) => string;
  };
  /** The table cell's justification for each cited value. */
  statements: Record<
    ExportReviewCitationField,
    (metadata: ExportReviewMetadata) => string
  >;
  columns: {
    documentType: ExportReviewColumn;
    counterparty: ExportReviewColumn;
    jurisdiction: ExportReviewColumn;
    governingLaw: ExportReviewColumn;
    effectiveDate: ExportReviewColumn;
    expiryDate: ExportReviewColumn;
    contractValue: ExportReviewColumn;
    riskLevel: ExportReviewColumn;
    /** Filled in by hand, so it has no prompt. */
    reviewStatus: { name: string };
    evidenceQuality: ExportReviewColumn;
    tags: ExportReviewColumn;
    keyObligation: ExportReviewColumn;
    riskFinding: ExportReviewColumn;
  };
};

// File names read like a real data room: the row's counterparty and document
// type joined with a vintage year, e.g. Aurora_Retail_Shareholder_Register_2018.docx.
// The counterparty/type indices mirror buildExportReviewMetadata exactly so a
// row's name always matches its metadata columns, and the year advances once
// per full (type, counterparty) cycle so all names stay unique. The marketing
// markers (@stll/playwright-tools/marketing-locales) name two of these files,
// and the agent thread's citations (seed-marketing-agent-thread.ts) cite them.
const fileNamePart = (value: string) => stripDiacritics(value);

export const buildExportReviewDocNames = (copy: ExportReviewCopy): string[] => {
  const result: string[] = [];

  for (let i = 0; i < EXPORT_TABLE_FILE_COUNT; i++) {
    const documentType = at(copy.documentTypes, i % copy.documentTypes.length);
    const counterparty = at(
      copy.counterparties,
      (i * 3) % copy.counterparties.length,
    );
    const counterpartyName = fileNamePart(counterparty)
      .split(" ")
      .slice(0, 2)
      .join("_")
      .replaceAll(/[^\w]/gu, "");
    const year = 2018 + Math.floor(i / copy.documentTypes.length);
    const extension = i % 9 === 0 ? "docx" : "pdf";
    result.push(
      `${counterpartyName}_${fileNamePart(documentType).replaceAll(" ", "_")}_${year}.${extension}`,
    );
  }

  return result;
};

export type ExportReviewMetadata = {
  documentType: string;
  counterparty: string;
  jurisdiction: string;
  governingLaw: string;
  effectiveDate: string;
  expiryDate: string;
  contractValue: number;
  /** One of the copy's `riskLevels`. */
  riskLevel: string;
  reviewStatus: string;
  evidenceQuality: string;
  /** The primary tag, then the secondary tag. */
  tags: readonly [string, string];
  keyObligation: string;
  riskFinding: string;
  pageNumber: number;
};

const addDays = (date: Date, days: number): string => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy.toISOString().slice(0, 10);
};

/** Whether a risk level is High or Critical. */
export const isElevatedRisk = (copy: ExportReviewCopy, riskLevel: string) =>
  copy.riskLevels.indexOf(riskLevel) >= 2;

export const buildExportReviewMetadata = (
  copy: ExportReviewCopy,
  index: number,
): ExportReviewMetadata => {
  const documentType = at(
    copy.documentTypes,
    index % copy.documentTypes.length,
  );
  const counterparty = at(
    copy.counterparties,
    (index * 3) % copy.counterparties.length,
  );
  // Stride must stay coprime with the list length or the "cycle" is a
  // constant: the old *5 stride on this length-5 list pinned every row to
  // one jurisdiction, which read as filler on camera. *2 varies row by row
  // and keeps index 0 on the third jurisdiction, which the review-citation
  // recording's paint predicate quotes verbatim.
  const jurisdictionIndex = (index * 2 + 2) % copy.jurisdictions.length;
  const riskLevel = at(copy.riskLevels, (index * 7) % copy.riskLevels.length);
  const effectiveDate = addDays(new Date(2024, 0, 1), index * 11);
  const expiryDate = addDays(new Date(2026, 0, 1), index * 17);
  const contractValue = 50_000 + ((index * 137_500) % 4_950_000);

  return {
    documentType,
    counterparty,
    jurisdiction: at(copy.jurisdictions, jurisdictionIndex),
    governingLaw: at(copy.governingLaws, jurisdictionIndex),
    effectiveDate,
    expiryDate,
    contractValue,
    riskLevel,
    reviewStatus: at(copy.reviewStatuses, index % copy.reviewStatuses.length),
    evidenceQuality: at(
      copy.evidenceQuality,
      index % copy.evidenceQuality.length,
    ),
    tags: [
      at(copy.primaryTags, index % 4),
      at(copy.secondaryTags, (index + 1) % 4),
    ],
    keyObligation: copy.keyObligation(counterparty),
    riskFinding: isElevatedRisk(copy, riskLevel)
      ? copy.riskFinding.elevated
      : copy.riskFinding.ordinary,
    pageNumber: (index % 4) + 1,
  };
};

export const buildExportReviewDocumentText = (
  copy: ExportReviewCopy,
  fileName: string,
  index: number,
): string => {
  const metadata = buildExportReviewMetadata(copy, index);
  const { extract } = copy;
  const { labels } = extract;
  return `${extract.heading(metadata.documentType)}

${extract.intro(metadata)}

${extract.keyTerms}
${labels.document}: ${fileName}
${labels.documentType}: ${metadata.documentType}
${labels.counterparty}: ${metadata.counterparty}
${labels.jurisdiction}: ${metadata.jurisdiction}
${labels.governingLaw}: ${metadata.governingLaw}
${labels.effectiveDate}: ${metadata.effectiveDate}
${labels.expiryDate}: ${metadata.expiryDate}
${labels.contractValue}: ${copy.formatContractValue(metadata.contractValue)}
${labels.riskLevel}: ${metadata.riskLevel}
${labels.reviewStatus}: ${metadata.reviewStatus}
${labels.evidenceQuality}: ${metadata.evidenceQuality}
${labels.tags}: ${metadata.tags.join(", ")}

${extract.keyObligation}
${metadata.keyObligation}

${extract.riskFinding}
${metadata.riskFinding}

${extract.underReview}
${extract.clause(metadata)}`;
};

export type ExportReviewCitationSeed = {
  fieldSuffix: ExportReviewCitationField;
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
  copy: ExportReviewCopy,
  metadata: ExportReviewMetadata,
): ExportReviewCitationSeed[] => {
  const { labels } = copy.extract;
  const line = (
    fieldSuffix: ExportReviewCitationField,
    label: string,
    value: string,
    blockIndex: number,
  ): ExportReviewCitationSeed => ({
    fieldSuffix,
    statement: copy.statements[fieldSuffix](metadata),
    quote: `${label}: ${value}`,
    blockIndex,
  });
  return [
    line("document-type", labels.documentType, metadata.documentType, 6),
    line("counterparty", labels.counterparty, metadata.counterparty, 7),
    line("jurisdiction", labels.jurisdiction, metadata.jurisdiction, 8),
    line("governing-law", labels.governingLaw, metadata.governingLaw, 9),
    line("effective-date", labels.effectiveDate, metadata.effectiveDate, 10),
    line("expiry-date", labels.expiryDate, metadata.expiryDate, 11),
    line(
      "contract-value",
      labels.contractValue,
      copy.formatContractValue(metadata.contractValue),
      12,
    ),
    line("risk-level", labels.riskLevel, metadata.riskLevel, 13),
    // Position 14 is the review status line (not a citation field);
    // evidence quality is the next line.
    line(
      "evidence-quality",
      labels.evidenceQuality,
      metadata.evidenceQuality,
      15,
    ),
    line("tags", labels.tags, metadata.tags.join(", "), 16),
    {
      fieldSuffix: "key-obligation",
      statement: copy.statements["key-obligation"](metadata),
      quote: metadata.keyObligation,
      // Position 17 is the key obligation heading; the obligation text
      // itself is the next line.
      blockIndex: 18,
    },
    {
      fieldSuffix: "risk-finding",
      statement: copy.statements["risk-finding"](metadata),
      quote: metadata.riskFinding,
      // Position 19 is the risk finding heading; the finding text itself
      // is the next line.
      blockIndex: 20,
    },
  ];
};

/** The folio block id a DOCX citation seed resolves to. */
export const exportReviewCitationBlockId = (
  citationSeed: Pick<ExportReviewCitationSeed, "blockIndex">,
): string =>
  deriveBlockId({
    paraId: null,
    index: citationSeed.blockIndex,
    taken: new Set(),
  });
