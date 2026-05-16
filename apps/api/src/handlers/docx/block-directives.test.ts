import { describe, expect, test } from "bun:test";
import * as slimdom from "slimdom";

import {
  evaluateCondition,
  flattenTemplateData,
  parseBlockTree,
  processBlockDirectives,
  resolvePath,
  scanBlockDirectives,
} from "./block-directives";
import { paragraphText, W_NS } from "./ooxml";

// ── Helpers ──────────────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const parseBody = (xml: string): slimdom.Element => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    throw new Error("No w:body element found");
  }
  return body;
};

/** Collect all paragraph texts from a body element. */
const bodyTexts = (body: slimdom.Element): string[] => {
  const ps = body.getElementsByTagNameNS(W_NS, "p");
  return [...ps].map((p) => paragraphText(p));
};

// ── evaluateCondition ────────────────────────────────────

describe("evaluateCondition", () => {
  test("truthiness: string present", () => {
    expect(evaluateCondition("name", { name: "Alice" })).toBe(true);
  });

  test("truthiness: empty string", () => {
    expect(evaluateCondition("name", { name: "" })).toBe(false);
  });

  test("truthiness: missing key", () => {
    expect(evaluateCondition("name", {})).toBe(false);
  });

  test("truthiness: boolean true", () => {
    expect(
      evaluateCondition("has_guarantor", {
        has_guarantor: true,
      }),
    ).toBe(true);
  });

  test("truthiness: boolean false", () => {
    expect(
      evaluateCondition("has_guarantor", {
        has_guarantor: false,
      }),
    ).toBe(false);
  });

  test("truthiness: number zero", () => {
    expect(evaluateCondition("count", { count: 0 })).toBe(false);
  });

  test("truthiness: number non-zero", () => {
    expect(evaluateCondition("count", { count: 5 })).toBe(true);
  });

  test("truthiness: non-empty array", () => {
    expect(evaluateCondition("items", { items: [1, 2] })).toBe(true);
  });

  test("truthiness: empty array", () => {
    expect(evaluateCondition("items", { items: [] })).toBe(false);
  });

  test("negation: !truthy", () => {
    expect(
      evaluateCondition("!is_individual", {
        is_individual: true,
      }),
    ).toBe(false);
  });

  test("negation: !falsy", () => {
    expect(
      evaluateCondition("!is_individual", {
        is_individual: false,
      }),
    ).toBe(true);
  });

  test("negation: !missing", () => {
    expect(evaluateCondition("!missing", {})).toBe(true);
  });

  test("equality: string ==", () => {
    expect(
      evaluateCondition('jurisdiction == "CZ"', {
        jurisdiction: "CZ",
      }),
    ).toBe(true);
  });

  test("equality: string == mismatch", () => {
    expect(
      evaluateCondition('jurisdiction == "CZ"', {
        jurisdiction: "SK",
      }),
    ).toBe(false);
  });

  test("inequality: !=", () => {
    expect(
      evaluateCondition('jurisdiction != "CZ"', {
        jurisdiction: "SK",
      }),
    ).toBe(true);
  });

  test("numeric: >", () => {
    expect(evaluateCondition("price > 10000", { price: 15_000 })).toBe(true);
  });

  test("numeric: > false", () => {
    expect(evaluateCondition("price > 10000", { price: 5000 })).toBe(false);
  });

  test("numeric: >=", () => {
    expect(evaluateCondition("price >= 10000", { price: 10_000 })).toBe(true);
  });

  test("numeric: <", () => {
    expect(evaluateCondition("shares < 50", { shares: 30 })).toBe(true);
  });

  test("numeric: <=", () => {
    expect(evaluateCondition("shares <= 50", { shares: 50 })).toBe(true);
  });

  test("numeric underscores: 10_000", () => {
    expect(
      evaluateCondition("price >= 10_000", {
        price: 10_000,
      }),
    ).toBe(true);
  });

  test("logical: and (both true)", () => {
    expect(
      evaluateCondition("has_guarantor and is_company", {
        has_guarantor: true,
        is_company: true,
      }),
    ).toBe(true);
  });

  test("logical: and (one false)", () => {
    expect(
      evaluateCondition("has_guarantor and is_company", {
        has_guarantor: true,
        is_company: false,
      }),
    ).toBe(false);
  });

  test("logical: or (one true)", () => {
    expect(evaluateCondition("a or b", { a: false, b: true })).toBe(true);
  });

  test("logical: or (both false)", () => {
    expect(evaluateCondition("a or b", { a: false, b: false })).toBe(false);
  });

  test("precedence: and binds tighter than or", () => {
    // "a or b and c" → a or (b and c)
    // false or (true and true) → true
    expect(
      evaluateCondition("a or b and c", {
        a: false,
        b: true,
        c: true,
      }),
    ).toBe(true);

    // false or (true and false) → false
    expect(
      evaluateCondition("a or b and c", {
        a: false,
        b: true,
        c: false,
      }),
    ).toBe(false);
  });

  test("dotted path in condition", () => {
    expect(
      evaluateCondition('company.type == "LLC"', {
        company: { type: "LLC" },
      }),
    ).toBe(true);
  });

  test("negation with comparison", () => {
    expect(
      evaluateCondition('!jurisdiction == "CZ"', {
        jurisdiction: "CZ",
      }),
    ).toBe(false);
  });

  test("combined: negation and or", () => {
    expect(
      evaluateCondition("!has_guarantor or price <= 5000", {
        has_guarantor: false,
        price: 10_000,
      }),
    ).toBe(true);
  });

  test("empty expression", () => {
    expect(evaluateCondition("", {})).toBe(false);
  });
});

