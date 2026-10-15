import { useTranslations } from "use-intl";

import { Loader } from "@stll/ui/loader";

import { useIsCreatingBBoxes } from "@/components/workspaces/hooks/use-create-b-boxes";

export const CreatingBBoxes = () => {
  const t = useTranslations();
  const isCreatingBoundingBoxes = useIsCreatingBBoxes();

  if (!isCreatingBoundingBoxes) {
    return null;
  }

  return (
    <div
      aria-busy="true"
      className="bg-muted sticky top-2 z-10 ms-3 mt-2 flex w-max items-center gap-1.5 rounded-md px-1.5 py-1 text-xs"
      role="status"
    >
      <Loader className="size-3" size="sm" variant="decorative" />
      <span>{t("workspaces.generatingCitations")}</span>
    </div>
  );
};
