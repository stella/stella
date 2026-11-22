/**
 * Certified email: an email whose providers certify its sending and delivery
 * and attach the certification data to every message they generate. Italian
 * PEC (posta elettronica certificata, DPR 68/2005) states it in an XML part
 * whose root is `postacert` (the AgID technical rules of DM 2 November 2005,
 * annex section 7.4); the transport envelope carries the original message as
 * a `message/rfc822` part (section 6.3.4).
 */

import * as v from "valibot";

import { apiDateTimeSchema } from "./api-date";
import { filePartDescriptorSchema } from "./file-parts";

export const CERTIFIED_EMAIL_SYSTEMS = ["pec"] as const;

/**
 * What the provider's message is: the transport envelope that carries the
 * original message, or a receipt or notice about it (`postacert` `tipo`).
 */
export const CERTIFIED_EMAIL_KINDS = [
  "transport",
  "acceptance",
  "non_acceptance",
  "taken_in_charge",
  "delivery",
  "delivery_error",
  "delivery_error_warning",
  "virus_detected",
] as const;
export type CertifiedEmailKind = (typeof CERTIFIED_EMAIL_KINDS)[number];

/** The error the provider states (`postacert` `errore`). */
export const CERTIFIED_EMAIL_ERRORS = [
  "none",
  "no_recipient",
  "no_domain",
  "virus",
  "other",
] as const;
export type CertifiedEmailError = (typeof CERTIFIED_EMAIL_ERRORS)[number];

/** The delivery receipt the sender asked for (`ricevuta` `tipo`). */
export const CERTIFIED_EMAIL_RECEIPT_TYPES = [
  "full",
  "short",
  "summary",
] as const;
export type CertifiedEmailReceiptType =
  (typeof CERTIFIED_EMAIL_RECEIPT_TYPES)[number];

const nullableText = v.nullable(v.string());

/** The provider's S/MIME signature as found; it is never verified. */
const certifiedEmailSignatureSchema = v.object({
  status: v.literal("unverified"),
  signerName: nullableText,
  issuerName: nullableText,
  serialNumber: nullableText,
  signedAt: v.nullable(apiDateTimeSchema),
});
export type CertifiedEmailSignature = v.InferOutput<
  typeof certifiedEmailSignatureSchema
>;

const certifiedEmailRecipientSchema = v.object({
  address: v.string(),
  /** A certified mailbox, or an ordinary one outside the system. */
  certified: v.boolean(),
});

/** The certification data exactly as the provider's message states it. */
export const certifiedEmailEnvelopeSchema = v.object({
  system: v.picklist(CERTIFIED_EMAIL_SYSTEMS),
  kind: v.picklist(CERTIFIED_EMAIL_KINDS),
  error: v.picklist(CERTIFIED_EMAIL_ERRORS),
  /** The provider's description of the error. */
  errorDetail: nullableText,
  sender: nullableText,
  recipients: v.array(certifiedEmailRecipientSchema),
  replyTo: nullableText,
  subject: nullableText,
  /** The provider that issued the message (`gestore-emittente`). */
  provider: nullableText,
  /** When the provider processed the message, as an instant. */
  certifiedAt: v.nullable(apiDateTimeSchema),
  /** The provider's message identifier (`identificativo`). */
  messageId: nullableText,
  /** The original message's Message-ID (`msgid`). */
  originalMessageId: nullableText,
  receiptType: v.nullable(v.picklist(CERTIFIED_EMAIL_RECEIPT_TYPES)),
  /** The mailbox a delivery receipt or notice is about (`consegna`). */
  deliveredTo: nullableText,
  /** The recipients a taken-in-charge receipt is about (`ricezione`). */
  receivedFor: v.array(v.string()),
  /** Whether the provider's message carries the original message. */
  includesOriginal: v.boolean(),
  /** The provider's signature part, which every PEC message carries (6.1). */
  signature: certifiedEmailSignatureSchema,
});
export type CertifiedEmailEnvelope = v.InferOutput<
  typeof certifiedEmailEnvelopeSchema
>;

/** A certified email's text reading, for readers that do not render email. */
export const certifiedEmailReadSchema = v.object({
  envelope: certifiedEmailEnvelopeSchema,
  /** The original message (or the provider's notice): headers and body. */
  text: v.string(),
  attachments: v.array(filePartDescriptorSchema),
});
export type CertifiedEmailRead = v.InferOutput<typeof certifiedEmailReadSchema>;
