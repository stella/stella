import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";
import { APIError } from "@/lib/errors/api";
import { isAuthFlowPathname, normalizeRedirectTo } from "@/lib/redirect";

const SSO_SIGN_IN_REQUIRED_CODE = "sso_sign_in_required";
const SSO_REQUIRED_TOAST_ID = "sso-sign-in-required";

export const isSsoSignInRequiredError = (error: unknown): boolean =>
  APIError.is(error) &&
  error.status === 403 &&
  error.code === SSO_SIGN_IN_REQUIRED_CODE;

const buildSsoReauthUrl = (redirectPath: string): string =>
  `/auth?sso=required&redirectTo=${encodeURIComponent(redirectPath)}`;

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
        const redirectPath = normalizeRedirectTo(
          window.location.pathname + window.location.search,
        );
        window.location.assign(buildSsoReauthUrl(redirectPath));
      },
    },
  });
  return true;
};
