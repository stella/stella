import { SSO_SIGN_IN_REQUIRED_CODE } from "@stll/api-contract/sso";
import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { isAuthFlowPathname, normalizeRedirectTo } from "@/lib/redirect";
import {
  readMemberOrganizationSsoProviders,
  requestSsoSignInRedirectUrl,
} from "@/lib/sso/sso-client";

const SSO_REQUIRED_TOAST_ID = "sso-sign-in-required";

export const isSsoSignInRequiredError = (error: unknown): boolean =>
  APIError.is(error) &&
  error.status === 403 &&
  error.code === SSO_SIGN_IN_REQUIRED_CODE;

const startOrganizationSsoReauth = async () => {
  const redirectPath = normalizeRedirectTo(
    window.location.pathname + window.location.search,
  );
  const callbackURL = `${window.location.origin}${redirectPath}`;
  const errorCallbackURL = `${window.location.origin}/auth?redirectTo=${encodeURIComponent(redirectPath)}`;

  try {
    const { providers } = await readMemberOrganizationSsoProviders();
    const first = providers.at(0);
    if (first === undefined) {
      window.location.assign(
        `/auth?redirectTo=${encodeURIComponent(redirectPath)}`,
      );
      return;
    }
    const redirect = await requestSsoSignInRedirectUrl({
      providerId: first.providerId,
      callbackURL,
      errorCallbackURL,
    });
    if (redirect.isOk()) {
      window.location.assign(redirect.value);
      return;
    }
  } catch {
    // Fall back to the sign-in screen so the user can still complete SSO.
  }
  window.location.assign(
    `/auth?redirectTo=${encodeURIComponent(redirectPath)}`,
  );
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
