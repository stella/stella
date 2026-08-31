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

import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  ExpenseCategory,
  InvoiceStatus,
  TimeEntryStatus,
  WorkspaceContactRole,
} from "@stll/api-contract";
import { deriveBlockId } from "@stll/folio-core/server";

import { rootDb } from "@/api/db/root";
import {
  billingCodes,
  chatMessages,
  chatThreads,
  contacts,
  documentTypes,
  entities,
  entityVersions,
  expenses,
  extractedContent,
  fields,
  invoices,
  justifications,
  organizationSettings,
  playbookDefinitions,
  properties,
  propertyDependencies,
  rateEntries,
  rateTables,
  timeEntries,
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
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DEFAULT_DOCUMENT_TYPES,
  ensureDefaultDocumentTypes,
} from "@/api/lib/document-types/defaults";
import {
  EML_MIME_TYPE,
  parseEmail,
  parsedEmailToText,
} from "@/api/lib/files/email-to-html";
import { cents } from "@/api/lib/money";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { buildDefaultViewRows } from "@/api/lib/views";
import type {
  PlaybookPositions,
  Position,
  PositionSeverity,
} from "@/api/lib/workflow/playbook-positions";

import { seedCaseLaw } from "./seed-case-law";
import { seedTemplates } from "./seed-templates";
import {
  ensureSeedColleaguesInOrganization,
  ensurePrimarySeedUserInOrganization,
  ensureTestUsers,
} from "./seed-test-user";
import {
  at,
  buildSeedUserIds,
  buildSeedUserRates,
  DEFAULT_SEED_COLLEAGUE_COUNT,
  DEFAULT_ORG_ID,
  DEFAULT_USER_ID,
  pickAuthor,
  seedId,
} from "./seed-utils";

// ─── Mock file generators ───────────────────────────────

const fileExtRe = /\.(?:pdf|docx|eml)$/u;

const PDF_MIME = "application/pdf" as const;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const HEAVY_MATTER_LABEL = "ws-heavy-virtualization";
const HEAVY_MATTER_FILE_COUNT = 1000;
const HEAVY_MATTER_FOLDER_COUNT = 25;
const EXPORT_TABLE_MATTER_LABEL = "ws-export-review";
const EXPORT_TABLE_FILE_COUNT = 72;
const EXPORT_TABLE_FOLDER_COUNT = 6;
// The akvizice matter is where the Czech (type-scoped) playbook runs; its
// "Document Type" classifier uses the org taxonomy labels so playbook gating
// can match the SPA document.
const AKVIZICE_MATTER_LABEL = "ws-akvizice-energo";
// English filename over a Czech-language body: the workspace stills film this
// file list, and the marketing cast files documents in English; the body stays
// Czech (like Due_Diligence_Report.pdf) so the Czech playbook demo keeps a
// Czech-law SPA to review.
const AKVIZICE_SPA_DOC_NAME = "Share_Acquisition_Agreement.pdf";
// The taxonomy key the Czech playbook is scoped to; its label classifies the
// akvizice SPA document so the gate matches. Derived from the single source of
// truth so the field value never drifts from the taxonomy.
const SPA_DOCUMENT_TYPE_KEY = "spa";
const spaDocumentType = DEFAULT_DOCUMENT_TYPES.find(
  (documentType) => documentType.key === SPA_DOCUMENT_TYPE_KEY,
);
if (!spaDocumentType) {
  panic(`Missing default document type: ${SPA_DOCUMENT_TYPE_KEY}`);
}
const SPA_DOCUMENT_TYPE_LABEL = spaDocumentType.label;

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

/**
 * Unicode → WinAnsiEncoding (CP1252) mapping for chars
 * outside ASCII. Helvetica supports these natively.
 *
 * Hex keys are the standard notation for Unicode code
 * points and CP1252 byte positions.
 */
const WIN_ANSI: Record<number, number> = {
  256: 0x00, // U+0100 fallback for unsupported chars
  // Latin Extended-A (Czech/Slovak/German)
  193: 0xc1, // Á
  225: 0xe1, // á
  196: 0xc4, // Ä
  228: 0xe4, // ä
  201: 0xc9, // É
  233: 0xe9, // é
  205: 0xcd, // Í
  237: 0xed, // í
  211: 0xd3, // Ó
  243: 0xf3, // ó
  212: 0xd4, // Ô
  244: 0xf4, // ô
  214: 0xd6, // Ö
  246: 0xf6, // ö
  218: 0xda, // Ú
  250: 0xfa, // ú
  220: 0xdc, // Ü
  252: 0xfc, // ü
  221: 0xdd, // Ý
  253: 0xfd, // ý
  223: 0xdf, // ß
  // Characters that need remapping to CP1252 positions
  268: 0x00, // Č → not in CP1252
  269: 0x00, // č
  270: 0x00, // Ď
  271: 0x00, // ď
  282: 0x00, // Ě
  283: 0x00, // ě
  313: 0x00, // Ĺ
  314: 0x00, // ĺ
  317: 0x00, // Ľ
  318: 0x00, // ľ
  327: 0x00, // Ň
  328: 0x00, // ň
  344: 0x00, // Ř
  345: 0x00, // ř
  352: 0x8a, // Š → CP1252 0x8A
  353: 0x9a, // š → CP1252 0x9A
  356: 0x00, // Ť
  357: 0x00, // ť
  366: 0x00, // Ů
  367: 0x00, // ů
  381: 0x8e, // Ž → CP1252 0x8E
  382: 0x9e, // ž → CP1252 0x9E
  340: 0x00, // Ŕ
  341: 0x00, // ŕ
};

// Fallback ASCII for chars not in WinAnsi
const FALLBACK: Record<string, string> = {
  Č: "C",
  č: "c",
  Ď: "D",
  ď: "d",
  Ě: "E",
  ě: "e",
  Ĺ: "L",
  ĺ: "l",
  Ľ: "L",
  ľ: "l",
  Ň: "N",
  ň: "n",
  Ř: "R",
  ř: "r",
  Ť: "T",
  ť: "t",
  Ů: "U",
  ů: "u",
  Ŕ: "R",
  ŕ: "r",
};

/** Encode a string for PDF text operators using
 *  WinAnsiEncoding. Non-encodable chars get an ASCII
 *  fallback. Returns an octal-escaped PDF string. */
const pdfEscape = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      // ASCII — escape PDF special chars
      if (ch === "\\") {
        out += "\\\\";
      } else if (ch === "(") {
        out += "\\(";
      } else if (ch === ")") {
        out += "\\)";
      } else {
        out += ch;
      }
    } else {
      const winAnsi = WIN_ANSI[cp];
      if (winAnsi !== undefined && winAnsi > 0) {
        // Encodable in WinAnsi — use octal escape
        out += `\\${winAnsi.toString(8).padStart(3, "0")}`;
      } else {
        // Not in WinAnsi — ASCII fallback
        out += FALLBACK[ch] ?? "?";
      }
    }
  }
  return out;
};

/**
 * Create a minimal but readable multi-page PDF.
 * Each page holds ~45 lines at 11pt with 14pt leading.
 */
export const createMockPdf = (title: string, bodyText?: string): Buffer => {
  const LINES_PER_PAGE = 45;
  const FONT_SIZE = 11;
  const LEADING = 14;
  const TITLE_SIZE = 16;
  const MARGIN_LEFT = 56;
  const TOP_Y = 740;

  // Split body text into lines, wrapping long lines at ~85 chars
  const rawLines = (bodyText ?? title).split("\n");
  const allLines: string[] = [];
  for (const raw of rawLines) {
    if (raw.length <= 85) {
      allLines.push(raw);
    } else {
      // Word-wrap
      const words = raw.split(" ");
      let line = "";
      for (const word of words) {
        if (line.length + word.length + 1 > 85) {
          allLines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) {
        allLines.push(line);
      }
    }
  }

  // Group into pages
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) {
    pages.push([title]);
  }

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
  ];

  // Build content streams for each page
  const pageObjIds: number[] = [];
  const contentObjStart = 4; // objects 4, 5, 6, ... are content streams
  const pageObjStart = contentObjStart + pages.length;

  for (const [p, lines] of pages.entries()) {
    let stream = "";

    // Title on first page
    if (p === 0) {
      stream +=
        `BT /F1 ${TITLE_SIZE} Tf ` +
        `${MARGIN_LEFT} ${TOP_Y} Td ` +
        `(${pdfEscape(title)}) Tj ` +
        `0 -${LEADING * 2} Td ` +
        `/F1 ${FONT_SIZE} Tf `;
    } else {
      stream += `BT /F1 ${FONT_SIZE} Tf ${MARGIN_LEFT} ${TOP_Y} Td `;
    }

    for (const [i, line] of lines.entries()) {
      if (i > 0 || p > 0) {
        stream += `0 -${LEADING} Td `;
      }
      stream += `(${pdfEscape(line)}) Tj `;
    }
    stream += "ET";

    const contentId = contentObjStart + p;
    objects.push(
      `${contentId} 0 obj\n<< /Length ${stream.length} >>\n` +
        `stream\n${stream}\nendstream\nendobj`,
    );

    const pageId = pageObjStart + p;
    pageObjIds.push(pageId);
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`,
    );
  }

  // Pages object (id 2)
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
  objects.splice(
    1,
    0,
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] ` +
      `/Count ${pages.length} >>\nendobj`,
  );

  // Font object (id 3)
  objects.splice(
    2,
    0,
    "3 0 obj\n<< /Type /Font /Subtype /Type1 " +
      "/BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj",
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }

  const xrefOffset = pdf.length;
  pdf += "xref\n";
  pdf += `0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += "trailer\n";
  pdf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += "startxref\n";
  pdf += `${xrefOffset}\n`;
  pdf += "%%EOF\n";

  return Buffer.from(pdf);
};

const xmlEscape = (s: string): string =>
  s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");

export const createMockDocx = async (
  title: string,
  bodyText?: string,
): Promise<Buffer> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );

  zip
    .folder("_rels")
    ?.file(
      ".rels",
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

  zip
    .folder("word")
    ?.file(
      "document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${paragraphs}</w:body>` +
        "</w:document>",
    );

  zip
    .folder("word")
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    );

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
// storyEditorDocument.
const SUPPLIER_AGREEMENT_DOC_NAME = "Supplier_Agreement.docx";

// Reviewer identity stamped on the tracked changes and margin comments;
// Clara Novak is a seeded colleague (clara@stella.dev).
const SUPPLIER_AGREEMENT_REVIEWER = {
  author: "Clara Novak",
  date: "2026-07-16T09:30:00Z",
  initials: "CN",
} as const;

type SupplierAgreementComment = {
  id: number;
  text: string;
};

const SUPPLIER_AGREEMENT_COMMENTS: SupplierAgreementComment[] = [
  {
    id: 1,
    text:
      "Above the approved liability cap: the Procurement Playbook allows at " +
      "most 100% of annual fees. Redlined to the playbook position; needs " +
      "Legal sign-off.",
  },
  {
    id: 2,
    text:
      "Playbook requires at least ninety (90) days' termination notice for " +
      "supply-critical agreements. Second deviation flagged for Legal " +
      "review.",
  },
];

type SupplierAgreementRun =
  | { kind: "deleted"; text: string }
  | { kind: "inserted"; text: string }
  | { kind: "text"; text: string };

type SupplierAgreementParagraph = {
  /** Margin comment (id in SUPPLIER_AGREEMENT_COMMENTS) anchored to the paragraph. */
  commentId?: number;
  runs: SupplierAgreementRun[];
  style: "body" | "heading" | "title";
};

const body = (text: string): SupplierAgreementParagraph => ({
  runs: [{ kind: "text", text }],
  style: "body",
});

const heading = (text: string): SupplierAgreementParagraph => ({
  runs: [{ kind: "text", text }],
  style: "heading",
});

const SUPPLIER_AGREEMENT_PARAGRAPHS: SupplierAgreementParagraph[] = [
  { runs: [{ kind: "text", text: "Supplier Agreement" }], style: "title" },
  body("NEGOTIATION DRAFT v4 — CONTAINS TRACKED CHANGES"),
  body(
    "This Supplier Agreement (the “Agreement”) is entered into as of 1 July " +
      "2026 (the “Effective Date”) by and between:",
  ),
  body(
    "(1) Northstar Robotics, Inc., a Delaware corporation with offices at " +
      "548 Market Street, San Francisco, California 94104, United States " +
      "(the “Customer”); and",
  ),
  body(
    "(2) Meridian Precision Components GmbH, a company organised under the " +
      "laws of Germany with registered offices at Werkstrasse 12, 80339 " +
      "Munich, Germany (the “Supplier”),",
  ),
  body("each a “Party” and together the “Parties”."),
  body(
    "WHEREAS the Customer designs and manufactures autonomous mobile robots " +
      "and requires a reliable supply of precision drive components; and " +
      "WHEREAS the Supplier manufactures harmonic drive gears, actuator " +
      "housings and related components meeting the Specifications; NOW, " +
      "THEREFORE, the Parties agree as follows.",
  ),
  heading("1. Definitions and interpretation"),
  body(
    "1.1 In this Agreement: “Affiliate” means any entity that directly or " +
      "indirectly controls, is controlled by, or is under common control " +
      "with a Party; “Annual Fees” means the aggregate fees paid or payable " +
      "by the Customer under this Agreement during the twelve (12) months " +
      "immediately preceding the event giving rise to the relevant claim; " +
      "“Business Day” means a day other than a Saturday, Sunday or public " +
      "holiday in San Francisco or Munich; “Order” means a purchase order " +
      "issued by the Customer under Clause 3; “Products” means the " +
      "components listed in Annex 1; and “Specifications” means the " +
      "technical specifications set out in Annex 1, as amended in " +
      "accordance with Clause 2.3.",
  ),
  body(
    "1.2 Headings are for convenience only and do not affect " +
      "interpretation. References to Clauses and Annexes are to the clauses " +
      "of, and annexes to, this Agreement.",
  ),
  heading("2. Supply of products"),
  body(
    "2.1 The Supplier shall manufacture and supply the Products in " +
      "accordance with the Specifications, the agreed quality standards and " +
      "the terms of this Agreement.",
  ),
  body(
    "2.2 The Supplier shall maintain sufficient production capacity to " +
      "satisfy the Customer's rolling forecast, up to one hundred and " +
      "twenty per cent (120%) of the most recent quarterly forecast volume.",
  ),
  body(
    "2.3 Neither Party may change the Specifications without the prior " +
      "written approval of the other Party. The Supplier shall give the " +
      "Customer at least twelve (12) months' written notice before " +
      "discontinuing any Product.",
  ),
  heading("3. Forecasts and orders"),
  body(
    "3.1 The Customer shall provide a rolling twelve (12) month forecast, " +
      "updated monthly. The first three (3) months of each forecast are " +
      "binding on the Customer.",
  ),
  body(
    "3.2 The Customer shall order Products by issuing an Order stating " +
      "quantities, delivery dates and delivery locations. The Supplier " +
      "shall accept or reject an Order within five (5) Business Days; an " +
      "Order not rejected within that period is deemed accepted.",
  ),
  body(
    "3.3 The Customer may cancel or reschedule an accepted Order more than " +
      "sixty (60) days before the scheduled delivery date at no charge.",
  ),
  heading("4. Delivery, title and risk"),
  body(
    "4.1 The Supplier shall deliver the Products DAP (Incoterms 2020) to " +
      "the Customer's facility identified in the Order. Delivery dates are " +
      "of the essence.",
  ),
  body(
    "4.2 If the Supplier fails to deliver by the confirmed delivery date, " +
      "the Customer is entitled to a delay credit of 0.5% of the Order " +
      "value per commenced week of delay, up to 5% of the Order value.",
  ),
  body(
    "4.3 Title to and risk in the Products pass to the Customer on " +
      "completed delivery under Clause 4.1.",
  ),
  heading("5. Prices and payment"),
  body(
    "5.1 Prices are set out in Annex 2 and are fixed until 31 December " +
      "2026. Price changes thereafter require ninety (90) days' written " +
      "notice and the Customer's written agreement.",
  ),
  body(
    "5.2 The Supplier shall invoice monthly in arrears. Undisputed invoices " +
      "are payable within forty-five (45) days of receipt of a correct " +
      "invoice.",
  ),
  body(
    "5.3 The Parties shall review prices annually in good faith, targeting " +
      "a productivity improvement of two per cent (2%) per year.",
  ),
  heading("6. Quality, inspection and non-conforming products"),
  body(
    "6.1 The Supplier shall maintain a quality management system certified " +
      "to ISO 9001 (or equivalent) and shall retain quality records for " +
      "each Product lot for at least ten (10) years.",
  ),
  body(
    "6.2 The Customer may perform incoming inspection within ten (10) " +
      "Business Days of delivery. Rejection of non-conforming Products " +
      "within that period does not limit the Customer's warranty rights.",
  ),
  body(
    "6.3 For non-conforming Products the Supplier shall, at the Customer's " +
      "election, replace the Products or refund the price, in each case " +
      "within ten (10) Business Days of notice.",
  ),
  heading("7. Warranties"),
  body(
    "7.1 The Supplier warrants that for twenty-four (24) months from " +
      "delivery each Product conforms to the Specifications, is free from " +
      "defects in materials and workmanship, and complies with applicable " +
      "law.",
  ),
  body(
    "7.2 The remedies in Clause 6.3 apply to any breach of the warranty in " +
      "Clause 7.1, without prejudice to the Customer's other rights under " +
      "this Agreement.",
  ),
  heading("8. Intellectual property"),
  body(
    "8.1 Each Party retains all rights in its background intellectual " +
      "property. Tooling, designs and Specifications provided by the " +
      "Customer remain the Customer's property and may be used by the " +
      "Supplier solely to perform this Agreement.",
  ),
  heading("9. Confidentiality"),
  body(
    "9.1 Each Party shall keep the other Party's confidential information " +
      "secret, use it solely to perform this Agreement, and disclose it " +
      "only to personnel and advisers who need it and are bound by " +
      "equivalent obligations. This Clause survives for five (5) years " +
      "after termination.",
  ),
  heading("10. Data protection and security"),
  body(
    "10.1 Each Party shall comply with applicable data protection law in " +
      "connection with this Agreement and shall implement appropriate " +
      "technical and organisational measures to protect personal data it " +
      "processes for the other Party.",
  ),
  heading("11. Insurance"),
  body(
    "11.1 The Supplier shall maintain product liability insurance of at " +
      "least EUR 5,000,000 per occurrence with a reputable insurer and " +
      "shall provide certificates of insurance on request.",
  ),
  heading("12. Limitation of liability"),
  body(
    "12.1 Nothing in this Agreement excludes or limits either Party's " +
      "liability for death or personal injury caused by negligence, for " +
      "fraud or fraudulent misrepresentation, or for any other liability " +
      "that may not be excluded or limited as a matter of law. Each party " +
      "remains responsible for its obligations under this Agreement.",
  ),
  {
    commentId: 1,
    runs: [
      {
        kind: "text",
        text: "12.2 The Supplier’s aggregate liability shall not exceed ",
      },
      { kind: "deleted", text: "300% of the fees" },
      { kind: "inserted", text: "100% of the annual fees" },
      { kind: "text", text: " paid under this Agreement." },
    ],
    style: "body",
  },
  body(
    "12.3 Neither Party is liable for loss of profits, loss of revenue, " +
      "loss of data, or any indirect or consequential loss, however " +
      "arising.",
  ),
  body(
    "12.4 The exclusions in this section survive termination of the Agreement.",
  ),
  heading("13. Indemnities"),
  body(
    "13.1 The Supplier shall indemnify the Customer against third-party " +
      "claims that a Product as delivered infringes intellectual property " +
      "rights, provided the Customer notifies the Supplier promptly and " +
      "gives the Supplier control of the defence.",
  ),
  heading("14. Term and termination"),
  {
    commentId: 2,
    runs: [
      {
        kind: "text",
        text:
          "14.1 This Agreement starts on the Effective Date and continues " +
          "for an initial term of three (3) years, renewing automatically " +
          "for successive one (1) year periods. Either Party may terminate " +
          "this Agreement for convenience by giving the other Party thirty " +
          "(30) days' prior written notice.",
      },
    ],
    style: "body",
  },
  body(
    "14.2 Either Party may terminate this Agreement with immediate effect " +
      "by written notice if the other Party undergoes a change of control " +
      "without the terminating Party's prior written approval, becomes " +
      "insolvent, or commits a material breach that remains uncured thirty " +
      "(30) days after written notice of the breach.",
  ),
  body(
    "14.3 Termination does not affect accrued rights. On termination the " +
      "Supplier shall return the Customer's tooling, designs and " +
      "confidential information, and shall support an orderly transition " +
      "of supply for up to six (6) months.",
  ),
  heading("15. Force majeure"),
  body(
    "15.1 Neither Party is liable for delay or failure to perform caused " +
      "by events beyond its reasonable control, provided it notifies the " +
      "other Party without undue delay and uses reasonable efforts to " +
      "mitigate. If a force majeure event continues for more than sixty " +
      "(60) days, either Party may terminate affected Orders.",
  ),
  heading("16. General"),
  body(
    "16.1 This Agreement is governed by the laws of England and Wales, and " +
      "the courts of London have exclusive jurisdiction.",
  ),
  body(
    "16.2 This Agreement, including its Annexes, is the entire agreement " +
      "between the Parties regarding its subject matter. Amendments must " +
      "be in writing and signed by both Parties. Notices must be in " +
      "writing to the addresses above.",
  ),
  body("SIGNED for and on behalf of NORTHSTAR ROBOTICS, INC."),
  body("Elena Park, Chief Executive Officer"),
  body("SIGNED for and on behalf of MERIDIAN PRECISION COMPONENTS GMBH"),
  body("Katrin Vogel, Managing Director"),
];

