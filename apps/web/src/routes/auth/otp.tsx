import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as v from "valibot";

import { OTPPanel } from "@/components/auth/otp-panel";
import { fetchDevOtp } from "@/lib/dev-otp";
import { afterSignInNavigation, redirectToSchema } from "@/lib/redirect";
import { routeSearchSchema } from "@/lib/route-search-params";
import { emailSchema } from "@/lib/schema";

const searchSchema = routeSearchSchema({
  email: v.optional(emailSchema()),
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/otp")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ email: search.email }),
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      throw redirect({
        to: "/auth/organization",
        search: { redirectTo: search.redirectTo },
        replace: true,
      });
    }
    // A code goes to an address; without one there is nothing to enter
    // here, so the reader starts the sign-in again.
    if (search.email === undefined) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: search.redirectTo },
        replace: true,
      });
    }
    return { otpEmail: search.email };
  },
  loader: async ({ context }) => ({
    devOtp: await fetchDevOtp(context.otpEmail),
  }),
  component: OTP,
});

function OTP() {
  const navigate = useNavigate();
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo });
  const email = Route.useRouteContext({ select: (c) => c.otpEmail });
  const devOtp = Route.useLoaderData({ select: (d) => d.devOtp });

  const handleVerified = async () => {
    await navigate(afterSignInNavigation(redirectTo));
  };

  return (
    <OTPPanel
      email={email}
      initialOtp={devOtp ?? undefined}
      onVerified={handleVerified}
      redirectTo={redirectTo}
    />
  );
}
