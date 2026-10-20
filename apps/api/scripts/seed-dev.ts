import { panic } from "better-result";
/**
 * Seed realistic test data for local development.
 *
 * Creates contacts (organizations + people) with billing data,
 * workspaces (matters) linked to clients, properties, views,
 * entities, files (PDF/DOCX uploaded to S3), fields, workspace
 * parties, and time entries.
 *
 * Deterministic IDs via `seedId()` so re-running is idempotent. Seed-owned
 * document names and content are upserted so fixture changes reach existing
 * development databases as well as fresh CI databases.
 *
 * Usage:
 *   bun apps/api/scripts/seed-dev.ts
 *
 * By default the CLI seeds the most recently active local
 * browser session's organization. Override with:
 *   STELLA_SEED_ORG_ID=... STELLA_SEED_USER_ID=...
 *
 * Prerequisites:
 *   - Database running (bun run docker:dev)
 *   - Test user seeded (bun run db:seed-test-user)
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  ExpenseCategory,
  InvoiceStatus,
  TimeEntryStatus,
  WorkspaceContactRole,
} from "@stll/api-contract";
import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { mapWithConcurrency } from "@stll/concurrency";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import type { ConditionNode } from "@stll/conditions";
import { writeZipEntry } from "@stll/docx-utils";
import { logErrorOutput, printError } from "@stll/errors";
import { timeEntryAmount } from "@stll/money";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import {
  billingCodes,
  chatMessages,
  chatThreads,
  contacts,
  documentReferenceCounters,
  documentTypes,
  entities,
  entityVersions,
  expenses,
  extractedContent,
  fields,
  invoices,
  justifications,
  numberSeries,
  organizationSettings,
  playbookDefinitions,
  properties,
  propertyDependencies,
  rateEntries,
  rateTables,
  sellerProfiles,
  timeEntries,
  userFiles,
  vatRates,
  workspaceContacts,
  workspaceMembers,
  workspaces,
  workspaceViews,
} from "@/api/db/schema";
import type {
  JustificationContent,
  PracticeJurisdiction,
} from "@/api/db/schema";
import type {
  EntityKind,
  FieldContent,
  PropertyContent,
  PropertyTool,
} from "@/api/db/schema-validators";
import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { DEFAULT_DOCUMENT_TYPES } from "@/api/lib/document-types/defaults";
import { createUserFileThumbnailKey } from "@/api/lib/file-key";
import { parsedEmailToText, parseEmail } from "@/api/lib/files/email-to-html";
import { createTextPdf } from "@/api/lib/files/text-pdf";
import { deleteS3Keys } from "@/api/lib/files/utils";
import { cents } from "@/api/lib/money";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { buildDefaultViewRows } from "@/api/lib/views";
import type {
  PlaybookPositions,
  Position,
  PositionSeverity,
} from "@/api/lib/workflow/playbook-positions";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { seedCaseLaw } from "./seed-case-law";
import {
  assertSeedLocaleMatches,
  SEED_CONTENT_BY_LOCALE,
  SEED_LOCALE,
} from "./seed-content/locales";
import {
  ACTIVITY_CODE_KEYS,
  MAIN_MATTER_LABELS,
  TASK_CODE_KEYS,
} from "./seed-content/types";
import type {
  MainMatterLabel,
  SeedEmail,
  SeedEmailAttachment,
  SupplierAgreementParagraph,
  SupplierAgreementRun,
} from "./seed-content/types";
import {
  buildExportReviewCitationSeeds,
  buildExportReviewDocNames,
  buildExportReviewDocumentText,
  buildExportReviewMetadata,
  EXPORT_TABLE_FOLDER_COUNT,
  EXPORT_TABLE_MATTER_LABEL,
  exportReviewCitationBlockId,
  exportReviewDocumentIds,
} from "./seed-export-review";
import type {
  ExportReviewCitationSeed,
  ExportReviewMetadata,
} from "./seed-export-review";
import { buildMarketingAgentThread } from "./seed-marketing-agent-thread";
import { seedMarketingCaseLaw } from "./seed-marketing-case-law";
import { writeSeedRecentFiles } from "./seed-recents";
import { seedTemplates } from "./seed-templates";
import {
  ensurePrimarySeedUserInOrganization,
  ensureSeedColleaguesInOrganization,
  ensureTestUsers,
} from "./seed-test-user";
import {
  at,
  DEFAULT_ORG_ID,
  DEFAULT_SEED_COLLEAGUE_COUNT,
  DEFAULT_USER_ID,
  pickAuthor,
  seedFileIdentity,
  seedId,
} from "./seed-utils";

const db = openMaintenanceDb({ readOnly: false });

// Every name, document and note this run writes, in the target firm's
// language (seed-content/locales.ts).
const SEED_CONTENT = SEED_CONTENT_BY_LOCALE[SEED_LOCALE];
const SUPPLIER_AGREEMENT = SEED_CONTENT.supplierAgreement;
const EXPORT_REVIEW_COPY = SEED_CONTENT.exportReview;
const EXPORT_REVIEW_DOC_NAMES = buildExportReviewDocNames(EXPORT_REVIEW_COPY);

// ─── Mock file generators ───────────────────────────────

const fileExtRe = /\.(?:pdf|docx|eml)$/u;

const PDF_MIME = "application/pdf" as const;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const HEAVY_MATTER_LABEL = "ws-heavy-virtualization";
// Rows per multi-row INSERT; well under the bind-parameter cap for these tables.
const SEED_INSERT_CHUNK_SIZE = 500;
// Matters seeded, and entities indexed, at once.
const SEED_WORKSPACE_CONCURRENCY = 8;
const HEAVY_MATTER_FILE_COUNT = 1000;
const HEAVY_MATTER_FOLDER_COUNT = 25;
// The akvizice matter is where the Czech (type-scoped) playbook runs; its
// "Document Type" classifier uses the org taxonomy labels so playbook gating
// can match the SPA document.
const AKVIZICE_MATTER_LABEL = "ws-akvizice-energo";
// The org taxonomy labels in the seeded firm's language, keyed like the
// default taxonomy.
const documentTypeLabels: Readonly<Record<string, string>> =
  SEED_CONTENT.documentTypeLabels;
const documentTypeLabel = (key: string): string =>
  documentTypeLabels[key] ?? panic(`Missing document type label: ${key}`);
// The taxonomy key the Czech playbook is scoped to; its label classifies the
// akvizice SPA document so the gate matches.
const SPA_DOCUMENT_TYPE_KEY = "spa";
const SPA_DOCUMENT_TYPE_LABEL = documentTypeLabel(SPA_DOCUMENT_TYPE_KEY);

type BillingCodeId = SafeId<"billingCode">;
type ContactId = SafeId<"contact">;
type EntityId = SafeId<"entity">;
type EntityVersionId = SafeId<"entityVersion">;
type ExpenseId = SafeId<"expense">;
type FieldId = SafeId<"field">;
type InvoiceId = SafeId<"invoice">;
type JustificationId = SafeId<"justification">;
type PropertyId = SafeId<"property">;
type RateEntryId = SafeId<"rateEntry">;
type RateTableId = SafeId<"rateTable">;
type UserFileId = SafeId<"userFile">;
type WorkspaceContactId = SafeId<"workspaceContact">;
type WorkspaceId = SafeId<"workspace">;

const xmlEscape = (s: string): string =>
  s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");

// A package without a styles part leaves the default font to the consumer,
// and word processors then fall back to Times New Roman. Name the seed's font
// explicitly so every renderer shows the same document.
const SEED_STYLES_CONTENT_TYPE =
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>';
const SEED_STYLES_RELATIONSHIP =
  '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
const SEED_STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
  "</w:rPr></w:rPrDefault></w:docDefaults>" +
  "</w:styles>";

export const createMockDocx = async (
  title: string,
  bodyText?: string,
): Promise<Buffer> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  writeZipEntry(
    zip,
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${
        SEED_STYLES_CONTENT_TYPE
      }</Types>`,
  );

  writeZipEntry(
    zip,
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );

  // Build paragraphs from body text
  const lines = (bodyText ?? title).split("\n");
  let paragraphs =
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' +
    `<w:r><w:t>${xmlEscape(title)}</w:t></w:r></w:p>`;
  for (const line of lines) {
    paragraphs +=
      `<w:p><w:r><w:t xml:space="preserve">` +
      `${xmlEscape(line)}</w:t></w:r></w:p>`;
  }

  writeZipEntry(
    zip,
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}</w:body>` +
      "</w:document>",
  );

  writeZipEntry(
    zip,
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        SEED_STYLES_RELATIONSHIP
      }</Relationships>`,
  );
  writeZipEntry(zip, "word/styles.xml", SEED_STYLES_XML);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
};

// ─── Supplier Agreement (negotiated redline) ────────────

// The negotiated Supplier Agreement filmed by the marketing editor scenes
// (apps/web/e2e/marketing/record-product-story.ts) and mirrored by the
// landing page's DOM mocks (apps/landing/src/data/product-story.ts:
// storyTeamsExchange + storyEditorDocument). Unlike the generic mock DOCX
// files, this one carries real OOXML tracked changes (w:ins / w:del) and
// margin comments so the editor renders an actual redline: clause 12's
// liability cap is redlined from 300% of fees to the playbook cap of 100%
// of annual fees, and clause 14.1's thirty-day termination notice is the
// second playbook deviation. Keep the clause 12 wording in sync with
// storyEditorDocument. Its words come from the content pack
// (SupplierAgreementContent); every locale keeps both deviations.

type SeedTrackedChangeDisposition = "keep" | "reject";

/**
 * Plain-text rendition of the Supplier Agreement with the tracked changes
 * applied (insertions kept, deletions dropped): the single source for
 * extracted content and the search index, same as `documentTexts` entries.
 */
const buildSupplierAgreementText = (): string =>
  SUPPLIER_AGREEMENT.paragraphs
    .filter((paragraph) => paragraph.style !== "title")
    .map((paragraph) =>
      paragraph.runs
        .filter((run) => run.kind !== "deleted")
        .map((run) => run.text)
        .join(""),
    )
    .join("\n\n");

const supplierAgreementBaseVersionId = (
  workspaceId: WorkspaceId,
): EntityVersionId =>
  seedId<"entityVersion">(`${workspaceId}-supplier-agreement-base-version`);

/**
 * Build the Supplier Agreement DOCX with real tracked changes and margin
 * comments. Mirrors `createMockDocx`'s minimal OOXML package, plus a
 * `word/comments.xml` part (folio reads it by path) and its content-type
 * override and relationship for Word compatibility.
 */
const createSupplierAgreementDocx = async (
  disposition: SeedTrackedChangeDisposition,
): Promise<Buffer> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const { author, date, initials } = SUPPLIER_AGREEMENT.reviewer;

  writeZipEntry(
    zip,
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${
        SEED_STYLES_CONTENT_TYPE
      }<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` +
      `</Types>`,
  );

  writeZipEntry(
    zip,
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );

  let revisionId = 100;
  const runXml = (run: SupplierAgreementRun, bold: boolean): string => {
    const boldXml = bold ? "<w:b/>" : "";
    const sizeXml = '<w:sz w:val="22"/>';
    const runProps = `<w:rPr>${boldXml}${sizeXml}</w:rPr>`;
    const text =
      disposition === "reject" && run.text === SUPPLIER_AGREEMENT.draftMarker
        ? SUPPLIER_AGREEMENT.baseDraftMarker
        : run.text;
    const escaped = xmlEscape(text);
    if (disposition === "reject") {
      if (run.kind === "inserted") {
        return "";
      }
      return `<w:r>${runProps}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
    }
    if (run.kind === "deleted") {
      revisionId++;
      return (
        `<w:del w:id="${revisionId}" w:author="${xmlEscape(author)}" w:date="${date}">` +
        `<w:r>${runProps}<w:delText xml:space="preserve">${escaped}</w:delText></w:r>` +
        "</w:del>"
      );
    }
    if (run.kind === "inserted") {
      revisionId++;
      return (
        `<w:ins w:id="${revisionId}" w:author="${xmlEscape(author)}" w:date="${date}">` +
        `<w:r>${runProps}<w:t xml:space="preserve">${escaped}</w:t></w:r>` +
        "</w:ins>"
      );
    }
    return `<w:r>${runProps}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
  };

  const paragraphXml = (paragraph: SupplierAgreementParagraph): string => {
    if (paragraph.style === "title") {
      const titleRuns = paragraph.runs
        .map((run) => runXml(run, false))
        .join("");
      return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${titleRuns}</w:p>`;
    }
    const isHeading = paragraph.style === "heading";
    const spacing = isHeading
      ? '<w:spacing w:before="360" w:after="160"/>'
      : '<w:spacing w:after="140"/>';
    const runProps = isHeading ? '<w:rPr><w:b/><w:sz w:val="26"/></w:rPr>' : "";
    const paragraphProps = `<w:pPr>${spacing}${runProps}</w:pPr>`;
    const runsXml = paragraph.runs
      .map((run) => runXml(run, isHeading))
      .join("");
    if (paragraph.commentId === undefined) {
      return `<w:p>${paragraphProps}${runsXml}</w:p>`;
    }
    return (
      `<w:p>${paragraphProps}<w:commentRangeStart w:id="${paragraph.commentId}"/>${
        runsXml
      }<w:commentRangeEnd w:id="${paragraph.commentId}"/>` +
      `<w:r><w:commentReference w:id="${paragraph.commentId}"/></w:r>` +
      `</w:p>`
    );
  };

  const paragraphs = SUPPLIER_AGREEMENT.paragraphs.map(paragraphXml).join("");

  writeZipEntry(
    zip,
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}</w:body>` +
      "</w:document>",
  );

  const commentsXml = SUPPLIER_AGREEMENT.comments
    .map(
      (comment) =>
        `<w:comment w:id="${comment.id}" w:author="${xmlEscape(author)}" ` +
        `w:initials="${initials}" w:date="${date}">` +
        `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(comment.text)}</w:t></w:r></w:p>` +
        "</w:comment>",
    )
    .join("");
  writeZipEntry(
    zip,
    "word/comments.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `${commentsXml}</w:comments>`,
  );

  writeZipEntry(
    zip,
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>${
        SEED_STYLES_RELATIONSHIP
      }</Relationships>`,
  );
  writeZipEntry(zip, "word/styles.xml", SEED_STYLES_XML);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
};

// ─── Document names per workspace ───────────────────────

const buildHeavyMatterDocNames = (): string[] => {
  const subjects = [
    "Pleadings",
    "Disclosure",
    "Witness",
    "Expert",
    "Contract",
    "Correspondence",
    "Board",
    "Finance",
    "Regulatory",
    "Closing",
  ];
  const phases = [
    "draft",
    "signed",
    "redline",
    "translated",
    "annex",
    "email",
    "scan",
    "bundle",
  ];
  const result: string[] = [];

  for (let i = 0; i < HEAVY_MATTER_FILE_COUNT; i++) {
    const subject = at(subjects, i % subjects.length);
    const phase = at(phases, (i * 7) % phases.length);
    const extension = i % 11 === 0 ? "docx" : "pdf";
    result.push(
      `${String(i + 1).padStart(4, "0")}_${subject}_${phase}.${extension}`,
    );
  }

  return result;
};

// ─── Email files ────────────────────────────────────────

const seedEmails: Readonly<Record<string, SeedEmail>> = SEED_CONTENT.emails;

const wrapBase64 = (value: Buffer): string =>
  value
    .toString("base64")
    .match(/.{1,76}/gu)
    ?.join("\r\n") ?? "";