/**
 * Plain-text rendition of the Supplier Agreement with the tracked changes
 * applied (insertions kept, deletions dropped): the single source for
 * extracted content and the search index, same as `documentTexts` entries.
 */
const buildSupplierAgreementText = (): string =>
  SUPPLIER_AGREEMENT_PARAGRAPHS.filter(
    (paragraph) => paragraph.style !== "title",
  )
    .map((paragraph) =>
      paragraph.runs
        .filter((run) => run.kind !== "deleted")
        .map((run) => run.text)
        .join(""),
    )
    .join("\n\n");

/**
 * Build the Supplier Agreement DOCX with real tracked changes and margin
 * comments. Mirrors `createMockDocx`'s minimal OOXML package, plus a
 * `word/comments.xml` part (folio reads it by path) and its content-type
 * override and relationship for Word compatibility.
 */
const createSupplierAgreementDocx = async (): Promise<Buffer> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const { author, date } = SUPPLIER_AGREEMENT_REVIEWER;

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' +
      "</Types>",
  );

  zip
    .folder("_rels")
    ?.file(
      ".rels",
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
    const escaped = xmlEscape(run.text);
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

  const paragraphs = SUPPLIER_AGREEMENT_PARAGRAPHS.map(paragraphXml).join("");

  zip
    .folder("word")
    ?.file(
      "document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${paragraphs}</w:body>` +
        "</w:document>",
    );

  const commentsXml = SUPPLIER_AGREEMENT_COMMENTS.map(
    (comment) =>
      `<w:comment w:id="${comment.id}" w:author="${xmlEscape(author)}" ` +
      `w:initials="${SUPPLIER_AGREEMENT_REVIEWER.initials}" w:date="${date}">` +
      `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(comment.text)}</w:t></w:r></w:p>` +
      "</w:comment>",
  ).join("");
  zip
    .folder("word")
    ?.file(
      "comments.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `${commentsXml}</w:comments>`,
    );

  zip
    .folder("word")
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' +
        "</Relationships>",
    );

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

const EXPORT_REVIEW_FOLDERS = [
  "Corporate",
  "Commercial",
  "Employment",
  "Regulatory",
  "Finance",
  "Real Estate",
] as const;

const EXPORT_REVIEW_DOCUMENT_TYPES = [
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

const EXPORT_REVIEW_JURISDICTIONS = [
  "Czech Republic",
  "Germany",
  "Netherlands",
  "Hungary",
  "United Kingdom",
] as const;

const EXPORT_REVIEW_RISK_LEVELS = [
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
// (apps/web/e2e/marketing/record-product-story.ts).
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

const EXPORT_REVIEW_DOC_NAMES = buildExportReviewDocNames();

type ExportReviewMetadata = {
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

export const SEED_EMAIL_FILE_NAMES = [
  "Closing_tomorrow_final_checklist.eml",
  "Fwd_ERU_clearance_condition_7.eml",
  "Client_update_Praha.eml",
] as const;

type SeedEmailFileName = (typeof SEED_EMAIL_FILE_NAMES)[number];

type SeedEmailAttachment =
  | {
      type: "pdf";
      fileName: string;
      title: string;
      bodyText: string;
    }
  | {
      type: "text";
      fileName: string;
      bodyText: string;
    };

type SeedEmail = {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  date: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: readonly SeedEmailAttachment[];
};

const SEED_EMAILS = {
  "Closing_tomorrow_final_checklist.eml": {
    from: "Elena Park <elena.park@northstar.example>",
    to: [
      "Marcus Chen <marcus.chen@northstarseed.example>",
      "Katrin Vogel <katrin.vogel@meridian.example>",
    ],
    cc: [
      "Clara Novak <clara.novak@counsel.example>",
      "Closing Team <closing@northstar.example>",
    ],
    date: "Thu, 16 Jul 2026 17:42:00 +0200",
    subject: "Closing tomorrow: final checklist and funds flow",
    textBody: `Hi all,

We are ready to sign tomorrow at 09:00 CET. Please treat the attached funds flow as final unless Clara circulates a replacement before 08:30.

The EUR 2,500,000 escrow amount must not be released until both signature pages and the condition 7 waiver are confirmed in writing.

Final actions:
1. Katrin: return the signed supplier consent by 08:15.
2. Marcus: confirm the originating account ending 2048.
3. Clara: release the completion email after checking all signatures.

If anything changes overnight, reply to this thread rather than starting a new one.

Elena`,
    htmlBody: `<p>Hi all,</p>
<p>We are ready to sign tomorrow at <strong>09:00 CET</strong>. Please treat the attached funds flow as final unless Clara circulates a replacement before 08:30.</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Signing</strong></td><td style="border:1px solid #d1d5db;padding:8px">17 July 2026, 09:00 CET</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Escrow</strong></td><td style="border:1px solid #d1d5db;padding:8px">EUR 2,500,000</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Release gate</strong></td><td style="border:1px solid #d1d5db;padding:8px">Signatures + condition 7 waiver</td></tr>
</table>
<p><strong>The EUR 2,500,000 escrow amount must not be released until both signature pages and the condition 7 waiver are confirmed in writing.</strong></p>
<p>Final actions:</p>
<ol>
  <li>Katrin: return the signed supplier consent by 08:15.</li>
  <li>Marcus: confirm the originating account ending 2048.</li>
  <li>Clara: release the completion email after checking all signatures.</li>
</ol>
<p>If anything changes overnight, reply to this thread rather than starting a new one.</p>
<p>Elena</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Final_Funds_Flow.pdf",
        title: "Final Funds Flow",
        bodyText:
          "Northstar closing funds flow. Escrow: EUR 2,500,000. Release only after signed pages and the condition 7 waiver are confirmed by closing counsel.",
      },
      {
        type: "text",
        fileName: "Closing_contacts.txt",
        bodyText:
          "Closing counsel: Clara Novak\nEscrow desk: +420 555 010 204\nCompletion bridge: 08:45 CET",
      },
    ],
  },
  "Fwd_ERU_clearance_condition_7.eml": {
    from: "Clara Novak <clara.novak@counsel.example>",
    to: ["Elena Park <elena.park@northstar.example>"],
    cc: ["Deal Team <deal-team@northstar.example>"],
    date: "Wed, 15 Jul 2026 14:18:00 +0200",
    subject: "Fwd: ERÚ clearance received — condition 7 remains open",
    textBody: `Elena,

The regulator has issued the clearance. Condition 7 is still open because the filing requires an updated grid-connection schedule by 20 July 2026.

My recommendation: closing may proceed only if the seller gives the attached undertaking and EUR 2,500,000 remains in escrow.

---------- Forwarded message ---------
From: Regulatory Filings <filings@eru.example>
Date: Wed, 15 Jul 2026 at 13:52
Subject: Decision ERU-2026-184
To: Clara Novak <clara.novak@counsel.example>

The Energy Regulatory Office grants clearance subject to condition 7. The applicant must provide the updated grid-connection schedule no later than 20 July 2026.

Clara`,
    htmlBody: `<p>Elena,</p>
<p>The regulator has issued the clearance. <strong>Condition 7 is still open</strong> because the filing requires an updated grid-connection schedule by 20 July 2026.</p>
<p>My recommendation: closing may proceed only if the seller gives the attached undertaking and EUR 2,500,000 remains in escrow.</p>
<div class="gmail_quote" style="border-left:3px solid #d1d5db;margin:20px 0;padding-left:16px;color:#4b5563">
  <div>---------- Forwarded message ---------</div>
  <div><strong>From:</strong> Regulatory Filings &lt;filings@eru.example&gt;</div>
  <div><strong>Date:</strong> Wed, 15 Jul 2026 at 13:52</div>
  <div><strong>Subject:</strong> Decision ERU-2026-184</div>
  <div><strong>To:</strong> Clara Novak &lt;clara.novak@counsel.example&gt;</div>
  <p>The Energy Regulatory Office grants clearance subject to condition 7. The applicant must provide the updated grid-connection schedule no later than 20 July 2026.</p>
</div>
<p>Clara</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Seller_Undertaking_Condition_7.pdf",
        title: "Seller Undertaking — Condition 7",
        bodyText:
          "The seller undertakes to provide the updated grid-connection schedule by 20 July 2026 and accepts that EUR 2,500,000 remains in escrow until written confirmation.",
      },
    ],
  },
  "Client_update_Praha.eml": {
    from: "Karim Haddad <karim.haddad@counsel.example>",
    to: [
      "Petra Malá <petra.mala@energo.example>",
      "ليلى منصور <layla.mansour@northstar.example>",
    ],
    cc: [],
    date: "Tue, 14 Jul 2026 11:06:00 +0200",
    subject: "Client update: Praha / تحديث العميل",
    textBody: `Hello Petra and Layla,

The Prague signing remains scheduled for 17 July 2026. No new corporate approvals are required.

Česky: Prodávající musí dodat aktualizovaný harmonogram připojení nejpozději 20. července 2026. Částka 2 500 000 EUR zůstane v úschově do písemného potvrzení.

العربية: سيبقى مبلغ 2,500,000 يورو في حساب الضمان حتى استلام التأكيد الكتابي. لا يجوز الإفراج عن المبلغ قبل ذلك.

Regards,
Karim`,
    htmlBody: `<p>Hello Petra and Layla,</p>
<p>The Prague signing remains scheduled for <strong>17 July 2026</strong>. No new corporate approvals are required.</p>
<p lang="cs"><strong>Česky:</strong> Prodávající musí dodat aktualizovaný harmonogram připojení nejpozději 20. července 2026. Částka 2 500 000 EUR zůstane v úschově do písemného potvrzení.</p>
<p lang="ar" dir="rtl"><strong>العربية:</strong> سيبقى مبلغ 2,500,000 يورو في حساب الضمان حتى استلام التأكيد الكتابي. لا يجوز الإفراج عن المبلغ قبل ذلك.</p>
<p>Regards,<br>Karim</p>`,
    attachments: [],
  },
} as const satisfies Record<SeedEmailFileName, SeedEmail>;

const seedEmailFileNames = new Set<string>(SEED_EMAIL_FILE_NAMES);

const isSeedEmailFileName = (fileName: string): fileName is SeedEmailFileName =>
  seedEmailFileNames.has(fileName);

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
      bytes: createMockPdf(attachment.title, attachment.bodyText),
    };
  }

  return {
    mimeType: "text/plain; charset=utf-8",
    bytes: Buffer.from(attachment.bodyText, "utf-8"),
  };
};

export const createSeedEmail = (fileName: SeedEmailFileName): Buffer => {
  const email = SEED_EMAILS[fileName];
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
      fileName: SeedEmailFileName;
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
  if (isSeedEmailFileName(fileName)) {
    return {
      type: "email",
      extension: "eml",
      mimeType: EML_MIME_TYPE,
      fileName,
    };
  }
  return { type: "pdf", extension: "pdf", mimeType: PDF_MIME };
};

const workspaceDocNames: Record<string, string[]> = {
  "ws-akvizice-energo": [
    AKVIZICE_SPA_DOC_NAME,
    "Due_Diligence_Report.pdf",
    "Board_Consent_Northstar.docx",
    "Expert_Valuation_Report.pdf",
    "Internal_SAFE_Agreement.docx",
    "Redacted_Due_Diligence_Extract.docx",
    SUPPLIER_AGREEMENT_DOC_NAME,
    ...SEED_EMAIL_FILE_NAMES,
  ],
  "ws-stavebni-spor": [
    "Zaloba_o_nahradu_skody.pdf",
    "Znalecky_posudek_stavba.pdf",
    "Protokol_o_mistnim_setreni.docx",
    "Doplneni_dukazu.pdf",
  ],
  "ws-due-diligence": [
    "DD_Checklist_Legal.pdf",
    "Corporate_Structure_Chart.pdf",
    "Share_Purchase_Agreement_Draft.docx",
    "Regulatory_Compliance_Report.pdf",
  ],
  "ws-pracovni-spory": [
    "Vypoved_z_pracovniho_pomeru.pdf",
    "Odvolani_proti_rozhodnuti.pdf",
    "Pracovni_smlouva.docx",
    "Svedecka_vypoved.pdf",
  ],
  "ws-compliance-ceska-energie": [
    "Compliance_Manual_2024.pdf",
    "AML_Risk_Assessment.pdf",
    "Internal_Audit_Report.docx",
    "Compliance_Training_Materials.pdf",
  ],
  "ws-reorganizace": [
    "Reorganizacni_plan.pdf",
    "Projekt_rozdeleni.pdf",
    "Zapis_z_valneho_shromazdeni.docx",
    "Schemata_holdingove_struktury.pdf",
  ],
  "ws-cross-border": [
    "Term_Sheet_Cross_Border.pdf",
    "Regulatory_Filing_EU.pdf",
    "Merger_Agreement_Draft.docx",
    "Competition_Law_Analysis.pdf",
  ],
  "ws-gdpr-audit": [
    "GDPR_Gap_Analysis.pdf",
    "Data_Processing_Agreement.pdf",
    "Privacy_Impact_Assessment.docx",
    "Cookie_Policy_Draft.pdf",
  ],
  [HEAVY_MATTER_LABEL]: buildHeavyMatterDocNames(),
  [EXPORT_TABLE_MATTER_LABEL]: EXPORT_REVIEW_DOC_NAMES,
};

