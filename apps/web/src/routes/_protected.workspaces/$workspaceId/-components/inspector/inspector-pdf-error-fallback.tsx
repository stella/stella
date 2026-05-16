import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";

export const InspectorPdfErrorFallback = ({
  onClose,
  onRetry,
}: {
  onClose: () => void;
  onRetry?: (() => void) | undefined;
}) => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center justify-end border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button onClick={onClose} size="icon-xs" variant="ghost">
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
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
    </div>
  );
};
