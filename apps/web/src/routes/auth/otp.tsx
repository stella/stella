import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { OTPPanel } from "@/components/auth/otp-panel";
import { fetchDevOtp } from "@/lib/dev-otp";
import { redirectToSchema } from "@/lib/redirect";
import { emailSchema } from "@/lib/schema";

const searchSchema = v.strictObject({
  email: emailSchema(),
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
  },
  loader: async ({ deps }) => ({ devOtp: await fetchDevOtp(deps.email) }),
  component: OTP,
});

function OTP() {
  const { email, redirectTo } = Route.useSearch({
    select: (s) => ({ email: s.email, redirectTo: s.redirectTo }),
  });
  const devOtp = Route.useLoaderData({ select: (d) => d.devOtp });

  return (
    <OTPPanel
      email={email}
      initialOtp={devOtp ?? undefined}
      redirectTo={redirectTo}
    />
  );
}
