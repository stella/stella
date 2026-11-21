import { describe, expect, test } from "bun:test";

import { factLabel } from "./fact-label.logic";

const recorded = {
  medium: "Outlook export p.14",
  occurredOn: "2021-03-09",
  precision: "day",
} as const;

describe("factLabel", () => {
  test("lifts the reference and drops a lead-in the row already shows", () => {
    expect(
      factLabel(
        'CAL-01: 9 Mar 2021 (Outlook export p.14): Calendar invitation "Intro" shown as accepted.',
        recorded,
      ),
    ).toEqual({
      reference: "CAL-01",
      statement: 'Calendar invitation "Intro" shown as accepted.',
    });
  });

  test.each([
    ["an ISO date", "2021-03-09", recorded],
    ["a full month name", "9 March 2021", recorded],
    ["a month-first date", "Mar 9, 2021", recorded],
    [
      "a month-precision date",
      "March 2021",
      { ...recorded, occurredOn: "2021-03-01", precision: "month" },
    ],
    [
      "a year-precision date",
      "2021",
      { ...recorded, occurredOn: "2021-01-01", precision: "year" },
    ],
  ] as const)("drops a lead-in written as %s", (_, date, fields) => {
    expect(
      factLabel(`${date} (Outlook export p.14): Text`, fields).statement,
    ).toBe("Text");
  });

  test("keeps a plain statement unchanged", () => {
    expect(factLabel("The payment date is disputed", recorded)).toEqual({
      reference: null,
      statement: "The payment date is disputed",
    });
  });

  test("lifts a reference even when nothing else is recorded", () => {
    expect(
      factLabel("BANK-02: Drawdown authorised.", {
        medium: null,
        occurredOn: null,
        precision: null,
      }),
    ).toEqual({ reference: "BANK-02", statement: "Drawdown authorised." });
  });

  test.each([
    [
      "the lead-in is digit-bearing prose",
      "Invoice 123 (Outlook export p.14): Paid",
      recorded,
    ],
    [
      "the lead-in date differs from the recorded date",
      "10 Mar 2021 (Outlook export p.14): Text",
      recorded,
    ],
    [
      "the lead-in is more precise than the recorded date",
      "9 Mar 2021 (Outlook export p.14): Text",
      { ...recorded, occurredOn: "2021-03-01", precision: "month" },
    ],
    [
      "the lead-in is less precise than the recorded date",
      "March 2021 (Outlook export p.14): Text",
      recorded,
    ],
    [
      "the source differs from the medium",
      "9 Mar 2021 (Email bundle p.2): Text",
      recorded,
    ],
    [
      "the fact has no recorded date",
      "9 Mar 2021 (Outlook export p.14): Text",
      { ...recorded, occurredOn: null, precision: null },
    ],
    [
      "the fact has no recorded medium",
      "9 Mar 2021 (Outlook export p.14): Text",
      { ...recorded, medium: null },
    ],
    [
      "the month word is not a month",
      "9 Mayday 2021 (Outlook export p.14): Text",
      recorded,
    ],
    [
      "nothing follows the lead-in",
      "9 Mar 2021 (Outlook export p.14): ",
      recorded,
    ],
  ] as const)("keeps the lead-in when %s", (_, name, fields) => {
    expect(factLabel(name, fields).statement).toBe(name);
  });

  test.each([
    "Note: the payment was late",
    "cal-01: lowercase is prose",
    "CAL01: no separator",
    "CAL-01 missing colon",
  ])("does not read %p as a reference", (name) => {
    expect(factLabel(name, recorded).reference).toBeNull();
  });
});
