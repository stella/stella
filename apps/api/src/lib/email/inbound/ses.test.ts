import { S3Client } from "@aws-sdk/client-s3";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import { Readable } from "node:stream";

import { hasAlignedAuthentication } from "@/api/lib/email/inbound/authentication";
import { InboundPersistenceError } from "@/api/lib/email/inbound/ingest";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/email/inbound/limits";
import {
  createSesS3ObjectDeleter,
  createSesS3ObjectReader,
  readSesInboundDelivery,
  receiveAndDeleteSesInboundMail,
  receiveSesInboundMail,
} from "@/api/lib/email/inbound/ses";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

const event = {
  notificationType: "Received",
  mail: {
    messageId: "delivery-1",
    source: "member@example.com",
    timestamp: "2026-09-26T12:00:00.000Z",
    commonHeaders: { from: ["Member <member@example.com>"] },
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

test.each([
  "filed",
  "rejected",
  "persistence-failed",
  "delete-failed",
] as const)(
  "raw mail deletion follows the durable %s outcome",
  async (mode) => {
    const storage = startFakeS3();
    const bucket = "inbound-bucket";
    const key = "mail/delivery-1";
    const client = new S3Client({
      region: "eu-west-1",
      endpoint: storage.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    });
    storage.put(bucket, key, raw);
    if (mode === "delete-failed") {
      storage.failNext({
        method: "DELETE",
        key,
        status: 403,
        code: "AccessDenied",
      });
    }
    let persisted = 0;
    try {
      const result = await receiveAndDeleteSesInboundMail({
        event: {
          ...event,
          receipt: {
            ...event.receipt,
            recipients: [`${"a".repeat(64)}@inbound.example.com`],
          },
        },
        bucket,
        keyPrefix: "mail/",
        inboundDomain: "inbound.example.com",
        readObject: createSesS3ObjectReader({ client, bucket }),
        deleteObject: createSesS3ObjectDeleter({ client, bucket }),
        persist: async ({ delivery }) => {
          expect(delivery.status).toBe("candidate");
          // The original remains available while filing is in flight.
          expect(storage.objects.has(`${bucket}/${key}`)).toBe(true);
          persisted += 1;
          switch (mode) {
            case "persistence-failed":
              return Result.err(
                new InboundPersistenceError({
                  message: "Injected filing failure",
                }),
              );
            case "rejected":
              return Result.ok({
                status: "dropped",
                reason: "unauthorized_sender",
              });
            case "filed":
            case "delete-failed":
              return Result.ok({
                status: "filed",
                correspondenceId: "correspondence-1",
              });
            default:
              mode satisfies never;
              return Result.err(
                new InboundPersistenceError({
                  message: "Unhandled test outcome",
                }),
              );
          }
        },
      });
      expect(persisted).toBe(1);
      expect(result.isOk()).toBe(mode === "filed" || mode === "rejected");
      expect(storage.objects.has(`${bucket}/${key}`)).toBe(
        mode === "persistence-failed" || mode === "delete-failed",
      );
      if (mode === "persistence-failed") {
        expect(storage.requests.some(({ method }) => method === "DELETE")).toBe(
          false,
        );
      }
      if (mode === "delete-failed" && result.isErr()) {
        expect(result.error.reason).toBe("object-delete-failed");
      }
    } finally {
      client.destroy();
      storage.stop();
    }
  },
);

test("only a missing source object is acknowledged as already completed", async () => {
  const storage = startFakeS3();
  const client = new S3Client({
    region: "eu-west-1",
    endpoint: storage.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  try {
    let persisted = 0;
    const receive = async () =>
      await receiveAndDeleteSesInboundMail({
        event,
        bucket: "inbound-bucket",
        keyPrefix: "mail/",
        inboundDomain: "inbound.example.com",
        readObject: createSesS3ObjectReader({
          client,
          bucket: "inbound-bucket",
        }),
        deleteObject: createSesS3ObjectDeleter({
          client,
          bucket: "inbound-bucket",
        }),
        persist: async () => {
          persisted += 1;
          return Result.ok({
            status: "filed",
            correspondenceId: "correspondence-1",
          });
        },
      });
    expect((await receive()).unwrap()).toEqual([
      { status: "already_completed" },
    ]);
    storage.failNext({
      method: "GET",
      key: "mail/delivery-1",
      status: 403,
      code: "AccessDenied",
    });
    const unavailable = await receive();
    expect(unavailable.isErr() && unavailable.error.reason).toBe(
      "object-unavailable",
    );
    expect(persisted).toBe(0);
    expect(storage.requests.some(({ method }) => method === "DELETE")).toBe(
      false,
    );
  } finally {
    client.destroy();
    storage.stop();
  }
});
const read = async (input: unknown) =>
  await readSesInboundDelivery({
    event: input,
    bucket: "inbound-bucket",
    keyPrefix: "mail/",
    readObject: async () => Result.ok(raw),
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

test.each([
  ["another domain", { from: ["Other <member@attacker.test>"] }],
  ["two authors", { from: ["member@example.com", "member@attacker.test"] }],
  ["no author", { from: [] }],
  ["no headers", undefined],
])(
  "a provider DMARC pass for %s does not authenticate the parsed author",
  async (_label, commonHeaders) => {
    const delivery = await read({
      ...event,
      mail: { ...event.mail, commonHeaders },
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
    expect(auth.value.dmarc).toBe("fail");
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
        return Result.ok(raw);
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
          return Result.ok({ status: "dropped", reason: "message_too_large" });
        },
      });
      expect(result.isOk() && result.value.deliveries).toEqual([
        { status: "dropped", reason: "message_too_large" },
      ]);
      expect(result.isOk() && result.value.objectKey).toBe("mail/delivery-1");
      expect(drops).toBe(1);
      expect(emitted).toBeLessThan(40);
      expect(body.destroyed).toBe(true);
    } finally {
      client.destroy();
    }
  },
);
