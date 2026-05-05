import { useCallback } from "react";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { templateVersionsOptions } from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────

type TemplateVersionsTabProps = {
  templateId: string;
};

// ── Component ────────────────────────────────────────

export const TemplateVersionsTab = ({
  templateId,
}: TemplateVersionsTabProps) => {
  const t = useTranslations();
  const format = useFormatter();

  const {
    data: versionsData,
    isLoading,
    isError,
  } = useQuery(templateVersionsOptions(templateId));

  const versions =
    versionsData && "versions" in versionsData ? versionsData.versions : [];

  const handleView = useCallback(
    async (versionId: string) => {
      const response = await api
        .templates({ templateId })
        .versions({ versionId })
        .get();

      if (response.error) {
        stellaToast.add({
          type: "error",
          title: t("templates.loadFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      const { data } = response;
      if (data instanceof Response) {
        return;
      }

      if ("downloadUrl" in data && typeof data.downloadUrl === "string") {
        window.open(data.downloadUrl, "_blank");
      }
    },
    [templateId, t],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.loadFailed")}
        </p>
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground mt-4 py-4 text-center text-sm">
        {t("templates.versionsEmpty")}
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-lg border">
      <ul className="divide-y">
        {versions.map((ver) => (
          <li
            className="flex items-center justify-between px-4 py-3 text-sm"
            key={ver.id}
          >
            <div>
              <span className="font-medium">
                {t("templates.versionLabel", {
                  version: String(ver.version),
                })}
              </span>
              <span className="text-muted-foreground ms-2">
                {t("templates.fieldCount", {
                  count: ver.fieldCount,
                })}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">
                {format.dateTime(new Date(ver.createdAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              <Button
                onClick={() => {
                  void handleView(ver.id);
                }}
                size="icon-xs"
                variant="ghost"
              >
                <DownloadIcon className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
