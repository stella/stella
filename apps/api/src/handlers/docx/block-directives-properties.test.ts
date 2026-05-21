/**
 * Property-based tests for the block-directive engine.
 *
 * Each test targets an invariant that was violated by a bug
 * found during code review. The generators produce a wide
 * variety of inputs so regressions are caught even for edge
 * cases that hand-written examples miss.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import {
  evaluateCondition,
  flattenTemplateData,
  processBlockDirectives,
  resolvePath,
} from "./block-directives";
import { discoverTemplate } from "./discover-template";
import { paragraphText, W_NS } from "./ooxml";
import { fillTemplate } from "./patch-template";

setDefaultTimeout(30_000);

// ── Helpers ──────────────────────────────────────────────

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const parseBody = (xml: string): slimdom.Element => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    throw new Error("No w:body element found");
  }
  return body;
};

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const extractTexts = async (buffer: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const texts: string[] = [];
  for (const match of xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu)) {
    if (match[1] !== undefined) {
      texts.push(match[1]);
    }
  }
  return texts;
};

// ── Arbitraries ──────────────────────────────────────────

const IDENT_RE = /^[a-z]{2,10}$/u;
const LEAF_RE = /^[A-Za-z0-9 ]{1,20}$/u;
const IDENT_UNDERSCORE_RE = /^[a-z_]{1,8}$/u;
const HAS_LETTER_RE = /[a-z]/u;
const NUMERIC_INDEX_SUFFIX_RE = /\.\d+$/u;
const DIRECTIVE_RE = /\{\{[#/]/u;

/** XML-safe identifier (letters only, 2-10 chars). */
const identifier = fc
  .stringMatching(IDENT_RE)
  .filter((s) => s !== "and" && s !== "or" && s !== "true" && s !== "false");

/** XML-safe leaf value (no special chars). */
const leafValue = fc.stringMatching(LEAF_RE).filter((s) => s.trim().length > 0);

// ── Tests ────────────────────────────────────────────────

describe("property: parseNumeric rejects non-numeric identifiers", () => {
  test("identifiers with underscores and letters resolve as paths, not numbers", async () => {
    // Bug: `_` parsed as 0, `_0` parsed as 0
    const identifiersWithUnderscores = fc
      .stringMatching(IDENT_UNDERSCORE_RE)
      .filter((s) => s.length > 0 && HAS_LETTER_RE.test(s));

    fc.assert(
      fc.property(identifiersWithUnderscores, (ident) => {
        const data = { [ident]: "found" };
        const result = resolvePath(ident, data);
        expect(result).toBe("found");
      }),
      { numRuns: 200 },
    );
  });

  test("underscore-only strings never resolve as numeric", async () => {
    const underscoreOnly = fc
      .integer({ min: 1, max: 10 })
      .map((n) => "_".repeat(n));

    fc.assert(
      fc.property(underscoreOnly, (ident) => {
        // Should resolve as a path lookup, not a number
        const data: Record<string, unknown> = {};
        const result = resolvePath(ident, data);
        expect(result).toBeUndefined();
      }),
      { numRuns: 50 },
    );
  });

  test("underscore-prefixed digits resolve as paths, not numbers", async () => {
    // Bug: _0, _1, _123 parsed as numeric after stripping _
    const underscoreDigit = fc
      .integer({ min: 0, max: 999 })
      .map((n) => `_${n}`);

    fc.assert(
      fc.property(underscoreDigit, (ident) => {
        const data = { [ident]: "found" };
        const result = resolvePath(ident, data);
        expect(result).toBe("found");
      }),
      { numRuns: 100 },
    );
  });
});

