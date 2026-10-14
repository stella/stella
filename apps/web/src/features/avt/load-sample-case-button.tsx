import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useLoadSampleCase } from "@/features/avt/use-load-sample-case";
import { usePermissions } from "@/hooks/use-permissions";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";
import { mergeLayout } from "@/lib/workspaces/view-layout";

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
  const loadSampleCase = useLoadSampleCase(workspaceId);
  const updateView = useUpdateView(workspaceId);

  if (!canCreate) {
    return null;
  }

  return (
    <Button
      disabled={loadSampleCase.isPending}
      onClick={() => {
        loadSampleCase.mutate(undefined, {
          onSuccess: ({ listId, documentMissing }) => {
            if (documentMissing) {
              notifyUserError(null, t("avt.view.loadSampleFailed"));
            }
            updateView.mutate({
              viewId: view.id,
              layout: mergeLayout(view.layout, {
                listId: toSafeId<"legalList">(listId),
              }),
            });
          },
          onError: (error) => {
            notifyUserError(error, t("avt.view.loadSampleFailed"));
          },
        });
      }}
      variant="outline"
    >
      {t("avt.view.loadSample")}
    </Button>
  );
};
