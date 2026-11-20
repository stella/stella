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
