import * as v from "valibot";

import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";

const REQUEST_TIMEOUT_MS = 15_000;

const manualOcrResponseSchema = v.object({
  outcome: v.picklist(["already_processed", "queued"]),
  runId: v.string(),
});

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
