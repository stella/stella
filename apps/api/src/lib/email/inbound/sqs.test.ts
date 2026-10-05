import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { generateInboundAddressToken } from "@/api/lib/email/inbound/address";
import type { InboundDeliveryStore } from "@/api/lib/email/inbound/ingest";
import {
  receiveSesInboundMail,
  SesInboundError,
} from "@/api/lib/email/inbound/ses";
import {
  drainInboundMailQueue,
  MAX_QUEUE_MESSAGE_CHARS,
  parseInboundQueueMessage,
} from "@/api/lib/email/inbound/sqs";
import {
  logger,
  resetLogSinkForTesting,
  setLogSinkForTesting,
  type LogRecord,
} from "@/api/lib/observability/logger";
import { createFakeSqsQueue } from "@/api/tests/helpers/fake-sqs";

const topicArn = "arn:aws:sns:eu-west-1:123456789012:inbound-mail";
const queueUrl = "https://sqs.eu-west-1.amazonaws.com/123456789012/inbound";
const token = generateInboundAddressToken();
const subject = "Confidential settlement terms";
const raw = new TextEncoder().encode(
  `From: Member <member@example.test>\r\nTo: Counsel <counsel@outside.test>\r\nSubject: ${subject}\r\nDate: Sat, 26 Sep 2026 12:00:00 +0000\r\nMessage-ID: <queue@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nPrivileged body text.\r\n`,
);

const sesEvent = (messageId: string) => ({
  notificationType: "Received",
  mail: {
    messageId,
    source: "member@example.test",
    timestamp: "2026-09-26T12:00:00.000Z",
    commonHeaders: { from: ["Member <member@example.test>"] },
  },
  receipt: {
    recipients: [`${token}@inbound.example.test`],
    action: {
      type: "S3",
      bucketName: "inbound-bucket",
      objectKey: `mail/${messageId}`,
    },
    spfVerdict: { status: "PASS" },
    dkimVerdict: { status: "PASS" },
    dmarcVerdict: { status: "PASS" },
    virusVerdict: { status: "PASS" },
  },
});

const snsBody = ({
  message,
  arn = topicArn,
  type = "Notification",
}: {
  message: unknown;
  arn?: string;
  type?: string;
}) =>
  JSON.stringify({
    Type: type,
    MessageId: "sns-message",
    TopicArn: arn,
    Message: typeof message === "string" ? message : JSON.stringify(message),
    Timestamp: "2026-09-26T12:00:01.000Z",
    SignatureVersion: "1",
  });

const reasonOf = (body: string | undefined) => {
  const parsed = parseInboundQueueMessage({ body, topicArn });
  return parsed.isErr() ? parsed.error.reason : parsed.value.type;
};

type QueueMessageRejection = Exclude<
  ReturnType<typeof reasonOf>,
  "received" | "setup"
>;

