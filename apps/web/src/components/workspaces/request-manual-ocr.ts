import { panic } from "better-result";

import type { AcceptingDocumentOcrAvailability } from "@stll/api-contract/document-ocr-availability";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";

type ManualOcrResponse =
  | { outcome: "already_processed"; runId: string }
  | {
      outcome: "queued";
      runId: string;
      availability: AcceptingDocumentOcrAvailability;
    };

type RequestManualOcrOptions = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

export const requestManualOcr = async ({
  entityId,
  fieldId,
  workspaceId,
}: RequestManualOcrOptions): Promise<ManualOcrResponse> =>
  unwrapApiResponse(
    await api
      .entities({ workspaceId })
      .entity({ entityId })
      .ocr.post({ fieldId }),
  );

const QUEUED_OCR_TOAST_KEYS = {
  live: "workspaces.files.ocrQueued",
  batched: "workspaces.files.ocrQueuedForBatch",
} as const satisfies Record<
  AcceptingDocumentOcrAvailability["type"],
  TranslationKey
>;

const OCR_ALREADY_PROCESSED_TOAST_KEY =
  "workspaces.files.ocrAlreadyProcessed" as const satisfies TranslationKey;

// The literal keys, not `TranslationKey`: `t()` over the whole key union is
// too complex for the checker to represent.
type ManualOcrSuccessKey =
  | typeof OCR_ALREADY_PROCESSED_TOAST_KEY
  | (typeof QUEUED_OCR_TOAST_KEYS)[keyof typeof QUEUED_OCR_TOAST_KEYS];

/** The success toast for a manual OCR request: done, queued, or batched. */
export const manualOcrSuccessKey = (
  response: ManualOcrResponse,
): ManualOcrSuccessKey => {
  switch (response.outcome) {
    case "already_processed":
      return OCR_ALREADY_PROCESSED_TOAST_KEY;
    case "queued":
      return QUEUED_OCR_TOAST_KEYS[response.availability.type];
    default:
      response satisfies never;
      return panic("Unhandled manual OCR outcome");
  }
};