/**
 * Realistic extracted text for each document. Keyed by
 * filename so the same text is reused when doc names cycle
 * across extra workspaces.
 */
const documentTexts: Record<string, string> = {
  // ws-akvizice-energo
  [AKVIZICE_SPA_DOC_NAME]: `SMLOUVA O AKVIZICI AKCIÍ

Smluvní strany:
1. Kupující: InvestCo Capital, a.s., IČO: 28456789, se sídlem Praha 1, Národní 15
2. Prodávající: EnerGo Holding, s.r.o., IČO: 25678901, se sídlem Brno, Veveří 42

Článek I – Předmět smlouvy
1.1 Prodávající převádí na Kupujícího 100 % akcií společnosti EnerGo Distribuce, a.s. (dále jen „Cílová společnost"), IČO: 27890123, zapsané v obchodním rejstříku u Krajského soudu v Brně, oddíl B, vložka 5678.
1.2 Akcie jsou kmenové, na jméno, v zaknihované podobě, o jmenovité hodnotě 1 000 Kč každá, celkový počet 50 000 ks.

Článek II – Kupní cena
2.1 Kupní cena činí 125 000 000 Kč (slovy: sto dvacet pět milionů korun českých).
2.2 Kupní cena bude uhrazena ve třech splátkách:
  a) 50 000 000 Kč do 10 pracovních dnů od podpisu této smlouvy;
  b) 50 000 000 Kč do 30 dnů po splnění odkládacích podmínek dle článku IV;
  c) 25 000 000 Kč do 90 dnů po dokončení transakce (holdback).

Článek III – Prohlášení a záruky
3.1 Prodávající prohlašuje a zaručuje, že:
  a) je výlučným vlastníkem převáděných akcií, bez jakýchkoli zástavních práv;
  b) Cílová společnost nemá žádné nesplacené závazky přesahující 5 000 000 Kč;
  c) vedené soudní spory nepřesahují částku 2 000 000 Kč.

Článek IV – Odkládací podmínky
4.1 Dokončení transakce je podmíněno:
  a) schválením Úřadem pro ochranu hospodářské soutěže;
  b) souhlasem Energetického regulačního úřadu;
  c) absencí podstatné nepříznivé změny (Material Adverse Change).

V Praze dne 15. března 2025`,

  "Due_Diligence_Report.pdf": `ZPRÁVA O PRÁVNÍ PROVĚRCE (DUE DILIGENCE)
Cílová společnost: EnerGo Distribuce, a.s.

1. SHRNUTÍ
Právní prověrka byla provedena v období 1.–28. února 2025. Celkem bylo přezkoumáno 347 dokumentů. Celkové riziko hodnotíme jako STŘEDNÍ.

2. KORPORÁTNÍ STRUKTURA
- Základní kapitál: 50 000 000 Kč, plně splacen
- Jediný akcionář: EnerGo Holding, s.r.o.
- Představenstvo: Ing. Jan Procházka (předseda), Mgr. Petra Malá
- Dozorčí rada: 3 členové, funkční období do 12/2026

3. IDENTIFIKOVANÁ RIZIKA
3.1 Vysoká rizika:
  - Licence na distribuci elektřiny vyprší 31. 12. 2025 (nutno prodloužit)
  - Probíhající řízení s ERÚ o pokutě 3 200 000 Kč za porušení podmínek licence

3.2 Střední rizika:
  - 2 pracovněprávní spory (celková expozice cca 800 000 Kč)
  - Nájemní smlouva na hlavní sídlo končí 06/2026, bez opce na prodloužení
  - Zástavní právo na transformační stanici Brno-jih (zajištění úvěru)

3.3 Nízká rizika:
  - Drobné nesrovnalosti v zápisu do katastru nemovitostí
  - Chybějící GDPR záznamy o zpracování pro 2 subdodavatele

4. DOPORUČENÍ
  a) Zajistit prodloužení licence ERÚ PŘED dokončením akvizice
  b) Vyžádat si od prodávajícího specifickou odškodňovací klauzuli na řízení ERÚ
  c) Zařadit nájemní smlouvu do seznamu smluv ke změně (change of control)

Zpracoval: Advokátní kancelář Novák & Partners
Datum: 28. února 2025`,

  "Board_Consent_Northstar.docx": `NORTHSTAR ROBOTICS, INC.

UNANIMOUS WRITTEN CONSENT OF THE BOARD OF DIRECTORS

The undersigned, constituting all members of the Board of Directors, approve the issuance of a Simple Agreement for Future Equity to Northstar Seed Fund I, L.P. for a purchase amount of EUR 500,000, subject to a post-money valuation cap of EUR 8,000,000.

The officers of the Company are authorized to execute the agreement and take any action reasonably necessary to complete the financing.

Approved on 15 July 2026.

Elena Park, Director
Daniel Ortiz, Director`,

  "Internal_SAFE_Agreement.docx": `INTERNAL DRAFT — FOR REVIEW ONLY

SAFE
(Simple Agreement for Future Equity)

THIS CERTIFIES THAT in exchange for the payment by Northstar Seed Fund I, L.P. (the “Investor”) of EUR 500,000 on or about 15 July 2026, Northstar Robotics, Inc., a Delaware corporation (the “Company”), issues to the Investor the right to certain shares of the Company’s capital stock, subject to the terms below.

1. EVENTS

Equity Financing. If there is an Equity Financing before this instrument terminates, the Company will automatically issue to the Investor the number of shares of Safe Preferred Stock equal to the Purchase Amount divided by the Conversion Price.

Liquidity Event. If there is a Liquidity Event before this instrument terminates, the Investor will be entitled to receive, immediately before or concurrently with the closing, the greater of the Purchase Amount or the amount payable on the number of shares of Common Stock equal to the Purchase Amount divided by the Liquidity Price.

Dissolution Event. If there is a Dissolution Event before this instrument terminates, the Investor will be entitled to receive the Purchase Amount immediately before the consummation of the Dissolution Event.

2. DEFINITIONS

“Company Capitalization” means the total number of issued and outstanding shares of capital stock of the Company, calculated on a fully diluted basis immediately before the Equity Financing.

“Post-Money Valuation Cap” means EUR 8,000,000.

“Discount Rate” means 80%.

3. COMPANY REPRESENTATIONS

The Company is duly incorporated, validly existing, and in good standing under the laws of Delaware. The execution and performance of this instrument have been duly authorized by the Company’s board of directors.

4. INVESTOR REPRESENTATIONS

The Investor has full legal capacity and authority to execute this instrument and is acquiring it for investment purposes, not with a view to distribution.

5. MISCELLANEOUS

This instrument is governed by the laws of the State of Delaware. Any amendment or waiver must be in writing and signed by the Company and either the Investor or holders of a majority of the aggregate purchase amounts of outstanding instruments with the same Post-Money Valuation Cap and Discount Rate.

NORTHSTAR ROBOTICS, INC.

By: Elena Park, Chief Executive Officer

NORTHSTAR SEED FUND I, L.P.

By: Marcus Chen, General Partner`,

  [SUPPLIER_AGREEMENT_DOC_NAME]: buildSupplierAgreementText(),

  "Redacted_Due_Diligence_Extract.docx": `CONFIDENTIAL — REDACTED REVIEW COPY

PROJECT NORTHSTAR
LEGAL DUE DILIGENCE EXTRACT

1. PARTIES

Target company: ████████████████████████
Seller: ████████████████████████████████
Buyer: Northstar Robotics, Inc.

2. TRANSACTION VALUE

The proposed purchase price is EUR ███████████, subject to the working-capital adjustment described in Schedule 4.

3. KEY FINDINGS

The target is party to a material supply agreement with ███████████████. The agreement contains a change-of-control clause requiring written consent before completion.

An employment dispute involving █████████████ remains pending. External counsel estimates the maximum exposure at EUR ████████.

4. RECOMMENDATION

Obtain change-of-control consent, require a specific indemnity for the pending dispute, and retain EUR █████████ from the purchase price until the claim is resolved.

Prepared for internal review. Personal names, counterparties, account numbers, and commercially sensitive amounts have been redacted.`,

  "Expert_Valuation_Report.pdf": `ZNALECKÝ POSUDEK č. 127-15/2025
O stanovení hodnoty 100 % akcií společnosti EnerGo Distribuce, a.s.

Znalec: doc. Ing. Karel Fiala, Ph.D., znalec v oboru ekonomika
Jmenován: Krajský soud v Praze, č.j. Spr 765/2019

ZÁVĚR:
Tržní hodnota 100 % akcií společnosti EnerGo Distribuce, a.s. k datu ocenění 31. 1. 2025 činí:

  118 500 000 Kč až 132 000 000 Kč

Střední hodnota: 125 250 000 Kč

Metoda ocenění: kombinace výnosové metody DCF entity (váha 60 %) a metody tržního porovnání (váha 40 %).

Klíčové předpoklady:
- WACC: 8,7 %
- Terminální růst: 2,0 %
- Plánované EBITDA 2025: 28 500 000 Kč
- Plánované EBITDA 2026: 31 200 000 Kč
- Multiplikátor EV/EBITDA srovnatelných společností: 4,2x–4,8x

V Praze dne 5. února 2025`,

  // ws-stavebni-spor
  "Zaloba_o_nahradu_skody.pdf": `ŽALOBA O NÁHRADU ŠKODY

Krajský soud v Ostravě
Havlíčkovo nábřeží 34
728 81 Ostrava

Žalobce: Městská správa silnic Ostrava, příspěvková organizace, IČO: 70890692
Právní zástupce: JUDr. Tomáš Novák, advokát, ev. č. ČAK 12456

Žalovaný: StavProjekt, s.r.o., IČO: 26845123, se sídlem Ostrava, Porubská 15

Žalovaná částka: 8 750 000 Kč s příslušenstvím

I. Skutkový stav
Žalovaný provedl na základě smlouvy o dílo č. 2022/0456 ze dne 15. 3. 2022 rekonstrukci mostu ev. č. 4773-1 přes řeku Odru. Dílo bylo předáno 30. 11. 2022. V dubnu 2024 byla při pravidelné prohlídce zjištěna závažná statická porucha nosné konstrukce.

II. Znalecký posudek
Dle znaleckého posudku Ing. Pavla Krejčího (č. 89-7/2024) je příčinou poruchy použití betonu nižší pevnostní třídy (C25/30 místo projektovaného C35/45) a nedostatečné krytí výztuže (18 mm místo min. 35 mm).

III. Návrh
Žalobce navrhuje, aby soud uložil žalovanému povinnost zaplatit žalobci částku 8 750 000 Kč, sestávající z:
  a) 6 500 000 Kč – náklady na sanaci;
  b) 1 250 000 Kč – náklady na provizorní omezení provozu;
  c) 1 000 000 Kč – znalecké a projektové náklady.

V Ostravě dne 20. ledna 2025`,

  "Znalecky_posudek_stavba.pdf": `ZNALECKÝ POSUDEK č. 89-7/2024
Předmět: Posouzení příčin statické poruchy mostu ev. č. 4773-1

Znalec: Ing. Pavel Krejčí, CSc., soudní znalec v oboru stavebnictví

NÁLEZ:
1. Na nosné konstrukci mostu byly identifikovány trhliny šířky 0,8–2,3 mm v oblastech maximálních ohybových momentů.
2. Jádrové vývrty prokázaly pevnost betonu v tlaku 27,3 MPa (odpovídá třídě C25/30), zatímco projekt předepisuje C35/45 (min. 45 MPa).
3. Krycí vrstva výztuže činí průměrně 18 mm, minimum dle ČSN EN 1992-1-1 pro třídu prostředí XD1 je 35 mm.

ZÁVĚR:
Příčinou zjištěných poruch je jednoznačně:
  a) použití betonu nižší pevnostní třídy;
  b) nedodržení minimálního krytí výztuže.
Obě vady jsou důsledkem nedostatečné kontroly kvality při provádění.

Odhadované náklady na sanaci: 6 200 000–6 800 000 Kč.

V Ostravě dne 15. listopadu 2024`,

  "Protokol_o_mistnim_setreni.docx": `PROTOKOL O MÍSTNÍM ŠETŘENÍ

Věc: Statická porucha mostu ev. č. 4773-1
Místo: Ostrava – Svinov, most přes Odru na silnici II/479
Datum: 8. dubna 2024, 9:00–14:30

Přítomni:
- Ing. Pavel Krejčí, CSc. – soudní znalec
- Mgr. Jan Dvořák – zástupce žalobce
- Ing. Roman Čížek – zástupce žalovaného (StavProjekt, s.r.o.)
- Bc. Marie Pokorná – stavební dozor města

Průběh šetření:
1. Vizuální prohlídka spodní stavby – zjištěny trhliny na 3 z 5 příčníků.
2. Odběr 6 jádrových vývrtů z nosné desky (vzorky V1–V6).
3. Měření tloušťky krycí vrstvy výztuže profometrem – 12 měřicích bodů.
4. Fotodokumentace – celkem 87 snímků (příloha č. 1).

Vyjádření žalovaného:
Ing. Čížek namítl, že trhliny mohly vzniknout v důsledku zvýšeného zatížení nadměrnými vozidly. Toto tvrzení bude posouzeno ve znaleckém posudku.

Protokol sepsán v Ostravě dne 8. dubna 2024.`,

  "Doplneni_dukazu.pdf": `DOPLNĚNÍ DŮKAZNÍCH NÁVRHŮ

Krajský soud v Ostravě
sp. zn. 15 C 234/2024

Žalobce tímto navrhuje provést následující důkazy:
1. Stavební deník č. 2022/0456 vedený žalovaným (k prokázání odchylek od projektu).
2. Dodací listy betonárny Cemex Ostrava za období 3–11/2022.
3. Výslech svědka Ing. Milana Březiny, stavbyvedoucího (k okolnostem změny receptury betonu).
4. Revizní zpráva TÜV SÜD Czech ze dne 22. 5. 2024.

V Ostravě dne 5. února 2025`,

  // ws-due-diligence
  "DD_Checklist_Legal.pdf": `LEGAL DUE DILIGENCE CHECKLIST

Target: TechFlow Solutions, s.r.o.
Engagement: Project Atlas – Legal DD
Date: January 2025

1. CORPORATE
  [✓] Certificate of incorporation
  [✓] Articles of association (current version)
  [✓] Shareholder register
  [✗] Board minutes for past 3 years (only 2 years provided)
  [✓] Powers of attorney

2. CONTRACTS
  [✓] Customer contracts (top 20 by revenue)
  [✓] Supplier agreements
  [✗] Change of control provisions review (in progress)
  [✓] Lease agreements

3. EMPLOYMENT
  [✓] Employment contracts (template + deviations)
  [✓] Collective bargaining agreement
  [✗] Stock option plan documentation (missing vesting schedule)
  [✓] Non-compete agreements

4. INTELLECTUAL PROPERTY
  [✓] Patent registrations (3 CZ, 1 EP)
  [✓] Trademark portfolio
  [✗] Open source license audit (pending)
  [✓] Software license agreements

5. LITIGATION
  [✓] Pending proceedings (1 minor labor dispute, EUR 15K)
  [✓] Regulatory investigations (none)
  [✓] Tax audit history

Overall completion: 78% (14/18 items)
Outstanding items require follow-up by Feb 15, 2025.`,

  "Corporate_Structure_Chart.pdf": `CORPORATE STRUCTURE – PROJECT ATLAS

TechFlow Group B.V. (Netherlands)
  │
  ├── 100% TechFlow Solutions, s.r.o. (Czech Republic)
  │     ├── 51% TechFlow Labs, s.r.o. (Czech Republic)
  │     └── 100% TechFlow Services, Kft. (Hungary)
  │
  ├── 100% TechFlow GmbH (Germany)
  │     └── 100% TechFlow Consulting AG (Switzerland)
  │
  └── 80% TechFlow UK Ltd. (United Kingdom)
        └── 100% TechFlow Ireland DAC (Ireland)

Key financial data (2024 consolidated):
- Revenue: EUR 42.3M
- EBITDA: EUR 8.1M
- Employees: 312 (CZ: 185, HU: 45, DE: 52, UK: 30)
- Net debt: EUR 3.2M

Regulatory notes:
- Czech subsidiary holds trade licenses for IT services
- Hungarian entity operates under simplified tax regime
- UK entity requires FCA notification for fintech module`,

  "Share_Purchase_Agreement_Draft.docx": `SHARE PURCHASE AGREEMENT – DRAFT v3.2

Between:
(1) TechFlow Group B.V. ("Seller")
(2) Nordic Digital Ventures AB ("Buyer")

Re: Acquisition of 100% shares in TechFlow Solutions, s.r.o.

ARTICLE 1 – DEFINITIONS
"Business Day" means any day other than Saturday, Sunday, or public holiday in the Czech Republic or the Netherlands.
"Closing Date" means the fifth Business Day after satisfaction of all Conditions Precedent.
"Material Adverse Change" means any event reducing EBITDA by more than 15% compared to the 2024 audited accounts.

ARTICLE 2 – PURCHASE PRICE
2.1 The Purchase Price shall be EUR 35,000,000 (thirty-five million euros).
2.2 The Purchase Price shall be adjusted by a locked-box mechanism with an effective date of December 31, 2024.
2.3 Permitted leakage: salaries, rent, and ordinary-course trade payables.

ARTICLE 3 – CONDITIONS PRECEDENT
3.1 Antitrust clearance from Czech ÚOHS (no Phase II referral);
3.2 Consent of key customers representing >60% of revenue;
3.3 No Material Adverse Change between signing and closing.

ARTICLE 4 – WARRANTIES
The Seller warrants that the information in the Data Room is true and complete as of the date hereof.

[REMAINDER SUBJECT TO NEGOTIATION]`,

  "Regulatory_Compliance_Report.pdf": `REGULATORY COMPLIANCE REPORT
TechFlow Solutions, s.r.o. – Project Atlas DD

1. DATA PROTECTION (GDPR)
Status: PARTIALLY COMPLIANT
- Data Processing Agreement with 12 of 15 sub-processors (3 pending)
- DPIA completed for customer analytics module
- Data breach notification procedure in place
- Missing: appointed DPO (required due to large-scale processing)
Recommendation: Appoint DPO before closing; budget EUR 45K/year

2. TRADE LICENSES
Status: COMPLIANT
- All required Czech trade licenses active and valid through 2027
- Hungarian trade license renewed in October 2024

3. EMPLOYMENT REGULATIONS
Status: COMPLIANT WITH MINOR GAPS
- Czech labor code requirements met
- Working time records: 2 instances of non-compliance in Q3 2024
- Collective bargaining agreement expires March 2026
Risk level: LOW

4. FINANCIAL REGULATION
Status: NOT APPLICABLE (fintech module not launched in CZ)
Note: UK FCA notification required if fintech module is deployed via TechFlow UK Ltd.

Overall risk rating: LOW-MEDIUM
Estimated remediation cost: EUR 65,000–85,000`,

  // ws-pracovni-spory
  "Vypoved_z_pracovniho_pomeru.pdf": `VÝPOVĚĎ Z PRACOVNÍHO POMĚRU

Zaměstnavatel: Moravské strojírny, a.s., IČO: 49567890, se sídlem Zlín, Třída Tomáše Bati 1500

Zaměstnanec: Ing. Radek Procházka, dat. nar. 3. 8. 1982, bytem Zlín, Březnická 22

Podle § 52 písm. c) zákoníku práce dáváme výpověď z pracovního poměru z důvodu organizačních změn. Na základě rozhodnutí představenstva ze dne 10. 12. 2024 se ruší pozice vedoucího oddělení technické kontroly, kterou zastáváte.

Výpovědní doba činí 2 měsíce a začne běžet prvním dnem kalendářního měsíce následujícího po doručení této výpovědi.

Odstupné: Náleží Vám odstupné ve výši trojnásobku průměrného výdělku dle § 67 odst. 1 písm. c) zákoníku práce, tj. 187 500 Kč.

Ve Zlíně dne 15. ledna 2025

Za zaměstnavatele: Ing. Josef Malý, personální ředitel`,

  "Odvolani_proti_rozhodnuti.pdf": `ODVOLÁNÍ PROTI ROZHODNUTÍ ZAMĚSTNAVATELE

Moravské strojírny, a.s.
k rukám personálního ředitele
Třída Tomáše Bati 1500, Zlín

Věc: Neplatnost výpovědi ze dne 15. 1. 2025

Já, Ing. Radek Procházka, tímto namítám neplatnost výpovědi z následujících důvodů:

1. Organizační změna nebyla skutečně realizována – pozice vedoucího technické kontroly nebyla zrušena, nýbrž přejmenována na „manažer kvality" a obsazena jiným zaměstnancem (Ing. Kopecká, nastoupila 1. 2. 2025).

2. Zaměstnavatel nedodržel povinnost nabídky jiného vhodného pracovního místa dle § 73a odst. 2 ZP, přestože v době výpovědi byla volná pozice vedoucího údržby.

3. V době doručení výpovědi jsem čerpal pracovní neschopnost (od 14. 1. 2025), výpověď tedy nemohla být platně doručena dle § 334 ZP.

Pokud zaměstnavatel neodvolá výpověď do 15 dnů, podám žalobu o určení neplatnosti výpovědi dle § 72 zákoníku práce.

Ve Zlíně dne 5. února 2025
Ing. Radek Procházka`,

  "Pracovni_smlouva.docx": `PRACOVNÍ SMLOUVA

Zaměstnavatel: Moravské strojírny, a.s., IČO: 49567890
Zaměstnanec: Ing. Radek Procházka, dat. nar. 3. 8. 1982

1. Druh práce: vedoucí oddělení technické kontroly
2. Místo výkonu práce: Zlín, Třída Tomáše Bati 1500
3. Den nástupu: 1. března 2018
4. Pracovní poměr se sjednává na dobu neurčitou
5. Zkušební doba: 3 měsíce
6. Mzda: 62 500 Kč měsíčně (mzdový výměr příloha č. 1)
7. Týdenní pracovní doba: 40 hodin
8. Dovolená: 5 týdnů ročně

Zaměstnanec potvrzuje, že byl seznámen s pracovním řádem, předpisy BOZP a interními směrnicemi zaměstnavatele.

Ve Zlíně dne 25. února 2018`,

  "Svedecka_vypoved.pdf": `SVĚDECKÁ VÝPOVĚĎ

Okresní soud ve Zlíně
sp. zn. 12 C 45/2025

Svědek: Bc. Lucie Dvořáková, dat. nar. 12. 4. 1990
Vztah k účastníkům: kolegkyně žalobce, vedoucí oddělení HR

Výpověď:
"Pracuji v Moravských strojírnách od roku 2015 jako vedoucí personálního oddělení. K organizační změně ze dne 10. 12. 2024 mohu uvést následující:

Rozhodnutí o zrušení pozice vedoucího technické kontroly připravoval finanční ředitel Ing. Kučera. Před tímto rozhodnutím jsem upozorňovala, že pan Procházka by mohl být převeden na pozici vedoucího údržby, která byla v té době neobsazena. Toto mi bylo zamítnuto s odůvodněním, že na tuto pozici je již vybrán externí kandidát.

Dne 20. ledna 2025 nastoupila na nově vytvořenou pozici 'manažer kvality' Ing. Kopecká. Náplň práce se z 80 % shoduje s původní pozicí vedoucího technické kontroly."

Svědek poučen dle § 126 o.s.ř. o povinnosti vypovídat pravdivě.

Ve Zlíně dne 10. března 2025`,

  // ws-compliance-ceska-energie
  "Compliance_Manual_2024.pdf": `COMPLIANCE MANUÁL 2024
Česká Energie, a.s.

1. ÚVOD
Tento manuál stanovuje pravidla pro dodržování regulatorních požadavků, etických norem a vnitřních předpisů společnosti Česká Energie, a.s.

2. PROTIKORUPČNÍ POLITIKA
2.1 Zákaz přijímání a poskytování úplatků dle zákona č. 40/2009 Sb. (trestní zákoník), § 331–334.
2.2 Dary a pohoštění: max. hodnota 2 000 Kč/osoba/rok, nutná evidence v registru darů.
2.3 Sponzoring: schvaluje výhradně představenstvo.

3. STŘET ZÁJMŮ
Každý zaměstnanec je povinen ohlásit střet zájmů prostřednictvím formuláře COI-01. Lhůta: 5 pracovních dnů od zjištění.

4. WHISTLEBLOWING
Oznámení lze podat:
  a) e-mailem: compliance@ceskaenergie.cz
  b) telefonicky: interní linka 5555
  c) poštou: Compliance Officer, Česká Energie, a.s., Vinohradská 100, Praha 3
Ochrana oznamovatele dle zákona č. 171/2023 Sb. je garantována.

5. SANKCE ZA PORUŠENÍ
Disciplinární řízení, výpověď, trestní oznámení dle závažnosti.

Platnost: 1. 1. 2024 – 31. 12. 2024
Schválil: Ing. Helena Marková, Chief Compliance Officer`,

  "AML_Risk_Assessment.pdf": `AML RISK ASSESSMENT
Česká Energie, a.s. – Annual Review 2024

EXECUTIVE SUMMARY
Overall AML risk rating: MEDIUM

1. CUSTOMER RISK
- Total B2B customers: 1,247
- High-risk jurisdictions: 3 customers (Russia-linked beneficial owners identified and terminated)
- PEP exposure: 2 customers flagged, enhanced due diligence applied
- KYC completion rate: 98.7%

2. PRODUCT/SERVICE RISK
- Energy trading positions: medium risk (large value, cross-border)
- Retail supply: low risk
- Green certificate trading: medium risk (new product, limited history)

3. GEOGRAPHIC RISK
- Primary operations: Czech Republic (low risk)
- Cross-border trading: Germany, Austria, Slovakia (low risk)
- Spot market participation: Leipzig EEX (medium risk due to volume)

4. TRANSACTION MONITORING
- Alerts generated (2024): 456
- Alerts escalated to MLRO: 34
- Suspicious Activity Reports filed: 2
- False positive rate: 92.5%

5. RECOMMENDATIONS
  a) Implement automated sanctions screening (current: manual, bi-weekly)
  b) Enhance UBO verification for green certificate counterparties
  c) Update customer risk scoring model (last update: 2022)

Prepared by: External AML Advisor, Deloitte Advisory s.r.o.
Date: December 2024`,

  "Internal_Audit_Report.docx": `ZPRÁVA INTERNÍHO AUDITU č. 2024/07
Česká Energie, a.s.

Oblast auditu: Proces schvalování dodavatelů
Období: Q1–Q3 2024
Auditor: Ing. Marek Vlček, CIA

ZJIŠTĚNÍ:
1. (VYSOKÁ PRIORITA) U 3 z 15 testovaných dodavatelů chybělo ověření skutečného vlastníka (UBO). Jedná se o dodavatele s kumulativním obratem 12,5 mil. Kč.

2. (STŘEDNÍ PRIORITA) Interní směrnice SM-07 vyžaduje tříkolové výběrové řízení pro zakázky nad 5 mil. Kč. U 2 zakázek bylo provedeno pouze dvoukolové řízení (zakázky č. 2024/089 a 2024/112).

3. (NÍZKÁ PRIORITA) 8 dodavatelských smluv překročilo platnost bez formálního prodloužení (auto-renewal klauzule).

DOPORUČENÍ:
1. Zavést automatickou kontrolu UBO při registraci nového dodavatele do SAP.
2. Implementovat workflow pro schvalování výjimek z SM-07.
3. Nasadit upozornění 60 dnů před expirací smlouvy.

VYJÁDŘENÍ MANAGEMENTU:
Všechna doporučení přijata. Implementace do 31. 3. 2025.`,

  "Compliance_Training_Materials.pdf": `COMPLIANCE ŠKOLENÍ 2024
Česká Energie, a.s.

Modul 1: Protikorupční pravidla
- Co je úplatek? Definice dle § 331 TZ
- Příklady zakázaného jednání
- Jak reagovat na nabídku úplatku
- Quiz: 5 otázek (min. skóre: 80 %)

Modul 2: GDPR a ochrana dat
- Práva subjektů údajů
- Jak bezpečně zacházet s osobními údaji
- Incidenty: co dělat při úniku dat
- Quiz: 5 otázek (min. skóre: 80 %)

Modul 3: Whistleblowing
- Kdy a jak podat oznámení
- Ochrana oznamovatele dle zákona č. 171/2023 Sb.
- Praktické příklady
- Quiz: 3 otázky

Statistika účasti:
- Povinní zaměstnanci: 842
- Absolvovali: 819 (97,3 %)
- Průměrné skóre: 91 %
- Zbývající termín: 31. 12. 2024`,

  // ws-reorganizace
  "Reorganizacni_plan.pdf": `REORGANIZAČNÍ PLÁN
PrůmyslPlus, a.s. – v reorganizaci

Krajský soud v Praze, sp. zn. MSPH 60 INS 4567/2024

1. ZÁKLADNÍ ÚDAJE
Dlužník: PrůmyslPlus, a.s., IČO: 25467890
Insolvenční správce: JUDr. Pavel Černý, se sídlem Praha 4
Celkové přihlášené pohledávky: 245 000 000 Kč
Zajištěné pohledávky: 120 000 000 Kč
Nezajištěné pohledávky: 125 000 000 Kč

2. NAVRHOVANÉ ŘEŠENÍ
2.1 Zajištění věřitelé obdrží 100 % svých pohledávek:
  - Splácení po dobu 5 let, úrok 3 % p.a.
  - Zajištění: zástavní právo k nemovitostem v k.ú. Hostivař

2.2 Nezajištění věřitelé obdrží 35 % svých pohledávek:
  - Jednorázová výplata do 90 dnů od schválení plánu
  - Zdroj: prodej neprovozního majetku (pozemky Uhříněves)

3. PROVOZNÍ OPATŘENÍ
  a) Snížení počtu zaměstnanců z 450 na 320
  b) Ukončení ztrátové divize povrchových úprav
  c) Restrukturalizace dodavatelského řetězce

4. HARMONOGRAM
  - Schválení věřitelským výborem: březen 2025
  - Schválení soudem: květen 2025
  - Zahájení plnění: červen 2025

Zpracoval: JUDr. Pavel Černý, insolvenční správce
Datum: 15. ledna 2025`,

  "Projekt_rozdeleni.pdf": `PROJEKT ROZDĚLENÍ ODŠTĚPENÍM

Rozdělovaná společnost: PrůmyslPlus, a.s. (v reorganizaci)
Nástupnická společnost: PrůmyslPlus Manufacturing, s.r.o. (nově zakládaná)

Dle § 243 a násl. zákona č. 125/2008 Sb. o přeměnách obchodních společností.

1. ODŠTĚPOVANÝ MAJETEK
  - Výrobní hala Hostivař (LV 4567, k.ú. Hostivař)
  - Strojní vybavení dle přílohy č. 1 (účetní hodnota 45 mil. Kč)
  - Zásoby materiálu (účetní hodnota 12 mil. Kč)
  - Pohledávky z obchodního styku (28 mil. Kč)

2. PŘECHÁZEJÍCÍ ZÁVAZKY
  - Závazky vůči dodavatelům výrobního materiálu (15 mil. Kč)
  - Pracovněprávní závazky vůči 280 zaměstnancům dle § 338 ZP

3. ZÁKLADNÍ KAPITÁL NÁSTUPNICKÉ SPOLEČNOSTI
  - 20 000 000 Kč (dvacet milionů korun českých)
  - Jediný společník: strategický investor (určen na základě výběrového řízení)

4. ROZHODNÝ DEN: 1. července 2025

Projekt schválen valnou hromadou dne 20. února 2025.`,

  "Zapis_z_valneho_shromazdeni.docx": `ZÁPIS Z MIMOŘÁDNÉ VALNÉ HROMADY
PrůmyslPlus, a.s. (v reorganizaci)

Datum: 20. února 2025, 10:00
Místo: Praha 4,Chodovská 1580/14
Přítomni: akcionáři zastupující 89,3 % základního kapitálu

Program:
1. Zahájení, volba orgánů valné hromady
2. Schválení reorganizačního plánu
3. Schválení projektu rozdělení odštěpením
4. Změna stanov
5. Různé

Usnesení č. 1: Valná hromada schvaluje reorganizační plán ze dne 15. 1. 2025.
Hlasování: pro 87,1 %, proti 2,2 %, zdržel se 0 %

Usnesení č. 2: Valná hromada schvaluje projekt rozdělení odštěpením.
Hlasování: pro 85,5 %, proti 3,8 %, zdržel se 0 %

Usnesení č. 3: Valná hromada schvaluje změnu stanov v rozsahu dle přílohy.
Hlasování: pro 89,3 %, proti 0 %, zdržel se 0 %

Zápis vyhotovil: JUDr. Anna Bílá, notářka
Notářský zápis č. NZ 112/2025`,

  "Schemata_holdingove_struktury.pdf": `SCHÉMA HOLDINGOVÉ STRUKTURY – PO REORGANIZACI

PrůmyslPlus, a.s. (mateřská společnost)
  │
  ├── 100% PrůmyslPlus Manufacturing, s.r.o.
  │     (výrobní činnost, 280 zaměstnanců)
  │
  ├── 100% PrůmyslPlus Services, s.r.o.
  │     (servis a údržba, 40 zaměstnanců)
  │
  └── 60% PrůmyslPlus Slovakia, s.r.o.
        (obchodní zastoupení pro SR, 15 zaměstnanců)

Strategický investor: vstup do PrůmyslPlus Manufacturing
  - Podíl: 70 % po kapitálovém vstupu
  - Investice: 85 000 000 Kč
  - Podmínky: zachování zaměstnanosti min. 3 roky

Časový plán restrukturalizace:
  Q2 2025: schválení soudem + zápis odštěpení
  Q3 2025: kapitálový vstup investora
  Q4 2025: dokončení reorganizace, splnění plánu`,

  // ws-cross-border
  "Term_Sheet_Cross_Border.pdf": `TERM SHEET – CROSS-BORDER ACQUISITION

Project: Project Danube
Date: January 15, 2025

Buyer: NordicAqua Industries AB (Sweden)
Target: AquaTech Central Europe, s.r.o. (Czech Republic)

1. TRANSACTION STRUCTURE
   Type: Share deal (100% acquisition)
   Consideration: EUR 28,000,000 (enterprise value)
   Adjustments: Net debt, working capital (target: EUR 4.2M)

2. KEY TERMS
   Exclusivity period: 60 days from signing
   Break fee: EUR 500,000 (mutual)
   Governing law: Czech Republic
   Arbitration: ICC Prague

3. CONDITIONS PRECEDENT
   a) Satisfactory legal, financial, and tax DD
   b) Czech antitrust clearance (ÚOHS)
   c) EU foreign subsidy regulation filing (if required)
   d) Consent of key customers (>50% revenue)
   e) No MAC between signing and closing

4. INDICATIVE TIMELINE
   DD completion: March 31, 2025
   SPA signing: April 30, 2025
   Regulatory approvals: June 30, 2025
   Closing: July 31, 2025

5. EMPLOYEE MATTERS
   Key management retention: 24-month lock-in
   No redundancies for 12 months post-closing

This Term Sheet is non-binding except for clauses 2 (exclusivity) and 2 (break fee).`,

  "Regulatory_Filing_EU.pdf": `EU REGULATORY FILING – PROJECT DANUBE

Filing Authority: European Commission, DG Competition
Filing Type: EU Foreign Subsidies Regulation (FSR), Art. 21

1. PARTIES
   Notifying Party: NordicAqua Industries AB
   - Registered: Stockholm, Sweden
   - Group revenue (2024): EUR 890M
   - Employees: 4,200

   Target: AquaTech Central Europe, s.r.o.
   - Registered: Prague, Czech Republic
   - Revenue (2024): EUR 31M
   - Employees: 145
   - Market share (CZ water treatment): ~12%

2. FOREIGN SUBSIDIES ASSESSMENT
   NordicAqua received the following financial contributions:
   a) Swedish Innovation Agency grant: EUR 2.1M (R&D, 2022–2024)
   b) EIB loan at preferential rate: EUR 15M (green infrastructure)
   c) Regional employment subsidy: EUR 800K (Gothenburg plant)

   Total financial contributions (3 years): EUR 17.9M
   Threshold for notification: EUR 50M (not met)

   CONCLUSION: Mandatory FSR notification NOT required.
   Voluntary pre-notification recommended due to:
   - Size of acquirer relative to target market
   - Strategic sector (water infrastructure)

3. CZECH ANTITRUST (ÚOHS)
   Combined market share in CZ: <15%
   Filing required: YES (turnover thresholds met)
   Expected timeline: 30 days (Phase I, no concerns anticipated)

4. MERGER CONTROL – OTHER JURISDICTIONS
   Slovakia: filing not required (no target turnover)
   Germany: filing not required (target revenue <EUR 5M in DE)
   Poland: filing not required (no operations)

Prepared by: Novák & Partners, Prague
Date: February 2025`,

  "Merger_Agreement_Draft.docx": `MERGER AGREEMENT – DRAFT v2.1
Project Danube

PARTIES:
(1) NordicAqua Industries AB, reg. no. 556789-0123, Stockholm ("Buyer")
(2) WaterTech Holding GmbH, HRB 45678, Munich ("Seller")
(3) AquaTech Central Europe, s.r.o., IČO: 04567890, Prague ("Company")

RECITALS:
(A) Seller is the sole shareholder of the Company.
(B) Buyer wishes to acquire 100% of the shares in the Company.
(C) The Parties have agreed on the terms set forth herein.

ARTICLE 1 – SALE AND PURCHASE
1.1 Subject to the terms of this Agreement, Seller sells and Buyer purchases all Shares.
1.2 The Shares are transferred free from all Encumbrances.

ARTICLE 2 – PURCHASE PRICE
2.1 Enterprise Value: EUR 28,000,000
2.2 Equity Value = Enterprise Value – Net Debt + excess Working Capital
2.3 Estimated Equity Value at Signing: EUR 24,800,000
2.4 Completion Accounts to be prepared within 60 days of Closing.

ARTICLE 3 – SELLER'S WARRANTIES
3.1 The Seller makes the warranties set out in Schedule 3.
3.2 Warranty cap: 30% of the Purchase Price (EUR 7,440,000)
3.3 De minimis threshold: EUR 50,000
3.4 Basket (deductible): EUR 250,000
3.5 Warranty period: 24 months from Closing (tax: 60 months)

[SCHEDULES TO BE ATTACHED]`,

  "Competition_Law_Analysis.pdf": `COMPETITION LAW ANALYSIS
Project Danube – NordicAqua / AquaTech

1. MARKET DEFINITION
   Relevant product market: industrial water treatment systems
   Relevant geographic market: Czech Republic (national)

2. MARKET SHARES (2024)
   Company                    | CZ Market Share
   Veolia Water Technologies  | 22%
   Xylem (Wedeco)            | 18%
   AquaTech CE (target)      | 12%
   NordicAqua (buyer)        | 3%
   Others                    | 45%

   Combined post-merger: ~15% → no dominance concern

3. HORIZONTAL OVERLAP
   Both parties active in industrial water treatment.
   Combined share <25% in all segments.
   No significant barrier to entry (multiple EU competitors).

4. VERTICAL EFFECTS
   NordicAqua supplies membrane filters used by AquaTech.
   Current share of NordicAqua in membrane supply: <8% (CZ).
   No foreclosure risk identified.

5. ASSESSMENT
   Phase I clearance expected (no serious doubts).
   No remedies anticipated.
   Filing fee: CZK 100,000

   Recommended filing date: March 15, 2025
   Expected decision: April 15, 2025

Prepared by: Novák & Partners, Prague`,

  // ws-gdpr-audit
  "GDPR_Gap_Analysis.pdf": `GDPR GAP ANALYSIS REPORT
Client: MedTech Innovations, s.r.o.

Assessment Date: January 2025
Assessor: Novák & Partners – Data Protection Practice

1. EXECUTIVE SUMMARY
   Current compliance level: 62% (target: 95%)
   Critical gaps: 4
   High-priority gaps: 7
   Medium-priority gaps: 5

2. CRITICAL GAPS
   2.1 No appointed DPO despite processing health data (Art. 37)
   2.2 Consent mechanism for clinical trial data does not meet Art. 7 requirements
   2.3 Data transfers to US cloud provider lack adequate safeguards (post-Schrems II)
   2.4 No documented data breach response procedure (Art. 33/34)

3. HIGH-PRIORITY GAPS
   3.1 Privacy notices incomplete (missing retention periods, legal basis)
   3.2 DPIA not conducted for AI diagnostic module
   3.3 Processor agreements missing with 3 of 8 sub-processors
   3.4 Records of processing activities incomplete (Art. 30)
   3.5 Employee training not conducted in past 12 months
   3.6 Right to erasure process not documented
   3.7 Cookie consent banner non-compliant (pre-checked boxes)

4. REMEDIATION TIMELINE
   Critical: 30 days
   High: 90 days
   Medium: 180 days

   Estimated total cost: EUR 45,000–65,000`,

  "Data_Processing_Agreement.pdf": `DATA PROCESSING AGREEMENT

Between:
Controller: MedTech Innovations, s.r.o., IČO: 09876543
Processor: CloudHealth Services, Inc., Delaware, USA

Pursuant to Article 28 GDPR

1. SCOPE OF PROCESSING
   Personal data categories: patient health records, diagnostic images, treatment plans
   Data subjects: patients of Controller's clients (hospitals, clinics)
   Processing purpose: cloud storage, AI-assisted diagnostics, reporting

2. PROCESSOR OBLIGATIONS
   2.1 Process data only on documented instructions from Controller
   2.2 Ensure confidentiality (all personnel under NDA)
   2.3 Implement technical measures: AES-256 encryption at rest, TLS 1.3 in transit
   2.4 Assist Controller with DPIA and data subject rights requests
   2.5 Delete all data within 30 days of contract termination

3. SUB-PROCESSORS
   Approved sub-processors:
   a) AWS (Frankfurt region) – infrastructure
   b) Datadog (EU) – monitoring
   Controller must be notified 30 days before any sub-processor change.

4. INTERNATIONAL TRANSFERS
   Transfer mechanism: EU Standard Contractual Clauses (2021/914)
   Supplementary measures: encryption, access controls, data localization option

5. AUDIT RIGHTS
   Controller may audit Processor once per year with 30 days' notice.
   SOC 2 Type II report provided annually.

Effective date: February 1, 2025`,

  "Privacy_Impact_Assessment.docx": `DATA PROTECTION IMPACT ASSESSMENT (DPIA)
MedTech Innovations – AI Diagnostic Module

1. DESCRIPTION OF PROCESSING
   The AI Diagnostic Module processes medical images (X-rays, CT scans, MRIs) to provide preliminary diagnostic suggestions to physicians.
   Data volume: ~50,000 images/month
   Storage: CloudHealth Services (AWS Frankfurt)
   Retention: 5 years (regulatory requirement)

2. NECESSITY AND PROPORTIONALITY
   Legal basis: legitimate interest (Art. 6(1)(f)) for processing; explicit consent (Art. 9(2)(a)) for health data
   Purpose limitation: diagnostic assistance only; no secondary use
   Data minimization: images pseudonymized before AI processing

3. RISKS TO DATA SUBJECTS
   3.1 HIGH: Re-identification of pseudonymized images through metadata correlation
   3.2 HIGH: Misdiagnosis leading to patient harm (not a GDPR risk per se, but relevant)
   3.3 MEDIUM: Unauthorized access to health data in transit
   3.4 LOW: Data subject unable to exercise right to explanation (Art. 22)

4. MITIGATION MEASURES
   3.1 → Strip all DICOM metadata before processing; use random patient tokens
   3.2 → AI output labeled as "preliminary suggestion"; physician review mandatory
   3.3 → End-to-end encryption; zero-trust network architecture
   3.4 → Implement explainability layer (SHAP values for model decisions)

5. DPA CONSULTATION
   Consultation with ÚOOÚ recommended due to large-scale health data processing.

Completed by: Mgr. Jana Horáková, DPO (external)
Date: January 2025`,

  "Cookie_Policy_Draft.pdf": `COOKIE POLICY – DRAFT
MedTech Innovations, s.r.o.

Last updated: January 2025

1. WHAT ARE COOKIES
   Cookies are small text files stored on your device when you visit our website (www.medtechinnovations.cz).

2. COOKIES WE USE

   Essential cookies (no consent required):
   - session_id: user authentication (expires: session)
   - csrf_token: security (expires: session)
   - cookie_consent: stores your cookie preferences (expires: 12 months)

   Analytics cookies (consent required):
   - _ga, _gid: Google Analytics – website usage statistics
   - _hjid: Hotjar – user behavior analysis

   Marketing cookies (consent required):
   - _fbp: Facebook Pixel – ad performance measurement
   - _gcl_au: Google Ads conversion tracking

3. HOW TO MANAGE COOKIES
   You can manage your preferences through our cookie banner or browser settings.
   Withdrawing consent does not affect the lawfulness of prior processing.

4. DATA TRANSFERS
   Google Analytics data may be transferred to the US. We use Google's EU data residency option where available.

5. CONTACT
   Data Protection Officer: Mgr. Jana Horáková
   Email: dpo@medtechinnovations.cz
   Supervisory authority: ÚOOÚ (www.uoou.cz)`,
};

