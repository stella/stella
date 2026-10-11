import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { scanRun } from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type { CitationWorkBudget } from "@/api/handlers/case-law/ingestion/us-citation-scanner";

const identityKey = ({ value }: { value: string }) => value;

const scan = (text: string, budget: CitationWorkBudget) =>
  scanRun([{ type: "text", text }], { identityKey, budget });

test("table-supported typography names the same reporter citation", () => {
  const cases = [
    ["137 F3d 246", "137 F.3d 246"],
    ["137 F.Supp.3D 246", "137 F. Supp. 3d 246"],
    ["137 NW2d 246", "137 N.W.2d 246"],
    ["137 P.[2nd] 246", "137 P.2d 246"],
    ["137 S.W.,SecondSeries, 246", "137 S.W.2d 246"],
    ["137   U.\n  S.\t 246", "137 U.S. 246"],
    ["8 U.S., 229", "8 U.S. 229"],
    ["8 U.S.,229", "8 U.S. 229"],
  ] as const;
  for (const [text, canonical] of cases) {
    const result = scan(text, { limit: 10_000, spent: 0 });
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(
      result.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual([canonical]);
  }
});

test("a page delimiter keeps an ambiguous reporter unresolved", () => {
  const result = scan("8 Cranch,229", { limit: 10_000, spent: 0 });
  if (Result.isError(result)) {
    throw result.error;
  }
  expect(
    result.value.events.flatMap((event) =>
      event.kind === "token" && event.token.kind === "full"
        ? [event.token.base]
        : [],
    ),
  ).toEqual([null]);
});

test("a next reference volume never becomes a missing first page", () => {
  const cases = [
    ["137 F.2d 246 F.2d 975", ["246 F.2d 975"]],
    ["319 U.S., 8 U.S. (8 Cranch) 229", ["8 U.S. 229"]],
    ["137 S.W. 246 S.Ct. 2017", ["246 S. Ct. 2017"]],
    ["137 S.W.3d 137 S.W.3d 975", ["137 S.W.3d 975"]],
    ["_ U.S. _, 137 S.Ct. 246 L.Ed.2d 975", ["246 L. Ed. 2d 975"]],
    ["137 U.S.\n246 S.Ct. at 975", []],
  ] as const;
  for (const [text, expected] of cases) {
    const result = scan(text, { limit: 10_000, spent: 0 });
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(
      result.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual(expected.slice());
  }
});

test("an ambiguous next reporter volume is never a pin", () => {
  const result = scan("137 U.S. 246, 8 Cranch at 975", {
    limit: 10_000,
    spent: 0,
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  expect(
    result.value.events.flatMap((event) =>
      event.kind === "token" && event.token.kind === "full"
        ? [event.token.pin]
        : [],
    ),
  ).toEqual([null]);
  expect(
    result.value.events.flatMap((event) =>
      event.kind === "token" ? [event.token.kind] : [],
    ),
  ).toEqual(["full", "volume-reporter"]);
});

test("case-folded footnote pins retain their note kind", () => {
  const result = scan("137 F3d 246, 247 N. 8", {
    limit: 10_000,
    spent: 0,
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  expect(
    result.value.events.flatMap((event) =>
      event.kind === "token" && event.token.kind === "full"
        ? [event.token.pin]
        : [],
    ),
  ).toEqual([
    {
      type: "pin",
      raw: "247 N. 8",
      parts: [
        { kind: "page", start: "247" },
        { kind: "footnote", start: "8" },
      ],
    },
  ]);
});

describe("the scanning budget", () => {
  const cases = {
    "short forms": "Id. ".repeat(1000),
    statutes: "§ 123 ".repeat(1000),
    "unsupported authorities": "1 XYZ 2. ".repeat(1000),
    "electronic citations": "2020 WL 1. ".repeat(1000),
  } as const;

  test("stops producing candidates at the first one past the limit", () => {
    for (const [name, text] of Object.entries(cases)) {
      const budget = { limit: 10, spent: 0 };
      const scanned = scan(text, budget);
      expect({
        name,
        rejected: Result.isError(scanned) ? scanned.error._tag : "accepted",
        spent: budget.spent,
      }).toEqual({ name, rejected: "UsCitationWorkBudgetError", spent: 11 });
    }
  });

  test("admits a run that fits", () => {
    const budget = { limit: 10_000, spent: 0 };
    const scanned = scan(cases["short forms"], budget);
    expect(
      Result.isOk(scanned)
        ? scanned.value.events.filter(({ kind }) => kind === "token").length
        : 0,
    ).toBe(1000);
    expect(budget.spent).toBe(1000);
  });
});
