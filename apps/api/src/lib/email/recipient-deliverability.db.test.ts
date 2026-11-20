import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { asc, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { emailDeliveryFailures } from "@/api/db/schema";
import { drainDeliverabilityEvents } from "@/api/lib/email/deliverability";
import { normalizeEmail } from "@/api/lib/email/normalized-email";
import {
  EMAIL_DELIVERY_FAILURE_RETENTION_DAYS,
  pruneRecipientFailures,
  recordRecipientFailures,
} from "@/api/lib/email/recipient-deliverability";
import { logger } from "@/api/lib/observability/logger";
import { createFakeSqsQueue } from "@/api/tests/helpers/fake-sqs";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { STARTTLS_REFUSAL_BOUNCE } from "@/api/tests/helpers/ses-bounce-fixtures";

beforeAll(async () => {
  await initAgentAuthTestDb();
});

beforeEach(async () => {
  await rootDb.delete(emailDeliveryFailures).where(sql`true`);
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const stored = async () =>
  await rootDb
    .select()
    .from(emailDeliveryFailures)
    .orderBy(asc(emailDeliveryFailures.address));

const member = normalizeEmail("member@example.test");
const other = normalizeEmail("other@example.test");
const earlier = new Date("2026-11-20T08:00:00.000Z");
const later = new Date("2026-11-20T09:00:00.000Z");

describe("recipient delivery failures", () => {
  test("a later failure replaces the stored one and an older one changes nothing", async () => {
    expect(
      await recordRecipientFailures(
        [
          { email: member, reason: "tls_required" },
          { email: other, reason: "mailbox_missing" },
        ],
        earlier,
      ),
    ).toBe(2);
    expect(
      await recordRecipientFailures(
        [{ email: member, reason: "mailbox_unavailable" }],
        later,
      ),
    ).toBe(1);
    // A late or redelivered event for the earlier send.
    expect(
      await recordRecipientFailures(
        [{ email: member, reason: "tls_required" }],
        earlier,
      ),
    ).toBe(0);
    expect(await recordRecipientFailures([], later)).toBe(0);

    expect(await stored()).toEqual([
      { address: member, reason: "mailbox_unavailable", failedAt: later },
      { address: other, reason: "mailbox_missing", failedAt: earlier },
    ]);
  });

  test("prunes only failures past retention", async () => {
    // Ages are relative to the database clock the prune reads.
    const daysAgo = (days: number) =>
      sql`now() - make_interval(days => ${days})`;
    await rootDb.insert(emailDeliveryFailures).values([
      {
        address: member,
        reason: "tls_required",
        failedAt: daysAgo(EMAIL_DELIVERY_FAILURE_RETENTION_DAYS + 1),
      },
      {
        address: other,
        reason: "tls_required",
        failedAt: daysAgo(EMAIL_DELIVERY_FAILURE_RETENTION_DAYS - 1),
      },
    ]);

    expect(await pruneRecipientFailures()).toBe(1);
    expect((await stored()).map(({ address }) => address)).toEqual([other]);
  });

  test("the drain records a recipient server without STARTTLS as needing TLS and marks no account", async () => {
    const queue = createFakeSqsQueue();
    const topicArn = "arn:aws:sns:eu-west-1:123456789012:ses-notifications";
    queue.enqueue(
      JSON.stringify({
        Type: "Notification",
        MessageId: "sns-message",
        TopicArn: topicArn,
        Message: JSON.stringify(STARTTLS_REFUSAL_BOUNCE),
      }),
    );
    const marked: string[] = [];

    const drained = await drainDeliverabilityEvents({
      client: queue.client,
      queueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/ses-events",
      topicArn,
      signal: new AbortController().signal,
      logger,
      markUndeliverable: async (emails) => {
        marked.push(...emails);
        return emails.length;
      },
      recordFailures: recordRecipientFailures,
    });

    expect(drained.isOk() && drained.value).toMatchObject({
      failuresRecorded: 1,
      marked: 0,
      stoppedBecause: "drained",
    });
    expect(marked).toEqual([]);
    expect(queue.remaining()).toEqual([]);
    expect(await stored()).toEqual([
      {
        address: normalizeEmail("new.member@example.test"),
        reason: "tls_required",
        failedAt: new Date(STARTTLS_REFUSAL_BOUNCE.bounce.timestamp),
      },
    ]);
  });
});
