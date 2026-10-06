import { expect, test } from "bun:test";

import { createCaseLawDecisionSlugCandidate } from "@/api/handlers/case-law/decisions/slug";
import { citationScopeAstHash } from "@/api/handlers/case-law/ingestion/citation-scopes";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import type { DocumentAst } from "@/api/lib/case-law/document-ast";

const text = "Článek\u0000📄\ud800";

test("stored source fingerprints retain text, byte views, and object order", () => {
  const page = {
    bytes: new Uint8Array([99, 0, 255, 128, 1, 88]).subarray(1, 5),
    contentType: "application/octet-stream",
  };
  const attachment = {
    bytes: new TextEncoder().encode(text),
    contentType: "application/octet-stream",
  };
  expect(String(sourceFingerprint({ sourceRaw: text }))).toBe(
    "538101558ae518cf05d6b09c3d882716760824eed529051e60838a3bad85896c",
  );
  expect(
    String(
      sourceFingerprint({
        sourceRaw: text,
        sourceRawObjects: { page, attachment },
      }),
    ),
  ).toBe("775c276311fccadb2a418882780c80d99b9faef347de76d089d07d7b14e7403e");
  expect(
    String(
      sourceFingerprint({
        sourceRaw: text,
        sourceRawObjects: { attachment, page },
      }),
    ),
  ).toBe("fe13ca8e1bf2994c10187a2c46c9a359b7131f8ad3815a068f548ec9b693be92");
});

test("stored citation AST fingerprints retain canonical JSON encoding", () => {
  const ast = {
    version: 1,
    source: { system: "test", documentId: "fixture", webUrl: "", printUrl: "" },
    blocks: [
      {
        id: "a",
        anchorId: "paragraph-a",
        type: "paragraph",
        plainText: text,
        inlines: [{ text, type: "text" }],
      },
    ],
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
  } satisfies DocumentAst;
  expect(citationScopeAstHash(ast)).toBe(
    "33b37bdf749a3524f3b9dfd3281a4a1eec72f0c86b41935f55a164ad2abbb010",
  );
});

test("decision slug suffixes retain identity and attempt encoding", () => {
  expect(
    createCaseLawDecisionSlugCandidate({
      baseSlug: "decision",
      identity: text,
      attempt: 0,
    }),
  ).toBe("decision");
  expect(
    createCaseLawDecisionSlugCandidate({
      baseSlug: "decision",
      identity: text,
      attempt: 1,
    }),
  ).toBe("decision-4e9ecd0317885470");
  expect(
    createCaseLawDecisionSlugCandidate({
      baseSlug: "decision",
      identity: text,
      attempt: 4,
    }),
  ).toBe("decision-2031cc3dbda1554f");
});
