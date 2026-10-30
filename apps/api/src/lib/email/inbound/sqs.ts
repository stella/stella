import type { SQSClient } from "@aws-sdk/client-sqs";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  declareFingerprintFields,
  sanitizeErrorAttributesForOutput,
} from "@stll/errors";

import { INBOUND_MAIL_LIMITS } from "@/api/lib/email/inbound/limits";
import type { receiveAndDeleteSesInboundMail } from "@/api/lib/email/inbound/ses";
import {
  drainSnsQueue,
  parseSnsQueueBody,
  type SnsQueueDelivery,
  type SnsQueueHandled,
} from "@/api/lib/email/sns-queue-drain";
import type { logger as appLogger } from "@/api/lib/observability/logger";

// Messages in one batch are filed sequentially; each may spend the provider
// read, authentication and persistence budgets. The lease must outlast the
// batch so a later run cannot take a message that is still being filed.
const VISIBILITY_TIMEOUT_SECONDS = 600;

/**
 * Recipient filings one run may spend; the continuation drains the rest. A
 * message names at most INBOUND_MAIL_LIMITS.recipients recipients.
 */
export const RECIPIENT_FILINGS_PER_RUN = 500;

// SES publishes this once when a receipt rule's topic is configured.
const SES_SETUP_NOTIFICATION = "AMAZON_SES_SETUP_NOTIFICATION";
const SES_RECEIVED_NOTIFICATION = "Received";

const sesNotificationKindSchema = v.object({
  notificationType: v.string(),
});

