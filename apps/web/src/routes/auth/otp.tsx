import { createFileRoute, redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";
import { fetchDevOtp } from "@/lib/dev-otp";

import { otpSearchSchema, otpSessionNavigation } from "./-otp.logic";
import { OTPPage } from "./-otp.page";
import { OTPPending } from "./-otp.pending";

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
    if (search.email === undefined) {
      redirect({
        to:
          search.mode === SIGN_IN_MODE.reauthenticate
            ? "/auth/reauth"
            : "/auth",
        search: { redirectTo: search.redirectTo },
        replace: true,
        throw: true,
      });
      return panic("TanStack Router did not throw the sign-in redirect.");
    }
    return { otpEmail: search.email };
  },
  loader: async ({ context }) => ({
    devOtp: await fetchDevOtp(context.otpEmail),
  }),
  component: OTPPage,
  pendingComponent: OTPPending,
});
