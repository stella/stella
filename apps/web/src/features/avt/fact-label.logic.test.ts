import { describe, expect, test } from "bun:test";

import { factLabel } from "./fact-label.logic";

const recorded = { medium: "Outlook export p.14", dated: true };

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
        dated: false,
      }),
    ).toEqual({ reference: "BANK-02", statement: "Drawdown authorised." });
  });

  test.each([
    [
      "the source differs from the medium",
      "9 Mar 2021 (Email bundle p.2): Text",
      recorded,
    ],
    [
      "the fact has no recorded date",
      "9 Mar 2021 (Outlook export p.14): Text",
      { ...recorded, dated: false },
    ],
    [
      "the fact has no recorded medium",
      "9 Mar 2021 (Outlook export p.14): Text",
      { medium: null, dated: true },
    ],
    [
      "the lead-in is prose, not a date",
      "Email from the bank about the transfer on 9 March (Outlook export p.14): Text",
      recorded,
    ],
    [
      "the lead-in has no date",
      "Undated (Outlook export p.14): Text",
      recorded,
    ],
    [
      "nothing follows the lead-in",
      "9 Mar 2021 (Outlook export p.14): ",
      recorded,
    ],
  ])("keeps the lead-in when %s", (_, name, fields) => {
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
