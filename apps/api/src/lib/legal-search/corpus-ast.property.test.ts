import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { prepareCorpusAst } from "@/api/lib/legal-search/corpus-ast";
import { parsePersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";

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
      const prepared = prepareCorpusAst({ ast });
      const read = parsePersistedCorpusAst(prepared.ast);
      expect(prepareCorpusAst({ ast: read }).ast).toEqual(read);
    }),
  );
});
