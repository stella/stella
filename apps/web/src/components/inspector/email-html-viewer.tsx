import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";

import { emailHtmlPreviewOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";

type EmailHtmlViewerProps = {
  fieldId: string;
  workspaceId: string;
};

export const EmailHtmlViewer = ({
  fieldId,
  workspaceId,
}: EmailHtmlViewerProps) => {
  const t = useTranslations();
  const previewQuery = useQuery(
    emailHtmlPreviewOptions({ workspaceId, fieldId }),
  );

  if (previewQuery.isPending) {
    return (
      <div className="bg-muted/30 flex min-h-0 flex-1 flex-col gap-2 p-3">
        <Skeleton className="h-8 w-full rounded-sm" />
        <Skeleton className="min-h-0 flex-1 rounded-sm" />
      </div>
    );
  }

  if (previewQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangleIcon className="text-foreground-disabled size-8" />
        <p className="text-muted-foreground text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button
          onClick={() => {
            void previewQuery.refetch();
          }}
          size="sm"
          variant="outline"
        >
          {t("common.tryAgain")}
        </Button>
      </div>
    );
  }

  return (
    <iframe
      className="bg-background size-full border-0"
      referrerPolicy="no-referrer"
      sandbox=""
      srcDoc={previewQuery.data.html}
      title={previewQuery.data.fileName}
    />
  );
};
