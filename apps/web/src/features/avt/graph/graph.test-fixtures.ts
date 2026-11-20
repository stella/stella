/**
 * A verification graph page shaped like the API's answer, for the graph's
 * logic and DOM tests: two statements, claims of every kind of link (a
 * record conflict among them), held, off-list, testimony and unsourced
 * facts, and dated facts at each precision.
 */

import type { VerificationGraphPage } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const uuid = (prefix: number, n: number) =>
  `0199b000-0000-7000-8${String(prefix)}00-${String(n).padStart(12, "0")}`;

export const statementId = (n: number) =>
  toSafeId<"legalListVerificationRun">(uuid(1, n));
export const graphClaimId = (n: number) =>
  toSafeId<"legalListClaim">(uuid(2, n));
export const graphFactId = (n: number) => toSafeId<"entity">(uuid(3, n));
export const sourceId = (n: number) => toSafeId<"entity">(uuid(4, n));

type Page = VerificationGraphPage;

const statement = (n: number, name: string, claimCount: number) =>
  ({
    id: statementId(n),
    entityId: toSafeId<"entity">(uuid(5, n)),
    fileFieldId: toSafeId<"field">(uuid(6, n)),
    name,
    finishedAt: "2026-11-01T10:00:00.000Z",
    claimCount,
  }) satisfies Page["statements"][number];

const claim = (
  n: number,
  statementNumber: number,
  state: Page["claims"][number]["state"],
  text: string,
) =>
  ({
    id: graphClaimId(n),
    statementId: statementId(statementNumber),
    position: n,
    paragraph: null,
    text,
    state,
    reviewStatus: null,
    qualifiers: [],
  }) satisfies Page["claims"][number];

const fact = (
  n: number,
  text: string,
  overrides: Partial<Page["facts"][number]> = {},
) =>
  ({
    id: graphFactId(n),
    text,
    occurredOn: null,
    occurredOnPrecision: null,
    tier: "document",
    held: false,
    listed: true,
    ...overrides,
  }) satisfies Page["facts"][number];

export const GRAPH_TEXT = {
  board: "The board approved the loan on 3 March 2021.",
  payment: "The payment was made on 23 August.",
  meeting: "The witness attended every meeting.",
  unseen: "The witness never saw the ledger.",
  ledger: "Ledger records the payment on 23 August 2021",
  recalled: "Officer recalls the payment on 30 August 2021",
  minutes: "Board minutes of March 2021",
  calendar: "Calendar entries for 2021",
  heldNote: "Handwritten note, meaning unclear",
  oldFact: "Superseded attendance record",
  undatedFact: "Witness's own recollection of the room",
} as const;

/** One page: the first statement holds a supported claim, a record
 *  conflict and a claim without coverage; the second a contradicted claim
 *  resting on a held fact and one off the list. */
export const graphPage = (): Page => ({
  listId: toSafeId<"legalList">(uuid(7, 1)),
  statements: [
    statement(1, "Witness statement.docx", 3),
    statement(2, "Defence.pdf", 1),
  ],
  claims: [
    claim(1, 1, "supported", GRAPH_TEXT.board),
    claim(2, 1, "recordconflict", GRAPH_TEXT.payment),
    claim(3, 1, "nocover", GRAPH_TEXT.unseen),
    claim(4, 2, "contradicted", GRAPH_TEXT.meeting),
  ],
  facts: [
    fact(1, GRAPH_TEXT.minutes, {
      occurredOn: "2021-03-01",
      occurredOnPrecision: "month",
    }),
    fact(2, GRAPH_TEXT.ledger, {
      occurredOn: "2021-08-23",
      occurredOnPrecision: "day",
    }),
    fact(3, GRAPH_TEXT.recalled, {
      occurredOn: "2021-08-30",
      occurredOnPrecision: "day",
      tier: "testimony",
    }),
    fact(4, GRAPH_TEXT.calendar, {
      occurredOn: "2021-01-01",
      occurredOnPrecision: "year",
    }),
    fact(5, GRAPH_TEXT.heldNote, { held: true, tier: "unsourced" }),
    fact(6, GRAPH_TEXT.undatedFact, { tier: "unsourced" }),
    fact(7, GRAPH_TEXT.oldFact, { listed: false }),
  ],
  sources: [
    { id: sourceId(1), name: "Board minutes.pdf" },
    { id: sourceId(2), name: "Ledger export.pdf" },
    { id: sourceId(3), name: "Interview note.docx" },
  ],
  citations: [
    {
      type: "cites",
      claimId: graphClaimId(1),
      factId: graphFactId(1),
      rel: "supports",
    },
    {
      type: "record-conflict",
      claimId: graphClaimId(2),
      factId: graphFactId(2),
      stateIfGoverning: "supported",
      governs: false,
    },
    {
      type: "record-conflict",
      claimId: graphClaimId(2),
      factId: graphFactId(3),
      stateIfGoverning: "contradicted",
      governs: false,
    },
    {
      type: "cites",
      claimId: graphClaimId(4),
      factId: graphFactId(5),
      rel: "conflicts",
    },
    {
      type: "cites",
      claimId: graphClaimId(4),
      factId: graphFactId(7),
      rel: "conflicts",
    },
  ],
  provenance: [
    {
      factId: graphFactId(1),
      sourceId: sourceId(1),
      locator: { type: "pdf-page", pageNumber: 4 },
      quote: null,
    },
    {
      factId: graphFactId(2),
      sourceId: sourceId(2),
      locator: { type: "pdf-page", pageNumber: 14 },
      quote: null,
    },
    {
      factId: graphFactId(3),
      sourceId: sourceId(3),
      locator: { type: "document" },
      quote: null,
    },
  ],
  factOverflow: false,
  nextCursor: null,
});
