import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { hasUsableAst } from "@/api/lib/case-law/document-ast";
import { chunkDocument } from "@/api/lib/corpus-index/chunking";
import type { CorpusDocumentPayload } from "@/api/lib/corpus-index/core";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  caseLawV5Title,
  type CaseLawV5ProjectionInput,
  type LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";

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

type CaseLawV5ProjectionDocument = SharedProjectionDocument & {
  anchor_id?: string;
  case_number: string;
  court: string;
  decision_date?: string;
  decision_date_ts: string;
  decision_year?: number;
  ecli?: string;
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

type BuildCorpusProjectionDocumentsOptions =
  | (ProjectionBuildBase & {
      manifest: Extract<CorpusIndexManifest, { family: "case_law" }>;
      input: CaseLawV5ProjectionInput;
    })
  | (ProjectionBuildBase & {
      manifest: Extract<CorpusIndexManifest, { family: "legislation" }>;
      input: LegislationV2ProjectionInput;
    });

const sharedFields = (
  input: CaseLawV5ProjectionInput | LegislationV2ProjectionInput,
  revision: ProjectionRevision,
): Omit<SharedProjectionDocument, "title" | "text" | "is_opening"> => ({
  document_id: input.documentId,
  projection_revision: revision,
  jurisdiction: input.jurisdiction.toUpperCase(),
  source: input.sourceId,
  language: input.language,
  ...(input.documentType === null ? {} : { document_type: input.documentType }),
});

type BuildCaseLawV5Options = ProjectionBuildBase & {
  input: CaseLawV5ProjectionInput;
};

const CASE_LAW_DECISION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const buildCaseLawV5ProjectionDocuments = ({
  input,
  payload,
  revision,
}: BuildCaseLawV5Options): CaseLawV5ProjectionDocument[] => {
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
  const title = caseLawV5Title(input);
  const decisionYear =
    input.decisionDate === null ? null : Number(input.decisionDate.slice(0, 4));
  const chunks = chunkDocument({
    ast: hasUsableAst(payload.ast) ? payload.ast : null,
    fallbackText: payload.text,
  });
  const documents: CaseLawV5ProjectionDocument[] = [];
  for (const chunk of chunks) {
    documents.push({
      ...shared,
      text: chunk.text,
      is_opening: chunk.seq === 0,
      ...(chunk.seq === 0 ? { title } : {}),
      ...(chunk.seq === 0 && decisionYear !== null
        ? { decision_year: decisionYear }
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
  if (options.input.family === "case_law") {
    if (options.manifest.projection.builderVersion !== "case-law-passages-v1") {
      return panic("Case-law projection input has a non-case-law manifest");
    }
    return buildCaseLawV5ProjectionDocuments({
      input: options.input,
      payload: options.payload,
      revision: options.revision,
    });
  }
  if (
    options.manifest.projection.builderVersion !== "legislation-document-v1"
  ) {
    return panic("Legislation projection input has a non-legislation manifest");
  }
  return buildLegislationV2ProjectionDocuments({
    input: options.input,
    payload: options.payload,
    revision: options.revision,
  });
};
