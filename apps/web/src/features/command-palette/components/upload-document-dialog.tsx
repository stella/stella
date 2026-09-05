import { useDeferredValue, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { SearchIcon, UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";

import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { useEntitiesCountLimit } from "@/components/workspaces/hooks/use-limits";
import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type UploadDocumentDialogProps = {
  onClose: () => void;
  workspaceId?: string | undefined;
};

type MatterOption = {
  id: string;
  name: string;
  clientName: string | null;
};

export const UploadDocumentDialog = ({
  onClose,
  workspaceId,
}: UploadDocumentDialogProps) => {
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId);
  const [matterSearch, setMatterSearch] = useState("");
  const deferredMatterSearch = useDeferredValue(matterSearch);
  const { data, error, isPending, refetch } = useQuery({
    ...workspacesNavigationOptions(activeOrganizationId),
    enabled: workspaceId === undefined,
  });

  const matters: MatterOption[] =
    data?.workspaces.map((matter) => ({
      clientName: matter.client?.displayName ?? null,
      id: matter.id,
      name: matter.name,
    })) ?? [];
  const filteredMatters = matters.filter((matter) => {
    const search = deferredMatterSearch.trim().toLocaleLowerCase();
    return (
      search.length === 0 ||
      matter.name.toLocaleLowerCase().includes(search) ||
      matter.clientName?.toLocaleLowerCase().includes(search)
    );
  });
  const selectedMatter = matters.find(
    (matter) => matter.id === selectedWorkspaceId,
  );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspaces.kanban.uploadDocument")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {workspaceId ? (
            <p className="text-sm">
              <BidiText>{selectedMatter?.name ?? t("common.loading")}</BidiText>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="upload-matter">
                {t("common.selectAMatter")}
              </label>
              <Combobox
                itemToStringLabel={(matter) => matter.name}
                onInputValueChange={setMatterSearch}
                onValueChange={(matter) => setSelectedWorkspaceId(matter?.id)}
                value={selectedMatter ?? null}
              >
                <ComboboxInput
                  id="upload-matter"
                  placeholder={t("common.selectAMatter")}
                  showClear={matterSearch.length > 0}
                  startAddon={<SearchIcon />}
                  value={matterSearch}
                />
                <ComboboxPopup>
                  <ComboboxList>
                    {filteredMatters.map((matter) => (
                      <ComboboxItem key={matter.id} value={matter}>
                        <BidiText className="truncate">{matter.name}</BidiText>
                        {matter.clientName && (
                          <span className="text-muted-foreground ms-2 truncate text-xs">
                            <BidiText>{matter.clientName}</BidiText>
                          </span>
                        )}
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                  <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
                </ComboboxPopup>
              </Combobox>
              {isPending && (
                <p className="text-muted-foreground text-sm">
                  {t("common.loading")}
                </p>
              )}
              {error && (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-destructive">
                    {t("errors.actionFailed")}
                  </span>
                  <Button
                    onClick={() =>
                      detached(refetch(), "upload-document.retry-matters")
                    }
                    size="xs"
                    variant="ghost"
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              )}
            </div>
          )}
          {selectedWorkspaceId && (
            <QuerySuspenseBoundary
              area="command-palette.upload-document"
              errorFallback={({ reset }) => (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-destructive">
                    {t("errors.actionFailed")}
                  </span>
                  <Button onClick={reset} size="xs" variant="ghost">
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              suspenseFallback={
                <p className="text-muted-foreground text-sm">
                  {t("common.loading")}
                </p>
              }
              resetKeys={[selectedWorkspaceId]}
            >
              <UploadDocumentForMatter
                key={selectedWorkspaceId}
                onClose={onClose}
                workspaceId={selectedWorkspaceId}
              />
            </QuerySuspenseBoundary>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type UploadDocumentForMatterProps = {
  onClose: () => void;
  workspaceId: string;
};

const UploadDocumentForMatter = ({
  onClose,
  workspaceId,
}: UploadDocumentForMatterProps) => {
  const t = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadPending, createFileEntities] =
    useCreateFileEntities(workspaceId);
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const isEntitiesLimitReached = useEntitiesCountLimit(workspaceId);
  const canCreateEntity = usePermissions({ entity: ["create"] });
  const disabled =
    !canCreateEntity ||
    isEntitiesLimitReached ||
    isWorkflowRunning ||
    isUploadPending;

  if (isEntitiesLimitReached || !canCreateEntity) {
    return (
      <p className="text-destructive text-sm">{t("errors.actionFailed")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        className="hidden"
        disabled={disabled}
        id={`upload-document-files-${workspaceId}`}
        multiple
        onChange={(event) => {
          const files = event.currentTarget.files
            ? [...event.currentTarget.files]
            : [];
          if (files.length > 0) {
            createFileEntities({ files, parentId: null });
            onClose();
          }
          event.currentTarget.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
      <Button
        className="min-h-11 border border-dashed"
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
        type="button"
        variant="outline"
      >
        <UploadIcon className="size-4" />
        {t("common.uploadFiles")}
      </Button>
    </div>
  );
};
