import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

export const InspectorPdfErrorFallback = ({
  onRetry,
}: {
  onRetry?: (() => void) | undefined;
}) => {
  const t = useTranslations();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangleIcon className="text-foreground-disabled size-8" />
      <p className="text-muted-foreground text-sm">
        {t("common.somethingWentWrong")}
      </p>
      {onRetry && (
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.tryAgain")}
        </Button>
      )}
    </div>
  );
};
