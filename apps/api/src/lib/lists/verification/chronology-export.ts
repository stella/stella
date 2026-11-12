/**
 * A list's chronology as a table to download: one row per fact on the list,
 * in the order it happened as precisely as its date is known, the facts
 * nobody dated last, each with the document it first comes from and the
 * claims that cite it with the verdict reviewers see now.
 *
 * Read through the verification graph (`readVerificationGraph`), page by
 * page, so a row says what the graph says: the same claims, verdicts and
 * sources, read with the same owners (`gradeOf`, `reviewedView`). Bounded:
 * a list holding more facts than the graph carries, or verified past
 * `CHRONOLOGY_EXPORT_PAGES_MAX` pages, is refused, never exported in part.
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
import {
  readVerificationGraph,
  verificationGraphCursor,
} from "@/api/lib/lists/verification/graph-read";
import type {
  ReadVerificationGraphOutcome,
  VerificationGraphCursor,
} from "@/api/lib/lists/verification/graph-read";

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

/**
 * The chronology rows of a list read as graph pages. Every page carries the
 * list's facts; the claims and their links are the union of the pages.
 * Ties on a date keep the list's order.
 */
export const chronologyRows = (
  pages: readonly ChronologyGraphPage[],
): ChronologyRow[] => {
  const first = pages.at(0);
  if (first === undefined) {
    return [];
  }
  const facts = first.facts.filter((fact) => fact.listed);
  const listOrder = new Map(facts.map((fact, index) => [fact.id, index]));
  const sourceName = new Map(
    pages.flatMap((page) =>
      page.sources.map((source) => [source.id, source.name] as const),
    ),
  );
  const statementName = new Map(
    pages.flatMap((page) =>
      page.statements.map(
        (statement) => [statement.id, statement.name] as const,
      ),
    ),
  );
  const claims = new Map(
    pages.flatMap((page) =>
      page.claims.map((claim) => [claim.id, claim] as const),
    ),
  );
  const citingClaims = new Map<string, string[]>();
  for (const citation of pages.flatMap((page) => page.citations)) {
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
    const cited = citingClaims.get(citation.factId) ?? [];
    cited.push(`${place}: ${claim.text} (${verdict})`);
    citingClaims.set(citation.factId, cited);
  }
  const firstSource = new Map<string, string>();
  for (const edge of first.provenance) {
    if (firstSource.has(edge.factId)) {
      continue;
    }
    const name = sourceName.get(edge.sourceId) ?? "";
    const place = placeIn(edge.locator);
    firstSource.set(edge.factId, place === null ? name : `${name}, ${place}`);
  }

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
    source: firstSource.get(fact.id) ?? "",
    claims: (citingClaims.get(fact.id) ?? []).join("\n"),
  }));
};

type ReadChronologyArgs = {
  tx: Pick<Transaction, "select" | "selectDistinctOn">;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
};

export type ReadChronologyOutcome =
  | { type: "list-not-found" }
  /** The list holds more facts, or was verified past more pages, than one
   *  export reads. */
  | { type: "too-large"; bound: "facts" | "pages" }
  | { type: "read"; rows: ChronologyRow[]; runs: GraphRead["runs"] };

/** The chronology of a list, read through every page of its graph. */
export const readVerificationChronology = async ({
  tx,
  workspaceId,
  listId,
}: ReadChronologyArgs): Promise<ReadChronologyOutcome> => {
  const pages: ChronologyGraphPage[] = [];
  // A document split across pages delivers its run on each; it is audited
  // once.
  const runs = new Map<string, GraphRead["runs"][number]>();
  let cursor: VerificationGraphCursor | null = null;
  for (
    let page = 0;
    page < VERIFICATION_LIMITS.CHRONOLOGY_EXPORT_PAGES_MAX;
    page += 1
  ) {
    // db-await-in-loop: each page resumes at the cursor the page before it issued, at most CHRONOLOGY_EXPORT_PAGES_MAX pages.
    const read = await readVerificationGraph({
      tx,
      workspaceId,
      listId,
      cursor,
      limit: VERIFICATION_LIMITS.GRAPH_CLAIMS_PAGE_MAX,
    });
    if (read.type === "list-not-found") {
      return read;
    }
    if (read.graph.factOverflow) {
      return { type: "too-large", bound: "facts" };
    }
    pages.push(read.graph);
    for (const run of read.runs) {
      runs.set(run.id, run);
    }
    if (read.graph.nextCursor === null) {
      return {
        type: "read",
        rows: chronologyRows(pages),
        runs: [...runs.values()],
      };
    }
    cursor =
      verificationGraphCursor.decode(read.graph.nextCursor) ??
      panic("The graph issued a cursor it cannot read");
  }
  return { type: "too-large", bound: "pages" };
};
