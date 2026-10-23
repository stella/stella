import { Result } from "better-result";

import type { TextField } from "@stll/api-contract/case-law-text-field";
import { DECISION_DOCUMENT_ROLE_METADATA_KEY } from "@stll/api-contract/decision-document-role";
// parser-output-unchanged: SHA-256 ownership changes preserve input bytes, serialization and update order, so stored hashes and parser output remain identical.
import { createSha256 } from "@stll/sha256/bun";

import type { caseLawDecisions } from "@/api/db/schema";
import { EU_ECJ_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj.metadata-urls";
import {
  splitStoredDecisionTextMetadata,
  TEXT_FIELD_TYPE,
} from "@/api/lib/case-law/decision-text";
import type {
  DecisionJudgeInput,
  IngestionResult,
  RawIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  toPlainTextIngestionResult,
} from "@/api/lib/legal-search/ingestion-types";
import { sortDeep } from "@/api/lib/sort-deep";
import { isRecord } from "@/api/lib/type-guards";

export const ECJ_COMPLETION_PROTECTED_COLUMNS = [
  "caseNumber",
  "caseNumberType",
  "sourceDocumentId",
  "ecli",
  "court",
  "courtId",
  "country",
  "language",
  "sheetNumber",
  "decisionDate",
  "decisionType",
  "sourceUrl",
  "documentUrl",
  "fulltext",
] as const satisfies readonly (keyof IngestionResult)[];

export type EcjCompletionStoredDecision = Pick<
  typeof caseLawDecisions.$inferSelect,
  | (typeof ECJ_COMPLETION_PROTECTED_COLUMNS)[number]
  | "metadata"
  | "sections"
  | "documentAst"
  | "sourceRaw"
  | "sourceRawS3Key"
  | "sourceRawContentType"
  | "sourceHash"
  | "parserVersion"
  | "textS3Key"
  | "normalizedS3Key"
  | "astS3Key"
  | "contentHash"
  | "redactedAt"
>;

type EcjCompletionProtectionOptions = {
  existing: EcjCompletionStoredDecision;
  candidate: IngestionResult;
  judges: readonly DecisionJudgeInput[];
};

type EcjCompletionProtectionOutcome =
  | { type: "accepted"; candidate: IngestionResult }
  | { type: "review-required"; fields: string[] };

const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(sortDeep(left)) === JSON.stringify(sortDeep(right));

type MergeMetadataOptions = {
  existing: Record<string, unknown>;
  candidate: Record<string, unknown>;
  path: string;
  conflicts: string[];
};

const mergeMetadata = ({
  existing,
  candidate,
  path,
  conflicts,
}: MergeMetadataOptions): Record<string, unknown> => {
  const merged = Object.fromEntries(Object.entries(existing));
  for (const [key, incoming] of Object.entries(candidate)) {
    const stored = Object.hasOwn(existing, key) ? existing[key] : undefined;
    const field = `${path}.${key}`;
    let value = stored;
    if (stored === undefined || stored === null) {
      value = incoming;
    } else if (incoming === undefined || incoming === null) {
      value = stored;
    } else if (isRecord(stored) && isRecord(incoming)) {
      value = mergeMetadata({
        existing: stored,
        candidate: incoming,
        path: field,
        conflicts,
      });
    } else if (!sameValue(stored, incoming)) {
      conflicts.push(field);
    }
    // Own data properties preserve unusual publisher keys without prototype mutation.
    Object.defineProperty(merged, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return merged;
};

type PreserveStoredStatementsOptions = EcjCompletionProtectionOptions & {
  metadata: Record<string, unknown>;
  textFields: RawIngestionResult["textFields"];
  hasStoredAst: boolean;
};
const preserveStoredStatements = ({
  existing,
  candidate,
  judges,
  metadata,
  textFields,
  hasStoredAst,
}: PreserveStoredStatementsOptions): RawIngestionResult => ({
  ...candidate,
  caseNumberType: candidate.caseNumberType ?? existing.caseNumberType,
  sourceDocumentId:
    candidate.sourceDocumentId ?? existing.sourceDocumentId ?? undefined,
  ecli: candidate.ecli ?? existing.ecli ?? undefined,
  courtId: candidate.courtId ?? existing.courtId ?? undefined,
  sheetNumber: candidate.sheetNumber ?? existing.sheetNumber ?? undefined,
  decisionDate: candidate.decisionDate ?? existing.decisionDate ?? undefined,
  decisionType: candidate.decisionType ?? existing.decisionType ?? undefined,
  sourceUrl: candidate.sourceUrl ?? existing.sourceUrl ?? undefined,
  documentUrl: candidate.documentUrl ?? existing.documentUrl ?? undefined,
  fulltext: candidate.fulltext ?? existing.fulltext ?? undefined,
  metadata,
  textFields,
  ...(judges.length > 0 ? { judges } : {}),
  // Existing document structure is part of the stated document, not a new surface.
  ...(hasStoredAst && existing.documentAst !== null
    ? { documentAst: existing.documentAst }
    : {}),
  ...(existing.sections !== null ? { sections: existing.sections } : {}),
});

/** Completion may add a statement; it cannot revise or remove one. */
export const protectEcjCompletion = ({
  existing,
  candidate,
  judges,
}: EcjCompletionProtectionOptions): EcjCompletionProtectionOutcome => {
  const fields: string[] = [];
  for (const key of ECJ_COMPLETION_PROTECTED_COLUMNS) {
    const stored = existing[key];
    const incoming = candidate[key];
    if (
      stored !== null &&
      incoming !== undefined &&
      !sameValue(stored, incoming)
    ) {
      fields.push(key);
    }
  }
  if (existing.redactedAt !== null) {
    fields.push("redactedAt");
  }
  if (
    judges.length > 0 &&
    candidate.judges !== undefined &&
    !sameValue(judges, candidate.judges)
  ) {
    fields.push("judges");
  }
  if (
    existing.sections !== null &&
    candidate.sections !== undefined &&
    !sameValue(existing.sections, candidate.sections)
  ) {
    fields.push("sections");
  }
  const hasStoredAst =
    existing.documentAst !== null &&
    Object.keys(existing.documentAst).length > 0;
  if (
    hasStoredAst &&
    Object.keys(candidate.documentAst).length > 0 &&
    !sameValue(existing.documentAst, candidate.documentAst)
  ) {
    fields.push("documentAst");
  }
  const storedText = splitStoredDecisionTextMetadata(existing.metadata ?? {});
  const incomingText = splitStoredDecisionTextMetadata(candidate.metadata);
  const metadata = mergeMetadata({
    existing: storedText.metadata,
    candidate: incomingText.metadata,
    path: "metadata",
    conflicts: fields,
  });
  const documentRole = storedText.metadata[DECISION_DOCUMENT_ROLE_METADATA_KEY];
  if (
    documentRole !== undefined &&
    documentRole !== null &&
    candidate.documentRole !== undefined &&
    documentRole !== candidate.documentRole
  ) {
    fields.push("documentRole");
  }
  const protectText = (
    stored: TextField,
    incoming: TextField,
    key: string,
  ): TextField => {
    if (stored.type === TEXT_FIELD_TYPE.ABSENT) {
      return incoming;
    }
    if (
      incoming.type === TEXT_FIELD_TYPE.PRESENT &&
      incoming.text !== stored.text
    ) {
      fields.push(`textFields.${key}`);
    }
    return stored;
  };
  const textFields = {
    abstract: protectText(
      protectText(
        storedText.textFields.abstract,
        incomingText.textFields.abstract,
        "abstract",
      ),
      candidate.textFields.abstract,
      "abstract",
    ),
    headnote: protectText(
      protectText(
        storedText.textFields.headnote,
        incomingText.textFields.headnote,
        "headnote",
      ),
      candidate.textFields.headnote,
      "headnote",
    ),
    legalSentence: protectText(
      protectText(
        storedText.textFields.legalSentence,
        incomingText.textFields.legalSentence,
        "legalSentence",
      ),
      candidate.textFields.legalSentence,
      "legalSentence",
    ),
    summary: protectText(
      protectText(
        storedText.textFields.summary,
        incomingText.textFields.summary,
        "summary",
      ),
      candidate.textFields.summary,
      "summary",
    ),
  };
  if (fields.length > 0) {
    return { type: "review-required", fields: [...new Set(fields)] };
  }
  // Stored values re-enter through the same plain-text boundary as a crawl.
  const branded = toPlainTextIngestionResult(
    preserveStoredStatements({
      existing,
      candidate,
      judges,
      metadata,
      textFields,
      hasStoredAst,
    }),
    EU_ECJ_METADATA_URL_SCHEMA,
  );
  if (branded.isErr()) {
    return { type: "review-required", fields: ["plainText"] };
  }
  return { type: "accepted", candidate: branded.value };
};

type EcjCompletionFormexPartsOptions = {
  storedRaw: Uint8Array;
  storedRawContentType?: string | null;
  candidate: Pick<IngestionResult, "sourceRaw" | "sourceRawBytes">;
};

/** The fetched stored bytes, including offloaded raw, are the preservation boundary. */
export const protectEcjFormexParts = ({
  storedRaw,
  storedRawContentType,
  candidate,
}: EcjCompletionFormexPartsOptions):
  | { type: "accepted" }
  | { type: "review-required"; fields: string[] } => {
  const decoded = Result.try({
    try: () => ({
      before: new TextDecoder("utf-8", { fatal: true }).decode(storedRaw),
      after:
        candidate.sourceRawBytes === undefined
          ? candidate.sourceRaw
          : new TextDecoder("utf-8", { fatal: true }).decode(
              candidate.sourceRawBytes,
            ),
    }),
    catch: () => null,
  }).unwrapOr(null);
  if (decoded === null) {
    return { type: "review-required", fields: ["sourceRaw"] };
  }
  const { before, after } = decoded;
  const decodedStored = decodeSourceRawEnvelope(before);
  const stored =
    decodedStored ??
    (storedRawContentType !== undefined &&
    storedRawContentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE
      ? { document: before }
      : null);
  const incoming = after === undefined ? null : decodeSourceRawEnvelope(after);
  if (stored === null || incoming === null || after === undefined) {
    return { type: "review-required", fields: ["sourceRaw"] };
  }
  const fields: string[] = [];
  for (const key of new Set([
    ...Object.keys(stored),
    ...Object.keys(incoming),
  ])) {
    if (key !== "formex" && stored[key] !== incoming[key]) {
      fields.push(`sourceRaw.parts.${key}`);
    }
  }
  if (incoming["formex"] === undefined) {
    fields.push("sourceRaw.parts.formex");
  }
  if (
    !sameValue(
      decodeSourceRawEnvelopeObjects(before),
      decodeSourceRawEnvelopeObjects(after),
    )
  ) {
    fields.push("sourceRaw.objects");
  }
  return fields.length > 0
    ? { type: "review-required", fields }
    : { type: "accepted" };
};

type EcjCompletionLegacyDocumentOptions = EcjCompletionFormexPartsOptions;

/** A full fetch may add surfaces, but cannot revise any stored source part. */
export const protectEcjLegacyDocument = ({
  storedRaw,
  storedRawContentType,
  candidate,
}: EcjCompletionLegacyDocumentOptions):
  | { type: "accepted" }
  | { type: "review-required"; fields: string[] } => {
  const decoded = Result.try({
    try: () => ({
      before: new TextDecoder("utf-8", { fatal: true }).decode(storedRaw),
      after:
        candidate.sourceRawBytes === undefined
          ? candidate.sourceRaw
          : new TextDecoder("utf-8", { fatal: true }).decode(
              candidate.sourceRawBytes,
            ),
    }),
    catch: () => null,
  }).unwrapOr(null);
  if (decoded === null) {
    return { type: "review-required", fields: ["sourceRaw"] };
  }
  if (decoded.after === undefined) {
    return { type: "review-required", fields: ["sourceRaw"] };
  }
  const stored = decodeSourceRawEnvelope(decoded.before);
  const incoming = decodeSourceRawEnvelope(decoded.after);
  if (stored !== null) {
    if (incoming === null) {
      return { type: "review-required", fields: ["sourceRaw"] };
    }
    const fields: string[] = [];
    for (const [part, original] of Object.entries(stored)) {
      if (incoming[part] !== original) {
        fields.push(`sourceRaw.parts.${part}`);
      }
    }
    const storedObjects = decodeSourceRawEnvelopeObjects(decoded.before);
    const incomingObjects = decodeSourceRawEnvelopeObjects(decoded.after);
    for (const [part, original] of Object.entries(storedObjects)) {
      if (!sameValue(incomingObjects[part], original)) {
        fields.push(`sourceRaw.objects.${part}`);
      }
    }
    return fields.length > 0
      ? { type: "review-required", fields }
      : { type: "accepted" };
  }
  if (storedRawContentType === SOURCE_RAW_ENVELOPE_CONTENT_TYPE) {
    return { type: "review-required", fields: ["sourceRaw"] };
  }
  return incoming?.["document"] === decoded.before
    ? { type: "accepted" }
    : { type: "review-required", fields: ["sourceRaw.parts.document"] };
};

type EcjCompletionFingerprintOptions = Pick<
  EcjCompletionProtectionOptions,
  "existing" | "judges"
>;

/** Observation timestamps/orders do not identify the content completion claimed. */
export const ecjCompletionFingerprint = ({
  existing,
  judges,
}: EcjCompletionFingerprintOptions): string => {
  const state = {
    statements: Object.fromEntries(
      ECJ_COMPLETION_PROTECTED_COLUMNS.map((key) => [key, existing[key]]),
    ),
    metadata: existing.metadata,
    judges,
    sections: existing.sections,
    documentAst: existing.documentAst,
    sourceRaw: existing.sourceRaw,
    sourceRawS3Key: existing.sourceRawS3Key,
    sourceRawContentType: existing.sourceRawContentType,
    sourceHash: existing.sourceHash,
    parserVersion: existing.parserVersion,
    textS3Key: existing.textS3Key,
    normalizedS3Key: existing.normalizedS3Key,
    astS3Key: existing.astS3Key,
    contentHash: existing.contentHash,
    redactedAt: existing.redactedAt?.toISOString() ?? null,
  };
  return createSha256()
    .update(JSON.stringify(sortDeep(state)))
    .digest("hex");
};
