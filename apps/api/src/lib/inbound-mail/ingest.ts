import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type {
  CorrespondenceAuthResult,
  CorrespondenceDropReason,
  ParsedCorrespondence,
} from "@stll/api-contract/correspondence";

import type { AttachmentScanVerdict } from "@/api/lib/inbound-mail/acceptance";
import { parseInboundAddressToken } from "@/api/lib/inbound-mail/address";
import {
  hasAlignedAuthentication,
  type MailAuthentication,
  type MailAuthResult,
  type MailEnvelope,
  type MailVerifier,
} from "@/api/lib/inbound-mail/authentication";
import { INBOUND_MAIL_LIMITS } from "@/api/lib/inbound-mail/limits";
import {
  InboundMessageError,
  parseInboundMessage,
  type InboundAttachment,
  type InboundMessageErrorReason,
} from "@/api/lib/inbound-mail/message";

const AUTH_PROJECTION = {
  pass: "pass",
  fail: "fail",
  none: "none",
  neutral: "fail",
  softfail: "fail",
  temperror: "unknown",
  permerror: "fail",
} as const satisfies Record<MailAuthResult, CorrespondenceAuthResult>;
const PARSE_DROP_REASON = {
  invalidMime: "malformed_message",
  invalidFrom: "malformed_message",
  rawTooLarge: "message_too_large",
  headersTooLarge: "message_too_large",
  bodyTooLarge: "message_too_large",
  tooManyRecipients: "message_too_large",
  tooManyAttachments: "attachment_rejected",
  attachmentTooLarge: "attachment_rejected",
  unsafeAttachment: "attachment_rejected",
} as const satisfies Record<
  InboundMessageErrorReason,
  CorrespondenceDropReason
>;

const deliveryMetadataSchema = v.strictObject({
  receivedAt: v.pipe(v.string(), v.isoTimestamp()),
  envelope: v.strictObject({
    mailFrom: v.pipe(v.string(), v.maxLength(1024)),
    recipients: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(1024))),
      v.minLength(1),
      v.maxLength(INBOUND_MAIL_LIMITS.recipients),
    ),
    remoteIp: v.pipe(v.string(), v.maxLength(64)),
    helo: v.pipe(v.string(), v.maxLength(253)),
  }),
});

export class InboundIngestError extends TaggedError("InboundIngestError")<{
  message: string;
  reason:
    | "invalid-envelope"
    | "verification-unavailable"
    | "scan-unavailable"
    | "persistence-unavailable";
}> {}

type ClassifiedDelivery =
  | { status: "drop"; sender: string | null; reason: CorrespondenceDropReason }
  | {
      status: "candidate";
      sender: string;
      message: ParsedCorrespondence;
      attachments: InboundAttachment[];
      authentication: MailAuthentication;
    };

export type PersistInboundDeliveryOptions = {
  token: string;
  deliveryKey: string;
  receivedAt: string;
  delivery: ClassifiedDelivery;
};

export type InboundDeliveryOutcome =
  | { status: "filed" | "duplicate"; correspondenceId: string }
  | { status: "dropped"; reason: CorrespondenceDropReason };

// The store owns the transaction: it resolves the token, locks the decisive
// address/member/approval rows, and rechecks current authority before filing.
export type InboundDeliveryStore = (
  options: PersistInboundDeliveryOptions,
) => Promise<InboundDeliveryOutcome>;

type IngestInboundMailOptions = {
  raw: Uint8Array;
  envelope: MailEnvelope;
  receivedAt: string;
  inboundDomain: string;
  verify: MailVerifier;
  scan: AttachmentScanVerdict;
  persist: InboundDeliveryStore;
};

const projectAuthentication = (auth: MailAuthentication) => {
  const dkim =
    auth.dkim.find(({ result }) => result === "pass") ?? auth.dkim.at(0);
  return {
    spf: AUTH_PROJECTION[auth.spf.result],
    dkim: dkim ? AUTH_PROJECTION[dkim.result] : "none",
    dmarc: AUTH_PROJECTION[auth.dmarc],
    alignedIdentifier: auth.fromDomain,
  } satisfies ParsedCorrespondence["authentication"];
};

