import { describe, expect, test } from "bun:test";

import {
  applyFieldSuggestions,
  type FieldSuggestion,
} from "./apply-field-suggestions";

const wt = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("applyFieldSuggestions", () => {
  test("replaces literals with markers and emits manifest fields (PoA values)", () => {
    const docXml = [
      "<w:body>",
      wt("Acting on behalf of ROKA NIERUCHOMOŚCI Sp. z o.o."),
      wt("Jan Kowalski"),
      wt("Prezes Zarządu"),
      wt("Scope: registration matters"),
      "</w:body>",
    ].join("");

    const suggestions: FieldSuggestion[] = [
      {
        literalText: "ROKA NIERUCHOMOŚCI Sp. z o.o.",
        fieldPath: "company.name",
      },
      { literalText: "Jan Kowalski", fieldPath: "signatory.name" },
      {
        literalText: "Prezes Zarządu",
        fieldPath: "signatory.role",
        inputType: "text",
      },
      {
        literalText: "registration matters",
        fieldPath: "scope",
        aiPrompt: "Draft the scope of this power of attorney",
      },
    ];

    const { xml, fields, unapplied } = applyFieldSuggestions(
      docXml,
      suggestions,
    );

    expect(xml).toContain("Acting on behalf of {{company.name}}");
    expect(xml).toContain(">{{signatory.name}}<");
    expect(xml).toContain(">{{signatory.role}}<");
    expect(xml).toContain("Scope: {{scope}}");
    expect(unapplied).toEqual([]);
    expect(fields).toEqual([
      { path: "company.name" },
      { path: "signatory.name" },
      { path: "signatory.role", inputType: "text" },
      {
        path: "scope",
        aiPrompt: "Draft the scope of this power of attorney",
      },
    ]);
  });

  test("reports a literal split across runs as unapplied (single-run scope)", () => {
    const docXml =
      "<w:body><w:p><w:r><w:t>Jan </w:t></w:r><w:r><w:t>Kowalski</w:t></w:r></w:p></w:body>";
    const suggestions: FieldSuggestion[] = [
      { literalText: "Jan Kowalski", fieldPath: "signatory.name" },
    ];
    const { xml, fields, unapplied } = applyFieldSuggestions(
      docXml,
      suggestions,
    );
    expect(xml).toBe(docXml); // unchanged
    expect(fields).toEqual([]);
    expect(unapplied).toEqual(suggestions);
  });

  test("only rewrites text nodes, never tags or attributes", () => {
    // A contrived literal that also appears inside a tag must not corrupt markup.
    const docXml = `<w:body>${wt("type is w:t here")}</w:body>`;
    const { xml } = applyFieldSuggestions(docXml, [
      { literalText: "w:t", fieldPath: "x" },
    ]);
    // The <w:t> tags themselves are intact; only the text content changed.
    expect(xml.startsWith("<w:body><w:p><w:r><w:t")).toBe(true);
    expect(xml).toContain("type is {{x}} here");
  });

  test("dedupes a repeated field path and skips empty entries", () => {
    const docXml = `<w:body>${wt("ACME and ACME again")}</w:body>`;
    const { xml, fields } = applyFieldSuggestions(docXml, [
      { literalText: "ACME", fieldPath: "co" },
      { literalText: "", fieldPath: "ignored" },
    ]);
    expect(xml).toContain("{{co}} and {{co}} again");
    expect(fields).toEqual([{ path: "co" }]);
  });
});