describe("queue message envelope", () => {
  test("accepts a received notification from the configured topic", () => {
    const parsed = parseInboundQueueMessage({
      body: snsBody({ message: sesEvent("delivery-1") }),
      topicArn,
    });
    expect(parsed.isOk() && parsed.value).toEqual({
      type: "received",
      event: sesEvent("delivery-1"),
    });
  });

  test("recognizes the provider's setup notification", () => {
    expect(
      reasonOf(
        snsBody({
          message: { notificationType: "AMAZON_SES_SETUP_NOTIFICATION" },
        }),
      ),
    ).toBe("setup");
  });

  test.each([
    [
      "another topic",
      snsBody({ message: sesEvent("x"), arn: `${topicArn}-other` }),
      "untrusted-topic",
    ],
    [
      "a subscription confirmation",
      snsBody({ message: sesEvent("x"), type: "SubscriptionConfirmation" }),
      "invalid-envelope",
    ],
    ["malformed JSON", '{"Type":', "malformed-json"],
    [
      "a malformed inner message",
      snsBody({ message: "{not json" }),
      "malformed-json",
    ],
    [
      "an inner message without a type",
      snsBody({ message: { mail: {} } }),
      "invalid-envelope",
    ],
    [
      "a bounce notification",
      snsBody({ message: { notificationType: "Bounce" } }),
      "unsupported-notification",
    ],
    [
      "a raw SES event without the SNS envelope",
      JSON.stringify(sesEvent("x")),
      "invalid-envelope",
    ],
    ["an oversized body", "x".repeat(MAX_QUEUE_MESSAGE_CHARS + 1), "oversized"],
    ["a missing body", undefined, "oversized"],
  ] as const satisfies readonly (readonly [
    string,
    string | undefined,
    QueueMessageRejection,
  ])[])("rejects %s", (_, body, reason) => {
    expect(reasonOf(body)).toBe(reason);
  });

  test("only the configured topic's notifications are accepted", () => {
    const sns = fc.record({
      Type: fc.constantFrom("Notification", "SubscriptionConfirmation", "x"),
      TopicArn: fc.constantFrom(topicArn, `${topicArn}x`, ""),
      Message: fc.oneof(
        fc.string(),
        fc.jsonValue().map((value) => JSON.stringify(value)),
        fc
          .constantFrom("Received", "AMAZON_SES_SETUP_NOTIFICATION", "Bounce")
          .map((notificationType) => JSON.stringify({ notificationType })),
      ),
    });
    assertProperty(
      "only the configured topic's notifications are accepted",
      fc.property(
        fc.oneof(
          fc.string(),
          fc.jsonValue().map((value) => JSON.stringify(value)),
          sns.map((value) => JSON.stringify(value)),
        ),
        (body) => {
          const parsed = parseInboundQueueMessage({ body, topicArn });
          if (parsed.isErr()) {
            return;
          }
          const envelope = JSON.parse(body);
          expect(envelope.Type).toBe("Notification");
          expect(envelope.TopicArn).toBe(topicArn);
          const kind = JSON.parse(envelope.Message).notificationType;
          expect(kind).toBe(
            parsed.value.type === "received"
              ? "Received"
              : "AMAZON_SES_SETUP_NOTIFICATION",
          );
        },
      ),
    );
  });
});

type DrainHarnessOptions = {
  persist?: InboundDeliveryStore;
  readObject?: Parameters<typeof receiveSesInboundMail>[0]["readObject"];
  onReceive?: () => void;
};

const filedStore: InboundDeliveryStore = async () =>
  Result.ok({ status: "filed", correspondenceId: "correspondence-1" });

const drainHarness = ({
  persist = filedStore,
  readObject = async () => Result.ok(raw),
  onReceive,
}: DrainHarnessOptions = {}) => {
  const queue = createFakeSqsQueue();
  const drain = async (signal = new AbortController().signal) =>
    await drainInboundMailQueue({
      client: queue.client,
      queueUrl,
      topicArn,
      signal,
      logger,
      receive: async (event) => {
        onReceive?.();
        const received = await receiveSesInboundMail({
          event,
          bucket: "inbound-bucket",
          keyPrefix: "mail/",
          inboundDomain: "inbound.example.test",
          readObject,
          persist,
        });
        return received.isErr()
          ? received
          : Result.ok(received.value.deliveries);
      },
    });
  return { queue, drain };
};

const records: LogRecord[] = [];
const captureLogs = () => {
  records.length = 0;
  setLogSinkForTesting((record) => {
    records.push(record);
  });
};
afterEach(() => {
  resetLogSinkForTesting();
});

