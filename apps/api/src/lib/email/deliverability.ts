import type { SQSClient } from "@aws-sdk/client-sqs";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  declareFingerprintFields,
  sanitizeErrorAttributesForOutput,
} from "@stll/errors";

import type { AccountEmailUndeliverableReason } from "@/api/lib/email/deliverability-contract";
import {
  emailAddressSchema,
  type NormalizedEmail,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";
import {
  drainSnsQueue,
  parseSnsQueueBody,
  type SnsQueueDelivery,
  type SnsQueueDisposition,
} from "@/api/lib/email/sns-queue-drain";
import type { logger as appLogger } from "@/api/lib/observability/logger";

// Each delivery is one small database write; a batch finishes in seconds.
const VISIBILITY_TIMEOUT_SECONDS = 60;

// The provider's configuration-set events, as its SNS destination publishes
// them. Only the fields that decide a transition are read; nothing else from
// the event, and no message content, is kept anywhere.
const recipientsSchema = v.array(v.object({ emailAddress: v.string() }));
const providerEventSchema = v.variant("eventType", [
  v.object({
    eventType: v.literal("Bounce"),
    bounce: v.object({
      bounceType: v.string(),
      bounceSubType: v.string(),
      bouncedRecipients: recipientsSchema,
      timestamp: v.string(),
    }),
  }),
  v.object({
    eventType: v.literal("Complaint"),
    complaint: v.object({
      complainedRecipients: recipientsSchema,
      complaintSubType: v.optional(v.nullable(v.string())),
      timestamp: v.string(),
    }),
  }),
]);

// The provider's own suppression list refused the send without trying.
const SUPPRESSION_SUBTYPES: ReadonlySet<string> = new Set([
  "Suppressed",
  "OnAccountSuppressionList",
]);

export type DeliverabilityTransition =
  | {
      type: "undeliverable";
      reason: AccountEmailUndeliverableReason;
      recipients: NormalizedEmail[];
      at: Date;
    }
  | { type: "unchanged"; cause: "transient-bounce" };

class DeliverabilityEventError extends TaggedError("DeliverabilityEventError")<{
  message: string;
  reason: "envelope" | "unsupported-event" | "invalid-time";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const toRecipients = (
  recipients: v.InferOutput<typeof recipientsSchema>,
): NormalizedEmail[] =>
  recipients.flatMap(({ emailAddress }) => {
    const parsed = v.safeParse(emailAddressSchema, emailAddress);
    return parsed.success ? [normalizeEmail(parsed.output)] : [];
  });

const parseEventTime = (
  timestamp: string,
): Result<Date, DeliverabilityEventError> => {
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime())
    ? Result.err(
        new DeliverabilityEventError({
          message: "Provider event has no valid time",
          reason: "invalid-time",
        }),
      )
    : Result.ok(at);
};

/**
 * What a provider event means for the addresses it names: a permanent bounce,
 * a complaint or a suppression-list refusal makes them undeliverable; a
 * transient bounce changes nothing.
 */
export const readDeliverabilityTransition = (
  event: unknown,
): Result<DeliverabilityTransition, DeliverabilityEventError> => {
  const parsed = v.safeParse(providerEventSchema, event);
  if (!parsed.success) {
    return Result.err(
      new DeliverabilityEventError({
        message: "Provider event is not a bounce or complaint",
        reason: "unsupported-event",
      }),
    );
  }
  const providerEvent = parsed.output;
  switch (providerEvent.eventType) {
    case "Bounce": {
      const { bounce } = providerEvent;
      if (bounce.bounceType !== "Permanent") {
        return Result.ok({ type: "unchanged", cause: "transient-bounce" });
      }
      return parseEventTime(bounce.timestamp).map((at) => ({
        type: "undeliverable" as const,
        reason: SUPPRESSION_SUBTYPES.has(bounce.bounceSubType)
          ? ("suppressed" as const)
          : ("hard_bounce" as const),
        recipients: toRecipients(bounce.bouncedRecipients),
        at,
      }));
    }
    case "Complaint": {
      const { complaint } = providerEvent;
      return parseEventTime(complaint.timestamp).map((at) => ({
        type: "undeliverable" as const,
        reason: SUPPRESSION_SUBTYPES.has(complaint.complaintSubType ?? "")
          ? ("suppressed" as const)
          : ("complaint" as const),
        recipients: toRecipients(complaint.complainedRecipients),
        at,
      }));
    }
    default:
      providerEvent satisfies never;
      return panic("Unhandled provider event type");
  }
};

type DeliverabilityDrainCounts = {
  marked: number;
  unknownAddress: number;
  unchanged: number;
  retry: number;
  poison: number;
};

type DrainDeliverabilityEventsOptions = {
  client: Pick<SQSClient, "send">;
  queueUrl: string;
  topicArn: string;
  /** Marks the account at this address; resolves whether one was marked. */
  markUndeliverable: (
    email: NormalizedEmail,
    reason: AccountEmailUndeliverableReason,
    at: Date,
  ) => Promise<boolean>;
  signal: AbortSignal;
  logger: typeof appLogger;
};

/**
 * Applies the provider's bounce and complaint events to the accounts they
 * name. A delivery is deleted once its transition is stored or it changes
 * nothing, so the queue keeps no event longer than it takes to apply it.
 */
export const drainDeliverabilityEvents = async ({
  client,
  queueUrl,
  topicArn,
  markUndeliverable,
  signal,
  logger,
}: DrainDeliverabilityEventsOptions) => {
  const counts: DeliverabilityDrainCounts = {
    marked: 0,
    unknownAddress: 0,
    unchanged: 0,
    retry: 0,
    poison: 0,
  };

  const handle = async ({
    body,
    deliveryId,
    receiveCount,
  }: SnsQueueDelivery): Promise<SnsQueueDisposition> => {
    const transition = parseSnsQueueBody({ body, topicArn })
      .mapError(
        () =>
          new DeliverabilityEventError({
            message: "Provider event envelope is not trusted",
            reason: "envelope",
          }),
      )
      .andThen(readDeliverabilityTransition);
    if (transition.isErr()) {
      counts.poison += 1;
      logger.error(
        "email_deliverability.queue.poison",
        sanitizeErrorAttributesForOutput({
          "queue.delivery_id": deliveryId,
          "queue.receive_count": receiveCount,
          "error.reason": transition.error.reason,
        }),
      );
      return "keep";
    }
    const { value } = transition;
    if (value.type === "unchanged") {
      counts.unchanged += 1;
      return "acknowledge";
    }
    const applied = await Result.tryPromise(
      async () =>
        await Promise.all(
          value.recipients.map(
            async (email) =>
              await markUndeliverable(email, value.reason, value.at),
          ),
        ),
    );
    if (applied.isErr()) {
      counts.retry += 1;
      logger.warn(
        "email_deliverability.queue.retry",
        sanitizeErrorAttributesForOutput({
          "queue.delivery_id": deliveryId,
          "queue.receive_count": receiveCount,
          "error.type": applied.error._tag,
        }),
      );
      return "keep";
    }
    for (const marked of applied.value) {
      if (marked) {
        counts.marked += 1;
        logger.info("email_deliverability.marked", {
          "queue.delivery_id": deliveryId,
          "delivery.refusal_reason": value.reason,
        });
      } else {
        counts.unknownAddress += 1;
      }
    }
    return "acknowledge";
  };

  const drained = await drainSnsQueue({
    client,
    queueUrl,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    handle,
    signal,
    logger,
    logPrefix: "email_deliverability.queue",
  });
  if (drained.isErr()) {
    return drained;
  }
  const result = { ...counts, ...drained.value };
  logger.info("email_deliverability.queue.drained", result);
  return Result.ok(result);
};
