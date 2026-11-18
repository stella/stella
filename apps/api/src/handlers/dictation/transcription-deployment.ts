import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type {
  TranscriptionModelId,
  TranscriptionServed,
} from "@stll/ai-catalog/transcription";

import {
  elevenLabsServes,
  readElevenLabsDeployment,
} from "@/api/handlers/dictation/elevenlabs-provider";
import type { ElevenLabsDeployment } from "@/api/handlers/dictation/elevenlabs-provider";
import type { OrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { getManagedOpenRouterConfiguration } from "@/api/lib/chat/openrouter-credential";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";

/** The transcription providers this deployment has credentials for. */
export type TranscriptionDeployment = {
  /** stella AI may transcribe through OpenRouter. */
  openRouter: boolean;
  elevenLabs: ElevenLabsDeployment | null;
};

export const readTranscriptionDeployment = (): TranscriptionDeployment => ({
  openRouter:
    getManagedOpenRouterConfiguration(MANAGED_MODEL_TIER.standard).type !==
    "unavailable",
  elevenLabs: readElevenLabsDeployment(),
});

/** The provider keeps the audio and transcript: a direct model on a key
 *  without zero retention. OpenRouter requests always require it. */
export const transcriptionRetainsData = (
  deployment: TranscriptionDeployment,
  modelId: TranscriptionModelId,
): boolean =>
  TRANSCRIPTION_MODELS[modelId].route === "elevenlabs" &&
  deployment.elevenLabs?.zeroRetention === false;

/**
 * Which models an organization may use, and at which endpoints. OpenRouter
 * models run on the organization's own OpenRouter key when it brings one,
 * and otherwise on the deployment's OpenRouter credential, as stella usage:
 * an organization on another AI provider of its own still transcribes with
 * stella. A direct model always runs on the deployment's key, as stella
 * usage. A model whose provider keeps the data is served only where the
 * caller warns about it, and never as a default (`asDefault`).
 */
export const transcriptionServed =
  (
    deployment: TranscriptionDeployment,
    orgAIConfig: OrgSettingsForAuth["orgAIConfig"],
    {
      retainingData = false,
      asDefault = false,
    }: { retainingData?: boolean; asDefault?: boolean } = {},
  ): TranscriptionServed =>
  (modelId, endpoint) => {
    if (
      transcriptionRetainsData(deployment, modelId) &&
      (asDefault || !retainingData)
    ) {
      return false;
    }
    const model = TRANSCRIPTION_MODELS[modelId];
    if (model.route === "openrouter") {
      return (
        deployment.openRouter ||
        orgAIConfig?.providers.some(
          ({ provider }) => provider === "openrouter",
        ) === true
      );
    }
    return elevenLabsServes(deployment.elevenLabs, endpoint);
  };

/** Whether any model is served at any endpoint: false when the caller has
 *  no transcription provider at all, not merely none in its region. */
export const transcriptionServedAnywhere = (
  served: TranscriptionServed,
): boolean =>
  Object.keys(TRANSCRIPTION_MODELS)
    .filter(isTranscriptionModelId)
    .some((modelId) =>
      (["eu", "us", "global"] as const).some((endpoint) =>
        served(modelId, endpoint),
      ),
    );
