import { describe, expect, test } from "bun:test";

import { summarizeRecordField } from "./field-value-logic";
import type { RecordFieldRecord } from "./types";

const record = (name: string): RecordFieldRecord => ({
  name,
  employees: 12,
  closed: null,
});

describe("record cell summary", () => {
  test("an unselected candidate list asks for a choice, never shows the first", () => {
    expect(
      summarizeRecordField(
        {
          status: "resolved",
          result: {
            kind: "candidates",
            records: [record("First a.s."), record("Second s.r.o.")],
            selected: null,
          },
        },
        () => "money",
      ),
    ).toEqual({ type: "choose", count: 2 });
  });

  test("a selection shows the selected record's values", () => {
    expect(
      summarizeRecordField(
        {
          status: "resolved",
          result: {
            kind: "candidates",
            records: [record("First a.s."), record("Second s.r.o.")],
            selected: 1,
          },
        },
        () => "money",
      ),
    ).toEqual({ type: "text", text: "Second s.r.o. · 12" });
  });

  test("a list without a selection is counted", () => {
    expect(
      summarizeRecordField(
        {
          status: "resolved",
          result: {
            kind: "many",
            records: [record("A"), record("B")],
            selected: null,
          },
        },
        () => "money",
      ),
    ).toEqual({ type: "records", count: 2 });
  });

  test("a refused input and a missing record say so", () => {
    expect(
      summarizeRecordField(
        {
          status: "input-needs-review",
          input: { ico: "1" },
          issues: [{ key: "ico", code: "invalid", message: "Checksum" }],
        },
        () => "money",
      ),
    ).toEqual({ type: "needs-review" });
    expect(
      summarizeRecordField(
        {
          status: "not-found",
          input: { ico: "12345678" },
          provenance: {
            url: "https://example.test/",
            retrievedAt: "2026-11-04T12:00:00.000Z",
            sha256: "0".repeat(64),
          },
        },
        () => "money",
      ),
    ).toEqual({ type: "not-found" });
  });
});

test("money in a record is read through the money formatter, never as minor units", () => {
  expect(
    summarizeRecordField(
      {
        status: "resolved",
        result: {
          kind: "one",
          record: { amount: { amountMinor: 12_345, currency: "EUR" } },
        },
      },
      ({ amountMinor, currency }) => `${amountMinor / 100} ${currency}`,
    ),
  ).toEqual({ type: "text", text: "123.45 EUR" });
});
