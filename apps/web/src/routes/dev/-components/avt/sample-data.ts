/**
 * AVT — sample case data (anonymised UK financial-inquiry scenario).
 *
 * Ported verbatim from the prototype's `app/data.js`. This is
 * placeholder content for the client-side pass; swapping in a real
 * Stella document later means writing an adapter from Stella's
 * `fields`/`justifications` records into this same shape (see
 * `types.ts`), not rebuilding the screens below.
 */

import type {
  AnchorFact,
  CaseDocument,
  Claim,
} from "@/routes/dev/-components/avt/types";

export const ANCHOR_FACTS: readonly AnchorFact[] = [
  {
    id: "CAL-01",
    fact: 'Calendar invitation "Intro — E.W. / J. Harrow" shown as accepted.',
    source: "Outlook export",
    page: "p.14",
    date: "9 Mar 2021",
    kind: "Calendar",
    confidence: "High",
    period: "9 Mar 2021",
  },
  {
    id: "EM-04",
    fact: 'Email from J. Harrow: "Good to have met you earlier today."',
    source: "Email bundle",
    page: "p.212",
    date: "9 Mar 2021",
    kind: "Email",
    confidence: "High",
    period: "9 Mar 2021",
  },
  {
    id: "EM-07",
    fact: "Email from E. Whitfield approving the Brightwater drawdown.",
    source: "Email bundle",
    page: "p.488",
    date: "2 Jul 2021",
    kind: "Email",
    confidence: "High",
    period: "2 Jul 2021",
  },
  {
    id: "BANK-02",
    fact: "Brightwater facility drawdown authorised under signatory E. Whitfield.",
    source: "Barclays statement",
    page: "p.7",
    date: "5 Jul 2021",
    kind: "Bank record",
    confidence: "High",
    period: "Jul 2021",
  },
  {
    id: "AGR-01",
    fact: "Agreed fact: E. Whitfield was an authorised signatory on the Brightwater mandate.",
    source: "Agreed Facts",
    page: "§4.2",
    date: "—",
    kind: "Agreed fact",
    confidence: "High",
    period: "1 Jan – 31 Dec 2021",
  },
  {
    id: "EM-09",
    fact: 'Email characterising the £40,000 as a "consultancy fee".',
    source: "Email bundle",
    page: "p.661",
    date: "19 Aug 2021",
    kind: "Email",
    confidence: "Medium",
    period: "19 Aug 2021",
    interpNote:
      '"Consultancy fee" is the writer\'s own label; the characterisation does not by itself settle the true nature of the payment, which is the point in dispute.',
  },
  {
    id: "MSG-02",
    fact: 'Message: "this just settles what I owe you from before."',
    source: "WhatsApp export",
    page: "p.33",
    date: "18 Aug 2021",
    kind: "Message",
    confidence: "Low",
    period: "18 Aug 2021",
    interpNote:
      '"...what I owe you from before" does not itself identify the debt being settled — it is consistent with the loan the witness describes, but does not on its own establish it.',
  },
  {
    id: "BANK-03",
    fact: "Transfer of £40,000 from the Meridian operating account to E. Whitfield.",
    source: "Barclays statement",
    page: "p.9",
    date: "20 Aug 2021",
    kind: "Bank record",
    confidence: "High",
    period: "20 Aug 2021",
  },
  {
    id: "MSG-05",
    fact: 'WhatsApp thread between E. Whitfield and C. Vance discussing "the Harrow situation".',
    source: "WhatsApp export",
    page: "p.51",
    date: "12 Aug 2021",
    kind: "Message",
    confidence: "High",
    period: "12 Aug 2021",
  },
  {
    id: "CAL-08",
    fact: 'Calendar "Annual leave" blocked across 2–20 August.',
    source: "Outlook export",
    page: "p.40",
    date: "2–20 Aug 2021",
    kind: "Calendar",
    confidence: "High",
    period: "2–20 Aug 2021",
  },
  {
    id: "EM-12",
    fact: "Email sent from E. Whitfield's account at 14:07.",
    source: "Email bundle",
    page: "p.703",
    date: "25 Aug 2021",
    kind: "Email",
    confidence: "High",
    period: "25 Aug 2021",
  },
  {
    id: "DOC-01",
    fact: "Engagement letter bearing E. Whitfield's signature, dated 14 June 2021.",
    source: "Engagement letter",
    page: "p.1",
    date: "14 Jun 2021",
    kind: "Document",
    confidence: "High",
    period: "14 Jun 2021",
  },
  {
    id: "BANK-05",
    fact: "Credit of £40,000 to E. Whitfield's personal account.",
    source: "HSBC statement (personal)",
    page: "p.3",
    date: "23 Aug 2021",
    kind: "Bank record",
    confidence: "High",
    period: "23 Aug 2021",
  },
  {
    id: "CAL-06",
    fact: 'Calendar "Brightwater review — Boardroom 2", 09:30.',
    source: "Outlook export",
    page: "p.31",
    date: "3 May 2021",
    kind: "Calendar",
    confidence: "High",
    period: "3 May 2021",
  },
  {
    id: "HAND-01",
    fact: 'Handwritten attendance sheet; "E.W." appears under the "dial-in" column.',
    source: "Scanned attendance sheet",
    page: "p.1",
    date: "3 May 2021",
    kind: "Document",
    confidence: "Medium",
    period: "3 May 2021",
    medium: "Handwritten",
    interpNote:
      'The initials are legible — the doubt is not the handwriting. What is uncertain is the inference: a name in the "dial-in" column may indicate remote attendance, but these columns are not a reliable record of how each person attended.',
  },
  {
    id: "HAND-02",
    fact: 'Handwritten margin note: "approx £40k — confirm w/ E".',
    source: "Scanned counsel notes",
    page: "p.6",
    date: "undated",
    kind: "Document",
    confidence: "Low",
    period: "—",
    medium: "Handwritten",
    flag: true,
    interpNote:
      'Explicitly provisional — "approx" and "confirm w/ E" show the figure was unconfirmed when written. It records an intention to verify, not a verified amount.',
  },
  {
    id: "LEDG-01",
    fact: "Meridian internal remittance advice records the 23 Aug payment to E. Whitfield as £45,000.",
    source: "Meridian ledger export",
    page: "p.118",
    date: "23 Aug 2021",
    kind: "Ledger",
    confidence: "High",
    period: "23 Aug 2021",
  },
  {
    id: "EM-15",
    fact: "Email from E. Whitfield to Compliance disclosing the arrangement, header timestamp 10 Aug 2021.",
    source: "Email bundle",
    page: "p.640",
    date: "10 Aug 2021",
    kind: "Email",
    confidence: "High",
    period: "10 Aug 2021",
  },
  {
    id: "LOG-01",
    fact: "Compliance case-management log records the same disclosure as received on 17 Aug 2021.",
    source: "Compliance system export",
    page: "case 4471",
    date: "17 Aug 2021",
    kind: "System log",
    confidence: "High",
    period: "17 Aug 2021",
  },
];