// ── resolvePath ──────────────────────────────────────────

describe("resolvePath", () => {
  test("simple key", () => {
    expect(resolvePath("name", { name: "Alice" })).toBe("Alice");
  });

  test("nested key", () => {
    expect(
      resolvePath("company.name", {
        company: { name: "Acme" },
      }),
    ).toBe("Acme");
  });

  test("deeply nested", () => {
    expect(resolvePath("a.b.c", { a: { b: { c: 42 } } })).toBe(42);
  });

  test("missing key returns undefined", () => {
    expect(resolvePath("missing", {})).toBeUndefined();
  });

  test("missing nested key returns undefined", () => {
    expect(resolvePath("a.b.c", { a: { b: {} } })).toBeUndefined();
  });

  test("null in path returns undefined", () => {
    expect(resolvePath("a.b", { a: null })).toBeUndefined();
  });
});

// ── flattenTemplateData ──────────────────────────────────

describe("flattenTemplateData", () => {
  test("flat string values", () => {
    expect(flattenTemplateData({ name: "Alice", city: "Prague" })).toEqual({
      name: "Alice",
      city: "Prague",
    });
  });

  test("nested objects", () => {
    expect(
      flattenTemplateData({
        company: { name: "Acme", id: "123" },
      }),
    ).toEqual({
      "company.name": "Acme",
      "company.id": "123",
    });
  });

  test("numbers become strings", () => {
    expect(flattenTemplateData({ price: 1000 })).toEqual({
      price: "1000",
    });
  });

  test("booleans become strings", () => {
    expect(flattenTemplateData({ active: true })).toEqual({ active: "true" });
  });

  test("arrays are skipped", () => {
    expect(
      flattenTemplateData({
        name: "Alice",
        items: [{ x: 1 }],
      }),
    ).toEqual({ name: "Alice" });
  });

  test("deeply nested objects", () => {
    expect(
      flattenTemplateData({
        a: { b: { c: "deep" } },
      }),
    ).toEqual({ "a.b.c": "deep" });
  });
});

// ── scanBlockDirectives ──────────────────────────────────

