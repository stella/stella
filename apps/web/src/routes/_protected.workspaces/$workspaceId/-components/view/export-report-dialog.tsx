import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceView } from "@/lib/types";
import { reportExportsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/report-exports";

import { ReportExportHistory } from "./report-export-history";
import {
  registerReportExportToast,
  useReportExportTrackingStore,
} from "./report-export-tracking";
import type { ReportExportDeliveryMode } from "./report-export-tracking";

/**
 * "Export report…" for a table view. The toolbar button opens a small dialog
 * (report template + delivery choice). On submit the export is enqueued and the
 * dialog closes. A workspace-level tracker owns progress after enqueue, so it
 * survives view switches and reloads. Receipt history is loaded only while the
 * dialog is open.
 */

type ReportFormat = "docx" | "pdf";

/** The picker encodes each option as `<prefix><id>` so a single Select can mix
 * deployment built-ins with the org's stored report templates. */
const BUILTIN_PREFIX = "builtin:";
const STORED_PREFIX = "stored:";

type ExportReportControlProps = {
  initialMode?: ReportExportDeliveryMode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  view: Pick<WorkspaceView, "id">;
  workspaceId: string;
};

export const ExportReportControl = ({
  initialMode: initialModeProp,
  onOpenChange,
  open,
  view,
  workspaceId,
}: ExportReportControlProps) => {
  const initialMode = initialModeProp ?? "workspace";
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const requestedBy = useRouteContext({
    from: "/_protected",
    select: (context) => context.user.id,
  });

  const handleStarted = (exportId: string, mode: ReportExportDeliveryMode) => {
    const toastId = stellaToast.loading(t("common.preparing"));
    registerReportExportToast(exportId, toastId);
    useReportExportTrackingStore
      .getState()
      .track({ exportId, mode, requestedBy, workspaceId });
    queryClient
      .invalidateQueries({ queryKey: reportExportsKeys.all(workspaceId) })
      .catch((error: unknown) => analytics.captureError(error));
    onOpenChange(false);
  };

  return (
    <ExportReportDialog
      initialMode={initialMode}
      onClose={() => onOpenChange(false)}
      onOpenChange={onOpenChange}
      onStarted={handleStarted}
      open={open}
      view={view}
      workspaceId={workspaceId}
    />
  );
};

type ExportReportDialogProps = {
  initialMode: ReportExportDeliveryMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  onStarted: (exportId: string, mode: ReportExportDeliveryMode) => void;
  view: Pick<WorkspaceView, "id">;
  workspaceId: string;
};

const ExportReportDialog = ({
  initialMode,
  open,
  onOpenChange,
  onClose,
  onStarted,
  view,
  workspaceId,
}: ExportReportDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {/* Mount only while open so each open re-reads the template list and resets
        the picker to the preselected built-in. */}
    {open ? (
      <ExportReportDialogBody
        initialMode={initialMode}
        onClose={onClose}
        onStarted={onStarted}
        view={view}
        workspaceId={workspaceId}
      />
    ) : null}
  </Dialog>
);

const DELIVERY_MODES = [
  // Reuse the canonical "Save to matter" string rather than duplicating it.
  { mode: "workspace", labelKey: "templates.moveToMatter" },
  { mode: "download", labelKey: "common.download" },
] as const satisfies readonly {
  mode: ReportExportDeliveryMode;
  labelKey: TranslationKey;
}[];

const FORMATS = [
  { format: "docx", labelKey: "workspaces.views.reportExport.formatDocx" },
  { format: "pdf", labelKey: "workspaces.views.reportExport.formatPdf" },
] as const satisfies readonly {
  format: ReportFormat;
  labelKey: TranslationKey;
}[];

type ExportReportDialogBodyProps = Omit<
  ExportReportDialogProps,
  "open" | "onOpenChange"
>;

const ExportReportDialogBody = ({
  onClose,
  onStarted,
  view,
  workspaceId,
  initialMode,
}: ExportReportDialogBodyProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const [templateValue, setTemplateValue] = useState<string | null>(null);
  const [mode, setMode] = useState<ReportExportDeliveryMode>(initialMode);
  const [format, setFormat] = useState<ReportFormat>("docx");
  // AI-drafted narrative (executive + per-contract summaries) is on by default;
  // turning it off skips every model call for a fast, deterministic export.
  const [aiNarrative, setAiNarrative] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [customizing, setCustomizing] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["report-templates", workspaceId],
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .reports.templates.get({ fetch: { signal } });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
  });

  const builtins = data ? data.builtins : [];
  const stored = data ? data.stored : [];
  const hasTemplates = builtins.length + stored.length > 0;

  // Derive the selected value during render (Rule 1): default to the first
  // built-in (Due Diligence Report) until the user picks, no effect needed.
  const firstOption = (() => {
    const builtin = builtins.at(0);
    if (builtin) {
      return `${BUILTIN_PREFIX}${builtin.key}`;
    }
    const storedTemplate = stored.at(0);
    if (storedTemplate) {
      return `${STORED_PREFIX}${storedTemplate.id}`;
    }
    return null;
  })();
  const resolvedValue = templateValue ?? firstOption;

  const selectedName = (() => {
    if (!resolvedValue) {
      return "";
    }
    if (resolvedValue.startsWith(BUILTIN_PREFIX)) {
      const key = resolvedValue.slice(BUILTIN_PREFIX.length);
      return builtins.find((builtin) => builtin.key === key)?.name ?? "";
    }
    const id = resolvedValue.slice(STORED_PREFIX.length);
    return (
      stored.find((storedTemplate) => storedTemplate.id === id)?.name ?? ""
    );
  })();

  const handleSubmit = async () => {
    if (!resolvedValue) {
      return;
    }
    const templateRef = resolvedValue.startsWith(BUILTIN_PREFIX)
      ? {
          type: "builtin" as const,
          key: resolvedValue.slice(BUILTIN_PREFIX.length),
        }
      : {
          type: "stored" as const,
          templateId: toSafeId<"template">(
            resolvedValue.slice(STORED_PREFIX.length),
          ),
        };

    setSubmitting(true);
    const result = await Result.tryPromise(
      async () =>
        await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .reports.export.post({
            templateRef,
            viewId: toSafeId<"workspaceView">(view.id),
            mode,
            format,
            aiNarrative,
          }),
    );
    setSubmitting(false);

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("workspaces.views.reportExport.failed"),
        description: t("common.unexpectedError"),
      });
      return;
    }

    const response = result.value;
    if (response.error) {
      analytics.captureError(toAPIError(response.error));
      stellaToast.add({
        type: "error",
        title: t("workspaces.views.reportExport.failed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    onStarted(response.data.exportId, mode);
  };

  // "Customize" is offered only for a built-in: cloning it into the org's
  // templates is the one way to see and edit the layout in Template Studio.
  const selectedBuiltinKey =
    resolvedValue && resolvedValue.startsWith(BUILTIN_PREFIX)
      ? resolvedValue.slice(BUILTIN_PREFIX.length)
      : null;

  const handleCustomize = async () => {
    if (selectedBuiltinKey === null) {
      return;
    }
    setCustomizing(true);
    const result = await Result.tryPromise(
      async () =>
        await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .reports.templates["clone-builtin"].post({ key: selectedBuiltinKey }),
    );
    setCustomizing(false);

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("common.unexpectedError"),
      });
      return;
    }
    const response = result.value;
    if (response.error) {
      analytics.captureError(toAPIError(response.error));
      stellaToast.add({
        type: "error",
        title: userErrorMessage(response.error, t("common.unexpectedError")),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("workspaces.views.reportExport.customized"),
    });
    onClose();
    const navigation = await Result.tryPromise(
      async () => await navigate({ to: "/knowledge/templates" }),
    );
    if (Result.isError(navigation)) {
      analytics.captureError(navigation.error);
    }
  };

  return (
    <DialogPopup className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t("workspaces.views.reportExport.title")}</DialogTitle>
        <DialogDescription>
          {t("workspaces.views.reportExport.description")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id="report-template-label">
            {t("workspaces.views.reportExport.templateLabel")}
          </span>
          <TemplateField
            isError={isError}
            isLoading={isLoading}
            builtins={builtins}
            hasTemplates={hasTemplates}
            onValueChange={setTemplateValue}
            selectedName={selectedName}
            stored={stored}
            value={resolvedValue}
          />
          {selectedBuiltinKey !== null && (
            <Button
              className="self-start"
              disabled={customizing}
              onClick={() => {
                void handleCustomize();
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("workspaces.views.reportExport.customize")}
            </Button>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={aiNarrative} onCheckedChange={setAiNarrative} />
          {t("workspaces.views.reportExport.aiSummaries")}
        </label>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium">
            {t("workspaces.views.reportExport.deliveryLabel")}
          </legend>
          <div
            aria-label={t("workspaces.views.reportExport.deliveryLabel")}
            className="flex gap-1"
            role="radiogroup"
          >
            {DELIVERY_MODES.map((option) => (
              <Button
                aria-checked={mode === option.mode}
                key={option.mode}
                onClick={() => setMode(option.mode)}
                role="radio"
                size="sm"
                tabIndex={mode === option.mode ? 0 : -1}
                type="button"
                variant={mode === option.mode ? "secondary" : "outline"}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium">
            {t("workspaces.views.reportExport.formatLabel")}
          </legend>
          <div
            aria-label={t("workspaces.views.reportExport.formatLabel")}
            className="flex gap-1"
            role="radiogroup"
          >
            {FORMATS.map((option) => (
              <Button
                aria-checked={format === option.format}
                key={option.format}
                onClick={() => setFormat(option.format)}
                role="radio"
                size="sm"
                tabIndex={format === option.format ? 0 : -1}
                type="button"
                variant={format === option.format ? "secondary" : "outline"}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
        </fieldset>

        <ReportExportHistory workspaceId={workspaceId} />
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={submitting || !resolvedValue}
          onClick={() => {
            void handleSubmit();
          }}
          type="button"
        >
          {t("workspaces.views.reportExport.submit")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};

type TemplateFieldProps = {
  isLoading: boolean;
  isError: boolean;
  hasTemplates: boolean;
  builtins: { key: string; name: string }[];
  stored: { id: string; name: string }[];
  value: string | null;
  selectedName: string;
  onValueChange: (value: string) => void;
};

const TemplateField = ({
  isLoading,
  isError,
  hasTemplates,
  builtins,
  stored,
  value,
  selectedName,
  onValueChange,
}: TemplateFieldProps) => {
  const t = useTranslations();

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("workspaces.views.reportExport.loadingTemplates")}
      </p>
    );
  }
  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("workspaces.views.reportExport.loadTemplatesFailed")}
      </p>
    );
  }
  if (!hasTemplates || value === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("workspaces.views.reportExport.noTemplates")}
      </p>
    );
  }

  return (
    <Select
      onValueChange={(next) => {
        if (next !== null) {
          onValueChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-labelledby="report-template-label"
        className="w-full"
        size="sm"
      >
        <SelectValue placeholder={selectedName}>{selectedName}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {builtins.map((builtin) => (
          <SelectItem
            key={builtin.key}
            value={`${BUILTIN_PREFIX}${builtin.key}`}
          >
            {builtin.name}
          </SelectItem>
        ))}
        {builtins.length > 0 && stored.length > 0 && <SelectSeparator />}
        {stored.map((storedTemplate) => (
          <SelectItem
            key={storedTemplate.id}
            value={`${STORED_PREFIX}${storedTemplate.id}`}
          >
            {storedTemplate.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