for (let i = 0; i < EXPORT_REVIEW_DOC_NAMES.length; i++) {
  const fileName = at(EXPORT_REVIEW_DOC_NAMES, i);
  documentTexts[fileName] = buildExportReviewDocumentText(fileName, i);
}

// ─── Contacts ───────────────────────────────────────────

const orgContacts = [
  {
    id: seedId("contact-org-novak-partners"),
    type: "organization" as const,
    displayName: "Novák & Partners, s.r.o.",
    organizationName: "Novák & Partners, s.r.o.",
    registrationNumber: "27145689",
    taxId: "CZ27145689",
    bankAccounts: [
      {
        iban: "CZ6508000000192000145399",
        bic: "GIBACZPX",
        bankName: "Česká spořitelna",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Národní 60/28",
      city: "Praha",
      state: "Praha 1",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "info@novak-partners.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office" as const,
        number: "+420 221 111 222",
        isPrimary: true,
      },
    ],
    color: "blue",
  },
  {
    id: seedId("contact-org-ceska-energie"),
    type: "organization" as const,
    displayName: "Česká Energie a.s.",
    organizationName: "Česká Energie a.s.",
    registrationNumber: "45274649",
    taxId: "CZ45274649",
    bankAccounts: [
      {
        iban: "CZ9501000000270100610043",
        bic: "KOMBCZPP",
        bankName: "Komerční banka",
        currency: "CZK",
      },
      {
        iban: "DE89370400440532013000",
        bic: "COBADEFFXXX",
        bankName: "Commerzbank",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Vodičkova 791/41",
      city: "Praha",
      state: "Praha 1",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5000,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work" as const,
        address: "legal@ceska-energie.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office" as const,
        number: "+420 234 567 890",
        isPrimary: true,
      },
    ],
    color: "green",
  },
  {
    id: seedId("contact-org-moravska-stavebni"),
    type: "organization" as const,
    displayName: "Moravská stavební, s.r.o.",
    organizationName: "Moravská stavební, s.r.o.",
    registrationNumber: "60711086",
    taxId: "CZ60711086",
    bankAccounts: [
      {
        accountNumber: "2901761283/2010",
        bankName: "Fio banka",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Masarykova 31",
      city: "Brno",
      postalCode: "602 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 3500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "kancelar@moravska-stavebni.cz",
        isPrimary: true,
      },
    ],
    color: "orange",
  },
  {
    id: seedId("contact-org-greenleaf"),
    type: "organization" as const,
    displayName: "Greenleaf Investments Ltd.",
    organizationName: "Greenleaf Investments Ltd.",
    registrationNumber: "12345678",
    taxId: "GB123456789",
    bankAccounts: [
      {
        iban: "GB29NWBK60161331926819",
        bic: "NWBKGB2L",
        bankName: "NatWest",
        currency: "GBP",
      },
    ],
    billingAddress: {
      line1: "25 Old Broad Street",
      city: "London",
      postalCode: "EC2N 1HN",
      country: "United Kingdom",
    },
    defaultHourlyRate: 350,
    currency: "GBP",
    paymentTermDays: 45,
    emails: [
      {
        type: "work" as const,
        address: "legal@greenleaf-investments.co.uk",
        isPrimary: true,
      },
    ],
    color: "emerald",
  },
  {
    id: seedId("contact-org-northstar-robotics"),
    type: "organization" as const,
    displayName: "Northstar Robotics, Inc.",
    organizationName: "Northstar Robotics, Inc.",
    registrationNumber: "7483921",
    taxId: "US-94-7483921",
    bankAccounts: [],
    billingAddress: {
      line1: "548 Market Street",
      city: "San Francisco",
      state: "California",
      postalCode: "94104",
      country: "United States",
    },
    defaultHourlyRate: 450,
    currency: "USD",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "legal@northstar-robotics.example",
        isPrimary: true,
      },
    ],
    phones: [],
    color: "violet",
  },
];

