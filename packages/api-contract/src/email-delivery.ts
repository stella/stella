import * as v from "valibot";

/**
 * Why mail recently failed to reach an address, as the sign-in screen
 * explains it:
 * - `tls_required`: the recipient's server does not accept encrypted
 *   delivery, and stella only sends over TLS;
 * - `mailbox_missing`: the recipient's server says the mailbox does not exist;
 * - `mailbox_unavailable`: the mailbox is full or temporarily unavailable;
 * - `suppressed`: earlier mail bounced, so mail to the address is no longer
 *   sent;
 * - `other`: any other refusal.
 */
export const EMAIL_DELIVERY_FAILURE_REASONS = [
  "tls_required",
  "mailbox_missing",
  "mailbox_unavailable",
  "suppressed",
  "other",
] as const;

export type EmailDeliveryFailureReason =
  (typeof EMAIL_DELIVERY_FAILURE_REASONS)[number];

export const emailDeliveryFailureReasonSchema = v.picklist(
  EMAIL_DELIVERY_FAILURE_REASONS,
);

/**
 * What stella knows about mail to the address a sign-in code was just
 * requested for: `failed` when the provider recently reported a failure for
 * it, `none_recorded` when it did not, `unknown` when that could not be
 * read. `none_recorded` is not proof of delivery.
 */
export const emailDeliveryStatusSchema = v.variant("type", [
  v.object({ type: v.literal("none_recorded") }),
  v.object({ type: v.literal("unknown") }),
  v.object({
    type: v.literal("failed"),
    reason: emailDeliveryFailureReasonSchema,
  }),
]);

export type EmailDeliveryStatus = v.InferOutput<
  typeof emailDeliveryStatusSchema
>;

/**
 * The code request's response carries the status in this field. A server
 * released before the field existed answers without it.
 */
export const EMAIL_DELIVERY_STATUS_FIELD = "emailDelivery";

export const emailCodeRequestResponseSchema = v.object({
  [EMAIL_DELIVERY_STATUS_FIELD]: v.optional(emailDeliveryStatusSchema),
});