describe("scanBlockDirectives", () => {
  test("finds #if and /if", () => {
    const xml = WRAP(
      [
        P("Intro"),
        P("{{#if has_guarantor}}"),
        P("Guarantor clause"),
        P("{{/if}}"),
        P("Outro"),
      ].join(""),
    );
    const body = parseBody(xml);
    const directives = scanBlockDirectives(body);

    expect(directives).toEqual([
      {
        kind: "if",
        expression: "has_guarantor",
        paragraphIndex: 1,
      },
      { kind: "endif", expression: "", paragraphIndex: 3 },
    ]);
  });

  test("finds #each and /each", () => {
    const xml = WRAP(
      [P("{{#each sellers}}"), P("{{sellers.name}}"), P("{{/each}}")].join(""),
    );
    const body = parseBody(xml);
    const directives = scanBlockDirectives(body);

    expect(directives).toEqual([
      {
        kind: "each",
        expression: "sellers",
        paragraphIndex: 0,
      },
      {
        kind: "endeach",
        expression: "",
        paragraphIndex: 2,
      },
    ]);
  });

  test("finds #elseif and #else", () => {
    const xml = WRAP(
      [
        P('{{#if jurisdiction == "CZ"}}'),
        P("Czech clause"),
        P('{{#elseif jurisdiction == "SK"}}'),
        P("Slovak clause"),
        P("{{#else}}"),
        P("ICC clause"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    const directives = scanBlockDirectives(body);

    expect(directives).toHaveLength(4);
    expect(directives[0]?.kind).toBe("if");
    expect(directives[1]?.kind).toBe("elseif");
    expect(directives[2]?.kind).toBe("else");
    expect(directives[3]?.kind).toBe("endif");
  });

  test("ignores non-directive paragraphs", () => {
    const xml = WRAP([P("Hello {{name}}"), P("Price: {{price}}")].join(""));
    const body = parseBody(xml);
    const directives = scanBlockDirectives(body);

    expect(directives).toEqual([]);
  });

  test("handles extra whitespace", () => {
    const xml = WRAP(
      [P("  {{#if   has_guarantor  }}  "), P("Content"), P("  {{/if}}  ")].join(
        "",
      ),
    );
    const body = parseBody(xml);
    const directives = scanBlockDirectives(body);

    expect(directives).toHaveLength(2);
    expect(directives[0]?.expression).toBe("has_guarantor");
  });
});

// ── parseBlockTree ───────────────────────────────────────

describe("parseBlockTree", () => {
  test("simple if block", () => {
    const directives = [
      { kind: "if" as const, expression: "x", paragraphIndex: 1 },
      { kind: "endif" as const, expression: "", paragraphIndex: 3 },
    ];
    const { blocks, errors } = parseBlockTree(directives);

    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(1);
    const ifBlock = blocks[0];
    if (ifBlock?.kind !== "if") {
      throw new Error(`Expected an 'if' block, got ${ifBlock?.kind ?? "none"}`);
    }
    expect(ifBlock.branches).toHaveLength(1);
    expect(ifBlock.branches[0]?.condition).toBe("x");
    expect(ifBlock.branches[0]?.contentStart).toBe(2);
    expect(ifBlock.branches[0]?.contentEnd).toBe(3);
  });

  test("if/else block", () => {
    const directives = [
      { kind: "if" as const, expression: "x", paragraphIndex: 0 },
      { kind: "else" as const, expression: "", paragraphIndex: 2 },
      { kind: "endif" as const, expression: "", paragraphIndex: 4 },
    ];
    const { blocks, errors } = parseBlockTree(directives);

    expect(errors).toEqual([]);
    const ifBlock = blocks[0];
    if (ifBlock?.kind !== "if") {
      throw new Error(`Expected an 'if' block, got ${ifBlock?.kind ?? "none"}`);
    }
    expect(ifBlock.branches).toHaveLength(2);
    expect(ifBlock.branches[0]?.condition).toBe("x");
    expect(ifBlock.branches[1]?.condition).toBe(""); // else
  });

  test("if/elseif/else block", () => {
    const directives = [
      { kind: "if" as const, expression: "a", paragraphIndex: 0 },
      { kind: "elseif" as const, expression: "b", paragraphIndex: 2 },
      { kind: "else" as const, expression: "", paragraphIndex: 4 },
      { kind: "endif" as const, expression: "", paragraphIndex: 6 },
    ];
    const { blocks, errors } = parseBlockTree(directives);

    expect(errors).toEqual([]);
    const ifBlock = blocks[0];
    if (ifBlock?.kind !== "if") {
      throw new Error(`Expected an 'if' block, got ${ifBlock?.kind ?? "none"}`);
    }
    expect(ifBlock.branches).toHaveLength(3);
    expect(ifBlock.branches[0]?.condition).toBe("a");
    expect(ifBlock.branches[1]?.condition).toBe("b");
    expect(ifBlock.branches[2]?.condition).toBe(""); // else
  });

  test("simple each block", () => {
    const directives = [
      {
        kind: "each" as const,
        expression: "sellers",
        paragraphIndex: 0,
      },
      {
        kind: "endeach" as const,
        expression: "",
        paragraphIndex: 3,
      },
    ];
    const { blocks, errors } = parseBlockTree(directives);

    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(1);
    const each = blocks[0];
    if (each?.kind !== "each") {
      throw new Error(`Expected an 'each' block, got ${each?.kind ?? "none"}`);
    }
    expect(each.arrayPath).toBe("sellers");
    expect(each.contentStart).toBe(1);
    expect(each.contentEnd).toBe(3);
  });

  test("unclosed #if reports error", () => {
    const directives = [
      { kind: "if" as const, expression: "x", paragraphIndex: 0 },
    ];
    const { errors } = parseBlockTree(directives);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unclosed");
  });

  test("unclosed #each reports error", () => {
    const directives = [
      {
        kind: "each" as const,
        expression: "items",
        paragraphIndex: 0,
      },
    ];
    const { errors } = parseBlockTree(directives);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unclosed");
  });

  test("orphaned /if reports error", () => {
    const directives = [
      { kind: "endif" as const, expression: "", paragraphIndex: 5 },
    ];
    const { errors } = parseBlockTree(directives);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Orphaned");
  });

  test("mismatched close: /each inside #if", () => {
    const directives = [
      { kind: "if" as const, expression: "x", paragraphIndex: 0 },
      {
        kind: "endeach" as const,
        expression: "",
        paragraphIndex: 2,
      },
    ];
    const { errors } = parseBlockTree(directives);

    expect(errors.length).toBeGreaterThan(0);
  });
});

// ── DOM integration: conditionals ────────────────────────

describe("processBlockDirectives — conditionals", () => {
  test("if-true keeps content", () => {
    const xml = WRAP(
      [
        P("Intro"),
        P("{{#if has_guarantor}}"),
        P("Guarantor clause"),
        P("{{/if}}"),
        P("Outro"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { has_guarantor: true });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Intro", "Guarantor clause", "Outro"]);
  });

  test("if-false removes content", () => {
    const xml = WRAP(
      [
        P("Intro"),
        P("{{#if has_guarantor}}"),
        P("Guarantor clause"),
        P("{{/if}}"),
        P("Outro"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { has_guarantor: false });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Intro", "Outro"]);
  });

  test("if/else: true branch", () => {
    const xml = WRAP(
      [
        P("{{#if is_company}}"),
        P("Company info"),
        P("{{#else}}"),
        P("Individual info"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { is_company: true });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Company info"]);
  });

  test("if/else: false branch (else)", () => {
    const xml = WRAP(
      [
        P("{{#if is_company}}"),
        P("Company info"),
        P("{{#else}}"),
        P("Individual info"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { is_company: false });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Individual info"]);
  });

  test("if/elseif/else: first branch", () => {
    const xml = WRAP(
      [
        P('{{#if jurisdiction == "CZ"}}'),
        P("Czech clause"),
        P('{{#elseif jurisdiction == "SK"}}'),
        P("Slovak clause"),
        P("{{#else}}"),
        P("ICC clause"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { jurisdiction: "CZ" });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Czech clause"]);
  });

  test("if/elseif/else: second branch", () => {
    const xml = WRAP(
      [
        P('{{#if jurisdiction == "CZ"}}'),
        P("Czech clause"),
        P('{{#elseif jurisdiction == "SK"}}'),
        P("Slovak clause"),
        P("{{#else}}"),
        P("ICC clause"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { jurisdiction: "SK" });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Slovak clause"]);
  });

  test("if/elseif/else: else branch", () => {
    const xml = WRAP(
      [
        P('{{#if jurisdiction == "CZ"}}'),
        P("Czech clause"),
        P('{{#elseif jurisdiction == "SK"}}'),
        P("Slovak clause"),
        P("{{#else}}"),
        P("ICC clause"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { jurisdiction: "DE" });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["ICC clause"]);
  });

  test("negation in condition", () => {
    const xml = WRAP(
      [
        P("{{#if !is_individual}}"),
        P("Company: {{company_id}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { is_individual: false });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Company: {{company_id}}"]);
  });

  test("nested if blocks", () => {
    const xml = WRAP(
      [
        P("{{#if is_company}}"),
        P("{{#if has_guarantor}}"),
        P("Company with guarantor"),
        P("{{/if}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {
      is_company: true,
      has_guarantor: true,
    });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Company with guarantor"]);
  });

  test("nested if: inner false", () => {
    const xml = WRAP(
      [
        P("{{#if is_company}}"),
        P("Company"),
        P("{{#if has_guarantor}}"),
        P("With guarantor"),
        P("{{/if}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {
      is_company: true,
      has_guarantor: false,
    });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Company"]);
  });

  test("nested if: outer false removes all", () => {
    const xml = WRAP(
      [
        P("{{#if is_company}}"),
        P("{{#if has_guarantor}}"),
        P("Guarantor"),
        P("{{/if}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {
      is_company: false,
      has_guarantor: true,
    });

    const texts = bodyTexts(body);
    expect(texts).toEqual([]);
  });

  test("adjacent if blocks", () => {
    const xml = WRAP(
      [
        P("{{#if a}}"),
        P("Block A"),
        P("{{/if}}"),
        P("{{#if b}}"),
        P("Block B"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { a: true, b: false });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Block A"]);
  });

  test("empty if block (no content paragraphs)", () => {
    const xml = WRAP(
      [P("Before"), P("{{#if x}}"), P("{{/if}}"), P("After")].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { x: true });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Before", "After"]);
  });

  test("multi-paragraph content in if", () => {
    const xml = WRAP(
      [
        P("{{#if show}}"),
        P("Line 1"),
        P("Line 2"),
        P("Line 3"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { show: true });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Line 1", "Line 2", "Line 3"]);
  });
});

// ── DOM integration: loops ───────────────────────────────

describe("processBlockDirectives — loops", () => {
  test("each with multiple items", () => {
    const xml = WRAP(
      [
        P("Sellers:"),
        P("{{#each sellers}}"),
        P("Name: {{sellers.name}}"),
        P("{{/each}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    const { patchValues } = processBlockDirectives(body, {
      sellers: [{ name: "Alice" }, { name: "Bob" }],
    });

    const texts = bodyTexts(body);
    expect(texts).toHaveLength(3); // "Sellers:" + 2 expanded
    expect(texts[0]).toBe("Sellers:");
    // Expanded placeholders should reference indexed keys
    expect(texts[1]).toContain("__each_sellers_0_name");
    expect(texts[2]).toContain("__each_sellers_1_name");

    // Patch values should have the indexed entries
    expect(patchValues["__each_sellers_0_name"]).toBe("Alice");
    expect(patchValues["__each_sellers_1_name"]).toBe("Bob");
  });

  test("each with zero items removes block", () => {
    const xml = WRAP(
      [
        P("Before"),
        P("{{#each items}}"),
        P("Item: {{items.name}}"),
        P("{{/each}}"),
        P("After"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { items: [] });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Before", "After"]);
  });

  test("each with multi-paragraph body", () => {
    const xml = WRAP(
      [
        P("{{#each sellers}}"),
        P("Name: {{sellers.name}}"),
        P("Address: {{sellers.address}}"),
        P("{{/each}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    const { patchValues } = processBlockDirectives(body, {
      sellers: [
        { name: "Alice", address: "Prague" },
        { name: "Bob", address: "Bratislava" },
      ],
    });

    const texts = bodyTexts(body);
    // 2 items × 2 paragraphs each = 4
    expect(texts).toHaveLength(4);
    expect(patchValues["__each_sellers_0_name"]).toBe("Alice");
    expect(patchValues["__each_sellers_0_address"]).toBe("Prague");
    expect(patchValues["__each_sellers_1_name"]).toBe("Bob");
    expect(patchValues["__each_sellers_1_address"]).toBe("Bratislava");
  });

  test("each with missing array path removes block", () => {
    const xml = WRAP(
      [P("{{#each missing}}"), P("Content"), P("{{/each}}")].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {});

    const texts = bodyTexts(body);
    expect(texts).toEqual([]);
  });

  test("each preserves formatting", () => {
    // Paragraph with bold run
    const xml = WRAP(
      [
        "<w:p><w:r><w:t>{{#each items}}</w:t></w:r></w:p>",
        "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold: {{items.x}}</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>{{/each}}</w:t></w:r></w:p>",
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {
      items: [{ x: "1" }, { x: "2" }],
    });

    const ps = body.getElementsByTagNameNS(W_NS, "p");
    // Both expanded paragraphs should have w:b
    for (const p of ps) {
      const bold = p.getElementsByTagNameNS(W_NS, "b");
      expect(bold.length).toBe(1);
    }
  });
});

// ── Combined: conditionals + loops ───────────────────────

describe("processBlockDirectives — combined", () => {
  test("conditional inside loop", () => {
    const xml = WRAP(
      [
        P("{{#each sellers}}"),
        P("{{#if sellers.is_company}}"),
        P("Company: {{sellers.name}}"),
        P("{{/if}}"),
        P("{{/each}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    const { patchValues } = processBlockDirectives(body, {
      sellers: [
        { name: "Alice Corp", is_company: true },
        { name: "Bob", is_company: false },
      ],
    });

    const texts = bodyTexts(body);
    // Only Alice Corp's company line should survive
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("__each_sellers_0_name");
    expect(patchValues["__each_sellers_0_name"]).toBe("Alice Corp");
  });

  test("loop inside conditional", () => {
    const xml = WRAP(
      [
        P("{{#if has_sellers}}"),
        P("Sellers:"),
        P("{{#each sellers}}"),
        P("- {{sellers.name}}"),
        P("{{/each}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    const { patchValues } = processBlockDirectives(body, {
      has_sellers: true,
      sellers: [{ name: "Alice" }, { name: "Bob" }],
    });

    const texts = bodyTexts(body);
    expect(texts).toHaveLength(3); // "Sellers:" + 2 items
    expect(patchValues["__each_sellers_0_name"]).toBe("Alice");
    expect(patchValues["__each_sellers_1_name"]).toBe("Bob");
  });

  test("loop inside false conditional is removed", () => {
    const xml = WRAP(
      [
        P("{{#if has_sellers}}"),
        P("{{#each sellers}}"),
        P("- {{sellers.name}}"),
        P("{{/each}}"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, {
      has_sellers: false,
      sellers: [{ name: "Alice" }],
    });

    const texts = bodyTexts(body);
    expect(texts).toEqual([]);
  });
});

// ── Edge cases ───────────────────────────────────────────

describe("processBlockDirectives — edge cases", () => {
  test("split runs in directive", () => {
    // Directive text split across multiple w:r/w:t runs
    const xml = WRAP(
      [
        "<w:p><w:r><w:t>{{#if </w:t></w:r><w:r><w:t>show}}</w:t></w:r></w:p>",
        P("Visible"),
        P("{{/if}}"),
      ].join(""),
    );
    const body = parseBody(xml);
    processBlockDirectives(body, { show: true });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Visible"]);
  });

  test("no directives is a no-op", () => {
    const xml = WRAP([P("Hello {{name}}"), P("World")].join(""));
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      name: "Alice",
    });

    const texts = bodyTexts(body);
    expect(texts).toEqual(["Hello {{name}}", "World"]);
    expect(errors).toEqual([]);
  });

  test("returns structural errors", () => {
    const xml = WRAP(
      [
        P("{{#if x}}"),
        P("Content"),
        // Missing {{/if}}
      ].join(""),
    );
    const body = parseBody(xml);
    const { errors } = processBlockDirectives(body, {
      x: true,
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("Unclosed");
  });
});
