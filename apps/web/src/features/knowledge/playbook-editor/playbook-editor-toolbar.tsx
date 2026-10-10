import { panic } from "better-result";
import { useTranslations } from "use-intl";

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
import {
  ArrowLeftIcon,
  HistoryIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import type { PaneSaveStatus } from "@/features/knowledge/playbook-editor/playbook-editor-sync.logic";
import { useFormatter } from "@/i18n/formatting-context";
import type { PlaybookApprovalStatus } from "@/lib/knowledge/playbook-types";

/** `data-*` attributes a product tour marks its targets with. */
export type TourAttributes = Readonly<
  Partial<Record<`data-${string}`, string>>
>;

const PlaybookStatusBadge = ({
  status,
  approvedAt,
}: {
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  if (status === "approved") {
    return (
      <Tooltip
        content={
          approvedAt
            ? t("knowledge.playbooks.approval.approvedOn", {
                date: format.dateTime(new Date(approvedAt), {
                  dateStyle: "medium",
                }),
              })
            : undefined
        }
        render={
          <span className="bg-success/15 text-success text-3xs inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tracking-wider uppercase" />
        }
      >
        {t("knowledge.playbooks.approval.statusApproved")}
      </Tooltip>
    );
  }

  return (
    <span className="bg-muted text-muted-foreground text-3xs inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium tracking-wider uppercase">
      {t("knowledge.playbooks.approval.statusDraft")}
    </span>
  );
};

type PaneSaveStatusProps = {
  status: PaneSaveStatus;
  onRetry: () => void;
  onShowProblems: () => void;
};

/**
 * Stands in for the Save button while the pane autosaves. "Saving" stays
 * quiet however long it takes: a save can wait on a model deriving asks.
 */
const PaneSaveStatusContent = ({
  status,
  onRetry,
  onShowProblems,
}: PaneSaveStatusProps) => {
  const t = useTranslations();
  switch (status.type) {
    case "saved":
      return <span className="text-muted-foreground">{t("common.saved")}</span>;
    case "saving":
      return (
        <span className="text-muted-foreground">{t("common.saving")}</span>
      );
    case "failed":
      return (
        <>
          <span className="text-destructive">
            {t("knowledge.playbooks.autosave.failed")}
          </span>
          <Button onClick={onRetry} size="xs" type="button" variant="ghost">
            {t("common.retry")}
          </Button>
        </>
      );
    case "needs-attention":
      return (
        <Button
          onClick={onShowProblems}
          size="xs"
          type="button"
          variant="outline"
        >
          <TriangleAlertIcon className="text-warning-foreground" />
          {status.invalidPositions > 0
            ? t("knowledge.playbooks.autosave.positionsNeedAttention", {
                count: status.invalidPositions,
              })
            : t("knowledge.playbooks.autosave.nameMissing")}
        </Button>
      );
    default:
      status satisfies never;
      return panic(`Unhandled pane save status: ${String(status)}`);
  }
};

/** The save control: a Save button, or the pane's autosave status. */
type ToolbarSave =
  | { type: "button"; disabled: boolean; loading: boolean; onSave: () => void }
  | ({ type: "autosave" } & PaneSaveStatusProps);

type PlaybookEditorToolbarProps = {
  /** Null in the pane, whose tab header closes it. */
  onBack: (() => void) | null;
  className?: string | undefined;
  backTourAttributes: TourAttributes;
  isEdit: boolean;
  isDirty: boolean;
  status: PlaybookApprovalStatus;
  approvedAt: string | null;
  canApprove: boolean;
  canDelete: boolean;
  approving: boolean;
  onApprove: () => void;
  onOpenVersionHistory: () => void;
  deleteOpen: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  /** A save or delete request is running. */
  busy: boolean;
  onDelete: () => void;
  save: ToolbarSave;
};

export const PlaybookEditorToolbar = ({
  onBack,
  className,
  backTourAttributes,
  isEdit,
  isDirty,
  status,
  approvedAt,
  canApprove,
  canDelete,
  approving,
  onApprove,
  onOpenVersionHistory,
  deleteOpen,
  onDeleteOpenChange,
  busy,
  onDelete,
  save,
}: PlaybookEditorToolbarProps) => {
  const t = useTranslations();
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      {onBack !== null && (
        <Button
          onClick={onBack}
          size="sm"
          type="button"
          variant="ghost"
          {...backTourAttributes}
        >
          <ArrowLeftIcon />
          {t("common.back")}
        </Button>
      )}
      <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
        {isEdit && (
          <PlaybookStatusBadge approvedAt={approvedAt} status={status} />
        )}
        {isDirty && save.type === "button" && (
          <span className="text-muted-foreground text-xs">
            {t("common.unsavedChanges")}
          </span>
        )}
        {isEdit && (
          <Button
            aria-label={t("knowledge.playbooks.versions.versionHistory")}
            onClick={onOpenVersionHistory}
            size="sm"
            type="button"
            variant="outline"
          >
            <HistoryIcon />
            <span className="hidden @lg:inline">
              {t("knowledge.playbooks.versions.versionHistory")}
            </span>
          </Button>
        )}
        {isEdit && canApprove && (
          <Button
            disabled={isDirty || approving}
            loading={approving}
            onClick={onApprove}
            size="sm"
            tooltip={
              isDirty
                ? t("knowledge.playbooks.approval.saveBeforeApprove")
                : undefined
            }
            type="button"
            variant="outline"
          >
            <ShieldCheckIcon />
            {t("knowledge.playbooks.approval.approve")}
          </Button>
        )}
        {isEdit && canDelete && (
          <AlertDialog onOpenChange={onDeleteOpenChange} open={deleteOpen}>
            <Button
              aria-label={t("knowledge.playbooks.deletePlaybook")}
              onClick={() => onDeleteOpenChange(true)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("knowledge.playbooks.deletePlaybook")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("knowledge.playbooks.confirmDelete")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>
                  {t("common.cancel")}
                </AlertDialogClose>
                <Button
                  disabled={busy}
                  onClick={onDelete}
                  variant="destructive"
                >
                  {t("common.delete")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
        {save.type === "autosave" ? (
          <div aria-live="polite" className="flex items-center gap-1 text-xs">
            <PaneSaveStatusContent
              onRetry={save.onRetry}
              onShowProblems={save.onShowProblems}
              status={save.status}
            />
          </div>
        ) : (
          <Button
            disabled={save.disabled}
            loading={save.loading}
            onClick={save.onSave}
            type="button"
          >
            {t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
};
