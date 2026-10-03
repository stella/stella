import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CLAUSE_DIRECTIVES_INVALID_CODE } from "@stll/api-contract";

import { validateClauseBodyDirectives } from "./clause-directives";

const texts = (paragraphs: string[]) => paragraphs.map((text) => ({ text }));

describe("clause directive validation", () => {
  test.each(
    [
      ["{% if enabled %}", "Text"],
      ["{% for item in items %}", "{{ item.name }}", "{% endif %}"],
      ["{% else %}"],
      ["{% endfor %}"],
      ["{% for not_a_loop %}"],
      ["Text {% if enabled %} unfinished"],
      ["{% if enabled %}", "Text {% if other %} unfinished", "{% endif %}"],
    ].map((paragraphs) => ({ paragraphs })),
  )("refuses unbalanced authored paragraphs %j", ({ paragraphs }) => {
    const result = validateClauseBodyDirectives(texts(paragraphs));
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.status).toBe(422);
      expect(result.error.code).toBe(CLAUSE_DIRECTIVES_INVALID_CODE);
      expect(result.error.issues?.length).toBeGreaterThan(0);
      expect(result.error.hint).toContain("save_clause");
    }
  });

  test("reports original paragraph positions even inside inactive branches", () => {
    const result = validateClauseBodyDirectives(
      texts([
        "{% if absent %}",
        "Valid",
        "Text {% if missing %} unfinished",
        "{% endif %}",
      ]),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.issues).toEqual([
        { path: "body.2", message: expect.stringContaining("Paragraph 3:") },
      ]);
    }
  });

  test("directive metadata requires literal marker text", () => {
    const result = validateClauseBodyDirectives([
      { text: "if enabled", isDirective: true, directiveKind: "if" },
    ]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.issues).toContainEqual({
        path: "body.0",
        message: expect.stringContaining("literal"),
      });
    }
  });

  test.each([
    '{{ num("section") }}',
    '{{ ref("section") }}',
    '{{ clause("Terms") }}',
    "{{ name | ai(adapt=true) }}",
  ])("refuses markers requiring template-wide processing: %s", (text) => {
    const result = validateClauseBodyDirectives([{ text }]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.issues?.at(0)?.message).toContain("template body");
    }
  });

  test("accepts placeholders, balanced blocks, nested loops, and ordinary AI declarations", () => {
    const result = validateClauseBodyDirectives(
      texts([
        "{{ name | required }}",
        "{% if enabled %}",
        "{% for item in items %}",
        "Text {% if item.enabled %}{{ item.name }}{% endif %}",
        "{% endfor %}",
        "{% else %}",
        '{{ summary | ai("Summarize the text") }}',
        "{% endif %}",
      ]),
    );
    expect(Result.isError(result)).toBe(false);
  });

  test("inline syntax is read across formatted runs", () => {
    const result = validateClauseBodyDirectives([
      {
        text: "Display",
        runs: [
          { text: "Text {% if" },
          { text: " enabled %} unfinished", bold: true },
        ],
      },
    ]);
    expect(Result.isError(result)).toBe(true);
  });
});
