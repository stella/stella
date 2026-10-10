import { S3Client } from "@aws-sdk/client-s3";
import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { CORRESPONDENCE_DROP_REASONS } from "@stll/api-contract/correspondence";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceDropLogs,
  matterInboundAddresses,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { generateInboundAddressToken } from "@/api/lib/email/inbound/address";
import { createInboundMailPersistence } from "@/api/lib/email/inbound/persistence";
import {
  createSesS3ObjectReader,
  createSesS3ObjectDeleter,
  receiveAndDeleteSesInboundMail,
  SesInboundError,
} from "@/api/lib/email/inbound/ses";
import { drainInboundMailQueue } from "@/api/lib/email/inbound/sqs";
import { logger } from "@/api/lib/observability/logger";
import {
  openGatedTestDatabase,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3, type FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createFakeSqsQueue } from "@/api/tests/helpers/fake-sqs";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const topicArn = "arn:aws:sns:eu-west-1:123456789012:inbound-mail";
const queueUrl = "https://sqs.eu-west-1.amazonaws.com/123456789012/inbound";
const bucket = "inbound-bucket";
const keyPrefix = "mail/";
const inboundDomain = "inbound.example.test";
const organizationId = mintAuthProviderId<"organization">();
const memberId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const token = generateInboundAddressToken();

const message = (from: string, messageId: string) =>
  new TextEncoder().encode(
    `From: ${from}\r\nTo: Counsel <counsel@outside.test>\r\nSubject: Status update\r\nDate: Sat, 26 Sep 2026 12:00:00 +0000\r\nMessage-ID: <${messageId}@example.test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nThe signed document is ready.\r\n`,
  );

type SesStatus = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
type NotificationOptions = {
  deliveryId: string;
  from?: string;
  authentication?: SesStatus;
};

const notification = ({
  deliveryId,
  from = "member@example.test",
  authentication = "PASS",
}: NotificationOptions) =>
  JSON.stringify({
    Type: "Notification",
    MessageId: `sns-${deliveryId}`,
    TopicArn: topicArn,
    Message: JSON.stringify({
      notificationType: "Received",
      mail: {
        messageId: deliveryId,
        source: from,
        timestamp: "2026-09-26T12:00:00.000Z",
        commonHeaders: { from: [`Sender <${from}>`] },
      },
      receipt: {
        recipients: [`${token}@${inboundDomain}`],
        action: {
          type: "S3",
          bucketName: bucket,
          objectKey: `${keyPrefix}${deliveryId}`,
        },
        spfVerdict: { status: authentication },
        dkimVerdict: { status: authentication },
        dmarcVerdict: { status: authentication },
        virusVerdict: { status: "PASS" },
      },
    }),
  });

let db: GatedTestDb;
let s3: FakeS3;

const records = async () =>
  await db
    .select()
    .from(correspondence)
    .where(eq(correspondence.organizationId, organizationId));
const drops = async () =>
  await db
    .select()
    .from(correspondenceDropLogs)
    .where(eq(correspondenceDropLogs.organizationId, organizationId));

