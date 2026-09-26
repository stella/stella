import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { AttachmentScanVerdict } from "@/api/lib/inbound-mail/acceptance";
import {
  MailAuthenticationError,
  mailboxDomain,
  type MailAuthentication,
  type MailAuthResult,
  type MailVerifier,
} from "@/api/lib/inbound-mail/authentication";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/inbound-mail/limits";
import { withTimeout } from "@/api/lib/with-timeout";

const SES_STATUS = ["PASS", "FAIL", "GRAY", "PROCESSING_FAILED"] as const;
const verdict = v.object({ status: v.picklist(SES_STATUS) });
const boundedString = v.pipe(v.string(), v.maxLength(1024));
// SES owns this extensible envelope. Strip fields we do not store, especially
// subjects, header snapshots, and provider-added diagnostic text.
const sesDeliverySchema = v.object({
  notificationType: v.literal("Received"),
  mail: v.object({
    messageId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9-]{1,256}$/u)),
    source: boundedString,
    timestamp: v.pipe(v.string(), v.isoTimestamp()),
  }),
  receipt: v.object({
    recipients: v.pipe(
      v.array(boundedString),
      v.minLength(1),
      v.maxLength(INBOUND_MAIL_LIMITS.recipients),
    ),
    action: v.object({
      type: v.literal("S3"),
      bucketName: boundedString,
      objectKey: boundedString,
    }),
    spfVerdict: verdict,
    dkimVerdict: verdict,
    dmarcVerdict: verdict,
    virusVerdict: verdict,
  }),
});

type SesStatus = (typeof SES_STATUS)[number];
const AUTH_RESULT = {
  PASS: "pass",
  FAIL: "fail",
  GRAY: "none",
  PROCESSING_FAILED: "temperror",
} as const satisfies Record<SesStatus, MailAuthResult>;
const SCAN_RESULT = {
  PASS: "pass",
  FAIL: "fail",
  GRAY: "unavailable",
  PROCESSING_FAILED: "unavailable",
} as const satisfies Record<SesStatus, AttachmentScanVerdict>;

export class SesInboundError extends TaggedError("SesInboundError")<{
  message: string;
  reason:
    | "invalid-event"
    | "untrusted-object"
    | "message-too-large"
    | "object-unavailable";
}> {}

type ReadSesObjectOptions = { key: string; signal: AbortSignal };
type SesObjectReader = (options: ReadSesObjectOptions) => Promise<Uint8Array>;

type CreateSesReaderOptions = { client: S3Client; bucket: string };
export const createSesS3ObjectReader =
  ({ client, bucket }: CreateSesReaderOptions): SesObjectReader =>
  async ({ key, signal }) => {
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: signal },
    );
    if (!object.Body) {
      throw new SesInboundError({
        message: "Inbound object is unavailable",
        reason: "object-unavailable",
      });
    }
    const reader = object.Body.transformToWebStream().getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (
      object.ContentLength !== undefined &&
      object.ContentLength > INBOUND_MAIL_LIMITS.rawBytes
    ) {
      await reader.cancel();
      throw new SesInboundError({
        message: "Inbound message exceeds size limit",
        reason: "message-too-large",
      });
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {break;}
      length += chunk.value.byteLength;
      if (length > INBOUND_MAIL_LIMITS.rawBytes) {
        await reader.cancel();
        throw new SesInboundError({
          message: "Inbound message exceeds size limit",
          reason: "message-too-large",
        });
      }
      chunks.push(chunk.value);
    }
    const raw = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return raw;
  };

type ReadSesDeliveryOptions = {
  event: unknown;
  bucket: string;
  keyPrefix: string;
  readObject: SesObjectReader;
};

// Call only after authenticating the queue/SNS transport and constraining its
// publisher. JSON structure and a bucket name cannot authenticate an event.
export const readSesInboundDelivery = async ({
  event,
  bucket,
  keyPrefix,
  readObject,
}: ReadSesDeliveryOptions) => {
  const parsed = v.safeParse(sesDeliverySchema, event);
  if (!parsed.success) {
    return Result.err(
      new SesInboundError({
        message: "Invalid inbound provider event",
        reason: "invalid-event",
      }),
    );
  }
  const { mail, receipt } = parsed.output;
  if (
    receipt.action.bucketName !== bucket ||
    receipt.action.objectKey !== `${keyPrefix}${mail.messageId}`
  ) {
    return Result.err(
      new SesInboundError({
        message: "Inbound object is outside configured source",
        reason: "untrusted-object",
      }),
    );
  }
  const object = await Result.tryPromise({
    try: () =>
      withTimeout(
        async (signal) =>
          await readObject({ key: receipt.action.objectKey, signal }),
        {
          label: "inbound-object-read",
          timeoutMs: INBOUND_MAIL_LIMITS.providerTimeoutMs,
        },
      ),
    catch: (error) =>
      SesInboundError.is(error)
        ? error
        : new SesInboundError({
            message: "Inbound object could not be read",
            reason: "object-unavailable",
          }),
  });
  if (object.isErr()) {return object;}
  if (object.value.byteLength > INBOUND_MAIL_LIMITS.rawBytes) {
    return Result.err(
      new SesInboundError({
        message: "Inbound message exceeds size limit",
        reason: "message-too-large",
      }),
    );
  }
  const verify: MailVerifier = async ({ fromAddress }) => {
    const fromDomain = mailboxDomain(fromAddress);
    if (!fromDomain)
      {return Result.err(
        new MailAuthenticationError({ message: "Invalid author domain" }),
      );}
    return Result.ok({
      source: "provider",
      evidence: "provider-dmarc",
      fromDomain,
      spf: {
        result: AUTH_RESULT[receipt.spfVerdict.status],
        domain: null,
        alignment: "relaxed",
      },
      dkim: [
        {
          result: AUTH_RESULT[receipt.dkimVerdict.status],
          domain: null,
          alignment: "relaxed",
        },
      ],
      dmarc: AUTH_RESULT[receipt.dmarcVerdict.status],
    } satisfies MailAuthentication);
  };
  return Result.ok({
    raw: object.value,
    receivedAt: mail.timestamp,
    deliveryId: mail.messageId,
    envelope: {
      mailFrom: mail.source,
      recipients: receipt.recipients,
      remoteIp: "",
      helo: "",
    },
    scan: SCAN_RESULT[receipt.virusVerdict.status],
    verify,
  });
};
