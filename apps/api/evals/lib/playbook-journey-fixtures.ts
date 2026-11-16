/**
 * Fixtures for the playbook journey (`evals/e2e/playbook-journey.ts`): one
 * playbook with a position for each check kind, the contracts it runs on, and
 * the verdict tiers each contract should get. Every party, name and figure is
 * fictional.
 *
 * Contracts:
 *   long       a services agreement whose confidentiality clause is a single
 *              paragraph of several thousand characters, with the terms the
 *              grader needs at its end
 *   reference  a shorter agreement, reviewed from the panel against a signed
 *              precedent stored in another matter
 */
import { ZipArchive } from "@stll/docx-core/zip";

import type { Position } from "@/api/lib/workflow/playbook-positions";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

export const JOURNEY_CONTRACT = {
  long: "long",
  reference: "reference",
} as const;

export type JourneyContract =
  (typeof JOURNEY_CONTRACT)[keyof typeof JOURNEY_CONTRACT];

// --------------- Positions ---------------

const FEES_ID = "5b0c1e00-0000-4000-8000-000000000001";
const CONFIDENTIALITY_ID = "5b0c1e00-0000-4000-8000-000000000002";
const LIABILITY_ID = "5b0c1e00-0000-4000-8000-000000000003";
const CONFIDENTIALITY_PRESENT_ID = "5b0c1e00-0000-4000-8000-000000000004";
const PAYMENT_DAYS_ID = "5b0c1e00-0000-4000-8000-000000000005";

/** A stable uuid per rule, derived from its position and place. */
const ruleId = (positionId: string, slot: number): string =>
  `${positionId.slice(0, 24)}${String(slot).padStart(12, "0")}`;

type TierFixture = {
  sourceId: string;
  issue: string;
  acceptable: readonly string[];
  fallbacks?: readonly string[];
  redLines?: readonly string[];
  ideal?: string;
  check?: Extract<Position, { mode: "graded" }>["check"];
};

const tierPosition = ({
  sourceId,
  issue,
  acceptable,
  fallbacks = [],
  redLines = [],
  ideal,
  check,
}: TierFixture): Position => ({
  mode: "graded",
  sourceId,
  issue,
  severity: "medium",
  ask: { mode: "auto" },
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: acceptable.map((text, index) => ({
          id: ruleId(sourceId, 100 + index),
          text,
        })),
        ...(ideal === undefined
          ? {}
          : { ideal: { source: "inline" as const, text: ideal } }),
      },
      fallback: {
        entries: fallbacks.map((text, index) => ({
          id: ruleId(sourceId, 200 + index),
          text,
        })),
      },
      notAcceptable: {
        rules: redLines.map((text, index) => ({
          id: ruleId(sourceId, 300 + index),
          text,
        })),
      },
    },
  },
  ...(check === undefined ? {} : { check }),
  enabled: true,
});

/** One position per check kind: three model-graded tier ladders (one with
 *  ideal language, so a deviation carries a proposed fix), a presence check,
 *  and a numeric constraint. Asks are derived at save time, as in the app. */
