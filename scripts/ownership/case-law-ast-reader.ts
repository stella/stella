import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-ast-reader",
  capability: "Parsing stored case-law decision ASTs for reads",
  owner: ["packages/legal-ast/src/case-law-reader.ts"],
  summary:
    "Every case-law read parses degraded persisted ASTs and applies structural " +
    "repairs through `parseCaseLawDecisionAst`, so web, MCP, search, research " +
    "and analysis observe the same headings.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/legal-ast/document-ast"],
    names: ["parseUsableDocumentAst"],
    allowed: [
      {
        path: "packages/legal-ast/src/document-ast.test.ts",
        reason: "Direct unit coverage for the generic persisted-AST parser.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
