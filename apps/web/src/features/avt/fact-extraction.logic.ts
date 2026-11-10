/**
 * Where a list's latest fact extraction stands, read off its generation runs
 * and candidates. stella's own fact runs are the only ones AVT follows; an
 * external client's runs stay on the lists page.
 */

import { panic } from "better-result";

import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

import type {
  GenerationRunErrorCode,
  GenerationRunSummary,
} from "@/features/avt/types";
import { EXTRACTION_ERROR_KEYS } from "@/features/avt/types";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";
import type { WorkspaceFile } from "@/lib/workspaces/queries/entities";

/** Documents one extraction reads, the start endpoint's cap. */
export const FACT_EXTRACTION_DOCUMENTS_MAX = 25;

type RunRef = Pick<
  GenerationRunSummary,
  "id" | "status" | "producer" | "itemType" | "errorCode"
>;

type ExtractionErrorKey =
  (typeof EXTRACTION_ERROR_KEYS)[keyof typeof EXTRACTION_ERROR_KEYS];

export type ExtractionPhase =
  | { type: "none" }
  | { type: "queued"; runId: string }
  | { type: "running"; runId: string }
  | { type: "failed"; runId: string; errorKey: ExtractionErrorKey }
  | { type: "review"; runId: string }
  | { type: "settled"; runId: string };

/** The newest fact extraction stella ran for the list; runs come newest first. */
export const latestFactExtraction = <T extends RunRef>(
  runs: readonly T[],
): T | null =>
  runs.find((run) => run.producer === "stella" && run.itemType === "fact") ??
  null;

export const extractionPhase = (run: RunRef | null): ExtractionPhase => {
  if (run === null) {
    return { type: "none" };
  }
  switch (run.status) {
    case "queued":
    case "running":
    case "review": {
      return { type: run.status, runId: run.id };
    }
    case "failed": {
      return {
        type: "failed",
        runId: run.id,
        errorKey: extractionErrorKey(run.errorCode),
      };
    }
    case "committed": {
      return { type: "settled", runId: run.id };
    }
    case "cancelled": {
      return { type: "none" };
    }
    default: {
      run.status satisfies never;
      return panic(`Unhandled generation run status: ${String(run.status)}`);
    }
  }
};

/**
 * A run still in progress or waiting for its review holds off the next one:
 * a newer run would take its place here and leave its proposals unreviewed.
 */
export const isExtractionBusy = (phase: ExtractionPhase): boolean =>
  phase.type === "queued" ||
  phase.type === "running" ||
  phase.type === "review";

const extractionErrorKey = (
  code: GenerationRunErrorCode | null,
): ExtractionErrorKey => EXTRACTION_ERROR_KEYS[code ?? "internal"];

type PickableDocument = Pick<
  WorkspaceFile,
  "entityId" | "fileName" | "mimeType" | "name"
>;

/**
 * The documents a fact extraction can read (DOCX and PDF), narrowed by the
 * search, with the chosen ones first in the order they were chosen so a
 * long matter never scrolls them out of sight.
 */
export const pickableDocuments = <T extends PickableDocument>(
  files: readonly T[],
  picked: readonly string[],
  search: string,
): T[] => {
  const matches = createSearchQueryMatcher(search);
  const readable = files.filter(
    (file) => file.mimeType === DOCX_MIME || file.mimeType === PDF_MIME,
  );
  const chosen = picked.flatMap((entityId) => {
    const file = readable.find((entry) => entry.entityId === entityId);
    return file === undefined ? [] : [file];
  });
  const rest = readable.filter(
    (file) =>
      !picked.includes(file.entityId) && matches(file.name ?? file.fileName),
  );
  return [...chosen, ...rest];
};

/**
 * The refusals of a start request that name something the reviewer can fix,
 * by the API's error code. Any other refusal reads as a failed start.
 */
export const startRefusalKey = (code: string | undefined) => {
  if (code === undefined) {
    return null;
  }
  switch (code) {
    case "document_encrypted": {
      return "errors.apiCodes.encryptedContent";
    }
    case "document_format_unsupported": {
      return "avt.extraction.errors.unsupportedFormat";
    }
    case "list_or_document_not_found": {
      return "avt.extraction.errors.documentMissing";
    }
    default: {
      return null;
    }
  }
};