const createSeedEmailAttachment = (
  attachment: SeedEmailAttachment,
): { mimeType: string; bytes: Buffer } => {
  if (attachment.type === "pdf") {
    return {
      mimeType: PDF_MIME,
      bytes: createTextPdf(attachment.title, attachment.bodyText),
    };
  }

  return {
    mimeType: "text/plain; charset=utf-8",
    bytes: Buffer.from(attachment.bodyText, "utf-8"),
  };
};

export const createSeedEmail = (fileName: string, email: SeedEmail): Buffer => {
  const slug = fileName.replaceAll(/[^a-z0-9]/giu, "-");
  const boundary = `stella-seed-mixed-${slug}`;
  const alternativeBoundary = `stella-seed-alt-${slug}`;
  const lines = [
    `From: ${email.from}`,
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    `Date: ${email.date}`,
    `Subject: ${email.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.textBody,
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    `<html><body>${email.htmlBody}</body></html>`,
    `--${alternativeBoundary}--`,
  ];

  for (const attachment of email.attachments) {
    const { bytes, mimeType } = createSeedEmailAttachment(attachment);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${attachment.fileName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.fileName}"`,
      "",
      wrapBase64(bytes),
    );
  }

  lines.push(`--${boundary}--`, "");
  return Buffer.from(lines.join("\r\n"), "utf-8");
};

type SeedFileFormat =
  | {
      type: "docx";
      extension: "docx";
      mimeType: typeof DOCX_MIME;
    }
  | {
      type: "email";
      extension: "eml";
      mimeType: typeof EML_MIME_TYPE;
      email: SeedEmail;
    }
  | {
      type: "pdf";
      extension: "pdf";
      mimeType: typeof PDF_MIME;
    };

const resolveSeedFileFormat = (fileName: string): SeedFileFormat => {
  if (fileName.endsWith(".docx")) {
    return { type: "docx", extension: "docx", mimeType: DOCX_MIME };
  }
  const email = seedEmails[fileName];
  if (email !== undefined) {
    return {
      type: "email",
      extension: "eml",
      mimeType: EML_MIME_TYPE,
      email,
    };
  }
  return { type: "pdf", extension: "pdf", mimeType: PDF_MIME };
};

// ─── Documents per workspace ────────────────────────────

/**
 * Every main matter's documents in listing order: the content pack's for
 * the standard matters, the generated data room, and (English firm only)
 * the virtualization stress matter.
 */
const workspaceDocNames: Record<string, readonly string[]> = {
  ...SEED_CONTENT.matterDocuments,
  // Key order matters: extra matters pick documents from this table by
  // position.
  ...(SEED_LOCALE === "en"
    ? { [HEAVY_MATTER_LABEL]: buildHeavyMatterDocNames() }
    : {}),
  [EXPORT_TABLE_MATTER_LABEL]: EXPORT_REVIEW_DOC_NAMES,
};

/**
 * Extracted text of each document, by file name: the content pack's bodies,
 * the supplier agreement derived from its tracked-change paragraphs, and
 * the data room's generated review extracts.
 */
const documentTexts: Record<string, string> = {
  ...SEED_CONTENT.documentTexts,
  [SUPPLIER_AGREEMENT.fileName]: buildSupplierAgreementText(),
  ...Object.fromEntries(
    EXPORT_REVIEW_DOC_NAMES.map((fileName, index) => [
      fileName,
      buildExportReviewDocumentText(EXPORT_REVIEW_COPY, fileName, index),
    ]),
  ),
};

// ─── Contacts ───────────────────────────────────────────

const { orgContacts, personContacts, moreOrgContacts } = SEED_CONTENT;

// ─── Workspaces (Matters) ───────────────────────────────

type SeedWorkspace = {
  id: WorkspaceId;
  label: string;
  name: string;
  reference: string;
  clientId: ContactId;
  billingReference?: string;
};

// The virtualization stress matter: a thousand generated files, for the
// English development firm only (no capture films it).
const HEAVY_MATTER = {
  name: "Virtualization Scale Test Matter",
  reference: "PERF/1000",
  clientIndex: 0,
  billingReference: "PERF-VIRT-1000",
} as const;

const seedWorkspaces: readonly SeedWorkspace[] = [
  ...MAIN_MATTER_LABELS.map((label) => ({
    label,
    ...SEED_CONTENT.matters[label],
  })),
  ...(SEED_LOCALE === "en"
    ? [{ label: HEAVY_MATTER_LABEL, ...HEAVY_MATTER }]
    : []),
].map(({ label, clientIndex, ...matter }) => ({
  id: seedId(label),
  label,
  ...matter,
  clientId: at(orgContacts, clientIndex).id,
}));

/** A main matter's seeded workspace, by its label. */
const seedWorkspaceFor = (label: MainMatterLabel): SeedWorkspace =>
  seedWorkspaces.find((workspace) => workspace.label === label) ??
  panic(`Missing seed workspace ${label}`);

// ─── Sidebar recents ordering ───────────────────────────
// The app sidebar's "Recent matters" list is ordered by
// workspaces.lastActivityAt (apps/web/src/components/app-sidebar.logic.ts),
// and the marketing recordings film that sidebar. Relying on the column's
// defaultNow() orders matters by seed insertion time, which surfaced the
// last few extra matters in every recording. Every workspace therefore gets
// a deterministic lastActivityAt: the content pack's `recentMatterActivity`
// pins the filmed matters to the newest dates so they fill all visible
// recents slots (sidebar limit is 5) with margin, and every other matter
// falls back to an older date derived from its insertion index. Keyed by
// the org-unique matter reference.
const recentMatterActivity: Readonly<Record<string, string>> =
  SEED_CONTENT.recentMatterActivity;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Non-cast matters: deterministic and strictly older than every pinned
// date above (2026-02-02 base + one hour per insertion index).
const FALLBACK_ACTIVITY_BASE_MS = Date.UTC(2026, 1, 2, 8, 0, 0);
const FALLBACK_ACTIVITY_STEP_MS = HOUR_MS;

const workspaceLastActivityAt = (reference: string, index: number): Date => {
  const pinned = recentMatterActivity[reference];
  return pinned
    ? new Date(pinned)
    : new Date(FALLBACK_ACTIVITY_BASE_MS + index * FALLBACK_ACTIVITY_STEP_MS);
};

// ─── Entity timestamp pinning ───────────────────────────
// The files views show per-document Created/Last-updated columns, the list
// endpoints sort by asc(entities.createdAt) (see
// apps/api/src/handlers/entities/files/list.ts), and the marketing stills
// film that ordering. With the columns' defaultNow(), every fresh seed
// produced "N min ago" values that varied with seed wall-clock time, so
// re-seeded screenshots drifted. Entities therefore get deterministic
// timestamps (same pattern as workspaces.lastActivityAt above): createdAt
// steps forward 9 minutes per entity from 30 days before the workspace's
// pinned lastActivityAt, so createdAt-sorted views render the seed's
// insertion order (folders first, then documents in listing order) exactly
// as the pre-pinning seed did; updatedAt lands a deterministic (hashed from
// the entity id) few minutes under one hour before the workspace's activity
// date, so created < updated <= workspace activity always holds. Exported
// for scripts that re-pin the shared dev DB without a full reseed.
const ENTITY_CREATED_STEP_MS = 9 * 60_000;
const ENTITY_CREATED_BASE_OFFSET_MS = 30 * DAY_MS;

type SeedEntityTimestampsOptions = {
  entityId: string;
  /** Insertion index of the entity within its workspace. */
  indexInWorkspace: number;
  workspaceActivityAt: Date;
};

export const seedEntityTimestamps = ({
  entityId,
  indexInWorkspace,
  workspaceActivityAt,
}: SeedEntityTimestampsOptions): { createdAt: Date; updatedAt: Date } => {
  // First 12 hex chars of the deterministic entity UUID: a stable, well-mixed
  // 48-bit value that is safely inside Number precision.
  const hash = Number.parseInt(entityId.replaceAll("-", "").slice(0, 12), 16);
  const createdAt = new Date(
    workspaceActivityAt.getTime() -
      ENTITY_CREATED_BASE_OFFSET_MS +
      indexInWorkspace * ENTITY_CREATED_STEP_MS,
  );
  const updatedAt = new Date(
    workspaceActivityAt.getTime() - HOUR_MS - (hash % (59 * 60_000)),
  );
  return { createdAt, updatedAt };
};

// ─── Properties (per-workspace) ─────────────────────────

type PropertySeed = {
  id: PropertyId;
  workspaceId: WorkspaceId;
  name: string;
  content: PropertyContent;
  tool: PropertyTool;
  system?: boolean;
  kinds?: EntityKind[];
};

const buildProperties = (
  wsId: WorkspaceId,
  wsLabel: string,
): PropertySeed[] => {
  const { properties: propertyNames } = SEED_CONTENT;
  const [activeStatus, inReviewStatus, closedStatus, onHoldStatus] =
    propertyNames.statusOptions;
  const base: PropertySeed[] = [
    {
      id: seedId(`${wsLabel}-prop-file`),
      workspaceId: wsId,
      name: propertyNames.documents,
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
      system: true,
      kinds: ["document"],
    },
    {
      id: seedId(`${wsLabel}-prop-status`),
      workspaceId: wsId,
      name: propertyNames.status,
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "green", value: activeStatus },
          { color: "amber", value: inReviewStatus },
          { color: "red", value: closedStatus },
          { color: "gray", value: onHoldStatus },
        ],
        fallback: null,
      },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: seedId(`${wsLabel}-prop-notes`),
      workspaceId: wsId,
      name: propertyNames.notes,
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: seedId(`${wsLabel}-prop-due-date`),
      workspaceId: wsId,
      name: propertyNames.dueDate,
      content: { version: 1, type: "date" },
      tool: { version: 1, type: "manual-input" },
    },
  ];

  const aiTool = (prompt: string): PropertyTool => ({
    version: 1,
    type: "ai-model",
    prompt,
  });

  if (wsLabel === AKVIZICE_MATTER_LABEL) {
    // A single-select AI classifier whose options are the org document-type
    // taxonomy labels; the type-scoped playbook gates its columns on this.
    const docTypeColors = ["blue", "teal", "violet", "amber"] as const;
    return [
      ...base,
      {
        id: seedId(`${wsLabel}-prop-document-type`),
        workspaceId: wsId,
        name: propertyNames.documentType,
        content: {
          version: 1,
          type: "single-select",
          options: DEFAULT_DOCUMENT_TYPES.map((documentType, index) => ({
            color: at(docTypeColors, index % docTypeColors.length),
            value: documentTypeLabel(documentType.key),
          })),
          fallback: null,
        },
        tool: aiTool(propertyNames.documentTypePrompt),
      },
    ];
  }

  if (wsLabel !== EXPORT_TABLE_MATTER_LABEL) {
    return base;
  }

  const { columns } = EXPORT_REVIEW_COPY;
  const [lowRisk, mediumRisk, highRisk, criticalRisk] =
    EXPORT_REVIEW_COPY.riskLevels;
  const [notStarted, inReview, needsPartner, cleared] =
    EXPORT_REVIEW_COPY.reviewStatuses;
  const [directCitation, needsSourceCheck, conflictingEvidence] =
    EXPORT_REVIEW_COPY.evidenceQuality;
  const [changeOfControl, termination, dataRoom, renewal] =
    EXPORT_REVIEW_COPY.primaryTags;
  const [consentNeeded, pricing, privacy, security] =
    EXPORT_REVIEW_COPY.secondaryTags;

  return [
    ...base,
    {
      id: seedId(`${wsLabel}-prop-document-type`),
      workspaceId: wsId,
      name: columns.documentType.name,
      content: {
        version: 1,
        type: "single-select",
        options: EXPORT_REVIEW_COPY.documentTypes.map((value, index) => ({
          color: at(["blue", "teal", "violet", "amber"], index % 4),
          value,
        })),
        fallback: null,
      },
      tool: aiTool(columns.documentType.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-counterparty`),
      workspaceId: wsId,
      name: columns.counterparty.name,
      content: { version: 1, type: "text" },
      tool: aiTool(columns.counterparty.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-jurisdiction`),
      workspaceId: wsId,
      name: columns.jurisdiction.name,
      content: {
        version: 1,
        type: "single-select",
        options: EXPORT_REVIEW_COPY.jurisdictions.map((value, index) => ({
          color: at(["cyan", "green", "purple", "orange", "gray"], index),
          value,
        })),
        fallback: null,
      },
      tool: aiTool(columns.jurisdiction.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-governing-law`),
      workspaceId: wsId,
      name: columns.governingLaw.name,
      content: { version: 1, type: "text" },
      tool: aiTool(columns.governingLaw.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-effective-date`),
      workspaceId: wsId,
      name: columns.effectiveDate.name,
      content: { version: 1, type: "date" },
      tool: aiTool(columns.effectiveDate.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-expiry-date`),
      workspaceId: wsId,
      name: columns.expiryDate.name,
      content: { version: 1, type: "date" },
      tool: aiTool(columns.expiryDate.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-contract-value`),
      workspaceId: wsId,
      name: columns.contractValue.name,
      content: { version: 1, type: "int" },
      tool: aiTool(columns.contractValue.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-risk-level`),
      workspaceId: wsId,
      name: columns.riskLevel.name,
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "green", value: lowRisk },
          { color: "amber", value: mediumRisk },
          { color: "red", value: highRisk },
          { color: "purple", value: criticalRisk },
        ],
        fallback: null,
      },
      tool: aiTool(columns.riskLevel.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-review-status`),
      workspaceId: wsId,
      name: columns.reviewStatus.name,
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "gray", value: notStarted },
          { color: "blue", value: inReview },
          { color: "amber", value: needsPartner },
          { color: "green", value: cleared },
        ],
        fallback: null,
      },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: seedId(`${wsLabel}-prop-evidence-quality`),
      workspaceId: wsId,
      name: columns.evidenceQuality.name,
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "green", value: directCitation },
          { color: "amber", value: needsSourceCheck },
          { color: "red", value: conflictingEvidence },
        ],
        fallback: null,
      },
      tool: aiTool(columns.evidenceQuality.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-tags`),
      workspaceId: wsId,
      name: columns.tags.name,
      content: {
        version: 1,
        type: "multi-select",
        options: [
          { color: "blue", value: changeOfControl },
          { color: "amber", value: termination },
          { color: "violet", value: dataRoom },
          { color: "green", value: renewal },
          { color: "red", value: consentNeeded },
          { color: "cyan", value: pricing },
          { color: "purple", value: privacy },
          { color: "gray", value: security },
        ],
        fallback: null,
      },
      tool: aiTool(columns.tags.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-key-obligation`),
      workspaceId: wsId,
      name: columns.keyObligation.name,
      content: { version: 1, type: "text" },
      tool: aiTool(columns.keyObligation.prompt),
    },
    {
      id: seedId(`${wsLabel}-prop-risk-finding`),
      workspaceId: wsId,
      name: columns.riskFinding.name,
      content: { version: 1, type: "text" },
      tool: aiTool(columns.riskFinding.prompt),
    },
  ];
};

// ─── Entities (per-workspace) ───────────────────────────

type EntitySeed = {
  entityId: EntityId;
  versionId: EntityVersionId;
  workspaceId: WorkspaceId;
  kind: "document" | "folder";
  parentId?: EntityId;
  /** Canonical display label. Non-null for every entity row. */
  name: string;
};

