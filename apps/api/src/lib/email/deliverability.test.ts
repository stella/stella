import { afterEach, describe, expect, test } from "bun:test";

import {
  drainDeliverabilityEvents,
  MAX_RECIPIENTS_PER_EVENT,
  readDeliverabilityTransition,
  RECIPIENT_WRITES_PER_RUN,
} from "@/api/lib/email/deliverability";
import type { AccountEmailUndeliverableReason } from "@/api/lib/email/deliverability-contract";
import {
  type NormalizedEmail,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";
import { MAX_MESSAGES_PER_BATCH } from "@/api/lib/email/sns-queue-drain";
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
        recipients: [normalizeEmail("member@example.test")],
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
        markUndeliverable: async (emails, reason) => {
          if (
            emails.includes(normalizeEmail("retry@example.test")) &&
            failWrites > 0
          ) {
            failWrites -= 1;
            throw new Error("database unavailable");
          }
          marked.push(
            ...emails.map(
              (email): [NormalizedEmail, AccountEmailUndeliverableReason] => [
                email,
                reason,
              ],
            ),
          );
          return emails.filter((email) => email !== "nobody@example.test")
            .length;
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
      [normalizeEmail("member@example.test"), "suppressed"],
      [normalizeEmail("nobody@example.test"), "hard_bounce"],
      [normalizeEmail("retry@example.test"), "hard_bounce"],
    ]);

    // Logs carry delivery ids and reasons, never an address.
    expect(JSON.stringify(records)).not.toContain("example.test");
  });

  const addresses = (event: string, count: number) =>
    Array.from(
      { length: count },
      (_, index) => `Recipient-${index}.${event}@example.test`,
    );

  const countingDrain = (queue: ReturnType<typeof createFakeSqsQueue>) => {
    const marked: NormalizedEmail[] = [];
    const writes: number[] = [];
    const drain = async () =>
      await drainDeliverabilityEvents({
        client: queue.client,
        queueUrl,
        topicArn,
        signal: new AbortController().signal,
        logger,
        markUndeliverable: async (emails) => {
          writes.push(emails.length);
          marked.push(...emails);
          return emails.length;
        },
      });
    return { drain, marked, writes };
  };

  test("stops leasing once a run's recipient writes are spent, one write per event", async () => {
    const perEvent = RECIPIENT_WRITES_PER_RUN / (4 * MAX_MESSAGES_PER_BATCH);
    const queue = createFakeSqsQueue();
    const { drain, marked, writes } = countingDrain(queue);
    for (let index = 0; index < 45; index += 1) {
      queue.enqueue(
        snsBody(
          bounce("Permanent", "General", addresses(`e${index}`, perEvent)),
        ),
      );
    }
    const first = await drain();
    expect(first.isOk() && first.value).toMatchObject({
      batches: 4,
      marked: RECIPIENT_WRITES_PER_RUN,
      stoppedBecause: "limitReached",
    });
    expect(queue.releasedMessageIds).toEqual([]);
    expect(queue.remaining()).toHaveLength(5);
    expect(writes).toEqual(Array.from({ length: 40 }, () => perEvent));

    const second = await drain();
    expect(second.isOk() && second.value).toMatchObject({
      marked: 5 * perEvent,
      stoppedBecause: "drained",
    });
    expect(new Set(marked).size).toBe(45 * perEvent);
  });

  test("a run at the recipient cap overshoots its budget by less than one batch", async () => {
    const queue = createFakeSqsQueue();
    const { drain, marked } = countingDrain(queue);
    const events = 2 * MAX_MESSAGES_PER_BATCH;
    for (let index = 0; index < events; index += 1) {
      queue.enqueue(
        snsBody(
          bounce(
            "Permanent",
            "General",
            addresses(`cap${index}`, MAX_RECIPIENTS_PER_EVENT),
          ),
        ),
      );
    }
    const drained = await drain();
    expect(drained.isOk() && drained.value).toMatchObject({
      stoppedBecause: "limitReached",
    });
    expect(marked.length).toBeLessThan(
      RECIPIENT_WRITES_PER_RUN +
        MAX_MESSAGES_PER_BATCH * MAX_RECIPIENTS_PER_EVENT,
    );
    expect(queue.remaining().length).toBeGreaterThan(0);
  });

  test("an event naming more recipients than the provider sends is kept for redrive", async () => {
    const queue = createFakeSqsQueue();
    const { drain, marked } = countingDrain(queue);
    const oversized = queue.enqueue(
      snsBody(
        bounce(
          "Permanent",
          "General",
          addresses("oversized", MAX_RECIPIENTS_PER_EVENT + 1),
        ),
      ),
    );
    const drained = await drain();
    expect(drained.isOk() && drained.value).toMatchObject({
      poison: 1,
      marked: 0,
    });
    expect(marked).toEqual([]);
    expect(queue.remaining().map(({ id }) => id)).toEqual([oversized]);
  });

  test("an event naming an address twice writes it once", async () => {
    const queue = createFakeSqsQueue();
    const { drain, marked } = countingDrain(queue);
    queue.enqueue(
      snsBody(
        bounce("Permanent", "General", [
          "Twice@Example.test",
          "twice@example.test",
        ]),
      ),
    );
    const drained = await drain();
    expect(drained.isOk() && drained.value).toMatchObject({
      marked: 1,
      unknownAddress: 0,
    });
    expect(marked).toEqual([normalizeEmail("twice@example.test")]);
  });
});
