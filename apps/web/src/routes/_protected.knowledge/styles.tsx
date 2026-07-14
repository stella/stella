import { useRef, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import {
  DownloadIcon,
  FileTextIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import {
  styleSetsKeys,
  styleSetsOptions,
} from "@/features/style-sets/style-set-queries";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { isDocxFile } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

export const Route = createFileRoute("/_protected/knowledge/styles")({
  component: StyleSetsPage,
});

const protectedRouteApi = getRouteApi("/_protected");

type StyleSetListResponse = Awaited<
  ReturnType<(typeof api)["style-sets"]["get"]>
>;
type StyleSetListData = Exclude<
  NonNullable<Extract<StyleSetListResponse, { data: unknown }>["data"]>,
  Response
>;
type StyleSetItem = StyleSetListData["items"][number];

const StyleSetsPage = () => {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data, isLoading, isError } = useQuery(
    styleSetsOptions(organizationId),
  );
  const canCreate = usePermissions({ styleSet: ["create"] });
  const canUpdate = usePermissions({ styleSet: ["update"] });
  const canDelete = usePermissions({ styleSet: ["delete"] });
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<StyleSetItem | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<StyleSetItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StyleSetItem | null>(null);
  const [busy, setBusy] = useState(false);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: styleSetsKeys.all(organizationId),
    });
  };

  const replace = async (file: File) => {
    const target = replaceTarget;
    setReplaceTarget(null);
    if (!target || !isDocxFile(file)) {
      stellaToast.add({ type: "error", title: t("templates.invalidFileType") });
      return;
    }
    setBusy(true);
    const response = await api["style-sets"]({
      styleSetId: toSafeId<"styleSet">(target.id),
    }).source.post({ styleSource: file });
    setBusy(false);
    if (response.error) {
      showError(t("styleSets.replaceFailed"), response.error, t);
      return;
    }
    await invalidate();
    stellaToast.add({ type: "success", title: t("styleSets.replaced") });
  };

  const download = async (styleSet: StyleSetItem) => {
    const response = await api["style-sets"]({
      styleSetId: toSafeId<"styleSet">(styleSet.id),
    }).download.get();
    if (response.error) {
      showError(t("styleSets.exportFailed"), response.error, t);
      return;
    }
    window.open(response.data.presignedUrl, "_blank");
  };

  const remove = async () => {
    if (!deleteTarget) {
      return;
    }
    setBusy(true);
    const response = await api["style-sets"]({
      styleSetId: toSafeId<"styleSet">(deleteTarget.id),
    }).delete();
    setBusy(false);
    if (response.error) {
      showError(t("styleSets.deleteFailed"), response.error, t);
      throw toAPIError(response.error);
    }
    setDeleteTarget(null);
    await invalidate();
  };

  if (isLoading || !data) {
    return <PageMessage>{t("common.loading")}</PageMessage>;
  }
  if (isError) {
    return <PageMessage>{t("styleSets.loadFailed")}</PageMessage>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold">{t("styleSets.title")}</h1>
          <p className="text-muted-foreground text-xs">
            {t("styleSets.description")}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setImportOpen(true)} size="sm">
            <PlusIcon />
            {t("styleSets.import")}
          </Button>
        )}
      </div>
      <ul className="flex-1 divide-y overflow-y-auto">
        <StyleSetRow
          description={t("styleSets.stellaDescription")}
          name={t("styleSets.stellaStyle")}
          trailing={
            <span className="bg-muted rounded-full px-2 py-1 text-xs font-medium">
              {t("styleSets.defaultBadge")}
            </span>
          }
        />
        {data.items.map((styleSet) => (
          <StyleSetRow
            description={format.dateTime(new Date(styleSet.updatedAt), {
              dateStyle: "medium",
            })}
            key={styleSet.id}
            name={styleSet.name}
            trailing={
              <div className="flex items-center gap-1">
                <Button
                  aria-label={t("common.download")}
                  onClick={() => void download(styleSet)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <DownloadIcon />
                </Button>
                {canUpdate && (
                  <>
                    <Button
                      aria-label={t("common.rename")}
                      onClick={() => setRenameTarget(styleSet)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      aria-label={t("styleSets.replace")}
                      disabled={busy}
                      onClick={() => {
                        setReplaceTarget(styleSet);
                        replaceInputRef.current?.click();
                      }}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <RefreshCwIcon />
                    </Button>
                  </>
                )}
                {canDelete && (
                  <Button
                    aria-label={t("common.delete")}
                    onClick={() => setDeleteTarget(styleSet)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </div>
            }
          />
        ))}
      </ul>
      <input
        accept=".docx"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.item(0);
          event.currentTarget.value = "";
          if (file) {
            void replace(file);
          }
        }}
        ref={replaceInputRef}
        type="file"
      />
      {importOpen && (
        <ImportStyleSetDialog
          onImported={invalidate}
          onOpenChange={setImportOpen}
          open
        />
      )}
      <RenameStyleSetDialog
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
          }
        }}
        onRenamed={invalidate}
        styleSet={renameTarget}
      />
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmation={deleteTarget?.name ?? ""}
        confirmLabel={t("common.delete")}
        description={t("styleSets.deleteDescription")}
        inputLabel={t("styleSets.deleteConfirmation")}
        loading={busy}
        onConfirm={remove}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
        title={t("styleSets.deleteTitle")}
      />
    </div>
  );
};

