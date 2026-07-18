import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { TwoFactorPanel } from "@/components/auth/two-factor-panel";
import { redirectToSchema } from "@/lib/redirect";

const searchSchema = v.strictObject({
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/two-factor")({
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
  component: TwoFactor,
});

function TwoFactor() {
  return <TwoFactorPanel />;
}
