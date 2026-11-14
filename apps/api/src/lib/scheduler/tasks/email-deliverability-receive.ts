import { panic, Result } from "better-result";

import { env } from "@/api/env";
import { drainDeliverabilityEvents } from "@/api/lib/email/deliverability";
import { resolveEmailEvents } from "@/api/lib/email/deliverability-config";
import { recordRecipientRefusals } from "@/api/lib/email/recipient-deliverability";
import {
  readApproximateQueueDepth,
  sqsClientFor,
} from "@/api/lib/email/sns-queue-drain";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

export const RECEIVE_EMAIL_DELIVERABILITY_TASK =
  "emailDeliverability.receive" as const;

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
  const client = sqsClientFor(config.queue);
  const drained = await drainDeliverabilityEvents({
    client,
    queueUrl: config.queue.url,
    topicArn: config.topicArn,
    markUndeliverable: recordRecipientRefusals,
    signal,
    logger,
  });

  // Events the consumer could not apply wait in the dead-letter queue; their
  // count is reported on every run instead of a separate alarm.
  const depth = await readApproximateQueueDepth({
    client,
    queueUrl: config.deadLetterQueue.url,
  });
  if (depth.isErr()) {
    logger.warn("email_deliverability.dead_letters.unreadable", {
      "error.type": errorTag(depth.error),
    });
  } else {
    const deadLetters = depth.value;
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
