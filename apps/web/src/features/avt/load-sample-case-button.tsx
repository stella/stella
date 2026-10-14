import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useLoadSampleCase } from "@/features/avt/use-load-sample-case";
import { usePermissions } from "@/hooks/use-permissions";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";

/** Loads the sample case into this matter and points the view at its facts. */
export const LoadSampleCaseButton = ({
  view,
  workspaceId,
}: {
  view: AvtWorkspaceView;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const canCreate = usePermissions({ view: ["create"], entity: ["create"] });
  const loadSampleCase = useLoadSampleCase({ view, workspaceId });

  if (!canCreate) {
    return null;
  }

  return (
    <Button
      disabled={loadSampleCase.isPending}
      onClick={() => loadSampleCase.mutate()}
      variant="outline"
    >
      {t("avt.view.loadSample")}
    </Button>
  );
};
