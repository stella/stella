import { Result } from "better-result";
import * as v from "valibot";

import type {
  CreateOidcSsoProviderBody,
  DiscoverSsoBody,
  OrganizationSsoPolicyRequirement,
  TestOidcSsoProviderBody,
} from "@stll/api-contract/sso";
import { fetchWithTimeout } from "@stll/fetch";

import { api } from "@/lib/api";
import { browserAuthBaseUrl } from "@/lib/api-url";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";

const SSO_SIGN_IN_TIMEOUT_MS = 12_000;

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
};

export const fetchOrgSsoSettings = async (signal?: AbortSignal) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.get(
      signal ? { fetch: { signal } } : undefined,
    ),
  );

export const saveOrgSsoPolicy = async (
  requirement: OrganizationSsoPolicyRequirement,
) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.policy.put({ requirement }),
  );

export const registerOidcSsoProvider = async (
  body: CreateOidcSsoProviderBody,
) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.providers.post(body),
  );

export const probeOidcSsoProvider = async (body: TestOidcSsoProviderBody) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.providers.test.post(body),
  );

export const removeOrgSsoProvider = async (providerId: string) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.providers({ providerId }).delete(),
  );

export const addOrgSsoDomain = async (domain: string) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.domains.post({ domain }),
  );

export const verifyOrgSsoDomain = async (domainId: string) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.domains({ domainId }).verify.post(),
  );

export const removeOrgSsoDomain = async (domainId: string) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.domains({ domainId }).delete(),
  );

export const lookupSsoProviders = async (
  body: DiscoverSsoBody,
  signal?: AbortSignal,
) =>
  unwrapApiResponse(
    await api.auth.sso.discover.post(
      body,
      signal ? { fetch: { signal } } : undefined,
    ),
  );

export const fetchMemberOrgSsoProviders = async (signal?: AbortSignal) =>
  unwrapApiResponse(
    await api.auth.sso["organization-providers"].get(
      signal ? { fetch: { signal } } : undefined,
    ),
  );

const ssoSignInResponseSchema = v.object({
  url: v.pipe(v.string(), v.url()),
});

const apiErrorBodySchema = v.looseObject({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

export const startSsoSignInRedirect = async (options: {
  providerId: string;
  callbackURL: string;
  errorCallbackURL: string;
  loginHint?: string;
}): Promise<Result<string, APIError>> => {
  const endpoint = `${trimTrailingSlashes(browserAuthBaseUrl())}/api/auth/sign-in/sso`;
  const response = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(endpoint, {
        method: "POST",
        credentials: "include",
        timeout: { type: "total", ms: SSO_SIGN_IN_TIMEOUT_MS },
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          providerId: options.providerId,
          callbackURL: options.callbackURL,
          errorCallbackURL: options.errorCallbackURL,
          ...(options.loginHint ? { loginHint: options.loginHint } : {}),
        }),
      }),
    catch: () =>
      new APIError({
        status: 502,
        message: "Could not start SSO sign-in",
      }),
  });
  if (response.isErr()) {
    return Result.err(response.error);
  }
  const payload = await Result.tryPromise({
    try: async (): Promise<unknown> => await response.value.json(),
    catch: () =>
      new APIError({
        status: response.value.status || 500,
        message: "Could not parse SSO sign-in response",
      }),
  });
  if (payload.isErr()) {
    return Result.err(payload.error);
  }
  if (!response.value.ok) {
    const err = v.safeParse(apiErrorBodySchema, payload.value);
    return Result.err(
      new APIError({
        status: response.value.status,
        code: err.success ? err.output.code : undefined,
        message:
          (err.success ? err.output.message : undefined) ??
          `Request failed (${response.value.status})`,
      }),
    );
  }
  const parsed = v.safeParse(ssoSignInResponseSchema, payload.value);
  if (!parsed.success) {
    return Result.err(
      new APIError({
        status: 500,
        message: "Unexpected SSO redirect response shape",
      }),
    );
  }
  return Result.ok(parsed.output.url);
};
