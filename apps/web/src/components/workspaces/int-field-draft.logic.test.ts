import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { commitIntFieldDraft } from "@/components/workspaces/int-field-draft.logic";

describe("commitIntFieldDraft", () => {
  test("an empty draft clears a stored value and leaves an empty cell alone", () => {
    expect(commitIntFieldDraft("", 5)).toEqual({ kind: "save", value: null });
    expect(commitIntFieldDraft("   ", 0)).toEqual({
      kind: "save",
      value: null,
    });
    expect(commitIntFieldDraft("", null)).toEqual({ kind: "unchanged" });
  });

  test("0 typed into an empty cell is saved, not mistaken for the empty state", () => {
    expect(commitIntFieldDraft("0", null)).toEqual({ kind: "save", value: 0 });
    expect(commitIntFieldDraft("-0", null)).toEqual({ kind: "save", value: 0 });
    expect(commitIntFieldDraft("0", 0)).toEqual({ kind: "unchanged" });
  });

  test("decimals and other non-integers are refused instead of rounded", () => {
    for (const draft of ["2.75", "2,75", "1e3", "abc", "0x10", "12a", "--1"]) {
      expect(commitIntFieldDraft(draft, 3)).toEqual({ kind: "invalid" });
    }
    expect(commitIntFieldDraft("9007199254740993", null)).toEqual({
      kind: "invalid",
    });
  });

  test("grouping spaces and signs are accepted", () => {
    expect(commitIntFieldDraft("1 000", null)).toEqual({
      kind: "save",
      value: 1000,
    });
    expect(commitIntFieldDraft("1 500 000", 0)).toEqual({
      kind: "save",
      value: 1_500_000,
    });
    expect(commitIntFieldDraft("+7", null)).toEqual({ kind: "save", value: 7 });
    expect(commitIntFieldDraft("-42", 42)).toEqual({
      kind: "save",
      value: -42,
    });
  });

  test("a safe integer's own string round-trips to that integer", () => {
    assertProperty(
      "a safe integer's own string round-trips to that integer",
      fc.property(
        fc.maxSafeInteger().filter((value) => value !== 0),
        fc.option(fc.maxSafeInteger(), { nil: null }),
        (value, stored) => {
          const commit = commitIntFieldDraft(String(value), stored);
          expect(commit).toEqual(
            value === stored ? { kind: "unchanged" } : { kind: "save", value },
          );
        },
      ),
    );
  });
});
