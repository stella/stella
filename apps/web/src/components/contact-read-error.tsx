import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

type ContactReadErrorProps = {
  error: unknown;
  onRetry: () => void;
};

export const ContactReadError = ({ error, onRetry }: ContactReadErrorProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    analytics.captureError(error);
  }, [analytics, error]);
  return (
    <div className="flex items-center gap-2 p-3" role="alert">
      <p className="text-destructive text-sm">
        {userErrorFromThrown(error, t("errors.actionFailed"))}
      </p>
      <Button onClick={onRetry} variant="outline">
        {t("common.retry")}
      </Button>
    </div>
  );
};
