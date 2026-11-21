import { createAuthEndpoint } from "@better-auth/core/api";
import type { BetterAuthPlugin } from "better-auth";
import { Result } from "better-result";
import * as v from "valibot";

import {
  type EmailDeliveryFailureReason,
  SIGN_IN_ATTEMPT_HEADER,
  SIGN_IN_CODE_DELIVERY_PATH,
  signInAttemptSchema,
  type SignInCodeDelivery,
  signInCodeFailureReasonSchema,
} from "@stll/api-contract/email-delivery";
import { sha256Hex } from "@stll/sha256/bun";

import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import type { SignInCodeDeliveryStore } from "@/api/lib/auth/sign-in-code-delivery-store";
import type { EmailSendOutcome } from "@/api/lib/email/transport";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

// Each sink observes a failed store command; the sign-in itself never depends
// on this bookkeeping, and an unread failure answers like no failure.
const sendUnremembered = failureSink({
  event: "auth.sign_in_code_delivery.send_unremembered",
  expected: [],
});
const failureUnmarked = failureSink({
  event: "auth.sign_in_code_delivery.failure_unmarked",
  expected: [],
});
const deliveryUnread = failureSink({
  event: "auth.sign_in_code_delivery.unread",
  expected: [],
});

const NO_REPORT = { status: "none" } as const satisfies SignInCodeDelivery;

/** The store key for an attempt id; the id itself is never stored. */
const attemptKeyOf = (attempt: string) => sha256Hex(attempt);

/**
 * Whether a code send would have gone out to any address, account or not.
 * `accounts_only` is the new-account rate-limited state: a code goes only to
 * an address that has an account, so a bounce report would tell the two
 * apart, and nothing is remembered.
 */
export type SignInCodeAudience = "any_address" | "accounts_only";

type RememberSignInCodeSendOptions = {
  store: SignInCodeDeliveryStore;
  headers: Headers | undefined;
  outcome: EmailSendOutcome;
  audience: SignInCodeAudience;
};

/**
 * Remembers which sign-in attempt sent this code mail, when the request named
 * an attempt and the send went out on a path open to every address. Only
 * then can that attempt later learn that its own mail bounced.
 */
export const rememberSignInCodeSend = async ({
  store,
  headers,
  outcome,
  audience,
}: RememberSignInCodeSendOptions): Promise<void> => {
  if (outcome.type !== "accepted" || audience !== "any_address") {
    return;
  }
  const attempt = v.safeParse(
    signInAttemptSchema,
    headers?.get(SIGN_IN_ATTEMPT_HEADER),
  );
  if (!attempt.success) {
    return;
  }
  const remembered = await Result.tryPromise(
    async () =>
      await store.rememberSend({
        attemptKey: attemptKeyOf(attempt.output),
        providerMessageId: outcome.providerMessageId,
      }),
  );
  if (remembered.isErr()) {
    observeFailure(remembered.error, { sink: sendUnremembered });
  }
};

/**
 * Records a bounce of a code mail against the attempt that sent it. A reason
 * the sign-in screen does not name (`suppressed`) records nothing, so the
 * attempt answers as if no failure were reported.
 */
export const markSignInCodeFailure =
  (store: SignInCodeDeliveryStore) =>
  async (
    providerMessageId: string,
    reason: EmailDeliveryFailureReason,
  ): Promise<void> => {
    const shown = v.safeParse(signInCodeFailureReasonSchema, reason);
    if (!shown.success) {
      return;
    }
    const marked = await Result.tryPromise(
      async () =>
        await store.markFailed({ providerMessageId, reason: shown.output }),
    );
    if (marked.isErr()) {
      observeFailure(marked.error, { sink: failureUnmarked });
    }
  };

const readDelivery = async (
  store: SignInCodeDeliveryStore,
  attemptId: string,
): Promise<SignInCodeDelivery> => {
  // A malformed id names no attempt, and answers like any unknown one.
  const attempt = v.safeParse(signInAttemptSchema, attemptId);
  if (!attempt.success) {
    return NO_REPORT;
  }
  const stored = await Result.tryPromise(
    async () => await store.readFailure(attemptKeyOf(attempt.output)),
  );
  if (stored.isErr()) {
    observeFailure(stored.error, { sink: deliveryUnread });
    return NO_REPORT;
  }
  const reason = v.safeParse(signInCodeFailureReasonSchema, stored.value);
  return reason.success
    ? { status: "failed", reason: reason.output }
    : NO_REPORT;
};

/**
 * Answers the sign-in screen's question about one code request: did the code
 * mail that request sent bounce, and why. The answer carries only the reason;
 * an unknown, expired or pending attempt answers exactly like a delivered one.
 */
export const createSignInCodeDeliveryPlugin = (
  store: SignInCodeDeliveryStore,
) =>
  ({
    id: "stella-sign-in-code-delivery",
    endpoints: {
      readSignInCodeDelivery: createAuthEndpoint(
        SIGN_IN_CODE_DELIVERY_PATH,
        {
          method: "POST",
          // Bounded loosely: a malformed id answers like an unknown one.
          body: v.object({ attempt: v.pipe(v.string(), v.maxLength(256)) }),
        },
        async (ctx) => {
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          return ctx.json(await readDelivery(store, ctx.body.attempt));
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
