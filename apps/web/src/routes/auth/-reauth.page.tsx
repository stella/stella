import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";
import { SignInPanel } from "@/components/auth/sign-in-panel";

import { ReauthenticateShell } from "./-reauth.pending";

const route = getRouteApi("/auth/reauth");

export function ReauthenticatePage() {
  const t = useTranslations();
  const redirectTo = route.useSearch({ select: (search) => search.redirectTo });
  return (
    <ReauthenticateShell message={t("auth.reauthenticationRequired")}>
      <SignInPanel mode={SIGN_IN_MODE.reauthenticate} redirectTo={redirectTo} />
    </ReauthenticateShell>
  );
}