export const JOURNEY_POSITIONS: readonly Position[] = [
  tierPosition({
    sourceId: FEES_ID,
    issue: "Fees, invoices and price increases",
    acceptable: [
      "Fees are specified in a binding schedule; invoices are monthly in arrears and due 30 days after receipt of a correct invoice.",
      "No increase during the initial term; thereafter no more than once annually, on at least 90 days' written notice and subject to an agreed objective cap.",
    ],
    fallbacks: [
      "After the initial term, Supplier may adjust fees once per contract year on at least 90 days' written notice, not exceeding the increase in the mutually specified published U.S. consumer-price index over the preceding 12 months.",
    ],
    redLines: [
      "Supplier may raise fees at will or without advance notice.",
      "Fees or payment milestones are not stated in an incorporated agreement or schedule.",
    ],
  }),
  tierPosition({
    sourceId: CONFIDENTIALITY_ID,
    issue: "Confidentiality and survival",
    acceptable: [
      "Mutual confidentiality and purpose limitation extend to personnel and advisers only on a need-to-know basis under equivalent duties.",
      "General confidentiality obligations survive five years after termination; trade-secret protection continues for as long as the information qualifies as a trade secret under applicable law.",
    ],
    redLines: [
      "Supplier may use or disclose customer confidential information for unrelated purposes.",
      "Confidentiality ends automatically at termination with no survival period.",
    ],
  }),
  tierPosition({
    sourceId: LIABILITY_ID,
    issue: "Limitation of liability",
    acceptable: [
      "Each party's aggregate liability is capped at no less than the total fees paid or payable in the twelve months before the event giving rise to the claim.",
    ],
    redLines: [
      "Supplier's aggregate liability is capped at less than the fees paid or payable in the six months before the claim.",
    ],
    ideal:
      "Each Party's aggregate liability arising out of or in connection with this Agreement shall not exceed the total fees paid or payable under this Agreement in the twelve (12) months preceding the event giving rise to the claim.",
  }),
  tierPosition({
    sourceId: CONFIDENTIALITY_PRESENT_ID,
    issue: "Confidentiality clause",
    acceptable: ["The contract contains a mutual confidentiality clause."],
    check: { kind: "presence", expectation: "required" },
  }),
  tierPosition({
    sourceId: PAYMENT_DAYS_ID,
    issue: "Invoice payment term (days)",
    acceptable: ["Invoices are payable within 30 days at most."],
    check: {
      kind: "constraint",
      condition: {
        type: "group",
        combinator: "and",
        children: [
          {
            type: "compare",
            left: { type: "property", propertyId: PAYMENT_DAYS_ID },
            op: "lte",
            right: { type: "literal", value: 30 },
          },
        ],
      },
    },
  }),
];

/**
 * The tiers a correct review gives each authored position, per contract. More
 * than one tier where a reading is defensible either way, as in the clause
 * eval: the long contract's CPI-capped increase meets the fallback and also
 * the acceptable rule, because a CPI limit is an "agreed objective cap".
 */
export const EXPECTED_TIERS: Readonly<
  Record<JourneyContract, Readonly<Record<string, readonly VerdictTier[]>>>
> = {
  long: {
    [FEES_ID]: ["fallback", "compliant"],
    [CONFIDENTIALITY_ID]: ["compliant"],
    [LIABILITY_ID]: ["deviation"],
    [CONFIDENTIALITY_PRESENT_ID]: ["compliant"],
    [PAYMENT_DAYS_ID]: ["compliant"],
  },
  reference: {
    [FEES_ID]: ["compliant"],
    [CONFIDENTIALITY_ID]: ["compliant"],
    [LIABILITY_ID]: ["deviation"],
    [CONFIDENTIALITY_PRESENT_ID]: ["compliant"],
    [PAYMENT_DAYS_ID]: ["compliant"],
  },
};

/** Positions whose deviation must come with a proposed fix: they carry ideal
 *  language in the document's own language. */
export const FIX_EXPECTED_POSITION_IDS: ReadonlySet<string> = new Set([
  LIABILITY_ID,
]);

/**
 * The reference contract repeats the precedent's clauses word for word, so a
 * position proposed from the precedent compares as aligned. `not-applicable`
 * is a defensible reading only when the model compared and called the term
 * deal-specific; the journey checks that it did compare.
 */
export const EXPECTED_REFERENCE_TIERS: readonly VerdictTier[] = [
  "compliant",
  "not-applicable",
];

// --------------- Contracts ---------------