// Additional org contacts for overview stress-testing
const moreOrgContacts = [
  {
    id: seedId("contact-org-bratislava-legal"),
    type: "organization" as const,
    displayName: "Bratislava Legal Group, s.r.o.",
    organizationName: "Bratislava Legal Group, s.r.o.",
    registrationNumber: "36721484",
    taxId: "SK2022336611",
    billingAddress: {
      line1: "Michalská 9",
      city: "Bratislava",
      postalCode: "811 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 200,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "office@bratislava-legal.sk",
        isPrimary: true,
      },
    ],
    color: "indigo",
  },
  {
    id: seedId("contact-org-muller-bergmann"),
    type: "organization" as const,
    displayName: "Müller & Bergmann Rechtsanwälte",
    organizationName: "Müller & Bergmann Rechtsanwälte",
    registrationNumber: "HRB 123456",
    taxId: "DE987654321",
    billingAddress: {
      line1: "Friedrichstraße 44",
      city: "Berlin",
      postalCode: "10117",
      country: "Deutschland",
    },
    defaultHourlyRate: 380,
    currency: "EUR",
    paymentTermDays: 21,
    emails: [
      {
        type: "work" as const,
        address: "kanzlei@muller-bergmann.de",
        isPrimary: true,
      },
    ],
    color: "rose",
  },
  {
    id: seedId("contact-org-thames-advisory"),
    type: "organization" as const,
    displayName: "Thames Advisory Partners LLP",
    organizationName: "Thames Advisory Partners LLP",
    registrationNumber: "OC345678",
    taxId: "GB345678901",
    billingAddress: {
      line1: "1 Finsbury Avenue",
      city: "London",
      postalCode: "EC2M 2PF",
      country: "United Kingdom",
    },
    defaultHourlyRate: 450,
    currency: "GBP",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "enquiries@thames-advisory.co.uk",
        isPrimary: true,
      },
    ],
    color: "teal",
  },
  {
    id: seedId("contact-org-zilina-steel"),
    type: "organization" as const,
    displayName: "Žilina Steel Works, a.s.",
    organizationName: "Žilina Steel Works, a.s.",
    registrationNumber: "31625801",
    taxId: "SK2020459789",
    billingAddress: {
      line1: "Priemyselná 12",
      city: "Žilina",
      postalCode: "010 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 180,
    currency: "EUR",
    paymentTermDays: 45,
    emails: [
      {
        type: "work" as const,
        address: "legal@zilina-steel.sk",
        isPrimary: true,
      },
    ],
    color: "slate",
  },
  {
    id: seedId("contact-org-pragobanka"),
    type: "organization" as const,
    displayName: "PragoBanka, a.s.",
    organizationName: "PragoBanka, a.s.",
    registrationNumber: "49241257",
    taxId: "CZ49241257",
    billingAddress: {
      line1: "Senovážné náměstí 15",
      city: "Praha",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5500,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work" as const,
        address: "pravni@pragobanka.cz",
        isPrimary: true,
      },
    ],
    color: "lime",
  },
  {
    id: seedId("contact-org-dunaj-pharma"),
    type: "organization" as const,
    displayName: "Dunaj Pharma, s.r.o.",
    organizationName: "Dunaj Pharma, s.r.o.",
    registrationNumber: "44556677",
    taxId: "SK2044556677",
    billingAddress: {
      line1: "Záhradnícka 46",
      city: "Bratislava",
      postalCode: "821 08",
      country: "Slovensko",
    },
    defaultHourlyRate: 220,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "legal@dunaj-pharma.sk",
        isPrimary: true,
      },
    ],
    color: "pink",
  },
  {
    id: seedId("contact-org-nord-energie"),
    type: "organization" as const,
    displayName: "Nord Energie GmbH",
    organizationName: "Nord Energie GmbH",
    registrationNumber: "HRB 789012",
    taxId: "DE789012345",
    billingAddress: {
      line1: "Am Sandtorkai 50",
      city: "Hamburg",
      postalCode: "20457",
      country: "Deutschland",
    },
    defaultHourlyRate: 320,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "recht@nord-energie.de",
        isPrimary: true,
      },
    ],
    color: "yellow",
  },
  {
    id: seedId("contact-org-ostrava-mining"),
    type: "organization" as const,
    displayName: "Ostrava Mining Corp., a.s.",
    organizationName: "Ostrava Mining Corp., a.s.",
    registrationNumber: "25831470",
    taxId: "CZ25831470",
    billingAddress: {
      line1: "Nádražní 88",
      city: "Ostrava",
      postalCode: "702 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4000,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "office@ostrava-mining.cz",
        isPrimary: true,
      },
    ],
    color: "stone",
  },
  {
    id: seedId("contact-org-crown-shipping"),
    type: "organization" as const,
    displayName: "Crown Shipping Ltd.",
    organizationName: "Crown Shipping Ltd.",
    registrationNumber: "09876543",
    taxId: "GB987654321",
    billingAddress: {
      line1: "3 Royal Exchange",
      city: "London",
      postalCode: "EC3V 3DG",
      country: "United Kingdom",
    },
    defaultHourlyRate: 400,
    currency: "GBP",
    paymentTermDays: 45,
    emails: [
      {
        type: "work" as const,
        address: "legal@crown-shipping.co.uk",
        isPrimary: true,
      },
    ],
    color: "red",
  },
  {
    id: seedId("contact-org-tatra-motors"),
    type: "organization" as const,
    displayName: "Tatra Motors, a.s.",
    organizationName: "Tatra Motors, a.s.",
    registrationNumber: "47892315",
    taxId: "CZ47892315",
    billingAddress: {
      line1: "Areál Tatra 1450",
      city: "Kopřivnice",
      postalCode: "742 21",
      country: "Česká republika",
    },
    defaultHourlyRate: 4200,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "pravni@tatra-motors.cz",
        isPrimary: true,
      },
    ],
    color: "purple",
  },
  {
    id: seedId("contact-org-kosice-tech"),
    type: "organization" as const,
    displayName: "Košice Tech Ventures, s.r.o.",
    organizationName: "Košice Tech Ventures, s.r.o.",
    registrationNumber: "55667788",
    taxId: "SK2055667788",
    billingAddress: {
      line1: "Hlavná 32",
      city: "Košice",
      postalCode: "040 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 190,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "office@kosice-tech.sk",
        isPrimary: true,
      },
    ],
    color: "zinc",
  },
];

