import { TRANSCRIPTION_MODELS } from "@stll/ai-catalog/transcription";
import type { TranscriptionServed } from "@stll/ai-catalog/transcription";

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

/**
 * Which models an organization may use, and at which endpoints. OpenRouter
 * models need the deployment's OpenRouter credential, or the organization's
 * own OpenRouter key when it brings its own AI provider. A direct model runs
 * on the deployment's key, so an organization on its own AI provider, which
 * pays its provider itself, does not get it.
 */
export const transcriptionServed =
  (
    deployment: TranscriptionDeployment,
    orgAIConfig: OrgSettingsForAuth["orgAIConfig"],
  ): TranscriptionServed =>
  (modelId, endpoint) => {
    const model = TRANSCRIPTION_MODELS[modelId];
    if (model.route === "openrouter") {
      return orgAIConfig === null
        ? deployment.openRouter
        : orgAIConfig.providers.some(
            ({ provider }) => provider === "openrouter",
          );
    }
    return (
      orgAIConfig === null && elevenLabsServes(deployment.elevenLabs, endpoint)
    );
  };
