/**
 * A list's chronology as a table to download: one row per fact on the list,
 * in the order it happened as precisely as its date is known, the facts
 * nobody dated last, each with the document it first comes from and the
 * claims that cite it with the verdict reviewers see now.
 *
 * Read as one page of the verification graph (`readVerificationGraph`), so
 * a row says what the graph says: the same claims, verdicts and sources,
 * read with the same owners (`gradeOf`, `reviewedView`). Bounded: a list
 * holding more facts than the graph carries, or verified past
 * `CHRONOLOGY_EXPORT_DOCUMENTS_MAX` documents or
 * `CHRONOLOGY_EXPORT_CLAIMS_MAX` claims, is refused, never exported in part.
 */

import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type { FactDatePrecision } from "@/api/lib/lists/fact-details";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type {
  ClaimReviewStatus,
  ClaimState,
} from "@/api/lib/lists/verification/contract";
import { readVerificationGraph } from "@/api/lib/lists/verification/graph-read";
import type { ReadVerificationGraphOutcome } from "@/api/lib/lists/verification/graph-read";

type GraphRead = Extract<ReadVerificationGraphOutcome, { type: "read" }>;
export type ChronologyGraphPage = Pick<
  GraphRead["graph"],
  "statements" | "claims" | "facts" | "sources" | "citations" | "provenance"
>;

export const CHRONOLOGY_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "fact", header: "Fact" },
  { key: "source", header: "Source" },
  { key: "claims", header: "Citing claims" },
] as const;

type ChronologyColumnKey = (typeof CHRONOLOGY_COLUMNS)[number]["key"];
export type ChronologyRow = Record<ChronologyColumnKey, string>;

/** The verdict as the review shows it on a claim's chip. */
const STATE_LABEL = {
  supported: "Supported",
  tension: "In tension",
  contradicted: "Contradicted",
  nocover: "No coverage",
  notverifiable: "Not verifiable",
  recordconflict: "Record conflict",
} as const satisfies Record<ClaimState, string>;

const REVIEW_LABEL = {
  reviewed: "reviewed",
  disputed: "disputed",
  "needs-evidence": "needs evidence",
} as const satisfies Record<ClaimReviewStatus, string>;

/** Coarser precision first on the same stored day: "2021" before
 *  "2021-01" before "2021-01-01", since a partial date is stored as its
 *  first day. */
const PRECISION_RANK = { year: 0, month: 1, day: 2 } as const satisfies Record<
  FactDatePrecision,
  number
>;

/** A date as precisely as it is known: `2021`, `2021-07` or `2021-07-01`. */
const dateAtPrecision = (
  occurredOn: string,
  precision: FactDatePrecision | null,
): string => {
  switch (precision) {
    // A date without a precision is a day.
    case null:
    case "day": {
      return occurredOn;
    }
    case "month": {
      return occurredOn.slice(0, 7);
    }
    case "year": {
      return occurredOn.slice(0, 4);
    }
    default: {
      precision satisfies never;
      return panic(`Unhandled date precision: ${String(precision)}`);
    }
  }
};

const compareText = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const placeIn = (locator: LegalListSourceLocator): string | null => {
  switch (locator.type) {
    case "pdf-page": {
      return `p. ${String(locator.pageNumber)}`;
    }
    case "docx-block":
    case "document": {
      return null;
    }
    default: {
      locator satisfies never;
      return panic(`Unhandled source locator: ${String(locator)}`);
    }
  }
};

/** Each claim citing a fact, as one line: where it sits, its words and the
 *  verdict reviewers see. */
