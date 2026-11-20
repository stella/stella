import type { BetterAuthPlugin } from "better-auth";
import type { createAuthMiddleware } from "better-auth/api";
import { Result } from "better-result";
import * as v from "valibot";

import {
  EMAIL_DELIVERY_STATUS_FIELD,
  type EmailDeliveryFailureReason,
  type EmailDeliveryStatus,
} from "@stll/api-contract/email-delivery";

import {
  emailAddressSchema,
  type NormalizedEmail,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord } from "@/api/lib/type-guards";

const SEND_VERIFICATION_OTP_PATH = "/email-otp/send-verification-otp";
const EMAIL_OTP_SIGN_IN_PATH = "/sign-in/email-otp";

// The code request then answers `unknown`; the sign-in screen shows what it
// showed before failures were recorded.
const deliveryStatusUnread = failureSink({
  event: "auth.email_delivery.status_unread",
  expected: [],
});
// A failure left behind is shown again until it is superseded or expires.
const deliveryFailureUnforgotten = failureSink({
  event: "auth.email_delivery.failure_unforgotten",
  expected: [],
});

type EmailDeliveryStatusDependencies = {
  readFailure: (
    email: NormalizedEmail,
  ) => Promise<EmailDeliveryFailureReason | undefined>;
  forgetFailure: (email: NormalizedEmail) => Promise<void>;
};

const requestedAddress = (body: unknown): NormalizedEmail | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const parsed = v.safeParse(emailAddressSchema, body["email"]);
  return parsed.success ? normalizeEmail(parsed.output) : undefined;
};

const toStatus = (
  reason: EmailDeliveryFailureReason | undefined,
): EmailDeliveryStatus =>
  reason === undefined ? { type: "none_recorded" } : { type: "failed", reason };

/**
 * Tells the sign-in screen when mail to the address a code was requested for
 * recently failed, so it explains the failure instead of saying a code is on
 * its way. The failure is keyed by address, not account, so the code
 * request's response stays the same for new and existing accounts. A code
 * sign-in proves the mail arrived, so it drops the address's failure.
 */
export const createEmailDeliveryStatusPlugin = (
  middleware: typeof createAuthMiddleware,
  { readFailure, forgetFailure }: EmailDeliveryStatusDependencies,
) =>
  ({
    id: "stella-email-delivery-status",
    hooks: {
      after: [
        {
          matcher: ({ path }) => path === SEND_VERIFICATION_OTP_PATH,
          handler: middleware(async (ctx) => {
            const returned = ctx.context.returned;
            const email = requestedAddress(ctx.body);
            if (
              email === undefined ||
              !isRecord(returned) ||
              returned["success"] !== true
            ) {
              return undefined;
            }
            const failure = await Result.tryPromise(
              async () => await readFailure(email),
            );
            if (failure.isErr()) {
              observeFailure(failure.error, { sink: deliveryStatusUnread });
              return await ctx.json({
                ...returned,
                [EMAIL_DELIVERY_STATUS_FIELD]: { type: "unknown" },
              });
            }
            return await ctx.json({
              ...returned,
              [EMAIL_DELIVERY_STATUS_FIELD]: toStatus(failure.value),
            });
          }),
        },
        {
          matcher: ({ path }) => path === EMAIL_OTP_SIGN_IN_PATH,
          handler: middleware(async (ctx) => {
            const signedIn = ctx.context.newSession?.user.email;
            if (signedIn === undefined) {
              return undefined;
            }
            const forgotten = await Result.tryPromise(
              async () => await forgetFailure(normalizeEmail(signedIn)),
            );
            if (forgotten.isErr()) {
              observeFailure(forgotten.error, {
                sink: deliveryFailureUnforgotten,
              });
            }
            return undefined;
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
