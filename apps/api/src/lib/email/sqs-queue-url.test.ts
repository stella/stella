import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { resolveEmailEvents } from "./deliverability-config";
import { resolveInboundMailReceiving } from "./inbound/receiving-config";
import { sqsClientFor } from "./sns-queue-drain";
import { parseSqsQueueUrl } from "./sqs-queue-url";

const queueIn = (region: string, name: string) =>
  `https://sqs.${region}.amazonaws.com/123456789012/${name}`;

describe("parseSqsQueueUrl", () => {
  test("reads the region from each AWS partition's queue URL", () => {
    for (const [url, region] of [
      [queueIn("eu-west-1", "ses-events"), "eu-west-1"],
      [queueIn("us-east-1", "inbound-mail.fifo"), "us-east-1"],
      [queueIn("us-gov-west-1", "ses_events"), "us-gov-west-1"],
      [queueIn("ap-southeast-2", "q"), "ap-southeast-2"],
      [
        "https://sqs.cn-north-1.amazonaws.com.cn/123456789012/events",
        "cn-north-1",
      ],
    ] as const) {
      expect(parseSqsQueueUrl(url)).toEqual({ url, region });
    }
  });

  test("refuses a URL that does not name a region and a queue", () => {
    for (const url of [
      "https://sqs.example.test/queue",
      "https://queue.amazonaws.com/123456789012/events",
      "http://sqs.eu-west-1.amazonaws.com/123456789012/events",
      "https://sqs.eu-west-1.amazonaws.com/events",
      "https://sqs.eu-west-1.amazonaws.com/123456789012/events/extra",
      "https://sqs.eu-west-1.amazonaws.com.evil.test/123456789012/events",
      `${queueIn("eu-west-1", "events")}?Action=SendMessage`,
      queueIn("eu-west-1", "x".repeat(81)),
    ]) {
      expect(parseSqsQueueUrl(url)).toBeNull();
    }
  });
});

describe("queue configuration", () => {
  const topicArn = "arn:aws:sns:eu-central-1:123456789012:ses-events";

  test("email events keep the queue's region apart from the object store's", () => {
    const resolved = resolveEmailEvents({
      EMAIL_EVENTS_QUEUE_URL: queueIn("eu-central-1", "ses-events"),
      EMAIL_EVENTS_TOPIC_ARN: topicArn,
      EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL: queueIn(
        "eu-central-1",
        "ses-events-dlq",
      ),
    }).unwrap();
    expect(resolved).toEqual({
      type: "enabled",
      queue: {
        url: queueIn("eu-central-1", "ses-events"),
        region: "eu-central-1",
      },
      topicArn,
      deadLetterQueue: {
        url: queueIn("eu-central-1", "ses-events-dlq"),
        region: "eu-central-1",
      },
    });
  });

  test("email events refuse a non-SQS URL and a dead-letter queue in another region", () => {
    const refused = [
      {
        EMAIL_EVENTS_QUEUE_URL: "https://sqs.example.test/ses-events",
        EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL: queueIn("eu-west-1", "dlq"),
        reason: "must be SQS queue URLs",
      },
      {
        EMAIL_EVENTS_QUEUE_URL: queueIn("eu-west-1", "ses-events"),
        EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL: "https://sqs.example.test/dlq",
        reason: "must be SQS queue URLs",
      },
      {
        EMAIL_EVENTS_QUEUE_URL: queueIn("eu-west-1", "ses-events"),
        EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL: queueIn("us-east-1", "dlq"),
        reason: "is in us-east-1; it must be in the queue's region, eu-west-1.",
      },
    ];
    for (const { reason, ...urls } of refused) {
      const resolved = resolveEmailEvents({
        ...urls,
        EMAIL_EVENTS_TOPIC_ARN: topicArn,
      });
      expect(resolved.isErr() && resolved.error.message).toContain(reason);
    }
  });

  test("inbound mail reads its queue's region and refuses a non-SQS URL", () => {
    const transport = {
      INBOUND_MAIL_DOMAIN: "inbound.example.test",
      INBOUND_MAIL_TOPIC_ARN: topicArn,
      INBOUND_MAIL_BUCKET: "inbound-mail-bucket",
      INBOUND_MAIL_KEY_PREFIX: "mail/",
    };
    const resolved = resolveInboundMailReceiving({
      ...transport,
      INBOUND_MAIL_QUEUE_URL: queueIn("us-west-2", "inbound-mail"),
    }).unwrap();
    expect(resolved.type === "enabled" && resolved.queue).toEqual({
      url: queueIn("us-west-2", "inbound-mail"),
      region: "us-west-2",
    });
    const refused = resolveInboundMailReceiving({
      ...transport,
      INBOUND_MAIL_QUEUE_URL: "https://sqs.example.test/inbound-mail",
    });
    expect(refused.isErr() && refused.error.message).toContain(
      "must be an SQS queue URL",
    );
  });
});

describe("sqsClientFor", () => {
  test("signs for the queue's region with one client per region", async () => {
    const queue = (region: string, name: string) =>
      parseSqsQueueUrl(queueIn(region, name)) ??
      panic(`Fixture ${region}/${name} must parse as an SQS queue URL`);
    const frankfurt = queue("eu-central-1", "a");
    const frankfurtAgain = queue("eu-central-1", "b");
    const virginia = queue("us-east-1", "a");
    const client = sqsClientFor(frankfurt);
    expect(await client.config.region()).toBe("eu-central-1");
    expect(sqsClientFor(frankfurtAgain)).toBe(client);
    const other = sqsClientFor(virginia);
    expect(other).not.toBe(client);
    expect(await other.config.region()).toBe("us-east-1");
  });
});