class InboundQueueMessageError extends TaggedError("InboundQueueMessageError")<{
  message: string;
  reason:
    | "oversized"
    | "malformed-json"
    | "invalid-envelope"
    | "untrusted-topic"
    | "unsupported-notification";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type InboundQueueNotification =
  { type: "received"; event: unknown } | { type: "setup" };

const ENVELOPE_REJECTION_MESSAGE = {
  oversized: "Inbound queue message has no bounded body",
  "malformed-json": "Inbound queue message is not JSON",
  "invalid-envelope": "Inbound queue message is not an SNS notification",
  "untrusted-topic": "Inbound queue message came from another topic",
} as const;

type ParseInboundQueueMessageOptions = {
  body: string | undefined;
  topicArn: string;
};

export const parseInboundQueueMessage = ({
  body,
  topicArn,
}: ParseInboundQueueMessageOptions): Result<
  InboundQueueNotification,
  InboundQueueMessageError
> => {
  const inner = parseSnsQueueBody({ body, topicArn });
  if (inner.isErr()) {
    return Result.err(
      new InboundQueueMessageError({
        message: ENVELOPE_REJECTION_MESSAGE[inner.error],
        reason: inner.error,
      }),
    );
  }
  const kind = v.safeParse(sesNotificationKindSchema, inner.value);
  if (!kind.success) {
    return Result.err(
      new InboundQueueMessageError({
        message: "Inbound queue message is not a provider notification",
        reason: "invalid-envelope",
      }),
    );
  }
  switch (kind.output.notificationType) {
    case SES_RECEIVED_NOTIFICATION:
      return Result.ok({ type: "received", event: inner.value });
    case SES_SETUP_NOTIFICATION:
      return Result.ok({ type: "setup" });
    default:
      return Result.err(
        new InboundQueueMessageError({
          message: "Inbound queue notification type is not supported",
          reason: "unsupported-notification",
        }),
      );
  }
};

type ReceiveResult = Awaited<ReturnType<typeof receiveAndDeleteSesInboundMail>>;

class InboundQueueReceiveError extends TaggedError("InboundQueueReceiveError")<{
  message: string;
  cause: unknown;
}> {}

type InboundQueueDrainCounts = {
  filed: number;
  duplicate: number;
  alreadyCompleted: number;
  dropped: number;
  setup: number;
  retry: number;
  poison: number;
};

type InboundQueueDrainSummary = InboundQueueDrainCounts & {
  deleteFailed: number;
  releaseFailed: number;
  batches: number;
  stoppedBecause: "drained" | "aborted" | "limitReached";
};

type DrainInboundMailQueueOptions = {
  client: Pick<SQSClient, "send">;
  queueUrl: string;
  topicArn: string;
  receive: (event: unknown) => Promise<ReceiveResult>;
  signal: AbortSignal;
  logger: typeof appLogger;
};

/**
 * A message is deleted only after a terminal outcome: filed, duplicate,
 * dropped (its drop log committed), a prior raw deletion, or a setup notice.
 * Anything else stays on the queue; abort releases unprocessed deliveries,
 * while other retries wait for their visibility timeout and redrive policy.
 */
export const drainInboundMailQueue = async ({
  client,
  queueUrl,
  topicArn,
  receive,
  signal,
  logger,
}: DrainInboundMailQueueOptions): Promise<
  Result<InboundQueueDrainSummary, InboundQueueReceiveError>
> => {
  const counts: InboundQueueDrainCounts = {
    filed: 0,
    duplicate: 0,
    alreadyCompleted: 0,
    dropped: 0,
    setup: 0,
    retry: 0,
    poison: 0,
  };

  const handle = async ({
    body,
    deliveryId,
    receiveCount,
  }: SnsQueueDelivery): Promise<SnsQueueHandled> => {
    const parsed = parseInboundQueueMessage({ body, topicArn });
    if (parsed.isErr()) {
      counts.poison += 1;
      const fields = sanitizeErrorAttributesForOutput({
        "queue.delivery_id": deliveryId,
        "queue.receive_count": receiveCount,
        "error.reason": parsed.error.reason,
      });
      logger.error("inbound_mail.queue.poison", fields);
      return { disposition: "keep", work: 0 };
    }
    const notification = parsed.value;
    switch (notification.type) {
      case "setup":
        counts.setup += 1;
        logger.info("inbound_mail.queue.setup_notification", {
          "queue.delivery_id": deliveryId,
        });
        return { disposition: "acknowledge", work: 0 };
      case "received":
        break;
      default:
        notification satisfies never;
        panic("Unhandled inbound queue notification");
    }
    const outcome = await receive(notification.event);
    if (outcome.isErr()) {
      counts.retry += 1;
      const fields = sanitizeErrorAttributesForOutput({
        "queue.delivery_id": deliveryId,
        "queue.receive_count": receiveCount,
        "error.type": outcome.error._tag,
        "error.reason": outcome.error.reason,
      });
      logger.warn("inbound_mail.queue.retry", fields);
      // A failed receive may have filed some recipients before it stopped.
      return { disposition: "keep", work: INBOUND_MAIL_LIMITS.recipients };
    }
    // Outcomes are terminal: recipient filing/drop, or a prior raw deletion.
    for (const delivery of outcome.value) {
      switch (delivery.status) {
        case "filed":
          counts.filed += 1;
          break;
        case "duplicate":
          counts.duplicate += 1;
          break;
        case "already_completed":
          counts.alreadyCompleted += 1;
          break;
        case "dropped":
          counts.dropped += 1;
          break;
        default:
          delivery satisfies never;
          panic("Unhandled inbound delivery outcome");
      }
      logger.info("inbound_mail.queue.received", {
        "queue.delivery_id": deliveryId,
        "inbound_mail.outcome": delivery.status,
        ...(delivery.status === "dropped" && {
          "inbound_mail.drop_reason": delivery.reason,
        }),
      });
    }
    return { disposition: "acknowledge", work: outcome.value.length };
  };

  const drained = await drainSnsQueue({
    client,
    queueUrl,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    handle,
    workBudget: RECIPIENT_FILINGS_PER_RUN,
    signal,
    logger,
    logPrefix: "inbound_mail.queue",
  });
  if (drained.isErr()) {
    return Result.err(
      new InboundQueueReceiveError({
        message: "Inbound mail queue could not be read",
        cause: drained.error.cause,
      }),
    );
  }
  const result = { ...counts, ...drained.value };
  logger.info("inbound_mail.queue.drained", result);
  return Result.ok(result);
};
