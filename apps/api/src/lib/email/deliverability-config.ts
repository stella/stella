import { Result, TaggedError } from "better-result";

import { parseSqsQueueUrl, type SqsQueue } from "@/api/lib/email/sqs-queue-url";

export type EmailEventsInput = {
  EMAIL_EVENTS_QUEUE_URL?: string | undefined;
  EMAIL_EVENTS_TOPIC_ARN?: string | undefined;
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL?: string | undefined;
};

type EmailEvents =
  | { type: "disabled" }
  | {
      type: "enabled";
      queue: SqsQueue;
      topicArn: string;
      deadLetterQueue: SqsQueue;
    };

class EmailEventsConfigError extends TaggedError("EmailEventsConfigError")<{
  message: string;
}> {}

// The boot invariant and the scheduler gate both read this, so a partial
// configuration cannot pass one and reach the other.
export const resolveEmailEvents = ({
  EMAIL_EVENTS_QUEUE_URL,
  EMAIL_EVENTS_TOPIC_ARN,
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL,
}: EmailEventsInput): Result<EmailEvents, EmailEventsConfigError> => {
  if (
    EMAIL_EVENTS_QUEUE_URL === undefined &&
    EMAIL_EVENTS_TOPIC_ARN === undefined &&
    EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL === undefined
  ) {
    return Result.ok({ type: "disabled" });
  }
  if (
    EMAIL_EVENTS_QUEUE_URL === undefined ||
    EMAIL_EVENTS_TOPIC_ARN === undefined ||
    EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL === undefined
  ) {
    return Result.err(
      new EmailEventsConfigError({
        message:
          "EMAIL_EVENTS_QUEUE_URL, EMAIL_EVENTS_TOPIC_ARN and EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL must be configured together.",
      }),
    );
  }
  const queue = parseSqsQueueUrl(EMAIL_EVENTS_QUEUE_URL);
  const deadLetterQueue = parseSqsQueueUrl(EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL);
  if (queue === null || deadLetterQueue === null) {
    return Result.err(
      new EmailEventsConfigError({
        message:
          "EMAIL_EVENTS_QUEUE_URL and EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL must be SQS queue URLs (https://sqs.<region>.amazonaws.com/<account>/<name>).",
      }),
    );
  }
  // SQS only redrives to a dead-letter queue in the source queue's region.
  if (deadLetterQueue.region !== queue.region) {
    return Result.err(
      new EmailEventsConfigError({
        message: `EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL is in ${deadLetterQueue.region}; it must be in the queue's region, ${queue.region}.`,
      }),
    );
  }
  return Result.ok({
    type: "enabled",
    queue,
    topicArn: EMAIL_EVENTS_TOPIC_ARN,
    deadLetterQueue,
  });
};
