import { afterEach, describe, expect, test } from "bun:test";

import {
  drainDeliverabilityEvents,
  readDeliverabilityTransition,
} from "@/api/lib/email/deliverability";
import type { AccountEmailUndeliverableReason } from "@/api/lib/email/deliverability-contract";
import type { NormalizedEmail } from "@/api/lib/email/normalized-email";
import {
  logger,
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import { createFakeSqsQueue } from "@/api/tests/helpers/fake-sqs";

const topicArn = "arn:aws:sns:eu-west-1:123456789012:ses-notifications";
const queueUrl = "https://sqs.eu-west-1.amazonaws.com/123456789012/ses-events";
const timestamp = "2026-10-26T03:37:41.000Z";

const bounce = (
  bounceType: string,
  bounceSubType: string,
  recipients = ["Member@Example.test"],
) => ({
  eventType: "Bounce",
  mail: { messageId: "provider-message", destination: recipients },
  bounce: {
    bounceType,
    bounceSubType,
    bouncedRecipients: recipients.map((emailAddress) => ({ emailAddress })),
    timestamp,
  },
});

const complaint = (complaintSubType: string | null) => ({
  eventType: "Complaint",
  mail: { messageId: "provider-message" },
  complaint: {
    complainedRecipients: [{ emailAddress: "member@example.test" }],
    complaintSubType,
    timestamp,
  },
});

const snsBody = (message: unknown, arn = topicArn) =>
  JSON.stringify({
    Type: "Notification",
    MessageId: "sns-message",
    TopicArn: arn,
    Message: JSON.stringify(message),
  });

describe("deliverability transitions", () => {
  test.each([
    ["Permanent", "General", "hard_bounce"],
    ["Permanent", "NoEmail", "hard_bounce"],
    ["Permanent", "Suppressed", "suppressed"],
    ["Permanent", "OnAccountSuppressionList", "suppressed"],
  ] as const)(
    "a %s %s bounce makes the address undeliverable as %s",
    (bounceType, subType, reason) => {
      const transition = readDeliverabilityTransition(
        bounce(bounceType, subType),
      );
      expect(transition.isOk() && transition.value).toEqual({
        type: "undeliverable",
        reason,
        recipients: ["member@example.test"],
        at: new Date(timestamp),
      });
    },
  );

  test.each(["Transient", "Undetermined"])(
    "a %s bounce changes nothing",
    (bounceType) => {
      const transition = readDeliverabilityTransition(
        bounce(bounceType, "General"),
      );
      expect(transition.isOk() && transition.value).toEqual({
        type: "unchanged",
        cause: "transient-bounce",
      });
    },
  );

  test("a complaint marks the address, a suppression-list complaint as suppressed", () => {
    for (const [subType, reason] of [
      [null, "complaint"],
      ["OnAccountSuppressionList", "suppressed"],
    ] as const) {
      const transition = readDeliverabilityTransition(complaint(subType));
      expect(transition.isOk() && transition.value).toMatchObject({
        type: "undeliverable",
        reason,
      });
    }
  });

  test("names only valid addresses and refuses other event types", () => {
    const transition = readDeliverabilityTransition(
      bounce("Permanent", "General", ["not an address", "a@example.test"]),
    );
    expect(transition.isOk() && transition.value).toMatchObject({
      recipients: ["a@example.test"],
    });
    const delivery = readDeliverabilityTransition({
      eventType: "Delivery",
      delivery: { recipients: ["a@example.test"] },
    });
    expect(delivery.isErr() && delivery.error.reason).toBe("unsupported-event");
  });
});

const records: LogRecord[] = [];
afterEach(() => {
  resetLogSinkForTesting();
});

describe("deliverability event drain", () => {
  test("applies events, deletes what it applied and keeps what it could not", async () => {
    records.length = 0;
    setLogSinkForTesting((record) => {
      records.push(record);
    });
    const queue = createFakeSqsQueue();
    const marked: [NormalizedEmail, AccountEmailUndeliverableReason][] = [];
    let failWrites = 1;
    const drain = async () =>
      await drainDeliverabilityEvents({
        client: queue.client,
        queueUrl,
        topicArn,
        signal: new AbortController().signal,
        logger,
        markUndeliverable: async (email, reason) => {
          if (email === "retry@example.test" && failWrites > 0) {
            failWrites -= 1;
            throw new Error("database unavailable");
          }
          marked.push([email, reason]);
          return email !== "nobody@example.test";
        },
      });

    queue.enqueue(snsBody(bounce("Permanent", "OnAccountSuppressionList")));
    queue.enqueue(
      snsBody(bounce("Permanent", "General", ["nobody@example.test"])),
    );
    queue.enqueue(snsBody(bounce("Transient", "MailboxFull")));
    const retry = queue.enqueue(
      snsBody(bounce("Permanent", "General", ["retry@example.test"])),
    );
    const poison = queue.enqueue(
      snsBody(bounce("Permanent", "General"), `${topicArn}-other`),
    );

    const first = await drain();
    expect(first.isOk() && first.value).toMatchObject({
      marked: 1,
      unknownAddress: 1,
      unchanged: 1,
      retry: 1,
      poison: 1,
      stoppedBecause: "drained",
    });
    expect(
      queue
        .remaining()
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual([poison, retry].toSorted());

    queue.expireLeases();
    const second = await drain();
    expect(second.isOk() && second.value).toMatchObject({
      marked: 1,
      poison: 1,
    });
    expect(queue.remaining().map(({ id }) => id)).toEqual([poison]);
    expect(marked).toEqual([
      ["member@example.test", "suppressed"],
      ["nobody@example.test", "hard_bounce"],
      ["retry@example.test", "hard_bounce"],
    ]);

    // Logs carry delivery ids and reasons, never an address.
    expect(JSON.stringify(records)).not.toContain("example.test");
  });
});
