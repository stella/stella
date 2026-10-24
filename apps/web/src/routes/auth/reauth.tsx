import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { redirectToSchema } from "@/lib/redirect";

export const Route = createFileRoute("/auth/reauth")({
  validateSearch: v.object({ redirectTo: redirectToSchema }),
  component: Reauthenticate,
});

function Reauthenticate() {
  const t = useTranslations();
  const redirectTo = Route.useSearch({ select: (search) => search.redirectTo });
  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <p>{t("auth.reauthenticationRequired")}</p>
      <SignInPanel mode={SIGN_IN_MODE.reauthenticate} redirectTo={redirectTo} />
    </div>
  );
}
