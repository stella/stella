import { S3Client } from "@aws-sdk/client-s3";
import { expect, test } from "bun:test";
import { Readable } from "node:stream";

import { hasAlignedAuthentication } from "@/api/lib/inbound-mail/authentication";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/inbound-mail/limits";
import {
  createSesS3ObjectReader,
  readSesInboundDelivery,
  receiveSesInboundMail,
} from "@/api/lib/inbound-mail/ses";

const event = {
  notificationType: "Received",
  mail: {
    messageId: "delivery-1",
    source: "member@example.com",
    timestamp: "2026-09-26T12:00:00.000Z",
  },
  receipt: {
    recipients: ["token@inbound.example.com"],
    action: {
      type: "S3",
      bucketName: "inbound-bucket",
      objectKey: "mail/delivery-1",
    },
    spfVerdict: { status: "PASS" },
    dkimVerdict: { status: "FAIL" },
    dmarcVerdict: { status: "PASS" },
    virusVerdict: { status: "PASS" },
  },
};
const raw = new TextEncoder().encode(
  "From: member@example.com\r\nAuthentication-Results: forged.test; dmarc=pass\r\n\r\nBody",
);
const read = async (input: unknown) =>
  await readSesInboundDelivery({
    event: input,
    bucket: "inbound-bucket",
    keyPrefix: "mail/",
    readObject: async () => raw,
  });

test("provider metadata authenticates the outer sender without inventing a signing domain", async () => {
  const delivery = await read(event);
  expect(delivery.isOk() && delivery.value.status).toBe("received");
  if (delivery.isErr() || delivery.value.status !== "received") {
    return;
  }
  expect(delivery.value.envelope.recipients).toEqual(event.receipt.recipients);
  const auth = await delivery.value.verify({
    raw,
    envelope: delivery.value.envelope,
    fromAddress: "member@example.com",
  });
  expect(auth.isOk()).toBe(true);
  if (auth.isErr()) {
    return;
  }
  expect(auth.value.spf.domain).toBeNull();
  expect(hasAlignedAuthentication(auth.value, "member@example.com")).toBe(true);
});

test.each(["FAIL", "GRAY", "PROCESSING_FAILED"])(
  "sender headers cannot override provider DMARC %s",
  async (status) => {
    const delivery = await read({
      ...event,
      receipt: { ...event.receipt, dmarcVerdict: { status } },
    });
    expect(delivery.isOk() && delivery.value.status).toBe("received");
    if (delivery.isErr() || delivery.value.status !== "received") {
      return;
    }
    const auth = await delivery.value.verify({
      raw,
      envelope: delivery.value.envelope,
      fromAddress: "member@example.com",
    });
    expect(auth.isOk()).toBe(true);
    if (auth.isErr()) {
      return;
    }
    expect(hasAlignedAuthentication(auth.value, "member@example.com")).toBe(
      false,
    );
  },
);

test("rejects bucket or object substitution before object storage access", async () => {
  for (const action of [
    { type: "S3", bucketName: "other-tenant", objectKey: "mail/delivery-1" },
    {
      type: "S3",
      bucketName: "inbound-bucket",
      objectKey: "mail/other-message",
    },
    { type: "S3", bucketName: "inbound-bucket", objectKey: "mail/../private" },
  ]) {
    let reads = 0;
    const result = await readSesInboundDelivery({
      event: { ...event, receipt: { ...event.receipt, action } },
      bucket: "inbound-bucket",
      keyPrefix: "mail/",
      readObject: async () => {
        reads += 1;
        return raw;
      },
    });
    expect(result.isErr()).toBe(true);
    expect(reads).toBe(0);
  }
});

test("an unknown virus verdict fails closed at the provider boundary", async () => {
  expect(
    (
      await read({
        ...event,
        receipt: { ...event.receipt, virusVerdict: { status: "NEW_STATUS" } },
      })
    ).isErr(),
  ).toBe(true);
  const delivery = await read({
    ...event,
    receipt: { ...event.receipt, virusVerdict: { status: "GRAY" } },
  });
  expect(delivery.isOk() && delivery.value.status).toBe("received");
  if (delivery.isOk() && delivery.value.status === "received") {
    expect(delivery.value.scan).toBe("unavailable");
  }
});

test.each(["declared", "streamed"] as const)(
  "the receiver cancels %s oversized S3 objects and persists a terminal drop",
  async (mode) => {
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = Readable.from(
      (function* () {
        for (let index = 0; index < 40; index += 1) {
          emitted += 1;
          yield chunk;
        }
      })(),
      { objectMode: false, highWaterMark: chunk.byteLength },
    );
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      requestHandler: {
        handle: async () => ({
          response: {
            statusCode: 200,
            headers:
              mode === "declared"
                ? { "content-length": String(INBOUND_MAIL_LIMITS.rawBytes + 1) }
                : {},
            body,
          },
        }),
      },
    });
    try {
      let drops = 0;
      const result = await receiveSesInboundMail({
        event: {
          ...event,
          receipt: {
            ...event.receipt,
            recipients: [`${"a".repeat(64)}@inbound.example.com`],
          },
        },
        inboundDomain: "inbound.example.com",
        bucket: "inbound-bucket",
        keyPrefix: "mail/",
        readObject: createSesS3ObjectReader({
          client,
          bucket: "inbound-bucket",
        }),
        persist: async ({ delivery }) => {
          expect(delivery).toEqual({
            status: "drop",
            reason: "message_too_large",
            sender: null,
          });
          drops += 1;
          return { status: "dropped", reason: "message_too_large" };
        },
      });
      expect(result.isOk() && result.value).toEqual([
        { status: "dropped", reason: "message_too_large" },
      ]);
      expect(drops).toBe(1);
      expect(emitted).toBeLessThan(40);
      expect(body.destroyed).toBe(true);
    } finally {
      client.destroy();
    }
  },
);
