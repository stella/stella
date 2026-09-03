import { panic } from "better-result";

import { publisherSummaryOf } from "@/api/lib/case-law/publisher-summary";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexContractDigest,
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
  corpusIndexPublisherSummaryField,
  corpusIndexStemFields,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import { MORPHOLOGY_VERSION } from "@/api/lib/legal-search/morphology/stem";

type ProjectionInputBase = {
  documentId: string;
  sourceId: string;
  jurisdiction: string;
  language: string;
  documentType: string | null;
  contentHash: string | null;
  redistributionEligible: boolean;
};

export type CaseLawProjectionInput = ProjectionInputBase & {
  family: "case_law";
  redacted: boolean;
  caseNumber: string;
  identifiers: readonly { type: string; value: string }[];
  court: string;
  decisionDate: string | null;
  ecli: string | null;
  /**
   * Publisher metadata as the adapter recorded it, read only through
   * `publisherSummaryOf`. The document AST is that summary's other source and
   * is deliberately absent here: it lives in object storage, while this input
   * is assembled per row inside the canonical transaction.
   */
  metadata: Record<string, unknown> | null;
};

export type LegislationV2ProjectionInput = ProjectionInputBase & {
  family: "legislation";
  title: string;
  status: string;
  effectiveDate: string | null;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  eli: string;
};

export type CorpusIndexProjectionInput =
  | CaseLawProjectionInput
  | LegislationV2ProjectionInput;

export type CorpusIndexProjectionDescriptor =
  | { action: "erase" }
  | { action: "upsert"; fingerprint: string; indexId: string };

const compareIdentifiers = (
  left: CaseLawProjectionInput["identifiers"][number],
  right: CaseLawProjectionInput["identifiers"][number],
): number => {
  if (left.type < right.type) {
    return -1;
  }
  if (left.type > right.type) {
    return 1;
  }
  if (left.value < right.value) {
    return -1;
  }
  return left.value > right.value ? 1 : 0;
};

export const caseLawProjectionTitle = ({
  identifiers,
  caseNumber,
  court,
}: Pick<
  CaseLawProjectionInput,
  "identifiers" | "caseNumber" | "court"
>): string => {
  const canonicalIdentifiers = identifiers.toSorted(compareIdentifiers);
  const reference =
    canonicalIdentifiers.length === 0
      ? caseNumber
      : canonicalIdentifiers.map(({ value }) => value).join(" · ");
  return `${reference} — ${court}`;
};

export const deriveCorpusIndexProjectionDescriptor = (
  manifest: CorpusIndexManifest,
  input: CorpusIndexProjectionInput,
): CorpusIndexProjectionDescriptor => {
  if (manifest.family !== input.family) {
    return panic(
      `Corpus projection family mismatch: ${manifest.family}/${input.family}`,
    );
  }
  if (
    input.contentHash === null ||
    EMPTY_CORPUS_CONTENT_HASHES.includes(input.contentHash) ||
    !input.redistributionEligible ||
    (input.family === "case_law" && input.redacted)
  ) {
    return { action: "erase" };
  }

  const indexId = corpusIndexIdFromManifest(manifest, input.jurisdiction);
  // The manifest digest pins the stem *fields*; the algorithms filling them
  // live outside it, so a new language or a Snowball upgrade would otherwise
  // leave already-projected documents holding stems the read path no longer
  // asks for. A generation that writes stem fields folds the stemmer set in
  // and re-projects when it moves; one that writes none keeps the
  // fingerprints it already has.
  const morphology =
    corpusIndexStemFields(manifest) === null
      ? {}
      : { morphology: MORPHOLOGY_VERSION };
  const common = {
    contract: "corpus-index-projection-v1",
    manifestDigest: corpusIndexManifestDigest(manifest),
    documentId: input.documentId,
    contentHash: input.contentHash,
    indexId,
    jurisdiction: input.jurisdiction.toUpperCase(),
    source: input.sourceId,
    language: input.language,
    documentType: input.documentType,
    redistributionEligible: true,
    ...morphology,
  } as const;

  switch (input.family) {
    case "case_law": {
      // A fingerprint has to cover everything the generation writes. The
      // summary's AST source is already covered through `contentHash`; its
      // metadata source is not, so a generation carrying the field folds the
      // metadata reading in and re-projects when a publisher edits it. A
      // generation without the field keeps the fingerprints it already has.
      const publisherSummary =
        corpusIndexPublisherSummaryField(manifest) === null
          ? {}
          : {
              publisherSummary: publisherSummaryOf({
                documentAst: null,
                metadata: input.metadata,
              }),
            };
      return {
        action: "upsert",
        indexId,
        fingerprint: corpusIndexContractDigest({
          ...common,
          title: caseLawProjectionTitle(input),
          caseNumber: input.caseNumber,
          court: input.court,
          decisionDate: input.decisionDate,
          decisionDateTimestamp:
            input.decisionDate ?? UNDATED_DECISION_TIMESTAMP,
          ecli: input.ecli,
          ...publisherSummary,
        }),
      };
    }
    case "legislation":
      return {
        action: "upsert",
        indexId,
        fingerprint: corpusIndexContractDigest({
          ...common,
          title: input.title,
          status: input.status,
          effectiveDate: input.effectiveDate,
          versionValidFrom: input.versionValidFrom,
          versionValidTo: input.versionValidTo,
          eli: input.eli,
        }),
      };
    default:
      return input satisfies never;
  }
};