const StyleSetRow = ({
  name,
  description,
  trailing,
}: {
  name: string;
  description: string;
  trailing: ReactNode;
}) => (
  <li className="flex items-center gap-3 px-6 py-4">
    <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
      <FileTextIcon className="text-muted-foreground size-5" />
    </div>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{name}</p>
      <p className="text-muted-foreground truncate text-xs">{description}</p>
    </div>
    {trailing}
  </li>
);

const PageMessage = ({ children }: PropsWithChildren) => (
  <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
    {children}
  </div>
);

type StyleSetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  styleSet?: StyleSetItem | undefined;
};

const StyleSetFormDialog = ({
  open,
  onOpenChange,
  onSaved,
  styleSet,
}: StyleSetDialogProps) => {
  const t = useTranslations();
  const [name, setName] = useState(styleSet?.name ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const normalizedName = name.trim();
    if (normalizedName === "" || (!styleSet && !file)) {
      return;
    }
    setSaving(true);
    const response = styleSet
      ? await api["style-sets"]({
          styleSetId: toSafeId<"styleSet">(styleSet.id),
        }).post({ name: normalizedName })
      : file
        ? await api["style-sets"].put({
            name: normalizedName,
            styleSource: file,
          })
        : null;
    setSaving(false);
    if (!response) {
      return;
    }
    if (response.error) {
      showError(t("styleSets.saveFailed"), response.error, t);
      return;
    }
    await onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {styleSet ? t("styleSets.renameTitle") : t("styleSets.importTitle")}
          </DialogTitle>
          {!styleSet && (
            <DialogDescription>
              {t("styleSets.importDescription")}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="space-y-1.5">
            <span className="text-sm font-medium">{t("common.name")}</span>
            <Input
              autoFocus
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          {!styleSet && (
            <label className="space-y-1.5">
              <span className="text-sm font-medium">
                {t("styleSets.sourceDocument")}
              </span>
              <Input
                accept=".docx"
                onChange={(event) =>
                  setFile(event.target.files?.item(0) ?? null)
                }
                type="file"
              />
            </label>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={saving || name.trim() === "" || (!styleSet && !file)}
            onClick={save}
          >
            {saving ? t("common.loading") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

const ImportStyleSetDialog = ({
  open,
  onOpenChange,
  onImported,
}: Omit<StyleSetDialogProps, "onSaved"> & {
  onImported: () => Promise<void>;
}) => (
  <StyleSetFormDialog
    onOpenChange={onOpenChange}
    onSaved={onImported}
    open={open}
  />
);

const RenameStyleSetDialog = ({
  styleSet,
  onOpenChange,
  onRenamed,
}: {
  styleSet: StyleSetItem | null;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => Promise<void>;
}) =>
  styleSet ? (
    <StyleSetFormDialog
      key={styleSet.id}
      onOpenChange={onOpenChange}
      onSaved={onRenamed}
      open
      styleSet={styleSet}
    />
  ) : null;

const showError = (
  title: string,
  error: Parameters<typeof userErrorMessage>[0],
  t: ReturnType<typeof useTranslations>,
) => {
  stellaToast.add({
    type: "error",
    title,
    description: userErrorMessage(error, t("common.unexpectedError")),
  });
};
