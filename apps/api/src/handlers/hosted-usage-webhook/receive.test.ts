import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  HOSTED_USAGE_WEBHOOK_HEADERS,
  receiveHostedUsageWebhook,
} from "@/api/handlers/hosted-usage-webhook/receive";

const TEST_SECRET = "test-webhook-secret-deadbeefcafe";

type SignedRequestOptions = {
  body: string;
  eventId: string;
};

const withWebhookConfig = async (fn: () => Promise<void>): Promise<void> => {
  const previousFeatureUsage = env.FEATURE_USAGE;
  const previousSecret = env.HOSTED_USAGE_WEBHOOK_SECRET;
  const previousSecretPrevious = env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS;
  env.FEATURE_USAGE = true;
  env.HOSTED_USAGE_WEBHOOK_SECRET = TEST_SECRET;
  env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = undefined;
  try {
    await fn();
  } finally {
    env.FEATURE_USAGE = previousFeatureUsage;
    env.HOSTED_USAGE_WEBHOOK_SECRET = previousSecret;
    env.HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS = previousSecretPrevious;
  }
};

const buildSignedRequest = ({
  body,
  eventId,
}: SignedRequestOptions): Request => {
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const hasher = new Bun.CryptoHasher("sha256", TEST_SECRET);
  hasher.update(`${eventId}.${timestamp}.${body}`);
  const signature = hasher.digest("base64");
  return new Request("http://api.test/usage/hosted/webhook", {
    method: "POST",
    headers: {
      [HOSTED_USAGE_WEBHOOK_HEADERS.id]: eventId,
      [HOSTED_USAGE_WEBHOOK_HEADERS.timestamp]: timestamp,
      [HOSTED_USAGE_WEBHOOK_HEADERS.signature]: `v1,${signature}`,
    },
  });
};

describe("receiveHostedUsageWebhook", () => {
  test("rejects malformed payloads for handled event types", async () => {
    await withWebhookConfig(async () => {
      const body = JSON.stringify({
        type: "entitlement.created",
        data: { id: "provider_ent_missing_required_fields" },
      });
      const response = await receiveHostedUsageWebhook({
        request: buildSignedRequest({
          body,
          eventId: "evt_malformed_handled",
        }),
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "Malformed payload for handled event type",
      });
    });
  });
});
