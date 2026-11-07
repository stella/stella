import { defineRequestState } from "@better-auth/core/context";
import { Result } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

/**
 * The social callback's authorization-code exchange, the one call a sign-in
 * makes to the identity provider's server.
 *
 * Better Auth reports every failed exchange as `invalid_code`, so a provider
 * that is down reads exactly like a forged or reused code: the user is told
 * nothing useful and the logs cannot tell the two apart. A provider answering
 * 5xx or 429, or not answering at all, is unavailable rather than refusing:
 * the exchange is tried once more after a short pause, and if the provider is
 * still unavailable the callback's error becomes `temporarily_unavailable`.
 * A refused code (4xx) is never retried.
 */

/** Pause before the single retry: long enough for a transient fault. */
const RETRY_DELAY_MS = 750;

export type TokenExchangeFault = "provider_unavailable" | "refused";

/**
 * How an exchange failed. Better Fetch rejects with the provider's error body
 * and its HTTP `status`; a request that never got an answer rejects with the
 * transport error instead.
 */
export const tokenExchangeFault = (error: unknown): TokenExchangeFault => {
  if (isRecord(error) && typeof error["status"] === "number") {
    const status = error["status"];
    return status >= 500 || status === 429 ? "provider_unavailable" : "refused";
  }
  return error instanceof Error ? "provider_unavailable" : "refused";
};

const statusOf = (error: unknown): number | undefined =>
  isRecord(error) && typeof error["status"] === "number"
    ? error["status"]
    : undefined;

type ExchangeObservation = {
  provider: string;
  attempt: number;
  fault: TokenExchangeFault;
  status: number | undefined;
  durationMs: number;
};

export type TokenExchangeRuntime = {
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  /** Records each failed attempt. */
  observe: (observation: ExchangeObservation) => void;
  /** Marks the current callback as failed by an unavailable provider. */
  markProviderUnavailable: () => Promise<void>;
};

type ExchangingProvider = {
  id: string;
  validateAuthorizationCode: (...args: never[]) => Promise<unknown>;
};

/**
 * The provider with its exchange retried once when the provider is
 * unavailable. Every other member is the provider's own.
 */
export const withTokenExchangeRetry = <Provider extends ExchangingProvider>(
  provider: Provider,
  runtime: TokenExchangeRuntime,
): Provider => {
  const exchange = provider.validateAuthorizationCode.bind(provider);
  const attempt = async (
    args: Parameters<Provider["validateAuthorizationCode"]>,
    number: number,
  ): Promise<Awaited<ReturnType<Provider["validateAuthorizationCode"]>>> => {
    const startedAt = runtime.now();
    const outcome = await Result.tryPromise({
      try: async () => await exchange(...args),
      catch: (cause: unknown) => cause,
    });
    if (Result.isOk(outcome)) {
      // The bound exchange keeps the provider's own signature.
      return outcome.value as Awaited<
        ReturnType<Provider["validateAuthorizationCode"]>
      >;
    }
    const error = outcome.error;
    const fault = tokenExchangeFault(error);
    runtime.observe({
      provider: provider.id,
      attempt: number,
      fault,
      status: statusOf(error),
      durationMs: Math.round(runtime.now() - startedAt),
    });
    // Better Auth maps a rejected exchange to its callback error, so the
    // provider's own rejection is what the caller receives.
    if (fault === "refused") {
      throw error;
    }
    if (number > 1) {
      await runtime.markProviderUnavailable();
      throw error;
    }
    await runtime.sleep(RETRY_DELAY_MS);
    return await attempt(args, number + 1);
  };
  return {
    ...provider,
    validateAuthorizationCode: async (
      ...args: Parameters<Provider["validateAuthorizationCode"]>
    ) => await attempt(args, 1),
  };
};

/**
 * Whether this callback's provider stayed unavailable, held in Better Auth's
 * per-request state so the exchange and the callback's after hook share it.
 */
export const providerUnavailableCallback = defineRequestState<boolean>(
  () => false,
);

/**
 * The redirect a callback should answer with instead, when its exchange failed
 * because the provider was unavailable: Better Auth's `invalid_code` error
 * redirect, with the code changed to `temporarily_unavailable`. Any other
 * response is left unchanged, so a completed sign-in is never touched.
 */
export type CallbackRedirect =
  { type: "rewrite"; location: string } | { type: "unchanged" };

const UNCHANGED: CallbackRedirect = { type: "unchanged" };

export const providerUnavailableRedirect = (
  returned: unknown,
  errorUrl: string,
): CallbackRedirect => {
  if (!isRecord(returned) || returned["statusCode"] !== 302) {
    return UNCHANGED;
  }
  const headers = returned["headers"];
  const location = headers instanceof Headers ? headers.get("location") : null;
  if (location === null) {
    return UNCHANGED;
  }
  const target = URL.parse(location, errorUrl);
  const expected = URL.parse(errorUrl);
  if (
    target === null ||
    expected === null ||
    target.origin !== expected.origin ||
    target.pathname !== expected.pathname ||
    target.searchParams.get("error") !== "invalid_code"
  ) {
    return UNCHANGED;
  }
  target.searchParams.set("error", "temporarily_unavailable");
  return { type: "rewrite", location: target.href };
};
