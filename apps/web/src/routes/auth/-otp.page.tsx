import { getRouteApi, useNavigate } from "@tanstack/react-router";

import { OTPPanelBody } from "@/components/auth/otp-panel";
import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";
import { detached } from "@/lib/detached";
import { afterSignInNavigation } from "@/lib/redirect";

import { OTPRouteShell } from "./-otp.pending";

const route = getRouteApi("/auth/otp");

export function OTPPage() {
  const navigate = useNavigate();
  const { redirectTo, mode, signInAttempt } = route.useSearch({
    select: (s) => ({
      redirectTo: s.redirectTo,
      mode: s.mode,
      signInAttempt: s.signInAttempt,
    }),
  });
  const email = route.useRouteContext({ select: (c) => c.otpEmail });
  const devOtp = route.useLoaderData({ select: (d) => d.devOtp });

  const handleUseDifferentEmail = async () => {
    await navigate({
      to: mode === SIGN_IN_MODE.reauthenticate ? "/auth/reauth" : "/auth",
      search: { redirectTo },
      replace: true,
    });
  };

  const handleVerified = async () => {
    await navigate(afterSignInNavigation(redirectTo));
  };

  return (
    <OTPRouteShell>
      <OTPPanelBody
        signInAttempt={signInAttempt}
        email={email}
        initialOtp={devOtp ?? undefined}
        onUseDifferentEmail={() =>
          detached(handleUseDifferentEmail(), "otp.use-different-email")
        }
        onVerified={handleVerified}
        redirectTo={redirectTo}
      />
    </OTPRouteShell>
  );
}
