import { Loader2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { useIsCreatingBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-b-boxes";

export const CreatingBBoxes = () => {
  const t = useTranslations();
  const isCreatingBoundingBoxes = useIsCreatingBBoxes();

  if (!isCreatingBoundingBoxes) {
    return null;
  }

  return (
    <div className="sticky top-2 z-10 ms-3 mt-2 flex w-max items-center gap-1.5 rounded-md bg-muted px-1.5 py-1 text-xs">
      <Loader2Icon className="size-3 animate-spin" />
      <span>{t("workspaces.generatingCitations")}</span>
    </div>
  );
};
