import { queryOptions, skipToken } from "@tanstack/react-query";
import { TaggedError } from "better-result";
import * as v from "valibot";

import {
  SIGN_IN_CODE_DELIVERY_PATH,
  type SignInCodeDelivery,
  signInCodeDeliverySchema,
} from "@stll/api-contract/email-delivery";
import { Temporal } from "@stll/time";

import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";

const SIGN_IN_CODE_DELIVERY_POLL_MS = 10_000;
/** The server forgets an attempt shortly after its code expires. */
export const SIGN_IN_CODE_DELIVERY_WINDOW_MS = 6 * 60 * 1000;

class SignInCodeDeliveryShapeError extends TaggedError(
  "SignInCodeDeliveryShapeError",
)<{ message: string }> {}

const readSignInCodeDelivery = async (
  attempt: string,
  signal: AbortSignal,
): Promise<SignInCodeDelivery> => {
  const { data, error } = await authClient.$fetch(SIGN_IN_CODE_DELIVERY_PATH, {
    method: "POST",
    body: { attempt },
    signal,
  });
  if (error) {
    throw toAuthClientError(error);
  }
  const parsed = v.safeParse(signInCodeDeliverySchema, data);
  if (!parsed.success) {
    throw new SignInCodeDeliveryShapeError({
      message: "Sign-in code delivery answer has an unexpected shape",
    });
  }
  return parsed.output;
};

type SignInCodeDeliveryOptions = {
  /** The code request's attempt id; none when the request named none. */
  attempt: string | undefined;
  /** When to stop asking, in epoch milliseconds. */
  pollUntil: number;
};

/**
 * Asks, every few seconds while the code can still be used, whether the
 * code mail this attempt sent bounced. Stops once it did.
 */
export const signInCodeDeliveryOptions = ({
  attempt,
  pollUntil,
}: SignInCodeDeliveryOptions) =>
  queryOptions({
    queryKey: ["auth", "sign-in-code-delivery", attempt] as const,
    queryFn:
      attempt === undefined
        ? skipToken
        : async ({ signal }) => await readSignInCodeDelivery(attempt, signal),
    refetchInterval: (query) =>
      query.state.data?.status === "failed" ||
      Temporal.Now.instant().epochMilliseconds >= pollUntil
        ? false
        : SIGN_IN_CODE_DELIVERY_POLL_MS,
    retry: false,
  });