describe("property: nested objects in #each items resolve", () => {
  test("all deep-path placeholders produce values in output", async () => {
    // Bug: nested objects in array items were not registered
    // as patch values, leaving deep-path placeholders unresolved.

    // Generate: field name, nested field name, array of items
    // with nested objects, verify the output contains all values.
    await fc.assert(
      fc.asyncProperty(
        identifier,
        identifier,
        identifier,
        fc.array(leafValue, { minLength: 1, maxLength: 5 }),
        async (arrayName, nestedObj, nestedField, values) => {
          // Template: {{#each arr}}{{arr.nested.field}}{{/each}}
          const xml = WRAP(
            [
              P(`{{#each ${arrayName}}}`),
              P(`{{${arrayName}.${nestedObj}.${nestedField}}}`),
              P("{{/each}}"),
            ].join(""),
          );
          const docx = await makeDocx(xml);

          const items = values.map((v) => ({
            [nestedObj]: { [nestedField]: v },
          }));

          const { buffer } = await fillTemplate(docx, {
            [arrayName]: items,
          });

          const texts = await extractTexts(buffer);
          const joined = texts.join(" ");
          for (const v of values) {
            expect(joined).toContain(v);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  test("mixed field types in array items: strings, numbers, nested objects", async () => {
    await fc.assert(
      fc.asyncProperty(
        identifier,
        leafValue,
        leafValue,
        async (arrayName, strVal, nestedVal) => {
          const xml = WRAP(
            [
              P(`{{#each ${arrayName}}}`),
              P(`Name: {{${arrayName}.name}}`),
              P(`City: {{${arrayName}.addr.city}}`),
              P("{{/each}}"),
            ].join(""),
          );
          const docx = await makeDocx(xml);

          const { buffer } = await fillTemplate(docx, {
            [arrayName]: [{ name: strVal, addr: { city: nestedVal } }],
          });

          const texts = await extractTexts(buffer);
          const joined = texts.join(" ");
          expect(joined).toContain(strVal);
          expect(joined).toContain(nestedVal);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("property: arrays inside loop items are not recursed into", () => {
  test("array fields in items do not produce nonsensical patch keys", async () => {
    // Bug: isRecord returned true for arrays, causing
    // registerItemPatchValues to recurse into array indices.

    const xml = WRAP(
      [P("{{#each items}}"), P("Name: {{items.name}}"), P("{{/each}}")].join(
        "",
      ),
    );
    fc.assert(
      fc.property(
        identifier,
        fc.array(leafValue, { minLength: 1, maxLength: 5 }),
        (name, tags) => {
          const freshBody = parseBody(xml);
          const { patchValues } = processBlockDirectives(freshBody, {
            items: [{ name, tags }],
          });

          // No patch key should contain numeric indices from
          // array iteration (e.g., __each_items_0_tags.0)
          for (const key of Object.keys(patchValues)) {
            // Keys like __each_items_0_tags.0 indicate the bug
            expect(key).not.toMatch(NUMERIC_INDEX_SUFFIX_RE);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("property: compound condition inference per sub-expression", () => {
  test("truthiness-only variables inferred as boolean, comparison variables as string", async () => {
    // Bug: hasComparison was checked on the entire condition
    // string, causing all paths to be inferred as "string"
    // when any sub-expression had a comparison.

    await fc.assert(
      fc.asyncProperty(
        fc.tuple(identifier, identifier).filter(([a, b]) => a !== b),
        leafValue,
        async ([boolVar, strVar], strLiteral) => {
          // Condition: `boolVar and strVar == "literal"`
          const condition = `${boolVar} and ${strVar} == "${strLiteral}"`;

          const xml = WRAP(
            [P(`{{#if ${condition}}}`), P("Content"), P("{{/if}}")].join(""),
          );
          const docx = await makeDocx(xml);
          const result = await discoverTemplate(docx);

          const boolField = result.fields.find((f) => f.path === boolVar);
          const strField = result.fields.find((f) => f.path === strVar);

          // The boolean variable should be inferred as boolean
          if (boolField) {
            expect(boolField.kind).toBe("boolean");
          }
          // The comparison variable should be inferred as string
          if (strField) {
            expect(strField.kind).toBe("string");
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test("and/or inside string literals do not split sub-expressions", async () => {
    // Bug: SUB_EXPR_SPLIT_RE split on and/or inside string
    // literals, producing malformed sub-expressions.

    // Constants for the literal so the identifier filter below can
    // reference them: if `varName` happened to equal one of these, a
    // legitimate field for the variable would also satisfy the
    // "literal substrings must not become fields" assertion and the
    // test would fail spuriously.
    const LITERAL_LEFT = "red";
    const LITERAL_RIGHT = "blue";

    await fc.assert(
      fc.asyncProperty(
        identifier.filter((s) => s !== LITERAL_LEFT && s !== LITERAL_RIGHT),
        async (varName) => {
          // Condition: `varName == "red and blue"`
          // The "and" inside the string must NOT split
          const condition = `${varName} == "${LITERAL_LEFT} and ${LITERAL_RIGHT}"`;

          const xml = WRAP(
            [P(`{{#if ${condition}}}`), P("Content"), P("{{/if}}")].join(""),
          );
          const docx = await makeDocx(xml);
          const result = await discoverTemplate(docx);

          // varName is on the left of a comparison, so the parser
          // must discover it as a string field. Asserting `toBeDefined`
          // catches a regression that drops it entirely; the previous
          // `if (field)` would have passed silently in that case.
          const field = result.fields.find((f) => f.path === varName);
          expect(field).toBeDefined();
          expect(field?.kind).toBe("string");

          // The literal's substrings must NOT appear as fields
          const leftField = result.fields.find((f) => f.path === LITERAL_LEFT);
          const rightField = result.fields.find(
            (f) => f.path === LITERAL_RIGHT,
          );
          expect(leftField).toBeUndefined();
          expect(rightField).toBeUndefined();
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("kind promotion: comparison overrides truthiness", () => {
  test("same variable in truthiness and comparison within one condition", async () => {
    // `status and status == "active"` — the comparison sub-expr
    // is more specific; the field should be inferred as "string".
    const xml = WRAP(
      [
        P('{{#if status and status == "active"}}'),
        P("Content"),
        P("{{/if}}"),
      ].join(""),
    );
    const docx = await makeDocx(xml);
    const result = await discoverTemplate(docx);

    const field = result.fields.find((f) => f.path === "status");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("string");
  });

  test("comparison before truthiness in the same condition", async () => {
    // Reversed order: `role == "admin" and role`
    const xml = WRAP(
      [P('{{#if role == "admin" and role}}'), P("Content"), P("{{/if}}")].join(
        "",
      ),
    );
    const docx = await makeDocx(xml);
    const result = await discoverTemplate(docx);

    const field = result.fields.find((f) => f.path === "role");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("string");
  });

  test("same variable across separate #if blocks", async () => {
    // First block: truthiness. Second block: comparison.
    // The comparison is more specific and should win.
    const xml = WRAP(
      [
        P("{{#if verified}}"),
        P("Verified"),
        P("{{/if}}"),
        P('{{#if verified == "yes"}}'),
        P("Confirmed"),
        P("{{/if}}"),
      ].join(""),
    );
    const docx = await makeDocx(xml);
    const result = await discoverTemplate(docx);

    const field = result.fields.find((f) => f.path === "verified");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("string");
  });

  test("array kind is not demoted by truthiness or comparison", async () => {
    // Variable used in #each (array), then in #if truthiness,
    // then in comparison. Array should win.
    const xml = WRAP(
      [
        P("{{#each items}}"),
        P("{{items.name}}"),
        P("{{/each}}"),
        P("{{#if items}}"),
        P("Has items"),
        P("{{/if}}"),
      ].join(""),
    );
    const docx = await makeDocx(xml);
    const result = await discoverTemplate(docx);

    const field = result.fields.find((f) => f.path === "items");
    expect(field).toBeDefined();
    expect(field?.kind).toBe("array");
  });
});

describe("property: MAX_PASSES reports an error", () => {
  test("deeply nested directives produce a structure error, never hang", () => {
    // Build a template with more nesting levels than MAX_PASSES
    // can resolve in a single go. The engine must report an error
    // rather than silently leaving directives in the output.

    // 25 nested #if blocks (MAX_PASSES = 20)
    const depth = 25;
    const paragraphs: string[] = [];
    for (let i = 0; i < depth; i++) {
      paragraphs.push(P(`{{#if level_${i}}}`));
    }
    paragraphs.push(P("Deep content"));
    for (let i = depth - 1; i >= 0; i--) {
      paragraphs.push(P("{{/if}}"));
    }

    const xml = WRAP(paragraphs.join(""));
    const body = parseBody(xml);

    // All conditions are true so all branches are kept,
    // but the nesting requires many passes to fully resolve
    const data: Record<string, boolean> = {};
    for (let i = 0; i < depth; i++) {
      data[`level_${i}`] = true;
    }

    const { errors } = processBlockDirectives(body, data);

    // If MAX_PASSES is exceeded, there should be an error
    const remaining = body.getElementsByTagNameNS(W_NS, "p");
    const hasDirectives = remaining.some((p) => {
      const text = paragraphText(p);
      return DIRECTIVE_RE.test(text);
    });

    if (hasDirectives) {
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("nesting"))).toBe(true);
    }
  });
});

describe("property: flattenTemplateData roundtrip", () => {
  test("all leaf values are accessible via dot-path keys", async () => {
    // Generate nested objects and verify that flattening
    // produces keys that match resolvePath on the original.

    const nestedObject = fc.record({
      name: leafValue,
      address: fc.record({
        city: leafValue,
        zip: leafValue,
      }),
    });

    fc.assert(
      fc.property(nestedObject, (obj) => {
        const flattened = flattenTemplateData(obj);

        // Every flattened key should correspond to a value
        // reachable by resolvePath on the original
        const toComparable = (x: unknown): string =>
          x === undefined ? "undefined" : JSON.stringify(x);
        for (const [key, value] of Object.entries(flattened)) {
          const resolved = resolvePath(key, obj);
          expect(toComparable(resolved)).toBe(toComparable(value));
        }

        // Specific paths must be present (array syntax to
        // avoid toHaveProperty interpreting dots as nesting)
        expect(flattened).toHaveProperty(["name"]);
        expect(flattened).toHaveProperty(["address.city"]);
        expect(flattened).toHaveProperty(["address.zip"]);
      }),
      { numRuns: 100 },
    );
  });
});

describe("property: evaluateCondition consistency", () => {
  test("negation inverts truthiness for any path", async () => {
    fc.assert(
      fc.property(identifier, leafValue, (path, value) => {
        const data = { [path]: value };
        const pos = evaluateCondition(path, data);
        const neg = evaluateCondition(`!${path}`, data);
        expect(neg).toBe(!pos);
      }),
      { numRuns: 100 },
    );
  });

  test("comparison is symmetric for ==", async () => {
    fc.assert(
      fc.property(identifier, identifier, leafValue, (a, b, value) => {
        const data = { [a]: value, [b]: value };
        const forward = evaluateCondition(`${a} == ${b}`, data);
        const reverse = evaluateCondition(`${b} == ${a}`, data);
        expect(forward).toBe(reverse);
      }),
      { numRuns: 100 },
    );
  });
});
