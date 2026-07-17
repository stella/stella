import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/components/sheet";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import type { PlaybookVersionItem } from "@/routes/_protected.knowledge/-components/playbook-types";
import {
  knowledgeKeys,
  playbookVersionsOptions,
} from "@/routes/_protected.knowledge/-queries";

type PlaybookVersionHistorySheetProps = {
  onOpenChange: (open: boolean) => void;
  // Called once a restore has succeeded and the detail/versions/list queries
  // have been invalidated, so the editor can pick up the restored draft.
  onRestored: () => void;
  open: boolean;
  organizationId: string;
  playbookId: string;
};

export const PlaybookVersionHistorySheet = (
  props: PlaybookVersionHistorySheetProps,
) => (
  <Sheet onOpenChange={props.onOpenChange} open={props.open}>
    {props.open ? <PlaybookVersionHistorySheetBody {...props} /> : null}
  </Sheet>
);

const SKELETON_ROW_KEYS = ["a", "b", "c"];

const PlaybookVersionHistorySheetBody = ({
  onOpenChange,
  onRestored,
  organizationId,
  playbookId,
}: PlaybookVersionHistorySheetProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(
    playbookVersionsOptions(organizationId, playbookId),
  );
  const versions = data ? data.items : [];

  const restore = useMutation({
    mutationFn: async (version: number) => {
      const response = await api
        .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
        .versions({ version })
        .restore.post();

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: async () => {
      // The definition (detail), its version list, and the playbook list
      // badge all share the `playbooks.all` prefix, so one invalidation
      // covers all three.
      await queryClient.invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(organizationId),
      });
      stellaToast.add({
        title: t("knowledge.playbooks.versions.restoredToast"),
        type: "success",
      });
      onRestored();
      onOpenChange(false);
    },
    onError: (error) => {
      stellaToast.add({
        description: userErrorFromThrown(error, t("common.unexpectedError")),
        title: t("knowledge.playbooks.versions.restoreFailed"),
        type: "error",
      });
    },
  });

  return (
    <SheetPopup side="inline-end">
      <SheetHeader>
        <SheetTitle>
          {t("knowledge.playbooks.versions.versionHistory")}
        </SheetTitle>
      </SheetHeader>
      <SheetPanel>
        <div className="flex flex-col gap-2">
          {isLoading &&
            SKELETON_ROW_KEYS.map((key) => (
              <Skeleton className="h-14 w-full rounded-lg" key={key} />
            ))}

          {!isLoading && versions.length === 0 && (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("common.noVersions")}
            </p>
          )}

          {!isLoading &&
            versions.map((version) => (
              <VersionRow
                key={version.version}
                onRestore={() => restore.mutate(version.version)}
                restoring={
                  restore.isPending && restore.variables === version.version
                }
                version={version}
              />
            ))}
        </div>
      </SheetPanel>
    </SheetPopup>
  );
};

const VersionRow = ({
  version,
  onRestore,
  restoring,
}: {
  version: PlaybookVersionItem;
  onRestore: () => void;
  restoring: boolean;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const canRestore = usePermissions({ playbook: ["update"] });
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="border-border flex items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" dir="auto">
          {t("common.versionLabel", { version: String(version.version) })}
          {" — "}
          {version.name}
        </p>
        <p className="text-muted-foreground text-xs">
          {format.dateTime(new Date(version.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      </div>
      {canRestore && (
        <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <Button
            aria-label={t("common.restore")}
            onClick={() => setConfirmOpen(true)}
            size="sm"
            variant="outline"
          >
            <RotateCcwIcon />
            {t("common.restore")}
          </Button>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("common.restore")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("knowledge.playbooks.versions.confirmRestore")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </AlertDialogClose>
              <Button
                disabled={restoring}
                loading={restoring}
                onClick={() => {
                  setConfirmOpen(false);
                  onRestore();
                }}
                variant="destructive"
              >
                {t("common.restore")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </div>
  );
};
