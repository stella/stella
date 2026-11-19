import { env } from "@/api/env";
import type { ElevenLabsEnvironment } from "@/api/lib/chat/provider-data-policy";

export type ElevenLabsDeployment = {
  apiKey: string;
  environment: ElevenLabsEnvironment;
  /** The account has ElevenLabs zero retention, so every request asks for
   *  it. Without it ElevenLabs keeps the audio and transcript. */
  zeroRetention: boolean;
};

/** The deployment's ElevenLabs key and its environment; `null` offers no
 *  direct ElevenLabs model. */
export const readElevenLabsDeployment = (): ElevenLabsDeployment | null => {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  return apiKey === undefined || apiKey === ""
    ? null
    : {
        apiKey,
        environment: env.ELEVENLABS_ENVIRONMENT,
        zeroRetention: env.ELEVENLABS_ZERO_RETENTION === "1",
      };
};

/** Whether this deployment's ElevenLabs requests leave a transcript there
 *  that has to be deleted. */
export const elevenLabsKeepsTranscripts = (
  deployment: ElevenLabsDeployment | null,
): deployment is ElevenLabsDeployment =>
  deployment !== null && !deployment.zeroRetention;
