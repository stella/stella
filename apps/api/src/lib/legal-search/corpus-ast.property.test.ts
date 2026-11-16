import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import {
  headMatterOrderDegradations,
  headMatterPrecedesBody,
  PARAGRAPH_ROLES,
} from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { prepareCorpusAst } from "@/api/lib/legal-search/corpus-ast";
import { parsePersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import { logger } from "@/api/lib/observability/logger";

const sparseDocument = fc
  .array(fc.string(), { maxLength: 12 })
  .map((texts) => ({
    version: 1,
    blocks: texts.map((text, index) => ({
      type: "paragraph",
      id: `block-${index}`,
      anchorId: `anchor-${index}`,
      inlines: [{ type: "text", text }],
    })),
  }));

// A block body keeps this file's frame on the stack: as an expression body,
// `assertProperty` would be a tail call, and the property harness finds the
// calling test file from that frame.
test("every prepared writer AST is readable", () => {
  assertProperty(
    "every prepared writer AST is readable",
    fc.property(fc.oneof(sparseDocument, fc.jsonValue()), (ast) => {
      const prepared = prepareCorpusAst({
        fallbackText: "Decision text.",
        ast,
      }).unwrap();
      const read = parsePersistedCorpusAst(prepared.ast);
      expect(
        prepareCorpusAst({ fallbackText: "Decision text.", ast: read }).unwrap()
          .ast,
      ).toEqual(read);
    }),
  );
});

/** Paragraphs in any role order, so head matter lands before, inside and after the body. */
const anyOrderDocument = fc
  .array(fc.constantFrom(...PARAGRAPH_ROLES), { maxLength: 12 })
  .map((roles) => ({
    version: 1,
    blocks: roles.map((role, index) => ({
      type: "paragraph",
      id: `block-${index}`,
      anchorId: `anchor-${index}`,
      role,
      inlines: [{ type: "text", text: `text ${index}` }],
    })),
  }));

test("block order never refuses a stored row, and writers store it as given", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    assertProperty(
      "block order never refuses a stored row, and writers store it as given",
      fc.property(anyOrderDocument, (ast) => {
        const read = parsePersistedCorpusAst(ast);
        if (read === null || !("blocks" in read)) {
          throw new Error("a stored document AST must read as a document");
        }
        expect(read.blocks.map(({ id }) => id)).toEqual(
          ast.blocks.map(({ id }) => id),
        );
        const ordered = headMatterPrecedesBody(read.blocks);
        expect(headMatterOrderDegradations(read.blocks).length === 0).toBe(
          ordered,
        );
        const warnedBefore = warn.mock.calls.length;
        const prepared = prepareCorpusAst({ ast, fallbackText: "x" }).unwrap();
        // Late head matter is reported once, never silently stored.
        expect(warn.mock.calls.length - warnedBefore).toBe(ordered ? 0 : 1);
        expect(prepared.type).toBe("readable");
        if (
          prepared.type !== "readable" ||
          prepared.ast === null ||
          !("blocks" in prepared.ast)
        ) {
          throw new Error("every generated block order must remain readable");
        }
        expect(prepared.ast.blocks.map(({ id }) => id)).toEqual(
          ast.blocks.map(({ id }) => id),
        );
      }),
    );
  } finally {
    warn.mockRestore();
  }
});
