import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  documentAstSchema,
  omitDerivablePlainText,
  parseDocumentAst,
} from "./document-ast.js";
import type {
  DecisionMetadata,
  DocumentAst,
  GuidanceMetadata,
} from "./document-ast.js";
import {
  DOCUMENT_KIND_LAYOUTS,
  DOCUMENT_KINDS,
  DOCUMENT_LAYOUTS,
  documentKindOf,
  documentLayoutOf,
  GUIDANCE_KINDS,
} from "./document-kind.js";
import type { GuidanceKind } from "./document-kind.js";

const DECISION = {
  caseNumber: "1 As 1/2026",
  ecli: null,
  court: "Nejvyšší správní soud",
  decisionDate: "2026-01-02",
  decisionType: null,
  keywords: [],
  statutes: [],
} satisfies DecisionMetadata;

const guidance = (kind: GuidanceKind): GuidanceMetadata => ({
  type: "guidance",
  kind,
  title: "Guidelines 3/2025 on the interplay between the DSA and the GDPR",
  reference: "Guidelines 3/2025",
  issuedOn: "2026-09-17",
  issuer: {
    type: "authority",
    name: "European Data Protection Board",
    jurisdiction: "EU",
  },
});

const astWith = (metadata: DocumentAst["metadata"]): DocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: "d",
    webUrl: "https://publisher.test/d",
    printUrl: "",
  },
  metadata,
  blocks: [],
});

describe("the kind-to-layout map", () => {
  test("maps exactly the declared kinds, each to a declared layout", () => {
    expect(Object.keys(DOCUMENT_KIND_LAYOUTS).toSorted()).toEqual(
      [...DOCUMENT_KINDS].toSorted(),
    );
    for (const kind of DOCUMENT_KINDS) {
      expect(DOCUMENT_LAYOUTS).toContain(DOCUMENT_KIND_LAYOUTS[kind]);
    }
  });

  test("reaches every layout from some kind", () => {
    expect(new Set(Object.values(DOCUMENT_KIND_LAYOUTS))).toEqual(
      new Set(DOCUMENT_LAYOUTS),
    );
  });

  test("lays decisions out as decisions whether or not they state a type", () => {
    expect(documentLayoutOf(DECISION)).toBe("decision");
    expect(documentLayoutOf({ ...DECISION, type: "decision" })).toBe(
      "decision",
    );
  });

  test("lays guidance out by its kind", () => {
    for (const kind of GUIDANCE_KINDS) {
      expect(documentKindOf(guidance(kind))).toBe(kind);
      expect(documentLayoutOf(guidance(kind))).toBe(
        DOCUMENT_KIND_LAYOUTS[kind],
      );
    }
  });
});

describe("document metadata on the wire", () => {
  test("round-trips guidance of every kind through the persisted reader", () => {
    for (const kind of GUIDANCE_KINDS) {
      const ast = astWith(guidance(kind));
      expect(v.is(documentAstSchema, ast)).toBe(true);
      expect(parseDocumentAst(omitDerivablePlainText(ast))).toEqual(ast);
      expect(parseDocumentAst(JSON.stringify(ast))).toEqual(ast);
    }
  });

  test("keeps a stored decision's metadata byte for byte", () => {
    const ast = astWith(DECISION);
    expect(parseDocumentAst(JSON.stringify(ast))).toEqual(ast);
    expect(parseDocumentAst(JSON.stringify(ast))?.metadata).not.toHaveProperty(
      "type",
    );
  });

  test("rejects a guidance kind the contract does not declare", () => {
    const stored = {
      ...astWith(guidance("guideline")),
      metadata: { ...guidance("guideline"), kind: "press_release" },
    };
    expect(v.is(documentAstSchema, stored)).toBe(false);
    expect(parseDocumentAst(stored)).toBeNull();
  });

  test("never reads guidance as a decision", () => {
    const { title: _title, ...untitled } = guidance("opinion");
    expect(
      v.is(documentAstSchema, { ...astWith(DECISION), metadata: untitled }),
    ).toBe(false);
  });
});
