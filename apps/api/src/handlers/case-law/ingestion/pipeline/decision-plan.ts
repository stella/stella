import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { CASE_LAW_CORPUS_MIRROR_STATUS } from "@/api/db/schema";
import { proceduralKeysFromMetadata } from "@/api/handlers/case-law/citation-kind";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  bareCitationKey,
  citationKeyOf,
  decisionIdentifiersFromMetadata,
  extractCitations,
  isSelfCitation,
  normalizeDecisionIdentifierIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { publisherCitationGap } from "@/api/handlers/case-law/ingestion/citation-recall";
import { buildCitationRows } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import {
  caseLawCanonicalPayload,
  decisionSections,
  hasStoredDocument,
  loadPendingMirrorPayload,
  planCorpusWrite,
} from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import type {
  CorpusWritePayload,
  CorpusWritePlan,
} from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import type { ExistingDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import { corpusCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import type { SafeId } from "@/api/lib/branded-types";
import {
  corpusMirrorColumns,
  corpusPayloadDisposition,
  planCorpusDocumentWrite,
  storedCorpusWrite,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import {
  TEXT_ENCODING_INCOMPLETE,
  TEXT_MISDECODED,
  textEncodingReport,
} from "@/api/lib/legal-search/parsers/text-encoding";
import {
  AST_MARKUP_RESIDUE,
  storedDecisionSignal,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { logger } from "@/api/lib/observability/logger";

type PendingMirrorPayload = Awaited<
  ReturnType<typeof loadPendingMirrorPayload>
>;

type ReportStoredDocumentQualityOptions = {
  result: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  preserveStoredDocument: boolean;
  pendingMirrorPayload: PendingMirrorPayload | null;
};

/**
 * Report a stored decision with no text, text without structure, or markup
 * that survived into its text.
 *
 * Parsers report their own quality through `validateAndLog`, but a
 * source whose parser never runs reports nothing at all. Emit the
 * same signal here so every stored decision is accounted for, and
 * split the severity the same way: no text is an error, text without
 * structure is a warning. A refresh that preserves the stored document
 * reports nothing: it did not store an empty decision, it left a full
 * one alone, and these errors are what an operator sweeps for.
 */
const reportStoredDocumentQuality = ({
  result,
  sourceId,
  preserveStoredDocument,
  pendingMirrorPayload,
}: ReportStoredDocumentQualityOptions): void => {
  const astBlocks = hasUsableAst(result.documentAst)
    ? result.documentAst.blocks.length
    : 0;
  const signal =
    preserveStoredDocument || pendingMirrorPayload !== null
      ? undefined
      : storedDecisionSignal({
          hasFulltext: Boolean(result.fulltext),
          astBlocks,
        });
  if (signal) {
    const subject = {
      sourceId,
      caseNumber: result.caseNumber,
      language: result.language,
      url: result.sourceUrl ?? result.documentUrl ?? "",
      fulltextLength: result.fulltext?.length ?? 0,
    };
    if (signal.level === "error") {
      logger.error(signal.event, subject);
    } else {
      logger.warn(signal.event, subject);
    }
  }

  // Same reasoning for markup that survived into the text: a parser
  // reports its own blocks through `validateAndLog`, so this covers the
  // decisions no parser produced — the source's payload stored verbatim
  // as the document. Skipped where a stored document is being preserved,
  // which stores no text of its own.
  const storedResidue =
    preserveStoredDocument ||
    pendingMirrorPayload !== null ||
    astBlocks > 0 ||
    !result.fulltext
      ? undefined
      : markupResidueIn(result.fulltext);
  if (storedResidue) {
    logger.error(AST_MARKUP_RESIDUE, {
      sourceId,
      caseNumber: result.caseNumber,
      language: result.language,
      url: result.sourceUrl ?? result.documentUrl ?? "",
      residueRule: storedResidue.rule,
      residueAnchorId: "fulltext",
      residueExcerpt: storedResidue.excerpt,
    });
  }

  // Text read through the wrong character set, by the adapter or upstream.
  // Checked on every stored text, parsed or not: the parser sees the text
  // after decoding and cannot tell either.
  const encoding =
    preserveStoredDocument || pendingMirrorPayload !== null || !result.fulltext
      ? undefined
      : textEncodingReport(result.fulltext, result.language);
  const subject = {
    sourceId,
    caseNumber: result.caseNumber,
    language: result.language,
    url: result.sourceUrl ?? result.documentUrl ?? "",
  };
  switch (encoding?.type) {
    case undefined:
      break;
    case "misdecoded":
      logger.error(TEXT_MISDECODED, { ...subject, ...encoding.fields });
      break;
    case "incomplete":
      logger.warn(TEXT_ENCODING_INCOMPLETE, { ...subject, ...encoding.fields });
      break;
    default:
      encoding satisfies never;
      panic("Unhandled text encoding report");
  }
};

type ReportCitationRecallOptions = {
  result: IngestionResult;
  citations: readonly ReturnType<typeof extractCitations>[number][];
  incomingCarriesDocument: boolean;
  preserveStoredDocument: boolean;
};

/**
 * Where the publisher supplies its own cited-decisions list, it is the
 * one ground truth extraction can be measured against without measuring
 * it against itself. Computed here, emitted only after the row write
 * commits (a replayed decision must not re-count) — and emitted for
 * zero-gap decisions too, or aggregated events could not produce a
 * recall denominator.
 * Measured only when the incoming payload carries a document: an empty
 * payload has nothing for extraction to find, so every publisher
 * citation would read as missed — on document-preserving refreshes and
 * equally when a concurrent backfill wins the row between the read and
 * the transaction. Emitted here rather than after the write because an
 * ambiguous timeout can commit the row yet throw, and the replay
 * dedup-skips before re-measuring; the source hash is the identity a
 * consumer deduplicates retries on.
 */
const reportCitationRecall = ({
  result,
  citations,
  incomingCarriesDocument,
  preserveStoredDocument,
}: ReportCitationRecallOptions): void => {
  if (
    incomingCarriesDocument &&
    !preserveStoredDocument &&
    result.publisherCitedCases &&
    result.publisherCitedCases.length > 0
  ) {
    const recall = publisherCitationGap({
      extracted: citations.map((c) => c.citationText),
      publisherCited: result.publisherCitedCases,
    });
    const level = recall.missed.length > 0 ? "warn" : "info";
    logger[level]("case_law.ingestion.citation_recall", {
      caseNumber: result.caseNumber,
      language: result.language,
      url: result.sourceUrl ?? "",
      sourceHash: result.rawHash,
      publisherCitedCount: recall.publisherCitedCount,
      missedCount: recall.missed.length,
      missed: recall.missed.slice(0, 10).join("; "),
    });
  }
};

type PlanCorpusPayloadOptions = {
  result: IngestionResult;
  existing: ExistingDecision | undefined;
  decisionId: SafeId<"caseLawDecision">;
  corpus: CaseLawCorpusDependencies;
  preserveStoredDocument: boolean;
  pendingMirrorPayload: PendingMirrorPayload | null;
};

/**
 * The canonical payload this write stores, where it ends up, and the row
 * columns that record it.
 */
const planCorpusPayload = ({
  result,
  existing,
  decisionId,
  corpus,
  preserveStoredDocument,
  pendingMirrorPayload,
}: PlanCorpusPayloadOptions) => {
  // Corpus objects and every publisher alias now share the UUID reserved by
  // identity resolution before any external write.

  const corpusPayload: CorpusWritePayload =
    pendingMirrorPayload === null
      ? {
          documentId: decisionId,
          jurisdiction: result.country,
          ...caseLawCanonicalPayload(result),
        }
      : {
          documentId: decisionId,
          jurisdiction: result.country,
          ...pendingMirrorPayload,
        };
  const mirrorCarriesDocument = Boolean(
    corpusPayload.text || hasUsableAst(corpusPayload.ast),
  );

  // A payload with no document has nothing to put in the corpus: its
  // mirror write stores nothing and settles the row with no pointers.
  // Writing that settled state directly is the same row, without taking it
  // through pending and back on every refresh of a document-less decision.
  const modePlan: CorpusWritePlan =
    mirrorCarriesDocument || pendingMirrorPayload !== null
      ? planCorpusWrite(corpus.mode)
      : { type: "postgres-only" };

  // The publisher's page can move while the document it carries does not.
  // A settled row that already records this exact payload in the corpus
  // keeps it: writing it back into the row as pending, only for the settle
  // to put the same pointers back, rewrites the whole document for nothing.
  // Asked of the corpus write's own planner, which compares the keys and
  // not the hash alone: a payload whose jurisdiction moved must still land
  // under its new partition. The write is fenced on the recorded hash, so
  // a payload replaced since the read is not taken for this one.
  const storedPayloadUnchanged =
    existing !== undefined &&
    modePlan.type !== "postgres-only" &&
    existing.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED &&
    corpusCarriesDocument(existing.contentHash) &&
    planCorpusDocumentWrite({
      ...corpusPayload,
      stored: storedCorpusWrite(existing),
    }).type === "skipped-unchanged";

  const corpusPlan: CorpusWritePlan =
    (preserveStoredDocument && pendingMirrorPayload === null) ||
    storedPayloadUnchanged
      ? { type: "preserve-stored" }
      : modePlan;

  // A pending mirror's payload was read out of the row, and the write that
  // replays it is fenced on the observation that stored it, so the row
  // already holds exactly this payload. Writing it back would copy the
  // whole document into a new row version to say the same thing.
  const postgresPayload =
    pendingMirrorPayload === null
      ? {
          fulltext: corpusPayload.text,
          sections: corpusPayload.sections,
          documentAst: corpusPayload.ast,
        }
      : {};

  const payloadColumns = (() => {
    switch (corpusPlan.type) {
      case "postgres-only":
        // This refresh supersedes whatever the corpus holds and nothing
        // will follow to rewrite the pointers, so a row carrying keys from
        // an earlier canonical/dual-write period would point at objects
        // that no longer match its columns. Clear them.
        return {
          ...postgresPayload,
          ...corpusMirrorColumns({
            status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
            written: null,
          }),
        };
      case "postgres-mirrored":
      case "object-storage":
        // Persist retry intent with the Postgres payload. Clearing every old
        // pointer makes the pending branch structurally unable to serve a
        // stale mirror while an unchanged replay repairs it.
        return {
          ...postgresPayload,
          ...corpusMirrorColumns({
            status: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
          }),
        };
      case "preserve-stored":
        // Every pointer into object storage stays exactly as stored.
        // Leaving the payload out of the update is what preserves it,
        // except where the corpus is confirmed to hold this exact payload
        // and the mode keeps it only there: those columns converge to
        // the trimmed shape the settle would have left.
        return storedPayloadUnchanged &&
          corpusPayloadDisposition({
            mode: corpus.mode,
            written: storedCorpusWrite(existing),
          }) === "trim"
          ? { ...TRIMMED_CORPUS_PAYLOAD_COLUMNS }
          : {};
      default: {
        corpusPlan satisfies never;
        return panic(`Unhandled corpus write plan: ${String(corpusPlan)}`);
      }
    }
  })();

  return {
    corpusPayload,
    corpusPlan,
    mirrorCarriesDocument,
    payloadColumns,
    storedPayloadUnchanged,
  };
};

type PlanDecisionWriteOptions = {
  result: IngestionResult;
  existing: ExistingDecision | undefined;
  decisionId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  corpus: CaseLawCorpusDependencies;
  incomingCarriesDocument: boolean;
  polarityRules: RuleCache | undefined;
};

/**
 * Everything the row write needs, computed before its transaction opens:
 * the payload and where it is stored, the identifiers, and the citation
 * rows read out of the document.
 */
export const planDecisionWrite = async ({
  result,
  existing,
  decisionId,
  sourceId,
  scopedDb,
  corpus,
  incomingCarriesDocument,
  polarityRules,
}: PlanDecisionWriteOptions) => {
  const sections = decisionSections(result);

  // A metadata-first source keeps refreshing a decision it has no
  // document for: the list endpoint's fields change, the hash moves, and
  // the adapter returns the same empty AST it returned at first sight.
  // Applying that over a decision whose document has since arrived — by
  // hydration or backfill — would put the empty AST back, and under
  // corpus storage would rewrite the objects empty and move the row's
  // keys onto them, which is precisely the state the repair pass exists
  // to undo. Nothing the refresh carries is a document, so nothing it
  // carries may replace one: the metadata is updated and the payload,
  // its object-storage pointers and the citations drawn from it are left
  // as they are.
  const preserveStoredDocument =
    existing !== undefined &&
    !incomingCarriesDocument &&
    (await hasStoredDocument(existing.id, scopedDb));
  const pendingMirrorPayload =
    existing?.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING &&
    !incomingCarriesDocument
      ? await loadPendingMirrorPayload(existing.id, scopedDb)
      : null;

  reportStoredDocumentQuality({
    result,
    sourceId,
    preserveStoredDocument,
    pendingMirrorPayload,
  });

  // The publisher's own statement of the case's procedural history, where
  // it supplies one; classification consults it before any heuristic.
  const proceduralKeys = proceduralKeysFromMetadata(
    result.metadata,
    (caseNumber) => bareCitationKey(caseNumber),
  );

  const decisionIdentifiers = decisionIdentifiersFromMetadata({
    caseNumber: result.caseNumber,
    ecli: result.ecli ?? null,
    identifiers: result.identifiers,
  });
  const identifierRows = decisionIdentifiers.map((identifier) => ({
    type: identifier.type,
    value: identifier.value,
    normalizedValue: normalizeDecisionIdentifierIn(result.country, identifier),
  }));
  const citations = extractCitations(
    sections.map((s) => ({ index: s.index, text: s.text })),
  ).filter((c) => !isSelfCitation(c.citationText, decisionIdentifiers));

  reportCitationRecall({
    result,
    citations,
    incomingCarriesDocument,
    preserveStoredDocument,
  });

  const languageGroupKey = result.ecli || `${sourceId}:${result.caseNumber}`;

  const {
    corpusPayload,
    corpusPlan,
    mirrorCarriesDocument,
    payloadColumns,
    storedPayloadUnchanged,
  } = planCorpusPayload({
    result,
    existing,
    decisionId,
    corpus,
    preserveStoredDocument,
    pendingMirrorPayload,
  });

  const incomingCitationKey = citationKeyOf(result.caseNumber);
  return {
    // Built here, outside the write transaction: classifying a citation
    // reads the polarity rules, and the write path must not hold a row
    // lock across that read. The citing row is either the one identity
    // resolution found or the one this attempt is about to insert under
    // the id it already reserved.
    citationRows: await buildCitationRows({
      citations,
      citingDecisionId: existing?.id ?? decisionId,
      language: result.language,
      polarityRules,
      proceduralKeys,
      scopedDb,
      sections,
    }),
    corpusPayload,
    corpusPlan,
    identifierRows,
    incomingCitationKey,
    languageGroupKey,
    mirrorCarriesDocument,
    payloadColumns,
    pendingMirrorPayload,
    storedPayloadUnchanged,
  };
};

/** What the row write is given to write, as planned before it. */
export type DecisionWritePlan = Awaited<ReturnType<typeof planDecisionWrite>>;
