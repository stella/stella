import { describe, expect, test } from "bun:test";

import {
  DECISION_COLUMN_IDS,
  DECISION_COLUMN_WIDTHS,
  DECISION_IDENTITY_LINE_FIELDS,
  decisionColumnWidthClassNames,
  decisionIdentityLineFields,
  DEFAULT_HIDDEN_DECISION_COLUMN_IDS,
} from "@/features/case-law/decision-columns.logic";

const visibleByDefault = DECISION_COLUMN_IDS.filter(
  (id) => !DEFAULT_HIDDEN_DECISION_COLUMN_IDS.some((hidden) => hidden === id),
);

describe("what the case-number cell has to say itself", () => {
  test("says nothing while every fact has a column of its own", () => {
    expect(decisionIdentityLineFields(DECISION_COLUMN_IDS)).toEqual([]);
  });

  test("carries exactly the facts whose columns are hidden", () => {
    expect(decisionIdentityLineFields(["caseNumber", "summary"])).toEqual([
      "court",
      "date",
      "type",
    ]);
    expect(
      decisionIdentityLineFields(["caseNumber", "summary", "date"]),
    ).toEqual(["court", "type"]);
  });

  test("never repeats a fact a visible column is already showing", () => {
    for (const field of DECISION_IDENTITY_LINE_FIELDS) {
      expect(decisionIdentityLineFields([field])).not.toContain(field);
    }
  });

  test("keeps the reading order of the line whatever order columns are hidden in", () => {
    expect(
      decisionIdentityLineFields(["type", "caseNumber"].toReversed()),
    ).toEqual(["court", "date"]);
  });
});

describe("how wide a column may get", () => {
  test("lets exactly the prose columns absorb the slack, so the row fits its container", () => {
    const prose = DECISION_COLUMN_IDS.filter(
      (id) => DECISION_COLUMN_WIDTHS[id] === "prose",
    );

    expect(prose).toEqual(["summary", "headnote"]);
    for (const id of prose) {
      expect(decisionColumnWidthClassNames(id).head).toBe("w-full");
      expect(decisionColumnWidthClassNames(id).cell).toContain(
        "whitespace-normal",
      );
    }
  });

  test("keeps every other column on one line at its natural width", () => {
    for (const id of DECISION_COLUMN_IDS) {
      if (DECISION_COLUMN_WIDTHS[id] === "prose") {
        continue;
      }
      expect(decisionColumnWidthClassNames(id)).toEqual({
        head: "w-px",
        cell: "whitespace-nowrap",
      });
    }
  });

  test("no prose column ever keeps the nowrap the shared cell applies", () => {
    for (const id of DECISION_COLUMN_IDS) {
      expect(decisionColumnWidthClassNames(id).cell).not.toContain(
        "whitespace-nowrap whitespace-normal",
      );
      const { cell } = decisionColumnWidthClassNames(id);
      expect(
        cell.includes("whitespace-nowrap") &&
          cell.includes("whitespace-normal"),
      ).toBe(false);
    }
  });

  test("the default row has one column that can give, and it is the hook", () => {
    const flexible = visibleByDefault.filter(
      (id) => DECISION_COLUMN_WIDTHS[id] === "prose",
    );

    expect(flexible).toEqual(["summary"]);
  });
});

describe("the columns a reader sees before choosing", () => {
  test("leads with identity, then the hook, then the signals", () => {
    expect(visibleByDefault).toEqual([
      "caseNumber",
      "summary",
      "court",
      "date",
      "type",
      "citedBy",
    ]);
  });

  test("hides the headnote column, which the summary column already shows", () => {
    expect(DEFAULT_HIDDEN_DECISION_COLUMN_IDS).toContain("headnote");
    expect(visibleByDefault).toContain("summary");
  });

  test("leaves the default identity line carrying nothing, because its columns show", () => {
    expect(decisionIdentityLineFields(visibleByDefault)).toEqual([]);
  });
});
