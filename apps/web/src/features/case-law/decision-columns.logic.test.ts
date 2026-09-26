import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  DECISION_COLUMN_IDS,
  DECISION_COLUMN_LABEL_KEYS,
  DECISION_COLUMN_WIDTHS,
  DECISION_IDENTITY_LINE_FIELDS,
  decisionColumnLabelKey,
  decisionColumnWidthClassNames,
  decisionIdentityLineFields,
  decisionReferenceColumnKind,
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

describe("what the case-number column is called", () => {
  const docket = { caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER };
  const reporter = {
    caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  };

  test("keeps the case-number label while every row is a docket", () => {
    const kind = decisionReferenceColumnKind([docket, docket]);

    expect(decisionColumnLabelKey("caseNumber", kind)).toBe(
      "caseLaw.columns.caseNumber",
    );
  });

  test("keeps the case-number label for a page with no rows yet", () => {
    expect(
      decisionColumnLabelKey("caseNumber", decisionReferenceColumnKind([])),
    ).toBe("caseLaw.columns.caseNumber");
  });

  test("names the column for any reference once one row is cited by a citation", () => {
    const kind = decisionReferenceColumnKind([docket, reporter]);

    expect(decisionColumnLabelKey("caseNumber", kind)).toBe(
      "caseLaw.columns.reference",
    );
  });

  test("leaves every other column's label alone", () => {
    for (const column of DECISION_COLUMN_IDS) {
      if (column === "caseNumber") {
        continue;
      }
      expect(decisionColumnLabelKey(column, "reference")).toBe(
        DECISION_COLUMN_LABEL_KEYS[column],
      );
    }
  });
});
