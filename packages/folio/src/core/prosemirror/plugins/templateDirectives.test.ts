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
});
