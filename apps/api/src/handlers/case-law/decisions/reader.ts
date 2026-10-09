import { panic, TaggedError } from "better-result";

import { locateCitationSpans } from "@stll/legal-ast/citation-passage";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { projectionPieces } from "@stll/legal-ast/projection-digest";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";

import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { attachDecisionProvisionPreviews } from "@/api/handlers/case-law/provisions/previews-for-decision";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { appReaderTextForSource } from "@/api/lib/case-law/app-reader-text";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import {
  APP_READER_TEXT,
  type AppReaderText,
} from "@/api/lib/legal-search/adapter-manifest";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

import { listOutgoingDecisionCitationRoutes } from "./citations";
import { readDecisionHandler } from "./get";

/**
 * Who receives the text: `model` results enter model context; `app` results
 * render only in the MCP host's reader UI.
 */
export type ReaderAudience = "model" | "app";

export type ReaderSourceOptions = {
  caseLawDb?: CaseLawPublicReadDb;
  legislationDb?: LegislationReadDb;
  decisionId: SafeId<"caseLawDecision">;
  phase: "blocks" | "citations" | "provisions";
  referenceCursor?: string | undefined;
  audience: ReaderAudience;
  /** The per-source reader setting; a test seam over the source registry. */
  appReaderTextOf?: (adapterKey: string) => AppReaderText;
};

type ReaderTextAccessOptions = {
  allowsDerivedAi: boolean;
  adapterKey: string;
  audience: ReaderAudience;
  appReaderTextOf: (adapterKey: string) => AppReaderText;
};

/**
 * Text a source keeps from AI stays out of model context; the app reader shows
 * it when the source's setting allows.
 */
const readerTextAccess = ({
  allowsDerivedAi,
  adapterKey,
  audience,
  appReaderTextOf,
}: ReaderTextAccessOptions) => {
  if (allowsDerivedAi) {
    return "readable" as const;
  }
  switch (audience) {
    case "model":
      return "withheld" as const;
    case "app":
      return appReaderTextOf(adapterKey) === APP_READER_TEXT.FULL
        ? ("readable" as const)
        : ("withheld" as const);
    default:
      audience satisfies never;
      return panic("Unknown reader audience");
  }
};

class ReaderProvisionSpanMismatchError extends TaggedError(
  "ReaderProvisionSpanMismatchError",
)<{ message: string }> {}

// A stored span that no longer matches its projection piece is withheld, not
// relocated; it signals a projection that needs republishing.
const readerProvisionSpanMismatch = failureSink({
  event: "case_law.reader.provision_span_mismatch",
  expected: [],
});

type ProvisionAnchor = {
  pieceId: string;
  start: number;
  end: number;
  appUrl: string | null;
  provision: { document_id: string; anchor: string; cited_anchor: string };
};

type LocateProvisionAnchorsOptions = {
  ast: DocumentAst;
  page: Extract<
    Awaited<ReturnType<typeof listDecisionProvisionsHandler>>,
    { items: unknown }
  >;
  decisionDate: string | null;
  legislationDb: LegislationReadDb;
};

/** Stored provision spans that still address this projection's exact text. */
const locateProvisionAnchors = async ({
  ast,
  page,
  decisionDate,
  legislationDb,
}: LocateProvisionAnchorsOptions) => {
  const provisionAnchors: ProvisionAnchor[] = [];
  const attached = await attachDecisionProvisionPreviews({
    page,
    decisionDate,
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
      observeFailure(
        new ReaderProvisionSpanMismatchError({
          message: "Stored provision span does not match its piece",
        }),
        { sink: readerProvisionSpanMismatch },
      );
      continue;
    }
    provisionAnchors.push({
      pieceId: row.printPieceId,
      start: row.printStart,
      end: row.printEnd,
      appUrl: preview.appUrl,
      provision: {
        document_id: preview.documentId,
        anchor: provisionHeadingAnchor(row.anchor),
        cited_anchor: row.anchor,
      },
    });
  }
  return provisionAnchors;
};

/** Each anchor stream is a bounded batch, not one query per block or link. */
export const readDecisionReaderSource = async ({
  decisionId,
  phase,
  referenceCursor,
  audience,
  appReaderTextOf = appReaderTextForSource,
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
      const textAccess = readerTextAccess({
        allowsDerivedAi: decision.source.allowsDerivedAi,
        adapterKey: decision.source.adapterKey,
        audience,
        appReaderTextOf,
      });
      const canRead = textAccess === "readable";
      const citations =
        canRead && ast !== null && phase === "citations"
          ? await listOutgoingDecisionCitationRoutes({
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
      return { decision, ast, textAccess, citations, provisions };
    },
  );
  if (read === null) {
    return null;
  }
  const { decision, ast, textAccess, citations, provisions } = read;
  const citationAnchors: {
    pieceId: string;
    start: number;
    end: number;
    citationId: string;
    decisionId: string;
    appUrl: string | null;
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
          appUrl: span.source.appUrl,
        });
      }
    }
  }
  if (provisions !== null && !("items" in provisions)) {
    return { status: "conflict" as const };
  }
  // The published span addresses precisely this projection. Never relocate a stale span by guessing.
  const provisionAnchors =
    provisions !== null &&
    ast !== null &&
    provisions.publishedProjectionDigest === decision.projectionDigest
      ? await locateProvisionAnchors({
          ast,
          page: provisions,
          decisionDate: decision.decisionDate,
          legislationDb,
        })
      : [];
  return {
    status: "read" as const,
    decision: {
      id: decision.id,
      caseNumber: decision.caseNumber,
      caseNumberType: decision.caseNumberType,
      courtAbbreviation: decision.courtAbbreviation,
      courtTier: decision.courtTier,
      court: decision.court,
      country: decision.country,
      decisionDate: decision.decisionDate,
      ecli: decision.ecli,
      language: decision.language,
      languageAlternates: decision.languageAlternates,
      slug: decision.slug,
    },
    textAccess,
    // Withheld text never leaves the read, whichever tool asked for it.
    ast: textAccess === "readable" ? ast : null,
    citationAnchors,
    provisionAnchors,
    referenceNextCursor:
      citations?.nextCursor ?? provisions?.nextCursor ?? null,
  };
};
