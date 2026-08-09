import { useId, useRef, useState, type ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  PaperclipIcon,
  SaveIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@stll/ui/components/menu";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { DocumentIcon } from "@/components/document-icon";
import {
  MatterTargetPicker,
  type MatterTarget,
} from "@/components/matter-target-picker";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import {
  emailAttachmentPreviewOptions,
  emailHtmlPreviewOptions,
  saveEmailAttachment,
  type EmailAttachmentDescriptor,
} from "@/lib/files/queries";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type EmailAttachmentsFacetProps = {
  fieldId: string;
  workspaceId: string;
};

const EMAIL_ATTACHMENT_SAVE_STATUS = {
  idle: "idle",
  saving: "saving",
} as const;

type EmailAttachmentSaveState = {
  status:
    | typeof EMAIL_ATTACHMENT_SAVE_STATUS.idle
    | typeof EMAIL_ATTACHMENT_SAVE_STATUS.saving;
};

const createInitialSaveState = (): EmailAttachmentSaveState => ({
  status: EMAIL_ATTACHMENT_SAVE_STATUS.idle,
});

export const EmailAttachmentsFacet = ({
  fieldId,
  workspaceId,
}: EmailAttachmentsFacetProps) => {
  const t = useTranslations();
  const canSave = usePermissions({ entity: ["create"] });
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveTargetId, setSaveTargetId] = useState<string | null>(null);
  const [matterTarget, setMatterTarget] = useState<MatterTarget | null>(null);
  const [saveState, setSaveState] = useState(createInitialSaveState);
  const savingRef = useRef(false);
  const previewQuery = useQuery(
    emailHtmlPreviewOptions({ fieldId, workspaceId }),
  );

  if (previewQuery.isPending) {
    return <Skeleton className="m-3 h-24 rounded-sm" />;
  }
  if (previewQuery.isError) {
    return (
      <FacetMessage
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }

  const selected = previewQuery.data.attachments.find(
    ({ id }) => id === selectedId,
  );
  if (selectedId !== null && selected === undefined) {
    return (
      <FacetMessage
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }
  const saveTargetAttachment = previewQuery.data.attachments.find(
    ({ id }) => id === saveTargetId,
  );
  const saveAttachment = ({
    attachment,
    destination,
  }: {
    attachment: EmailAttachmentDescriptor;
    destination: MatterTarget;
  }): void => {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    setSaveState({ status: EMAIL_ATTACHMENT_SAVE_STATUS.saving });
    detached(
      (async () => {
        const result = await Result.tryPromise(async () => {
          const saved = await saveEmailAttachment({
            attachmentId: attachment.id,
            destinationWorkspaceId: destination.workspaceId,
            fieldId,
            parentId: destination.parentId,
            sourceWorkspaceId: workspaceId,
          });
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: entitiesKeys.all(saved.workspaceId),
            }),
            queryClient.invalidateQueries({
              queryKey: workspacesKeys.overview(saved.workspaceId),
            }),
            queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
          ]);
        });
        savingRef.current = false;
        setSaveState({ status: EMAIL_ATTACHMENT_SAVE_STATUS.idle });
        if (Result.isError(result)) {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          return;
        }
        setSaveTargetId(null);
        setMatterTarget(null);
        stellaToast.add({
          title: t("workspaces.copyToMatter.copied"),
          type: "success",
        });
      })(),
      "email-attachment.save",
    );
  };
  const saving = saveState.status === EMAIL_ATTACHMENT_SAVE_STATUS.saving;
  const openMatterPicker = (attachmentId: string) => {
    setMatterTarget(null);
    setSaveTargetId(attachmentId);
  };
  const closeMatterPicker = () => {
    setMatterTarget(null);
    setSaveTargetId(null);
  };
  const content =
    selected !== undefined ? (
      <AttachmentPreview
        attachment={selected}
        canSave={canSave}
        fieldId={fieldId}
        onBack={() => setSelectedId(null)}
        onChooseMatter={() => openMatterPicker(selected.id)}
        onSave={() =>
          saveAttachment({
            attachment: selected,
            destination: { workspaceId, parentId: null },
          })
        }
        saving={saving}
        workspaceId={workspaceId}
      />
    ) : (
      <AttachmentList
        attachments={previewQuery.data.attachments}
        canSave={canSave}
        fieldId={fieldId}
        onChooseMatter={openMatterPicker}
        onSave={(attachment) =>
          saveAttachment({
            attachment,
            destination: { workspaceId, parentId: null },
          })
        }
        onSelect={setSelectedId}
        saving={saving}
      />
    );

  return (
    <>
      {content}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeMatterPicker();
          }
        }}
        open={saveTargetAttachment !== undefined}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("common.selectAMatter")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <MatterTargetPicker
              excludeWorkspaceId={workspaceId}
              onChange={setMatterTarget}
              value={matterTarget}
            />
          </DialogPanel>
          <DialogFooter>
            <Button onClick={closeMatterPicker} variant="ghost">
              {t("common.cancel")}
            </Button>
            <Button
              disabled={
                matterTarget === null ||
                saveTargetAttachment === undefined ||
                saving
              }
              onClick={() => {
                if (matterTarget && saveTargetAttachment) {
                  saveAttachment({
                    attachment: saveTargetAttachment,
                    destination: matterTarget,
                  });
                }
              }}
            >
              {saving ? t("common.loading") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
};

