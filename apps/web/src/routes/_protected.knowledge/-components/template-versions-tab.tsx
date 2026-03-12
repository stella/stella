import { useCallback, useEffect, useRef, useState } from "react";

import { DownloadIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

// ── Types ────────────────────────────────────────────

type VersionItem = {
  id: string;
  version: number;
  fieldCount: number;
  createdAt: Date;
};

type TemplateVersionsTabProps = {
  templateId: string;
};

// ── Component ────────────────────────────────────────

export const TemplateVersionsTab = ({
  templateId,
}: TemplateVersionsTabProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) {
      return;
    }
    fetchedRef.current = true;

    const load = async () => {
      const response = await api.templates({ templateId }).versions.get();

      setLoading(false);

      if (response.error) {
        toastManager.add({
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

      if ("versions" in data && Array.isArray(data.versions)) {
        setVersions(data.versions);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    load();
  }, [templateId, t]);

  const handleView = useCallback(
    async (versionId: string) => {
      const response = await api
        .templates({ templateId })
        .versions({ versionId })
        .get();

      if (response.error) {
        toastManager.add({
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

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("clauses.loading")}</p>
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
                // eslint-disable-next-line typescript/no-misused-promises
                onClick={async () => await handleView(ver.id)}
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
