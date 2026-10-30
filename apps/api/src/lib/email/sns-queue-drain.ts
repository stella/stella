import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { Temporal } from "@stll/time";

import type { SqsQueue } from "@/api/lib/email/sqs-queue-url";
import { errorTag } from "@/api/lib/errors/error-tag";
import type { logger as appLogger } from "@/api/lib/observability/logger";

// SQS caps a message body at 256 KiB. A longer body did not come from the
// configured queue and is not worth parsing.
export const MAX_QUEUE_MESSAGE_CHARS = 262_144;
export const MAX_MESSAGES_PER_BATCH = 10;
const MAX_BATCHES_PER_RUN = 10;
const RUN_BUDGET_MS = 30_000;
const RECEIVE_WAIT_SECONDS = 1;
const DELETE_TIMEOUT_MS = 5000;
const RELEASE_TIMEOUT_MS = 5000;
const DEPTH_TIMEOUT_MS = 5000;

// One client per region; credentials come from the SDK's default chain (the
// task role in a deployment).
const sqsClients = new Map<string, SQSClient>();
export const sqsClientFor = ({ region }: SqsQueue): SQSClient => {
  const existing = sqsClients.get(region);
  if (existing) {
    return existing;
  }
  const client = new SQSClient({ region });
  sqsClients.set(region, client);
  return client;
};

// SNS adds signing and routing fields the consumers do not use; strip them.
const snsNotificationSchema = v.object({
  Type: v.literal("Notification"),
  TopicArn: v.string(),
  Message: v.string(),
});

export type SnsEnvelopeRejection =
  "oversized" | "malformed-json" | "invalid-envelope" | "untrusted-topic";

const parseJson = (text: string): Result<unknown, "malformed-json"> =>
  Result.try({
    try: (): unknown => JSON.parse(text),
    catch: () => "malformed-json" as const,
  });

/**
 * The provider notification an SNS-to-SQS delivery carries, from the
 * configured topic only. The queue policy admits only that topic; the check
 * keeps a misrouted subscription out. SNS signatures are not fetched: IAM on
 * the queue is the trust boundary.
 */
export const parseSnsQueueBody = ({
  body,
  topicArn,
}: {
  body: string | undefined;
  topicArn: string;
}): Result<unknown, SnsEnvelopeRejection> => {
  if (body === undefined || body.length > MAX_QUEUE_MESSAGE_CHARS) {
    return Result.err("oversized");
  }
  const outer = parseJson(body);
  if (outer.isErr()) {
    return outer;
  }
  const envelope = v.safeParse(snsNotificationSchema, outer.value);
  if (!envelope.success) {
    return Result.err("invalid-envelope");
  }
  if (envelope.output.TopicArn !== topicArn) {
    return Result.err("untrusted-topic");
  }
  return parseJson(envelope.output.Message);
};

export class SnsQueueReceiveError extends TaggedError("SnsQueueReceiveError")<{
  message: string;
  cause: unknown;
}> {}

export type SnsQueueDelivery = {
  body: string | undefined;
  deliveryId: string;
  receiveCount: string;
};

/** `acknowledge` deletes the delivery; `keep` leaves it for redelivery. */
type SnsQueueDisposition = "acknowledge" | "keep";

/**
 * What handling one delivery did. `work` counts the units of the run's work
 * budget it spent (for example, one per recipient row written or attempted);
 * a delivery that touched no rows spends zero.
 */
export type SnsQueueHandled = {
  disposition: SnsQueueDisposition;
  work: number;
};

export type SnsQueueDrainSummary = {
  batches: number;
  stoppedBecause: "drained" | "aborted" | "limitReached";
  deleteFailed: number;
  releaseFailed: number;
};

type DrainSnsQueueOptions = {
  client: Pick<SQSClient, "send">;
  queueUrl: string;
  /** Must outlast the handling of one whole batch. */
  visibilityTimeoutSeconds: number;
  handle: (delivery: SnsQueueDelivery) => Promise<SnsQueueHandled>;
  /**
   * Work units one run may spend. Once spent, the run leases no further batch
   * and stops with `limitReached`. A leased batch is always finished, since a
   * released delivery still counts toward the redrive limit, so a run spends
   * less than the budget plus one batch of deliveries at their fan-out cap;
   * each consumer caps a delivery's fan-out where it parses the delivery.
   */
  workBudget: number;
  signal: AbortSignal;
  logger: typeof appLogger;
  /** Prefix of this queue's log events, such as `inbound_mail.queue`. */
  logPrefix: string;
};

