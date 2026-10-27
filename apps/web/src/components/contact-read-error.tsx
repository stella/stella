import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type ContactReadErrorProps = {
  error: unknown;
  onRetry: () => void;
  fallbackKey?: TranslationKey;
  retryDisabled?: boolean;
};

export const ContactReadError = ({
  error,
  onRetry,
  fallbackKey = "errors.actionFailed",
  retryDisabled = false,
}: ContactReadErrorProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    analytics.captureError(error, {
      fingerprintKey: "ContactReadError:failure",
      scope: { type: "handler", handlerId: "ContactReadError:failure" },
    });
  }, [analytics, error]);
  return (
    <div className="flex items-center gap-2 p-3" role="alert">
      <p className="text-destructive text-sm">
        {userErrorFromThrown(error, t(fallbackKey))}
      </p>
      <Button disabled={retryDisabled} onClick={onRetry} variant="outline">
        {t("common.retry")}
      </Button>
    </div>
  );
};
