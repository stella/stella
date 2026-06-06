import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { OTPPanel } from "@/components/auth/otp-panel";
import { redirectToSchema } from "@/lib/redirect";
import { emailSchema } from "@/lib/schema";

const searchSchema = v.strictObject({
  email: emailSchema(),
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/otp")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      throw redirect({
        to: "/auth/organization",
        search: { redirectTo: search.redirectTo },
        replace: true,
      });
    }
  },
  component: OTP,
});

function OTP() {
  const { email, redirectTo } = Route.useSearch({
    select: (s) => ({ email: s.email, redirectTo: s.redirectTo }),
  });

  return <OTPPanel email={email} redirectTo={redirectTo} />;
}
