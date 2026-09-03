import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { hasUsableAst } from "@/api/lib/case-law/document-ast";
import { publisherSummaryOf } from "@/api/lib/case-law/publisher-summary";
import { chunkDocument } from "@/api/lib/corpus-index/chunking";
import type { CorpusDocumentPayload } from "@/api/lib/corpus-index/core";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexPublisherSummaryField,
  corpusIndexStemFields,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  caseLawProjectionTitle,
  type CaseLawProjectionInput,
  type LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { documentMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { stemCorpusText } from "@/api/lib/legal-search/morphology/stem-text";

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

type SharedProjectionDocument = {
  document_id: string;
  projection_revision: ProjectionRevision;
  jurisdiction: string;
  source: string;
  language: string;
  document_type?: string;
  title?: string;
  text: string;
  is_opening: boolean;
};

type CaseLawProjectionDocument = SharedProjectionDocument & {
  anchor_id?: string;
  case_number: string;
  court: string;
  decision_date?: string;
  decision_date_ts: string;
  decision_year?: number;
  ecli?: string;
  headnote?: string;
  text_stem?: string;
  headnote_stem?: string;
};

type LegislationV2ProjectionDocument = SharedProjectionDocument & {
  status: string;
  effective_date?: string;
  version_valid_from?: string;
  version_valid_to?: string;
  eli: string;
};

type ProjectionBuildBase = {
  payload: CorpusDocumentPayload;
  revision: ProjectionRevision;
};

/**
 * The family is carried at the top level so the manifest and the input are
 * paired by the type rather than by a runtime check: a case-law manifest can
 * only arrive with a case-law input, and the dispatch below narrows both at
 * once.
 */
type BuildCorpusProjectionDocumentsOptions =
  | (ProjectionBuildBase & {
      family: "case_law";
      manifest: Extract<CorpusIndexManifest, { family: "case_law" }>;
      input: CaseLawProjectionInput;
    })
  | (ProjectionBuildBase & {
      family: "legislation";
      manifest: Extract<CorpusIndexManifest, { family: "legislation" }>;
      input: LegislationV2ProjectionInput;
    });

const sharedFields = (
  input: CaseLawProjectionInput | LegislationV2ProjectionInput,
  revision: ProjectionRevision,
): Omit<SharedProjectionDocument, "title" | "text" | "is_opening"> => ({
  document_id: input.documentId,
  projection_revision: revision,
  jurisdiction: input.jurisdiction.toUpperCase(),
  source: input.sourceId,
  language: input.language,
  ...(input.documentType === null ? {} : { document_type: input.documentType }),
});

type BuildCaseLawOptions = ProjectionBuildBase & {
  manifest: Extract<CorpusIndexManifest, { family: "case_law" }>;
  input: CaseLawProjectionInput;
};

const CASE_LAW_DECISION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const buildCaseLawProjectionDocuments = ({
  manifest,
  input,
  payload,
  revision,
}: BuildCaseLawOptions): CaseLawProjectionDocument[] => {
  if (
    input.decisionDate !== null &&
    !CASE_LAW_DECISION_DATE_PATTERN.test(input.decisionDate)
  ) {
    return panic("Case-law projection decision date is not canonical");
  }
  const shared = {
    ...sharedFields(input, revision),
    case_number: input.caseNumber,
    court: input.court,
    decision_date_ts: input.decisionDate ?? UNDATED_DECISION_TIMESTAMP,
    ...(input.decisionDate === null
      ? {}
      : { decision_date: input.decisionDate }),
    ...(input.ecli === null ? {} : { ecli: input.ecli }),
  };
  const title = caseLawProjectionTitle(input);
  const decisionYear =
    input.decisionDate === null ? null : Number(input.decisionDate.slice(0, 4));
  const ast = hasUsableAst(payload.ast) ? payload.ast : null;
  // The full source list, AST roles included: this is the one place holding
  // both a parsed document and its publisher metadata. The read path sees the
  // metadata prefix of the same list, so the indexed line is never a different
  // answer, only a better one.
  const summaryField = corpusIndexPublisherSummaryField(manifest);
  const summary =
    summaryField === null
      ? null
      : publisherSummaryOf({ documentAst: ast, metadata: input.metadata });
  // Stems come from the decision's own language, not its jurisdiction: an
  // index group spans several countries and a court may publish in more than
  // one language. A language with no stemmer writes no stem fields at all,
  // rather than a copy of the surface text under a stem name.
  const stemFields = corpusIndexStemFields(manifest);
  const stemLanguage = documentMorphologyLanguage(input.language);
  const stemmed =
    stemFields === null || stemLanguage === null
      ? null
      : { fields: stemFields, language: stemLanguage };
  const summaryStem =
    stemmed === null || summary === null
      ? null
      : stemCorpusText(summary, stemmed.language);
  const chunks = chunkDocument({ ast, fallbackText: payload.text });
  const documents: CaseLawProjectionDocument[] = [];
  for (const chunk of chunks) {
    const textStem =
      stemmed === null ? null : stemCorpusText(chunk.text, stemmed.language);
    documents.push({
      ...shared,
      text: chunk.text,
      is_opening: chunk.seq === 0,
      ...(chunk.seq === 0 ? { title } : {}),
      ...(chunk.seq === 0 && decisionYear !== null
        ? { decision_year: decisionYear }
        : {}),
      // Opening passage only, like `title`: a document-level line repeated on
      // every passage would let one decision answer a broad query as many
      // times as it has passages. The summary's stem follows it, so the two
      // are always written together or not at all.
      ...(chunk.seq === 0 && summaryField !== null && summary !== null
        ? { [summaryField]: summary }
        : {}),
      ...(chunk.seq === 0 && stemmed !== null && summaryStem !== null
        ? { [stemmed.fields.publisherSummary]: summaryStem }
        : {}),
      // Per passage, beside that passage's own text, so a stemmed phrase
      // matches inside one passage exactly as a surface phrase does.
      ...(stemmed !== null && textStem !== null && textStem !== ""
        ? { [stemmed.fields.text]: textStem }
        : {}),
      ...(chunk.anchorId === null ? {} : { anchor_id: chunk.anchorId }),
    });
  }
  return documents;
};

type BuildLegislationV2Options = ProjectionBuildBase & {
  input: LegislationV2ProjectionInput;
};

export const buildLegislationV2ProjectionDocuments = ({
  input,
  payload,
  revision,
}: BuildLegislationV2Options): [LegislationV2ProjectionDocument] => [
  {
    ...sharedFields(input, revision),
    title: input.title,
    text: payload.text,
    is_opening: true,
    status: input.status,
    eli: input.eli,
    ...(input.effectiveDate === null
      ? {}
      : { effective_date: input.effectiveDate }),
    ...(input.versionValidFrom === null
      ? {}
      : { version_valid_from: input.versionValidFrom }),
    ...(input.versionValidTo === null
      ? {}
      : { version_valid_to: input.versionValidTo }),
  },
];

export const buildCorpusProjectionDocuments = (
  options: BuildCorpusProjectionDocumentsOptions,
): Record<string, unknown>[] => {
  switch (options.family) {
    case "case_law":
      return buildCaseLawProjectionDocuments({
        manifest: options.manifest,
        input: options.input,
        payload: options.payload,
        revision: options.revision,
      });
    case "legislation":
      return buildLegislationV2ProjectionDocuments({
        input: options.input,
        payload: options.payload,
        revision: options.revision,
      });
    default:
      return options satisfies never;
  }
};
