/**
 * Bounded manual redirect following for fetchers that refuse automatic
 * redirects (the safe-outbound helpers): every hop re-enters the injected
 * fetcher, so its target validation runs against each redirect target
 * instead of trusting the chain blindly.
 */

import { Result, TaggedError } from "better-result";

export class RedirectChainError extends TaggedError("RedirectChainError")<{
  code: "missing_location" | "too_many_redirects";
  message: string;
}> {}

type RedirectFetchResponse = {
  body: ArrayBuffer;
  headers: Headers;
  ok: boolean;
  status: number;
};

type FetchBytesFollowingRedirectsOptions<E> = {
  url: string;
  maxHops: number;
  /** One manual-redirect request; a 3xx must come back, not be followed. */
  fetchBytes: (url: string) => Promise<Result<RedirectFetchResponse, E>>;
};

export const fetchBytesFollowingRedirects = async <E>({
  fetchBytes,
  maxHops,
  url,
}: FetchBytesFollowingRedirectsOptions<E>): Promise<
  Result<RedirectFetchResponse, E | RedirectChainError>
> => {
  const follow = async (
    target: string,
    hop: number,
  ): Promise<Result<RedirectFetchResponse, E | RedirectChainError>> => {
    if (hop > maxHops) {
      return Result.err(
        new RedirectChainError({
          code: "too_many_redirects",
          message: `redirect chain exceeded ${maxHops} hops`,
        }),
      );
    }
    const response = await fetchBytes(target);
    if (Result.isError(response)) {
      return response;
    }
    const { headers, status } = response.value;
    if (status < 300 || status >= 400) {
      return response;
    }
    const location = headers.get("location");
    if (!location) {
      return Result.err(
        new RedirectChainError({
          code: "missing_location",
          message: `redirect from ${new URL(target).origin} carried no location`,
        }),
      );
    }
    return await follow(new URL(location, target).toString(), hop + 1);
  };

  return await follow(url, 0);
};
