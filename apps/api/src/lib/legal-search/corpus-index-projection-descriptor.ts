import { panic } from "better-result";

import { UNDATED_DECISION_TIMESTAMP } from "@/api/lib/legal-search/corpus-index-config";
import {
  corpusIndexContractDigest,
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

type ProjectionInputBase = {
  documentId: string;
  sourceId: string;
  jurisdiction: string;
  language: string;
  documentType: string | null;
  contentHash: string | null;
  redistributionEligible: boolean;
};

export type CaseLawV5ProjectionInput = ProjectionInputBase & {
  family: "case_law";
  redacted: boolean;
  caseNumber: string;
  identifiers: readonly { type: string; value: string }[];
  court: string;
  decisionDate: string | null;
  ecli: string | null;
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
  | CaseLawV5ProjectionInput
  | LegislationV2ProjectionInput;

export type CorpusIndexProjectionDescriptor =
  | { action: "erase" }
  | { action: "upsert"; fingerprint: string; indexId: string };

const compareIdentifiers = (
  left: CaseLawV5ProjectionInput["identifiers"][number],
  right: CaseLawV5ProjectionInput["identifiers"][number],
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

export const caseLawV5Title = ({
  identifiers,
  caseNumber,
  court,
}: Pick<
  CaseLawV5ProjectionInput,
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
    !input.redistributionEligible ||
    (input.family === "case_law" && input.redacted)
  ) {
    return { action: "erase" };
  }

  const indexId = corpusIndexIdFromManifest(manifest, input.jurisdiction);
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
  } as const;

  switch (input.family) {
    case "case_law":
      return {
        action: "upsert",
        indexId,
        fingerprint: corpusIndexContractDigest({
          ...common,
          title: caseLawV5Title(input),
          caseNumber: input.caseNumber,
          court: input.court,
          decisionDate: input.decisionDate,
          decisionDateTimestamp:
            input.decisionDate ?? UNDATED_DECISION_TIMESTAMP,
          ecli: input.ecli,
        }),
      };
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
