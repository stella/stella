import { panic } from "better-result";
import { expect } from "bun:test";

import { classifiedCitationBlockIds } from "@stll/legal-ast/citation-passage";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { citationPassageIn } from "@/api/handlers/case-law/decisions/citation-passages";
import { readServedDecisionAst } from "@/api/handlers/case-law/decisions/served-ast";
import { createSafeId } from "@/api/lib/branded-types";
import { analysisInputOf } from "@/api/lib/case-law/analysis-prompt";
import { createDecisionRowAstCache } from "@/api/lib/case-law/decision-row-ast-cache";
import { createDecisionSectionCache } from "@/api/lib/case-law/decision-section-cache";
import { readReaderAnswerDecision } from "@/api/lib/case-law/reader-answer-corpus";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import type { WINDOWED_READ_SURFACE } from "@/api/lib/files/windowed-read-surface";
import { createCorpusAstCache } from "@/api/lib/legal-search/corpus-ast-cache";
import {
  currentReadWork,
  meterStorageRead,
  recordDbResult,
  recordReadWork,
} from "@/api/lib/observability/request-work";

type CaseLawWindowProfile = {
  [
    Key in keyof typeof WINDOWED_READ_SURFACE
  ]: (typeof WINDOWED_READ_SURFACE)[Key]["guard"] extends "lib/case-law/windowed-read.postgres.test.ts"
    ? Key
    : never;
}[keyof typeof WINDOWED_READ_SURFACE];

/** Uses the production cache, projection, citation locator and answer adapters;
 * only the external storage and database bodies are supplied by the fixture. */
type CaseLawWindowFixtureOptions = {
  scale: number;
  source: "store" | "database";
};

export const caseLawWindowFixture = async (
  profile: CaseLawWindowProfile,
  { scale, source }: CaseLawWindowFixtureOptions,
) => {
  const decisionId = createSafeId<"caseLawDecision">();
  const text = `${"Court reasoning. ".repeat(3000 * scale)} 4 Tdo 348/2023`;
  const document = {
    version: 1,
    source: {
      system: "test",
      documentId: decisionId,
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
        id: "p1",
        anchorId: "p1",
        type: "paragraph",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
  } as const satisfies DocumentAst;
  const serialized = JSON.stringify(document);
  const cache = createCorpusAstCache({
    maxHeapBytes: 32 * 1024 * 1024,
    read: async () => {
      meterStorageRead(Buffer.from(serialized));
      recordReadWork("astParses");
      return await Promise.resolve({
        ast: document,
        decodedLength: serialized.length,
      });
    },
  });
  const readRow = createDecisionRowAstCache({ maxBytes: 32 * 1024 * 1024 });
  const readSections = createDecisionSectionCache({ maxBytes: 1024 * 1024 });
  const read = async () => {
    const served = await readServedDecisionAst({
      decisionId,
      astS3Key: source === "store" ? "immutable-fixture" : null,
      contentHash: "version-1",
      pgAst: null,
      corpusReadEnabled: source === "store",
      readStore: async () => await cache.read("immutable-fixture"),
      readPgAst: async () =>
        await readRow({
          documentId: decisionId,
          key: "decision-id/updated-at/version-1",
          read: async () => {
            recordDbResult([{ documentAst: document }]);
            return await Promise.resolve(document);
          },
        }),
    });
    const ast = served.payload;
    if (!isDocumentAst(ast)) {
      return panic("Fixture requires a readable AST");
    }
    switch (profile) {
      case "case-law-reader":
        expect(ast.blocks.at(0)?.id).toBe("p1");
        break;
      case "citation-passages": {
        const sections = await readSections({
          key: "version-1",
          ast,
          readSections: async () => {
            const rows = [
              { index: 0, title: null, type: "ruling" as const, text },
            ];
            recordDbResult(rows);
            return await Promise.resolve(rows);
          },
        });
        const passage = citationPassageIn({
          ast,
          citationText: "4 Tdo 348/2023",
          classifiedBlockIds: classifiedCitationBlockIds(
            ast,
            sections?.at(0)?.blockIndices,
          ),
        });
        expect(passage?.text).toContain("4 Tdo 348/2023");
        expect(passage?.text.length).toBeLessThanOrEqual(1200);
        break;
      }
      case "reader-answer": {
        const answer = await readReaderAnswerDecision(decisionId, {
          readDecision: async () =>
            await Promise.resolve({
              status: "read",
              textAccess: "readable",
              ast,
              decision: {
                id: decisionId,
                caseNumberType: "case-number",
                caseNumber: "1 Test",
                courtAbbreviation: null,
                courtTier: "other",
                court: "Court",
                country: "CZE",
                decisionDate: null,
                ecli: null,
                language: "cs",
                languageAlternates: [],
                slug: null,
              },
              citationAnchors: [],
              provisionAnchors: [],
              provisionStatus: null,
              referenceNextCursor: null,
            }),
        });
        expect(
          answer.isOk() && answer.value?.paragraphs.at(0)?.paragraphId,
        ).toBe("p1");
        break;
      }
      case "analysis-input":
        expect(
          analysisInputOf({
            blocks: ast.blocks,
            decision: {
              court: "Court",
              country: "CZE",
              decisionType: null,
              language: "cs",
            },
            systemPrompt: "Analyse the decision.",
          }).userMessage,
        ).toContain("4 Tdo 348/2023");
        break;
      default:
        profile satisfies never;
        return panic("Unknown fixture profile");
    }
    return currentReadWork() ?? panic("Fixture requires a request meter");
  };
  const cold = await runWithQueryCounter(read);
  const warm = await runWithQueryCounter(read);
  return { cold, warm };
};
