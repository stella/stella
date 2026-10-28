import { panic } from "better-result";
import * as v from "valibot";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import type { AcceptingDocumentOcrAvailability } from "@stll/api-contract/document-ocr-availability";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";

const REQUEST_TIMEOUT_MS = 15_000;

const manualOcrResponseSchema = v.variant("outcome", [
  v.object({ outcome: v.literal("already_processed"), runId: v.string() }),
  v.object({
    outcome: v.literal("queued"),
    runId: v.string(),
    availability: v.variant("type", [
      v.object({ type: v.literal(DOCUMENT_OCR_AVAILABILITY.live.type) }),
      v.object({ type: v.literal(DOCUMENT_OCR_AVAILABILITY.batched.type) }),
    ]),
  }),
]);

type ManualOcrResponse = v.InferOutput<typeof manualOcrResponseSchema>;

type RequestManualOcrOptions = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

export const requestManualOcr = async ({
  entityId,
  fieldId,
  workspaceId,
}: RequestManualOcrOptions): Promise<ManualOcrResponse> => {
  const payload = await invokeCapability(
    "entities.ocr.create",
    async (request) =>
      unwrapApiResponse(
        await api
          .entities({ workspaceId })
          .entity({ entityId })
          .ocr.post(
            { fieldId },
            { ...request, fetch: { timeoutMs: REQUEST_TIMEOUT_MS } },
          ),
      ),
  );
  const parsed = v.safeParse(manualOcrResponseSchema, payload);
  if (!parsed.success) {
    return await Promise.reject(toAPIError({ status: 502, value: null }));
  }
  return parsed.output;
};

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