const drainHarness = () => {
  const queue = createFakeSqsQueue();
  const objectClient = new S3Client({
    region: "eu-west-1",
    endpoint: s3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIDFAKES3", secretAccessKey: "fake-s3" },
    maxAttempts: 1,
  });
  const objects = createSesS3ObjectReader({ client: objectClient, bucket });
  const deleteObject = createSesS3ObjectDeleter({
    client: objectClient,
    bucket,
  });
  const persist = createInboundMailPersistence({
    database: db,
    scopedDbForMatter: (scope) =>
      createScopedDb(
        markRlsDatabase(db),
        [scope.workspaceId],
        scope.organizationId,
        scope.userId,
      ),
  });
  const drain = async () =>
    await drainInboundMailQueue({
      client: queue.client,
      queueUrl,
      topicArn,
      signal: new AbortController().signal,
      logger,
      receive: async (event) =>
        await receiveAndDeleteSesInboundMail({
          event,
          bucket,
          keyPrefix,
          inboundDomain,
          // The bounded reader's size cut-off is covered in ses.test.ts; a
          // 25 MiB object is not worth streaming through the fake store here.
          readObject: async (options) =>
            options.key.endsWith("oversized")
              ? Result.err(
                  new SesInboundError({
                    message: "Inbound message exceeds size limit",
                    reason: "message-too-large",
                  }),
                )
              : await objects(options),
          persist,
          deleteObject,
        }),
    });
  return { queue, drain };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("inbound mail queue drain against the database", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("inbound mail queue drain against the database", () => {
    const gated = openGatedTestDatabase(databaseUrl);
    db = gated.db;
    gated.cleanUp(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, memberId));
    });

    beforeAll(async () => {
      s3 = startFakeS3();
      await db.insert(user).values({
        id: memberId,
        name: "Member",
        email: "member@example.test",
        emailVerified: true,
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Inbound queue",
        slug: `inbound-queue-${organizationId}`,
        createdAt: new Date(),
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId: memberId,
        role: "member",
        createdAt: new Date(),
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Matter",
        reference: "QUEUE-1",
      });
      await db.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId,
        userId: memberId,
      });
      await db.insert(matterInboundAddresses).values({
        id: createSafeId<"matterInboundAddress">(),
        organizationId,
        workspaceId,
        token,
      });
    }, 60_000);

    afterAll(() => {
      s3.stop();
    });

    beforeEach(async () => {
      await db
        .delete(correspondenceDropLogs)
        .where(eq(correspondenceDropLogs.organizationId, organizationId));
      await db
        .delete(correspondence)
        .where(eq(correspondence.organizationId, organizationId));
    });

    test("filed, duplicate and dropped deliveries are acknowledged once durable", async () => {
      const { queue, drain } = drainHarness();
      s3.put(
        bucket,
        `${keyPrefix}filed`,
        message("Member <member@example.test>", "filed"),
      );
      s3.put(
        bucket,
        `${keyPrefix}outsider`,
        message("Outsider <outsider@outside.test>", "outsider"),
      );
      // SNS delivers at least once: the same notification can arrive twice.
      queue.enqueue(notification({ deliveryId: "filed" }));
      queue.enqueue(notification({ deliveryId: "filed" }));
      queue.enqueue(
        notification({ deliveryId: "outsider", from: "outsider@outside.test" }),
      );
      queue.enqueue(notification({ deliveryId: "oversized" }));

      const drained = await drain();
      expect(drained.isOk() && drained.value).toMatchObject({
        filed: 1,
        alreadyCompleted: 1,
        dropped: 2,
        retry: 0,
        poison: 0,
        stoppedBecause: "drained",
      });
      expect(queue.remaining()).toEqual([]);
      expect(s3.objects.has(`${bucket}/${keyPrefix}filed`)).toBe(false);
      expect(s3.objects.has(`${bucket}/${keyPrefix}outsider`)).toBe(false);
      expect(await records()).toMatchObject([
        { workspaceId, authenticatedSenderAddress: "member@example.test" },
      ]);
      expect((await drops()).map(({ reason }) => reason).toSorted()).toEqual(
        CORRESPONDENCE_DROP_REASONS.filter(
          (reason) =>
            reason === "message_too_large" || reason === "unauthorized_sender",
        ).toSorted(),
      );
    });

    test("retryable failures stay on the queue without a record or drop", async () => {
      const { queue, drain } = drainHarness();
      s3.put(
        bucket,
        `${keyPrefix}dns-unavailable`,
        message("Member <member@example.test>", "dns-unavailable"),
      );
      s3.put(
        bucket,
        `${keyPrefix}temporarily-unreadable`,
        message("Member <member@example.test>", "temporarily-unreadable"),
      );
      s3.failNext({
        method: "GET",
        key: `${keyPrefix}temporarily-unreadable`,
        code: "AccessDenied",
        status: 403,
      });
      queue.enqueue(notification({ deliveryId: "temporarily-unreadable" }));
      queue.enqueue(
        notification({
          deliveryId: "dns-unavailable",
          authentication: "PROCESSING_FAILED",
        }),
      );

      const drained = await drain();
      expect(drained.isOk() && drained.value).toMatchObject({
        retry: 2,
        filed: 0,
        dropped: 0,
      });
      expect(queue.remaining()).toHaveLength(2);
      expect(s3.objects.has(`${bucket}/${keyPrefix}dns-unavailable`)).toBe(
        true,
      );
      expect(await records()).toHaveLength(0);
      expect(await drops()).toHaveLength(0);

      // Once object access recovers, the redelivered notification files normally.
      s3.put(
        bucket,
        `${keyPrefix}temporarily-unreadable`,
        message("Member <member@example.test>", "temporarily-unreadable"),
      );
      queue.expireLeases();
      const retried = await drain();
      expect(retried.isOk() && retried.value).toMatchObject({
        filed: 1,
        retry: 1,
      });
      expect(queue.remaining()).toEqual([
        expect.objectContaining({ receiveCount: 2 }),
      ]);
      expect(await records()).toHaveLength(1);
    });

    test("a failed raw deletion preserves the queue delivery and retries without refiling", async () => {
      const { queue, drain } = drainHarness();
      s3.put(
        bucket,
        `${keyPrefix}delete-failed`,
        message("Member <member@example.test>", "delete-failed"),
      );
      queue.enqueue(notification({ deliveryId: "delete-failed" }));
      s3.failNext({
        method: "DELETE",
        key: `${keyPrefix}delete-failed`,
        code: "AccessDenied",
        status: 403,
      });
      const first = await drain();
      expect(first.isOk() && first.value).toMatchObject({ retry: 1 });
      expect(queue.remaining()).toHaveLength(1);
      expect(s3.objects.has(`${bucket}/${keyPrefix}delete-failed`)).toBe(true);
      expect(await records()).toHaveLength(1);
      queue.expireLeases();
      const second = await drain();
      expect(second.isOk() && second.value).toMatchObject({ retry: 0 });
      expect(queue.remaining()).toEqual([]);
      expect(s3.objects.has(`${bucket}/${keyPrefix}delete-failed`)).toBe(false);
      expect(await records()).toHaveLength(1);
    });

    test("a lost acknowledgement converges to one record on redelivery", async () => {
      const { queue, drain } = drainHarness();
      s3.put(
        bucket,
        `${keyPrefix}unacknowledged`,
        message("Member <member@example.test>", "unacknowledged"),
      );
      queue.enqueue(notification({ deliveryId: "unacknowledged" }));
      queue.failDeletes(1);

      const first = await drain();
      expect(first.isOk() && first.value).toMatchObject({
        filed: 1,
        deleteFailed: 1,
      });
      expect(queue.remaining()).toHaveLength(1);
      expect(s3.objects.has(`${bucket}/${keyPrefix}unacknowledged`)).toBe(
        false,
      );
      queue.expireLeases();
      const second = await drain();
      expect(second.isOk() && second.value).toMatchObject({
        alreadyCompleted: 1,
        deleteFailed: 0,
      });
      expect(queue.remaining()).toEqual([]);
      expect(await records()).toHaveLength(1);
    });
  });
}
