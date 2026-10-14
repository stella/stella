import type { FactDetailsBody } from "@/features/avt/types";

export type SampleFact = {
  statement: string;
  details: Omit<FactDetailsBody, "listId" | "itemEntityId">;
};

/**
 * The anonymised Whitfield case: anchor facts for a witness statement whose
 * claims cover every verdict. Low-confidence facts are held out of scoring.
 */
export const SAMPLE_FACTS: readonly SampleFact[] = [
  {
    statement:
      'Calendar invitation "Intro — E.W. / J. Harrow" shown as accepted.',
    details: {
      occurredOn: { date: "2021-03-09", precision: "day" },
      evidenceKind: "Calendar",
      medium: "Outlook export p.14",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: 'Email from J. Harrow: "Good to have met you earlier today."',
    details: {
      occurredOn: { date: "2021-03-09", precision: "day" },
      evidenceKind: "Email",
      medium: "Email bundle p.212",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: "Email from E. Whitfield approving the Brightwater drawdown.",
    details: {
      occurredOn: { date: "2021-07-02", precision: "day" },
      evidenceKind: "Email",
      medium: "Email bundle p.488",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      "Brightwater facility drawdown authorised under signatory E. Whitfield.",
    details: {
      occurredOn: { date: "2021-07-05", precision: "day" },
      evidenceKind: "Bank record",
      medium: "Barclays statement p.7",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      "Agreed fact: E. Whitfield was an authorised signatory on the Brightwater mandate.",
    details: {
      occurredOn: null,
      evidenceKind: "Agreed fact",
      medium: "Agreed Facts §4.2",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: 'Email characterising the £40,000 as a "consultancy fee".',
    details: {
      occurredOn: { date: "2021-08-19", precision: "day" },
      evidenceKind: "Email",
      medium: "Email bundle p.661",
      confidence: "medium",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: 'Message: "this just settles what I owe you from before."',
    details: {
      occurredOn: { date: "2021-08-18", precision: "day" },
      evidenceKind: "Message",
      medium: "WhatsApp export p.33",
      confidence: "low",
      interpretationNote: null,
      scoring: "held",
    },
  },
  {
    statement:
      "Transfer of £40,000 from the Meridian operating account to E. Whitfield.",
    details: {
      occurredOn: { date: "2021-08-20", precision: "day" },
      evidenceKind: "Bank record",
      medium: "Barclays statement p.9",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      'WhatsApp thread between E. Whitfield and C. Vance discussing "the Harrow situation".',
    details: {
      occurredOn: { date: "2021-08-12", precision: "day" },
      evidenceKind: "Message",
      medium: "WhatsApp export p.51",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: 'Calendar "Annual leave" blocked across 2–20 August.',
    details: {
      occurredOn: null,
      evidenceKind: "Calendar",
      medium: "Outlook export p.40",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: "Email sent from E. Whitfield's account at 14:07.",
    details: {
      occurredOn: { date: "2021-08-25", precision: "day" },
      evidenceKind: "Email",
      medium: "Email bundle p.703",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      "Engagement letter bearing E. Whitfield's signature, dated 14 June 2021.",
    details: {
      occurredOn: { date: "2021-06-14", precision: "day" },
      evidenceKind: "Document",
      medium: "Engagement letter p.1",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: "Credit of £40,000 to E. Whitfield's personal account.",
    details: {
      occurredOn: { date: "2021-08-23", precision: "day" },
      evidenceKind: "Bank record",
      medium: "HSBC statement (personal) p.3",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: 'Calendar "Brightwater review — Boardroom 2", 09:30.',
    details: {
      occurredOn: { date: "2021-05-03", precision: "day" },
      evidenceKind: "Calendar",
      medium: "Outlook export p.31",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      'Handwritten attendance sheet; "E.W." appears under the "dial-in" column.',
    details: {
      occurredOn: { date: "2021-05-03", precision: "day" },
      evidenceKind: "Document",
      medium: "Scanned attendance sheet p.1",
      confidence: "medium",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement: 'Handwritten margin note: "approx £40k — confirm w/ E".',
    details: {
      occurredOn: null,
      evidenceKind: "Document",
      medium: "Scanned counsel notes p.6",
      confidence: "low",
      interpretationNote: null,
      scoring: "held",
    },
  },
  {
    statement:
      "Meridian internal remittance advice records the 23 Aug payment to E. Whitfield as £45,000.",
    details: {
      occurredOn: { date: "2021-08-23", precision: "day" },
      evidenceKind: "Ledger",
      medium: "Meridian ledger export p.118",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      "Email from E. Whitfield to Compliance disclosing the arrangement, header timestamp 10 Aug 2021.",
    details: {
      occurredOn: { date: "2021-08-10", precision: "day" },
      evidenceKind: "Email",
      medium: "Email bundle p.640",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
  {
    statement:
      "Compliance case-management log records the same disclosure as received on 17 Aug 2021.",
    details: {
      occurredOn: { date: "2021-08-17", precision: "day" },
      evidenceKind: "System log",
      medium: "Compliance system export case 4471",
      confidence: "high",
      interpretationNote: null,
      scoring: "included",
    },
  },
];