/**
 * Leases bounded batches and hands each delivery to `handle` in turn. A
 * delivery is deleted only when `handle` acknowledges it; anything else stays
 * on the queue for its visibility timeout and redrive policy. An abort
 * releases the deliveries that have not started; a spent work budget stops
 * the run before its next lease.
 */
export const drainSnsQueue = async ({
  client,
  queueUrl,
  visibilityTimeoutSeconds,
  handle,
  workBudget,
  signal,
  logger,
  logPrefix,
}: DrainSnsQueueOptions): Promise<
  Result<SnsQueueDrainSummary, SnsQueueReceiveError>
> => {
  let deleteFailed = 0;
  let releaseFailed = 0;
  let workSpent = 0;
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
            VisibilityTimeout: visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          { abortSignal: signal },
        ),
      catch: (cause) =>
        new SnsQueueReceiveError({
          message: "The queue could not be read",
          cause,
        }),
    });

  const remove = async (message: Message, deliveryId: string) => {
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
      // Handlers converge on redelivery, so a failed delete is not lost work.
      deleteFailed += 1;
      logger.warn(`${logPrefix}.delete_failed`, {
        "queue.delivery_id": deliveryId,
        "error.type": errorTag(deleted.error),
      });
    }
  };

  const releaseMessages = async (messages: readonly Message[]) => {
    // Batch entry ids are the message positions, so a failed id names its
    // message without parsing it back.
    const byEntryId = new Map(
      messages.map((message, index) => [String(index), message] as const),
    );
    const released = await Result.tryPromise({
      try: async () =>
        await client.send(
          new ChangeMessageVisibilityBatchCommand({
            QueueUrl: queueUrl,
            Entries: [...byEntryId].map(([id, message]) => ({
              Id: id,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            })),
          }),
          { abortSignal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) },
        ),
      catch: (cause) => cause,
    });
    const failedIds = released.isErr()
      ? [...byEntryId.keys()]
      : released.value.Failed?.map(({ Id }) => Id);
    // SQS omits `Failed` when every entry was released.
    if (failedIds === undefined) {
      return;
    }
    for (const failedId of failedIds) {
      const message =
        failedId === undefined ? undefined : byEntryId.get(failedId);
      releaseFailed += 1;
      logger.warn(`${logPrefix}.release_failed`, {
        "queue.delivery_id": message?.MessageId ?? "unknown",
        "error.type": released.isErr()
          ? errorTag(released.error)
          : "SqsBatchEntryError",
      });
    }
  };

  const summary = (
    batches: number,
    stoppedBecause: SnsQueueDrainSummary["stoppedBecause"],
  ) => Result.ok({ batches, stoppedBecause, deleteFailed, releaseFailed });

  // Read through a call: the signal can abort during any await, so a
  // narrowed `signal.aborted` would be stale.
  const aborted = () => signal.aborted;
  const budgetSpent = () => workSpent >= workBudget;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    if (aborted()) {
      return summary(batch, "aborted");
    }
    if (budgetSpent() || Temporal.Now.instant().epochMilliseconds >= deadline) {
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
    for (const [index, message] of messages.entries()) {
      // On abort, immediately re-offer only deliveries that have not started.
      if (aborted()) {
        await releaseMessages(messages.slice(index));
        return summary(batch + 1, "aborted");
      }
      // One delivery at a time, so an abort leaves none half-acknowledged.
      const deliveryId = message.MessageId ?? "unknown";
      const { disposition, work } = await handle({
        body: message.Body,
        deliveryId,
        receiveCount: message.Attributes?.ApproximateReceiveCount ?? "unknown",
      });
      workSpent += work;
      if (disposition === "acknowledge") {
        await remove(message, deliveryId);
      }
    }
  }
  return summary(MAX_BATCHES_PER_RUN, "limitReached");
};

/** How many messages wait in a queue, as SQS approximates it. */
export const readApproximateQueueDepth = async ({
  client,
  queueUrl,
}: {
  client: Pick<SQSClient, "send">;
  queueUrl: string;
}): Promise<Result<number, unknown>> =>
  await Result.tryPromise({
    try: async () => {
      const attributes = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
        { abortSignal: AbortSignal.timeout(DEPTH_TIMEOUT_MS) },
      );
      const depth = attributes.Attributes?.ApproximateNumberOfMessages;
      return depth === undefined
        ? 0
        : parseIntegerToken(depth, { sign: "unsigned" }).unwrap(
            "SQS reports a queue depth as a whole number",
          );
    },
    catch: (cause) => cause,
  });