const AttachmentPreview = ({
  attachment,
  canSave,
  fieldId,
  onBack,
  onChooseMatter,
  onSave,
  saving,
  workspaceId,
}: {
  attachment: EmailAttachmentDescriptor;
  canSave: boolean;
  fieldId: string;
  onBack: () => void;
  onChooseMatter: () => void;
  onSave: () => void;
  saving: boolean;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const fileNameId = useId();
  const fileName = attachment.fileName ?? t("emailViewer.unnamedAttachment");
  const attachmentQuery = useQuery(
    emailAttachmentPreviewOptions({
      attachmentId: attachment.id,
      fieldId,
      workspaceId,
    }),
  );
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);

  useExternalSyncEffect(() => {
    if (!attachmentQuery.data) {
      setPreviewObjectUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(
      new Blob([attachmentQuery.data], {
        type: attachment.mimeType ?? "application/octet-stream",
      }),
    );
    setPreviewObjectUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.mimeType, attachmentQuery.data]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          aria-label={t("common.back")}
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <DirectionalIcon className="size-3.5" icon={ArrowLeftIcon} />
        </Button>
        <BidiText
          as="span"
          className="min-w-0 flex-1 truncate text-sm font-medium"
          id={fileNameId}
        >
          {fileName}
        </BidiText>
        {canSave ? (
          <AttachmentSaveControls
            compact={false}
            descriptionId={fileNameId}
            disabled={saving}
            onChooseMatter={onChooseMatter}
            onSave={onSave}
          />
        ) : null}
      </div>
      <div className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center p-2">
        <AttachmentPreviewContent
          fileName={fileName}
          imageAttempt={imageAttempt}
          imageFailed={imageFailed}
          mimeType={attachment.mimeType}
          onImageError={() => setImageFailed(true)}
          onRetryImage={() => {
            setImageFailed(false);
            setImageAttempt((attempt) => attempt + 1);
          }}
          previewUrl={previewObjectUrl}
          previewError={attachmentQuery.isError}
        />
      </div>
    </div>
  );
};

const AttachmentPreviewContent = ({
  fileName,
  imageFailed,
  imageAttempt,
  mimeType,
  onImageError,
  onRetryImage,
  previewUrl,
  previewError,
}: {
  fileName: string;
  imageFailed: boolean;
  imageAttempt: number;
  mimeType: string | null;
  onImageError: () => void;
  onRetryImage: () => void;
  previewUrl: string | null;
  previewError: boolean;
}) => {
  const t = useTranslations();
  if (previewError) {
    return (
      <FacetMessage
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (imageFailed) {
    return (
      <FacetMessage
        action={
          <Button onClick={onRetryImage} size="sm" variant="outline">
            {t("common.tryAgain")}
          </Button>
        }
        icon={<AlertTriangleIcon aria-hidden="true" className="size-5" />}
        message={t("common.somethingWentWrong")}
      />
    );
  }
  if (previewUrl === null) {
    return <Skeleton className="size-full rounded-sm" />;
  }
  if (mimeType?.toLowerCase().startsWith("image/") === true) {
    return (
      <img
        alt={fileName}
        className="max-h-full max-w-full object-contain"
        key={imageAttempt}
        onError={onImageError}
        referrerPolicy="no-referrer"
        src={previewUrl}
      />
    );
  }

  return (
    <iframe
      className="bg-background size-full border-0"
      referrerPolicy="no-referrer"
      sandbox=""
      src={previewUrl}
      title={fileName}
    />
  );
};

const AttachmentList = ({
  attachments,
  canSave,
  fieldId,
  onChooseMatter,
  onSave,
  onSelect,
  saving,
}: {
  attachments: readonly EmailAttachmentDescriptor[];
  canSave: boolean;
  fieldId: string;
  onChooseMatter: (id: string) => void;
  onSave: (attachment: EmailAttachmentDescriptor) => void;
  onSelect: (id: string) => void;
  saving: boolean;
}) => {
  const t = useTranslations();

  return (
    <section
      aria-labelledby={`${fieldId}-attachment-facet`}
      className="min-h-0 flex-1 overflow-y-auto p-3"
    >
      <h2
        className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium"
        id={`${fieldId}-attachment-facet`}
      >
        <PaperclipIcon aria-hidden="true" className="size-3.5" />
        {t("emailViewer.attachments")}
      </h2>
      {attachments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("common.noResults")}</p>
      ) : (
        <ul className="grid gap-1.5">
          {attachments.map((attachment) => (
            <AttachmentListItem
              attachment={attachment}
              canSave={canSave}
              key={attachment.id}
              onChooseMatter={onChooseMatter}
              onSave={onSave}
              onSelect={onSelect}
              saving={saving}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

const AttachmentListItem = ({
  attachment,
  canSave,
  onChooseMatter,
  onSave,
  onSelect,
  saving,
}: {
  attachment: EmailAttachmentDescriptor;
  canSave: boolean;
  onChooseMatter: (id: string) => void;
  onSave: (attachment: EmailAttachmentDescriptor) => void;
  onSelect: (id: string) => void;
  saving: boolean;
}) => {
  const t = useTranslations();
  const fileNameId = useId();
  const fileName = attachment.fileName ?? t("emailViewer.unnamedAttachment");
  const unsupportedLabel = t("chat.unsupportedFileType");

  return (
    <li>
      <div className="hover:bg-muted/60 flex min-h-11 w-full items-center rounded-md border text-xs">
        <button
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 text-start disabled:cursor-default"
          disabled={!attachment.previewable}
          onClick={() => onSelect(attachment.id)}
          type="button"
        >
          <DocumentIcon
            className="text-muted-foreground size-4 shrink-0"
            fileName={fileName}
            mimeType={attachment.mimeType ?? "application/octet-stream"}
          />
          <BidiText
            as="span"
            className="min-w-0 flex-1 truncate"
            id={fileNameId}
          >
            {fileName}
          </BidiText>
          {!attachment.previewable ? (
            <span className="text-muted-foreground shrink-0">
              {unsupportedLabel}
            </span>
          ) : null}
        </button>
        {canSave ? (
          <AttachmentSaveControls
            compact
            descriptionId={fileNameId}
            disabled={saving}
            onChooseMatter={() => onChooseMatter(attachment.id)}
            onSave={() => onSave(attachment)}
          />
        ) : null}
      </div>
    </li>
  );
};

const AttachmentSaveControls = ({
  compact,
  descriptionId,
  disabled,
  onChooseMatter,
  onSave,
}: {
  compact: boolean;
  descriptionId: string;
  disabled: boolean;
  onChooseMatter: () => void;
  onSave: () => void;
}) => {
  const t = useTranslations();

  return (
    <div className="flex shrink-0 items-center">
      <Button
        aria-describedby={descriptionId}
        aria-label={t("common.save")}
        className="min-h-11 min-w-11"
        disabled={disabled}
        onClick={onSave}
        size={compact ? "icon-sm" : "sm"}
        variant="ghost"
      >
        <SaveIcon aria-hidden="true" className="size-3.5" />
        {!compact ? t("common.save") : null}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-describedby={descriptionId}
              aria-label={t("common.selectAMatter")}
              className="min-h-11 min-w-11"
              disabled={disabled}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onChooseMatter}>
            {t("common.selectAMatter")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

const FacetMessage = ({
  action,
  icon,
  message,
}: {
  action?: ReactNode;
  icon: ReactNode;
  message: string;
}) => (
  <div
    className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm"
    role="alert"
  >
    {icon}
    <p>{message}</p>
    {action}
  </div>
);