export const CLAIMS: readonly Claim[] = [
  {
    id: "c1",
    type: "fact",
    state: "supported",
    score: 88,
    refs: [
      { factId: "CAL-01", rel: "supports" },
      { factId: "EM-04", rel: "supports" },
    ],
  },
  {
    id: "c2",
    type: "fact",
    state: "contradicted",
    score: 18,
    refs: [
      { factId: "EM-07", rel: "conflicts" },
      { factId: "BANK-02", rel: "conflicts" },
      { factId: "AGR-01", rel: "conflicts" },
    ],
  },
  {
    id: "c3",
    type: "fact",
    state: "tension",
    score: 46,
    refs: [
      { factId: "MSG-02", rel: "supports" },
      { factId: "EM-09", rel: "conflicts" },
      { factId: "BANK-03", rel: "supports" },
    ],
  },
  {
    id: "c4",
    type: "fact",
    state: "contradicted",
    score: 24,
    refs: [{ factId: "MSG-05", rel: "conflicts" }],
  },
  {
    id: "c5",
    type: "fact",
    state: "tension",
    score: 52,
    timeConflict: true,
    refs: [
      { factId: "CAL-08", rel: "supports" },
      { factId: "EM-12", rel: "conflicts" },
    ],
  },
  {
    id: "c6",
    type: "fact",
    state: "nocover",
    score: null,
    recalled: true,
    refs: [],
  },
  {
    id: "c7",
    type: "fact",
    state: "supported",
    score: 92,
    refs: [{ factId: "DOC-01", rel: "supports" }],
  },
  {
    id: "c8",
    type: "fact",
    state: "supported",
    score: 95,
    recalled: true,
    refs: [{ factId: "BANK-03", rel: "supports" }],
  },
  {
    id: "c9",
    type: "fact",
    state: "contradicted",
    score: 16,
    refs: [{ factId: "BANK-05", rel: "conflicts" }],
  },
  {
    id: "c10",
    type: "fact",
    state: "nocover",
    score: null,
    refs: [],
  },
  {
    id: "c11",
    type: "fact",
    state: "tension",
    score: 58,
    // Superseded by Whitfield's SECOND statement (§4): she revised "in
    // person" -> "by dial-in", bringing her account into line with
    // HAND-01 and the other witnesses. Single-view build: keep the S1
    // account and its tension verdict, flag the revision.
    superseded: {
      by: "her second statement (§4)",
      note: 'Whitfield withdrew this account in her second statement, revising her 3 May attendance from "in person" to "by dial-in" — which brings it into line with the attendance sheet (HAND-01) and with the other witnesses. The earlier account is kept and dated, not deleted.',
    },
    refs: [
      { factId: "CAL-06", rel: "supports" },
      { factId: "HAND-01", rel: "conflicts" },
    ],
  },
  {
    id: "c14",
    type: "opinion",
    state: "notverifiable",
    score: null,
    refs: [],
  },
  {
    id: "c15",
    type: "unverifiable",
    state: "notverifiable",
    score: null,
    refs: [],
  },
  {
    id: "c12",
    type: "fact",
    state: "recordconflict",
    score: null,
    recordConflict: {
      subject: "the amount of the 23 August payment",
      factIds: ["BANK-05", "LEDG-01"],
      values: ["£40,000", "£45,000"],
      governingStates: ["supported", "contradicted"],
    },
    refs: [
      { factId: "BANK-05", rel: "record" },
      { factId: "LEDG-01", rel: "record" },
    ],
  },
  {
    id: "c13",
    type: "fact",
    state: "recordconflict",
    score: null,
    recordConflict: {
      subject: "the date compliance was notified",
      kind: "date",
      factIds: ["EM-15", "LOG-01"],
      values: ["10 Aug 2021", "17 Aug 2021"],
      governingStates: ["supported", "contradicted"],
      dates: [10, 17],
      month: "Aug",
      boundary: {
        day: 14,
        label: "Board meeting — disclosure due by this date",
        before: {
          verdict: "supported",
          note: "disclosure reaches compliance before the board meeting — in time.",
        },
        after: {
          verdict: "contradicted",
          note: "disclosure only logged after the board meeting — out of time.",
        },
      },
    },
    refs: [
      { factId: "EM-15", rel: "record" },
      { factId: "LOG-01", rel: "record" },
    ],
  },
];