export const ingestInboundMail = async ({
  raw,
  envelope,
  receivedAt,
  inboundDomain,
  verify,
  scan,
  persist,
}: IngestInboundMailOptions) => {
  const metadata = v.safeParse(deliveryMetadataSchema, {
    envelope,
    receivedAt,
  });
  if (!metadata.success) {
    return Result.err(
      new InboundIngestError({
        message: "Invalid inbound envelope",
        reason: "invalid-envelope",
      }),
    );
  }
  const tokens = new Set<string>();
  for (const recipient of envelope.recipients) {
    const token = parseInboundAddressToken(recipient, inboundDomain);
    if (token.isOk()) {
      tokens.add(token.value);
    }
  }
  if (tokens.size === 0) {
    return Result.ok([
      { status: "dropped", reason: "unknown_recipient" },
    ] satisfies InboundDeliveryOutcome[]);
  }

  const parsed = await Result.tryPromise({
    try: () => parseInboundMessage(raw),
    catch: (cause) =>
      InboundMessageError.is(cause)
        ? cause
        : new InboundMessageError({
            message: "Malformed inbound message",
            reason: "invalidMime",
          }),
  });
  let delivery: ClassifiedDelivery;
  if (parsed.isErr()) {
    delivery = {
      status: "drop",
      sender: null,
      reason: PARSE_DROP_REASON[parsed.error.reason],
    };
  } else if (!parsed.value.outerSender || !parsed.value.message.from) {
    delivery = {
      status: "drop",
      sender: parsed.value.outerSender,
      reason: "malformed_message",
    };
  } else {
    const { outerSender, message } = parsed.value;
    const authenticated = await verify({
      raw,
      envelope,
      fromAddress: outerSender,
    });
    if (authenticated.isErr()) {
      return Result.err(
        new InboundIngestError({
          message: "Inbound verification is unavailable",
          reason: "verification-unavailable",
        }),
      );
    }
    const aligned = hasAlignedAuthentication(authenticated.value, outerSender);
    if (
      !aligned &&
      (authenticated.value.dmarc === "temperror" ||
        authenticated.value.spf.result === "temperror" ||
        authenticated.value.dkim.some(({ result }) => result === "temperror"))
    ) {
      return Result.err(
        new InboundIngestError({
          message: "Inbound verification is unavailable",
          reason: "verification-unavailable",
        }),
      );
    }
    if (!aligned) {
      delivery = {
        status: "drop",
        sender: outerSender,
        reason: "authentication_failed",
      };
    } else if (scan === "unavailable") {
      return Result.err(
        new InboundIngestError({
          message: "Inbound scanning is unavailable",
          reason: "scan-unavailable",
        }),
      );
    } else if (scan !== "pass") {
      delivery = {
        status: "drop",
        sender: outerSender,
        reason: "attachment_rejected",
      };
    } else {
      delivery = {
        status: "candidate",
        sender: outerSender,
        attachments: message.attachments,
        authentication: authenticated.value,
        message: {
          channel: "email",
          direction: message.from === outerSender ? "out" : "in",
          from: { address: message.from, name: null },
          to: message.to.map((address) => ({ address, name: null })),
          cc: message.cc.map((address) => ({ address, name: null })),
          subject: message.subject ?? "",
          sentAt: message.date,
          receivedAt,
          messageId: message.messageId,
          contentHash: message.contentHash,
          inReplyTo: message.inReplyTo,
          references: message.references,
          bodyText: message.text,
          bodyHtml: message.html,
          authentication: projectAuthentication(authenticated.value),
        },
      };
    }
  }
  const deliveryKey = new Bun.CryptoHasher("sha256")
    .update(String(raw.byteLength))
    .update(raw.subarray(0, INBOUND_MAIL_LIMITS.rawBytes))
    .digest("hex");
  const outcomes: InboundDeliveryOutcome[] = [];
  for (const token of tokens) {
    const persisted = await Result.tryPromise({
      try: () => persist({ token, receivedAt, deliveryKey, delivery }),
      catch: () =>
        new InboundIngestError({
          message: "Inbound filing could not complete",
          reason: "persistence-unavailable",
        }),
    });
    if (persisted.isErr()) {
      return persisted;
    }
    outcomes.push(persisted.value);
  }
  return Result.ok(outcomes);
};
