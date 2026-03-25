/**
 * Seed templates & clauses (Knowledge section).
 *
 * Creates clause categories (5), clauses (25) with variants (6),
 * template categories (4), templates (8 DOCX files with manifests),
 * and template-clause links (9).
 *
 * Deterministic IDs via `seedId()` so re-running is idempotent
 * (uses `onConflictDoNothing()`).
 *
 * Usage:
 *   bun apps/api/scripts/seed-templates.ts        # standalone
 *   Called from seed-dev.ts as section 14          # full seed
 *
 * Prerequisites:
 *   - Database running (bun run docker:dev)
 *   - Test user seeded (bun run db:seed-test-user)
 */

import JSZip from "jszip";

import { db } from "@/api/db";
import {
  clauseCategories,
  clauses,
  clauseVariants,
  clauseVersions,
  templateCategories,
  templateClauses,
  templates,
  templateVersions,
} from "@/api/db/schema";
import type { ClauseBody, ClauseParagraph } from "@/api/handlers/clauses/types";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type {
  FieldMeta,
  NamedCondition,
  TemplateManifest,
} from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";

import { ensureTestUsers } from "./seed-test-user";
import { DEFAULT_ORG_ID, pickAuthor, seedId } from "./seed-utils";

// ─── Clause body helpers ────────────────────────────────

/** Plain paragraph. */
const p = (text: string, opts?: Partial<ClauseParagraph>): ClauseParagraph => ({
  text,
  ...opts,
});

/** Paragraph with a bold defined term inline. */
const boldTerm = (
  before: string,
  term: string,
  after: string,
): ClauseParagraph => ({
  text: `${before}${term}${after}`,
  runs: [
    ...(before ? [{ text: before }] : []),
    { text: term, bold: true },
    ...(after ? [{ text: after }] : []),
  ],
});

// ─── OOXML helpers for DOCX body ────────────────────────

const xmlP = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;

const xmlHeading = (text: string, level: number): string => {
  const style = level === 1 ? "Heading1" : `Heading${level}`;
  return (
    `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>` +
    `<w:r><w:t>${escXml(text)}</w:t></w:r></w:p>`
  );
};

const xmlBoldP = (text: string): string =>
  "<w:p><w:r><w:rPr><w:b/></w:rPr>" +
  `<w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;

const escXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ─── DOCX generator ────────────────────────────────────

const createTemplateDocx = async (
  title: string,
  bodyXml: string,
): Promise<Buffer> => {
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

  zip
    .folder("word")
    ?.file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${escXml(title)}</w:t></w:r></w:p>${bodyXml}</w:body></w:document>`,
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
  return Buffer.from(buf);
};

// ═══════════════════════════════════════════════════════════
// CLAUSE CATEGORIES (5)
// ═══════════════════════════════════════════════════════════

const CLAUSE_CATS = [
  {
    label: "clause-cat-general",
    name: "General Provisions",
    description:
      "Boilerplate: entire agreement, severability, " +
      "amendments, notices, counterparts.",
    sortOrder: 0,
  },
  {
    label: "clause-cat-liability",
    name: "Liability & Risk",
    description:
      "Indemnification, limitation of liability, " +
      "force majeure, insurance, warranty.",
    sortOrder: 1,
  },
  {
    label: "clause-cat-confidentiality",
    name: "Confidentiality & IP",
    description:
      "NDA, intellectual property, non-compete, " +
      "non-solicitation, data processing.",
    sortOrder: 2,
  },
  {
    label: "clause-cat-governance",
    name: "Governance",
    description:
      "Governing law, dispute resolution, assignment, " +
      "waiver, termination.",
    sortOrder: 3,
  },
  {
    label: "clause-cat-compliance",
    name: "Data & Compliance",
    description:
      "Data protection, anti-bribery, export control, " +
      "modern slavery, regulatory.",
    sortOrder: 4,
  },
] as const;

// ═══════════════════════════════════════════════════════════
// CLAUSES (25) grouped by category
// ═══════════════════════════════════════════════════════════

type ClauseSeed = {
  label: string;
  catLabel: string;
  title: string;
  description: string;
  usageNotes: string;
  body: ClauseBody;
  variants?: { label: string; body: ClauseBody }[];
};

