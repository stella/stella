import { Result } from "better-result";

import {
  deleteElevenLabsTranscript,
  elevenLabsTranscriptUrl,
} from "@/api/lib/chat/provider-data-policy";
import type { ElevenLabsEnvironment } from "@/api/lib/chat/provider-data-policy";
import type { ElevenLabsDeployment } from "@/api/lib/dictation/elevenlabs-deployment";

const KEPT_TRANSCRIPT_DELETE_TIMEOUT_MS = 60_000;

export type KeptTranscriptDeleteOutcome =
  { type: "deleted" } | { type: "failed"; code: string };

type DeleteKeptTranscriptAtOptions = {
  deployment: ElevenLabsDeployment;
  environment: ElevenLabsEnvironment;
  transcriptionId: string;
  fetch?: typeof deleteElevenLabsTranscript | undefined;
};

/**
 * Deletes one transcript ElevenLabs kept. A transcript already gone counts
 * as deleted. Anything else is a failure with a short code (`http_503`,
 * `request_failed`), never the provider's body.
 */
export const deleteKeptTranscriptAt = async ({
  deployment,
  environment,
  transcriptionId,
  fetch: fetchProvider = deleteElevenLabsTranscript,
}: DeleteKeptTranscriptAtOptions): Promise<KeptTranscriptDeleteOutcome> => {
  // A key works only in its own environment, so a transcript kept in
  // another one needs that environment's key back.
  if (environment !== deployment.environment) {
    return { type: "failed", code: "environment_changed" };
  }
  const url = elevenLabsTranscriptUrl(environment, transcriptionId);
  if (url === null) {
    return { type: "failed", code: "unexpected_id" };
  }
  const answered = await Result.tryPromise(async () => {
    const response = await fetchProvider(url, {
      method: "DELETE",
      headers: { "xi-api-key": deployment.apiKey },
      redirect: "error",
      timeout: { type: "headers", ms: KEPT_TRANSCRIPT_DELETE_TIMEOUT_MS },
    });
    await response.body?.cancel();
    return response.status;
  });
  if (answered.isErr()) {
    return { type: "failed", code: "request_failed" };
  }
  const status = answered.value;
  return (status >= 200 && status < 300) || status === 404
    ? { type: "deleted" }
    : { type: "failed", code: `http_${status}` };
};
