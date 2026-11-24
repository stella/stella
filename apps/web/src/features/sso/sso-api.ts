import { Result } from "better-result";
import * as v from "valibot";

import type {
  CreateOidcSsoProviderBody,
  DiscoverSsoBody,
  OrganizationSsoPolicyRequirement,
  TestOidcSsoProviderBody,
} from "@stll/api-contract/sso";

import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";

export const fetchOrgSsoSettings = async (signal?: AbortSignal) =>
  unwrapApiResponse(
    await api["organization-settings"].sso.get(
      signal ? { fetch: { signal } } : undefined,
    ),
  );

export const saveOrgSsoPolicy = async (
  requirement: OrganizationSsoPolicyRequirement,
) =>
  await invokeAppOnlyWrite("organization-settings.sso.policy.put", async () =>
    unwrapApiResponse(
      await api["organization-settings"].sso.policy.put({ requirement }),
    ),
  );

export const registerOidcSsoProvider = async (
  body: CreateOidcSsoProviderBody,
) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.providers.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso.providers.post(body),
      ),
  );

export const probeOidcSsoProvider = async (body: TestOidcSsoProviderBody) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.providers.test.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso.providers.test.post(body),
      ),
  );

export const removeOrgSsoProvider = async (providerId: string) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.providers.delete",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso
          .providers({ providerId })
          .delete(),
      ),
  );

export const addOrgSsoDomain = async (domain: string) =>
  await invokeAppOnlyWrite("organization-settings.sso.domains.post", async () =>
    unwrapApiResponse(
      await api["organization-settings"].sso.domains.post({ domain }),
    ),
  );

export const verifyOrgSsoDomain = async (domainId: string) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.domains.verify.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso
          .domains({ domainId })
          .verify.post(),
      ),
  );

export const removeOrgSsoDomain = async (domainId: string) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.domains.delete",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso.domains({ domainId }).delete(),
      ),
  );

export const lookupSsoProviders = async (
  body: DiscoverSsoBody,
  signal?: AbortSignal,
) =>
  await invokeAppOnlyWrite("auth.sso.discover.post", async () =>
    unwrapApiResponse(
      await api.auth.sso.discover.post(
        body,
        signal ? { fetch: { signal } } : undefined,
      ),
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

export const startSsoSignInRedirect = async (options: {
  providerId: string;
  callbackURL: string;
  errorCallbackURL: string;
  loginHint?: string;
}): Promise<Result<string, APIError>> => {
  const response = await Result.tryPromise({
    try: async () =>
      await authClient.$fetch<unknown>("/sign-in/sso", {
        method: "POST",
        body: {
          providerId: options.providerId,
          callbackURL: options.callbackURL,
          errorCallbackURL: options.errorCallbackURL,
          ...(options.loginHint ? { loginHint: options.loginHint } : {}),
        },
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
  if (response.value.error) {
    const rawErr = response.value.error;
    const code =
      "code" in rawErr && typeof rawErr.code === "string"
        ? rawErr.code
        : undefined;
    return Result.err(
      new APIError({
        status: rawErr.status ?? 500,
        code,
        message: rawErr.message ?? "Could not start SSO sign-in",
      }),
    );
  }
  const parsed = v.safeParse(ssoSignInResponseSchema, response.value.data);
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
