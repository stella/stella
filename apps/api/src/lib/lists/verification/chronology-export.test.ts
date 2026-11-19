import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { chronologyRows } from "@/api/lib/lists/verification/chronology-export";
import type { ChronologyGraphPage } from "@/api/lib/lists/verification/chronology-export";

const uuid = (prefix: number, n: number) =>
  `00000000-0000-4000-8${String(prefix)}00-${String(n).padStart(12, "0")}`;
const factId = (n: number) => toSafeId<"entity">(uuid(1, n));
const documentId = (n: number) => toSafeId<"entity">(uuid(2, n));
const runId = (n: number) => toSafeId<"legalListVerificationRun">(uuid(3, n));
const claimId = (n: number) => toSafeId<"legalListClaim">(uuid(4, n));

type Fact = ChronologyGraphPage["facts"][number];

const fact = (
  n: number,
  occurredOn: string | null,
  occurredOnPrecision: Fact["occurredOnPrecision"],
  listed = true,
): Fact => ({
  id: factId(n),
  text: `Fact ${String(n)}`,
  occurredOn,
  occurredOnPrecision,
  tier: "document",
  held: false,
  listed,
});

const statement = (n: number): ChronologyGraphPage["statements"][number] => ({
  id: runId(n),
  entityId: documentId(10 + n),
  fileFieldId: toSafeId<"field">(uuid(5, n)),
  name: `Statement ${String(n)}.docx`,
  finishedAt: null,
  claimCount: 1,
});

const claim = (
  n: number,
  statementNumber: number,
  paragraph: number | null,
): ChronologyGraphPage["claims"][number] => ({
  id: claimId(n),
  statementId: runId(statementNumber),
  position: n,
  paragraph,
  text: `Claim ${String(n)}.`,
  state: "contradicted",
  reviewStatus: n === 2 ? "disputed" : null,
  qualifiers: [],
});

const facts = [
  fact(1, "2021-08-23", "day"),
  fact(2, null, null),
  fact(3, "2021-01-01", "year"),
  fact(4, "2021-08-01", "month"),
  fact(5, "2021-08-01", "day"),
  // A fact off the list that a claim still cites is no row.
  fact(6, "2020-01-01", "day", false),
];

const page = (
  claims: ChronologyGraphPage["claims"],
  statements: ChronologyGraphPage["statements"],
): ChronologyGraphPage => ({
  statements,
  claims,
  facts,
  sources: [
    { id: documentId(1), name: "Ledger.pdf" },
    { id: documentId(2), name: "Email.docx" },
  ],
  citations: claims.map((one) => ({
    type: "cites" as const,
    claimId: one.id,
    factId: factId(1),
    rel: "conflicts" as const,
  })),
  provenance: [
    {
      factId: factId(1),
      sourceId: documentId(1),
      locator: { type: "pdf-page", pageNumber: 3 },
      quote: null,
    },
    {
      factId: factId(1),
      sourceId: documentId(2),
      locator: { type: "document" },
      quote: null,
    },
    {
      factId: factId(3),
      sourceId: documentId(2),
      locator: { type: "document" },
      quote: "Sent in 2021",
    },
  ],
});

describe("chronologyRows", () => {
  test("orders the list's facts as they happened, coarser dates first on a day, undated last", () => {
    const rows = chronologyRows(page([], []));
    expect(rows.map(({ date, fact: text }) => [date, text])).toEqual([
      ["2021", "Fact 3"],
      ["2021-08", "Fact 4"],
      ["2021-08-01", "Fact 5"],
      ["2021-08-23", "Fact 1"],
      ["", "Fact 2"],
    ]);
  });

  test("names the first source with its page, and every citing claim with where it sits and its verdict", () => {
    const rows = chronologyRows(
      page([claim(1, 1, 11), claim(2, 2, null)], [statement(1), statement(2)]),
    );
    const cited = rows.find(({ fact: text }) => text === "Fact 1");
    expect(cited).toEqual({
      date: "2021-08-23",
      fact: "Fact 1",
      source: "Ledger.pdf, p. 3",
      claims: [
        "Statement 1.docx ¶ 11: Claim 1. (Contradicted)",
        "Statement 2.docx: Claim 2. (Contradicted, disputed)",
      ].join("\n"),
    });
    expect(rows.find(({ fact: text }) => text === "Fact 3")?.source).toBe(
      "Email.docx",
    );
  });

  test("a fact off the list is no row, even when a claim cites it", () => {
    const rows = chronologyRows(page([], []));
    expect(rows.map(({ fact: text }) => text)).not.toContain("Fact 6");
  });
});
