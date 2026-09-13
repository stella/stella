import { useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { usePublicSignInRequest } from "@/components/public-sign-in-request";

/**
 * What a reader without an account is told about the marks they are leaving:
 * this tab holds them, and an account keeps them. Renders nothing until there
 * is something to lose.
 */
export const GuestAnnotationPrompt = ({
  className,
  count,
}: {
  className?: string | undefined;
  count: number;
}) => {
  const t = useTranslations();
  const requestSignIn = usePublicSignInRequest();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  if (count === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "bg-muted text-muted-foreground flex min-h-11 items-center justify-center gap-3 border-b px-4 py-2 text-center text-xs",
        className,
      )}
      role="status"
    >
      <span>{t("legalReader.annotations.guestSavePrompt")}</span>
      {requestSignIn !== null && (
        <Button
          className="shrink-0"
          onClick={() => requestSignIn(currentHref)}
          size="sm"
          variant="outline"
        >
          {t("legalReader.annotations.createFreeAccount")}
        </Button>
      )}
    </div>
  );
};
