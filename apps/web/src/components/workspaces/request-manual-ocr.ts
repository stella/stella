import { panic } from "better-result";
import * as v from "valibot";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";
import type { AcceptingDocumentOcrAvailability } from "@stll/api-contract/document-ocr-availability";
import { fetchWithTimeout } from "@stll/fetch";

import type { TranslationKey } from "@/i18n/types";
import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";

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

type RequestManualOcrOptions = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

export const requestManualOcr = async ({
  entityId,
  fieldId,
  workspaceId,
}: RequestManualOcrOptions) => {
  const response = await fetchWithTimeout(
    apiUrl(
      `/entities/${encodeURIComponent(workspaceId)}/entity/${encodeURIComponent(entityId)}/ocr`,
    ),
    {
      body: JSON.stringify({ fieldId }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );
  if (!response.ok) {
    throw toAPIError({ status: response.status, value: null });
  }

  const payload: unknown = await response.json();
  const parsed = v.safeParse(manualOcrResponseSchema, payload);
  if (!parsed.success) {
    throw toAPIError({ status: 502, value: null });
  }
  return parsed.output;
};

type ManualOcrResponse = v.InferOutput<typeof manualOcrResponseSchema>;

const QUEUED_OCR_TOAST_KEYS = {
  live: "workspaces.files.ocrQueued",
  batched: "workspaces.files.ocrQueuedForBatch",
} as const satisfies Record<
  AcceptingDocumentOcrAvailability["type"],
  TranslationKey
>;

/** The success toast for a manual OCR request: done, queued, or batched. */
export const manualOcrSuccessKey = (
  response: ManualOcrResponse,
): TranslationKey => {
  switch (response.outcome) {
    case "already_processed":
      return "workspaces.files.ocrAlreadyProcessed";
    case "queued":
      return QUEUED_OCR_TOAST_KEYS[response.availability.type];
    default:
      response satisfies never;
      return panic("Unhandled manual OCR outcome");
  }
};
