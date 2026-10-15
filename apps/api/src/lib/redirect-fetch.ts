/**
 * Bounded manual redirect following for fetchers that refuse automatic
 * redirects (the safe-outbound helpers): every hop re-enters the injected
 * fetcher, so its target validation runs against each redirect target
 * instead of trusting the chain blindly.
 */

import { Result, TaggedError, panic } from "better-result";

export class RedirectChainError extends TaggedError("RedirectChainError")<{
  code:
    | "missing_location"
    | "too_many_redirects"
    | "invalid_location"
    | "body_cancel_failed"
    | "destination_not_allowed";
  message: string;
}> {}

type RedirectFetchResponse = {
  body: ArrayBuffer;
  headers: Headers;
  ok: boolean;
  status: number;
};

type RedirectResponse<Body> = Omit<RedirectFetchResponse, "body"> & {
  body: Body;
};

type FetchFollowingRedirectsOptions<Body, E> = {
  url: string;
  maxHops: number;
  /** Each request must validate its target and return redirects manually. */
  fetchResponse: (
    url: string,
    hop: number,
  ) => Promise<Result<RedirectResponse<Body>, E | RedirectChainError>>;
  discardBody: (
    body: Body,
  ) =>
    | Result<void, RedirectChainError>
    | Promise<Result<void, RedirectChainError>>;
};

const fetchFollowingRedirects = async <Body, E>({
  fetchResponse,
  discardBody,
  maxHops,
  url,
}: FetchFollowingRedirectsOptions<Body, E>): Promise<
  Result<RedirectResponse<Body>, E | RedirectChainError>
> => {
  if (!Number.isSafeInteger(maxHops) || maxHops < 0) {
    panic("redirect hop limit must be a nonnegative safe integer");
  }
  const follow = async (
    target: string,
    hop: number,
  ): Promise<Result<RedirectResponse<Body>, E | RedirectChainError>> => {
    const response = await fetchResponse(target, hop);
    if (response.isErr()) {
      return response;
    }
    const { headers, status, body } = response.value;
    if (status < 300 || status >= 400) {
      return response;
    }
    const discarded = await discardBody(body);
    if (discarded.isErr()) {
      return discarded;
    }
    if (hop >= maxHops) {
      return Result.err(
        new RedirectChainError({
          code: "too_many_redirects",
          message: `redirect chain exceeded ${maxHops} hops`,
        }),
      );
    }
    const location = headers.get("location");
    if (!location) {
      return Result.err(
        new RedirectChainError({
          code: "missing_location",
          message: "redirect carried no location",
        }),
      );
    }
    const next = Result.try(() => new URL(location, target).toString());
    if (next.isErr()) {
      return Result.err(
        new RedirectChainError({
          code: "invalid_location",
          message: "redirect location is invalid",
        }),
      );
    }
    return await follow(next.value, hop + 1);
  };

  return await follow(url, 0);
};

type FetchBytesFollowingRedirectsOptions<E> = {
  url: string;
  maxHops: number;
  fetchBytes: (url: string) => Promise<Result<RedirectFetchResponse, E>>;
};

export const fetchBytesFollowingRedirects = async <E>({
  fetchBytes,
  maxHops,
  url,
}: FetchBytesFollowingRedirectsOptions<E>) =>
  await fetchFollowingRedirects({
    fetchResponse: fetchBytes,
    discardBody: () => Result.ok(),
    maxHops,
    url,
  });

type FetchStreamFollowingRedirectsOptions<E> = {
  url: string;
  maxHops: number;
  fetchStream: (
    url: string,
    hop: number,
  ) => Promise<
    Result<RedirectResponse<ReadableStream<Uint8Array>>, E | RedirectChainError>
  >;
};

export const fetchStreamFollowingRedirects = async <E>({
  fetchStream,
  maxHops,
  url,
}: FetchStreamFollowingRedirectsOptions<E>) =>
  await fetchFollowingRedirects({
    fetchResponse: fetchStream,
    discardBody: async (body) =>
      await Result.tryPromise({
        try: async () => await body.cancel(),
        catch: () =>
          new RedirectChainError({
            code: "body_cancel_failed",
            message: "redirect response body could not be cancelled",
          }),
      }),
    maxHops,
    url,
  });
