import * as v from "valibot";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { hostedUsageWebhookEventSchema } from "@/api/lib/hosted-usage-provider/event-schemas";
import type { HostedUsageWebhookEvent } from "@/api/lib/hosted-usage-provider/event-schemas";

// Unhandled events retain identifiers for review, never arbitrary provider data.
const identifier = v.fallback(v.optional(v.string()), undefined);
const unknownEventRecordSchema = v.object({
  timestamp: identifier,
  data: v.fallback(
    v.optional(
      v.object({
        id: identifier,
        customer_id: identifier,
        subscription_id: identifier,
        product_id: identifier,
        account_ref: identifier,
        policy_ref: identifier,
        status: identifier,
        created_at: identifier,
        modified_at: identifier,
      }),
    ),
    undefined,
  ),
});

type WebhookRecordOptions = {
  rawBody: string;
  payload: Record<string, unknown>;
  event: HostedUsageWebhookEvent | null;
};

export const minimalWebhookRecord = ({
  rawBody,
  payload,
  event,
}: WebhookRecordOptions): Record<string, unknown> => {
  const digest = hashSha256Hex(rawBody);
  // Parse again at the persistence boundary: callers cannot bypass stripping by
  // supplying an object whose inferred type permits additional runtime fields.
  const known =
    event === null ? null : v.parse(hostedUsageWebhookEventSchema, event);
  const details =
    known === null
      ? v.parse(unknownEventRecordSchema, payload)
      : { type: known.type, data: known.data };
  return {
    signatureVerified: true,
    payloadDigest: digest,
    ...(typeof payload["api_version"] === "string"
      ? { api_version: payload["api_version"] }
      : {}),
    ...(typeof payload["delivery_api_version"] === "string" ||
    payload["delivery_api_version"] === null
      ? { delivery_api_version: payload["delivery_api_version"] }
      : {}),
    ...details,
  };
};
