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
  Settings2Icon,
  Trash2Icon,
  UploadIcon,
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

import { StyleSetEditorDialog } from "@/features/style-sets/style-set-editor-dialog";
import type { StyleSetEditorTarget } from "@/features/style-sets/style-set-editor-types";
import {
  styleSetsKeys,
  styleSetsOptions,
} from "@/features/style-sets/style-set-queries";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { isDocxFile } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";

const protectedRouteApi = getRouteApi("/_protected");
const UNEXPECTED_ERROR_TRANSLATION_KEY = "common.unexpectedError";

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
  const replaceTargetRef = useRef<StyleSetItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<StyleSetItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StyleSetItem | null>(null);
  const [editorTarget, setEditorTarget] = useState<StyleSetEditorTarget | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: styleSetsKeys.all(organizationId),
    });
  };

  const replace = async (file: File) => {
    const target = replaceTargetRef.current;
    replaceTargetRef.current = null;
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
      showError(
        t("styleSets.replaceFailed"),
        response.error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
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
      showError(
        t("styleSets.exportFailed"),
        response.error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
      return;
    }
    window.open(response.data.presignedUrl, "_blank");
  };

  const handleDownload = async (styleSet: StyleSetItem) => {
    try {
      await download(styleSet);
    } catch (error) {
      showThrownError(
        t("styleSets.exportFailed"),
        error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
    }
  };

  const handleReplace = async (file: File) => {
    try {
      await replace(file);
    } catch (error) {
      setBusy(false);
      showThrownError(
        t("styleSets.replaceFailed"),
        error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
    }
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
      showError(
        t("styleSets.deleteFailed"),
        response.error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
      throw toAPIError(response.error);
    }
    setDeleteTarget(null);
    await invalidate();
  };

  if (isError) {
    return <PageMessage>{t("styleSets.loadFailed")}</PageMessage>;
  }
  if (isLoading || !data) {
    return <PageMessage>{t("common.loading")}</PageMessage>;
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
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setImportOpen(true)}
              size="sm"
              variant="outline"
            >
              <UploadIcon />
              {t("styleSets.import")}
            </Button>
            <Button
              onClick={() => setEditorTarget({ type: "stella" })}
              size="sm"
            >
              <PlusIcon />
              {t("styleSets.create")}
            </Button>
          </div>
        )}
      </div>
      <ul className="flex-1 divide-y overflow-y-auto">
        <StyleSetRow
          description={t("styleSets.stellaDescription")}
          name={t("styleSets.stellaStyle")}
          trailing={
            <div className="flex items-center gap-2">
              <span className="bg-muted rounded-full px-2 py-1 text-xs font-medium">
                {t("styleSets.defaultBadge")}
              </span>
              {canCreate && (
                <Button
                  aria-label={t("styleSets.editor.createFromStella")}
                  onClick={() => setEditorTarget({ type: "stella" })}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Settings2Icon />
                </Button>
              )}
            </div>
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
                  onClick={() => void handleDownload(styleSet)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <DownloadIcon />
                </Button>
                {canUpdate && (
                  <>
                    <Button
                      aria-label={t("common.edit")}
                      onClick={() =>
                        setEditorTarget({
                          type: "saved",
                          styleSetId: styleSet.id,
                        })
                      }
                      size="icon-xs"
                      variant="ghost"
                    >
                      <Settings2Icon />
                    </Button>
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
                        replaceTargetRef.current = styleSet;
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
            void handleReplace(file);
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
      {editorTarget && (
        <StyleSetEditorDialog
          onOpenChange={(open) => {
            if (!open) {
              setEditorTarget(null);
            }
          }}
          onSaved={invalidate}
          target={editorTarget}
        />
      )}
    </div>
  );
};

export const Route = createFileRoute("/_protected/knowledge/styles")({
  component: StyleSetsPage,
});

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
    let response;
    if (styleSet) {
      response = await api["style-sets"]({
        styleSetId: toSafeId<"styleSet">(styleSet.id),
      }).post({ name: normalizedName });
    } else {
      if (!file) {
        setSaving(false);
        return;
      }
      response = await api["style-sets"].put({
        name: normalizedName,
        styleSource: file,
      });
    }
    setSaving(false);
    if (response.error) {
      showError(
        t("styleSets.saveFailed"),
        response.error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
      return;
    }
    await onSaved();
    onOpenChange(false);
  };

  const handleSave = async () => {
    try {
      await save();
    } catch (error) {
      setSaving(false);
      showThrownError(
        t("styleSets.saveFailed"),
        error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
    }
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
            onClick={() => void handleSave()}
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

// eslint-disable-next-line sonarjs/function-name -- React components use PascalCase.
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
  fallbackMessage: string,
) => {
  stellaToast.add({
    type: "error",
    title,
    description: userErrorMessage(error, fallbackMessage),
  });
};

const showThrownError = (
  title: string,
  error: unknown,
  fallbackMessage: string,
) => {
  stellaToast.add({
    type: "error",
    title,
    description: userErrorFromThrown(error, fallbackMessage),
  });
};
