import { useId, useState } from "react";
import type { PropsWithChildren } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { FileInput } from "@stll/ui/file-input";
import { openFilePicker } from "@stll/ui/file-picker";
import {
  CogIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { stellaToast } from "@stll/ui/toast";
import { TruncatedText } from "@stll/ui/truncated-text";

import { StyleSetEditorDialog } from "@/features/style-sets/style-set-editor-dialog";
import type { StyleSetEditorTarget } from "@/features/style-sets/style-set-editor-types";
import {
  styleSetsKeys,
  styleSetsOptions,
} from "@/features/style-sets/style-set-queries";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { isDocxFile } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { toSafeId } from "@/lib/safe-id";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import {
  StyleSetDefaultBadge,
  StyleSetList,
  StyleSetRow,
  StyleSetsPending,
  StyleSetsShell,
} from "@/routes/knowledge/-member/styles.pending";

const UNEXPECTED_ERROR_TRANSLATION_KEY = "common.unexpectedError";

type StyleSetListResponse = Awaited<
  ReturnType<(typeof api)["style-sets"]["get"]>
>;
type StyleSetListData = Exclude<
  NonNullable<Extract<StyleSetListResponse, { data: unknown }>["data"]>,
  Response
>;
type StyleSetItem = StyleSetListData["items"][number];

const MemberStyleSetsPage = () => {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const organizationId = useAuthenticatedUser().activeOrganizationId;
  const { data, isLoading, isError } = useQuery(
    styleSetsOptions(organizationId),
  );
  const canCreate = usePermissions({ styleSet: ["create"] });
  const canUpdate = usePermissions({ styleSet: ["update"] });
  const canDelete = usePermissions({ styleSet: ["delete"] });
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

  const replace = async (target: StyleSetItem, file: File) => {
    if (!isDocxFile(file)) {
      notifyUserProblem(t("templates.invalidFileType"));
      return;
    }
    setBusy(true);
    const response = await invokeCapability(
      "style-sets.replace",
      async (capability) => {
        const { error } = await api["style-sets"]({
          styleSetId: toSafeId<"styleSet">(target.id),
        }).source.post({ styleSource: file }, capability);
        return { error };
      },
    );
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
    openIsolatedWindow(response.data.presignedUrl);
  };

  const downloadHandler = (styleSet: StyleSetItem) => () => {
    download(styleSet).catch((error: unknown) => {
      showThrownError(
        t("styleSets.exportFailed"),
        error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
    });
  };

  const handleReplace = (target: StyleSetItem, file: File) => {
    replace(target, file).catch((error: unknown) => {
      setBusy(false);
      showThrownError(
        t("styleSets.replaceFailed"),
        error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
    });
  };

  const remove = async () => {
    if (!deleteTarget) {
      return;
    }
    setBusy(true);
    const response = await invokeCapability(
      "style-sets.delete",
      async (capability) => {
        const { error } = await api["style-sets"]({
          styleSetId: toSafeId<"styleSet">(deleteTarget.id),
        }).delete({}, capability);
        return { error };
      },
    );
    setBusy(false);
    if (response.error) {
      showError(
        t("styleSets.deleteFailed"),
        response.error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
      // The dialog stays open for another try.
      return "keep-open" as const;
    }
    setDeleteTarget(null);
    await invalidate();
  };

  if (isError) {
    return <PageMessage>{t("styleSets.loadFailed")}</PageMessage>;
  }
  if (isLoading || !data) {
    return <StyleSetsPending />;
  }

  return (
    <StyleSetsShell
      actions={
        canCreate && (
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
        )
      }
      description={t("styleSets.description")}
      title={t("styleSets.title")}
    >
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        <StyleSetList>
          <StyleSetRow
            description={
              <RowDescription text={t("styleSets.stellaDescription")} />
            }
            name={<RowName text={t("styleSets.stellaStyle")} />}
            trailing={
              <div className="flex items-center gap-2">
                <StyleSetDefaultBadge>
                  {t("styleSets.defaultBadge")}
                </StyleSetDefaultBadge>
                {canCreate && (
                  <Button
                    aria-label={t("styleSets.editor.createFromStella")}
                    onClick={() => setEditorTarget({ type: "stella" })}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <CogIcon />
                  </Button>
                )}
              </div>
            }
          />
          {data.items.map((styleSet) => (
            <StyleSetRow
              description={
                <RowDescription
                  text={format.dateTime(new Date(styleSet.updatedAt), {
                    dateStyle: "medium",
                  })}
                />
              }
              key={styleSet.id}
              name={<RowName text={styleSet.name} />}
              trailing={
                <div className="flex items-center gap-1">
                  <Button
                    aria-label={t("common.download")}
                    onClick={downloadHandler(styleSet)}
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
                        <CogIcon />
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
                        onClick={() =>
                          openFilePicker({
                            accept: ".docx",
                            onPick: ([file]) => handleReplace(styleSet, file),
                          })
                        }
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
        </StyleSetList>
      </ScrollArea>
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
    </StyleSetsShell>
  );
};

const RowName = ({ text }: { text: string }) => (
  <TruncatedText className="text-sm font-medium" render={<p />}>
    {text}
  </TruncatedText>
);

const RowDescription = ({ text }: { text: string }) => (
  <TruncatedText className="text-muted-foreground text-xs" render={<p />}>
    {text}
  </TruncatedText>
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
  const idempotentSubmit = useIdempotentSubmit();
  const t = useTranslations();
  const sourceLabelId = useId();
  const nameInputId = useId();
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
      response = await invokeCapability(
        "style-sets.update",
        async (capability) => {
          const { data, error } = await api["style-sets"]({
            styleSetId: toSafeId<"styleSet">(styleSet.id),
          }).post({ name: normalizedName }, capability);
          return { data, error };
        },
      );
    } else {
      if (!file) {
        setSaving(false);
        return;
      }
      response = await idempotentSubmit.run({
        operation: JSON.stringify(['api["style-sets"]']),
        body: {
          name: normalizedName,
          styleSource: file,
        },
        send: async (body) =>
          await invokeCapability("style-sets.create", async (capability) => {
            const { data, error } = await api["style-sets"].put(
              body,
              capability,
            );
            return { data, error };
          }),
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

  const handleSave = () => {
    save().catch((error: unknown) => {
      setSaving(false);
      showThrownError(
        t("styleSets.saveFailed"),
        error,
        t(UNEXPECTED_ERROR_TRANSLATION_KEY),
      );
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogFormState
          dirty={name !== (styleSet?.name ?? "") || file !== null}
          onDiscard={() => {
            setName(styleSet?.name ?? "");
            setFile(null);
          }}
        />
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameInputId}>{t("common.name")}</Label>
            <Input
              autoFocus
              id={nameInputId}
              maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          {!styleSet && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium" id={sourceLabelId}>
                {t("styleSets.sourceDocument")}
              </span>
              <FileInput
                accept=".docx"
                aria-labelledby={sourceLabelId}
                chooseLabel={t("common.chooseFile")}
                emptyLabel={t("common.noFileChosen")}
                file={file}
                onFileChange={setFile}
              />
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={saving || name.trim() === "" || (!styleSet && !file)}
            onClick={handleSave}
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

const renameStyleSetDialog = ({
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

const RenameStyleSetDialog = renameStyleSetDialog;

const showError = (
  title: string,
  error: Parameters<typeof userErrorMessage>[0],
  fallbackMessage: string,
) => {
  notifyUserError(toAPIError(error), title, {
    description: userErrorMessage(error, fallbackMessage),
  });
};

const showThrownError = (
  title: string,
  error: unknown,
  fallbackMessage: string,
) => {
  notifyUserError(error, title, {
    description: userErrorFromThrown(error, fallbackMessage),
  });
};

/** The organization's house styles. */
export function StyleSetsPage() {
  return (
    <KnowledgeMemberOnly pending={<StyleSetsPending />}>
      {(organizationId) => <MemberStyleSetsPage key={organizationId} />}
    </KnowledgeMemberOnly>
  );
}