const buildEntities = (wsId: WorkspaceId, wsLabel: string): EntitySeed[] => {
  const folderId = seedId(`${wsLabel}-folder-1`);
  if (wsLabel === EXPORT_TABLE_MATTER_LABEL) {
    const result: EntitySeed[] = [];
    const folderIds: EntityId[] = [];

    for (let i = 0; i < EXPORT_TABLE_FOLDER_COUNT; i++) {
      const entityId = seedId(`${wsLabel}-folder-${i + 1}`);
      folderIds.push(entityId);
      result.push({
        entityId,
        versionId: seedId(`${wsLabel}-folder-${i + 1}-v`),
        workspaceId: wsId,
        kind: "folder",
        name: at(EXPORT_REVIEW_COPY.folders, i),
      });
    }

    const docNames = workspaceDocNames[wsLabel] ?? [];
    for (let i = 0; i < docNames.length; i++) {
      const { entityId, entityVersionId } = exportReviewDocumentIds(i);
      result.push({
        entityId,
        versionId: entityVersionId,
        workspaceId: wsId,
        kind: "document",
        name: at(docNames, i),
        parentId: at(folderIds, i % folderIds.length),
      });
    }

    return result;
  }

  if (wsLabel === HEAVY_MATTER_LABEL) {
    const result: EntitySeed[] = [];
    const folderIds: EntityId[] = [];

    for (let i = 0; i < HEAVY_MATTER_FOLDER_COUNT; i++) {
      const parentId =
        i > 0 && i % 5 !== 0 ? folderIds[Math.floor(i / 5) * 5] : undefined;
      const entityId = seedId(`${wsLabel}-folder-${i + 1}`);
      folderIds.push(entityId);
      result.push({
        entityId,
        versionId: seedId(`${wsLabel}-folder-${i + 1}-v`),
        workspaceId: wsId,
        kind: "folder",
        name: `Folder ${i + 1}`,
        ...(parentId !== undefined && { parentId }),
      });
    }

    const docNames = workspaceDocNames[wsLabel] ?? [];
    for (let i = 0; i < docNames.length; i++) {
      const parentId = at(folderIds, i % folderIds.length);
      result.push({
        entityId: seedId(`${wsLabel}-doc-${i + 1}`),
        versionId: seedId(`${wsLabel}-doc-${i + 1}-v`),
        workspaceId: wsId,
        kind: "document",
        name: at(docNames, i),
        parentId,
      });
    }

    return result;
  }

  const docNames = workspaceDocNames[wsLabel] ?? [];
  const standardEntities: EntitySeed[] = [
    {
      entityId: folderId,
      versionId: seedId(`${wsLabel}-folder-1-v`),
      workspaceId: wsId,
      kind: "folder",
      name: SEED_CONTENT.folders.documents,
    },
    {
      entityId: seedId(`${wsLabel}-doc-1`),
      versionId: seedId(`${wsLabel}-doc-1-v`),
      workspaceId: wsId,
      kind: "document",
      name: docNames[0] ?? "Document 1",
      parentId: folderId,
    },
    {
      entityId: seedId(`${wsLabel}-doc-2`),
      versionId: seedId(`${wsLabel}-doc-2-v`),
      workspaceId: wsId,
      kind: "document",
      name: docNames[1] ?? "Document 2",
      parentId: folderId,
    },
    {
      entityId: seedId(`${wsLabel}-doc-3`),
      versionId: seedId(`${wsLabel}-doc-3-v`),
      workspaceId: wsId,
      kind: "document",
      name: docNames[2] ?? "Document 3",
    },
    {
      entityId: seedId(`${wsLabel}-doc-4`),
      versionId: seedId(`${wsLabel}-doc-4-v`),
      workspaceId: wsId,
      kind: "document",
      name: docNames[3] ?? "Document 4",
    },
  ];

  for (let i = 4; i < docNames.length; i++) {
    standardEntities.push({
      entityId: seedId(`${wsLabel}-doc-${i + 1}`),
      versionId: seedId(`${wsLabel}-doc-${i + 1}-v`),
      workspaceId: wsId,
      kind: "document",
      name: at(docNames, i),
    });
  }

  return standardEntities;
};

// ─── Fields (status, due date, notes for each entity) ───

type FieldSeed = {
  id: FieldId;
  workspaceId: WorkspaceId;
  propertyId: PropertyId;
  entityVersionId: EntityVersionId;
  content: FieldContent;
};

/**
 * Deterministic future date within ~6 months of 2025-03-01.
 *
 * Built and read back in UTC. Constructing the base with `new Date(y, m, d)`
 * anchors it to the seeding machine's local midnight, which `toISOString()`
 * then renders in UTC: east of Greenwich every seeded due date lands a day
 * earlier than it does on a UTC runner. The marketing screenshot baselines
 * render this field, so the drift showed up as a permanent one-day diff
 * between locally regenerated baselines and CI.
 */
const seedDueDate = (index: number): string => {
  const offsetDays = ((index * 37 + 13) % 180) + 1; // 1..180
  const base = new Date(Date.UTC(2025, 2, 1)); // 2025-03-01
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
};

const addExportReviewFields = (
  result: FieldSeed[],
  wsLabel: string,
  doc: EntitySeed,
  index: number,
) => {
  const metadata = buildExportReviewMetadata(EXPORT_REVIEW_COPY, index);
  result.push(
    {
      id: seedId(`${wsLabel}-field-document-type-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-document-type`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: metadata.documentType,
      },
    },
    {
      id: seedId(`${wsLabel}-field-counterparty-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-counterparty`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "text",
        value: metadata.counterparty,
      },
    },
    {
      id: seedId(`${wsLabel}-field-jurisdiction-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-jurisdiction`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: metadata.jurisdiction,
      },
    },
    {
      id: seedId(`${wsLabel}-field-governing-law-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-governing-law`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "text",
        value: metadata.governingLaw,
      },
    },
    {
      id: seedId(`${wsLabel}-field-effective-date-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-effective-date`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "date",
        value: metadata.effectiveDate,
      },
    },
    {
      id: seedId(`${wsLabel}-field-expiry-date-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-expiry-date`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "date",
        value: metadata.expiryDate,
      },
    },
    {
      id: seedId(`${wsLabel}-field-contract-value-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-contract-value`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "int",
        value: metadata.contractValue,
        currency: "EUR",
      },
    },
    {
      id: seedId(`${wsLabel}-field-risk-level-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-risk-level`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: metadata.riskLevel,
      },
    },
    {
      id: seedId(`${wsLabel}-field-review-status-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-review-status`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: metadata.reviewStatus,
      },
    },
    {
      id: seedId(`${wsLabel}-field-evidence-quality-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-evidence-quality`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: metadata.evidenceQuality,
      },
    },
    {
      id: seedId(`${wsLabel}-field-tags-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-tags`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "multi-select",
        value: [...metadata.tags],
      },
    },
    {
      id: seedId(`${wsLabel}-field-key-obligation-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-key-obligation`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "text",
        value: metadata.keyObligation,
      },
    },
    {
      id: seedId(`${wsLabel}-field-risk-finding-${index}`),
      workspaceId: doc.workspaceId,
      propertyId: seedId(`${wsLabel}-prop-risk-finding`),
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "text",
        value: metadata.riskFinding,
      },
    },
  );
};

const statuses = SEED_CONTENT.properties.statusOptions;
const { notes } = SEED_CONTENT;

const buildFields = (
  wsLabel: string,
  entitySeeds: EntitySeed[],
): FieldSeed[] => {
  const statusPropId = seedId(`${wsLabel}-prop-status`);
  const dueDatePropId = seedId(`${wsLabel}-prop-due-date`);
  const notesPropId = seedId(`${wsLabel}-prop-notes`);

  const docs = entitySeeds.filter((e) => e.kind === "document");
  const result: FieldSeed[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = at(docs, i);
    // The Supplier Agreement redline is mid-negotiation: pin its status and
    // note to the review story instead of the rotating generic values, so
    // the filmed files view matches the landing mock's framing.
    const isSupplierAgreement =
      wsLabel === AKVIZICE_MATTER_LABEL &&
      doc.name === SUPPLIER_AGREEMENT.fileName;

    // Status field
    result.push({
      id: seedId(`${wsLabel}-field-status-${i}`),
      workspaceId: doc.workspaceId,
      propertyId: statusPropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: isSupplierAgreement
          ? at(statuses, 1)
          : at(statuses, i % statuses.length),
      },
    });

    // Due Date field
    result.push({
      id: seedId(`${wsLabel}-field-due-date-${i}`),
      workspaceId: doc.workspaceId,
      propertyId: dueDatePropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "date",
        value: seedDueDate(
          // Use wsLabel hash + doc index for variety
          (seedId(`${wsLabel}-${i}`).codePointAt(0) ?? 0) + i,
        ),
      },
    });

    // Notes field
    const noteIndex =
      ((seedId(`${wsLabel}-note-${i}`).codePointAt(0) ?? 0) + i) % notes.length;
    result.push({
      id: seedId(`${wsLabel}-field-notes-${i}`),
      workspaceId: doc.workspaceId,
      propertyId: notesPropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "text",
        value: isSupplierAgreement
          ? SUPPLIER_AGREEMENT.note
          : at(notes, noteIndex),
      },
    });

    if (wsLabel === EXPORT_TABLE_MATTER_LABEL) {
      addExportReviewFields(result, wsLabel, doc, i);
    }

    // Classify the akvizice SPA document so the type-scoped playbook's gate
    // (DocumentType == "Share Purchase Agreement") matches it.
    if (
      wsLabel === AKVIZICE_MATTER_LABEL &&
      doc.name === SEED_CONTENT.spaDocumentName
    ) {
      result.push({
        id: seedId(`${wsLabel}-field-document-type-${i}`),
        workspaceId: doc.workspaceId,
        propertyId: seedId(`${wsLabel}-prop-document-type`),
        entityVersionId: doc.versionId,
        content: {
          version: 1,
          type: "single-select",
          value: SPA_DOCUMENT_TYPE_LABEL,
        },
      });
    }
  }

  return result;
};

type JustificationSeed = {
  id: JustificationId;
  workspaceId: WorkspaceId;
  fieldId: FieldId;
  content: JustificationContent;
  fileFieldIds: FieldId[];
};

