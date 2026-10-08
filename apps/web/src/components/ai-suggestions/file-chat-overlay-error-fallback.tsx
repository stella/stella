import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { isStaleDeploymentLoadError } from "@/lib/preload-error-recovery";

type FileChatOverlayErrorFallbackProps = {
  error: Error;
  onRetry: () => void;
};

/**
 * Says which part of the page failed. A chunk removed by a deploy cannot be
 * fetched again by the old page, so that case offers a reload; anything else
 * offers a fresh attempt.
 */
export const FileChatOverlayErrorFallback = ({
  error,
  onRetry,
}: FileChatOverlayErrorFallbackProps) => {
  const t = useTranslations();
  const staleDeployment = isStaleDeploymentLoadError(error);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <div
        className="bg-background/95 pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 shadow-sm"
        role="alert"
      >
        <span className="text-muted-foreground text-sm">
          {staleDeployment
            ? t("chat.overlayUpdated")
            : t("chat.overlayLoadFailed")}
        </span>
        {staleDeployment ? (
          <Button
            onClick={() => {
              window.location.reload();
            }}
            size="sm"
            variant="outline"
          >
            {t("common.reload")}
          </Button>
        ) : (
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("common.tryAgain")}
          </Button>
        )}
      </div>
    </div>
  );
};
