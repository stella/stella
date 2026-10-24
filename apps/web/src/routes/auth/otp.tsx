import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { OTPPanel } from "@/components/auth/otp-panel";
import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";
import { detached } from "@/lib/detached";
import { fetchDevOtp } from "@/lib/dev-otp";
import { afterSignInNavigation } from "@/lib/redirect";

import { otpSearchSchema, otpSessionNavigation } from "./-otp.logic";

export const Route = createFileRoute("/auth/otp")({
  validateSearch: otpSearchSchema,
  loaderDeps: ({ search }) => ({ email: search.email }),
  beforeLoad: ({ context, search }) => {
    const navigation = otpSessionNavigation({
      mode: search.mode,
      session: context.session ? "present" : "absent",
      redirectTo: search.redirectTo,
    });
    if (navigation) {
      redirect({ ...navigation, throw: true });
    }
  },
  loader: async ({ deps }) => ({ devOtp: await fetchDevOtp(deps.email) }),
  component: OTP,
});

function OTP() {
  const navigate = useNavigate();
  const { email, redirectTo, mode } = Route.useSearch({
    select: (s) => ({ email: s.email, redirectTo: s.redirectTo, mode: s.mode }),
  });
  const devOtp = Route.useLoaderData({ select: (d) => d.devOtp });

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
    <OTPPanel
      email={email}
      initialOtp={devOtp ?? undefined}
      onUseDifferentEmail={() =>
        detached(handleUseDifferentEmail(), "otp.use-different-email")
      }
      onVerified={handleVerified}
      redirectTo={redirectTo}
    />
  );
}
