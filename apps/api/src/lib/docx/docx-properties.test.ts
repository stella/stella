/**
 * Property-based tests (fast-check) for the shared DOCX helpers.
 * They verify invariants that must hold for ALL inputs, not just
 * hand-picked examples:
 *
 * - ID uniqueness: generated IDs never collide
 * - Tokenization roundtrip: tokenize(text).join("") === text
 * - Placeholder discovery finds every Unicode-named tag
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import JSZip from "jszip";

import { propertyConfig } from "@stll/property-testing";

import { tokenize } from "./diff-paragraphs";
import { discoverPlaceholders } from "./discover-placeholders";
import { createIdGenerator, W_NS } from "./ooxml";

// ── Property: ID generation ──────────────────────────────

describe("property: ID generation", () => {
  test("generated IDs never collide with existing", async () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 10_000 }), {
          minLength: 0,
          maxLength: 50,
        }),
        fc.nat({ max: 20 }),
        (existingArray, count) => {
          const existing = new Set(existingArray);
          const originalIds = new Set(existing);
          const gen = createIdGenerator(existing);

          for (let i = 0; i < count; i++) {
            const id = gen();
            expect(originalIds.has(id)).toBe(false);
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("generated IDs are always unique", async () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 10_000 }), {
          minLength: 0,
          maxLength: 20,
        }),
        fc.integer({ min: 2, max: 50 }),
        (existingArray, count) => {
          const gen = createIdGenerator(new Set(existingArray));
          const generated = new Set<number>();

          for (let i = 0; i < count; i++) {
            const id = gen();
            expect(generated.has(id)).toBe(false);
            generated.add(id);
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("wraparound past INT32_MAX does not reissue generated IDs", () => {
    const INT32_MAX = 2_147_483_647;
    // Start near INT32_MAX so we wrap quickly
    const existing = new Set([INT32_MAX - 2]);
    const gen = createIdGenerator(existing);

    const generated: number[] = [];
    // Generate 5 IDs (will wrap past INT32_MAX)
    for (let i = 0; i < 5; i++) {
      generated.push(gen());
    }

    // All generated IDs must be unique
    expect(generated.length).toBe(new Set(generated).size);
  });
});

// ── Property: tokenization roundtrip ─────────────────────

describe("property: tokenization roundtrip", () => {
  test("tokenize(text).join('') === text for any Unicode", async () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80, unit: "grapheme" }),
        (text) => {
          expect(tokenize(text).join("")).toBe(text);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
});

// ── Property: placeholder roundtrip ──────────────────────

/** Build a minimal DOCX buffer with the given paragraph XML. */
const buildDocxBuffer = async (bodyXml: string): Promise<Buffer> => {
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}">` +
    `<w:body>${bodyXml}</w:body></w:document>`;

  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

/**
 * Placeholder name from realistic scripts (Latin, Czech,
 * Cyrillic, CJK). Avoids XML-incompatible compatibility
 * ideographs that don't roundtrip through XML parsers.
 */
const PLACEHOLDER_CHARS = Array.from(
  "abcdefghijklmnopqrstuvwxyz" +
    "áéíóúčřšžňďťůý" +
    "бвгдежзиклмнопрстуфхцчшщ" +
    "名前住所日付" +
    "0123456789_",
);
const placeholderName = fc
  .array(fc.constantFrom(...PLACEHOLDER_CHARS), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

describe("property: placeholder roundtrip", () => {
  test("discoverPlaceholders finds all Unicode-named tags", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(placeholderName, {
          minLength: 1,
          maxLength: 6,
          comparator: (a, b) => a === b,
        }),
        async (names) => {
          // Build a paragraph containing each placeholder
          const bodyXml = names
            .map(
              (name) =>
                `<w:p><w:r><w:t xml:space="preserve">` +
                `Value: {{${name}}}</w:t></w:r></w:p>`,
            )
            .join("");

          const buffer = await buildDocxBuffer(bodyXml);
          const discovered = await discoverPlaceholders(buffer);
          const discoveredNames = discovered.map((p) => p.name);

          for (const name of names) {
            expect(discoveredNames).toContain(name);
          }
          expect(discovered.length).toBe(names.length);
        },
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
