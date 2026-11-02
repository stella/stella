import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";
import { APIError, isAuthRefusal } from "@/lib/errors/api";
import { AuthClientError } from "@/lib/errors/auth";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { isAuthFlowPathname, normalizeRedirectTo } from "@/lib/redirect";

const SESSION_EXPIRED_TOAST_ID = "session-expired";
const UNAUTHORIZED_STATUS = 401;

// Whether this page has held a member. A visitor who never signed in has no
// session to lose, and the flag outlives the session read that comes back null.
let memberSeen = false;

export const resetSessionExpiredNoticeForTests = (): void => {
  memberSeen = false;
};

export const setSessionMemberSeen = (seen: boolean): void => {
  memberSeen = seen;
};

export const closeSessionExpiredNotice = (): void => {
  stellaToast.close(SESSION_EXPIRED_TOAST_ID);
};

const isSessionRejection = (error: unknown): boolean =>
  (APIError.is(error) || AuthClientError.is(error)) &&
  error.status === UNAUTHORIZED_STATUS &&
  isAuthRefusal(error);

const openSignIn = () => {
  const path = normalizeRedirectTo(
    window.location.pathname + window.location.search,
  );
  // A new tab, so whatever is typed on this page stays there.
  openIsolatedWindow(`/auth?redirectTo=${encodeURIComponent(path)}`);
};

/**
 * Shows the one notice for every failure of an expired session and answers
 * whether it did, so the caller drops its own toast. The page is left alone:
 * nothing navigates and nothing runs again, the person decides when to save.
 */
export const notifySessionExpired = (error: unknown): boolean => {
  if (
    !memberSeen ||
    !isSessionRejection(error) ||
    isAuthFlowPathname(window.location.pathname)
  ) {
    return false;
  }
  const t = getTranslator();
  stellaToast.add({
    id: SESSION_EXPIRED_TOAST_ID,
    title: t("auth.sessionExpired"),
    description: t("auth.sessionExpiredDescription"),
    type: "warning",
    timeout: 0,
    action: { label: t("auth.signIn"), onClick: openSignIn },
  });
  return true;
};
