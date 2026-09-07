import { panic } from "better-result";

import {
  publisherHeadnoteOf,
  publisherKeywordsOf,
  publisherSummaryOf,
} from "@/api/lib/case-law/publisher-summary";
import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexContractDigest,
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
  corpusIndexPublisherFields,
  corpusIndexStemFields,
  type CorpusIndexManifest,
  type CorpusIndexPublisherFields,
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

type PublisherFingerprintFields = {
  publisherSummary?: string | null;
  keywords?: string | null;
};

/**
 * The publisher text a generation's fingerprint covers. Keyed by what the
 * reading means rather than by the field it lands in, and derived from the
 * same union the writer branches on, so a fingerprint cannot describe a
 * reading the writer does not perform.
 */
const publisherFingerprintFields = (
  publisher: CorpusIndexPublisherFields,
  metadata: Record<string, unknown> | null,
): PublisherFingerprintFields => {
  const input = { documentAst: null, metadata };
  switch (publisher.kind) {
    case "none":
      return {};
    case "summary":
      return { publisherSummary: publisherSummaryOf(input) };
    case "summary_and_keywords":
      return {
        publisherSummary: publisherHeadnoteOf(input),
        keywords: publisherKeywordsOf(input),
      };
    default:
      publisher satisfies never;
      return panic(`Unhandled publisher fields: ${String(publisher)}`);
  }
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
      // A fingerprint has to cover everything the generation writes, under the
      // exact reading that generation writes it with. The AST source is
      // already covered through `contentHash`; the metadata sources are not,
      // so a generation carrying a publisher field folds its metadata reading
      // in and re-projects when a publisher edits it. A generation without the
      // fields keeps the fingerprints it already has.
      const publisher = publisherFingerprintFields(
        corpusIndexPublisherFields(manifest),
        input.metadata,
      );
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
          ...publisher,
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
      input satisfies never;
      return panic(`Unhandled input: ${String(input)}`);
  }
};
