import * as v from "valibot";

/**
 * Outbound actions act as the user outside stella (for example sending an
 * email from their mailbox). The assistant can only prepare one: it is stored
 * as a pending preview, and only the signed-in user's click on that exact
 * preview executes it. No tool, approval grant or background run can.
 */
export const OUTBOUND_ACTION_KINDS = ["email.send"] as const;
export type OutboundActionKind = (typeof OUTBOUND_ACTION_KINDS)[number];

/**
 * Lifecycle of an outbound action. `sending` is entered before the provider
 * call and never retried automatically, so an interrupted send stays visible
 * instead of risking a second delivery.
 */
export const OUTBOUND_ACTION_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "discarded",
  "expired",
] as const;
export type OutboundActionStatus = (typeof OUTBOUND_ACTION_STATUSES)[number];

/** How long a prepared preview stays confirmable. */
export const OUTBOUND_ACTION_TTL_MS = 30 * 60 * 1000;

export const OUTBOUND_EMAIL_MAX_RECIPIENTS = 50;
export const OUTBOUND_EMAIL_SUBJECT_MAX_LENGTH = 998;
export const OUTBOUND_EMAIL_BODY_MAX_LENGTH = 200_000;
export const OUTBOUND_EMAIL_MAX_ATTACHMENTS = 20;

const emailAddressSchema = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(320),
  v.email(),
);

export const outboundEmailRecipientSchema = v.strictObject({
  address: emailAddressSchema,
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
});

export const outboundEmailAttachmentSchema = v.strictObject({
  fileName: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  byteLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});

/** Everything the user sees on the preview card, and nothing else. */
export const outboundEmailPreviewSchema = v.pipe(
  v.strictObject({
    kind: v.literal("email.send"),
    from: outboundEmailRecipientSchema,
    to: v.pipe(v.array(outboundEmailRecipientSchema), v.minLength(1)),
    cc: v.array(outboundEmailRecipientSchema),
    bcc: v.array(outboundEmailRecipientSchema),
    subject: v.pipe(v.string(), v.maxLength(OUTBOUND_EMAIL_SUBJECT_MAX_LENGTH)),
    bodyText: v.pipe(v.string(), v.maxLength(OUTBOUND_EMAIL_BODY_MAX_LENGTH)),
    attachments: v.pipe(
      v.array(outboundEmailAttachmentSchema),
      v.maxLength(OUTBOUND_EMAIL_MAX_ATTACHMENTS),
    ),
    /** Provider message id this email replies to, when it is a reply. */
    inReplyTo: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(998))),
  }),
  v.check(
    (preview) =>
      preview.to.length + preview.cc.length + preview.bcc.length <=
      OUTBOUND_EMAIL_MAX_RECIPIENTS,
    `An email can have at most ${OUTBOUND_EMAIL_MAX_RECIPIENTS} recipients`,
  ),
);
export type OutboundEmailPreview = v.InferOutput<
  typeof outboundEmailPreviewSchema
>;

export const outboundActionPreviewSchema = v.variant("kind", [
  outboundEmailPreviewSchema,
]);
export type OutboundActionPreview = v.InferOutput<
  typeof outboundActionPreviewSchema
>;

/** SHA-256 hex of the canonical preview; a confirm must echo it. */
export const OUTBOUND_PREVIEW_HASH_PATTERN = "^[0-9a-f]{64}$";
