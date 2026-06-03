import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { SignInPanel } from "@/components/auth/sign-in-panel";
import { pageTitle } from "@/lib/page-title";
import { redirectToSchema } from "@/lib/redirect";

const searchSchema = v.strictObject({
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/")({
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
  head: () => ({
    meta: [{ title: pageTitle("auth.signIn") }],
  }),
  component: LoginOrSignup,
});

function LoginOrSignup() {
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo });

  return <SignInPanel redirectTo={redirectTo} />;
}
