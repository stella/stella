import { Result } from "better-result";
import * as v from "valibot";

import {
  discoverSsoResponseSchema,
  organizationSsoDomainSummarySchema,
  organizationSsoProviderSummarySchema,
  organizationSsoSettingsResponseSchema,
  testOidcSsoProviderResponseSchema,
} from "@stll/api-contract/sso";
import type {
  CreateOidcSsoProviderBody,
  DiscoverSsoBody,
  DiscoverSsoResponse,
  OrganizationSsoDomainSummary,
  OrganizationSsoPolicyRequirement,
  OrganizationSsoProviderSummary,
  OrganizationSsoSettingsResponse,
  TestOidcSsoProviderBody,
  TestOidcSsoProviderResponse,
} from "@stll/api-contract/sso";
import { fetchWithTimeout } from "@stll/fetch";

import { browserApiBaseUrl, browserAuthBaseUrl } from "@/lib/api-url";
import { APIError } from "@/lib/errors/api";

const SSO_REQUEST_TIMEOUT_MS = 12_000;

const apiErrorBodySchema = v.looseObject({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

const parseJsonResponse = async <TSchema extends v.GenericSchema>(
  response: Response,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = v.safeParse(apiErrorBodySchema, payload);
    throw new APIError({
      status: response.status,
      code: err.success ? err.output.code : undefined,
      message:
        (err.success ? err.output.message : undefined) ??
        `Request failed (${response.status})`,
    });
  }
  const parsed = v.safeParse(schema, payload);
  if (!parsed.success) {
    throw new APIError({
      status: 500,
      message: "Unexpected SSO response shape",
    });
  }
  return parsed.output;
};

const ssoApiUrl = (path: string) =>
  `${browserApiBaseUrl().replace(/\/+$/u, "")}/v1${path}`;

const ssoJsonFetch = async <TSchema extends v.GenericSchema>(
  path: string,
  init: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
  },
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> => {
  const response = await fetchWithTimeout(ssoApiUrl(path), {
    method: init.method,
    credentials: "include",
    signal: init.signal,
    timeout: { type: "total", ms: SSO_REQUEST_TIMEOUT_MS },
    headers:
      init.body !== undefined
        ? { "content-type": "application/json", accept: "application/json" }
        : { accept: "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return await parseJsonResponse(response, schema);
};

export const readOrganizationSsoSettings = async (
  signal?: AbortSignal,
): Promise<OrganizationSsoSettingsResponse> =>
  await ssoJsonFetch(
    "/organization-settings/sso",
    { method: "GET", signal },
    organizationSsoSettingsResponseSchema,
  );

export const updateOrganizationSsoPolicy = async (
  requirement: OrganizationSsoPolicyRequirement,
) =>
  await ssoJsonFetch(
    "/organization-settings/sso/policy",
    { method: "PUT", body: { requirement } },
    v.object({ requirement: v.picklist(["optional", "required"]) }),
  );

export const createOidcSsoProvider = async (
  body: CreateOidcSsoProviderBody,
): Promise<OrganizationSsoProviderSummary> =>
  await ssoJsonFetch(
    "/organization-settings/sso/providers",
    { method: "POST", body },
    organizationSsoProviderSummarySchema,
  );

export const testOidcSsoProvider = async (
  body: TestOidcSsoProviderBody,
): Promise<TestOidcSsoProviderResponse> =>
  await ssoJsonFetch(
    "/organization-settings/sso/providers/test",
    { method: "POST", body },
    testOidcSsoProviderResponseSchema,
  );

export const deleteOrganizationSsoProvider = async (providerId: string) =>
  await ssoJsonFetch(
    `/organization-settings/sso/providers/${encodeURIComponent(providerId)}`,
    { method: "DELETE" },
    v.object({ deleted: v.literal(true), id: v.string() }),
  );

export const createOrganizationSsoDomain = async (
  domain: string,
): Promise<OrganizationSsoDomainSummary> =>
  await ssoJsonFetch(
    "/organization-settings/sso/domains",
    { method: "POST", body: { domain } },
    organizationSsoDomainSummarySchema,
  );

export const verifyOrganizationSsoDomain = async (domainId: string) =>
  await ssoJsonFetch(
    `/organization-settings/sso/domains/${encodeURIComponent(domainId)}/verify`,
    { method: "POST" },
    v.object({
      domain: organizationSsoDomainSummarySchema,
      verified: v.boolean(),
    }),
  );

export const deleteOrganizationSsoDomain = async (domainId: string) =>
  await ssoJsonFetch(
    `/organization-settings/sso/domains/${encodeURIComponent(domainId)}`,
    { method: "DELETE" },
    v.object({ deleted: v.literal(true), id: v.string() }),
  );

export const discoverSsoProviders = async (
  body: DiscoverSsoBody,
  signal?: AbortSignal,
): Promise<DiscoverSsoResponse> =>
  await ssoJsonFetch(
    "/auth/sso/discover",
    { method: "POST", body, signal },
    discoverSsoResponseSchema,
  );

export const readMemberOrganizationSsoProviders = async (
  organizationId?: string,
  signal?: AbortSignal,
): Promise<DiscoverSsoResponse> => {
  const qs =
    organizationId !== undefined && organizationId.length > 0
      ? `?organizationId=${encodeURIComponent(organizationId)}`
      : "";
  return await ssoJsonFetch(
    `/auth/sso/organization-providers${qs}`,
    { method: "GET", signal },
    discoverSsoResponseSchema,
  );
};

const ssoSignInResponseSchema = v.looseObject({
  url: v.string(),
});

export type StartSsoSignInOptions = {
  providerId: string;
  callbackURL: string;
  errorCallbackURL: string;
  loginHint?: string;
};

/**
 * Starts an SP-initiated SSO sign-in through Better Auth's `/sign-in/sso`
 * endpoint and returns the identity provider authorization redirect URL.
 */
export const requestSsoSignInRedirectUrl = async (
  options: StartSsoSignInOptions,
): Promise<Result<string, APIError>> => {
  const authBase = browserAuthBaseUrl().replace(/\/+$/u, "");
  const response = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(`${authBase}/sign-in/sso`, {
        method: "POST",
        credentials: "include",
        timeout: { type: "total", ms: SSO_REQUEST_TIMEOUT_MS },
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          providerId: options.providerId,
          providerType: "oidc",
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
  const parsed = await Result.tryPromise({
    try: async () =>
      await parseJsonResponse(response.value, ssoSignInResponseSchema),
    catch: (error: unknown) =>
      APIError.is(error)
        ? error
        : new APIError({ status: 500, message: "Could not start SSO sign-in" }),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return Result.ok(parsed.value.url);
};
