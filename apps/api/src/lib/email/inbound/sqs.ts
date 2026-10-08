import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Result, TaggedError, panic } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type { receiveAndDeleteSesInboundMail } from "@/api/lib/email/inbound/ses";
import { errorTag } from "@/api/lib/errors/error-tag";
import type { logger as appLogger } from "@/api/lib/observability/logger";

// SQS caps a message body at 256 KiB. A longer body did not come from the
// configured queue and is not worth parsing.
export const MAX_QUEUE_MESSAGE_CHARS = 262_144;
const MAX_MESSAGES_PER_BATCH = 10;
const MAX_BATCHES_PER_RUN = 10;
const RUN_BUDGET_MS = 30_000;
const RECEIVE_WAIT_SECONDS = 1;
// Messages in one batch are filed sequentially; each may spend the provider
// read, authentication and persistence budgets. The lease must outlast the
// batch so a later run cannot take a message that is still being filed.
const VISIBILITY_TIMEOUT_SECONDS = 600;
const DELETE_TIMEOUT_MS = 5000;

// SES publishes this once when a receipt rule's topic is configured.
const SES_SETUP_NOTIFICATION = "AMAZON_SES_SETUP_NOTIFICATION";
const SES_RECEIVED_NOTIFICATION = "Received";

// SNS adds signing and routing fields this receiver does not use; strip them.
const snsNotificationSchema = v.object({
  Type: v.literal("Notification"),
  TopicArn: v.string(),
  Message: v.string(),
});
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
}> {}

type InboundQueueNotification =
  | { type: "received"; event: unknown }
  | { type: "setup" };

const parseJson = (text: string) =>
  Result.try({
    try: (): unknown => JSON.parse(text),
    catch: () =>
      new InboundQueueMessageError({
        message: "Inbound queue message is not JSON",
        reason: "malformed-json",
      }),
  });

type ParseInboundQueueMessageOptions = {
  body: string | undefined;
  topicArn: string;
};

// The queue policy admits only the configured topic; the topic check here
// keeps a misrouted subscription from reaching the filer. SNS signatures are
// not fetched: IAM on the queue is the trust boundary.
export const parseInboundQueueMessage = ({
  body,
  topicArn,
}: ParseInboundQueueMessageOptions): Result<
  InboundQueueNotification,
  InboundQueueMessageError
> => {
  if (body === undefined || body.length > MAX_QUEUE_MESSAGE_CHARS) {
    return Result.err(
      new InboundQueueMessageError({
        message: "Inbound queue message has no bounded body",
        reason: "oversized",
      }),
    );
  }
  const outer = parseJson(body);
  if (outer.isErr()) {
    return outer;
  }
  const envelope = v.safeParse(snsNotificationSchema, outer.value);
  if (!envelope.success) {
    return Result.err(
      new InboundQueueMessageError({
        message: "Inbound queue message is not an SNS notification",
        reason: "invalid-envelope",
      }),
    );
  }
  if (envelope.output.TopicArn !== topicArn) {
    return Result.err(
      new InboundQueueMessageError({
        message: "Inbound queue message came from another topic",
        reason: "untrusted-topic",
      }),
    );
  }
  const inner = parseJson(envelope.output.Message);
  if (inner.isErr()) {
    return inner;
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
  deleteFailed: number;
};

type InboundQueueDrainSummary = InboundQueueDrainCounts & {
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
 * Anything else stays
 * on the queue; its visibility timeout re-offers it and the queue's redrive
 * policy moves it to the dead-letter queue after the receive limit.
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
    deleteFailed: 0,
  };
  const deadline = Temporal.Now.instant().epochMilliseconds + RUN_BUDGET_MS;

  // Leases one batch. Batches are sequential: a lease taken before the
  // previous batch finished would spend its visibility timeout waiting.
  const receiveBatch = async () =>
    await Result.tryPromise({
      try: async () =>
        await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: MAX_MESSAGES_PER_BATCH,
            WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: signal },
        ),
      catch: (cause) =>
        new InboundQueueReceiveError({
          message: "Inbound mail queue could not be read",
          cause,
        }),
    });

  const remove = async (message: Message, messageId: string) => {
    const deleted = await Result.tryPromise({
      try: async () =>
        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
          // Not the run signal: once a delivery is terminal, an abort must
          // not turn its acknowledgement into a redelivery.
          { abortSignal: AbortSignal.timeout(DELETE_TIMEOUT_MS) },
        ),
      catch: (cause) => cause,
    });
    if (deleted.isErr()) {
      // The record is durable; redelivery converges as a duplicate.
      counts.deleteFailed += 1;
      logger.warn("inbound_mail.queue.delete_failed", {
        "queue.delivery_id": messageId,
        "error.type": errorTag(deleted.error),
      });
    }
  };

  const handle = async (message: Message) => {
    const messageId = message.MessageId ?? "unknown";
    const receiveCount =
      message.Attributes?.ApproximateReceiveCount ?? "unknown";
    const parsed = parseInboundQueueMessage({ body: message.Body, topicArn });
    if (parsed.isErr()) {
      counts.poison += 1;
      logger.error("inbound_mail.queue.poison", {
        "queue.delivery_id": messageId,
        "queue.receive_count": receiveCount,
        "error.reason": parsed.error.reason,
      });
      return;
    }
    const notification = parsed.value;
    switch (notification.type) {
      case "setup":
        counts.setup += 1;
        logger.info("inbound_mail.queue.setup_notification", {
          "queue.delivery_id": messageId,
        });
        await remove(message, messageId);
        return;
      case "received":
        break;
      default:
        notification satisfies never;
        panic("Unhandled inbound queue notification");
    }
    const outcome = await receive(notification.event);
    if (outcome.isErr()) {
      counts.retry += 1;
      logger.warn("inbound_mail.queue.retry", {
        "queue.delivery_id": messageId,
        "queue.receive_count": receiveCount,
        "error.type": outcome.error._tag,
        "error.reason": outcome.error.reason,
      });
      return;
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
        "queue.delivery_id": messageId,
        "inbound_mail.outcome": delivery.status,
        ...(delivery.status === "dropped" && {
          "inbound_mail.drop_reason": delivery.reason,
        }),
      });
    }
    await remove(message, messageId);
  };

  const summary = (
    batches: number,
    stoppedBecause: InboundQueueDrainSummary["stoppedBecause"],
  ) => {
    const result = { ...counts, batches, stoppedBecause };
    logger.info("inbound_mail.queue.drained", result);
    return Result.ok(result);
  };

  // Read through a call: the signal can abort during any await, so a
  // narrowed `signal.aborted` would be stale.
  const aborted = () => signal.aborted;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    if (aborted()) {
      return summary(batch, "aborted");
    }
    if (Temporal.Now.instant().epochMilliseconds >= deadline) {
      return summary(batch, "limitReached");
    }
    const received = await receiveBatch();
    if (received.isErr()) {
      if (aborted()) {
        return summary(batch, "aborted");
      }
      return received;
    }
    // SQS omits Messages when a receive finds the queue empty.
    const messages = received.value.Messages;
    if (messages === undefined || messages.length === 0) {
      return summary(batch, "drained");
    }
    for (const message of messages) {
      // On abort the unhandled rest stay leased until their visibility
      // timeout ends; they are redelivered, never deleted.
      if (aborted()) {
        return summary(batch + 1, "aborted");
      }
      // Messages are filed one at a time so an abort leaves no delivery
      // half-acknowledged.
      await handle(message);
    }
  }
  return summary(MAX_BATCHES_PER_RUN, "limitReached");
};