const CLAUSES: ClauseSeed[] = [
  // ── General Provisions (5) ───────────────────────────
  {
    label: "clause-entire-agreement",
    catLabel: "clause-cat-general",
    title: "Entire Agreement",
    description:
      "Supersedes all prior negotiations, representations, " +
      "and agreements between the parties.",
    usageNotes:
      "Place at the end of the agreement, before the " +
      "signature block. Check for carve-outs if side " +
      "letters exist.",
    body: [
      boldTerm(
        "This Agreement (including all schedules and " +
          "exhibits attached hereto) constitutes the ",
        "Entire Agreement",
        " between the Parties with respect to the subject matter hereof.",
      ),
      p(
        "It supersedes all prior negotiations, " +
          "representations, warranties, commitments, " +
          "offers, and undertakings, whether written or " +
          "oral, relating to such subject matter.",
      ),
      p(
        "Each Party acknowledges that in entering into " +
          "this Agreement it does not rely on any " +
          "statement, representation, assurance, or " +
          "warranty of any person other than as expressly " +
          "set out in this Agreement.",
      ),
    ],
  },
  {
    label: "clause-severability",
    catLabel: "clause-cat-general",
    title: "Severability",
    description:
      "Preserves the remainder of the agreement if any " +
      "provision is held invalid or unenforceable.",
    usageNotes: "Standard boilerplate. Rarely needs customization.",
    body: [
      p(
        "If any provision of this Agreement is held by " +
          "a court of competent jurisdiction to be invalid, " +
          "illegal, or unenforceable, the validity, " +
          "legality, and enforceability of the remaining " +
          "provisions shall not in any way be affected or " +
          "impaired thereby.",
      ),
      p(
        "The Parties shall negotiate in good faith to " +
          "replace any invalid or unenforceable provision " +
          "with a valid and enforceable provision that " +
          "achieves, to the greatest extent possible, the " +
          "economic, business, and other purposes of the " +
          "invalid or unenforceable provision.",
      ),
    ],
  },
  {
    label: "clause-amendments",
    catLabel: "clause-cat-general",
    title: "Amendments",
    description:
      "Requires written consent of all parties to modify the agreement.",
    usageNotes:
      "Consider whether board approval or third-party " +
      "consent is needed for material amendments.",
    body: [
      p(
        "No amendment, modification, or waiver of any " +
          "provision of this Agreement shall be effective " +
          "unless set forth in a written instrument signed " +
          "by each of the Parties.",
      ),
      p(
        "No failure or delay by any Party in exercising " +
          "any right or remedy under this Agreement shall " +
          "operate as a waiver thereof, nor shall any " +
          "single or partial exercise preclude any further " +
          "exercise of any right or remedy.",
      ),
    ],
  },
  {
    label: "clause-notices",
    catLabel: "clause-cat-general",
    title: "Notices",
    description:
      "Specifies how formal communications must be " +
      "delivered to be effective.",
    usageNotes:
      "Update addresses in the schedule. Consider adding " +
      "email as a permitted delivery method for routine " +
      "communications.",
    body: [
      p(
        "Any notice, demand, or other communication " +
          "required or permitted under this Agreement " +
          "shall be in writing and shall be deemed to " +
          "have been duly given when: (a) delivered by " +
          "hand; (b) sent by registered or certified " +
          "mail, return receipt requested; or (c) sent " +
          "by nationally recognized overnight courier.",
      ),
      p(
        "Notices shall be addressed to the Parties at " +
          "the addresses set forth in Schedule 1, or to " +
          "such other address as a Party may designate " +
          "by written notice to the other Parties.",
      ),
    ],
  },
  {
    label: "clause-counterparts",
    catLabel: "clause-cat-general",
    title: "Counterparts",
    description:
      "Permits execution in multiple counterparts, " +
      "including electronic signatures.",
    usageNotes:
      "Check local law on electronic signature " +
      "validity. eIDAS applies in EU jurisdictions.",
    body: [
      p(
        "This Agreement may be executed in any number " +
          "of counterparts, each of which when executed " +
          "and delivered shall constitute a duplicate " +
          "original, but all counterparts together shall " +
          "constitute a single agreement.",
      ),
      p(
        "Delivery of an executed counterpart by email " +
          "(in PDF format) or other electronic means " +
          "shall be effective as delivery of a manually " +
          "executed counterpart.",
      ),
    ],
  },

  // ── Liability & Risk (5) ─────────────────────────────
  {
    label: "clause-indemnification",
    catLabel: "clause-cat-liability",
    title: "Indemnification",
    description:
      "Mutual indemnification for losses arising from " +
      "breach of representations, warranties, or " +
      "obligations under the agreement.",
    usageNotes:
      "Choose the appropriate variant: mutual (default), " +
      "one-way provider, or one-way client. Adjust cap " +
      "amounts and carve-outs as needed.",
    body: [
      boldTerm(
        "Each Party (the ",
        "Indemnifying Party",
        ") shall indemnify and hold harmless the other " +
          "Party (the Indemnified Party) from and against " +
          "any and all losses, damages, liabilities, " +
          "costs, and expenses (including reasonable " +
          "legal fees) arising out of or resulting from:",
      ),
      p(
        "(a) any breach of any representation or " +
          "warranty made by the Indemnifying Party in " +
          "this Agreement;",
        { level: 1 },
      ),
      p(
        "(b) any breach of any obligation or covenant " +
          "of the Indemnifying Party under this Agreement; " +
          "or",
        { level: 1 },
      ),
      p(
        "(c) any negligent or wrongful act or omission " +
          "of the Indemnifying Party in connection with " +
          "the performance of this Agreement.",
        { level: 1 },
      ),
      p(
        "The aggregate liability of either Party under " +
          "this clause shall not exceed the total fees " +
          "paid or payable under this Agreement in the " +
          "twelve (12) months preceding the claim.",
      ),
    ],
    variants: [
      {
        label: "One-Way (Provider)",
        body: [
          boldTerm(
            "The ",
            "Provider",
            " shall indemnify and hold harmless the " +
              "Client from and against any and all " +
              "losses, damages, liabilities, costs, and " +
              "expenses (including reasonable legal fees) " +
              "arising out of or resulting from:",
          ),
          p(
            "(a) any breach of any representation or " +
              "warranty made by the Provider in this " +
              "Agreement;",
            { level: 1 },
          ),
          p(
            "(b) any negligent or wrongful act or " +
              "omission of the Provider or its personnel " +
              "in connection with the Services; or",
            { level: 1 },
          ),
          p(
            "(c) any infringement of third-party " +
              "intellectual property rights by the " +
              "deliverables provided under this Agreement.",
            { level: 1 },
          ),
          p(
            "The aggregate liability of the Provider " +
              "under this clause shall not exceed the " +
              "total fees paid or payable under this " +
              "Agreement in the twelve (12) months " +
              "preceding the claim.",
          ),
        ],
      },
      {
        label: "One-Way (Client)",
        body: [
          boldTerm(
            "The ",
            "Client",
            " shall indemnify and hold harmless the " +
              "Provider from and against any and all " +
              "losses, damages, liabilities, costs, and " +
              "expenses (including reasonable legal fees) " +
              "arising out of or resulting from:",
          ),
          p(
            "(a) any breach of any representation or " +
              "warranty made by the Client in this " +
              "Agreement;",
            { level: 1 },
          ),
          p(
            "(b) any inaccuracy in the data, materials, " +
              "or instructions provided by the Client " +
              "to the Provider; or",
            { level: 1 },
          ),
          p(
            "(c) any use of the deliverables by the " +
              "Client in a manner not authorized under " +
              "this Agreement.",
            { level: 1 },
          ),
        ],
      },
    ],
  },
  {
    label: "clause-limitation-of-liability",
    catLabel: "clause-cat-liability",
    title: "Limitation of Liability",
    description: "Caps and excludes certain categories of damages.",
    usageNotes:
      "Verify enforceability in the governing " +
      "jurisdiction. Some jurisdictions prohibit " +
      "excluding liability for fraud or personal injury.",
    body: [
      boldTerm(
        "Except in respect of ",
        "Excluded Claims",
        " (as defined below), neither Party shall be " +
          "liable to the other for any indirect, " +
          "incidental, special, consequential, or " +
          "punitive damages, including loss of profits, " +
          "revenue, data, or business opportunity.",
      ),
      p(
        "The total aggregate liability of either Party " +
          "under or in connection with this Agreement, " +
          "whether in contract, tort (including " +
          "negligence), or otherwise, shall not exceed " +
          "the greater of: (a) the total fees paid or " +
          "payable under this Agreement during the " +
          "twelve (12) months preceding the event giving " +
          "rise to the claim; or (b) the amount specified " +
          "in Schedule 2.",
      ),
      p(
        "Excluded Claims means: (i) liability for death " +
          "or personal injury caused by negligence; " +
          "(ii) liability for fraud or fraudulent " +
          "misrepresentation; and (iii) indemnification " +
          "obligations under this Agreement.",
      ),
    ],
  },
  {
    label: "clause-force-majeure",
    catLabel: "clause-cat-liability",
    title: "Force Majeure",
    description:
      "Excuses non-performance caused by events beyond " +
      "reasonable control.",
    usageNotes:
      "Consider whether pandemic and government " +
      "lockdown orders should be explicitly listed. " +
      "Specify the termination right if the force " +
      "majeure event continues beyond a threshold " +
      "period.",
    body: [
      boldTerm(
        "Neither Party shall be liable for any failure " +
          "or delay in performing its obligations under " +
          "this Agreement to the extent that such failure " +
          "or delay results from a ",
        "Force Majeure Event",
        ".",
      ),
      p(
        "Force Majeure Event means any event beyond the " +
          "reasonable control of the affected Party, " +
          "including: acts of God, flood, earthquake, " +
          "epidemic, pandemic, war, terrorism, riot, " +
          "fire, explosion, embargo, labour disputes, " +
          "government orders, or failure of public " +
          "utilities or telecommunications.",
      ),
      p(
        "The affected Party shall: (a) promptly notify " +
          "the other Party in writing of the Force " +
          "Majeure Event and its expected duration; and " +
          "(b) use reasonable efforts to mitigate the " +
          "effect of the Force Majeure Event.",
      ),
      p(
        "If the Force Majeure Event continues for a " +
          "period exceeding ninety (90) days, either " +
          "Party may terminate this Agreement by giving " +
          "thirty (30) days' written notice to the other " +
          "Party.",
      ),
    ],
  },
  {
    label: "clause-warranty",
    catLabel: "clause-cat-liability",
    title: "Warranty",
    description:
      "Representations and warranties regarding " +
      "authority, compliance, and quality of deliverables.",
    usageNotes:
      "Tailor warranty scope to the subject matter. " +
      "For services, add a fitness-for-purpose warranty " +
      "if applicable.",
    body: [
      p("Each Party represents and warrants that:"),
      p(
        "(a) it has full power and authority to enter " +
          "into and perform its obligations under this " +
          "Agreement;",
        { level: 1 },
      ),
      p(
        "(b) the execution and performance of this " +
          "Agreement will not conflict with any other " +
          "agreement or obligation to which it is bound; " +
          "and",
        { level: 1 },
      ),
      p(
        "(c) it shall comply with all applicable laws, " +
          "regulations, and industry standards in the " +
          "performance of its obligations under this " +
          "Agreement.",
        { level: 1 },
      ),
      p(
        "Except as expressly set forth in this " +
          "Agreement, neither Party makes any " +
          "representations or warranties, whether " +
          "express, implied, statutory, or otherwise.",
      ),
    ],
  },
  {
    label: "clause-insurance",
    catLabel: "clause-cat-liability",
    title: "Insurance",
    description:
      "Requires parties to maintain adequate insurance " +
      "coverage for the duration of the agreement.",
    usageNotes:
      "Adjust minimum coverage amounts and policy " +
      "types based on transaction size and risk profile.",
    body: [
      p(
        "Each Party shall, at its own expense, obtain " +
          "and maintain throughout the term of this " +
          "Agreement insurance policies with reputable " +
          "insurers providing coverage that is customary " +
          "for businesses of similar nature and size.",
      ),
      p(
        "Such insurance shall include, at a minimum: " +
          "(a) commercial general liability insurance " +
          "with a minimum limit of GBP 5,000,000 per " +
          "occurrence; and (b) professional indemnity " +
          "insurance with a minimum limit of " +
          "GBP 2,000,000 per claim.",
      ),
      p(
        "Upon request, each Party shall provide the " +
          "other with certificates of insurance " +
          "evidencing the coverage required by this " +
          "clause.",
      ),
    ],
  },

  // ── Confidentiality & IP (5) ─────────────────────────
  {
    label: "clause-confidentiality",
    catLabel: "clause-cat-confidentiality",
    title: "Confidentiality",
    description:
      "Mutual obligation to protect confidential " +
      "information disclosed during the engagement.",
    usageNotes:
      "Adjust the survival period and permitted " +
      "disclosures as appropriate. Add carve-outs for " +
      "regulatory disclosures if needed.",
    body: [
      boldTerm(
        "Each Party (the ",
        "Receiving Party",
        ") agrees that it shall: (a) keep confidential " +
          "all Confidential Information of the other " +
          "Party (the Disclosing Party); and (b) not " +
          "use the Confidential Information for any " +
          "purpose other than the performance of its " +
          "obligations under this Agreement.",
      ),
      boldTerm(
        "",
        "Confidential Information",
        " means all information (whether written, oral, " +
          "or in electronic form) that is designated as " +
          "confidential or that ought reasonably to be " +
          "considered confidential, including: trade " +
          "secrets, know-how, financial information, " +
          "customer lists, business plans, and technical " +
          "data.",
      ),
      p(
        "The obligations under this clause shall not " +
          "apply to information that: (a) is or becomes " +
          "publicly available through no fault of the " +
          "Receiving Party; (b) was known to the " +
          "Receiving Party prior to disclosure; (c) is " +
          "independently developed without reference to " +
          "the Confidential Information; or (d) is " +
          "required to be disclosed by law or " +
          "regulation.",
      ),
      p(
        "The obligations of confidentiality shall " +
          "survive the termination of this Agreement " +
          "for a period of five (5) years.",
      ),
    ],
  },
  {
    label: "clause-intellectual-property",
    catLabel: "clause-cat-confidentiality",
    title: "Intellectual Property",
    description:
      "Assigns or licenses IP rights in deliverables " +
      "created under the agreement.",
    usageNotes:
      "Choose between full assignment and licence-back " +
      "model depending on the commercial arrangement.",
    body: [
      boldTerm(
        "All ",
        "Intellectual Property Rights",
        " in the deliverables created by the Provider " +
          "specifically for the Client under this " +
          "Agreement shall vest in and be the exclusive " +
          "property of the Client upon payment in full " +
          "of the applicable fees.",
      ),
      p(
        "The Provider retains all rights in its " +
          "pre-existing intellectual property, tools, " +
          "methodologies, and know-how. To the extent " +
          "any pre-existing IP is incorporated into the " +
          "deliverables, the Provider grants the Client " +
          "a non-exclusive, perpetual, royalty-free " +
          "licence to use such pre-existing IP solely " +
          "as part of the deliverables.",
      ),
      p(
        "Intellectual Property Rights means patents, " +
          "rights to inventions, copyright and related " +
          "rights, trade marks, trade names, domain " +
          "names, rights in get-up and trade dress, " +
          "goodwill, database rights, rights in " +
          "confidential information, and all other " +
          "similar rights.",
      ),
    ],
  },
  {
    label: "clause-non-compete",
    catLabel: "clause-cat-confidentiality",
    title: "Non-Compete",
    description:
      "Restricts competitive activities during " +
      "and after the agreement term.",
    usageNotes:
      "Non-compete clauses must be reasonable in " +
      "scope, duration, and geography to be " +
      "enforceable. Review local law carefully.",
    body: [
      p(
        "During the term of this Agreement and for a " +
          "period of twelve (12) months following its " +
          "termination (the Restricted Period), neither " +
          "Party shall, without the prior written " +
          "consent of the other Party, directly or " +
          "indirectly engage in any business that " +
          "competes with the business of the other Party " +
          "within the Territory.",
      ),
      boldTerm(
        "",
        "Territory",
        " means the jurisdictions in which the Parties " +
          "conduct business as of the date of this " +
          "Agreement, as specified in Schedule 3.",
      ),
      p(
        "Nothing in this clause shall prevent either " +
          "Party from holding, as a passive investor, " +
          "less than five percent (5%) of the issued " +
          "share capital of any company whose shares " +
          "are listed on a recognised stock exchange.",
      ),
    ],
  },
  {
    label: "clause-non-solicitation",
    catLabel: "clause-cat-confidentiality",
    title: "Non-Solicitation",
    description:
      "Prevents solicitation of the other party's employees and clients.",
    usageNotes:
      "Duration of 6-24 months is typical. Consider " +
      "whether a carve-out for general advertising " +
      "is needed.",
    body: [
      p(
        "During the term of this Agreement and for a " +
          "period of twelve (12) months following its " +
          "termination, neither Party shall, directly " +
          "or indirectly, solicit or entice away (or " +
          "attempt to solicit or entice away) any " +
          "employee, officer, or consultant of the " +
          "other Party who was involved in the " +
          "performance of this Agreement.",
      ),
      p(
        "This restriction shall not apply to: " +
          "(a) general advertising or recruitment " +
          "campaigns not specifically targeted at the " +
          "other Party's personnel; or (b) any person " +
          "who responds to such general advertising " +
          "without direct solicitation.",
      ),
    ],
  },
  {
    label: "clause-data-processing",
    catLabel: "clause-cat-confidentiality",
    title: "Data Processing",
    description:
      "Establishes data processing obligations " +
      "when personal data is shared between parties.",
    usageNotes:
      "Select the variant matching the applicable " +
      "data protection regime. UK GDPR variant " +
      "includes ICO references; Minimal variant " +
      "for non-EU jurisdictions.",
    body: [
      p(
        "To the extent that one Party processes " +
          "personal data on behalf of the other Party " +
          "in connection with this Agreement, the " +
          "processing Party (the Processor) shall " +
          "process such personal data only on the " +
          "documented instructions of the controlling " +
          "Party (the Controller).",
      ),
      p(
        "The Processor shall: (a) implement appropriate " +
          "technical and organisational measures to " +
          "ensure a level of security appropriate to " +
          "the risk; (b) assist the Controller in " +
          "responding to data subject requests; (c) " +
          "notify the Controller without undue delay " +
          "upon becoming aware of a personal data " +
          "breach; and (d) delete or return all personal " +
          "data upon termination of this Agreement.",
      ),
      p(
        "The Processor shall not engage any sub-processor " +
          "without the prior written consent of the " +
          "Controller. The terms of this clause shall " +
          "be supplemented by the Data Processing " +
          "Addendum attached as Schedule 4.",
      ),
    ],
    variants: [
      {
        label: "UK GDPR",
        body: [
          p(
            "This clause is entered into pursuant to " +
              "Article 28 of the UK General Data " +
              "Protection Regulation (UK GDPR) as " +
              "retained under the Data Protection Act " +
              "2018.",
          ),
          p(
            "The Processor shall process personal data " +
              "only on the documented instructions of " +
              "the Controller, including with respect " +
              "to transfers of personal data to a third " +
              "country, unless required to do so by " +
              "applicable UK law.",
          ),
          p(
            "The Processor shall: (a) ensure that " +
              "persons authorised to process the " +
              "personal data have committed themselves " +
              "to confidentiality; (b) implement " +
              "appropriate technical and organisational " +
              "measures in accordance with Article 32 " +
              "of the UK GDPR; (c) notify the Controller " +
              "of any personal data breach without " +
              "undue delay and in any event within " +
              "72 hours; and (d) make available to the " +
              "Controller all information necessary to " +
              "demonstrate compliance.",
          ),
          p(
            "The Processor shall submit to audits and " +
              "inspections conducted by the Controller " +
              "or a mandated auditor. All processing " +
              "shall comply with the guidance issued " +
              "by the Information Commissioner's " +
              "Office (ICO).",
          ),
        ],
      },
      {
        label: "Minimal (non-EU)",
        body: [
          p(
            "Each Party shall comply with all applicable " +
              "data protection and privacy laws in " +
              "connection with the processing of " +
              "personal data under this Agreement.",
          ),
          p(
            "The Processor shall: (a) process personal " +
              "data solely for the purposes of this " +
              "Agreement; (b) implement reasonable " +
              "security measures; and (c) promptly " +
              "notify the Controller of any security " +
              "incident involving personal data.",
          ),
          p(
            "Upon termination of this Agreement, the " +
              "Processor shall delete or return all " +
              "personal data to the Controller within " +
              "thirty (30) days.",
          ),
        ],
      },
    ],
  },

  // ── Governance (5) ───────────────────────────────────
  {
    label: "clause-governing-law",
    catLabel: "clause-cat-governance",
    title: "Governing Law",
    description:
      "Specifies the governing law and jurisdiction for the agreement.",
    usageNotes:
      "Select the variant matching the transaction " +
      "jurisdiction. Add arbitration provisions if " +
      "cross-border.",
    body: [
      p(
        "This Agreement and any dispute or claim " +
          "(including non-contractual disputes or " +
          "claims) arising out of or in connection " +
          "with it or its subject matter or formation " +
          "shall be governed by and construed in " +
          "accordance with the laws of England and " +
          "Wales.",
      ),
      p(
        "Each Party irrevocably agrees that the courts " +
          "of England and Wales shall have exclusive " +
          "jurisdiction to settle any dispute or claim " +
          "arising out of or in connection with this " +
          "Agreement.",
      ),
    ],
    variants: [
      {
        label: "England & Wales",
        body: [
          p(
            "This Agreement and any dispute or claim " +
              "(including non-contractual disputes or " +
              "claims) arising out of or in connection " +
              "with it or its subject matter or formation " +
              "shall be governed by and construed in " +
              "accordance with the laws of England and " +
              "Wales.",
          ),
          p(
            "Each Party irrevocably agrees that the " +
              "courts of England and Wales shall have " +
              "exclusive jurisdiction to settle any " +
              "dispute or claim arising out of or in " +
              "connection with this Agreement.",
          ),
        ],
      },
      {
        label: "State of New York",
        body: [
          p(
            "This Agreement shall be governed by and " +
              "construed in accordance with the laws " +
              "of the State of New York, without regard " +
              "to its conflict of laws principles.",
          ),
          p(
            "Any action or proceeding arising out of " +
              "or relating to this Agreement shall be " +
              "brought exclusively in the state or " +
              "federal courts located in the Borough " +
              "of Manhattan, New York City, and each " +
              "Party irrevocably submits to the " +
              "jurisdiction of such courts.",
          ),
        ],
      },
    ],
  },
  {
    label: "clause-dispute-resolution",
    catLabel: "clause-cat-governance",
    title: "Dispute Resolution",
    description:
      "Establishes a tiered dispute resolution process before litigation.",
    usageNotes:
      "Consider adding LCIA or ICC arbitration for " +
      "cross-border transactions. Adjust escalation " +
      "timeframes as appropriate.",
    body: [
      p(
        "In the event of any dispute arising out of " +
          "or in connection with this Agreement, the " +
          "Parties shall first attempt to resolve the " +
          "dispute through good-faith negotiation " +
          "between their respective senior " +
          "representatives.",
      ),
      p(
        "If the dispute is not resolved within thirty " +
          "(30) days of the commencement of " +
          "negotiations, either Party may refer the " +
          "dispute to mediation in accordance with " +
          "the CEDR Model Mediation Procedure.",
      ),
      p(
        "If the dispute is not resolved within sixty " +
          "(60) days of the commencement of mediation, " +
          "either Party may commence legal proceedings " +
          "in accordance with the governing law and " +
          "jurisdiction clause of this Agreement.",
      ),
    ],
  },
  {
    label: "clause-assignment",
    catLabel: "clause-cat-governance",
    title: "Assignment",
    description:
      "Restricts the ability of parties to assign " +
      "their rights and obligations.",
    usageNotes:
      "Consider adding an exception for intra-group " +
      "assignments without consent.",
    body: [
      p(
        "Neither Party may assign, transfer, or " +
          "otherwise dispose of any of its rights or " +
          "obligations under this Agreement without " +
          "the prior written consent of the other " +
          "Party, such consent not to be unreasonably " +
          "withheld or delayed.",
      ),
      p(
        "Notwithstanding the foregoing, either Party " +
          "may assign this Agreement to an affiliate " +
          "or in connection with a merger, acquisition, " +
          "or sale of all or substantially all of its " +
          "assets, provided that the assignee agrees " +
          "in writing to be bound by the terms of " +
          "this Agreement.",
      ),
    ],
  },
  {
    label: "clause-waiver",
    catLabel: "clause-cat-governance",
    title: "Waiver",
    description:
      "Clarifies that failure to enforce a right " +
      "does not constitute a waiver.",
    usageNotes: "Standard boilerplate. Rarely customized.",
    body: [
      p(
        "No failure or delay by a Party to exercise " +
          "any right or remedy provided under this " +
          "Agreement or by law shall constitute a " +
          "waiver of that or any other right or remedy, " +
          "nor shall it prevent or restrict the further " +
          "exercise of that or any other right or remedy.",
      ),
      p(
        "No single or partial exercise of such right " +
          "or remedy shall prevent or restrict the " +
          "further exercise of that or any other right " +
          "or remedy.",
      ),
    ],
  },
  {
    label: "clause-termination",
    catLabel: "clause-cat-governance",
    title: "Termination",
    description:
      "Specifies grounds and procedures for terminating the agreement.",
    usageNotes:
      "Adjust the notice period and cure period to " +
      "match the commercial arrangement. Add " +
      "termination-for-convenience if applicable.",
    body: [
      p(
        "Either Party may terminate this Agreement " +
          "with immediate effect by giving written " +
          "notice to the other Party if:",
      ),
      p(
        "(a) the other Party commits a material breach " +
          "of any term of this Agreement and (if such " +
          "breach is remediable) fails to remedy that " +
          "breach within thirty (30) days of receipt " +
          "of notice requiring it to do so;",
        { level: 1 },
      ),
      p(
        "(b) the other Party becomes insolvent, enters " +
          "into administration, receivership, or " +
          "liquidation, or makes any arrangement with " +
          "its creditors; or",
        { level: 1 },
      ),
      p(
        "(c) the other Party ceases, or threatens to " +
          "cease, to carry on business.",
        { level: 1 },
      ),
      p(
        "On termination of this Agreement for any " +
          "reason: (i) all rights granted under this " +
          "Agreement shall cease; (ii) each Party shall " +
          "return or destroy all Confidential " +
          "Information of the other Party; and " +
          "(iii) any clauses that expressly or by " +
          "implication survive termination shall " +
          "continue in full force and effect.",
      ),
    ],
  },

  // ── Data & Compliance (5) ────────────────────────────
  {
    label: "clause-data-protection",
    catLabel: "clause-cat-compliance",
    title: "Data Protection",
    description:
      "General data protection obligations for both " +
      "parties, independent of specific regime.",
    usageNotes:
      "Use alongside the Data Processing clause for " +
      "processor/controller relationships. This clause " +
      "covers general obligations.",
    body: [
      p(
        "Each Party shall comply with all applicable " +
          "data protection and privacy legislation in " +
          "force from time to time, including the UK " +
          "GDPR, the Data Protection Act 2018, and any " +
          "laws implementing or supplementing the same.",
      ),
      p(
        "Each Party shall maintain a record of " +
          "processing activities and shall implement " +
          "appropriate technical and organisational " +
          "measures to protect personal data against " +
          "unauthorised or unlawful processing and " +
          "against accidental loss, destruction, " +
          "or damage.",
      ),
      p(
        "Each Party shall promptly notify the other " +
          "if it receives a complaint or request " +
          "relating to the other Party's obligations " +
          "under data protection legislation.",
      ),
    ],
  },
  {
    label: "clause-anti-bribery",
    catLabel: "clause-cat-compliance",
    title: "Anti-Bribery and Corruption",
    description:
      "Compliance with anti-bribery laws including " +
      "the UK Bribery Act 2010.",
    usageNotes:
      "Required for UK-connected transactions. " +
      "Consider adding US FCPA provisions for " +
      "US-connected counterparties.",
    body: [
      p(
        "Each Party shall comply with all applicable " +
          "laws, statutes, and regulations relating " +
          "to anti-bribery and anti-corruption, " +
          "including the Bribery Act 2010.",
      ),
      p(
        "Each Party shall: (a) not engage in any " +
          "activity that would constitute an offence " +
          "under the Bribery Act 2010; (b) maintain " +
          "its own policies and procedures to ensure " +
          "compliance; (c) promptly report to the " +
          "other Party any request or demand for any " +
          "undue financial or other advantage received " +
          "in connection with this Agreement.",
      ),
      p(
        "Breach of this clause shall be deemed a " +
          "material breach entitling the non-breaching " +
          "Party to terminate this Agreement " +
          "immediately.",
      ),
    ],
  },
  {
    label: "clause-export-control",
    catLabel: "clause-cat-compliance",
    title: "Export Control",
    description: "Compliance with export control and sanctions regulations.",
    usageNotes:
      "Critical for cross-border transactions. " +
      "Check OFSI (UK), OFAC (US), and EU sanctions " +
      "lists as applicable.",
    body: [
      p(
        "Each Party shall comply with all applicable " +
          "export control and sanctions laws and " +
          "regulations, including those administered " +
          "by the UK Office of Financial Sanctions " +
          "Implementation (OFSI) and, where applicable, " +
          "the US Office of Foreign Assets Control " +
          "(OFAC).",
      ),
      p(
        "Neither Party shall export, re-export, or " +
          "transfer any goods, technology, or services " +
          "provided under this Agreement to any " +
          "sanctioned country, entity, or person, or " +
          "for any prohibited end-use.",
      ),
      p(
        "Each Party shall screen all relevant " +
          "transactions and counterparties against " +
          "applicable sanctions lists and shall " +
          "maintain records of such screening for " +
          "a minimum period of six (6) years.",
      ),
    ],
  },
  {
    label: "clause-modern-slavery",
    catLabel: "clause-cat-compliance",
    title: "Modern Slavery",
    description: "Compliance with the Modern Slavery Act 2015.",
    usageNotes:
      "Required for UK companies with turnover " +
      "exceeding GBP 36 million. Good practice to " +
      "include in all commercial agreements.",
    body: [
      p(
        "Each Party shall comply with the Modern " +
          "Slavery Act 2015 and shall ensure that " +
          "slavery, servitude, forced or compulsory " +
          "labour, and human trafficking (together, " +
          "Modern Slavery) do not take place in any " +
          "part of its business or supply chain.",
      ),
      p(
        "Each Party shall: (a) implement due diligence " +
          "procedures for its own operations and supply " +
          "chains; (b) maintain a complete and accurate " +
          "modern slavery and human trafficking " +
          "statement pursuant to section 54 of the " +
          "Modern Slavery Act 2015 (where applicable); " +
          "and (c) promptly notify the other Party if " +
          "it becomes aware of any actual or suspected " +
          "instances of Modern Slavery.",
      ),
    ],
  },
  {
    label: "clause-regulatory-compliance",
    catLabel: "clause-cat-compliance",
    title: "Regulatory Compliance",
    description: "General regulatory compliance obligations and cooperation.",
    usageNotes:
      "Customize for sector-specific regulations " +
      "(e.g., FCA for financial services, SRA for " +
      "legal services).",
    body: [
      p(
        "Each Party shall comply with all applicable " +
          "laws, regulations, codes of practice, and " +
          "guidance issued by relevant regulatory " +
          "authorities in connection with the " +
          "performance of its obligations under this " +
          "Agreement.",
      ),
      p(
        "Each Party shall: (a) obtain and maintain all " +
          "licences, permits, and authorisations " +
          "required for the performance of its " +
          "obligations; (b) cooperate with any " +
          "regulatory investigation or inquiry relating " +
          "to this Agreement; and (c) promptly notify " +
          "the other Party of any regulatory action or " +
          "proceeding that may materially affect its " +
          "ability to perform its obligations.",
      ),
      p(
        "In the event of a change in applicable law " +
          "or regulation that materially affects the " +
          "terms of this Agreement, the Parties shall " +
          "negotiate in good faith to amend this " +
          "Agreement to comply with such change.",
      ),
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// TEMPLATE CATEGORIES (4)
// ═══════════════════════════════════════════════════════════

const TEMPLATE_CATS = [
  {
    label: "tmpl-cat-corporate",
    name: "Corporate",
    description: "Share purchase, shareholder, and board resolution templates.",
    sortOrder: 0,
  },
  {
    label: "tmpl-cat-employment",
    name: "Employment",
    description: "Employment contracts, NDAs, and HR-related templates.",
    sortOrder: 1,
  },
  {
    label: "tmpl-cat-commercial",
    name: "Commercial",
    description: "Master services, SLA, and commercial agreement templates.",
    sortOrder: 2,
  },
  {
    label: "tmpl-cat-real-estate",
    name: "Real Estate",
    description:
      "Lease agreements, licences, and property transaction templates.",
    sortOrder: 3,
  },
] as const;

// ═══════════════════════════════════════════════════════════
// TEMPLATES (8)
// ═══════════════════════════════════════════════════════════

type TemplateSeed = {
  label: string;
  catLabel: string;
  name: string;
  fileName: string;
  bodyXml: string;
  fields: FieldMeta[];
  conditions: NamedCondition[];
};

const TEMPLATES: TemplateSeed[] = [
  // 1. Share Purchase Agreement
  {
    label: "tmpl-spa",
    catLabel: "tmpl-cat-corporate",
    name: "Share Purchase Agreement",
    fileName: "Share_Purchase_Agreement.docx",
    bodyXml:
      xmlHeading("Share Purchase Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlHeading("Parties", 2) +
      xmlBoldP("Seller") +
      xmlP(
        "{{sellerName}}, a company incorporated under the laws of {{sellerJurisdiction}}, with registered office at {{sellerAddress}}.",
      ) +
      xmlBoldP("Buyer") +
      xmlP(
        "{{buyerName}}, a company incorporated under the laws of {{buyerJurisdiction}}, with registered office at {{buyerAddress}}.",
      ) +
      xmlHeading("Sale and Purchase", 2) +
      xmlP(
        "Subject to the terms and conditions of this Agreement, the Seller agrees to sell and the Buyer agrees to purchase {{shareCount}} shares (the Shares) in {{companyName}} (the Company) for a total consideration of {{purchasePrice}} (the Purchase Price).",
      ) +
      xmlHeading("Completion", 2) +
      xmlP(
        "Completion of the sale and purchase shall take place on {{completionDate}} at the offices of the Seller's solicitors.",
      ) +
      xmlP("{{#if includeEarnOut}}") +
      xmlHeading("Earn-Out", 2) +
      xmlP(
        "In addition to the Purchase Price, the Buyer shall pay the Seller an earn-out amount calculated in accordance with Schedule 3.",
      ) +
      xmlP("{{/if}}") +
      xmlP("{{#if includeWarrantyInsurance}}") +
      xmlHeading("Warranty and Indemnity Insurance", 2) +
      xmlP(
        "The Buyer shall procure warranty and indemnity insurance in respect of the Seller's warranties, on terms reasonably satisfactory to both Parties.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("{{Confidentiality}}", 2) +
      xmlP("[Clause slot: Confidentiality]") +
      xmlHeading("{{GoverningLaw}}", 2) +
      xmlP("[Clause slot: GoverningLaw]") +
      xmlHeading("{{IndemnificationProvision}}", 2) +
      xmlP("[Clause slot: IndemnificationProvision]"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "sellerName",
        label: "Seller Name",
        inputType: "text",
        required: true,
      },
      {
        path: "sellerJurisdiction",
        label: "Seller Jurisdiction",
        inputType: "text",
      },
      { path: "sellerAddress", label: "Seller Address", inputType: "textarea" },
      {
        path: "buyerName",
        label: "Buyer Name",
        inputType: "text",
        required: true,
      },
      {
        path: "buyerJurisdiction",
        label: "Buyer Jurisdiction",
        inputType: "text",
      },
      { path: "buyerAddress", label: "Buyer Address", inputType: "textarea" },
      {
        path: "shareCount",
        label: "Number of Shares",
        inputType: "number",
        required: true,
      },
      {
        path: "companyName",
        label: "Company Name",
        inputType: "text",
        required: true,
      },
      {
        path: "purchasePrice",
        label: "Purchase Price",
        inputType: "text",
        required: true,
      },
      {
        path: "completionDate",
        label: "Completion Date",
        inputType: "date",
        required: true,
      },
      {
        path: "includeEarnOut",
        label: "Include Earn-Out",
        inputType: "boolean",
      },
      {
        path: "includeWarrantyInsurance",
        label: "Include W&I Insurance",
        inputType: "boolean",
      },
    ],
    conditions: [
      {
        name: "includeEarnOut",
        expression: "includeEarnOut",
        label: "Include Earn-Out provision",
      },
      {
        name: "includeWarrantyInsurance",
        expression: "includeWarrantyInsurance",
        label: "Include W&I Insurance section",
      },
    ],
  },

  // 2. Board Resolution
  {
    label: "tmpl-board-resolution",
    catLabel: "tmpl-cat-corporate",
    name: "Board Resolution",
    fileName: "Board_Resolution.docx",
    bodyXml:
      xmlHeading("Board Resolution", 1) +
      xmlP("Date: {{date}}") +
      xmlP("Company: {{companyName}}") +
      xmlP("Company Number: {{companyNumber}}") +
      xmlHeading("Resolution", 2) +
      xmlP(
        "At a duly convened meeting of the Board of Directors of {{companyName}}, the following resolution was passed:",
      ) +
      xmlP("{{resolutionText}}") +
      xmlP("{{#if requiresShareholderApproval}}") +
      xmlP(
        "This resolution is subject to shareholder approval at the next general meeting of the Company.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("Signatories", 2) +
      xmlP("Chairperson: {{chairpersonName}}") +
      xmlP("Secretary: {{secretaryName}}"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "companyName",
        label: "Company Name",
        inputType: "text",
        required: true,
      },
      {
        path: "companyNumber",
        label: "Company Number",
        inputType: "text",
        required: true,
      },
      {
        path: "resolutionText",
        label: "Resolution Text",
        inputType: "textarea",
        required: true,
      },
      {
        path: "requiresShareholderApproval",
        label: "Requires Shareholder Approval",
        inputType: "boolean",
      },
      {
        path: "chairpersonName",
        label: "Chairperson",
        inputType: "text",
        required: true,
      },
      { path: "secretaryName", label: "Secretary", inputType: "text" },
    ],
    conditions: [
      {
        name: "requiresShareholderApproval",
        expression: "requiresShareholderApproval",
        label: "Requires shareholder approval",
      },
    ],
  },

  // 3. Shareholders' Agreement
  {
    label: "tmpl-shareholders",
    catLabel: "tmpl-cat-corporate",
    name: "Shareholders' Agreement",
    fileName: "Shareholders_Agreement.docx",
    bodyXml:
      xmlHeading("Shareholders' Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlHeading("Parties", 2) +
      xmlP(
        "The shareholders listed in Schedule 1 (each a Shareholder and together the Shareholders) of {{companyName}} (the Company), incorporated in {{jurisdiction}}.",
      ) +
      xmlHeading("Share Capital", 2) +
      xmlP(
        "The authorised share capital of the Company is {{authorisedCapital}}, divided into ordinary shares of {{shareNominalValue}} each.",
      ) +
      xmlP("{{#if includePreEmptionRights}}") +
      xmlHeading("Pre-Emption Rights", 2) +
      xmlP(
        "No Shareholder shall transfer any shares without first offering them to the existing Shareholders pro rata to their holdings, in accordance with the procedure set out in Schedule 2.",
      ) +
      xmlP("{{/if}}") +
      xmlP("{{#if includeDragAlong}}") +
      xmlHeading("Drag-Along Rights", 2) +
      xmlP(
        "If Shareholders holding in aggregate seventy-five percent (75%) or more of the issued share capital wish to accept a bona fide offer for the entire issued share capital, they may require the remaining Shareholders to sell their shares on the same terms.",
      ) +
      xmlP("{{/if}}") +
      xmlP("{{#if includeTagAlong}}") +
      xmlHeading("Tag-Along Rights", 2) +
      xmlP(
        "If any Shareholder receives a bona fide offer to purchase shares representing fifty percent (50%) or more of the issued share capital, the remaining Shareholders shall have the right to sell their shares on the same terms and conditions.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("Board Composition", 2) +
      xmlP(
        "The Board shall comprise {{boardSize}} directors, appointed in accordance with Schedule 3.",
      ) +
      xmlHeading("{{DisputeResolution}}", 2) +
      xmlP("[Clause slot: DisputeResolution]"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "companyName",
        label: "Company Name",
        inputType: "text",
        required: true,
      },
      { path: "jurisdiction", label: "Jurisdiction", inputType: "text" },
      {
        path: "authorisedCapital",
        label: "Authorised Capital",
        inputType: "text",
        required: true,
      },
      {
        path: "shareNominalValue",
        label: "Share Nominal Value",
        inputType: "text",
      },
      {
        path: "includePreEmptionRights",
        label: "Include Pre-Emption Rights",
        inputType: "boolean",
      },
      {
        path: "includeDragAlong",
        label: "Include Drag-Along",
        inputType: "boolean",
      },
      {
        path: "includeTagAlong",
        label: "Include Tag-Along",
        inputType: "boolean",
      },
      { path: "boardSize", label: "Board Size", inputType: "number" },
    ],
    conditions: [
      {
        name: "includePreEmptionRights",
        expression: "includePreEmptionRights",
        label: "Include pre-emption rights",
      },
      {
        name: "includeDragAlong",
        expression: "includeDragAlong",
        label: "Include drag-along rights",
      },
      {
        name: "includeTagAlong",
        expression: "includeTagAlong",
        label: "Include tag-along rights",
      },
    ],
  },

  // 4. Employment Agreement
  {
    label: "tmpl-employment",
    catLabel: "tmpl-cat-employment",
    name: "Employment Agreement",
    fileName: "Employment_Agreement.docx",
    bodyXml:
      xmlHeading("Employment Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlHeading("Parties", 2) +
      xmlBoldP("Employer") +
      xmlP("{{employerName}}, with registered office at {{employerAddress}}.") +
      xmlBoldP("Employee") +
      xmlP("{{employeeName}}, residing at {{employeeAddress}}.") +
      xmlHeading("Position and Duties", 2) +
      xmlP(
        "The Employer hereby employs the Employee as {{jobTitle}}, reporting to {{reportsTo}}.",
      ) +
      xmlP(
        "The Employee's principal place of work shall be {{workLocation}}.",
      ) +
      xmlHeading("Commencement and Term", 2) +
      xmlP("Employment shall commence on {{startDate}}.") +
      xmlP("{{#if hasProbationPeriod}}") +
      xmlP(
        "The first {{probationMonths}} months of employment shall constitute a probationary period, during which either party may terminate employment by giving one week's written notice.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("Remuneration", 2) +
      xmlP(
        "The Employee's gross annual salary shall be {{salary}}, payable in equal monthly instalments.",
      ) +
      xmlP("{{#if includeBonus}}") +
      xmlP(
        "The Employee shall be eligible for a discretionary annual bonus of up to {{bonusPercentage}}% of annual salary, subject to the achievement of performance targets set by the Employer.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("{{NonCompete}}", 2) +
      xmlP("[Clause slot: NonCompete]") +
      xmlHeading("{{Confidentiality}}", 2) +
      xmlP("[Clause slot: Confidentiality]"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "employerName",
        label: "Employer Name",
        inputType: "text",
        required: true,
      },
      {
        path: "employerAddress",
        label: "Employer Address",
        inputType: "textarea",
      },
      {
        path: "employeeName",
        label: "Employee Name",
        inputType: "text",
        required: true,
      },
      {
        path: "employeeAddress",
        label: "Employee Address",
        inputType: "textarea",
      },
      {
        path: "jobTitle",
        label: "Job Title",
        inputType: "text",
        required: true,
      },
      { path: "reportsTo", label: "Reports To", inputType: "text" },
      { path: "workLocation", label: "Work Location", inputType: "text" },
      {
        path: "startDate",
        label: "Start Date",
        inputType: "date",
        required: true,
      },
      {
        path: "hasProbationPeriod",
        label: "Has Probation Period",
        inputType: "boolean",
      },
      {
        path: "probationMonths",
        label: "Probation Period (months)",
        inputType: "number",
      },
      {
        path: "salary",
        label: "Annual Salary",
        inputType: "text",
        required: true,
      },
      { path: "includeBonus", label: "Include Bonus", inputType: "boolean" },
      {
        path: "bonusPercentage",
        label: "Bonus Percentage",
        inputType: "number",
      },
    ],
    conditions: [
      {
        name: "hasProbationPeriod",
        expression: "hasProbationPeriod",
        label: "Include probation period",
      },
      {
        name: "includeBonus",
        expression: "includeBonus",
        label: "Include bonus provision",
      },
    ],
  },

  // 5. Non-Disclosure Agreement
  {
    label: "tmpl-nda",
    catLabel: "tmpl-cat-employment",
    name: "Non-Disclosure Agreement",
    fileName: "Non_Disclosure_Agreement.docx",
    bodyXml:
      xmlHeading("Non-Disclosure Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlHeading("Parties", 2) +
      xmlP(
        "(1) {{disclosingPartyName}}, with registered office at {{disclosingPartyAddress}} (the Disclosing Party); and",
      ) +
      xmlP(
        "(2) {{receivingPartyName}}, with registered office at {{receivingPartyAddress}} (the Receiving Party).",
      ) +
      xmlHeading("Purpose", 2) +
      xmlP(
        "The Disclosing Party intends to disclose certain Confidential Information to the Receiving Party for the purpose of {{purpose}} (the Permitted Purpose).",
      ) +
      xmlHeading("Obligations", 2) +
      xmlP(
        "The Receiving Party shall: (a) keep the Confidential Information strictly confidential; (b) use the Confidential Information only for the Permitted Purpose; and (c) not disclose the Confidential Information to any third party without the prior written consent of the Disclosing Party.",
      ) +
      xmlHeading("Duration", 2) +
      xmlP(
        "This Agreement shall remain in effect for a period of {{durationYears}} years from the date hereof.",
      ) +
      xmlP("{{#if isMutual}}") +
      xmlP(
        "The obligations of confidentiality under this Agreement shall apply equally to both Parties, each acting as both Disclosing Party and Receiving Party as the context requires.",
      ) +
      xmlP("{{/if}}"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "disclosingPartyName",
        label: "Disclosing Party Name",
        inputType: "text",
        required: true,
      },
      {
        path: "disclosingPartyAddress",
        label: "Disclosing Party Address",
        inputType: "textarea",
      },
      {
        path: "receivingPartyName",
        label: "Receiving Party Name",
        inputType: "text",
        required: true,
      },
      {
        path: "receivingPartyAddress",
        label: "Receiving Party Address",
        inputType: "textarea",
      },
      {
        path: "purpose",
        label: "Purpose",
        inputType: "textarea",
        required: true,
      },
      {
        path: "durationYears",
        label: "Duration (years)",
        inputType: "number",
        required: true,
      },
      { path: "isMutual", label: "Mutual NDA", inputType: "boolean" },
    ],
    conditions: [
      {
        name: "isMutual",
        expression: "isMutual",
        label: "Mutual NDA (both parties disclose)",
      },
    ],
  },

  // 6. Master Services Agreement
  {
    label: "tmpl-msa",
    catLabel: "tmpl-cat-commercial",
    name: "Master Services Agreement",
    fileName: "Master_Services_Agreement.docx",
    bodyXml:
      xmlHeading("Master Services Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlHeading("Parties", 2) +
      xmlBoldP("Provider") +
      xmlP(
        "{{providerName}}, a company incorporated in {{providerJurisdiction}}, with registered office at {{providerAddress}}.",
      ) +
      xmlBoldP("Client") +
      xmlP(
        "{{clientName}}, a company incorporated in {{clientJurisdiction}}, with registered office at {{clientAddress}}.",
      ) +
      xmlHeading("Services", 2) +
      xmlP(
        "The Provider shall provide the services described in each Statement of Work (SOW) executed under this Agreement. Each SOW shall specify the scope, deliverables, timeline, and fees for the relevant services.",
      ) +
      xmlP("{{#each services}}") +
      xmlBoldP("{{serviceName}}") +
      xmlP("{{serviceDescription}}") +
      xmlP("Fee: {{serviceFee}}") +
      xmlP("{{/each}}") +
      xmlP("{{#if includeChangeControl}}") +
      xmlHeading("Change Control", 2) +
      xmlP(
        "Any change to the scope of Services shall be agreed in writing through a Change Request, signed by authorised representatives of both Parties, before work on the change commences.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("Term", 2) +
      xmlP(
        "This Agreement shall commence on {{startDate}} and continue for an initial term of {{termYears}} years, unless terminated earlier in accordance with the termination provisions.",
      ) +
      xmlP("{{#if includeAutoRenewal}}") +
      xmlP(
        "Upon expiry of the initial term, this Agreement shall automatically renew for successive periods of twelve (12) months, unless either Party gives not less than ninety (90) days' written notice of non-renewal prior to the end of the then-current term.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("{{LimitationOfLiability}}", 2) +
      xmlP("[Clause slot: LimitationOfLiability]") +
      xmlHeading("{{ForceMajeure}}", 2) +
      xmlP("[Clause slot: ForceMajeure]") +
      xmlHeading("{{GoverningLaw}}", 2) +
      xmlP("[Clause slot: GoverningLaw]"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "providerName",
        label: "Provider Name",
        inputType: "text",
        required: true,
      },
      {
        path: "providerJurisdiction",
        label: "Provider Jurisdiction",
        inputType: "text",
      },
      {
        path: "providerAddress",
        label: "Provider Address",
        inputType: "textarea",
      },
      {
        path: "clientName",
        label: "Client Name",
        inputType: "text",
        required: true,
      },
      {
        path: "clientJurisdiction",
        label: "Client Jurisdiction",
        inputType: "text",
      },
      { path: "clientAddress", label: "Client Address", inputType: "textarea" },
      { path: "services", label: "Services", inputType: "text" },
      {
        path: "startDate",
        label: "Start Date",
        inputType: "date",
        required: true,
      },
      {
        path: "termYears",
        label: "Initial Term (years)",
        inputType: "number",
        required: true,
      },
      {
        path: "includeChangeControl",
        label: "Include Change Control",
        inputType: "boolean",
      },
      {
        path: "includeAutoRenewal",
        label: "Include Auto-Renewal",
        inputType: "boolean",
      },
    ],
    conditions: [
      {
        name: "includeChangeControl",
        expression: "includeChangeControl",
        label: "Include change control procedure",
      },
      {
        name: "includeAutoRenewal",
        expression: "includeAutoRenewal",
        label: "Include auto-renewal",
      },
    ],
  },

  // 7. Service Level Agreement
  {
    label: "tmpl-sla",
    catLabel: "tmpl-cat-commercial",
    name: "Service Level Agreement",
    fileName: "Service_Level_Agreement.docx",
    bodyXml:
      xmlHeading("Service Level Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlP(
        "This Service Level Agreement (SLA) supplements the Master Services Agreement between {{providerName}} and {{clientName}}.",
      ) +
      xmlHeading("Service Levels", 2) +
      xmlP("{{#each metrics}}") +
      xmlBoldP("{{metricName}}") +
      xmlP("Target: {{metricTarget}}") +
      xmlP("Measurement: {{metricMeasurement}}") +
      xmlP("{{/each}}") +
      xmlHeading("Service Credits", 2) +
      xmlP(
        "If the Provider fails to meet any Service Level in a given calendar month, the Client shall be entitled to a service credit equal to {{creditPercentage}}% of the monthly fees for each percentage point below the target, up to a maximum credit of {{maxCreditPercentage}}% of monthly fees.",
      ) +
      xmlP("{{#if includeEscalation}}") +
      xmlHeading("Escalation Procedure", 2) +
      xmlP(
        "Service level failures shall be escalated in accordance with the escalation matrix set out in Appendix A.",
      ) +
      xmlP("{{/if}}"),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "providerName",
        label: "Provider Name",
        inputType: "text",
        required: true,
      },
      {
        path: "clientName",
        label: "Client Name",
        inputType: "text",
        required: true,
      },
      { path: "metrics", label: "Service Metrics", inputType: "text" },
      {
        path: "creditPercentage",
        label: "Credit Percentage",
        inputType: "number",
      },
      {
        path: "maxCreditPercentage",
        label: "Max Credit Percentage",
        inputType: "number",
      },
      {
        path: "includeEscalation",
        label: "Include Escalation Procedure",
        inputType: "boolean",
      },
    ],
    conditions: [
      {
        name: "includeEscalation",
        expression: "includeEscalation",
        label: "Include escalation procedure",
      },
    ],
  },

  // 8. Lease Agreement
  {
    label: "tmpl-lease",
    catLabel: "tmpl-cat-real-estate",
    name: "Lease Agreement",
    fileName: "Lease_Agreement.docx",
    bodyXml:
      xmlHeading("Lease Agreement", 1) +
      xmlP("Date: {{date}}") +
      xmlHeading("Parties", 2) +
      xmlBoldP("Landlord") +
      xmlP("{{landlordName}}, with registered office at {{landlordAddress}}.") +
      xmlBoldP("Tenant") +
      xmlP("{{tenantName}}, with registered office at {{tenantAddress}}.") +
      xmlHeading("Premises", 2) +
      xmlP(
        "The Landlord hereby leases to the Tenant the premises known as {{premisesDescription}} (the Premises), comprising approximately {{areaSize}} square metres.",
      ) +
      xmlHeading("Term", 2) +
      xmlP(
        "The lease shall commence on {{startDate}} and continue for a term of {{termYears}} years (the Term).",
      ) +
      xmlHeading("Rent", 2) +
      xmlP(
        "The annual rent shall be {{annualRent}}, payable in equal quarterly instalments in advance on the usual quarter days.",
      ) +
      xmlP("{{#if includeRentReview}}") +
      xmlHeading("Rent Review", 2) +
      xmlP(
        "The rent shall be reviewed on each fifth anniversary of the commencement date. The revised rent shall be the higher of: (a) the rent payable immediately before the review date; and (b) the open market rent as determined by an independent surveyor appointed pursuant to the RICS guidelines.",
      ) +
      xmlP("{{/if}}") +
      xmlHeading("Permitted Use", 2) +
      xmlP(
        "The Tenant shall use the Premises solely for {{permittedUse}} and shall not change the use without the prior written consent of the Landlord.",
      ),
    fields: [
      { path: "date", label: "Date", inputType: "date", required: true },
      {
        path: "landlordName",
        label: "Landlord Name",
        inputType: "text",
        required: true,
      },
      {
        path: "landlordAddress",
        label: "Landlord Address",
        inputType: "textarea",
      },
      {
        path: "tenantName",
        label: "Tenant Name",
        inputType: "text",
        required: true,
      },
      { path: "tenantAddress", label: "Tenant Address", inputType: "textarea" },
      {
        path: "premisesDescription",
        label: "Premises Description",
        inputType: "textarea",
        required: true,
      },
      { path: "areaSize", label: "Area (sq m)", inputType: "number" },
      {
        path: "startDate",
        label: "Start Date",
        inputType: "date",
        required: true,
      },
      {
        path: "termYears",
        label: "Term (years)",
        inputType: "number",
        required: true,
      },
      {
        path: "annualRent",
        label: "Annual Rent",
        inputType: "text",
        required: true,
      },
      {
        path: "includeRentReview",
        label: "Include Rent Review",
        inputType: "boolean",
      },
      {
        path: "permittedUse",
        label: "Permitted Use",
        inputType: "text",
        required: true,
      },
    ],
    conditions: [
      {
        name: "includeRentReview",
        expression: "includeRentReview",
        label: "Include rent review provision",
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// TEMPLATE-CLAUSE LINKS (9)
// ═══════════════════════════════════════════════════════════

type TemplateClauseLinkSeed = {
  templateLabel: string;
  clauseLabel: string;
  slotName: string;
  variantLabel?: string;
  sortOrder: number;
};

const TEMPLATE_CLAUSE_LINKS: TemplateClauseLinkSeed[] = [
  {
    templateLabel: "tmpl-spa",
    clauseLabel: "clause-confidentiality",
    slotName: "Confidentiality",
    sortOrder: 0,
  },
  {
    templateLabel: "tmpl-spa",
    clauseLabel: "clause-governing-law",
    slotName: "GoverningLaw",
    variantLabel: "England & Wales",
    sortOrder: 1,
  },
  {
    templateLabel: "tmpl-spa",
    clauseLabel: "clause-indemnification",
    slotName: "IndemnificationProvision",
    sortOrder: 2,
  },
  {
    templateLabel: "tmpl-shareholders",
    clauseLabel: "clause-dispute-resolution",
    slotName: "DisputeResolution",
    sortOrder: 0,
  },
  {
    templateLabel: "tmpl-employment",
    clauseLabel: "clause-non-compete",
    slotName: "NonCompete",
    sortOrder: 0,
  },
  {
    templateLabel: "tmpl-employment",
    clauseLabel: "clause-confidentiality",
    slotName: "Confidentiality",
    sortOrder: 1,
  },
  {
    templateLabel: "tmpl-msa",
    clauseLabel: "clause-limitation-of-liability",
    slotName: "LimitationOfLiability",
    sortOrder: 0,
  },
  {
    templateLabel: "tmpl-msa",
    clauseLabel: "clause-force-majeure",
    slotName: "ForceMajeure",
    sortOrder: 1,
  },
  {
    templateLabel: "tmpl-msa",
    clauseLabel: "clause-governing-law",
    slotName: "GoverningLaw",
    variantLabel: "State of New York",
    sortOrder: 2,
  },
];

// ═══════════════════════════════════════════════════════════
// MAIN SEED FUNCTION
// ═══════════════════════════════════════════════════════════

export async function seedTemplates(
  organizationId?: SafeId<"organization">,
): Promise<void> {
  const ORG_ID = organizationId ?? DEFAULT_ORG_ID;

  console.log("  Templates & clauses:");

  // ── 1. Clause categories ────────────────────────────
  for (const cat of CLAUSE_CATS) {
    await db
      .insert(clauseCategories)
      .values({
        id: seedId(cat.label),
        organizationId: ORG_ID,
        name: cat.name,
        description: cat.description,
        sortOrder: cat.sortOrder,
      })
      .onConflictDoNothing();
  }
  console.log(`    Clause categories: ${CLAUSE_CATS.length}`);

  // ── 2. Clauses + clause versions (v1) ──────────────
  let variantCount = 0;
  for (const [i, c] of CLAUSES.entries()) {
    const clauseId = seedId(c.label);
    const versionId = seedId(`${c.label}-v1`);

    await db
      .insert(clauses)
      .values({
        id: clauseId,
        organizationId: ORG_ID,
        categoryId: seedId(c.catLabel),
        title: c.title,
        description: c.description,
        usageNotes: c.usageNotes,
        language: "en",
        body: c.body,
        currentVersion: 1,
        createdBy: pickAuthor(i),
      })
      .onConflictDoNothing();

    await db
      .insert(clauseVersions)
      .values({
        id: versionId,
        organizationId: ORG_ID,
        clauseId,
        version: 1,
        body: c.body,
      })
      .onConflictDoNothing();

    // 3. Clause variants
    if (c.variants) {
      for (const [vi, v] of c.variants.entries()) {
        await db
          .insert(clauseVariants)
          .values({
            id: seedId(`${c.label}-var-${vi}`),
            organizationId: ORG_ID,
            clauseId,
            label: v.label,
            body: v.body,
            sortOrder: vi,
          })
          .onConflictDoNothing();
        variantCount++;
      }
    }
  }
  console.log(`    Clauses: ${CLAUSES.length} (${variantCount} variants)`);

  // ── 4. Template categories ──────────────────────────
  for (const cat of TEMPLATE_CATS) {
    await db
      .insert(templateCategories)
      .values({
        id: seedId(cat.label),
        organizationId: ORG_ID,
        name: cat.name,
        description: cat.description,
        sortOrder: cat.sortOrder,
      })
      .onConflictDoNothing();
  }
  console.log(`    Template categories: ${TEMPLATE_CATS.length}`);

  // ── 5. Templates → S3 → template versions (v1) ─────
  for (const [i, t] of TEMPLATES.entries()) {
    const templateId = seedId(t.label);
    const versionId = seedId(`${t.label}-v1`);

    // Build manifest
    const manifest: TemplateManifest = {
      version: 1,
      fields: t.fields,
      conditions: t.conditions,
    };

    // Generate DOCX with body content
    let docxBuffer = await createTemplateDocx(t.name, t.bodyXml);

    // Embed manifest into DOCX
    docxBuffer = await writeManifest(docxBuffer, manifest);

    const sizeBytes = docxBuffer.length;

    // Upload to S3
    const s3Key = `${ORG_ID}/templates/${templateId}.docx`;
    await s3.write(s3Key, new Uint8Array(docxBuffer));

    // Insert template
    await db
      .insert(templates)
      .values({
        id: templateId,
        organizationId: ORG_ID,
        categoryId: seedId(t.catLabel),
        name: t.name,
        fileName: t.fileName,
        s3Key,
        sizeBytes,
        manifest,
        fieldCount: t.fields.length,
        currentVersion: 1,
        createdBy: pickAuthor(i),
      })
      .onConflictDoNothing();

    // Insert version v1
    const versionS3Key = `${ORG_ID}/templates/${templateId}/v1.docx`;
    await s3.write(versionS3Key, new Uint8Array(docxBuffer));

    await db
      .insert(templateVersions)
      .values({
        id: versionId,
        organizationId: ORG_ID,
        templateId,
        version: 1,
        s3Key: versionS3Key,
        manifest,
        fieldCount: t.fields.length,
        createdBy: pickAuthor(i),
      })
      .onConflictDoNothing();
  }
  console.log(`    Templates: ${TEMPLATES.length} (DOCX + S3)`);

  // ── 6. Template-clause links ────────────────────────
  for (const link of TEMPLATE_CLAUSE_LINKS) {
    const templateId = seedId(link.templateLabel);
    const clauseId = seedId(link.clauseLabel);

    // Find variant ID if specified
    let clauseVariantId: string | undefined;
    if (link.variantLabel) {
      const clause = CLAUSES.find((c) => c.label === link.clauseLabel);
      if (clause?.variants) {
        const vi = clause.variants.findIndex(
          (v) => v.label === link.variantLabel,
        );
        if (vi !== -1) {
          clauseVariantId = seedId(`${link.clauseLabel}-var-${vi}`);
        }
      }
    }

    await db
      .insert(templateClauses)
      .values({
        id: seedId(`link-${link.templateLabel}-${link.slotName}`),
        organizationId: ORG_ID,
        templateId,
        clauseId,
        clauseVariantId,
        slotName: link.slotName,
        sortOrder: link.sortOrder,
      })
      .onConflictDoNothing();
  }
  console.log(`    Template-clause links: ${TEMPLATE_CLAUSE_LINKS.length}`);
}

// ─── Standalone CLI entry point ─────────────────────────

if (import.meta.main) {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run in production.");
    process.exit(1);
  }

  console.log("Seeding templates & clauses...\n");
  await ensureTestUsers(DEFAULT_ORG_ID);
  seedTemplates()
    .then(() => {
      console.log("\nDone.");
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