export const CLAIM_TEXT: Readonly<Record<string, string>> = {
  c1: "I first met Mr Harrow in March 2021.",
  c2: "I had no involvement whatsoever in the Brightwater transaction.",
  c3: "The payment of £40,000 was a loan repayment, not a consultancy fee.",
  c4: "I never discussed the matter with Ms Vance.",
  c5: "I was on annual leave for the whole of August 2021.",
  c6: "To my knowledge, the board was never informed of the arrangement.",
  c7: "I signed the engagement letter on 14 June 2021.",
  c8: "I recall the sum involved was approximately £40,000",
  c9: "I did not receive any personal benefit from the arrangement.",
  c10: "The instruction to proceed came verbally from senior management.",
  c11: "I attended the meeting on 3 May 2021 in person",
  c12: "the amount transferred to my account was £40,000",
  c13: "I notified compliance of the arrangement on 10 August 2021.",
  c14: "the whole arrangement was entirely proper and unremarkable",
  c15: "Had it been raised at board level, I would have expected to see it minuted.",
};

export const DOCUMENT: CaseDocument = {
  title: "Witness Statement of Eleanor Whitfield",
  meta: "First statement · 13 paragraphs · signed 26 May 2026",
  paragraphs: [
    {
      id: "p1",
      segments: [
        "I, Eleanor Whitfield, am a former director of Meridian Capital Partners LLP. I make this statement in response to the matters raised by the Inquiry. The facts set out below are within my own knowledge and are true to the best of my recollection.",
      ],
    },
    {
      id: "p2",
      segments: [
        { claimId: "c1" },
        " He was introduced to me by a mutual contact at a portfolio event, and our dealings from that point were limited and professional in nature.",
      ],
    },
    {
      id: "p3",
      segments: [
        { claimId: "c2" },
        " The mandate was run by the structured-finance desk, and decisions of that kind sat well outside my remit at the relevant time.",
      ],
    },
    {
      id: "p4",
      segments: [
        "On the question of the August payment, I should be clear. ",
        { claimId: "c3" },
        " ",
        { claimId: "c14" },
        ", and it was documented in the ordinary way.",
      ],
    },
    {
      id: "p5",
      segments: [
        { claimId: "c4" },
        " To the extent the Inquiry has been told otherwise, I do not accept that characterisation.",
      ],
    },
    {
      id: "p6",
      segments: [
        { claimId: "c5" },
        " I was abroad with my family and had no access to work systems during that period.",
      ],
    },
    { id: "p7", segments: [{ claimId: "c6" }, " ", { claimId: "c15" }] },
    {
      id: "p8",
      segments: [
        { claimId: "c7" },
        " I read the letter carefully before signing and understood its terms.",
      ],
    },
    {
      id: "p9",
      segments: [
        "As to the figures, ",
        { claimId: "c8" },
        ", although I could not now give an exact amount without the papers in front of me.",
      ],
    },
    {
      id: "p10",
      segments: [
        { claimId: "c9" },
        " Any suggestion that I gained financially from these events is simply wrong.",
      ],
    },
    {
      id: "p11",
      segments: [
        { claimId: "c10" },
        " I acted on that instruction in good faith and ",
        { claimId: "c11" },
        ", as my diary for that day records.",
      ],
    },
    {
      id: "p12",
      segments: [
        "For completeness on the sums, ",
        { claimId: "c12" },
        " and that figure is borne out by the bank record for my account.",
      ],
    },
    {
      id: "p13",
      segments: [
        { claimId: "c13" },
        " The disclosure was made in good time and the correspondence bears that out.",
      ],
    },
  ],
};