describe("queue drain", () => {
  test("deletes terminal deliveries and leaves poison and retryable ones for redrive", async () => {
    captureLogs();
    let objectReads = 0;
    const { queue, drain } = drainHarness({
      readObject: async ({ key }) => {
        objectReads += 1;
        return key === "mail/unreadable"
          ? Result.err(
              new SesInboundError({
                message: "Inbound object could not be read",
                reason: "object-unavailable",
              }),
            )
          : Result.ok(raw);
      },
    });
    queue.enqueue(snsBody({ message: sesEvent("filed") }));
    const poison = queue.enqueue(
      snsBody({ message: sesEvent("poison"), arn: `${topicArn}-other` }),
    );
    const unreadable = queue.enqueue(
      snsBody({ message: sesEvent("unreadable") }),
    );
    queue.enqueue(
      snsBody({
        message: { notificationType: "AMAZON_SES_SETUP_NOTIFICATION" },
      }),
    );

    const first = await drain();
    expect(first.isOk() && first.value).toMatchObject({
      filed: 1,
      setup: 1,
      poison: 1,
      retry: 1,
      deleteFailed: 0,
      stoppedBecause: "drained",
    });
    expect(
      queue
        .remaining()
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual([poison, unreadable].toSorted());
    // The poison message never reached the object store.
    expect(objectReads).toBe(2);

    // Each later lease counts toward the queue's redrive limit; nothing is
    // deleted for them, so the dead-letter queue receives both.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      queue.expireLeases();
      await drain();
    }
    expect(queue.remaining()).toEqual(
      expect.arrayContaining([
        { id: poison, receiveCount: 5 },
        { id: unreadable, receiveCount: 5 },
      ]),
    );

    const serialized = JSON.stringify(records);
    for (const content of [
      subject,
      "Privileged body",
      token,
      "member@example.test",
      "mail/",
    ]) {
      expect(serialized).not.toContain(content);
    }
    expect(records.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        "inbound_mail.queue.poison",
        "inbound_mail.queue.retry",
        "inbound_mail.queue.received",
        "inbound_mail.queue.setup_notification",
      ]),
    );
  });

  test("leases bounded batches with a visibility timeout", async () => {
    const { queue, drain } = drainHarness();
    for (let index = 0; index < 105; index += 1) {
      queue.enqueue(snsBody({ message: sesEvent(`bulk-${index}`) }));
    }
    const drained = await drain();
    expect(drained.isOk() && drained.value).toMatchObject({
      batches: 10,
      filed: 100,
      stoppedBecause: "limitReached",
    });
    expect(queue.remaining()).toHaveLength(5);
    for (const request of queue.receiveRequests) {
      expect(request.QueueUrl).toBe(queueUrl);
      expect(request.MaxNumberOfMessages).toBeLessThanOrEqual(10);
      expect(request.VisibilityTimeout).toBeGreaterThan(0);
    }
  });

  test("an abort mid-batch leaves every unhandled message on the queue", async () => {
    const controller = new AbortController();
    let received = 0;
    const { queue, drain } = drainHarness({
      onReceive: () => {
        received += 1;
        controller.abort();
      },
    });
    const ids = [0, 1, 2].map((index) =>
      queue.enqueue(snsBody({ message: sesEvent(`abort-${index}`) })),
    );
    const drained = await drain(controller.signal);
    expect(drained.isOk() && drained.value).toMatchObject({
      stoppedBecause: "aborted",
    });
    expect(received).toBe(1);
    // The first delivery filed and its acknowledgement outlives the abort;
    // the unhandled rest stay on the queue.
    expect(queue.remaining().map(({ id }) => id)).toEqual(ids.slice(1));
  });

  test("a failed delete is redelivered and acknowledged once it converges", async () => {
    let persisted = 0;
    const { queue, drain } = drainHarness({
      persist: async () => {
        persisted += 1;
        return Result.ok({
          status: persisted === 1 ? "filed" : "duplicate",
          correspondenceId: "correspondence-1",
        });
      },
    });
    queue.enqueue(snsBody({ message: sesEvent("redelivered") }));
    queue.failDeletes(1);
    const first = await drain();
    expect(first.isOk() && first.value).toMatchObject({
      filed: 1,
      deleteFailed: 1,
    });
    expect(queue.remaining()).toHaveLength(1);
    queue.expireLeases();
    const second = await drain();
    expect(second.isOk() && second.value).toMatchObject({
      duplicate: 1,
      deleteFailed: 0,
    });
    expect(queue.remaining()).toHaveLength(0);
  });
});
