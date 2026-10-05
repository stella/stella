import { Result, TaggedError } from "better-result";

export type InboundMailReceivingInput = {
  INBOUND_MAIL_DOMAIN?: string | undefined;
  INBOUND_MAIL_QUEUE_URL?: string | undefined;
  INBOUND_MAIL_TOPIC_ARN?: string | undefined;
  INBOUND_MAIL_BUCKET?: string | undefined;
  INBOUND_MAIL_KEY_PREFIX?: string | undefined;
};

type InboundMailReceiving =
  | { type: "disabled" }
  | {
      type: "enabled";
      inboundDomain: string;
      queueUrl: string;
      topicArn: string;
      bucket: string;
      keyPrefix: string;
    };

class InboundMailReceivingConfigError extends TaggedError(
  "InboundMailReceivingConfigError",
)<{ message: string }> {}

// The boot invariant and the scheduler gate both read this, so a partial
// transport configuration cannot pass one and reach the other.
export const resolveInboundMailReceiving = ({
  INBOUND_MAIL_DOMAIN,
  INBOUND_MAIL_QUEUE_URL,
  INBOUND_MAIL_TOPIC_ARN,
  INBOUND_MAIL_BUCKET,
  INBOUND_MAIL_KEY_PREFIX,
}: InboundMailReceivingInput): Result<
  InboundMailReceiving,
  InboundMailReceivingConfigError
> => {
  const transport = [
    INBOUND_MAIL_QUEUE_URL,
    INBOUND_MAIL_TOPIC_ARN,
    INBOUND_MAIL_BUCKET,
    INBOUND_MAIL_KEY_PREFIX,
  ];
  if (transport.every((value) => value === undefined)) {
    return Result.ok({ type: "disabled" });
  }
  if (
    INBOUND_MAIL_QUEUE_URL === undefined ||
    INBOUND_MAIL_TOPIC_ARN === undefined ||
    INBOUND_MAIL_BUCKET === undefined ||
    INBOUND_MAIL_KEY_PREFIX === undefined
  ) {
    return Result.err(
      new InboundMailReceivingConfigError({
        message:
          "INBOUND_MAIL_QUEUE_URL, INBOUND_MAIL_TOPIC_ARN, INBOUND_MAIL_BUCKET and INBOUND_MAIL_KEY_PREFIX must be configured together.",
      }),
    );
  }
  if (INBOUND_MAIL_DOMAIN === undefined) {
    return Result.err(
      new InboundMailReceivingConfigError({
        message: "Inbound mail receiving requires INBOUND_MAIL_DOMAIN.",
      }),
    );
  }
  return Result.ok({
    type: "enabled",
    inboundDomain: INBOUND_MAIL_DOMAIN,
    queueUrl: INBOUND_MAIL_QUEUE_URL,
    topicArn: INBOUND_MAIL_TOPIC_ARN,
    bucket: INBOUND_MAIL_BUCKET,
    keyPrefix: INBOUND_MAIL_KEY_PREFIX,
  });
};