const personContacts = [
  {
    id: seedId("contact-person-jan-novak"),
    type: "person" as const,
    displayName: "JUDr. Jan Novák",
    prefix: "JUDr.",
    firstName: "Jan",
    lastName: "Novák",
    emails: [
      {
        type: "work" as const,
        address: "jan.novak@novak-partners.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile" as const,
        number: "+420 602 111 222",
        isPrimary: true,
      },
    ],
    color: "violet",
  },
  {
    id: seedId("contact-person-eva-svobodova"),
    type: "person" as const,
    displayName: "Mgr. Eva Svobodová",
    prefix: "Mgr.",
    firstName: "Eva",
    lastName: "Svobodová",
    emails: [
      {
        type: "work" as const,
        address: "eva.svobodova@ceska-energie.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile" as const,
        number: "+420 603 444 555",
        isPrimary: true,
      },
    ],
    color: "fuchsia",
  },
  {
    id: seedId("contact-person-petr-dvorak"),
    type: "person" as const,
    displayName: "Ing. Petr Dvořák",
    prefix: "Ing.",
    firstName: "Petr",
    lastName: "Dvořák",
    emails: [
      {
        type: "work" as const,
        address: "dvorak@moravska-stavebni.cz",
        isPrimary: true,
      },
    ],
    color: "cyan",
  },
  {
    id: seedId("contact-person-sarah-williams"),
    type: "person" as const,
    displayName: "Sarah Williams",
    firstName: "Sarah",
    lastName: "Williams",
    emails: [
      {
        type: "work" as const,
        address: "s.williams@greenleaf-investments.co.uk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile" as const,
        number: "+44 7700 900123",
        isPrimary: true,
      },
    ],
    color: "sky",
  },
  {
    id: seedId("contact-person-milan-kral"),
    type: "person" as const,
    displayName: "JUDr. Milan Král, Ph.D.",
    prefix: "JUDr.",
    firstName: "Milan",
    lastName: "Král",
    suffix: "Ph.D.",
    notes: "Odborník na stavební právo",
    emails: [
      {
        type: "work" as const,
        address: "kral@kral-advokat.cz",
        isPrimary: true,
      },
    ],
    color: "amber",
  },
];

// ─── Workspaces (Matters) ───────────────────────────────

const seedWorkspaces = [
  {
    id: seedId("ws-akvizice-energo"),
    // The matter the marketing editor scenes film: its breadcrumb frames the
    // Supplier_Agreement.docx redline (Northstar Robotics buying drive
    // components from Meridian Precision), so the name stays supplier-themed.
    name: "Meridian supply agreement",
    reference: "2026/031",
    clientId: at(orgContacts, 4).id, // Northstar Robotics
    billingReference: "NS-SUPPLY-2026",
  },
  {
    id: seedId("ws-stavebni-spor"),
    name: "Stavební spor - Brno Centrál",
    reference: "2024/002",
    clientId: at(orgContacts, 2).id, // Moravská stavební
    billingReference: "MS-LIT-2024",
  },
  {
    id: seedId("ws-due-diligence"),
    name: "Due Diligence - Greenleaf Fund III",
    reference: "2024/003",
    clientId: at(orgContacts, 3).id, // Greenleaf
    billingReference: "GL-DD-2024",
  },
  {
    id: seedId("ws-pracovni-spory"),
    name: "Pracovní spory - Novák",
    reference: "2024/004",
    clientId: at(orgContacts, 0).id, // Novák & Partners
  },
  {
    id: seedId("ws-compliance-ceska-energie"),
    name: "Compliance program",
    reference: "2024/005",
    clientId: at(orgContacts, 1).id, // Česká Energie
    billingReference: "CE-COMP-2024",
  },
  {
    id: seedId("ws-reorganizace"),
    name: "Reorganizace skupiny",
    reference: "2024/006",
    clientId: at(orgContacts, 0).id, // Novák & Partners
  },
  {
    id: seedId("ws-cross-border"),
    name: "Cross-border M&A Advisory",
    reference: "2024/007",
    clientId: at(orgContacts, 3).id, // Greenleaf
    billingReference: "GL-MA-2024",
  },
  {
    id: seedId("ws-gdpr-audit"),
    name: "GDPR Audit a implementace",
    reference: "2024/008",
    clientId: at(orgContacts, 2).id, // Moravská stavební
    billingReference: "MS-GDPR-2024",
  },
  {
    id: seedId("ws-export-review"),
    name: "Export Review - Project Atlas Data Room",
    reference: "2024/059",
    clientId: at(orgContacts, 3).id, // Greenleaf
    billingReference: "GL-EXPORT-2024",
  },
  {
    id: seedId("ws-heavy-virtualization"),
    name: "Virtualization Scale Test Matter",
    reference: "PERF/1000",
    clientId: at(orgContacts, 0).id, // Novák & Partners
    billingReference: "PERF-VIRT-1000",
  },
];

