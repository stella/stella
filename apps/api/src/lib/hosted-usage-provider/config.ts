/** Hosted usage configuration. */

import { env } from "@/api/env";

export type HostedUsageWebhookConfig = {
  /**
   * Active secrets accepted for HMAC verification, current first.
   * During a rotation window the previous secret is included so
   * in-flight webhook deliveries keep working while the update
   * propagates.
   */
  secrets: readonly string[];
};

export const getWebhookSecret = (): HostedUsageWebhookConfig | null => {
  if (!env.FEATURE_USAGE || !env.HOSTED_USAGE_WEBHOOK_SECRET) {
    return null;
  }
  const secrets: string[] = [env.HOSTED_USAGE_WEBHOOK_SECRET];
  if (env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS) {
    secrets.push(env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS);
  }
  return { secrets };
};

export type HostedUsageProviderApiCredentials = {
  apiKey: string;
  baseUrl: string;
};

export const getApiCredentials =
  (): HostedUsageProviderApiCredentials | null => {
    if (
      !env.FEATURE_USAGE ||
      !env.HOSTED_USAGE_PROVIDER_API_KEY ||
      !env.HOSTED_USAGE_PROVIDER_BASE_URL
    ) {
      return null;
    }
    return {
      apiKey: env.HOSTED_USAGE_PROVIDER_API_KEY,
      baseUrl: env.HOSTED_USAGE_PROVIDER_BASE_URL,
    };
  };
