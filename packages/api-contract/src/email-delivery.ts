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

/**
 * Which failure reasons the sign-in screen may name. A reason the recipient's
 * own mail server would tell any sender is shown; `suppressed` says stella
 * stopped mailing the address after earlier failures, so it reads the same as
 * no report at all.
 */
const SIGN_IN_CODE_FAILURE_DISCLOSURE = {
  tls_required: "shown",
  mailbox_missing: "shown",
  mailbox_unavailable: "shown",
  suppressed: "generic",
  other: "shown",
} as const satisfies Record<EmailDeliveryFailureReason, "shown" | "generic">;

type ShownReason<Reason extends EmailDeliveryFailureReason> =
  (typeof SIGN_IN_CODE_FAILURE_DISCLOSURE)[Reason] extends "shown"
    ? Reason
    : never;

/** A failure reason the sign-in screen names. */
export type SignInCodeFailureReason = {
  [Reason in EmailDeliveryFailureReason]: ShownReason<Reason>;
}[EmailDeliveryFailureReason];

export const SIGN_IN_CODE_FAILURE_REASONS =
  EMAIL_DELIVERY_FAILURE_REASONS.filter(
    (reason): reason is SignInCodeFailureReason =>
      SIGN_IN_CODE_FAILURE_DISCLOSURE[reason] === "shown",
  );

export const signInCodeFailureReasonSchema = v.picklist(
  SIGN_IN_CODE_FAILURE_REASONS,
);

/**
 * The random id the sign-in screen gives one code request, sent in this
 * header. Only a request that presents the id can later ask whether that
 * request's own code mail bounced.
 */
export const SIGN_IN_ATTEMPT_HEADER = "X-Stella-Sign-In-Attempt";

/** 32 random bytes, base64url without padding. */
export const signInAttemptSchema = v.pipe(v.string(), v.regex(/^[\w-]{43}$/u));

/** Where the sign-in screen asks whether its code mail bounced. */
export const SIGN_IN_CODE_DELIVERY_PATH = "/email-otp/sign-in-delivery";

/**
 * What the provider reported about the code mail one sign-in attempt sent:
 * `failed` once that mail bounced for a reason the screen may name, `none`
 * otherwise. An unknown, expired or pending attempt, and one whose mail was
 * never sent, all answer `none`.
 */
export const signInCodeDeliverySchema = v.variant("status", [
  v.strictObject({ status: v.literal("none") }),
  v.strictObject({
    status: v.literal("failed"),
    reason: signInCodeFailureReasonSchema,
  }),
]);

export type SignInCodeDelivery = v.InferOutput<typeof signInCodeDeliverySchema>;
