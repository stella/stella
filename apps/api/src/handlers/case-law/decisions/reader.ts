import { panic } from "better-result";

import { locateCitationSpans } from "@stll/legal-ast/citation-passage";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { projectionPieces } from "@stll/legal-ast/projection-digest";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";

import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { attachDecisionProvisionPreviews } from "@/api/handlers/case-law/provisions/previews-for-decision";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

import { listOutgoingDecisionCitations } from "./citations";
import { readDecisionHandler } from "./get";

export type ReaderSourceOptions = {
  caseLawDb?: CaseLawPublicReadDb;
  legislationDb?: LegislationReadDb;
  decisionId: SafeId<"caseLawDecision">;
  phase: "blocks" | "citations" | "provisions";
  referenceCursor?: string | undefined;
  withheldTextPolicy: "metadata-only" | "show-to-user";
};

/** Each anchor stream is a bounded batch, not one query per block or link. */
export const readDecisionReaderSource = async ({
  decisionId,
  phase,
  referenceCursor,
  withheldTextPolicy,
  caseLawDb = caseLawPublicReadDb,
  legislationDb = legislationPublicReadDb,
}: ReaderSourceOptions) => {
  const read = await withRedistributableSubject(
    caseLawDb,
    { kind: "id", id: decisionId },
    async (subject) => {
      const decision = await readDecisionHandler({
        subject,
        citationsCursor: null,
      });
      if (!("caseNumber" in decision)) {
        return null;
      }
      const ast = parseDocumentAst(decision.documentAst);
      const canRead =
        decision.source.allowsDerivedAi ||
        withheldTextPolicy !== "metadata-only";
      const citations =
        canRead && ast !== null && phase === "citations"
          ? await listOutgoingDecisionCitations({
              tx: subject.tx,
              decisionId: subject.id,
              cursor: referenceCursor,
            })
          : null;
      const provisions =
        canRead && ast !== null && phase === "provisions"
          ? await listDecisionProvisionsHandler({
              subject,
              query: {
                limit: 20,
                ...(referenceCursor === undefined
                  ? {}
                  : { cursor: referenceCursor }),
              },
            })
          : null;
      return { decision, ast, citations, provisions };
    },
  );
  if (read === null) {
    return null;
  }
  const { decision, ast, citations, provisions } = read;
  const citationAnchors: {
    pieceId: string;
    start: number;
    end: number;
    citationId: string;
    decisionId: string;
  }[] = [];
  if (citations !== null) {
    if (!("items" in citations)) {
      return { status: "conflict" as const };
    }
    const linked = citations.items.flatMap((row) =>
      row.citedDecisionId === null
        ? []
        : [{ ...row, citedDecisionId: row.citedDecisionId }],
    );
    for (const [pieceId, spans] of Object.entries(
      locateCitationSpans({
        blocks: ast === null ? [] : ast.blocks,
        citations: linked,
      }),
    )) {
      for (const span of spans) {
        citationAnchors.push({
          pieceId,
          start: span.start,
          end: span.end,
          citationId: span.source.id,
          decisionId: span.source.citedDecisionId,
        });
      }
    }
  }
  const provisionAnchors: {
    pieceId: string;
    start: number;
    end: number;
    provision: { document_id: string; anchor: string; cited_anchor: string };
  }[] = [];
  if (provisions !== null) {
    if (!("items" in provisions)) {
      return { status: "conflict" as const };
    }
    // The published span addresses precisely this projection. Never relocate a stale span by guessing.
    if (
      ast !== null &&
      provisions.publishedProjectionDigest === decision.projectionDigest
    ) {
      const attached = await attachDecisionProvisionPreviews({
        page: provisions,
        decisionDate: decision.decisionDate,
        legislationDb,
      });
      const previews = new Map(
        attached.previews.map((preview) => [preview.key, preview]),
      );
      const pieces = new Map(
        projectionPieces(ast).map((piece) => [piece.pieceId, piece.text]),
      );
      for (const row of attached.items) {
        if (
          row.previewKey === null ||
          row.printPieceId === null ||
          row.printStart === null ||
          row.printEnd === null ||
          row.printText === null
        ) {
          continue;
        }
        const preview =
          previews.get(row.previewKey) ??
          panic("Provision preview key has no preview");
        const text = pieces.get(row.printPieceId);
        if (
          text === undefined ||
          row.printStart < 0 ||
          row.printEnd <= row.printStart ||
          row.printEnd > text.length ||
          text.slice(row.printStart, row.printEnd) !== row.printText ||
          preview.blocks.length === 0
        ) {
          continue;
        }
        provisionAnchors.push({
          pieceId: row.printPieceId,
          start: row.printStart,
          end: row.printEnd,
          provision: {
            document_id: preview.documentId,
            anchor: provisionHeadingAnchor(row.anchor),
            cited_anchor: row.anchor,
          },
        });
      }
    }
  }
  return {
    status: "read" as const,
    decision: {
      id: decision.id,
      caseNumber: decision.caseNumber,
      court: decision.court,
      country: decision.country,
      decisionDate: decision.decisionDate,
      ecli: decision.ecli,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
      source: { allowsDerivedAi: decision.source.allowsDerivedAi },
    },
    ast,
    citationAnchors,
    provisionAnchors,
    referenceNextCursor:
      citations?.nextCursor ?? provisions?.nextCursor ?? null,
  };
};
