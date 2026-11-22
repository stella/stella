/**
 * An email file (`.eml`, `.msg`) read for readers that do not render email,
 * such as the mobile app: its header, its body as text and its attachments
 * as parts of the file. A certified email (Italian PEC) also carries the
 * provider's certification data; its header and body are then the original
 * message's, or the provider's notice where the file carries no original.
 */

import * as v from "valibot";

import { certifiedEmailEnvelopeSchema } from "./certified-email";
import { filePartDescriptorSchema } from "./file-parts";

export const emailReadingSchema = v.object({
  /** A certified email's certification data; null for any other email. */
  certified: v.nullable(certifiedEmailEnvelopeSchema),
  subject: v.nullable(v.string()),
  /** The sender as the message states it: name and address. */
  from: v.nullable(v.string()),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  /** The date as the message states it, which may not parse as a date. */
  date: v.nullable(v.string()),
  /** The message body as text, without its header. */
  text: v.string(),
  /** The attachments, without the inline images the body shows. */
  attachments: v.array(filePartDescriptorSchema),
});
export type EmailReading = v.InferOutput<typeof emailReadingSchema>;