const LONG_CONFIDENTIALITY_PREAMBLE = [
  '6.1 "Confidential Information" means all non-public information, in any form or medium, that a Party (the "Discloser") discloses to the other Party (the "Recipient") in connection with this Agreement, including business plans, customer lists, pricing, product roadmaps, technical data, software, source and object code, data models, reports generated by the Services, and the terms of this Agreement, whether marked confidential or not, provided that it would reasonably be understood to be confidential given its nature and the circumstances of disclosure.',
  "Confidential Information does not include information that the Recipient can show by written records was lawfully known to it before disclosure without any duty of confidence, is or becomes generally available to the public other than through a breach of this Agreement, is lawfully received from a third party entitled to disclose it without restriction, or is independently developed by the Recipient's personnel who had no access to the Discloser's Confidential Information.",
  "The Recipient may disclose Confidential Information to the extent required by law, a court order or the rules of a recognised stock exchange, provided that, where lawful, it gives the Discloser prompt written notice, cooperates with any effort by the Discloser to obtain a protective order, and discloses only the minimum that it is legally required to disclose.",
  "On written request, and in any event on expiry or termination of this Agreement, the Recipient shall promptly return or securely destroy all Confidential Information of the Discloser in its possession, except for copies held in routine backup systems that cannot reasonably be deleted and copies it must retain by law, which remain subject to this Clause for as long as they are held.",
  "Each Party acknowledges that damages alone may not be an adequate remedy for a breach of this Clause, and that the Discloser is entitled to seek injunctive or other equitable relief for any threatened or actual breach, in addition to any other remedy available to it.",
].join(" ");

const LONG_CONFIDENTIALITY_TERMS =
  "Each Party shall protect the other Party's Confidential Information using reasonable care, use it only to perform this Agreement, and disclose it only to its personnel and professional advisers who need to know it and are bound by obligations no less protective than this Clause 6. These obligations survive for five (5) years after expiry or termination, and information that qualifies as a trade secret remains protected for as long as it qualifies as a trade secret under applicable law.";

const filler = (number: number, heading: string, text: string): string =>
  `${String(number)}. ${heading}\n${String(number)}.1 ${text}`;

const LONG_CONTRACT = [
  "SERVICES AGREEMENT",
  'between Nordwind Logistics GmbH ("Customer") and Halden Data AB ("Supplier").',
  filler(
    1,
    "Services",
    "Supplier shall provide the hosted reporting services described in Schedule 1 with the skill and care of a competent provider of similar services.",
  ),
  '2. Term\n2.1 This Agreement starts on the Effective Date and continues for an initial term of 24 months (the "Initial Term"), after which it renews for successive periods of 12 months unless either Party gives at least 90 days\' written notice of non-renewal.',
  filler(
    3,
    "Service levels",
    "Supplier shall make the Services available at least 99.5% of each calendar month, excluding planned maintenance notified at least five business days in advance, and shall credit the fees as set out in Schedule 3 for any shortfall.",
  ),
  "4. Fees\n4.1 Customer shall pay the fees set out in Schedule 2. Supplier shall invoice monthly in arrears, and each correct, itemised invoice is payable within 30 days after receipt.\n4.2 Fees are fixed for the Initial Term. After the Initial Term, Supplier may adjust the fees once per contract year on at least 90 days' written notice. No adjustment may exceed the increase in the U.S. Consumer Price Index for All Urban Consumers (CPI-U) published by the U.S. Bureau of Labor Statistics over the preceding 12 months.",
  filler(
    5,
    "Customer data",
    "Customer Data remains the property of Customer. Supplier shall process Customer Data only on Customer's documented instructions and in accordance with the data processing terms in Schedule 4.",
  ),
  `6. Confidentiality\n${LONG_CONFIDENTIALITY_PREAMBLE} ${LONG_CONFIDENTIALITY_TERMS}`,
  filler(
    7,
    "Intellectual property",
    "Each Party retains its pre-existing intellectual property. Supplier grants Customer a non-exclusive licence to use the reports generated by the Services for its internal business purposes during and after the term.",
  ),
  "8. Limitation of liability\n8.1 Neither Party excludes liability for death or personal injury caused by negligence or for fraud.\n8.2 Subject to Clause 8.1, Supplier's aggregate liability arising out of or in connection with this Agreement shall not exceed the fees paid by Customer in the three (3) months preceding the event giving rise to the claim.",
  filler(
    9,
    "Termination",
    "Either Party may terminate this Agreement with immediate effect by written notice if the other Party commits a material breach that is not remedied within 30 days after written notice of the breach.",
  ),
  filler(
    10,
    "Governing law",
    "This Agreement is governed by the laws of Sweden, and the courts of Stockholm have exclusive jurisdiction over any dispute arising out of it.",
  ),
  "Schedule 2. Fees\nThe hosted reporting services are charged at a fixed fee of EUR 4,800 per month, which covers up to 50 named users. Each additional named user is charged at EUR 60 per month.",
].join("\n");

