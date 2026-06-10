import { describe, expect, test } from "bun:test";

import { schema } from "../schema";
import { scanDirectives } from "./templateDirectives";

const docOf = (...paragraphs: string[]) =>
  schema.node(
    "doc",
    null,
    paragraphs.map((text) =>
      schema.node("paragraph", null, text ? [schema.text(text)] : null),
    ),
  );

describe("scanDirectives", () => {
  test("recognizes @num and @ref numbering markers as their own kinds", () => {
    const doc = docOf(
      "Clause {{@num:scope}}. Scope of authority.",
      "As set out in Clause {{@ref:scope}}, signed on {{signing_date}}.",
    );
    const tokens = scanDirectives(doc).map((r) => `${r.kind}:${r.expr}`);

    expect(tokens).toContain("num:scope");
    expect(tokens).toContain("ref:scope");
    expect(tokens).toContain("placeholder:signing_date");
    // The numbering markers must not also be claimed as plain placeholders.
    expect(
      tokens.filter((token) => token === "placeholder:@num:scope"),
    ).toEqual([]);
  });

  test("still recognizes clause slots and plain fields alongside them", () => {
    const doc = docOf(
      "Party {{tenant.name}} acts under {{@clause:Indemnity}}.",
    );
    const tokens = scanDirectives(doc)
      .map((r) => `${r.kind}:${r.expr}`)
      .sort();

    expect(tokens).toEqual(["clause:Indemnity", "placeholder:tenant.name"]);
  });

  test("emits mid-line conditional markers as inline (block:false) ranges", () => {
    const doc = docOf(
      "the Buyer{{#if hasSpouse}} and their spouse{{#else}} alone{{/if}} hereby agrees.",
    );
    const tokens = scanDirectives(doc).map(
      (r) => `${r.kind}:${r.expr}:${String(r.block)}`,
    );

    expect(tokens).toEqual([
      "if:hasSpouse:false",
      "else::false",
      "endif::false",
    ]);
  });

  test("inline range positions cover the markers in document order", () => {
    const doc = docOf("A{{#if x}}B{{/if}}C");
    const ranges = scanDirectives(doc);

    expect(ranges).toHaveLength(2);
    const [opener, closer] = ranges;
    expect(opener?.kind).toBe("if");
    expect(closer?.kind).toBe("endif");
    expect(doc.textBetween(opener?.from ?? 0, opener?.to ?? 0)).toBe(
      "{{#if x}}",
    );
    expect(doc.textBetween(closer?.from ?? 0, closer?.to ?? 0)).toBe("{{/if}}");
  });

  test("whole-paragraph directives keep block:true", () => {
    const doc = docOf("{{#if hasSpouse}}", "Spouse paragraph.", "{{/if}}");
    const blockKinds = scanDirectives(doc)
      .filter((r) => r.block)
      .map((r) => r.kind);

    expect(blockKinds).toEqual(["if", "endif"]);
  });

  test("skips mid-line each markers (inline loops are unsupported)", () => {
    const doc = docOf("Items: {{#each items}}{{items.name}}{{/each}} end.");
    const kinds = scanDirectives(doc).map((r) => r.kind);

    expect(kinds).not.toContain("each");
    expect(kinds).not.toContain("endeach");
    // The field inside the would-be loop still gets its chip.
    expect(kinds).toContain("placeholder");
  });
});
