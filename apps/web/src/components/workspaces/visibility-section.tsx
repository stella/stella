import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { MatterVisibility } from "@stll/api-contract/matter-visibility";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { CONTROL_SIZE } from "@stll/ui/control-size";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { MatterVisibilitySelect } from "@/components/workspaces/matter-visibility-select";
import {
  canChangeMatterVisibility,
  MATTER_VISIBILITY_WIDENING_AUDIENCE,
  matterVisibilityChange,
} from "@/components/workspaces/matter-visibility.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import type { WorkspaceUpdate } from "@/lib/workspaces/mutations";
import { workspaceOptions } from "@/lib/workspaces/queries";

type VisibilitySectionProps = {
  workspaceId: string;
};

export const VisibilitySection = ({ workspaceId }: VisibilitySectionProps) => {
  const t = useTranslations();
  const { id: userId } = useAuthenticatedUser();
  const canUpdateMatters = usePermissions({ workspace: ["update"] });
  const roleView = queryView(useQuery(roleOptions));
  useQueryViewError(roleView, "VisibilitySection:role");
  const workspaceView = queryView(useQuery(workspaceOptions(workspaceId)));
  const updateWorkspace = useUpdateWorkspace();

  switch (workspaceView.type) {
    case "pending":
    case "error":
      return (
        <section className="border-b px-3 py-2">
          <span className="text-muted-foreground text-sm font-medium">
            {t("workspaces.visibility.label")}
          </span>
          <QueryViewFeedback view={workspaceView} />
        </section>
      );
    case "empty":
      return null;
    case "items":
      break;
    default:
      workspaceView satisfies never;
      return panic("Unhandled matter visibility read state");
  }
  const workspace = workspaceView.items;
  const role =
    roleView.type === "items" && roleView.refetchError === undefined
      ? roleView.items
      : undefined;

  return (
    <MatterVisibilityField
      editable={canChangeMatterVisibility({
        canUpdateMatters,
        role,
        userId,
        leadUserId: workspace.leadUserId,
      })}
      updateWorkspace={updateWorkspace}
      visibility={workspace.visibility}
      workspaceId={workspaceId}
    />
  );
};

type MatterVisibilityMutation = Pick<
  ReturnType<typeof useUpdateWorkspace>,
  "mutate" | "isPending"
>;

type WideningConfirmation =
  | { type: "closed" }
  | {
      type: "confirming";
      visibility: keyof typeof MATTER_VISIBILITY_WIDENING_AUDIENCE;
    };

type MatterVisibilityFieldProps = {
  editable: boolean;
  updateWorkspace: MatterVisibilityMutation;
  visibility: MatterVisibility;
  workspaceId: string;
};

/**
 * Narrowing applies at once; widening shows the matter to people who cannot
 * see it now, so it names them and waits for confirmation first.
 */
export const MatterVisibilityField = ({
  editable,
  updateWorkspace,
  visibility,
  workspaceId,
}: MatterVisibilityFieldProps) => {
  const t = useTranslations();
  const [widening, setWidening] = useState<WideningConfirmation>({
    type: "closed",
  });

  const save = (update: Extract<WorkspaceUpdate, { type: "visibility" }>) => {
    updateWorkspace.mutate(
      { workspaceId, update },
      {
        onSuccess: () => {
          setWidening({ type: "closed" });
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleChange = (next: MatterVisibility) => {
    const change = matterVisibilityChange({ from: visibility, to: next });
    switch (change.type) {
      case "unchanged":
        return;
      case "narrow":
        save({ type: "visibility", value: change.visibility });
        return;
      case "widen":
        setWidening({ type: "confirming", visibility: change.visibility });
        return;
      default:
        change satisfies never;
        panic(`Unhandled matter visibility change: ${String(change)}`);
    }
  };

  return (
    <>
      <section
        className={cn(
          "grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <TruncatedText className="text-muted-foreground text-sm font-medium">
          {t("workspaces.visibility.label")}
        </TruncatedText>
        <MatterVisibilitySelect
          disabled={!editable || updateWorkspace.isPending}
          label={t("workspaces.visibility.label")}
          onValueChange={handleChange}
          size={CONTROL_SIZE.sm}
          value={visibility}
        />
      </section>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !updateWorkspace.isPending) {
            setWidening({ type: "closed" });
          }
        }}
        open={widening.type === "confirming"}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.visibility.widenTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {widening.type === "confirming" &&
                t(MATTER_VISIBILITY_WIDENING_AUDIENCE[widening.visibility])}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={updateWorkspace.isPending}
              render={<Button variant="outline" />}
            >
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              loading={updateWorkspace.isPending}
              onClick={() => {
                if (widening.type === "confirming") {
                  save({
                    type: "visibility",
                    value: widening.visibility,
                    confirmWidening: true,
                  });
                }
              }}
            >
              {t("workspaces.visibility.widenConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
