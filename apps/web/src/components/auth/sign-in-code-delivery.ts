import { queryOptions, skipToken } from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  SIGN_IN_CODE_DELIVERY_PATH,
  type SignInCodeDelivery,
  signInCodeDeliverySchema,
} from "@stll/api-contract/email-delivery";
import { Temporal } from "@stll/time";

import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { readQueryResult } from "@/lib/errors/query-result";

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
  const answer = readQueryResult(
    error ? Result.err(toAuthClientError(error)) : Result.ok(data),
  );
  const parsed = v.safeParse(signInCodeDeliverySchema, answer);
  return readQueryResult(
    parsed.success
      ? Result.ok(parsed.output)
      : Result.err(
          new SignInCodeDeliveryShapeError({
            message: "Sign-in code delivery answer has an unexpected shape",
          }),
        ),
  );
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
