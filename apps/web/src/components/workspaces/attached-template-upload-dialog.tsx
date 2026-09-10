import { useTranslations } from "use-intl";

import type { AttachedTemplateTargetKind } from "@stll/docx-utils";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPanel,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import type { AttachedTemplateUploadPrompt } from "@/lib/files/attached-template-upload-store";
import {
  currentAttachedTemplateUploadPrompt,
  useAttachedTemplateUploadStore,
} from "@/lib/files/attached-template-upload-store";

export const AttachedTemplateUploadDialog = () => {
  const queuedPrompt = useAttachedTemplateUploadStore(
    currentAttachedTemplateUploadPrompt,
  );
  const close = useAttachedTemplateUploadStore((store) => store.close);

  if (queuedPrompt === null) {
    return null;
  }

  return (
    <AttachedTemplateUploadDialogBody
      key={queuedPrompt.id}
      onClose={() => close(queuedPrompt.id)}
      prompt={queuedPrompt.prompt}
    />
  );
};

type AttachedTemplateUploadDialogBodyProps = {
  prompt: AttachedTemplateUploadPrompt;
  onClose: () => void;
};

const AttachedTemplateUploadDialogBody = ({
  prompt: { files, onApproved, onCancelled },
  onClose,
}: AttachedTemplateUploadDialogBodyProps) => {
  const t = useTranslations();
  const targetLocationMessages = {
    local: t("workspaces.files.attachedTemplateUpload.localLocation"),
    network: t("workspaces.files.attachedTemplateUpload.networkLocation"),
    unknown: t("workspaces.files.attachedTemplateUpload.unknownLocation"),
  } as const satisfies Record<AttachedTemplateTargetKind, string>;
  const mixedLocationMessage = t(
    "workspaces.files.attachedTemplateUpload.mixedLocation",
  );

  const cancel = () => {
    onCancelled();
    onClose();
  };
  const approve = () => {
    onApproved();
    onClose();
  };

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          cancel();
        }
      }}
      open
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("workspaces.files.attachedTemplateUpload.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("workspaces.files.attachedTemplateUpload.description", {
              count: files.length,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogPanel className="flex flex-col gap-3">
          {files.map(({ id, originalFile, rule, targetKinds }) => (
            <div className="flex flex-col gap-1 rounded-lg border p-3" key={id}>
              <span className="text-sm font-medium">
                <BidiText>{originalFile.name}</BidiText>
              </span>
              <span className="text-muted-foreground text-xs">
                {targetKindMessage({
                  targetKinds,
                  targetLocationMessages,
                  mixedLocationMessage,
                })}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("workspaces.files.attachedTemplateUpload.ruleLabel")}{" "}
                <code dir="ltr">{rule}</code>
              </span>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            {t("workspaces.files.attachedTemplateUpload.effect")}
          </p>
        </AlertDialogPanel>

        <AlertDialogFooter>
          <Button onClick={cancel} variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button onClick={approve}>
            {t("workspaces.files.attachedTemplateUpload.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};

type TargetKindMessageOptions = {
  targetKinds: readonly AttachedTemplateTargetKind[];
  targetLocationMessages: Record<AttachedTemplateTargetKind, string>;
  mixedLocationMessage: string;
};

const targetKindMessage = ({
  targetKinds,
  targetLocationMessages,
  mixedLocationMessage,
}: TargetKindMessageOptions): string => {
  const targetKind = targetKinds.at(0);
  if (targetKinds.length !== 1 || targetKind === undefined) {
    return mixedLocationMessage;
  }
  return targetLocationMessages[targetKind];
};
