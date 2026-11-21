import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { usePermissions } from "@/hooks/use-permissions";

export const EvidenceListEmptyState = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useTranslations();
  const canCreateList = usePermissions({ view: ["create"] });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-muted-foreground text-sm">{t("avt.view.noLists")}</p>
      {canCreateList && (
        <Button
          render={
            <Link
              params={{ workspaceId }}
              to="/workspaces/$workspaceId/lists"
            />
          }
        >
          {t("avt.view.createList")}
        </Button>
      )}
    </div>
  );
};
