import { Result, TaggedError } from "better-result";

export type EmailEventsInput = {
  EMAIL_EVENTS_QUEUE_URL?: string | undefined;
  EMAIL_EVENTS_TOPIC_ARN?: string | undefined;
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL?: string | undefined;
};

type EmailEvents =
  | { type: "disabled" }
  | {
      type: "enabled";
      queueUrl: string;
      topicArn: string;
      deadLetterQueueUrl: string;
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
  return Result.ok({
    type: "enabled",
    queueUrl: EMAIL_EVENTS_QUEUE_URL,
    topicArn: EMAIL_EVENTS_TOPIC_ARN,
    deadLetterQueueUrl: EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL,
  });
};
