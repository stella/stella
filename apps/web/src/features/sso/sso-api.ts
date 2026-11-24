import { Result } from "better-result";
import * as v from "valibot";

import {
  createOrganizationScimTokenResponseSchema,
  revokeOrganizationScimTokenResponseSchema,
} from "@stll/api-contract/sso";
import type {
  CreateOidcSsoProviderBody,
  CreateOrganizationScimTokenBody,
  CreateSamlSsoProviderBody,
  DiscoverSsoBody,
  ParseSamlMetadataBody,
  SsoProtocol,
  TestOidcSsoProviderBody,
  UpdateOrganizationSsoPolicyBody,
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

export const saveOrgSsoPolicy = async (body: UpdateOrganizationSsoPolicyBody) =>
  await invokeAppOnlyWrite("organization-settings.sso.policy.put", async () =>
    unwrapApiResponse(await api["organization-settings"].sso.policy.put(body)),
  );

export const approveOrgSsoPendingMember = async (pendingId: string) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.pending-members.approve.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso["pending-members"]({
          pendingId,
        }).approve.post(),
      ),
  );

export const rejectOrgSsoPendingMember = async (pendingId: string) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.pending-members.reject.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso["pending-members"]({
          pendingId,
        }).reject.post(),
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

export const registerSamlSsoProvider = async (
  body: CreateSamlSsoProviderBody,
) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.providers.saml.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso.providers.saml.post(body),
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

export const createOrganizationScimToken = async (
  body: CreateOrganizationScimTokenBody = {},
) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.scim-tokens.post",
    async () =>
      v.parse(
        createOrganizationScimTokenResponseSchema,
        unwrapApiResponse(
          await api["organization-settings"].sso["scim-tokens"].post(body),
        ),
      ),
  );

export const revokeOrganizationScimToken = async (tokenId: string) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.scim-tokens.delete",
    async () =>
      v.parse(
        revokeOrganizationScimTokenResponseSchema,
        unwrapApiResponse(
          await api["organization-settings"].sso["scim-tokens"]({
            tokenId,
          }).delete(),
        ),
      ),
  );

export const importSamlSsoMetadata = async (body: ParseSamlMetadataBody) =>
  await invokeAppOnlyWrite(
    "organization-settings.sso.saml.parse-metadata.post",
    async () =>
      unwrapApiResponse(
        await api["organization-settings"].sso.saml["parse-metadata"].post(
          body,
        ),
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
  protocol?: SsoProtocol;
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
          providerType: options.protocol ?? "oidc",
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
        status: rawErr.status,
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
