import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  CITATION_SCOPE_METADATA_KEY,
  citationScopeAstHash,
  citationScopeEnvelope,
  validatedCitationScopes,
} from "@/api/handlers/case-law/ingestion/citation-scopes";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import type { DocumentAst } from "@/api/lib/case-law/document-ast";
import { plainTextOf } from "@/api/lib/case-law/document-ast";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";

const text = "See 347 U.S. 483. Id. at 495.";
const ast = (paragraphText = text): DocumentAst => ({
  version: 1,
  source: {
    system: "test",
    documentId: "scoped-decision",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "opinion-1",
      anchorId: "paragraph-1",
      type: "paragraph",
      inlines: [{ type: "text", text: paragraphText }],
      plainText: paragraphText,
    },
  ],
});

const opinions = [
  {
    opinionId: "majority",
    blockIds: ["opinion-1"],
    boundaries: "proven",
  },
] as const;

const extract = (documentAst: DocumentAst) => {
  const result = extractDecisionCitations({
    country: "USA",
    sections: [],
    documentAst,
    citationScopes: opinions,
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("persisted citation scopes", () => {
  test("survive JSON storage with the final annotated AST and reparse to a fixed point", () => {
    const first = extract(ast());
    const annotated = first.documentAst ?? expect.unreachable();
    const envelope = citationScopeEnvelope(annotated, opinions);
    const storedJson = JSON.stringify({
      documentAst: annotated,
      metadata: { [CITATION_SCOPE_METADATA_KEY]: envelope },
    });
    const stored = JSON.parse(storedJson);
    const checked = validatedCitationScopes(
      stored.metadata,
      stored.documentAst,
    );

    if (Result.isError(checked)) {
      throw checked.error;
    }
    expect(checked.value).toEqual(opinions);
    expect(envelope.astHash).toBe(citationScopeAstHash(stored.documentAst));
    expect(extract(stored.documentAst).documentAst).toEqual(stored.documentAst);
    expect(extract(stored.documentAst).occurrences).toEqual(first.occurrences);
  });

  test("rejects a stale hash even when the old scope names still exist", () => {
    const first = extract(ast());
    const annotated = first.documentAst ?? expect.unreachable();
    const metadata = {
      [CITATION_SCOPE_METADATA_KEY]: citationScopeEnvelope(annotated, opinions),
    };
    const changed = {
      ...annotated,
      blocks: annotated.blocks.map((block) => ({
        ...block,
        plainText: "Changed",
      })),
    };

    expect(citationScopeAstHash(changed)).not.toBe(
      citationScopeAstHash(annotated),
    );
    const checked = validatedCitationScopes(metadata, changed);
    expect(Result.isError(checked)).toBe(true);
    if (!Result.isError(checked)) {
      throw new TypeError("A changed AST must reject its old scope envelope");
    }
    expect(checked.error.defect).toBe("ast-hash-mismatch");
  });

  test("rejects a hash-valid envelope whose scope names a missing block", () => {
    const documentAst = ast();
    const metadata = {
      [CITATION_SCOPE_METADATA_KEY]: citationScopeEnvelope(documentAst, [
        {
          opinionId: "majority",
          blockIds: ["missing-block"],
          boundaries: "proven",
        },
      ]),
    };
    const checked = validatedCitationScopes(metadata, documentAst);
    expect(Result.isError(checked)).toBe(true);
    if (!Result.isError(checked)) {
      throw new TypeError("A missing block must reject its scope envelope");
    }
    expect(checked.error.defect).toBe("unknown-block");
  });

  test("reads offsets from sanitized inline text", () => {
    const rawText = "\u0000See\u00a0347 U.S. 483. Id. at 495.";
    const input: IngestionResult = {
      caseNumber: "scope-offset-1",
      sourceDocumentId: "scope-offset-1",
      court: "Supreme Court of the United States",
      country: "USA",
      language: "en",
      fulltext: rawText,
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: "raw-scope-offset-1",
      documentAst: ast(rawText),
      citationScopes: opinions,
    };
    const sanitized = sanitizeResult(input);
    const documentAst = sanitized.documentAst;
    if (!documentAst || !Array.isArray(documentAst.blocks)) {
      throw new Error("Sanitized fixture must retain its AST");
    }
    const paragraph = documentAst.blocks.at(0);
    if (paragraph?.type !== "paragraph") {
      throw new Error("Sanitized fixture must retain its paragraph");
    }
    const sanitizedText = plainTextOf(paragraph.inlines);
    expect(sanitizedText).toBe("See 347 U.S. 483. Id. at 495.");
    expect(rawText.indexOf("347 U.S. 483")).not.toBe(
      sanitizedText.indexOf("347 U.S. 483"),
    );

    const extracted = extract(documentAst);
    expect(
      extracted.occurrences.map(({ start, end }) =>
        sanitizedText.slice(start, end),
      ),
    ).toEqual(["347 U.S. 483", "Id. at 495"]);
    const annotated = extracted.documentAst ?? expect.unreachable();
    const storedParagraph = annotated.blocks.at(0);
    expect(
      storedParagraph?.type === "paragraph"
        ? plainTextOf(storedParagraph.inlines)
        : null,
    ).toBe(sanitizedText);
    expect(extract(annotated).documentAst).toEqual(annotated);
  });
});