const citingLines = (page: ChronologyGraphPage): Map<string, string[]> => {
  const statementName = new Map(
    page.statements.map((statement) => [statement.id, statement.name]),
  );
  const claims = new Map(page.claims.map((claim) => [claim.id, claim]));
  const lines = new Map<string, string[]>();
  for (const citation of page.citations) {
    const claim =
      claims.get(citation.claimId) ??
      panic("A graph citation names a claim its page does not carry");
    const statement = statementName.get(claim.statementId) ?? "";
    const place =
      claim.paragraph === null
        ? statement
        : `${statement} ¶ ${String(claim.paragraph)}`;
    const verdict =
      claim.reviewStatus === null
        ? STATE_LABEL[claim.state]
        : `${STATE_LABEL[claim.state]}, ${REVIEW_LABEL[claim.reviewStatus]}`;
    const line = `${place}: ${claim.text} (${verdict})`;
    const cited = lines.get(citation.factId);
    if (cited === undefined) {
      lines.set(citation.factId, [line]);
    } else {
      cited.push(line);
    }
  }
  return lines;
};

/** The first source of each fact, with its page when it has one. */
const firstSources = (page: ChronologyGraphPage): Map<string, string> => {
  const sourceName = new Map(
    page.sources.map((source) => [source.id, source.name]),
  );
  const first = new Map<string, string>();
  for (const edge of page.provenance) {
    if (first.has(edge.factId)) {
      continue;
    }
    const name = sourceName.get(edge.sourceId) ?? "";
    const place = placeIn(edge.locator);
    first.set(edge.factId, place === null ? name : `${name}, ${place}`);
  }
  return first;
};

/**
 * The chronology rows of a list read as one graph page: the facts on the
 * list, dated ones in the order they happened (ties keep the list's order),
 * undated ones last.
 */
export const chronologyRows = (page: ChronologyGraphPage): ChronologyRow[] => {
  const facts = page.facts.filter((fact) => fact.listed);
  const listOrder = new Map(facts.map((fact, index) => [fact.id, index]));
  const citing = citingLines(page);
  const sources = firstSources(page);
  const dated = facts
    .filter((fact) => fact.occurredOn !== null)
    .toSorted(
      (a, b) =>
        // ISO dates order as text.
        compareText(a.occurredOn ?? "", b.occurredOn ?? "") ||
        PRECISION_RANK[a.occurredOnPrecision ?? "day"] -
          PRECISION_RANK[b.occurredOnPrecision ?? "day"] ||
        (listOrder.get(a.id) ?? 0) - (listOrder.get(b.id) ?? 0),
    );
  const undated = facts.filter((fact) => fact.occurredOn === null);
  return [...dated, ...undated].map((fact) => ({
    date:
      fact.occurredOn === null
        ? ""
        : dateAtPrecision(fact.occurredOn, fact.occurredOnPrecision),
    fact: fact.text,
    source: sources.get(fact.id) ?? "",
    claims: citing.get(fact.id)?.join("\n") ?? "",
  }));
};

type ReadChronologyArgs = {
  tx: Pick<Transaction, "select" | "selectDistinctOn">;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
};

export type ReadChronologyOutcome =
  | { type: "list-not-found" }
  /** The list holds more facts, or was verified past more documents or
   *  claims, than one export reads. */
  | { type: "too-large"; bound: "facts" | "documents" }
  | { type: "read"; rows: ChronologyRow[]; runs: GraphRead["runs"] };

/** The chronology of a list, read as one page of its graph that must hold
 *  every verified document whole. */
export const readVerificationChronology = async ({
  tx,
  workspaceId,
  listId,
}: ReadChronologyArgs): Promise<ReadChronologyOutcome> => {
  const read = await readVerificationGraph({
    tx,
    workspaceId,
    listId,
    cursor: null,
    limit: VERIFICATION_LIMITS.CHRONOLOGY_EXPORT_CLAIMS_MAX,
    documents: VERIFICATION_LIMITS.CHRONOLOGY_EXPORT_DOCUMENTS_MAX,
  });
  if (read.type === "list-not-found") {
    return read;
  }
  if (read.graph.factOverflow) {
    return { type: "too-large", bound: "facts" };
  }
  if (read.graph.nextCursor !== null) {
    return { type: "too-large", bound: "documents" };
  }
  return { type: "read", rows: chronologyRows(read.graph), runs: read.runs };
};
