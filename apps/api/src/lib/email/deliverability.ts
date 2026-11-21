import type { SQSClient } from "@aws-sdk/client-sqs";
import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { EmailDeliveryFailureReason } from "@stll/api-contract/email-delivery";
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
  type SnsQueueHandled,
} from "@/api/lib/email/sns-queue-drain";
import type { logger as appLogger } from "@/api/lib/observability/logger";

// Each delivery is one small database write; a batch finishes in seconds.
const VISIBILITY_TIMEOUT_SECONDS = 60;

/**
 * The provider sends one message to at most 50 recipients, so one event names
 * at most 50. An event naming more did not come from it and is kept for the
 * dead-letter queue.
 */
export const MAX_RECIPIENTS_PER_EVENT = 50;

/**
 * Recipient rows one run may write; the continuation drains the rest. Each
 * event's rows are one write per kind through the unique address indexes.
 */
export const RECIPIENT_WRITES_PER_RUN = 200;

// The provider's configuration-set events, as its SNS destination publishes
// them. Only the fields that decide a transition are read; nothing else from
// the event, and no message content or diagnostic text, is kept anywhere.
const recipientsSchema = v.pipe(
  v.array(v.object({ emailAddress: v.string() })),
  v.maxLength(MAX_RECIPIENTS_PER_EVENT),
);
const bouncedRecipientsSchema = v.pipe(
  v.array(
    v.object({
      emailAddress: v.string(),
      status: v.optional(v.nullable(v.string())),
      diagnosticCode: v.optional(v.nullable(v.string())),
    }),
  ),
  v.maxLength(MAX_RECIPIENTS_PER_EVENT),
);
const providerEventSchema = v.variant("eventType", [
  v.object({
    eventType: v.literal("Bounce"),
    // The provider's id for the bounced message, as its send returned it.
    mail: v.object({ messageId: v.string() }),
    bounce: v.object({
      bounceType: v.string(),
      bounceSubType: v.string(),
      bouncedRecipients: bouncedRecipientsSchema,
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

type BouncedRecipient = v.InferOutput<typeof bouncedRecipientsSchema>[number];

/** Why mail failed to reach one address. */
export type EmailDeliveryFailure = {
  email: NormalizedEmail;
  reason: EmailDeliveryFailureReason;
};

// The provider's own suppression list refused the send without trying.
const SUPPRESSION_SUBTYPES: ReadonlySet<string> = new Set([
  "Suppressed",
  "OnAccountSuppressionList",
]);

// The receiving server would not take mail over TLS, which the configuration
// set requires. Such a refusal can carry a mailbox status (5.1.1) as well, so
// it is read before the status.
const TLS_REFUSAL = /\bSTARTTLS\b|\bTLS\b/iu;
// RFC 3463 enhanced status codes: 5.1.1 bad mailbox and 5.1.10 null MX;
// x.2.0 to x.2.2 mailbox unavailable, disabled or full.
const ENHANCED_STATUS = /\b([245]\.\d{1,3}\.\d{1,3})\b/u;
const MAILBOX_MISSING_STATUSES: ReadonlySet<string> = new Set([
  "5.1.1",
  "5.1.10",
]);
const MAILBOX_UNAVAILABLE_STATUS = /^[45]\.2\.[0-2]$/u;

type ClassifyBounceFailureOptions = {
  bounceType: string;
  bounceSubType: string;
  recipient: Pick<BouncedRecipient, "status" | "diagnosticCode">;
};

/**
 * Why a bounce kept mail from one recipient, in the classes the sign-in
 * screen explains. The recipient's own diagnostic and status decide before
 * the event's subtype, except a suppression-list refusal, which never reached
 * the recipient's server.
 */
export const classifyBounceFailure = ({
  bounceType,
  bounceSubType,
  recipient: { status, diagnosticCode },
}: ClassifyBounceFailureOptions): EmailDeliveryFailureReason => {
  if (SUPPRESSION_SUBTYPES.has(bounceSubType)) {
    return "suppressed";
  }
  if (diagnosticCode && TLS_REFUSAL.test(diagnosticCode)) {
    return "tls_required";
  }
  const enhanced =
    status?.trim() || (ENHANCED_STATUS.exec(diagnosticCode ?? "")?.[1] ?? "");
  if (bounceSubType === "NoEmail" || MAILBOX_MISSING_STATUSES.has(enhanced)) {
    return "mailbox_missing";
  }
  if (
    bounceSubType === "MailboxFull" ||
    MAILBOX_UNAVAILABLE_STATUS.test(enhanced)
  ) {
    return "mailbox_unavailable";
  }
  // The provider stopped retrying a server or mailbox that would not take
  // mail for now.
  if (bounceType === "Transient" && bounceSubType === "General") {
    return "mailbox_unavailable";
  }
  return "other";
};

type AccountRefusal =
  | { type: "none" }
  | {
      type: "refused";
      reason: AccountEmailUndeliverableReason;
      recipients: NormalizedEmail[];
    };

/**
 * What a provider event means for the addresses it names: the accounts at
 * them may stop receiving mail (`refusal`), and why mail failed to reach each
 * address is recorded (`failures`). A bounce also names the message that
 * failed (`bouncedMessage`), so the sign-in attempt that sent it can learn
 * why; a complaint names none.
 */
export type DeliverabilityTransition = {
  refusal: AccountRefusal;
  failures: EmailDeliveryFailure[];
  bouncedMessage:
    { type: "message"; providerMessageId: string } | { type: "none" };
  at: Date;
};

class DeliverabilityEventError extends TaggedError("DeliverabilityEventError")<{
  message: string;
  reason: "envelope" | "unsupported-event" | "invalid-time";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const toRecipient = (emailAddress: string): NormalizedEmail | undefined => {
  const parsed = v.safeParse(emailAddressSchema, emailAddress);
  return parsed.success ? normalizeEmail(parsed.output) : undefined;
};

const toRecipients = (
  recipients: v.InferOutput<typeof recipientsSchema>,
): NormalizedEmail[] => [
  ...new Set(
    recipients.flatMap(({ emailAddress }) => {
      const recipient = toRecipient(emailAddress);
      return recipient === undefined ? [] : [recipient];
    }),
  ),
];

type ToFailuresOptions = {
  bounceType: string;
  bounceSubType: string;
  bouncedRecipients: readonly BouncedRecipient[];
};

// One failure per address, so one statement can write them all; an address
// named twice keeps its first naming.
const toFailures = ({
  bounceType,
  bounceSubType,
  bouncedRecipients,
}: ToFailuresOptions): EmailDeliveryFailure[] => {
  const failures = new Map<NormalizedEmail, EmailDeliveryFailureReason>();
  for (const recipient of bouncedRecipients) {
    const email = toRecipient(recipient.emailAddress);
    if (email !== undefined && !failures.has(email)) {
      failures.set(
        email,
        classifyBounceFailure({ bounceType, bounceSubType, recipient }),
      );
    }
  }
  return [...failures].map(([email, reason]) => ({ email, reason }));
};

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
 * Reads a provider event. A permanent bounce, a complaint or a
 * suppression-list refusal makes the accounts at its addresses undeliverable;
 * a transient bounce leaves them deliverable. Every bounce records why mail
 * failed per address, transient ones included; a complaint records no
 * failure, since the mail arrived.
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
      const failures = toFailures(bounce);
      const refusal: AccountRefusal =
        bounce.bounceType === "Permanent"
          ? {
              type: "refused",
              reason: SUPPRESSION_SUBTYPES.has(bounce.bounceSubType)
                ? "suppressed"
                : "hard_bounce",
              recipients: failures.map(({ email }) => email),
            }
          : { type: "none" };
      const bouncedMessage = {
        type: "message",
        providerMessageId: providerEvent.mail.messageId,
      } as const;
      return parseEventTime(bounce.timestamp).map(
        (at): DeliverabilityTransition => ({
          refusal,
          failures,
          bouncedMessage,
          at,
        }),
      );
    }
    case "Complaint": {
      const { complaint } = providerEvent;
      return parseEventTime(complaint.timestamp).map(
        (at): DeliverabilityTransition => ({
          refusal: {
            type: "refused",
            reason: SUPPRESSION_SUBTYPES.has(complaint.complaintSubType ?? "")
              ? "suppressed"
              : "complaint",
            recipients: toRecipients(complaint.complainedRecipients),
          },
          failures: [],
          bouncedMessage: { type: "none" },
          at,
        }),
      );
    }
    default:
      providerEvent satisfies never;
      return panic("Unhandled provider event type");
  }
};

type DeliverabilityDrainCounts = {
  marked: number;
  unknownAddress: number;
  failuresRecorded: number;
  retry: number;
  poison: number;
};

type DrainDeliverabilityEventsOptions = {
  client: Pick<SQSClient, "send">;
  queueUrl: string;
  topicArn: string;
  /** Marks the accounts at these addresses; resolves how many were marked. */
  markUndeliverable: (
    emails: readonly NormalizedEmail[],
    reason: AccountEmailUndeliverableReason,
    at: Date,
  ) => Promise<number>;
  /** Records why mail failed per address; resolves how many were written. */
  recordFailures: (
    failures: readonly EmailDeliveryFailure[],
    at: Date,
  ) => Promise<number>;
  /**
   * Tells the sign-in attempt that sent a bounced message why it failed, if
   * one did. Best effort: it never fails the event.
   */
  reportBouncedMessage: (
    providerMessageId: string,
    reason: EmailDeliveryFailureReason,
  ) => Promise<void>;
  signal: AbortSignal;
  logger: typeof appLogger;
};

type AppliedTransition = { recorded: number; marked: number };

/**
 * Applies the provider's bounce and complaint events to the accounts and
 * addresses they name. A delivery is deleted once its transition is stored,
 * so the queue keeps no event longer than it takes to apply it.
 */
export const drainDeliverabilityEvents = async ({
  client,
  queueUrl,
  topicArn,
  markUndeliverable,
  recordFailures,
  reportBouncedMessage,
  signal,
  logger,
}: DrainDeliverabilityEventsOptions) => {
  const counts: DeliverabilityDrainCounts = {
    marked: 0,
    unknownAddress: 0,
    failuresRecorded: 0,
    retry: 0,
    poison: 0,
  };

  const apply = async ({
    refusal,
    failures,
    bouncedMessage,
    at,
  }: DeliverabilityTransition): Promise<AppliedTransition> => {
    const recorded = await recordFailures(failures, at);
    // A sign-in code goes to one address, so its message's first failure is
    // the one that matters.
    const firstFailure = failures.at(0);
    if (bouncedMessage.type === "message" && firstFailure !== undefined) {
      await reportBouncedMessage(
        bouncedMessage.providerMessageId,
        firstFailure.reason,
      );
    }
    switch (refusal.type) {
      case "none":
        return { recorded, marked: 0 };
      case "refused":
        return {
          recorded,
          marked: await markUndeliverable(
            refusal.recipients,
            refusal.reason,
            at,
          ),
        };
      default:
        refusal satisfies never;
        return panic("Unhandled account refusal");
    }
  };

  const handle = async ({
    body,
    deliveryId,
    receiveCount,
  }: SnsQueueDelivery): Promise<SnsQueueHandled> => {
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
      return { disposition: "keep", work: 0 };
    }
    const { value } = transition;
    const { refusal, failures } = value;
    const refused = refusal.type === "refused" ? refusal.recipients : [];
    // Each kind of row is one statement over the event's recipients; a
    // redelivery after a failed write spends the budget again, and both
    // writes converge on replay.
    const work = new Set([...refused, ...failures.map(({ email }) => email)])
      .size;
    const applied = await Result.tryPromise(async () => await apply(value));
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
      return { disposition: "keep", work };
    }
    const { recorded, marked } = applied.value;
    counts.failuresRecorded += recorded;
    counts.marked += marked;
    counts.unknownAddress += refused.length - marked;
    if (refusal.type === "refused" && marked > 0) {
      logger.info("email_deliverability.marked", {
        "queue.delivery_id": deliveryId,
        "delivery.refusal_reason": refusal.reason,
        "delivery.marked_accounts": marked,
      });
    }
    if (recorded > 0) {
      logger.info("email_deliverability.failures_recorded", {
        "queue.delivery_id": deliveryId,
        "delivery.failure_reasons": [
          ...new Set(failures.map(({ reason }) => reason)),
        ]
          .toSorted()
          .join(","),
        "delivery.failed_addresses": recorded,
      });
    }
    return { disposition: "acknowledge", work };
  };

  const drained = await drainSnsQueue({
    client,
    queueUrl,
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    handle,
    workBudget: RECIPIENT_WRITES_PER_RUN,
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
