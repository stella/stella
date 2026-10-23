import * as v from "valibot";

import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";
import type { SignInMode } from "@/components/auth/sign-in-mode";
import { afterSignInNavigation, redirectToSchema } from "@/lib/redirect";
import { emailSchema } from "@/lib/schema";
import { routeSearchSchema } from "@/route-search-params";

export const otpSearchSchema = routeSearchSchema({
  mode: v.optional(
    v.picklist(Object.values(SIGN_IN_MODE)),
    SIGN_IN_MODE.signIn,
  ),
  email: v.optional(emailSchema()),
  redirectTo: redirectToSchema,
});

type OtpSessionNavigationOptions = {
  mode: SignInMode;
  session: "present" | "absent";
  redirectTo: string;
};

export const otpSessionNavigation = ({
  mode,
  session,
  redirectTo,
}: OtpSessionNavigationOptions) => {
  if (session === "absent" || mode === SIGN_IN_MODE.reauthenticate) {
    return undefined;
  }
  return afterSignInNavigation(redirectTo);
};
