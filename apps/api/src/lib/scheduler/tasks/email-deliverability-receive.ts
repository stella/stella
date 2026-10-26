import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { panic, Result } from "better-result";

import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { markAccountEmailUndeliverable } from "@/api/lib/db/account-row";
import { drainDeliverabilityEvents } from "@/api/lib/email/deliverability";
import { resolveEmailEvents } from "@/api/lib/email/deliverability-config";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

export const RECEIVE_EMAIL_DELIVERABILITY_TASK =
  "emailDeliverability.receive" as const;

const DEAD_LETTER_DEPTH_TIMEOUT_MS = 5000;

// The queue shares the object store's region; credentials come from the SDK's
// default chain (the task role in a deployment).
let sqsClient: SQSClient | null = null;
const getSqsClient = () => {
  sqsClient ??= new SQSClient({ region: envBase.S3_REGION });
  return sqsClient;
};

export const receiveEmailDeliverability: SchedulerTask = async ({
  dueAt,
  logger,
  scheduleContinuation,
  signal,
}) => {
  const events = resolveEmailEvents(env);
  if (events.isErr()) {
    // Boot validates the same resolver, so a running API cannot reach this.
    return panic(events.error.message);
  }
  const config = events.value;
  switch (config.type) {
    case "disabled":
      logger.warn("email_deliverability.queue.disabled");
      return Result.ok(undefined);
    case "enabled":
      break;
    default:
      config satisfies never;
      return panic("Unhandled email events configuration");
  }
  const client = getSqsClient();
  const drained = await drainDeliverabilityEvents({
    client,
    queueUrl: config.queueUrl,
    topicArn: config.topicArn,
    markUndeliverable: async (email, reason, at) =>
      await markAccountEmailUndeliverable({
        database: rootDb,
        email,
        reason,
        at,
      }),
    signal,
    logger,
  });

  // Events the consumer could not apply wait in the dead-letter queue; their
  // count is reported on every run instead of a separate alarm.
  const depth = await Result.tryPromise(
    async () =>
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: config.deadLetterQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
        { abortSignal: AbortSignal.timeout(DEAD_LETTER_DEPTH_TIMEOUT_MS) },
      ),
  );
  if (depth.isErr()) {
    logger.warn("email_deliverability.dead_letters.unreadable", {
      "error.type": errorTag(depth.error),
    });
  } else {
    const deadLetters = Number(
      depth.value.Attributes?.ApproximateNumberOfMessages ?? "0",
    );
    if (deadLetters > 0) {
      logger.error("email_deliverability.dead_letters", {
        "queue.dead_letters": deadLetters,
      });
    }
  }

  if (drained.isErr()) {
    return Result.err(
      new SchedulerTaskFailure({
        message: drained.error.message,
        cause: drained.error,
      }),
    );
  }
  if (drained.value.stoppedBecause === "limitReached" && !signal.aborted) {
    scheduleContinuation(dueAt.claimedAtDate());
  }
  return Result.ok(undefined);
};