// ─── Sidebar recents ordering ───────────────────────────
// The app sidebar's "Recent matters" list is ordered by
// workspaces.lastActivityAt (apps/web/src/components/app-sidebar.logic.ts),
// and the marketing recordings film that sidebar. Relying on the column's
// defaultNow() orders matters by seed insertion time, which surfaced the
// last few MORE_WORKSPACES entries (Czech-named) in every recording. Every
// workspace therefore gets a deterministic lastActivityAt: the matters
// below (English names, English client names) are pinned to the newest
// dates so they fill all visible recents slots (sidebar limit is 5) with
// margin, and every other matter falls back to an older date derived from
// its insertion index. Keyed by the org-unique matter reference.
const RECENT_MATTER_ACTIVITY: Record<string, string> = {
  "2024/059": "2026-07-17T09:00:00.000Z", // Export Review - Project Atlas Data Room (Greenleaf)
  "2026/031": "2026-07-16T15:00:00.000Z", // Meridian supply agreement (Northstar Robotics)
  "2024/058": "2026-07-16T11:00:00.000Z", // Fund IV Structuring (Greenleaf)
  "2024/046": "2026-07-15T16:00:00.000Z", // Sanctions Screening Programme (Crown Shipping)
  "2024/018": "2026-07-15T10:30:00.000Z", // Post-Acquisition Integration (Thames Advisory)
  "2024/003": "2026-07-14T14:00:00.000Z", // Due Diligence - Greenleaf Fund III (Greenleaf)
  "2024/043": "2026-07-14T09:00:00.000Z", // Charter Party Dispute (Crown Shipping)
  "2024/020": "2026-07-13T15:00:00.000Z", // Anti-Bribery Compliance Review (Thames Advisory)
  "2024/007": "2026-07-13T10:00:00.000Z", // Cross-border M&A Advisory (Greenleaf)
  "2024/016": "2026-07-12T14:00:00.000Z", // Shareholder Dispute Resolution (Thames Advisory)
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Non-cast matters: deterministic and strictly older than every pinned
// date above (2026-02-02 base + one hour per insertion index).
const FALLBACK_ACTIVITY_BASE_MS = Date.UTC(2026, 1, 2, 8, 0, 0);
const FALLBACK_ACTIVITY_STEP_MS = HOUR_MS;

const workspaceLastActivityAt = (reference: string, index: number): Date => {
  const pinned = RECENT_MATTER_ACTIVITY[reference];
  return pinned
    ? new Date(pinned)
    : new Date(FALLBACK_ACTIVITY_BASE_MS + index * FALLBACK_ACTIVITY_STEP_MS);
};

// ─── Entity timestamp pinning ───────────────────────────
// The files views show per-document Created/Last-updated columns, the list
// endpoints sort by asc(entities.createdAt) (see
// apps/api/src/handlers/entities/list-files.ts), and the marketing stills
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

const MARKETING_AGENT_THREAD_TITLE = "Project Atlas · Change-of-control review";

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
  const base: PropertySeed[] = [
    {
      id: seedId(`${wsLabel}-prop-file`),
      workspaceId: wsId,
      name: "Documents",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
      system: true,
      kinds: ["document"],
    },
    {
      id: seedId(`${wsLabel}-prop-status`),
      workspaceId: wsId,
      name: "Status",
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "green", value: "Active" },
          { color: "amber", value: "In Review" },
          { color: "red", value: "Closed" },
          { color: "gray", value: "On Hold" },
        ],
        fallback: null,
      },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: seedId(`${wsLabel}-prop-notes`),
      workspaceId: wsId,
      name: "Notes",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: seedId(`${wsLabel}-prop-due-date`),
      workspaceId: wsId,
      name: "Due Date",
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
        name: "Document Type",
        content: {
          version: 1,
          type: "single-select",
          options: DEFAULT_DOCUMENT_TYPES.map((documentType, index) => ({
            color: at(docTypeColors, index % docTypeColors.length),
            value: documentType.label,
          })),
          fallback: null,
        },
        tool: aiTool("Extract the document category from the attached file."),
      },
    ];
  }

  if (wsLabel !== EXPORT_TABLE_MATTER_LABEL) {
    return base;
  }

  return [
    ...base,
    {
      id: seedId(`${wsLabel}-prop-document-type`),
      workspaceId: wsId,
      name: "Document Type",
      content: {
        version: 1,
        type: "single-select",
        options: EXPORT_REVIEW_DOCUMENT_TYPES.map((value, index) => ({
          color: at(["blue", "teal", "violet", "amber"], index % 4),
          value,
        })),
        fallback: null,
      },
      tool: aiTool("Extract the document category from the attached file."),
    },
    {
      id: seedId(`${wsLabel}-prop-counterparty`),
      workspaceId: wsId,
      name: "Counterparty",
      content: { version: 1, type: "text" },
      tool: aiTool("Extract the primary counterparty named in the document."),
    },
    {
      id: seedId(`${wsLabel}-prop-jurisdiction`),
      workspaceId: wsId,
      name: "Jurisdiction",
      content: {
        version: 1,
        type: "single-select",
        options: EXPORT_REVIEW_JURISDICTIONS.map((value, index) => ({
          color: at(["cyan", "green", "purple", "orange", "gray"], index),
          value,
        })),
        fallback: null,
      },
      tool: aiTool("Extract the relevant jurisdiction from the document."),
    },
    {
      id: seedId(`${wsLabel}-prop-governing-law`),
      workspaceId: wsId,
      name: "Governing Law",
      content: { version: 1, type: "text" },
      tool: aiTool("Extract the governing law clause."),
    },
    {
      id: seedId(`${wsLabel}-prop-effective-date`),
      workspaceId: wsId,
      name: "Effective Date",
      content: { version: 1, type: "date" },
      tool: aiTool("Extract the effective date as an ISO date."),
    },
    {
      id: seedId(`${wsLabel}-prop-expiry-date`),
      workspaceId: wsId,
      name: "Expiry Date",
      content: { version: 1, type: "date" },
      tool: aiTool("Extract the expiry or renewal date as an ISO date."),
    },
    {
      id: seedId(`${wsLabel}-prop-contract-value`),
      workspaceId: wsId,
      name: "Contract Value",
      content: { version: 1, type: "int" },
      tool: aiTool("Extract the contract value in euros."),
    },
    {
      id: seedId(`${wsLabel}-prop-risk-level`),
      workspaceId: wsId,
      name: "Risk Level",
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "green", value: "Low" },
          { color: "amber", value: "Medium" },
          { color: "red", value: "High" },
          { color: "purple", value: "Critical" },
        ],
        fallback: null,
      },
      tool: aiTool("Classify the diligence risk level."),
    },
    {
      id: seedId(`${wsLabel}-prop-review-status`),
      workspaceId: wsId,
      name: "Review Status",
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "gray", value: "Not Started" },
          { color: "blue", value: "In Review" },
          { color: "amber", value: "Needs Partner" },
          { color: "green", value: "Cleared" },
        ],
        fallback: null,
      },
      tool: { version: 1, type: "manual-input" },
    },
    {
      id: seedId(`${wsLabel}-prop-evidence-quality`),
      workspaceId: wsId,
      name: "Evidence Quality",
      content: {
        version: 1,
        type: "single-select",
        options: [
          { color: "green", value: "Direct citation" },
          { color: "amber", value: "Needs source check" },
          { color: "red", value: "Conflicting evidence" },
        ],
        fallback: null,
      },
      tool: aiTool("Assess whether the extracted value has direct support."),
    },
    {
      id: seedId(`${wsLabel}-prop-tags`),
      workspaceId: wsId,
      name: "Tags",
      content: {
        version: 1,
        type: "multi-select",
        options: [
          { color: "blue", value: "change of control" },
          { color: "amber", value: "termination" },
          { color: "violet", value: "data room" },
          { color: "green", value: "renewal" },
          { color: "red", value: "consent needed" },
          { color: "cyan", value: "pricing" },
          { color: "purple", value: "privacy" },
          { color: "gray", value: "security" },
        ],
        fallback: null,
      },
      tool: aiTool("Extract concise diligence tags."),
    },
    {
      id: seedId(`${wsLabel}-prop-key-obligation`),
      workspaceId: wsId,
      name: "Key Obligation",
      content: { version: 1, type: "text" },
      tool: aiTool("Extract the key obligation relevant to closing."),
    },
    {
      id: seedId(`${wsLabel}-prop-risk-finding`),
      workspaceId: wsId,
      name: "Risk Finding",
      content: { version: 1, type: "text" },
      tool: aiTool("Summarize the key diligence risk in one sentence."),
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
        name: at(EXPORT_REVIEW_FOLDERS, i),
      });
    }

    const docNames = workspaceDocNames[wsLabel] ?? [];
    for (let i = 0; i < docNames.length; i++) {
      result.push({
        entityId: seedId(`${wsLabel}-doc-${i + 1}`),
        versionId: seedId(`${wsLabel}-doc-${i + 1}-v`),
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
      name: "Documents",
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

const statuses = ["Active", "In Review", "Closed", "On Hold"];

const notes = [
  "Awaiting client feedback on latest draft",
  "Reviewed by senior partner; minor revisions needed",
  "Final version pending signature",
  "Opposing counsel requested extension",
  "Submitted to court registry",
  "Internal review completed",
  "Client meeting scheduled to discuss terms",
  "Requires translation to English",
  "Expert opinion attached separately",
  "Pending regulatory approval",
  "Redlined version sent to counterparty",
  "Board resolution required before execution",
  "Notarization scheduled for next week",
  "Updated to reflect amended legislation",
  "Confidential; restricted distribution",
  "Cross-referenced with due diligence findings",
  "Template updated to current standards",
  "Risk assessment appended",
  "Fee estimate included in cover letter",
  "Archived after matter closure",
];

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
  const metadata = buildExportReviewMetadata(index);
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
        value: metadata.tags,
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
      doc.name === SUPPLIER_AGREEMENT_DOC_NAME;

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
          ? "In Review"
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
          ? "Two positions outside playbook"
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
      doc.name === AKVIZICE_SPA_DOC_NAME
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

type ExportReviewCitationSeed = {
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
                  blockId: deriveBlockId({
                    paraId: null,
                    index: citationSeed.blockIndex,
                    taken: new Set(),
                  }),
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
    const metadata = buildExportReviewMetadata(i);
    const fileFieldId = seedId<"field">(`${wsLabel}-field-file-${i}`);
    const seeds = buildExportReviewCitationSeeds(metadata);

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

const TASK_CODES = [
  { code: "RESEARCH", label: "Legal research" },
  { code: "REVIEW", label: "Document review" },
  { code: "DRAFT", label: "Drafting" },
  { code: "MEETING", label: "Meeting / conference" },
  { code: "COURT", label: "Court appearance" },
  { code: "FILING", label: "Filing and service" },
  { code: "DISCOVERY", label: "Discovery" },
  { code: "NEGOTIATE", label: "Negotiation" },
  { code: "ADVISE", label: "Advisory" },
  { code: "ADMIN", label: "Administrative" },
] as const;

const ACTIVITY_CODES = [
  { code: "PLAN", label: "Planning and strategy" },
  { code: "COMMUNICATE", label: "Communication" },
  { code: "ANALYZE", label: "Analysis" },
  { code: "MANAGE", label: "Case management" },
  { code: "TRAVEL", label: "Travel" },
  { code: "ATTEND", label: "Attendance" },
  { code: "PREPARE", label: "Preparation" },
  { code: "CORRESPOND", label: "Correspondence" },
] as const;

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
      name: "Default Rate Table",
      currency: "CZK",
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

const EXTENDED_NARRATIVES = [
  "Review of acquisition agreement draft",
  "Client conference call re: deal terms",
  "Legal research on regulatory compliance",
  "Preparation of due diligence checklist",
  "Analysis of opposing party's motion",
  "Drafting response to counterparty",
  "Review of financial disclosure documents",
  "Witness interview preparation",
  "Court filing and service coordination",
  "Negotiation of settlement terms",
  "Review of employment contract amendments",
  "Compliance risk assessment meeting",
  "Cross-border regulatory analysis",
  "GDPR gap analysis and documentation",
  "Internal team strategy discussion",
  "Preparation of expert witness report",
  "Review of corporate restructuring plan",
  "Analysis of environmental permit conditions",
  "Draft shareholder resolution",
  "Anti-money laundering review",
  "Review of merger notification filing",
  "Client update on litigation status",
  "Research on jurisdictional questions",
  "Preparation of closing documents",
  "Review of lease agreement modifications",
  "Correspondence with opposing counsel",
  "Due diligence on target company assets",
  "Review of intellectual property portfolio",
  "Preparation for arbitration hearing",
  "Analysis of insurance coverage terms",
  "Tax advisory on cross-border transaction",
  "Review of non-compete clause enforceability",
  "Preparation of board meeting minutes",
  "Research on data protection regulations",
  "Draft supply contract amendments",
  "Review of regulatory investigation response",
  "Client briefing on new legislation",
  "Analysis of construction contract claims",
  "Preparation of settlement proposal",
  "Review of export control compliance",
];

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

const WS_LABELS = [
  "ws-akvizice-energo",
  "ws-stavebni-spor",
  "ws-due-diligence",
  "ws-pracovni-spory",
  "ws-compliance-ceska-energie",
  "ws-reorganizace",
  "ws-cross-border",
  "ws-gdpr-audit",
  EXPORT_TABLE_MATTER_LABEL,
  HEAVY_MATTER_LABEL,
] as const;

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

    const narrative = at(EXTENDED_NARRATIVES, i % EXTENDED_NARRATIVES.length);
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
      currency: "CZK",
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

const EXPENSE_DESCRIPTIONS = [
  "Court filing fee",
  "Travel to client office",
  "Expert witness consultation fee",
  "Document printing and binding",
  "Courier delivery of signed contracts",
  "Notarization fee",
  "Land registry extract",
  "Process server fee",
  "Conference room rental",
  "Postage for certified mail",
];

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
    const description = at(
      EXPENSE_DESCRIPTIONS,
      i % EXPENSE_DESCRIPTIONS.length,
    );
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
      currency: "CZK",
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

const buildInvoices = (): InvoiceSeed[] => {
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
      id: seedId(`invoice-${i}`),
      workspaceId: ws.id,
      invoiceNumber: `INV-2025-${String(i + 1).padStart(4, "0")}`,
      status: at(invoiceStatuses, i),
      invoiceDate: `2025-0${i + 1}-15`,
      dueDate: `2025-0${i + 2}-15`,
      currency: "CZK",
      totalAmount: 50_000 + i * 25_000,
    });
  }
  return invoiceSeeds;
};

// ─── Additional workspaces for overview stress-testing ──

const MORE_WORKSPACES = [
  // Bratislava Legal Group
  {
    name: "Reštitučné konanie Bratislava",
    reference: "2024/009",
    clientLabel: "contact-org-bratislava-legal",
  },
  {
    name: "Obchodný spor – dodávky",
    reference: "2024/010",
    clientLabel: "contact-org-bratislava-legal",
  },
  {
    name: "Prevod obchodného podielu",
    reference: "2024/011",
    clientLabel: "contact-org-bratislava-legal",
  },
  // Müller & Bergmann
  {
    name: "Kartellrechtliche Prüfung",
    reference: "2024/012",
    clientLabel: "contact-org-muller-bergmann",
  },
  {
    name: "Gesellschafterstreit GmbH",
    reference: "2024/013",
    clientLabel: "contact-org-muller-bergmann",
  },
  {
    name: "Arbeitsrechtliche Restrukturierung",
    reference: "2024/014",
    clientLabel: "contact-org-muller-bergmann",
  },
  {
    name: "Datenschutz-Folgenabschätzung",
    reference: "2024/015",
    clientLabel: "contact-org-muller-bergmann",
  },
  // Thames Advisory
  {
    name: "Shareholder Dispute Resolution",
    reference: "2024/016",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "UK Regulatory Filing",
    reference: "2024/017",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "Post-Acquisition Integration",
    reference: "2024/018",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "Employee Share Scheme",
    reference: "2024/019",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "Anti-Bribery Compliance Review",
    reference: "2024/020",
    clientLabel: "contact-org-thames-advisory",
  },
  // Žilina Steel
  {
    name: "Environmentálne povolenia",
    reference: "2024/021",
    clientLabel: "contact-org-zilina-steel",
  },
  {
    name: "Kolektívna zmluva 2025",
    reference: "2024/022",
    clientLabel: "contact-org-zilina-steel",
  },
  {
    name: "Cezhraničná dodávka ocele",
    reference: "2024/023",
    clientLabel: "contact-org-zilina-steel",
  },
  // PragoBanka
  {
    name: "Syndikovaný úvěr – strukturace",
    reference: "2024/024",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Regulatorní reporting ČNB",
    reference: "2024/025",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "AML vyšetřování",
    reference: "2024/026",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Spotřebitelské úvěry – audit",
    reference: "2024/027",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Bankovní záruky – rámcová smlouva",
    reference: "2024/028",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Digitální transformace – právní rámec",
    reference: "2024/029",
    clientLabel: "contact-org-pragobanka",
  },
  // Dunaj Pharma
  {
    name: "Registrácia liečiv ŠÚKL",
    reference: "2024/030",
    clientLabel: "contact-org-dunaj-pharma",
  },
  {
    name: "Klinické skúšanie – zmluvy",
    reference: "2024/031",
    clientLabel: "contact-org-dunaj-pharma",
  },
  {
    name: "Patentový spor – generikum",
    reference: "2024/032",
    clientLabel: "contact-org-dunaj-pharma",
  },
  {
    name: "Distribučná sieť – regulácia",
    reference: "2024/033",
    clientLabel: "contact-org-dunaj-pharma",
  },
  // Nord Energie
  {
    name: "Windpark Genehmigung Nordsee",
    reference: "2024/034",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "Energieliefervertrag B2B",
    reference: "2024/035",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "Netzanschluss Offshore",
    reference: "2024/036",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "EEG-Umlage Optimierung",
    reference: "2024/037",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "Gasliefervertrag Russland-Exit",
    reference: "2024/038",
    clientLabel: "contact-org-nord-energie",
  },
  // Ostrava Mining
  {
    name: "Těžební licence – prodloužení",
    reference: "2024/039",
    clientLabel: "contact-org-ostrava-mining",
  },
  {
    name: "Rekultivace území Karviná",
    reference: "2024/040",
    clientLabel: "contact-org-ostrava-mining",
  },
  {
    name: "Pracovní úrazy – hromadná žaloba",
    reference: "2024/041",
    clientLabel: "contact-org-ostrava-mining",
  },
  {
    name: "Emise CO₂ – povolenky EU ETS",
    reference: "2024/042",
    clientLabel: "contact-org-ostrava-mining",
  },
  // Crown Shipping
  {
    name: "Charter Party Dispute",
    reference: "2024/043",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Marine Insurance Claim",
    reference: "2024/044",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Port Authority Compliance",
    reference: "2024/045",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Sanctions Screening Programme",
    reference: "2024/046",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Bill of Lading Fraud Investigation",
    reference: "2024/047",
    clientLabel: "contact-org-crown-shipping",
  },
  // Tatra Motors
  {
    name: "Homologace vozidla EU",
    reference: "2024/048",
    clientLabel: "contact-org-tatra-motors",
  },
  {
    name: "Záruční spor – flotila",
    reference: "2024/049",
    clientLabel: "contact-org-tatra-motors",
  },
  {
    name: "Dodavatelský řetězec – audit",
    reference: "2024/050",
    clientLabel: "contact-org-tatra-motors",
  },
  {
    name: "Ochranná známka TATRA",
    reference: "2024/051",
    clientLabel: "contact-org-tatra-motors",
  },
  // Košice Tech Ventures
  {
    name: "Seed investment – term sheet",
    reference: "2024/052",
    clientLabel: "contact-org-kosice-tech",
  },
  {
    name: "IP licenčná zmluva",
    reference: "2024/053",
    clientLabel: "contact-org-kosice-tech",
  },
  {
    name: "ESOP program pre zamestnancov",
    reference: "2024/054",
    clientLabel: "contact-org-kosice-tech",
  },
  // Extra matters for existing clients (deeper grouping)
  {
    name: "Daňová optimalizace holdingu",
    reference: "2024/055",
    clientLabel: "contact-org-novak-partners",
  },
  {
    name: "Obchodní registr – změny",
    reference: "2024/056",
    clientLabel: "contact-org-ceska-energie",
  },
  {
    name: "Stavební povolení Brno-jih",
    reference: "2024/057",
    clientLabel: "contact-org-moravska-stavebni",
  },
  {
    name: "Fund IV Structuring",
    reference: "2024/058",
    clientLabel: "contact-org-greenleaf",
  },
];

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
  await rootDb
    .delete(playbookDefinitions)
    .where(eq(playbookDefinitions.id, definitionId));
  await rootDb
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
    .onConflictDoNothing();
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
  await rootDb
    .delete(playbookDefinitions)
    .where(eq(playbookDefinitions.id, definitionId));

  await rootDb
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
              },
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
    .onConflictDoNothing();

  await seedDdGeneralPlaybook(organizationId);

  console.log("  Playbooks: 2");
};

// ─── Main ───────────────────────────────────────────────