const buildExportReviewJustificationContent = ({
  fileName,
  fileFieldId,
  metadata,
  citationSeed,
}: {
  fileName: string;
  fileFieldId: FieldId;
  metadata: ExportReviewMetadata;
  citationSeed: ExportReviewCitationSeed;
}): JustificationContent => {
  if (fileName.endsWith(".docx")) {
    return {
      version: 1,
      blocks: [
        {
          kind: "docx-folio",
          fileFieldId,
          statements: [
            {
              text: citationSeed.statement,
              citations: [
                {
                  citationStatus: "verified",
                  blockId: exportReviewCitationBlockId(citationSeed),
                  text: citationSeed.quote,
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const batesPrefix = fileName.replace(fileExtRe, "").replaceAll("_", "-");
  return {
    version: 1,
    blocks: [
      {
        kind: "pdf-bates",
        fileFieldId,
        statements: [
          {
            text: citationSeed.statement,
            citations: [
              {
                bates: `${batesPrefix}-${metadata.pageNumber}`,
                pageNumber: metadata.pageNumber,
              },
            ],
          },
        ],
      },
    ],
  };
};

const buildExportReviewJustifications = (
  wsId: WorkspaceId,
  wsLabel: string,
  entitySeeds: EntitySeed[],
): JustificationSeed[] => {
  if (wsLabel !== EXPORT_TABLE_MATTER_LABEL) {
    return [];
  }

  const docs = entitySeeds.filter((e) => e.kind === "document");
  const result: JustificationSeed[] = [];

  for (let i = 0; i < docs.length; i++) {
    const fileName = at(EXPORT_REVIEW_DOC_NAMES, i);
    const metadata = buildExportReviewMetadata(EXPORT_REVIEW_COPY, i);
    const { fileFieldId } = exportReviewDocumentIds(i);
    const seeds = buildExportReviewCitationSeeds(EXPORT_REVIEW_COPY, metadata);

    for (const citationSeed of seeds) {
      const fieldId = seedId<"field">(
        `${wsLabel}-field-${citationSeed.fieldSuffix}-${i}`,
      );
      result.push({
        id: seedId(`${wsLabel}-justification-${citationSeed.fieldSuffix}-${i}`),
        workspaceId: wsId,
        fieldId,
        content: buildExportReviewJustificationContent({
          fileName,
          fileFieldId,
          metadata,
          citationSeed,
        }),
        fileFieldIds: [fileFieldId],
      });
    }
  }

  return result;
};

// ─── Workspace contacts (parties) ───────────────────────

type PartySeed = {
  id: WorkspaceContactId;
  workspaceId: WorkspaceId;
  contactId: ContactId;
  role: WorkspaceContactRole;
};

const seedParties: PartySeed[] = [
  // Akvizice EnerGo: opposing counsel + witness
  {
    id: seedId("party-akvizice-kral"),
    workspaceId: at(seedWorkspaces, 0).id,
    contactId: at(personContacts, 4).id, // Milan Král
    role: "opposing_counsel",
  },
  {
    id: seedId("party-akvizice-dvorak"),
    workspaceId: at(seedWorkspaces, 0).id,
    contactId: at(personContacts, 2).id, // Petr Dvořák
    role: "witness",
  },
  // Stavební spor: opposing party + judge
  {
    id: seedId("party-stavebni-novak-partners"),
    workspaceId: at(seedWorkspaces, 1).id,
    contactId: at(orgContacts, 0).id, // Novák & Partners
    role: "opposing_party",
  },
  {
    id: seedId("party-stavebni-kral"),
    workspaceId: at(seedWorkspaces, 1).id,
    contactId: at(personContacts, 4).id, // Milan Král
    role: "judge",
  },
  // Due Diligence: co-counsel
  {
    id: seedId("party-dd-novak"),
    workspaceId: at(seedWorkspaces, 2).id,
    contactId: at(personContacts, 0).id, // Jan Novák
    role: "co_counsel",
  },
  // Cross-border M&A: expert witness
  {
    id: seedId("party-crossborder-svobodova"),
    workspaceId: at(seedWorkspaces, 6).id,
    contactId: at(personContacts, 1).id, // Eva Svobodová
    role: "expert_witness",
  },
  // GDPR Audit: third party
  {
    id: seedId("party-gdpr-williams"),
    workspaceId: at(seedWorkspaces, 7).id,
    contactId: at(personContacts, 3).id, // Sarah Williams
    role: "third_party",
  },
  // Pracovní spory: opposing counsel
  {
    id: seedId("party-pracovni-svobodova"),
    workspaceId: at(seedWorkspaces, 3).id,
    contactId: at(personContacts, 1).id, // Eva Svobodová
    role: "opposing_counsel",
  },
];

// ─── Billing codes ─────────────────────────────────────

const TASK_CODES = TASK_CODE_KEYS.map((code) => ({
  code,
  label: SEED_CONTENT.billing.taskCodeLabels[code],
}));

const ACTIVITY_CODES = ACTIVITY_CODE_KEYS.map((code) => ({
  code,
  label: SEED_CONTENT.billing.activityCodeLabels[code],
}));

type BillingCodeSeed = {
  id: BillingCodeId;
  workspaceId: WorkspaceId;
  type: "task" | "activity";
  code: string;
  label: string;
  sortOrder: number;
};

const buildBillingCodes = (): BillingCodeSeed[] => {
  const codes: BillingCodeSeed[] = [];
  for (let wsIndex = 0; wsIndex < seedWorkspaces.length; wsIndex++) {
    const ws = at(seedWorkspaces, wsIndex);
    for (let i = 0; i < TASK_CODES.length; i++) {
      const tc = at(TASK_CODES, i);
      codes.push({
        id: seedId(`billing-code-${wsIndex}-task-${tc.code}`),
        workspaceId: ws.id,
        type: "task",
        code: tc.code,
        label: tc.label,
        sortOrder: i,
      });
    }
    for (let i = 0; i < ACTIVITY_CODES.length; i++) {
      const ac = at(ACTIVITY_CODES, i);
      codes.push({
        id: seedId(`billing-code-${wsIndex}-activity-${ac.code}`),
        workspaceId: ws.id,
        type: "activity",
        code: ac.code,
        label: ac.label,
        sortOrder: i,
      });
    }
  }
  return codes;
};

// ─── Rate tables ───────────────────────────────────────

type RateTableSeed = {
  id: RateTableId;
  workspaceId: WorkspaceId;
  name: string;
  currency: string;
};

type RateEntrySeed = {
  id: RateEntryId;
  workspaceId: WorkspaceId;
  rateTableId: RateTableId;
  userId: string;
  hourlyRate: number;
  effectiveFrom: string;
};

const buildRateTables = ({
  userIds,
  userRates,
}: {
  userIds: readonly string[];
  userRates: Record<string, number>;
}): {
  tables: RateTableSeed[];
  entries: RateEntrySeed[];
} => {
  const tables: RateTableSeed[] = [];
  const entries: RateEntrySeed[] = [];
  for (let wsIndex = 0; wsIndex < seedWorkspaces.length; wsIndex++) {
    const ws = at(seedWorkspaces, wsIndex);
    const tableId = seedId(`rate-table-${wsIndex}`);
    tables.push({
      id: tableId,
      workspaceId: ws.id,
      name: SEED_CONTENT.billing.rateTableName,
      currency: SEED_CONTENT.currency,
    });
    for (let ui = 0; ui < userIds.length; ui++) {
      const userId = at(userIds, ui);
      entries.push({
        id: seedId(`rate-entry-${wsIndex}-${ui}`),
        workspaceId: ws.id,
        rateTableId: tableId,
        userId,
        hourlyRate: userRates[userId] ?? 4000,
        effectiveFrom: "2024-01-01",
      });
    }
  }
  return { tables, entries };
};

// ─── Extended time entries (~500) ──────────────────────

type ExtendedTimeEntrySeed = {
  id: SafeId<"timeEntry">;
  workspaceId: WorkspaceId;
  userId: string;
  matterId: EntityId;
  dateWorked: string;
  durationMinutes: number;
  billedMinutes: number;
  rateAtEntry: number;
  currency: string;
  narrative: string;
  billable: boolean;
  status: TimeEntryStatus;
  taskCode: string;
  activityCode: string;
  invoiceId: InvoiceId | null;
};

const WS_LABELS = seedWorkspaces.map((workspace) => workspace.label);

const buildExtendedTimeEntries = (
  invoiceIds: InvoiceId[],
  userIds: readonly string[],
  userRates: Record<string, number>,
): ExtendedTimeEntrySeed[] => {
  const entries: ExtendedTimeEntrySeed[] = [];
  const TARGET = 500;

  for (let i = 0; i < TARGET; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    const wsLabel = at(WS_LABELS, wsIndex);
    const matterId = seedId(`${wsLabel}-doc-1`);
    const userIndex = i % userIds.length;
    const userId = at(userIds, userIndex);
    const rate = userRates[userId] ?? 4000;

    // Spread across 90 days (Dec 2024 – Feb 2025)
    const dayOffset = i % 90;
    const date = new Date(2024, 11, 1 + dayOffset);
    const dateStr = date.toISOString().slice(0, 10);

    // Duration: 15–240 min, varied
    const duration = 15 + ((i * 7 + 13) % 226);
    const billedMinutes = Math.ceil(duration / 6) * 6;

    const narratives = SEED_CONTENT.billing.timeEntryNarratives;
    const narrative = at(narratives, i % narratives.length);
    const taskCode = at(TASK_CODES, i % TASK_CODES.length).code;
    const activityCode = at(ACTIVITY_CODES, i % ACTIVITY_CODES.length).code;

    // Status distribution: 60% draft, 25% approved,
    // 10% billed, 5% written_off
    const statusRoll = i % 20;
    let status: ExtendedTimeEntrySeed["status"] = "draft";
    let invoiceId: InvoiceId | null = null;
    if (statusRoll >= 19) {
      status = "written_off";
    } else if (statusRoll >= 17) {
      status = "billed";
      invoiceId = at(invoiceIds, i % invoiceIds.length);
    } else if (statusRoll >= 12) {
      status = "approved";
    }

    const billable = i % 7 !== 0;

    entries.push({
      id: seedId(`ext-time-entry-${i}`),
      workspaceId: ws.id,
      userId,
      matterId,
      dateWorked: dateStr,
      durationMinutes: duration,
      billedMinutes,
      rateAtEntry: rate,
      currency: SEED_CONTENT.currency,
      narrative,
      billable,
      status,
      taskCode,
      activityCode,
      invoiceId,
    });
  }
  return entries;
};

// ─── Due-diligence invoice entries ─────────────────────

// The sent invoice the marketing invoicing capture opens (`invoice-2`,
// INV-2025-0003). Its billed entries are its own: same matter, narratives
// about that matter's documents, rates in CZK minor units, and the invoice
// total is their sum. The extended entries above never link to it.
const DUE_DILIGENCE_INVOICE_INDEX = 2;
const DUE_DILIGENCE_WS_LABEL = "ws-due-diligence" satisfies MainMatterLabel;

// Narratives come from the content pack, in this order.
const DUE_DILIGENCE_INVOICE_ENTRIES = [
  {
    date: "2025-02-03",
    docIndex: 1,
    minutes: 150,
    task: "REVIEW",
    activity: "ANALYZE",
  },
  {
    date: "2025-02-05",
    docIndex: 2,
    minutes: 90,
    task: "RESEARCH",
    activity: "ANALYZE",
  },
  {
    date: "2025-02-10",
    docIndex: 4,
    minutes: 120,
    task: "REVIEW",
    activity: "ANALYZE",
  },
  {
    date: "2025-02-12",
    docIndex: 1,
    minutes: 180,
    task: "DRAFT",
    activity: "PREPARE",
  },
  {
    date: "2025-02-18",
    docIndex: 3,
    minutes: 210,
    task: "DRAFT",
    activity: "PREPARE",
  },
  {
    date: "2025-02-20",
    docIndex: 3,
    minutes: 60,
    task: "MEETING",
    activity: "COMMUNICATE",
  },
] as const;

const buildDueDiligenceInvoiceEntries = (
  invoiceId: InvoiceId,
  userIds: readonly string[],
  userRates: Record<string, number>,
): ExtendedTimeEntrySeed[] => {
  const workspace = seedWorkspaceFor(DUE_DILIGENCE_WS_LABEL);
  return DUE_DILIGENCE_INVOICE_ENTRIES.map((entry, index) => {
    const userId = at(userIds, index % userIds.length);
    const narrative = at(SEED_CONTENT.billing.invoiceEntryNarratives, index);
    return {
      id: seedId(`dd-invoice-time-entry-${index}`),
      workspaceId: workspace.id,
      userId,
      matterId: seedId(`${DUE_DILIGENCE_WS_LABEL}-doc-${entry.docIndex}`),
      dateWorked: entry.date,
      durationMinutes: entry.minutes,
      billedMinutes: entry.minutes,
      // Seed user rates are whole currency units per hour; entries store
      // minor units.
      rateAtEntry: (userRates[userId] ?? 4000) * 100,
      currency: SEED_CONTENT.currency,
      narrative,
      billable: true,
      status: "billed",
      taskCode: entry.task,
      activityCode: entry.activity,
      invoiceId,
    };
  });
};

const sumTimeEntryAmounts = (entries: readonly ExtendedTimeEntrySeed[]) =>
  entries.reduce(
    (total, entry) =>
      total +
      timeEntryAmount({
        billedMinutes: entry.billedMinutes,
        rateAtEntry: cents(entry.rateAtEntry),
        noCharge: false,
      }),
    0,
  );

// ─── Expenses (~50) ────────────────────────────────────

type ExpenseSeed = {
  id: ExpenseId;
  workspaceId: WorkspaceId;
  userId: string;
  matterId: EntityId;
  dateIncurred: string;
  amount: number;
  currency: string;
  category: ExpenseCategory;
  description: string;
  billable: boolean;
  status: TimeEntryStatus;
};

const SEED_EXPENSE_CATEGORIES = [
  "filing_fee",
  "travel",
  "expert_witness",
  "printing",
  "courier",
  "other",
] as const satisfies readonly ExpenseCategory[];

type MissingSeedExpenseCategory = Exclude<
  ExpenseCategory,
  (typeof SEED_EXPENSE_CATEGORIES)[number]
>;

true satisfies MissingSeedExpenseCategory extends never ? true : never;

const buildExpenses = (userIds: readonly string[]): ExpenseSeed[] => {
  const expenseSeeds: ExpenseSeed[] = [];
  const TARGET = 50;

  for (let i = 0; i < TARGET; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    const wsLabel = at(WS_LABELS, wsIndex);
    const matterId = seedId(`${wsLabel}-doc-1`);
    const userId = pickAuthor(userIds, i);
    const dayOffset = (i * 3) % 90;
    const date = new Date(2024, 11, 1 + dayOffset);
    const dateStr = date.toISOString().slice(0, 10);

    // Amounts 500–50000 CZK
    const amount = 500 + ((i * 997) % 49_501);
    const category = at(
      SEED_EXPENSE_CATEGORIES,
      i % SEED_EXPENSE_CATEGORIES.length,
    );
    const descriptions = SEED_CONTENT.billing.expenseDescriptions;
    const description = at(descriptions, i % descriptions.length);
    const billable = i % 5 !== 0;
    const statusRoll = i % 10;
    let status: ExpenseSeed["status"] = "draft";
    if (statusRoll >= 9) {
      status = "written_off";
    } else if (statusRoll >= 7) {
      status = "billed";
    } else if (statusRoll >= 4) {
      status = "approved";
    }

    expenseSeeds.push({
      id: seedId(`expense-${i}`),
      workspaceId: ws.id,
      userId,
      matterId,
      dateIncurred: dateStr,
      amount,
      currency: SEED_CONTENT.currency,
      category,
      description,
      billable,
      status,
    });
  }
  return expenseSeeds;
};

// ─── Invoices (~5) ─────────────────────────────────────

type InvoiceSeed = {
  id: InvoiceId;
  workspaceId: WorkspaceId;
  invoiceNumber: string;
  status: Exclude<InvoiceStatus, "void">;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  totalAmount: number;
};

const invoiceSeedId = (index: number): InvoiceId => seedId(`invoice-${index}`);

const buildInvoices = (dueDiligenceTotal: number): InvoiceSeed[] => {
  const invoiceStatuses = [
    "draft",
    "finalized",
    "sent",
    "paid",
    "sent",
  ] as const;
  const invoiceSeeds: InvoiceSeed[] = [];
  for (let i = 0; i < 5; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    invoiceSeeds.push({
      id: invoiceSeedId(i),
      workspaceId: ws.id,
      invoiceNumber: `${SEED_CONTENT.billing.invoiceNumberPrefix}-2025-${String(i + 1).padStart(4, "0")}`,
      status: at(invoiceStatuses, i),
      invoiceDate: `2025-0${i + 1}-15`,
      dueDate: `2025-0${i + 2}-15`,
      currency: SEED_CONTENT.currency,
      totalAmount:
        i === DUE_DILIGENCE_INVOICE_INDEX
          ? dueDiligenceTotal
          : 50_000 + i * 25_000,
    });
  }
  return invoiceSeeds;
};

// ─── Additional workspaces for overview stress-testing ──

const MORE_WORKSPACES = SEED_CONTENT.extraMatters;

// ─── Playbooks (knowledge base) ─────────────────────────

type DdPositionInput = {
  /** Stable seedId label suffix; keys the sourceId and every tier id. */
  key: string;
  issue: string;
  severity: PositionSeverity;
  ideal: string;
  fallback: { label: string; text: string };
  redLine: string;
  guidance: string;
  negotiation: {
    rationale: string;
    talkingPoints: string[];
    escalation: string;
  };
};

// An English, unscoped (no documentTypeKey) graded playbook for the Project
// Atlas data room: `POST /workspaces/:id/playbooks/:playbookId/run` with
// `{ projection: "columns" }` grades every document in the matter. Sample
// standards only; not legal advice.
const DD_GENERAL_POSITIONS: DdPositionInput[] = [
  {
    key: "governing-law",
    issue: "Governing law",
    severity: "high",
    ideal:
      "This Agreement is governed by the laws of the Czech Republic, without regard to its conflict-of-laws rules.",
    fallback: {
      label: "Other EU member state",
      text: "This Agreement is governed by the laws of another EU member state.",
    },
    redLine: "Governing law of a jurisdiction outside the EU or the EEA.",
    guidance:
      "Target-group contracts should sit under Czech or EU law so post-closing disputes run in a familiar forum.",
    negotiation: {
      rationale:
        "Non-EU law raises enforcement cost and uncertainty for the buyer's post-closing risk model.",
      talkingPoints: [
        "Offer the law of the counterparty's EU member state as a compromise.",
        "Pair any concession with an EU court or arbitration seat.",
      ],
      escalation:
        "Escalate to deal counsel when the counterparty insists on non-EU law.",
    },
  },
  {
    key: "limitation-of-liability",
    issue: "Limitation of liability",
    severity: "blocker",
    ideal:
      "Each party's aggregate liability under this Agreement is capped at the fees paid or payable in the twelve months preceding the claim, excluding liability for wilful misconduct, gross negligence and breach of confidentiality.",
    fallback: {
      label: "Cap at 200% of annual fees",
      text: "Aggregate liability is capped at twice the fees paid or payable in the preceding twelve months.",
    },
    redLine:
      "Uncapped liability of the target, or a cap applying to the counterparty only.",
    guidance:
      "Asymmetric or uncapped exposure of the target is a valuation item; flag it for the SPA indemnity schedule.",
    negotiation: {
      rationale:
        "Uncapped target exposure passes straight through to the buyer after closing.",
      talkingPoints: [
        "Ask for a mutual cap at 100-200% of annual fees.",
        "Carve out only the customary exceptions (wilful misconduct, confidentiality, IP infringement).",
      ],
      escalation: "Escalate when the counterparty refuses any mutual cap.",
    },
  },
  {
    key: "change-of-control",
    issue: "Change of control",
    severity: "blocker",
    ideal:
      "A change of control of either party does not require the other party's consent and does not give rise to a termination right.",
    fallback: {
      label: "Notice only",
      text: "The affected party notifies the other party of a change of control within 30 days; no consent or termination right arises.",
    },
    redLine:
      "The counterparty may terminate, or must consent, upon a change of control of the target.",
    guidance:
      "Consent or termination rights triggered by the acquisition must be listed as closing conditions or consents to obtain.",
    negotiation: {
      rationale:
        "A change-of-control trigger lets the counterparty walk away or re-price at closing.",
      talkingPoints: [
        "Replace consent with a notice obligation.",
        "Limit any termination right to a change of control in favour of a named competitor.",
      ],
      escalation:
        "Escalate every consent requirement to the transaction team for the consents schedule.",
    },
  },
  {
    key: "assignment",
    issue: "Assignment",
    severity: "medium",
    ideal:
      "Either party may assign this Agreement to an affiliate or to a successor of all or substantially all of its business without the other party's consent.",
    fallback: {
      label: "Consent not unreasonably withheld",
      text: "Assignment requires the other party's prior written consent, not to be unreasonably withheld, conditioned or delayed.",
    },
    redLine:
      "Assignment prohibited outright, including to affiliates and successors.",
    guidance:
      "Free assignability to affiliates and successors keeps post-closing restructuring simple.",
    negotiation: {
      rationale:
        "An absolute ban blocks intra-group reorganisations after closing.",
      talkingPoints: [
        "Ask for an affiliate and successor carve-out.",
        "Accept a consent requirement for assignments to unrelated third parties.",
      ],
      escalation:
        "Escalate only when the contract is material to the business plan.",
    },
  },
  {
    key: "termination-for-convenience",
    issue: "Termination for convenience",
    severity: "high",
    ideal:
      "Neither party may terminate this Agreement for convenience during the initial term; thereafter either party may terminate on six months' written notice.",
    fallback: {
      label: "Mutual short notice",
      text: "Either party may terminate for convenience on at least three months' written notice.",
    },
    redLine:
      "The counterparty may terminate for convenience on less than 30 days' notice while the target may not.",
    guidance:
      "A one-sided walk-away right undermines revenue visibility assumed in the valuation.",
    negotiation: {
      rationale:
        "Revenue from a contract the counterparty can end at will cannot be treated as recurring.",
      talkingPoints: [
        "Ask for a mutual convenience right with equal notice periods.",
        "Trade a longer notice period for a termination fee covering unrecovered costs.",
      ],
      escalation: "Escalate for top-ten customer and supplier contracts.",
    },
  },
  {
    key: "non-compete-exclusivity",
    issue: "Non-compete and exclusivity",
    severity: "high",
    ideal:
      "This Agreement contains no non-compete, exclusivity or most-favoured-customer obligation binding the target or its affiliates.",
    fallback: {
      label: "Narrow product or territory exclusivity",
      text: "Exclusivity is limited to a named product line or territory and expires with the initial term.",
    },
    redLine:
      "A non-compete or exclusivity obligation that binds the target's affiliates or survives termination.",
    guidance:
      "Restrictions that extend to affiliates would bind the buyer group after closing.",
    negotiation: {
      rationale:
        "Group-wide or surviving restrictions can conflict with the buyer's existing business.",
      talkingPoints: [
        "Limit the restriction to the contracting entity and the contract term.",
        "Replace exclusivity with a volume commitment or a right of first offer.",
      ],
      escalation:
        "Escalate any restriction reaching affiliates to antitrust counsel.",
    },
  },
  {
    key: "confidentiality",
    issue: "Confidentiality",
    severity: "medium",
    ideal:
      "Each party keeps the other party's confidential information confidential for the term and five years thereafter, subject to customary carve-outs and a permitted disclosure to advisers and prospective acquirers under equivalent obligations.",
    fallback: {
      label: "Mutual, no acquirer carve-out",
      text: "Mutual confidentiality obligations with customary carve-outs but no express disclosure right towards prospective acquirers.",
    },
    redLine:
      "No confidentiality obligation on the counterparty, or an obligation binding the target only.",
    guidance:
      "Check that sharing the contract in the data room is itself permitted; note any breach to disclose in the SPA.",
    negotiation: {
      rationale:
        "A one-way duty leaves the target's know-how unprotected after closing.",
      talkingPoints: [
        "Ask for mutual obligations with an adviser and acquirer carve-out.",
        "Cap the survival period at three to five years.",
      ],
      escalation:
        "Escalate if data-room disclosure itself breaches the clause.",
    },
  },
  {
    key: "indemnity",
    issue: "Indemnity",
    severity: "low",
    ideal:
      "Indemnities are mutual, limited to third-party claims for IP infringement, breach of confidentiality and breach of law, and are subject to the liability cap.",
    fallback: {
      label: "Mutual, outside the cap",
      text: "Mutual third-party-claim indemnities that sit outside the general liability cap.",
    },
    redLine:
      "A broad first-party indemnity from the target covering all losses, including indirect and consequential loss.",
    guidance:
      "Broad first-party indemnities are disguised uncapped liability; read them together with the liability clause.",
    negotiation: {
      rationale:
        "A broad indemnity bypasses the negotiated liability cap and the exclusion of indirect loss.",
      talkingPoints: [
        "Restrict indemnities to third-party claims.",
        "Bring the indemnity under the general cap or agree a separate sub-cap.",
      ],
      escalation: "Escalate when combined with uncapped liability.",
    },
  },
];

const buildDdGeneralPosition = (input: DdPositionInput): Position => ({
  mode: "graded",
  sourceId: seedId(`playbook-dd-general-pos-${input.key}`),
  issue: input.issue,
  severity: input.severity,
  ask: {
    mode: "manual",
    question: `What does the agreement provide regarding the following issue: ${input.issue}? Quote the operative wording.`,
    content: { version: 1, type: "text" },
  },
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [],
        ideal: { source: "inline", text: input.ideal },
      },
      fallback: {
        entries: [
          {
            id: seedId(`playbook-dd-general-fb-${input.key}`),
            label: input.fallback.label,
            text: input.fallback.text,
          },
        ],
      },
      notAcceptable: {
        rules: [
          {
            id: seedId(`playbook-dd-general-rl-${input.key}`),
            text: input.redLine,
          },
        ],
      },
    },
  },
  guidance: input.guidance,
  negotiation: input.negotiation,
  enabled: true,
});

const seedDdGeneralPlaybook = async (
  organizationId: SafeId<"organization">,
): Promise<void> => {
  const definitionId = seedId("playbook-dd-general");
  // Same delete-then-insert as the Czech playbook: reruns pick up position
  // changes and materialized columns re-adopt by deterministic sourceId.
  await db.transaction(
    async (tx) =>
      await tx
        .delete(playbookDefinitions)
        .where(eq(playbookDefinitions.id, definitionId)),
  );
  await db.transaction(
    async (tx) =>
      await tx
        .insert(playbookDefinitions)
        .values({
          id: definitionId,
          organizationId,
          name: "Due Diligence Review (General)",
          description:
            "Buyer-side red-flag review of target contracts; applies to every document type.",
          scope: { perspective: "buyer" },
          positions: {
            version: 3,
            items: DD_GENERAL_POSITIONS.map(buildDdGeneralPosition),
          } satisfies PlaybookPositions,
        })
        .onConflictDoNothing(),
  );
};

export const seedPlaybooks = async (
  organizationId: SafeId<"organization">,
): Promise<void> => {
  // The payment-terms position is graded by a deterministic constraint over its
  // own extracted value, so the constraint's property operand must point back to
  // this position's sourceId. Build it once and reuse it for both.
  const paymentTermsSourceId = seedId("playbook-cz-pos-splatnost-faktur");
  const definitionId = seedId("playbook-cz-obchodni-smlouva");

  // onConflictDoNothing would keep a stale definition, so reruns must delete the
  // prior seed playbook first to pick up position/scope changes. The
  // properties.playbook_definition_id FK nulls rather than cascades, so columns
  // the previous seed materialized are orphaned, not dropped; the position
  // sourceIds are deterministic, so the next run re-adopts them by
  // playbook_source_id.
  await db.transaction(
    async (tx) =>
      await tx
        .delete(playbookDefinitions)
        .where(eq(playbookDefinitions.id, definitionId)),
  );

  await db.transaction(
    async (tx) =>
      await tx
        .insert(playbookDefinitions)
        .values({
          id: definitionId,
          organizationId,
          name: "Kontrola obchodní smlouvy (CZ)",
          description:
            "Standardní revize obchodních a akvizičních smluv podle českého práva.",
          scope: {
            documentTypeKey: SPA_DOCUMENT_TYPE_KEY,
            perspective: "buyer",
          },
          positions: {
            version: 3,
            items: [
              {
                mode: "graded",
                sourceId: seedId("playbook-cz-pos-rozhodne-pravo"),
                issue: "Rozhodné právo",
                severity: "high",
                ask: {
                  mode: "manual",
                  question: "Jakým právním řádem se smlouva řídí?",
                  content: { version: 1, type: "text" },
                },
                standard: {
                  source: "tiers",
                  tiers: {
                    acceptable: {
                      rules: [],
                      ideal: {
                        source: "inline",
                        text: "Smlouva se řídí právním řádem České republiky.",
                      },
                    },
                    fallback: {
                      entries: [
                        {
                          id: seedId("playbook-cz-fb-rozhodne-pravo-eu"),
                          text: "Smlouva se řídí právem jiného členského státu Evropské unie.",
                        },
                      ],
                    },
                    notAcceptable: { rules: [] },
                  },
                },
                guidance:
                  "Preferujeme volbu českého práva; jiné právo EU je akceptovatelný ústupek.",
                enabled: true,
              },
              {
                mode: "graded",
                sourceId: seedId("playbook-cz-pos-omezeni-odpovednosti"),
                issue: "Omezení odpovědnosti za škodu",
                severity: "blocker",
                ask: {
                  mode: "manual",
                  question:
                    "Je odpovědnost smluvní strany za škodu omezena? Pokud ano, jaká je maximální výše náhrady?",
                  content: { version: 1, type: "text" },
                },
                standard: {
                  source: "tiers",
                  tiers: {
                    acceptable: {
                      rules: [],
                      ideal: {
                        source: "inline",
                        text: "Odpovědnost za škodu je omezena a její celková výše nepřesahuje cenu plnění sjednanou ve smlouvě.",
                      },
                    },
                    fallback: {
                      entries: [
                        {
                          id: seedId("playbook-cz-fb-omezeni-odpovednosti-2x"),
                          text: "Odpovědnost za škodu je omezena na dvojnásobek roční hodnoty plnění.",
                        },
                      ],
                    },
                    notAcceptable: { rules: [] },
                  },
                },
                guidance:
                  "Neomezená odpovědnost je nepřijatelná; vyžaduje eskalaci.",
                enabled: true,
              },
              {
                mode: "graded",
                sourceId: paymentTermsSourceId,
                issue: "Splatnost faktur (dny)",
                severity: "medium",
                ask: {
                  mode: "manual",
                  question:
                    "Jaká je splatnost faktur ve dnech? Odpověz pouze číslem.",
                  content: { version: 1, type: "int" },
                },
                standard: {
                  source: "tiers",
                  tiers: {
                    acceptable: { rules: [] },
                    fallback: { entries: [] },
                    notAcceptable: { rules: [] },
                  },
                },
                check: {
                  kind: "constraint",
                  condition: {
                    type: "group",
                    combinator: "and",
                    children: [
                      {
                        type: "compare",
                        left: {
                          type: "property",
                          propertyId: paymentTermsSourceId,
                        },
                        op: "lte",
                        right: { type: "literal", value: 30 },
                      },
                    ],
                  } satisfies ConditionNode,
                },
                guidance: "Splatnost nad 30 dnů zhoršuje cash flow.",
                enabled: true,
              },
              {
                mode: "graded",
                sourceId: seedId("playbook-cz-pos-mlcenlivost"),
                issue: "Mlčenlivost",
                severity: "high",
                ask: {
                  mode: "manual",
                  question:
                    "Cituj ustanovení smlouvy o mlčenlivosti / ochraně důvěrných informací, je-li ve smlouvě obsaženo.",
                  content: { version: 1, type: "text" },
                },
                standard: {
                  source: "tiers",
                  tiers: {
                    acceptable: { rules: [] },
                    fallback: { entries: [] },
                    notAcceptable: { rules: [] },
                  },
                },
                check: { kind: "presence", expectation: "required" },
                guidance: "Smlouva musí obsahovat závazek mlčenlivosti.",
                enabled: true,
              },
              {
                mode: "graded",
                sourceId: seedId("playbook-cz-pos-change-of-control"),
                issue: "Změna ovládání (change of control)",
                severity: "high",
                ask: {
                  mode: "manual",
                  question:
                    "Cituj ustanovení vyžadující souhlas druhé strany při změně ovládání (change of control) jedné ze stran, existuje-li.",
                  content: { version: 1, type: "text" },
                },
                standard: {
                  source: "tiers",
                  tiers: {
                    acceptable: { rules: [] },
                    fallback: { entries: [] },
                    notAcceptable: { rules: [] },
                  },
                },
                check: { kind: "presence", expectation: "restricted" },
                guidance:
                  "Požadavek na souhlas při change of control je riziko pro akvizici – nutno označit.",
                enabled: true,
              },
              {
                mode: "extract",
                sourceId: seedId("playbook-cz-pos-vypovedni-doba"),
                issue: "Výpovědní doba",
                ask: {
                  question: "Jaká je výpovědní doba pro ukončení smlouvy?",
                  content: { version: 1, type: "text" },
                },
                enabled: true,
              },
              {
                mode: "extract",
                sourceId: seedId("playbook-cz-pos-doba-trvani"),
                issue: "Doba trvání a automatické prodloužení",
                ask: {
                  question:
                    "Na jakou dobu je smlouva uzavřena a obsahuje doložku o automatickém prodloužení (auto-renewal)?",
                  content: { version: 1, type: "text" },
                },
                enabled: true,
              },
              {
                mode: "graded",
                sourceId: seedId("playbook-cz-pos-reseni-sporu"),
                issue: "Řešení sporů",
                severity: "medium",
                ask: {
                  mode: "manual",
                  question:
                    "Jak se řeší spory ze smlouvy — příslušnými soudy ČR, nebo v rozhodčím řízení?",
                  content: { version: 1, type: "text" },
                },
                standard: {
                  source: "tiers",
                  tiers: {
                    acceptable: {
                      rules: [],
                      ideal: {
                        source: "inline",
                        text: "Spory z této smlouvy rozhodují věcně a místně příslušné soudy České republiky.",
                      },
                    },
                    fallback: {
                      entries: [
                        {
                          id: seedId("playbook-cz-fb-reseni-sporu-rozhodci"),
                          text: "Spory se řeší v rozhodčím řízení u Rozhodčího soudu při Hospodářské komoře ČR a Agrární komoře ČR.",
                        },
                      ],
                    },
                    notAcceptable: { rules: [] },
                  },
                },
                enabled: true,
              },
            ],
          } satisfies PlaybookPositions,
        })
        .onConflictDoNothing(),
  );

  await seedDdGeneralPlaybook(organizationId);

  console.log("  Playbooks: 2");
};

// ─── Main ───────────────────────────────────────────────

type UserFileCleanupRow = {
  organizationId: string;
  s3Key: string;
  thumbnailFileId: string | null;
  userId: string;
};

export const userFileCleanupKeys = ({
  organizationId,
  s3Key,
  thumbnailFileId,
  userId,
}: UserFileCleanupRow): string[] => {
  if (thumbnailFileId === null) {
    return [s3Key];
  }
  const thumbnailKey = createUserFileThumbnailKey({
    sourceKey: s3Key,
    thumbnailFileId,
    organizationId: brandPersistedOrganizationId(organizationId),
    uploaderUserId: brandPersistedUserId(userId),
  });
  return thumbnailKey === null ? [s3Key] : [s3Key, thumbnailKey];
};

export async function seed(organizationId?: string, userId?: string) {
  requireLocalDevOpen("Seeding");
  const ORG_ID = toSafeId<"organization">(organizationId ?? DEFAULT_ORG_ID);
  // The module-level tables were built in one locale; never write them into
  // another locale's firm.
  assertSeedLocaleMatches(ORG_ID);
  let USER_ID = userId ?? DEFAULT_USER_ID;
  const toWs = (id: WorkspaceId) => id;

  /** The owner first, then the colleagues in author rotation order. */
  const ensureSeedUsers = async (): Promise<readonly string[]> => {
    if (ORG_ID === DEFAULT_ORG_ID && USER_ID === DEFAULT_USER_ID) {
      const { colleagueUserIds, testUserId } = await ensureTestUsers(ORG_ID);
      USER_ID = testUserId;
      return [
        testUserId,
        ...colleagueUserIds.slice(0, DEFAULT_SEED_COLLEAGUE_COUNT),
      ];
    }
    await ensurePrimarySeedUserInOrganization({
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    const colleagueUserIds = await ensureSeedColleaguesInOrganization({
      organizationId: ORG_ID,
      colleagues: SEED_CONTENT.colleagues,
    });
    return [USER_ID, ...colleagueUserIds];
  };

  /**
   * Delete every chat file stored in threads of these workspaces: generated
   * views and anything a developer uploaded since the last seed. Objects (and
   * image thumbnails) go first, as the thread delete handler does, so no row
   * removal leaves an unreachable object behind.
   */
  const deleteThreadUserFiles = async (
    workspaceIds: readonly WorkspaceId[],
  ) => {
    const files = await withAggregateTransaction(
      db,
      async (tx) =>
        await tx
          .select({
            id: userFiles.id,
            s3Key: userFiles.s3Key,
            thumbnailFileId: userFiles.thumbnailFileId,
            organizationId: chatThreads.organizationId,
            userId: userFiles.userId,
          })
          .from(userFiles)
          .innerJoin(chatThreads, eq(chatThreads.id, userFiles.threadId))
          .where(inArray(chatThreads.workspaceId, [...workspaceIds])),
    );
    for (const page of chunkItems(files, SEED_INSERT_CHUNK_SIZE)) {
      const deleted = await deleteS3Keys(page.flatMap(userFileCleanupKeys));
      if (deleted.isErr()) {
        panic("Could not delete seeded chat files from storage", deleted.error);
      }
      await withAggregateTransaction(
        db,
        async (tx) =>
          await tx.delete(userFiles).where(
            inArray(
              userFiles.id,
              page.map(({ id }) => id),
            ),
          ),
      );
    }
  };

  const clearSeedData = async () => {
    const allSeedContactIds = [
      ...orgContacts,
      ...personContacts,
      ...moreOrgContacts,
    ].map((contact) => contact.id);
    const allSeedWorkspaceIds = [
      ...seedWorkspaces.map((workspace) => workspace.id),
      ...MORE_WORKSPACES.map((workspace) =>
        seedId(`extra-ws-${workspace.reference}`),
      ),
    ];
    const seedReferences = [...seedWorkspaces, ...MORE_WORKSPACES].map(
      (workspace) => workspace.reference,
    );
    if (allSeedWorkspaceIds.length > 0) {
      await db.transaction(
        async (tx) =>
          await tx
            .delete(chatMessages)
            .where(sql`${chatMessages.workspaceId} IN ${allSeedWorkspaceIds}`),
      );
      // user_files.thread_id uses ON DELETE RESTRICT: a thread's files
      // must go before the thread, stored objects first.
      await deleteThreadUserFiles(allSeedWorkspaceIds);
      await db.transaction(
        async (tx) =>
          await tx
            .delete(chatThreads)
            .where(sql`${chatThreads.workspaceId} IN ${allSeedWorkspaceIds}`),
      );
      // property_dependencies.depends_on_property_id uses ON DELETE RESTRICT,
      // so dependencies must be removed before the workspace cascade.
      await db.transaction(
        async (tx) =>
          await tx
            .delete(propertyDependencies)
            .where(
              sql`${propertyDependencies.workspaceId} IN ${allSeedWorkspaceIds}`,
            ),
      );
      await db.transaction(async (tx) => {
        await tx
          .delete(workspaces)
          .where(sql`${workspaces.id} IN ${allSeedWorkspaceIds}`);
        await tx
          .delete(documentReferenceCounters)
          .where(
            and(
              eq(documentReferenceCounters.organizationId, ORG_ID),
              inArray(documentReferenceCounters.reference, seedReferences),
            ),
          );
      });
    }
    if (allSeedContactIds.length === 0) {
      return;
    }
    // Include manually created workspaces that reference seed contacts, not
    // only workspaces whose IDs came from this script.
    const clientWorkspaces = await db.transaction(
      async (tx) =>
        await tx.query.workspaces.findMany({
          where: { clientId: { in: allSeedContactIds } },
          columns: { id: true },
        }),
    );
    const clientWorkspaceIds = clientWorkspaces.map(
      (workspace) => workspace.id,
    );
    if (clientWorkspaceIds.length > 0) {
      // These relations use ON DELETE RESTRICT and can belong to manually
      // created workspaces that reference deterministic seed contacts.
      await db.transaction(
        async (tx) =>
          await tx
            .delete(chatMessages)
            .where(sql`${chatMessages.workspaceId} IN ${clientWorkspaceIds}`),
      );
      // user_files.thread_id uses ON DELETE RESTRICT: a thread's files
      // must go before the thread, stored objects first.
      await deleteThreadUserFiles(clientWorkspaceIds);
      await db.transaction(
        async (tx) =>
          await tx
            .delete(chatThreads)
            .where(sql`${chatThreads.workspaceId} IN ${clientWorkspaceIds}`),
      );
      await db.transaction(
        async (tx) =>
          await tx
            .delete(propertyDependencies)
            .where(
              sql`${propertyDependencies.workspaceId} IN ${clientWorkspaceIds}`,
            ),
      );
    }
    await db.transaction(
      async (tx) =>
        await tx
          .delete(workspaces)
          .where(sql`${workspaces.clientId} IN ${allSeedContactIds}`),
    );
    await db.transaction(
      async (tx) =>
        await tx
          .delete(contacts)
          .where(sql`${contacts.id} IN ${allSeedContactIds}`),
    );
  };

  // Ensure referenced users exist in the target org before seeding matters,
  // billing, and analytics data; then clear deterministic IDs for replay.
  const seedUserIds = await ensureSeedUsers();
  // Hourly rates in whole currency units: the owner's, then each
  // colleague's, by position.
  const seedUserRates: Record<string, number> = Object.fromEntries(
    seedUserIds.map((id, index) => [
      id,
      index === 0
        ? SEED_CONTENT.ownerHourlyRate
        : (SEED_CONTENT.colleagues[index - 1]?.hourlyRate ?? 4000),
    ]),
  );
  await clearSeedData();

  console.log("Seeding development data...\n");

  const seedContacts = async () => {
    const primaryUserId = USER_ID;
    // 1. Contacts (original orgs + people)
    const coreContacts = [...orgContacts, ...personContacts];
    for (const c of coreContacts) {
      await db.transaction(
        async (tx) =>
          await tx
            .insert(contacts)
            .values({
              id: c.id,
              organizationId: ORG_ID,
              type: c.type,
              displayName: c.displayName,
              prefix: "prefix" in c ? c.prefix : undefined,
              firstName: "firstName" in c ? c.firstName : undefined,
              lastName: "lastName" in c ? c.lastName : undefined,
              suffix: "suffix" in c ? c.suffix : undefined,
              organizationName:
                "organizationName" in c ? c.organizationName : undefined,
              notes: "notes" in c ? c.notes : undefined,
              emails: "emails" in c ? c.emails : undefined,
              phones: "phones" in c ? c.phones : undefined,
              color: c.color,
              registrationNumber:
                "registrationNumber" in c ? c.registrationNumber : undefined,
              taxId: "taxId" in c ? c.taxId : undefined,
              bankAccounts: "bankAccounts" in c ? c.bankAccounts : undefined,
              billingAddress:
                "billingAddress" in c ? c.billingAddress : undefined,
              defaultHourlyRate:
                "defaultHourlyRate" in c
                  ? cents(c.defaultHourlyRate)
                  : undefined,
              currency: "currency" in c ? c.currency : undefined,
              paymentTermDays:
                "paymentTermDays" in c ? c.paymentTermDays : undefined,
              originatingAttorneyId: primaryUserId,
              responsibleAttorneyId: primaryUserId,
              createdBy: primaryUserId,
            })
            .onConflictDoNothing(),
      );
    }
    // 1b. Additional org contacts for overview stress-testing
    for (const c of moreOrgContacts) {
      await db.transaction(
        async (tx) =>
          await tx
            .insert(contacts)
            .values({
              id: c.id,
              organizationId: ORG_ID,
              type: c.type,
              displayName: c.displayName,
              organizationName: c.organizationName,
              registrationNumber: c.registrationNumber,
              taxId: c.taxId,
              billingAddress: c.billingAddress,
              defaultHourlyRate: cents(c.defaultHourlyRate),
              currency: c.currency,
              paymentTermDays: c.paymentTermDays,
              emails: c.emails,
              color: c.color,
              originatingAttorneyId: primaryUserId,
              responsibleAttorneyId: primaryUserId,
              createdBy: primaryUserId,
            })
            .onConflictDoNothing(),
      );
    }
    const totalContacts = coreContacts.length + moreOrgContacts.length;
    console.log(
      `  Contacts: ${totalContacts} (${orgContacts.length + moreOrgContacts.length} orgs, ${personContacts.length} people)`,
    );
  };
  await seedContacts();

  // 1c. Organization settings: pin the practice jurisdiction (the seeded
  // cast is a Czech firm) so jurisdiction-derived surfaces, notably the
  // Knowledge tools catalogue's recommended section that the marketing cli
  // scene films, render identically on every fresh seed instead of
  // depending on whatever settings live dev usage left behind. Re-pinned on
  // conflict; other settings columns stay untouched.
  const practiceJurisdictions: PracticeJurisdiction[] = [
    { countryCode: "CZ", isPrimary: true },
  ];
  await db.transaction(
    async (tx) =>
      await tx
        .insert(organizationSettings)
        .values({
          id: seedId("org-settings"),
          organizationId: ORG_ID,
          practiceJurisdictions,
        })
        .onConflictDoUpdate({
          target: organizationSettings.organizationId,
          set: { practiceJurisdictions },
        }),
  );
  console.log("  Organization settings: practice jurisdiction CZ pinned");

  // 2. Workspaces. lastActivityAt is pinned (never defaultNow()) so the
  // sidebar "Recent matters" ordering the marketing recordings film stays
  // deterministic; the conflict path re-pins it so a reseed restores the
  // ordering even when live activity bumped it in the shared dev DB.
  // Collected per workspace because entity timestamps below derive from it.
  const workspaceActivityById = new Map<WorkspaceId, Date>();
  for (const [wsIndex, ws] of seedWorkspaces.entries()) {
    const lastActivityAt = workspaceLastActivityAt(ws.reference, wsIndex);
    workspaceActivityById.set(ws.id, lastActivityAt);
    await db.transaction(
      async (tx) =>
        await tx
          .insert(workspaces)
          .values({
            id: ws.id,
            organizationId: ORG_ID,
            name: ws.name,
            reference: ws.reference,
            clientId: ws.clientId,
            billingReference:
              "billingReference" in ws ? ws.billingReference : undefined,
            lastActivityAt,
          })
          .onConflictDoUpdate({
            target: workspaces.id,
            set: { lastActivityAt },
          }),
    );
  }
  // 2b. Additional workspaces (overview stress-testing)
  let moreWsCount = 0;
  for (const mw of MORE_WORKSPACES) {
    const clientId = seedId(mw.clientLabel);
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const lastActivityAt = workspaceLastActivityAt(
      mw.reference,
      seedWorkspaces.length + moreWsCount,
    );
    workspaceActivityById.set(wsId, lastActivityAt);
    await db.transaction(
      async (tx) =>
        await tx
          .insert(workspaces)
          .values({
            id: wsId,
            organizationId: ORG_ID,
            name: mw.name,
            reference: mw.reference,
            clientId,
            lastActivityAt,
          })
          .onConflictDoUpdate({
            target: workspaces.id,
            set: { lastActivityAt },
          }),
    );

    moreWsCount++;
  }
  console.log(
    `  Workspaces: ${seedWorkspaces.length} + ${moreWsCount} extra = ${seedWorkspaces.length + moreWsCount}`,
  );

  const marketingAgentWorkspace = seedWorkspaceFor(EXPORT_TABLE_MATTER_LABEL);
  const marketingAgent = buildMarketingAgentThread({
    createdAt: new Date("2026-07-16T09:30:00.000Z"),
    locale: SEED_LOCALE,
    organizationId: ORG_ID,
    userId: USER_ID,
    workspaceId: marketingAgentWorkspace.id,
  });
  // The generated view's page is stored like a `show_visual` call stores it:
  // JSON text in the user's chat-file space, read back through
  // /v1/user-files/:fileId/visual.
  await writeS3ObjectWithRetry(
    {
      data: marketingAgent.visualFile.bytes,
      key: marketingAgent.visualFile.row.s3Key,
    },
    { type: "fixture" },
  );
  await withAggregateTransaction(db, async (tx) => {
    await tx.insert(chatThreads).values(marketingAgent.thread);
    await tx.insert(chatMessages).values(marketingAgent.messages);
    await tx.insert(userFiles).values(marketingAgent.visualFile.row);
  });
  console.log(
    `  Marketing agent story: 1 thread, ${String(marketingAgent.messages.length)} messages, 1 generated view`,
  );

  // 2c. Workspace members — add all seed users to every workspace
  const allWsIds = [
    ...seedWorkspaces.map((ws) => ws.id),
    ...MORE_WORKSPACES.map((mw) => seedId(`extra-ws-${mw.reference}`)),
  ];
  for (const wsId of allWsIds) {
    for (const uid of seedUserIds) {
      await db.transaction(
        async (tx) =>
          await tx
            .insert(workspaceMembers)
            .values({
              id: seedId(`wm-${wsId}-${uid}`),
              workspaceId: toWs(wsId),
              userId: uid,
            })
            .onConflictDoNothing(),
      );
    }
  }
  console.log(
    `  Workspace members: ${allWsIds.length} × ${seedUserIds.length} users`,
  );

  // 3. Properties
  const allProperties: PropertySeed[] = [];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    allProperties.push(
      ...buildProperties(at(seedWorkspaces, i).id, at(WS_LABELS, i)),
    );
  }
  for (const mw of MORE_WORKSPACES) {
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const label = `extra-ws-${mw.reference}`;
    allProperties.push(...buildProperties(wsId, label));
  }
  for (const prop of allProperties) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(properties)
          .values({
            id: prop.id,
            workspaceId: toWs(prop.workspaceId),
            name: prop.name,
            content: prop.content,
            tool: prop.tool,
            // Seed AI properties as stale so the workflow planner picks
            // them up on first run; everything else is user-managed and
            // fresh from creation.
            status: prop.tool.type === "ai-model" ? "stale" : "fresh",
            ...(prop.system !== undefined && { system: prop.system }),
            ...(prop.kinds !== undefined && { kinds: prop.kinds }),
          })
          .onConflictDoNothing(),
    );
  }
  console.log(
    `  Properties: ${allProperties.length} (${allProperties.length / seedWorkspaces.length}/workspace)`,
  );

  // 3b. Default views — one set per workspace, pinned to the file column.
  // Listing views is now a pure read, so directly-seeded workspaces (which
  // never hit the create handler) must have their default views seeded here,
  // exactly as production does at workspace creation.
  const fileProperties = allProperties.filter(
    (prop) => prop.system === true && prop.content.type === "file",
  );
  // Skip workspaces that already have views: `workspace_views` has only a
  // primary key, so `onConflictDoNothing` catches nothing on the fresh ids a
  // reseed generates and would accumulate duplicate default tabs each run.
  // Seed only workspaces with none, matching the production create path and the
  // backfill migration's NOT EXISTS guard.
  const seededViewWorkspaceIds = new Set(
    (
      await db.transaction(
        async (tx) =>
          await tx
            .select({ workspaceId: workspaceViews.workspaceId })
            .from(workspaceViews),
      )
    ).map((row) => row.workspaceId),
  );
  const viewRows = fileProperties
    .filter((prop) => !seededViewWorkspaceIds.has(prop.workspaceId))
    .flatMap((prop) =>
      buildDefaultViewRows({
        workspaceId: toWs(prop.workspaceId),
        filePropertyId: prop.id,
      }),
    );
  if (viewRows.length > 0) {
    await db.transaction(
      async (tx) => await tx.insert(workspaceViews).values(viewRows),
    );
  }
  console.log(
    `  Views: ${viewRows.length} (${fileProperties.length} workspaces × default set)`,
  );

  // 4. Entities + entity versions
  const allEntities: EntitySeed[] = [];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    allEntities.push(
      ...buildEntities(at(seedWorkspaces, i).id, at(WS_LABELS, i)),
    );
  }
  // Also create entities in extra workspaces, cycling through
  // the 8 document-name sets so every workspace has docs.
  for (let i = 0; i < MORE_WORKSPACES.length; i++) {
    const mw = at(MORE_WORKSPACES, i);
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const label = `extra-ws-${mw.reference}`;
    allEntities.push(...buildEntities(wsId, label));
  }
  // Rows are written in multi-row chunks: one transaction per row cost
  // seconds of round trips, and every seeded stack start pays for them.
  const entityIndexByWorkspace = new Map<WorkspaceId, number>();
  const entityRows: (typeof entities.$inferInsert)[] = [];
  const plainVersionRows: (typeof entityVersions.$inferInsert)[] = [];
  const supplierAgreementEntities: EntitySeed[] = [];
  for (const [ei, e] of allEntities.entries()) {
    const workspaceActivityAt = workspaceActivityById.get(e.workspaceId);
    if (!workspaceActivityAt) {
      panic(`No pinned activity date for workspace ${e.workspaceId}`);
    }
    const indexInWorkspace = entityIndexByWorkspace.get(e.workspaceId) ?? 0;
    entityIndexByWorkspace.set(e.workspaceId, indexInWorkspace + 1);
    // Pinned like workspaces.lastActivityAt, re-pinned on conflict, so the
    // filmed Created/Modified columns match a fresh seed exactly.
    const { createdAt, updatedAt } = seedEntityTimestamps({
      entityId: e.entityId,
      indexInWorkspace,
      workspaceActivityAt,
    });
    entityRows.push({
      id: e.entityId,
      workspaceId: toWs(e.workspaceId),
      kind: e.kind,
      parentId: e.parentId ?? null,
      name: e.name,
      createdBy: pickAuthor(seedUserIds, ei),
      lastEditedBy: pickAuthor(seedUserIds, ei + 1),
      createdAt,
      updatedAt,
    });
    if (e.name === SUPPLIER_AGREEMENT.fileName) {
      supplierAgreementEntities.push(e);
    } else {
      plainVersionRows.push({
        id: e.versionId,
        workspaceId: toWs(e.workspaceId),
        entityId: e.entityId,
      });
    }
  }

  // Chunks keep input order, so a folder lands before the documents in it.
  for (const chunk of chunkItems(entityRows, SEED_INSERT_CHUNK_SIZE)) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(entities)
          .values(chunk)
          .onConflictDoUpdate({
            target: entities.id,
            set: {
              name: sql`excluded.name`,
              parentId: sql`excluded.parent_id`,
              createdAt: sql`excluded.created_at`,
              updatedAt: sql`excluded.updated_at`,
            },
          }),
    );
  }
  for (const chunk of chunkItems(plainVersionRows, SEED_INSERT_CHUNK_SIZE)) {
    await db.transaction(
      async (tx) =>
        await tx.insert(entityVersions).values(chunk).onConflictDoNothing(),
    );
  }
  for (const e of supplierAgreementEntities) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(entityVersions)
          .values({
            id: e.versionId,
            workspaceId: toWs(e.workspaceId),
            entityId: e.entityId,
            versionNumber: 2,
            label: "Negotiated draft",
          })
          .onConflictDoUpdate({
            target: entityVersions.id,
            set: { versionNumber: 2, label: "Negotiated draft" },
          }),
    );
    await db.transaction(
      async (tx) =>
        await tx
          .insert(entityVersions)
          .values({
            id: supplierAgreementBaseVersionId(e.workspaceId),
            workspaceId: toWs(e.workspaceId),
            entityId: e.entityId,
            versionNumber: 1,
            label: "Initial draft",
          })
          .onConflictDoUpdate({
            target: entityVersions.id,
            set: { versionNumber: 1, label: "Initial draft" },
          }),
    );
  }

  // Link currentVersionId
  for (const chunk of chunkItems(allEntities, SEED_INSERT_CHUNK_SIZE)) {
    await db.transaction(
      async (tx) =>
        await tx
          .update(entities)
          .set({ currentVersionId: sql`${entityVersions.id}` })
          // Drizzle emits FROM before WHERE whatever the call order; `where`
          // follows `set` so the unscoped-update lint can see it.
          .where(
            and(
              eq(entityVersions.entityId, entities.id),
              inArray(
                entityVersions.id,
                chunk.map((e) => e.versionId),
              ),
            ),
          )
          .from(entityVersions),
    );
  }
  console.log(
    `  Entities: ${allEntities.length} (${allEntities.length / seedWorkspaces.length}/workspace)`,
  );

  // 6. Document content: files (S3), file fields, extracted
  //    text, status/metadata fields, and search index.
  //
  //    Content is defined ONCE in `documentTexts` and flows to:
  //      - PDF/DOCX file on S3 (preview)
  //      - `extracted_content` table (AI read-content tool)
  //      - `search_documents` table (AI search-matter tool)
  //      - `fields` table (file field + status/date/notes)
  const IV_BYTES = 12;
  let fileCount = 0;
  const pdfTwinCount = 0;
  let extractedCount = 0;

  // Pool for the extra workspaces' pseudo-random doc picks. The Supplier
  // Agreement is excluded twice over: including it would reshuffle every
  // previously seeded extra workspace's picks (they index into this list
  // modulo its length), and the redlined marketing document should not be
  // cloned into unrelated matters.
  const allDocNames = Object.values(workspaceDocNames)
    .flat()
    .filter(
      (name) =>
        name !== SUPPLIER_AGREEMENT.fileName && seedEmails[name] === undefined,
    );

  /** Seed all document content for a single workspace. */
  const seedDocumentsForWorkspace = async (
    wsId: WorkspaceId,
    wsLabel: string,
    docNames: readonly string[],
  ) => {
    const filePropertyId = seedId(`${wsLabel}-prop-file`);
    const docEntities = allEntities.filter(
      (e) => e.workspaceId === wsId && e.kind === "document",
    );

    for (let j = 0; j < docEntities.length; j++) {
      const entity = at(docEntities, j);
      const fileName = at(docNames, j);
      const format = resolveSeedFileFormat(fileName);

      const title = fileName.replace(fileExtRe, "").replaceAll("_", " ");

      // Single source of truth for document content
      const configuredDocText = documentTexts[fileName];

      // ── S3 file ──
      // The Supplier Agreement ships real tracked changes and comments, so
      // it has a dedicated builder instead of the generic paragraph mock.
      const buildContent = async () => {
        if (fileName === SUPPLIER_AGREEMENT.fileName) {
          return await createSupplierAgreementDocx("keep");
        }
        switch (format.type) {
          case "docx":
            return await createMockDocx(title, configuredDocText);
          case "email":
            return createSeedEmail(fileName, format.email);
          case "pdf":
            return createTextPdf(title, configuredDocText);
          default: {
            format satisfies never;
            return panic(`Unsupported seed file format for ${fileName}`);
          }
        }
      };
      const content = await buildContent();
      let docText = configuredDocText;
      if (format.type === "email") {
        const parsedResult = await parseEmail(
          Uint8Array.from(content).buffer,
          EML_MIME_TYPE,
        );
        if (parsedResult.isErr()) {
          panic(`Could not parse seed email ${fileName}`, parsedResult.error);
        }
        docText = parsedEmailToText(parsedResult.value);
      }

      const { sha256Hex, sizeBytes } = seedFileIdentity(content);

      const fileId = seedId(`${wsLabel}-file-${j}`);
      const s3Key = `${ORG_ID}/${wsId}/${fileId}.${format.extension}`;
      await writeS3ObjectWithRetry(
        {
          data: new Uint8Array(content),
          key: s3Key,
        },
        { type: "fixture" },
      );

      // DOCX files are rendered natively via Folio — no PDF twin needed.
      // Non-DOCX convertible types still get a PDF twin from Gotenberg.
      const pdfFileId: UserFileId | null = null;
      const fileContent = {
        version: 1,
        type: "file",
        id: fileId,
        fileName,
        mimeType: format.mimeType,
        sizeBytes,
        encrypted: false,
        sha256Hex,
        pdfFileId,
      } as const satisfies FieldContent;

      // ── File field ──
      await db.transaction(
        async (tx) =>
          await tx
            .insert(fields)
            .values({
              id: seedId(`${wsLabel}-field-file-${j}`),
              workspaceId: toWs(entity.workspaceId),
              propertyId: filePropertyId,
              entityVersionId: entity.versionId,
              content: fileContent,
            })
            .onConflictDoUpdate({
              target: fields.id,
              set: { content: fileContent },
            }),
      );
      fileCount++;

      if (fileName === SUPPLIER_AGREEMENT.fileName) {
        const baseVersionId = supplierAgreementBaseVersionId(wsId);
        const baseFileId = seedId<"userFile">(
          `${wsLabel}-supplier-agreement-base-file`,
        );
        const baseContent = await createSupplierAgreementDocx("reject");
        const baseIdentity = seedFileIdentity(baseContent);
        await writeS3ObjectWithRetry(
          {
            data: new Uint8Array(baseContent),
            key: `${ORG_ID}/${wsId}/${baseFileId}.docx`,
          },
          { type: "fixture" },
        );
        const baseFileContent = {
          version: 1,
          type: "file",
          id: baseFileId,
          fileName: "Supplier_Agreement_v3.docx",
          mimeType: DOCX_MIME,
          sizeBytes: baseIdentity.sizeBytes,
          encrypted: false,
          sha256Hex: baseIdentity.sha256Hex,
          pdfFileId: null,
        } as const satisfies FieldContent;
        await db.transaction(
          async (tx) =>
            await tx
              .insert(fields)
              .values({
                id: seedId<"field">(`${wsLabel}-supplier-agreement-base-field`),
                workspaceId: toWs(wsId),
                propertyId: filePropertyId,
                entityVersionId: baseVersionId,
                content: baseFileContent,
              })
              .onConflictDoUpdate({
                target: fields.id,
                set: { content: baseFileContent },
              }),
        );
        fileCount++;
      }

      // ── Extracted content (AI reads this) ──
      // Resolve the org from the workspace row so this
      // matches the org the user's session will filter by
      // (workspaces may belong to an org created before
      // the seed ran, e.g. via manual signup).
      if (docText) {
        const ws = await db.transaction(
          async (tx) =>
            await tx.query.workspaces.findFirst({
              where: { id: { eq: toWs(wsId) } },
              columns: { organizationId: true },
            }),
        );
        const ecOrgId = ws?.organizationId ?? ORG_ID;
        const extractionEnvelope = {
          ciphertext: Buffer.from(docText, "utf-8"),
          iv: Buffer.alloc(IV_BYTES),
        };

        await db.transaction(
          async (tx) =>
            await tx
              .insert(extractedContent)
              .values({
                entityId: entity.entityId,
                organizationId: ecOrgId,
                workspaceId: toWs(entity.workspaceId),
                ciphertext: extractionEnvelope.ciphertext,
                iv: extractionEnvelope.iv,
                charCount: docText.length,
                language: null,
                extractedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: extractedContent.entityId,
                set: {
                  ciphertext: extractionEnvelope.ciphertext,
                  iv: extractionEnvelope.iv,
                  charCount: docText.length,
                  extractedAt: new Date(),
                },
              }),
        );
        extractedCount++;
      }
    }
  };

  // Resolve doc names for each workspace
  type WsDocPlan = {
    wsId: WorkspaceId;
    wsLabel: string;
    docNames: readonly string[];
  };
  const docPlans: WsDocPlan[] = [];

  // Main 8 workspaces
  for (let i = 0; i < seedWorkspaces.length; i++) {
    const ws = at(seedWorkspaces, i);
    const wsLabel = at(WS_LABELS, i);
    const docNames = workspaceDocNames[wsLabel];
    if (docNames) {
      docPlans.push({ wsId: ws.id, wsLabel, docNames });
    }
  }

  // Extra workspaces: pseudo-random doc set
  for (let i = 0; i < MORE_WORKSPACES.length; i++) {
    const mw = at(MORE_WORKSPACES, i);
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const wsLabel = `extra-ws-${mw.reference}`;
    const hash = seedId(`${wsLabel}-docs`).codePointAt(0) ?? 0;
    const picked: string[] = [];
    for (let d = 0; d < 4; d++) {
      const idx = (hash + d * 7) % allDocNames.length;
      picked.push(at(allDocNames, idx));
    }
    docPlans.push({ wsId, wsLabel, docNames: picked });
  }

  // Matters are independent: documents are built and uploaded for several
  // at once, while each matter keeps its own document order.
  await mapWithConcurrency({
    items: docPlans,
    limit: SEED_WORKSPACE_CONCURRENCY,
    operation: async (plan) => {
      await seedDocumentsForWorkspace(plan.wsId, plan.wsLabel, plan.docNames);
    },
  });

  console.log(
    `  Files: ${fileCount} (uploaded to S3, ${pdfTwinCount} PDF twins)`,
  );
  console.log(`  Extracted content: ${extractedCount} documents`);

  // 7. Fields (status, due date, notes for each document)
  const allFields: FieldSeed[] = [];
  for (const plan of docPlans) {
    const wsEntities = allEntities.filter((e) => e.workspaceId === plan.wsId);
    allFields.push(...buildFields(plan.wsLabel, wsEntities));
  }
  for (const chunk of chunkItems(allFields, SEED_INSERT_CHUNK_SIZE)) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(fields)
          .values(
            chunk.map((f) => ({
              id: f.id,
              workspaceId: toWs(f.workspaceId),
              propertyId: f.propertyId,
              entityVersionId: f.entityVersionId,
              content: f.content,
            })),
          )
          .onConflictDoNothing(),
    );
  }
  console.log(`  Fields: ${allFields.length}`);

  const allJustifications: JustificationSeed[] = [];
  for (const plan of docPlans) {
    const wsEntities = allEntities.filter((e) => e.workspaceId === plan.wsId);
    allJustifications.push(
      ...buildExportReviewJustifications(plan.wsId, plan.wsLabel, wsEntities),
    );
  }
  for (const chunk of chunkItems(allJustifications, SEED_INSERT_CHUNK_SIZE)) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(justifications)
          .values(
            chunk.map((justification) => ({
              id: justification.id,
              workspaceId: toWs(justification.workspaceId),
              fieldId: justification.fieldId,
              content: justification.content,
              fileFieldIds: justification.fileFieldIds,
            })),
          )
          .onConflictDoNothing(),
    );
  }
  console.log(`  Justifications: ${allJustifications.length}`);

  // 7b. Ensure search prerequisites exist on fresh dev databases.
  // `db:push` syncs declarative schema but does not run migration
  // files, so the unaccent extension, the `stella_unaccent` text
  // search config, and the tsvector column added by the
  // global-search migrations are missing on a freshly pushed DB.
  // Index-time SQL calls `unaccent(...)` and runtime headlines use
  // the `stella_unaccent` regconfig; without these the first
  // `upsertSearchDocument` aborts the whole seed.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_ts_config
        WHERE cfgname = 'stella_unaccent'
          AND cfgnamespace = 'public'::regnamespace
      ) THEN
        CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple);
      END IF;
    END
    $$;
  `);
  await db.execute(sql`
    ALTER TEXT SEARCH CONFIGURATION public.stella_unaccent
      ALTER MAPPING FOR
        asciiword,
        asciihword,
        hword_asciipart,
        word,
        hword,
        hword_part
      WITH unaccent, simple
  `);
  await db.execute(sql`
    ALTER TABLE search_documents
      ADD COLUMN IF NOT EXISTS tsv tsvector
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS search_documents_tsv_idx
      ON search_documents USING gin (tsv)
  `);

  // 7c. Search index (depends on fields + extracted content)
  await mapWithConcurrency({
    items: allEntities,
    limit: SEED_WORKSPACE_CONCURRENCY,
    operation: async (e) => {
      await upsertSearchDocument(e.entityId);
    },
  });
  console.log(`  Search index: ${allEntities.length} documents`);

  // 8. Workspace contacts (parties)
  for (const party of seedParties) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(workspaceContacts)
          .values({
            id: party.id,
            organizationId: ORG_ID,
            workspaceId: toWs(party.workspaceId),
            contactId: party.contactId,
            role: party.role,
          })
          .onConflictDoNothing(),
    );
  }
  console.log(`  Parties: ${seedParties.length}`);

  // 9. Billing codes
  const billingCodeSeeds = buildBillingCodes();
  for (const bc of billingCodeSeeds) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(billingCodes)
          .values({
            id: bc.id,
            organizationId: ORG_ID,
            workspaceId: toWs(bc.workspaceId),
            type: bc.type,
            code: bc.code,
            label: bc.label,
            sortOrder: bc.sortOrder,
          })
          .onConflictDoNothing(),
    );
  }
  console.log(`  Billing codes: ${billingCodeSeeds.length}`);

  // 10. Rate tables + entries
  const { tables: rateTableSeeds, entries: rateEntrySeeds } = buildRateTables({
    userIds: seedUserIds,
    userRates: seedUserRates,
  });
  for (const rt of rateTableSeeds) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(rateTables)
          .values({
            id: rt.id,
            organizationId: ORG_ID,
            workspaceId: toWs(rt.workspaceId),
            name: rt.name,
            currency: rt.currency,
            isDefault: true,
          })
          .onConflictDoNothing(),
    );
  }
  for (const re of rateEntrySeeds) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(rateEntries)
          .values({
            id: re.id,
            workspaceId: toWs(re.workspaceId),
            rateTableId: re.rateTableId,
            userId: re.userId,
            hourlyRate: cents(re.hourlyRate),
            effectiveFrom: re.effectiveFrom,
          })
          .onConflictDoNothing(),
    );
  }
  console.log(
    `  Rate tables: ${rateTableSeeds.length}, entries: ${rateEntrySeeds.length}`,
  );

  // 11. Invoices (must be inserted before time entries
  // that reference them)
  const dueDiligenceInvoiceId = invoiceSeedId(DUE_DILIGENCE_INVOICE_INDEX);
  const dueDiligenceEntries = buildDueDiligenceInvoiceEntries(
    dueDiligenceInvoiceId,
    seedUserIds,
    seedUserRates,
  );
  const invoiceSeeds = buildInvoices(sumTimeEntryAmounts(dueDiligenceEntries));
  for (const inv of invoiceSeeds) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(invoices)
          .values({
            id: inv.id,
            organizationId: ORG_ID,
            workspaceId: toWs(inv.workspaceId),
            invoiceNumber: inv.invoiceNumber,
            status: inv.status,
            invoiceDate: inv.invoiceDate,
            dueDate: inv.dueDate,
            currency: inv.currency,
            totalAmount: cents(inv.totalAmount),
          })
          .onConflictDoNothing(),
    );
  }
  console.log(`  Invoices: ${invoiceSeeds.length}`);

  // 12. Extended time entries (~500)
  const invoiceIds = invoiceSeeds
    .map((inv) => inv.id)
    .filter((id) => id !== dueDiligenceInvoiceId);
  const extTimeEntries = [
    ...buildExtendedTimeEntries(invoiceIds, seedUserIds, seedUserRates),
    ...dueDiligenceEntries,
  ];
  for (const te of extTimeEntries) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(timeEntries)
          .values({
            id: te.id,
            organizationId: ORG_ID,
            workspaceId: toWs(te.workspaceId),
            userId: te.userId,
            workItemId: te.matterId,
            dateWorked: te.dateWorked,
            timezoneId: "Europe/Prague",
            durationMinutes: te.durationMinutes,
            billedMinutes: te.billedMinutes,
            rateAtEntry: cents(te.rateAtEntry),
            currency: te.currency,
            narrative: te.narrative,
            billable: te.billable,
            status: te.status,
            taskCode: te.taskCode,
            activityCode: te.activityCode,
            invoiceId: te.invoiceId,
          })
          .onConflictDoNothing(),
    );
  }
  console.log(`  Time entries: ${extTimeEntries.length}`);

  // 13. Expenses (~50)
  const expenseSeeds = buildExpenses(seedUserIds);
  for (const exp of expenseSeeds) {
    await db.transaction(
      async (tx) =>
        await tx
          .insert(expenses)
          .values({
            id: exp.id,
            organizationId: ORG_ID,
            workspaceId: toWs(exp.workspaceId),
            userId: exp.userId,
            matterId: exp.matterId,
            dateIncurred: exp.dateIncurred,
            amount: cents(exp.amount),
            currency: exp.currency,
            category: exp.category,
            description: exp.description,
            billable: exp.billable,
            status: exp.status,
          })
          .onConflictDoNothing(),
    );
  }
  console.log(`  Expenses: ${expenseSeeds.length}`);

  // 13b. Issuing setup: a default seller profile, the firm's VAT rates and a
  // default invoice number series, so a new invoice prefills and issues.
  await withAggregateTransaction(db, async (tx) => {
    // These tables force row-level security, so the transaction takes the
    // application role and names its organization the way a request does.
    await tx.execute(
      sql`SELECT set_config('role', 'stella', true), set_config('app.organization_id', ${ORG_ID}, true)`,
    );
    // audit: skip - dev seed inserts fixture issuing settings.
    await tx
      .insert(sellerProfiles)
      .values({
        id: seedId<"sellerProfile">("seller-profile-default"),
        organizationId: ORG_ID,
        ...SEED_CONTENT.issuing.seller,
        vatPayer: true,
        defaultCurrency: SEED_CONTENT.currency,
        isDefault: true,
      })
      .onConflictDoNothing();
    // audit: skip - dev seed inserts fixture VAT rates.
    await tx
      .insert(vatRates)
      .values([
        {
          id: seedId<"vatRate">("vat-rate-standard"),
          organizationId: ORG_ID,
          code: "standard",
          ...SEED_CONTENT.issuing.vatRates.standard,
        },
        {
          id: seedId<"vatRate">("vat-rate-reduced"),
          organizationId: ORG_ID,
          code: "reduced",
          ...SEED_CONTENT.issuing.vatRates.reduced,
        },
      ])
      .onConflictDoNothing();
    // audit: skip - dev seed inserts a fixture number series.
    await tx
      .insert(numberSeries)
      .values({
        id: seedId<"numberSeries">("number-series-invoices"),
        organizationId: ORG_ID,
        documentType: "invoice",
        name: SEED_CONTENT.issuing.numberSeriesName,
        pattern: "{YYYY}-{SEQ}",
        padding: 4,
        isDefault: true,
      })
      .onConflictDoNothing();
  });
  console.log("  Issuing setup: seller profile, VAT rates, number series");

  // 14. Templates & clauses (knowledge base)
  await seedTemplates(ORG_ID, seedUserIds, SEED_CONTENT.templates);

  // 15. Playbooks (knowledge base) + the org document-type taxonomy the
  // type-scoped playbook references. ensureDefaultDocumentTypes is intentionally
  // non-overwriting, so reruns refresh the default-keyed rows in place to pick
  // up label changes: seeded playbooks reference these rows, so they cannot be
  // deleted and re-inserted. Custom, non-default document types are untouched.
  await db.transaction(
    async (tx) =>
      // audit: skip — dev seed refreshes the default taxonomy labels.
      await tx
        .insert(documentTypes)
        .values(
          DEFAULT_DOCUMENT_TYPES.map((documentType) => ({
            organizationId: ORG_ID,
            key: documentType.key,
            label: documentTypeLabel(documentType.key),
            sortOrder: documentType.sortOrder,
          })),
        )
        .onConflictDoUpdate({
          target: [documentTypes.organizationId, documentTypes.key],
          set: {
            label: sql`excluded.label`,
            sortOrder: sql`excluded.sort_order`,
          },
        }),
  );
  await seedPlaybooks(ORG_ID);

  // 16. Global case-law corpus for search and references. This pulls real prod
  // fixtures and is the most schema-coupled step; a local schema drift here
  // (e.g. a worktree whose migrations lag the shared dev DB) must not abort the
  // whole seed or dump a giant error toast — warn and continue. The corpus is
  // shared by every organization, so the per-locale marketing firms, seeded
  // after the English one (seed-marketing-locales.ts), only add their own
  // readers and fail loudly when the corpus is missing.
  let caseLawSeeded = SEED_LOCALE !== "en";
  try {
    if (SEED_LOCALE === "en") {
      await seedCaseLaw();
      caseLawSeeded = true;
    }
  } catch (error) {
    logErrorOutput({
      level: "warn",
      values: [
        "  Case-law seed skipped (non-fatal — likely local schema drift):",
        error,
      ],
    });
  }

  // The marketing seed needs the corpus rows; skip it when the corpus seed
  // was skipped, but keep its own failures fatal (the screenshots need them).
  if (caseLawSeeded) {
    await seedMarketingCaseLaw({
      db,
      locale: SEED_LOCALE,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
  }

  console.log("\nDone. Dev data seeded successfully.");
  return { organizationId: ORG_ID, userId: USER_ID, workspaceIds: allWsIds };
}

// Allow running as a CLI script
if (import.meta.main) {
  const explicitOrgId = process.env["STELLA_SEED_ORG_ID"];
  const explicitUserId = process.env["STELLA_SEED_USER_ID"];

  if (
    (explicitOrgId && !explicitUserId) ||
    (!explicitOrgId && explicitUserId)
  ) {
    console.error(
      "Set both STELLA_SEED_ORG_ID and STELLA_SEED_USER_ID, or neither.",
    );
    process.exit(1);
  }

  const resolveTarget = async () => {
    if (explicitOrgId && explicitUserId) {
      return {
        organizationId: explicitOrgId,
        userId: explicitUserId,
        label: "explicit env target",
      };
    }

    const { desc, gt, isNotNull } = await import("drizzle-orm");
    const {
      member: authMember,
      organization: authOrganization,
      session: authSession,
      user: authUser,
    } = await import("@/api/db/auth-schema");

    const activeSessions = await db.transaction(
      async (tx) =>
        await tx
          .select({
            userId: authSession.userId,
            organizationId: authSession.activeOrganizationId,
            userEmail: authUser.email,
            organizationName: authOrganization.name,
          })
          .from(authSession)
          .innerJoin(authUser, eq(authUser.id, authSession.userId))
          .innerJoin(
            authMember,
            and(
              eq(authMember.userId, authSession.userId),
              eq(authMember.organizationId, authSession.activeOrganizationId),
            ),
          )
          .innerJoin(
            authOrganization,
            eq(authOrganization.id, authSession.activeOrganizationId),
          )
          .where(
            and(
              isNotNull(authSession.activeOrganizationId),
              gt(authSession.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(authSession.updatedAt))
          .limit(1),
    );

    const activeSession = activeSessions.at(0);
    if (activeSession?.organizationId) {
      return {
        organizationId: activeSession.organizationId,
        userId: activeSession.userId,
        label: `${activeSession.userEmail} / ${activeSession.organizationName}`,
      };
    }

    const firstMember = await db.transaction(
      async (tx) =>
        await tx.query.member.findFirst({
          columns: { userId: true, organizationId: true },
          where: { role: "owner" },
          orderBy: { createdAt: "desc" },
        }),
    );
    if (!firstMember) {
      console.error("No users found. Sign in at least once before seeding.");
      process.exit(1);
    }
    return {
      organizationId: firstMember.organizationId,
      userId: firstMember.userId,
      label: "latest owner fallback",
    };
  };

  const target = await resolveTarget();
  if (
    !explicitOrgId &&
    !explicitUserId &&
    target.organizationId !== DEFAULT_ORG_ID
  ) {
    console.log(
      `Resolved seed target ${target.organizationId} for user ${target.userId} (${target.label}); restarting with org-scoped IDs`,
    );
    const child = Bun.spawn({
      cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
      env: {
        ...process.env,
        STELLA_SEED_ID_NAMESPACE: `org:${target.organizationId}`,
        STELLA_SEED_ORG_ID: target.organizationId,
        STELLA_SEED_USER_ID: target.userId,
      },
      stderr: "inherit",
      stdout: "inherit",
    });
    await child.exited;
    process.exit(childExitStatus(child));
  }

  console.log(
    `Seeding into org ${target.organizationId} for user ${target.userId} (${target.label})`,
  );

  seed(target.organizationId, target.userId)
    .then(async ({ organizationId, userId, workspaceIds }) => {
      if (process.argv.includes("--seed-recents")) {
        const seededFiles = await withAggregateTransaction(
          db,
          async (tx) =>
            await tx
              .select({
                entityId: entities.id,
                workspaceId: workspaces.id,
                workspaceName: workspaces.name,
                title: entities.name,
                fileFieldId: fields.id,
                filePropertyId: fields.propertyId,
                content: fields.content,
                openedAt: entities.createdAt,
              })
              .from(fields)
              .innerJoin(
                entityVersions,
                eq(fields.entityVersionId, entityVersions.id),
              )
              .innerJoin(
                entities,
                eq(entities.currentVersionId, entityVersions.id),
              )
              .innerJoin(workspaces, eq(entities.workspaceId, workspaces.id))
              .where(
                and(
                  eq(workspaces.organizationId, organizationId),
                  inArray(workspaces.id, workspaceIds),
                ),
              ),
        );
        writeSeedRecentFiles({
          path: `${import.meta.dir}/../../../.playwright/storage-state.json`,
          origin: new URL(env.FRONTEND_URL).origin,
          organizationId,
          userId,
          files: seededFiles.flatMap(({ content, openedAt, ...file }) =>
            content.type === "file"
              ? [
                  {
                    ...file,
                    mimeType: content.mimeType,
                    openedAt: openedAt.toISOString(),
                  },
                ]
              : [],
          ),
        });
      }
      process.exit(0);
    })
    .catch((error: unknown) => {
      printError("Seed failed:", error);
      process.exit(1);
    });
}
