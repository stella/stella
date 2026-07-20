import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";

import { detached } from "@/lib/detached";
import { redirectToSchema } from "@/lib/redirect";

const searchSchema = v.object({
  error: v.optional(v.string()),
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/error")({
  validateSearch: searchSchema,
  component: AuthError,
});

function AuthError() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { error, redirectTo } = Route.useSearch({
    select: (s) => ({ error: s.error, redirectTo: s.redirectTo }),
  });

  // Resolve with literal translation keys: a dynamic key lookup both trips the
  // typed translator's arity overload and risks Object.prototype keys via the
  // untrusted `error` query param.
  const message =
    error === "account_not_linked"
      ? t("auth.error.accountNotLinked")
      : t("auth.error.generic");

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.error.title")}</FrameTitle>
        <FrameDescription>{message}</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Button
          className="w-full"
          onClick={() => {
            detached(
              navigate({ to: "/auth", search: { redirectTo } }),
              "AuthError",
            );
          }}
        >
          {t("common.tryAgain")}
        </Button>
      </FramePanel>
    </Frame>
  );
}
