import { describe, expect, test } from "bun:test";

import {
  clauseBodyToPlainText,
  clauseBodyToRichPatch,
} from "@/api/handlers/clauses/clause-to-patch";
import {
  isOutdatedLink,
  isVariantDeleted,
} from "@/api/handlers/clauses/template-links";
import { toSafeId } from "@/api/lib/branded-types";

describe("isOutdatedLink", () => {
  test("true when the pinned version trails the clause's current one", () => {
    expect(
      isOutdatedLink({
        clause: { currentVersion: 3 },
        clauseVersion: { version: 1 },
      }),
    ).toBe(true);
  });

  test("false when the pinned version is current", () => {
    expect(
      isOutdatedLink({
        clause: { currentVersion: 3 },
        clauseVersion: { version: 3 },
      }),
    ).toBe(false);
  });

  test("false for tombstoned links (deleted clause or no pin)", () => {
    expect(
      isOutdatedLink({ clause: null, clauseVersion: { version: 1 } }),
    ).toBe(false);
    expect(
      isOutdatedLink({ clause: { currentVersion: 3 }, clauseVersion: null }),
    ).toBe(false);
  });
});

describe("isVariantDeleted", () => {
  test("true only when the FK was nulled but the label snapshot remains", () => {
    expect(
      isVariantDeleted({ clauseVariantId: null, clauseVariantLabel: "Strict" }),
    ).toBe(true);
    expect(
      isVariantDeleted({
        clauseVariantId: toSafeId<"clauseVariant">("var_1"),
        clauseVariantLabel: "Strict",
      }),
    ).toBe(false);
    expect(
      isVariantDeleted({ clauseVariantId: null, clauseVariantLabel: null }),
    ).toBe(false);
  });
});

describe("clauseBodyToPlainText", () => {
  test("joins paragraph texts with newlines, keeping directives", () => {
    expect(
      clauseBodyToPlainText([
        { text: "{{#if penalty}}", isDirective: true },
        { text: "First paragraph." },
        { text: "Second paragraph.", runs: [{ text: "ignored for text" }] },
      ]),
    ).toBe("{{#if penalty}}\nFirst paragraph.\nSecond paragraph.");
  });

  test("directive paragraphs stay out of the fill patch but in the diff text", () => {
    const body = [
      { text: "{{#if penalty}}", isDirective: true },
      { text: "Visible." },
    ];
    expect(clauseBodyToRichPatch(body)).toEqual({
      paragraphs: [{ runs: [{ text: "Visible." }] }],
    });
    expect(clauseBodyToPlainText(body)).toContain("{{#if penalty}}");
  });
});
