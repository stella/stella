import { APIError } from "better-auth/api";
import { describe, expect, test } from "bun:test";

import {
  providerUnavailableRedirect,
  type TokenExchangeFault,
  tokenExchangeFault,
  withTokenExchangeRetry,
} from "@/api/lib/auth/social-token-exchange";

const errorUrl = "https://app.example.test/api/auth/error";

/** The rejection Better Fetch produces for a provider's error response. */
const providerError = (status: number, error: string) => ({
  error,
  status,
  statusText: "provider answer",
});

const tokens = { accessToken: "access" };

const provider = (answers: readonly unknown[]) => {
  const remaining = [...answers];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    instance: {
      id: "google",
      name: "Google",
      validateAuthorizationCode: async (_input: { code: string }) => {
        calls += 1;
        const answer = remaining.shift();
        if (answer === tokens) {
          return tokens;
        }
        throw answer;
      },
    },
  };
};

const runtime = () => {
  const observed: unknown[] = [];
  const slept: number[] = [];
  let unavailable = 0;
  return {
    observed,
    slept,
    get unavailable() {
      return unavailable;
    },
    value: {
      sleep: async (milliseconds: number) => {
        slept.push(milliseconds);
      },
      now: () => 0,
      observe: (observation: unknown) => {
        observed.push(observation);
      },
      markProviderUnavailable: async () => {
        unavailable += 1;
      },
    },
  };
};

describe("token exchange fault", () => {
  test.each<[unknown, TokenExchangeFault]>([
    [providerError(500, "internal_failure"), "provider_unavailable"],
    [providerError(503, "unavailable"), "provider_unavailable"],
    [providerError(429, "rate_limited"), "provider_unavailable"],
    [new TypeError("fetch failed"), "provider_unavailable"],
    [new DOMException("timed out", "TimeoutError"), "provider_unavailable"],
    [providerError(400, "invalid_grant"), "refused"],
    [providerError(401, "invalid_client"), "refused"],
    ["unexpected", "refused"],
  ])("classifies %p as %s", (error, fault) => {
    expect(tokenExchangeFault(error)).toBe(fault);
  });
});

describe("exchange retry", () => {
  test("a provider fault followed by an answer completes the exchange", async () => {
    const google = provider([providerError(500, "internal_failure"), tokens]);
    const run = runtime();
    const wrapped = withTokenExchangeRetry(google.instance, run.value);
    expect(await wrapped.validateAuthorizationCode({ code: "c" })).toBe(tokens);
    expect(google.calls).toBe(2);
    expect(run.slept).toEqual([750]);
    expect(run.unavailable).toBe(0);
    expect(run.observed).toEqual([
      {
        provider: "google",
        attempt: 1,
        fault: "provider_unavailable",
        status: 500,
        durationMs: 0,
      },
    ]);
  });

  test("a provider still unavailable after the retry marks the callback", async () => {
    const failure = providerError(500, "internal_failure");
    const google = provider([failure, failure]);
    const run = runtime();
    const wrapped = withTokenExchangeRetry(google.instance, run.value);
    expect(
      await wrapped
        .validateAuthorizationCode({ code: "c" })
        .catch((error: unknown) => error),
    ).toBe(failure);
    expect(google.calls).toBe(2);
    expect(run.unavailable).toBe(1);
  });

  test("a refused code is not retried and does not mark the callback", async () => {
    const refusal = providerError(400, "invalid_grant");
    const google = provider([refusal, tokens]);
    const run = runtime();
    const wrapped = withTokenExchangeRetry(google.instance, run.value);
    expect(
      await wrapped
        .validateAuthorizationCode({ code: "c" })
        .catch((error: unknown) => error),
    ).toBe(refusal);
    expect(google.calls).toBe(1);
    expect(run.slept).toEqual([]);
    expect(run.unavailable).toBe(0);
  });

  test("the wrapped provider keeps every other member", () => {
    const google = provider([]);
    const wrapped = withTokenExchangeRetry(google.instance, runtime().value);
    expect(wrapped.id).toBe("google");
    expect(wrapped.name).toBe("Google");
  });
});

describe("provider unavailable redirect", () => {
  const redirectTo = (location: string) =>
    new APIError("FOUND", undefined, new Headers({ location }));

  test("rewrites the invalid_code error redirect and keeps its other parameters", () => {
    expect(
      providerUnavailableRedirect(
        redirectTo(`${errorUrl}?error=invalid_code&state=x`),
        errorUrl,
      ),
    ).toEqual({
      type: "rewrite",
      location: `${errorUrl}?error=temporarily_unavailable&state=x`,
    });
  });

  test.each([
    `${errorUrl}?error=state_mismatch`,
    "https://app.example.test/matters",
    "https://other.example.test/api/auth/error?error=invalid_code",
  ])("leaves %s alone", (location) => {
    expect(providerUnavailableRedirect(redirectTo(location), errorUrl)).toEqual(
      { type: "unchanged" },
    );
  });

  test("leaves a response that is not a redirect alone", () => {
    expect(providerUnavailableRedirect({ statusCode: 200 }, errorUrl)).toEqual({
      type: "unchanged",
    });
  });
});
