import { Result } from "better-result";

import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { isAuthFlowPathname, normalizeRedirectTo } from "@/lib/redirect";

const SSO_SIGN_IN_REQUIRED_CODE = "sso_sign_in_required";
const SSO_REQUIRED_TOAST_ID = "sso-sign-in-required";

export const isSsoSignInRequiredError = (error: unknown): boolean =>
  APIError.is(error) &&
  error.status === 403 &&
  error.code === SSO_SIGN_IN_REQUIRED_CODE;

const buildSsoFallbackUrl = (redirectPath: string): string =>
  `/auth?sso=required&redirectTo=${encodeURIComponent(redirectPath)}`;

const startOrganizationSsoReauth = async () => {
  const redirectPath = normalizeRedirectTo(
    window.location.pathname + window.location.search,
  );
  const callbackURL = `${window.location.origin}${redirectPath}`;
  const errorCallbackURL = `${window.location.origin}${buildSsoFallbackUrl(redirectPath)}`;

  const ssoApi = await Result.tryPromise({
    try: async () => await import("@/features/sso/sso-api"),
    catch: () => null,
  });
  if (ssoApi.isErr()) {
    window.location.assign(buildSsoFallbackUrl(redirectPath));
    return;
  }

  const providersResult = await Result.tryPromise({
    try: async () => await ssoApi.value.fetchMemberOrgSsoProviders(),
    catch: () => null,
  });
  const first = providersResult.isOk()
    ? providersResult.value.providers.at(0)
    : undefined;
  if (first === undefined) {
    window.location.assign(buildSsoFallbackUrl(redirectPath));
    return;
  }

  const redirect = await ssoApi.value.startSsoSignInRedirect({
    providerId: first.providerId,
    callbackURL,
    errorCallbackURL,
  });
  if (redirect.isOk()) {
    window.location.assign(redirect.value);
    return;
  }

  window.location.assign(buildSsoFallbackUrl(redirectPath));
};

/**
 * Surfaces one persistent notice when the active organization requires an
 * SSO-created session, letting the member re-authenticate into that
 * organization without signing out of their other organizations.
 */
export const notifySsoSignInRequired = (error: unknown): boolean => {
  if (
    !isSsoSignInRequiredError(error) ||
    isAuthFlowPathname(window.location.pathname)
  ) {
    return false;
  }
  const t = getTranslator();
  stellaToast.add({
    id: SSO_REQUIRED_TOAST_ID,
    title: t("auth.sso.signInRequiredTitle"),
    description: t("auth.sso.signInRequiredDescription"),
    type: "warning",
    timeout: 0,
    action: {
      label: t("auth.sso.continueWithSso"),
      onClick: () => {
        detached(startOrganizationSsoReauth(), "sso.reauth");
      },
    },
  });
  return true;
};