export async function seed(organizationId?: string, userId?: string) {
  const ORG_ID = toSafeId<"organization">(organizationId ?? DEFAULT_ORG_ID);
  const USER_ID = userId ?? DEFAULT_USER_ID;
  const toWs = (id: WorkspaceId) => id;
  const seedUserIds = buildSeedUserIds({
    primaryUserId: USER_ID,
    colleagueCount: DEFAULT_SEED_COLLEAGUE_COUNT,
  });
  const seedUserRates = buildSeedUserRates(seedUserIds);

  const ensureSeedUsers = async () => {
    if (ORG_ID === DEFAULT_ORG_ID && USER_ID === DEFAULT_USER_ID) {
      await ensureTestUsers(ORG_ID);
      return;
    }
    await ensurePrimarySeedUserInOrganization({
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    await ensureSeedColleaguesInOrganization({
      organizationId: ORG_ID,
      colleagueCount: DEFAULT_SEED_COLLEAGUE_COUNT,
    });
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
    if (allSeedWorkspaceIds.length > 0) {
      await rootDb
        .delete(chatMessages)
        .where(sql`${chatMessages.workspaceId} IN ${allSeedWorkspaceIds}`);
      await rootDb
        .delete(chatThreads)
        .where(sql`${chatThreads.workspaceId} IN ${allSeedWorkspaceIds}`);
      // property_dependencies.depends_on_property_id uses ON DELETE RESTRICT,
      // so dependencies must be removed before the workspace cascade.
      await rootDb
        .delete(propertyDependencies)
        .where(
          sql`${propertyDependencies.workspaceId} IN ${allSeedWorkspaceIds}`,
        );
      await rootDb
        .delete(workspaces)
        .where(sql`${workspaces.id} IN ${allSeedWorkspaceIds}`);
    }
    if (allSeedContactIds.length === 0) {
      return;
    }
    // Include manually created workspaces that reference seed contacts, not
    // only workspaces whose IDs came from this script.
    const clientWorkspaces = await rootDb.query.workspaces.findMany({
      where: { clientId: { in: allSeedContactIds } },
      columns: { id: true },
    });
    const clientWorkspaceIds = clientWorkspaces.map(
      (workspace) => workspace.id,
    );
    if (clientWorkspaceIds.length > 0) {
      // These relations use ON DELETE RESTRICT and can belong to manually
      // created workspaces that reference deterministic seed contacts.
      await rootDb
        .delete(chatMessages)
        .where(sql`${chatMessages.workspaceId} IN ${clientWorkspaceIds}`);
      await rootDb
        .delete(chatThreads)
        .where(sql`${chatThreads.workspaceId} IN ${clientWorkspaceIds}`);
      await rootDb
        .delete(propertyDependencies)
        .where(
          sql`${propertyDependencies.workspaceId} IN ${clientWorkspaceIds}`,
        );
    }
    await rootDb
      .delete(workspaces)
      .where(sql`${workspaces.clientId} IN ${allSeedContactIds}`);
    await rootDb
      .delete(contacts)
      .where(sql`${contacts.id} IN ${allSeedContactIds}`);
  };

  if (process.env.NODE_ENV === "production") {
    panic("Refusing to run in production.");
  }

  // Ensure referenced users exist in the target org before seeding matters,
  // billing, and analytics data; then clear deterministic IDs for replay.
  await ensureSeedUsers();
  await clearSeedData();

  console.log("Seeding development data...\n");

  const seedContacts = async () => {
    // 1. Contacts (original orgs + people)
    const coreContacts = [...orgContacts, ...personContacts];
    for (const c of coreContacts) {
      // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order
      await rootDb
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
          billingAddress: "billingAddress" in c ? c.billingAddress : undefined,
          defaultHourlyRate:
            "defaultHourlyRate" in c ? cents(c.defaultHourlyRate) : undefined,
          currency: "currency" in c ? c.currency : undefined,
          paymentTermDays:
            "paymentTermDays" in c ? c.paymentTermDays : undefined,
          originatingAttorneyId: USER_ID,
          responsibleAttorneyId: USER_ID,
          createdBy: USER_ID,
        })
        .onConflictDoNothing();
    }
    // 1b. Additional org contacts for overview stress-testing
    for (const c of moreOrgContacts) {
      // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order
      await rootDb
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
          originatingAttorneyId: USER_ID,
          responsibleAttorneyId: USER_ID,
          createdBy: USER_ID,
        })
        .onConflictDoNothing();
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
  await rootDb
    .insert(organizationSettings)
    .values({
      id: seedId("org-settings"),
      organizationId: ORG_ID,
      practiceJurisdictions,
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { practiceJurisdictions },
    });
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
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
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
      });
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
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
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
      });

    moreWsCount++;
  }
  console.log(
    `  Workspaces: ${seedWorkspaces.length} + ${moreWsCount} extra = ${seedWorkspaces.length + moreWsCount}`,
  );

  const marketingAgentWorkspace = at(seedWorkspaces, 8);
  const marketingAgentThreadId = seedId("marketing-agent-thread");
  const marketingAgentCreatedAt = new Date("2026-07-16T09:30:00.000Z");
  await rootDb.insert(chatThreads).values({
    id: marketingAgentThreadId,
    organizationId: ORG_ID,
    userId: USER_ID,
    workspaceId: marketingAgentWorkspace.id,
    title: MARKETING_AGENT_THREAD_TITLE,
    createdAt: marketingAgentCreatedAt,
    updatedAt: marketingAgentCreatedAt,
  });
  await rootDb.insert(chatMessages).values([
    {
      id: seedId("marketing-agent-message-user"),
      threadId: marketingAgentThreadId,
      workspaceId: marketingAgentWorkspace.id,
      userId: USER_ID,
      role: "user",
      content: {
        version: 1,
        data: [
          {
            type: "text",
            text: "Compare the change-of-control clauses across this matter.",
          },
        ],
      },
      createdAt: marketingAgentCreatedAt,
    },
    {
      id: seedId("marketing-agent-message-assistant"),
      threadId: marketingAgentThreadId,
      workspaceId: marketingAgentWorkspace.id,
      userId: USER_ID,
      role: "assistant",
      content: {
        version: 1,
        data: [
          {
            type: "text",
            text: "Across the cited agreements, assignment or a material service change requires written notice. The higher-risk agreements also require consent or termination review before signing.",
          },
          {
            type: "data-stella-source-document",
            data: {
              entityId: seedId(`${EXPORT_TABLE_MATTER_LABEL}-doc-1`),
              kind: "document",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              title: at(EXPORT_REVIEW_DOC_NAMES, 0),
              workspaceId: marketingAgentWorkspace.id,
            },
          },
          {
            type: "data-stella-source-document",
            data: {
              entityId: seedId(`${EXPORT_TABLE_MATTER_LABEL}-doc-5`),
              kind: "document",
              mimeType: "application/pdf",
              title: at(EXPORT_REVIEW_DOC_NAMES, 4),
              workspaceId: marketingAgentWorkspace.id,
            },
          },
          {
            type: "data-stella-source-document",
            data: {
              entityId: seedId(`${EXPORT_TABLE_MATTER_LABEL}-doc-9`),
              kind: "document",
              mimeType: "application/pdf",
              title: at(EXPORT_REVIEW_DOC_NAMES, 8),
              workspaceId: marketingAgentWorkspace.id,
            },
          },
        ],
      },
      createdAt: new Date(marketingAgentCreatedAt.getTime() + 2500),
    },
  ]);
  console.log("  Marketing agent story: 1 thread, 2 messages");

  // 2c. Workspace members — add all seed users to every workspace
  const allWsIds = [
    ...seedWorkspaces.map((ws) => ws.id),
    ...MORE_WORKSPACES.map((mw) => seedId(`extra-ws-${mw.reference}`)),
  ];
  for (const wsId of allWsIds) {
    for (const uid of seedUserIds) {
      // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
      await rootDb
        .insert(workspaceMembers)
        .values({
          id: seedId(`wm-${wsId}-${uid}`),
          workspaceId: toWs(wsId),
          userId: uid,
        })
        .onConflictDoNothing();
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
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
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
      .onConflictDoNothing();
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
      await rootDb
        .select({ workspaceId: workspaceViews.workspaceId })
        .from(workspaceViews)
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
    await rootDb.insert(workspaceViews).values(viewRows);
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
  const entityIndexByWorkspace = new Map<WorkspaceId, number>();
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
    // oxlint-disable-next-line no-await-in-loop -- entity row must exist before its version + currentVersion link below
    await rootDb
      .insert(entities)
      .values({
        id: e.entityId,
        workspaceId: toWs(e.workspaceId),
        kind: e.kind,
        parentId: e.parentId,
        name: e.name,
        createdBy: pickAuthor(seedUserIds, ei),
        lastEditedBy: pickAuthor(seedUserIds, ei + 1),
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          name: e.name,
          parentId: e.parentId ?? null,
          createdAt,
          updatedAt,
        },
      });

    // oxlint-disable-next-line no-await-in-loop -- version row depends on the entity inserted just above
    await rootDb
      .insert(entityVersions)
      .values({
        id: e.versionId,
        workspaceId: toWs(e.workspaceId),
        entityId: e.entityId,
      })
      .onConflictDoNothing();

    // Link currentVersionId
    // oxlint-disable-next-line no-await-in-loop -- links the entity row to the version inserted in this same iteration
    await rootDb
      .update(entities)
      .set({ currentVersionId: e.versionId })
      // oxlint-disable-next-line no-await-in-loop -- dynamic import of drizzle-orm eq() inside the where clause
      .where((await import("drizzle-orm")).eq(entities.id, e.entityId));
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
        name !== SUPPLIER_AGREEMENT_DOC_NAME && !seedEmailFileNames.has(name),
    );

  /** Seed all document content for a single workspace. */
  const seedDocumentsForWorkspace = async (
    wsId: WorkspaceId,
    wsLabel: string,
    docNames: string[],
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
        if (fileName === SUPPLIER_AGREEMENT_DOC_NAME) {
          return await createSupplierAgreementDocx();
        }
        switch (format.type) {
          case "docx":
            return await createMockDocx(title, configuredDocText);
          case "email":
            return createSeedEmail(format.fileName);
          case "pdf":
            return createMockPdf(title, configuredDocText);
          default: {
            format satisfies never;
            return panic(`Unsupported seed file format for ${fileName}`);
          }
        }
      };
      // oxlint-disable-next-line no-await-in-loop -- bounded memory: build one document's bytes at a time
      const content = await buildContent();
      const docText =
        format.type === "email"
          ? parsedEmailToText(
              // oxlint-disable-next-line no-await-in-loop -- parse this bounded fixture before inserting its extraction row
              await parseEmail(Uint8Array.from(content).buffer, EML_MIME_TYPE),
            )
          : configuredDocText;

      const sha256Hex = new Bun.CryptoHasher("sha256")
        .update(content)
        .digest("hex");

      const fileId = seedId(`${wsLabel}-file-${j}`);
      const s3Key = `${ORG_ID}/${wsId}/${fileId}.${format.extension}`;
      // oxlint-disable-next-line no-await-in-loop -- bounded memory: upload one document's bytes to S3 at a time
      await writeS3ObjectWithRetry({
        data: new Uint8Array(content),
        key: s3Key,
      });

      // DOCX files are rendered natively via Folio — no PDF twin needed.
      // Non-DOCX convertible types still get a PDF twin from Gotenberg.
      const pdfFileId: UserFileId | null = null;
      const fileContent = {
        version: 1,
        type: "file",
        id: fileId,
        fileName,
        mimeType: format.mimeType,
        sizeBytes: content.length,
        encrypted: false,
        sha256Hex,
        pdfFileId,
      } as const satisfies FieldContent;

      // ── File field ──
      // oxlint-disable-next-line no-await-in-loop -- references the fileId/sha256 produced by the S3 write above
      await rootDb
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
        });
      fileCount++;

      // ── Extracted content (AI reads this) ──
      // Resolve the org from the workspace row so this
      // matches the org the user's session will filter by
      // (workspaces may belong to an org created before
      // the seed ran, e.g. via manual signup).
      if (docText) {
        // oxlint-disable-next-line no-await-in-loop -- per-document org lookup feeds the extracted-content insert that follows
        const ws = await rootDb.query.workspaces.findFirst({
          where: { id: { eq: toWs(wsId) } },
          columns: { organizationId: true },
        });
        const ecOrgId = ws?.organizationId ?? ORG_ID;
        const extractionEnvelope = {
          ciphertext: Buffer.from(docText, "utf-8"),
          iv: Buffer.alloc(IV_BYTES),
        };

        // oxlint-disable-next-line no-await-in-loop -- depends on the org resolved from the workspace query above
        await rootDb
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
          });
        extractedCount++;
      }
    }
  };

  // Resolve doc names for each workspace
  type WsDocPlan = {
    wsId: WorkspaceId;
    wsLabel: string;
    docNames: string[];
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

  for (const plan of docPlans) {
    // oxlint-disable-next-line no-await-in-loop -- bounded memory and S3 throughput: process one workspace's documents at a time
    await seedDocumentsForWorkspace(plan.wsId, plan.wsLabel, plan.docNames);
  }

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
  for (const f of allFields) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
      .insert(fields)
      .values({
        id: f.id,
        workspaceId: toWs(f.workspaceId),
        propertyId: f.propertyId,
        entityVersionId: f.entityVersionId,
        content: f.content,
      })
      .onConflictDoNothing();
  }
  console.log(`  Fields: ${allFields.length}`);

  const allJustifications: JustificationSeed[] = [];
  for (const plan of docPlans) {
    const wsEntities = allEntities.filter((e) => e.workspaceId === plan.wsId);
    allJustifications.push(
      ...buildExportReviewJustifications(plan.wsId, plan.wsLabel, wsEntities),
    );
  }
  for (const justification of allJustifications) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
      .insert(justifications)
      .values({
        id: justification.id,
        workspaceId: toWs(justification.workspaceId),
        fieldId: justification.fieldId,
        content: justification.content,
        fileFieldIds: justification.fileFieldIds,
      })
      .onConflictDoNothing();
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
  await rootDb.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
  await rootDb.execute(sql`
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
  await rootDb.execute(sql`
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
  await rootDb.execute(sql`
    ALTER TABLE search_documents
      ADD COLUMN IF NOT EXISTS tsv tsvector
  `);
  await rootDb.execute(sql`
    CREATE INDEX IF NOT EXISTS search_documents_tsv_idx
      ON search_documents USING gin (tsv)
  `);

  // 7c. Search index (depends on fields + extracted content)
  let searchCount = 0;
  for (const e of allEntities) {
    // oxlint-disable-next-line no-await-in-loop -- sequential indexing keeps memory bounded and avoids overwhelming the DB
    await upsertSearchDocument(e.entityId);
    searchCount++;
  }
  console.log(`  Search index: ${searchCount} documents`);

  // 8. Workspace contacts (parties)
  for (const party of seedParties) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
      .insert(workspaceContacts)
      .values({
        id: party.id,
        organizationId: ORG_ID,
        workspaceId: toWs(party.workspaceId),
        contactId: party.contactId,
        role: party.role,
      })
      .onConflictDoNothing();
  }
  console.log(`  Parties: ${seedParties.length}`);

  // 9. Billing codes
  const billingCodeSeeds = buildBillingCodes();
  for (const bc of billingCodeSeeds) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order
    await rootDb
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
      .onConflictDoNothing();
  }
  console.log(`  Billing codes: ${billingCodeSeeds.length}`);

  // 10. Rate tables + entries
  const { tables: rateTableSeeds, entries: rateEntrySeeds } = buildRateTables({
    userIds: seedUserIds,
    userRates: seedUserRates,
  });
  for (const rt of rateTableSeeds) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order / FK dependencies
    await rootDb
      .insert(rateTables)
      .values({
        id: rt.id,
        organizationId: ORG_ID,
        workspaceId: toWs(rt.workspaceId),
        name: rt.name,
        currency: rt.currency,
        isDefault: true,
      })
      .onConflictDoNothing();
  }
  for (const re of rateEntrySeeds) {
    // oxlint-disable-next-line no-await-in-loop -- rate entries depend on rate tables seeded above; sequential preserves FK dependencies
    await rootDb
      .insert(rateEntries)
      .values({
        id: re.id,
        workspaceId: toWs(re.workspaceId),
        rateTableId: re.rateTableId,
        userId: re.userId,
        hourlyRate: cents(re.hourlyRate),
        effectiveFrom: re.effectiveFrom,
      })
      .onConflictDoNothing();
  }
  console.log(
    `  Rate tables: ${rateTableSeeds.length}, entries: ${rateEntrySeeds.length}`,
  );

  // 11. Invoices (must be inserted before time entries
  // that reference them)
  const invoiceSeeds = buildInvoices();
  for (const inv of invoiceSeeds) {
    // oxlint-disable-next-line no-await-in-loop -- invoices must be inserted before time entries that reference them
    await rootDb
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
      .onConflictDoNothing();
  }
  console.log(`  Invoices: ${invoiceSeeds.length}`);

  // 12. Extended time entries (~500)
  const invoiceIds = invoiceSeeds.map((inv) => inv.id);
  const extTimeEntries = buildExtendedTimeEntries(
    invoiceIds,
    seedUserIds,
    seedUserRates,
  );
  for (const te of extTimeEntries) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order
    await rootDb
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
      .onConflictDoNothing();
  }
  console.log(`  Time entries: ${extTimeEntries.length}`);

  // 13. Expenses (~50)
  const expenseSeeds = buildExpenses(seedUserIds);
  for (const exp of expenseSeeds) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves insert order
    await rootDb
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
      .onConflictDoNothing();
  }
  console.log(`  Expenses: ${expenseSeeds.length}`);

  // 14. Templates & clauses (knowledge base)
  await seedTemplates(ORG_ID, seedUserIds);

  // 15. Playbooks (knowledge base) + the org document-type taxonomy the
  // type-scoped playbook references. ensureDefaultDocumentTypes is intentionally
  // non-overwriting (onConflictDoNothing), so reruns must first drop the org's
  // default-keyed taxonomy rows to pick up label changes. Custom, non-default
  // document types (keys outside DEFAULT_DOCUMENT_TYPES) are left untouched.
  await rootDb.delete(documentTypes).where(
    and(
      eq(documentTypes.organizationId, ORG_ID),
      inArray(
        documentTypes.key,
        DEFAULT_DOCUMENT_TYPES.map((documentType) => documentType.key),
      ),
    ),
  );
  await ensureDefaultDocumentTypes(ORG_ID, rootDb);
  await seedPlaybooks(ORG_ID);

  // 16. Global case-law corpus for search and references. This pulls real prod
  // fixtures and is the most schema-coupled step; a local schema drift here
  // (e.g. a worktree whose migrations lag the shared dev DB) must not abort the
  // whole seed or dump a giant error toast — warn and continue.
  try {
    await seedCaseLaw();
  } catch (error) {
    console.warn(
      "  Case-law seed skipped (non-fatal — likely local schema drift):",
      error instanceof Error ? error.message : error,
    );
  }

  console.log("\nDone. Dev data seeded successfully.");
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

    const activeSessions = await rootDb
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
      .limit(1);

    const activeSession = activeSessions.at(0);
    if (activeSession?.organizationId) {
      return {
        organizationId: activeSession.organizationId,
        userId: activeSession.userId,
        label: `${activeSession.userEmail} / ${activeSession.organizationName}`,
      };
    }

    const firstMember = await rootDb.query.member.findFirst({
      columns: { userId: true, organizationId: true },
      where: { role: "owner" },
      orderBy: { createdAt: "desc" },
    });
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
      cmd: [process.execPath, import.meta.path],
      env: {
        ...process.env,
        STELLA_SEED_ID_NAMESPACE: `org:${target.organizationId}`,
        STELLA_SEED_ORG_ID: target.organizationId,
        STELLA_SEED_USER_ID: target.userId,
      },
      stderr: "inherit",
      stdout: "inherit",
    });
    process.exit(await child.exited);
  }

  console.log(
    `Seeding into org ${target.organizationId} for user ${target.userId} (${target.label})`,
  );

  seed(target.organizationId, target.userId)
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
