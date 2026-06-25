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

import type { TranslationKey } from "@/i18n/types";
import { redirectToSchema } from "@/lib/redirect";

const searchSchema = v.object({
  error: v.optional(v.string()),
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/error")({
  validateSearch: searchSchema,
  component: AuthError,
});

const ERROR_MESSAGE_KEYS: Record<string, TranslationKey> = {
  account_not_linked: "auth.error.accountNotLinked",
};

const GENERIC_ERROR_KEY: TranslationKey = "auth.error.generic";

function AuthError() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { error, redirectTo } = Route.useSearch({
    select: (s) => ({ error: s.error, redirectTo: s.redirectTo }),
  });

  const messageKey = (error && ERROR_MESSAGE_KEYS[error]) ?? GENERIC_ERROR_KEY;

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.error.title")}</FrameTitle>
        <FrameDescription>{t(messageKey)}</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Button
          className="w-full"
          onClick={() => {
            void navigate({ to: "/auth", search: { redirectTo } });
          }}
        >
          {t("auth.error.tryAgain")}
        </Button>
      </FramePanel>
    </Frame>
  );
}