// The precedent and the reference contract share these two clauses word for
// word; positions proposed from the precedent read them.
const SHARED_CONFIDENTIALITY =
  "Each Party shall keep the other Party's Confidential Information confidential, use it only to perform this Agreement, and disclose it only to its personnel and professional advisers who need to know it and are bound by obligations no less protective than this Clause. These obligations survive for five (5) years after expiry or termination, and information that qualifies as a trade secret remains protected for as long as it qualifies as a trade secret under applicable law.";

const SHARED_GOVERNING_LAW =
  "This Agreement is governed by the laws of Sweden, and the courts of Stockholm have exclusive jurisdiction over any dispute arising out of it.";

const REFERENCE_CONTRACT = [
  "DATA SERVICES AGREEMENT",
  'between Brightwater Analytics Ltd ("Customer") and Kestrel Routing Oy ("Supplier").',
  "1. Services\n1.1 Supplier shall provide the route-planning data services described in Schedule 1.",
  "2. Fees\n2.1 Customer shall pay the fees set out in Schedule 2, which are fixed for the whole term and may not be increased. Supplier shall invoice monthly in arrears, and each correct, itemised invoice is payable within 30 days after receipt.",
  `3. Confidentiality\n3.1 ${SHARED_CONFIDENTIALITY}`,
  "4. Limitation of liability\n4.1 Supplier's aggregate liability arising out of or in connection with this Agreement shall not exceed the fees paid by Customer in the one (1) month preceding the event giving rise to the claim.",
  `5. Governing law\n5.1 ${SHARED_GOVERNING_LAW}`,
  "Schedule 2. Fees\nThe route-planning data services are charged at a fixed fee of EUR 2,500 per month for the whole term.",
].join("\n");

const PRECEDENT = [
  "DATA SERVICES AGREEMENT (SIGNED PRECEDENT)",
  'between Larchmont Freight AB ("Customer") and Kestrel Routing Oy ("Supplier").',
  `1. Confidentiality\n1.1 ${SHARED_CONFIDENTIALITY}`,
  `2. Governing law\n2.1 ${SHARED_GOVERNING_LAW}`,
].join("\n");

export const JOURNEY_DOCUMENTS = {
  long: { fileName: "services-agreement-long.docx", text: LONG_CONTRACT },
  reference: {
    fileName: "data-services-agreement.docx",
    text: REFERENCE_CONTRACT,
  },
  precedent: {
    fileName: "data-services-precedent.docx",
    text: PRECEDENT,
  },
} as const;

// --------------- DOCX ---------------

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const PACKAGE_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

/** A minimal DOCX with one paragraph per line of `text`. */
export const fixtureDocx = async (
  text: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const paragraphs = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    )
    .join("");
  const zip = new ZipArchive();
  zip.set("[Content_Types].xml", CONTENT_TYPES);
  zip.set("_rels/.rels", PACKAGE_RELS);
  zip.set(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}</w:body></w:document>`,
  );
  return await zip.generate();
};
