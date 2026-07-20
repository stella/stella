import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Trash2Icon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

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
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import {
  FLOW_SCHEDULE_FREQUENCIES,
  FLOW_SCHEDULE_FREQUENCY_LABEL_KEYS,
  FLOW_STEP_KIND_HELP_KEYS,
  FLOW_STEP_KIND_ICONS,
  FLOW_STEP_KIND_LABEL_KEYS,
  FLOW_STEP_KINDS,
  FLOW_TRIGGER_TYPE_LABEL_KEYS,
  FLOW_TRIGGER_TYPES,
  type FlowStepKind,
  type FlowTriggerType,
} from "@/components/flows/flow-meta";
import { FlowSwitch } from "@/components/flows/flow-switch";
import { usePermissions } from "@/hooks/use-permissions";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import {
  buildFlowExample,
  type FlowExampleKey,
} from "@/routes/_protected.knowledge/-components/flow-examples";
import { FlowExtensionInput } from "@/routes/_protected.knowledge/-components/flow-extension-input";
import type {
  FlowDefinitionBody,
  FlowStep,
  FlowTrigger,
} from "@/routes/_protected.knowledge/-components/flow-types";
import {
  flowDetailOptions,
  knowledgeKeys,
} from "@/routes/_protected.knowledge/-queries";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

const MAX_FLOW_STEPS = 20;

// ── Root component ────────────────────────────────────

type FlowEditorProps = {
  organizationId: string;
  flowId: string | null;
  example?: FlowExampleKey | undefined;
  onBack: () => void;
  onSaved: () => void;
};

export const FlowEditor = ({
  organizationId,
  flowId,
  example,
  onBack,
  onSaved,
}: FlowEditorProps) => {
  // Scoped to `flows.examples` so the example builder narrows its key union to
  // that namespace instead of the full message union (which overflows the
  // native compiler's union-representation limit — TS2590).
  const tExamples = useTranslations("flows.examples");

  if (flowId === null) {
    const preset = example ? buildFlowExample(example, tExamples) : null;
    return (
      <FlowEditorForm
        flowId={null}
        initialDescription={preset?.description ?? ""}
        initialEnabled={true}
        initialSteps={
          preset?.steps ?? [
            { kind: "ai", name: "", prompt: "", includeDocuments: true },
          ]
        }
        initialTrigger={{ type: "manual" }}
        initialName={preset?.name ?? ""}
        onBack={onBack}
        onSaved={onSaved}
        organizationId={organizationId}
      />
    );
  }

  return (
    <FlowEditorLoader
      flowId={flowId}
      onBack={onBack}
      onSaved={onSaved}
      organizationId={organizationId}
    />
  );
};

const FlowEditorLoader = ({
  organizationId,
  flowId,
  onBack,
  onSaved,
}: {
  organizationId: string;
  flowId: string;
  onBack: () => void;
  onSaved: () => void;
}) => {
  const t = useTranslations();
  const detailQuery = useQuery(flowDetailOptions(organizationId, flowId));

  if (detailQuery.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("flows.loading")}</p>
      </div>
    );
  }

  const detail = detailQuery.data;
  if (detailQuery.isError || !detail || !("steps" in detail)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("flows.loadFailed")}</p>
      </div>
    );
  }

  return (
    <FlowEditorForm
      flowId={flowId}
      initialDescription={detail.description ?? ""}
      initialEnabled={detail.enabled}
      initialSteps={detail.steps}
      initialTrigger={detail.trigger}
      initialName={detail.name}
      onBack={onBack}
      onSaved={onSaved}
      organizationId={organizationId}
    />
  );
};

// ── Trigger draft (keeps both sub-configs so switching type is lossless) ──

type TriggerDraft = {
  type: FlowTriggerType;
  schedule: {
    workspaceId: string;
    frequency: (typeof FLOW_SCHEDULE_FREQUENCIES)[number];
    hourUtc: number;
    dayOfWeek: number;
    dayOfMonth: number;
  };
  fileUpload: {
    allWorkspaces: boolean;
    workspaceIds: string[];
    anyExtension: boolean;
    extensions: string[];
  };
};

const defaultTriggerDraft = (): TriggerDraft => ({
  type: "manual",
  schedule: {
    workspaceId: "",
    frequency: "daily",
    hourUtc: 9,
    dayOfWeek: 1,
    dayOfMonth: 1,
  },
  fileUpload: {
    allWorkspaces: true,
    workspaceIds: [],
    anyExtension: true,
    extensions: [],
  },
});

const deriveTriggerDraft = (trigger: FlowTrigger): TriggerDraft => {
  const draft = defaultTriggerDraft();
  if (trigger.type === "schedule") {
    draft.type = "schedule";
    draft.schedule.workspaceId = trigger.workspaceId;
    draft.schedule.frequency = trigger.schedule.frequency;
    draft.schedule.hourUtc = trigger.schedule.hourUtc;
    draft.schedule.dayOfWeek = trigger.schedule.dayOfWeek ?? 1;
    draft.schedule.dayOfMonth = trigger.schedule.dayOfMonth ?? 1;
    return draft;
  }
  if (trigger.type === "file-upload") {
    draft.type = "file-upload";
    draft.fileUpload.allWorkspaces = trigger.workspaceIds === null;
    draft.fileUpload.workspaceIds = trigger.workspaceIds ?? [];
    draft.fileUpload.anyExtension = trigger.fileExtensions === null;
    draft.fileUpload.extensions = trigger.fileExtensions ?? [];
    return draft;
  }
  return draft;
};

// Returns the save-payload trigger shape (branded workspace ids), not the
// response-derived `FlowTrigger`, so the literal stays assignable to the
// POST/PUT body without widening the ids back to plain strings.
const buildTrigger = (draft: TriggerDraft): FlowDefinitionBody["trigger"] => {
  if (draft.type === "schedule") {
    const { frequency, hourUtc, dayOfWeek, dayOfMonth } = draft.schedule;
    return {
      type: "schedule",
      workspaceId: toSafeId<"workspace">(draft.schedule.workspaceId),
      schedule: {
        frequency,
        hourUtc,
        ...(frequency === "weekly" ? { dayOfWeek } : {}),
        ...(frequency === "monthly" ? { dayOfMonth } : {}),
      },
    };
  }
  if (draft.type === "file-upload") {
    return {
      type: "file-upload",
      workspaceIds: draft.fileUpload.allWorkspaces
        ? null
        : draft.fileUpload.workspaceIds.map((id) => toSafeId<"workspace">(id)),
      fileExtensions: draft.fileUpload.anyExtension
        ? null
        : draft.fileUpload.extensions,
    };
  }
  return { type: "manual" };
};

const newStep = (kind: FlowStepKind): FlowStep => {
  if (kind === "ai") {
    return { kind: "ai", name: "", prompt: "", includeDocuments: true };
  }
  if (kind === "review-gate") {
    return { kind: "review-gate", name: "", instructions: "" };
  }
  return { kind: "create-document", name: "", documentTitle: "" };
};

// Steps carry a stable client-only `_id` so the reorderable/removable list
// keys on identity rather than array position. It is stripped before the body
// is sent to the API (the server schema only knows `FlowStep`).
type EditableStep = FlowStep & { _id: string };

const withStepId = (step: FlowStep): EditableStep => ({
  ...step,
  _id: crypto.randomUUID(),
});

// ── Editor form ───────────────────────────────────────

type FlowEditorFormProps = {
  organizationId: string;
  flowId: string | null;
  initialName: string;
  initialDescription: string;
  initialEnabled: boolean;
  initialTrigger: FlowTrigger;
  initialSteps: FlowStep[];
  onBack: () => void;
  onSaved: () => void;
};

const FlowEditorForm = ({
  organizationId,
  flowId,
  initialName,
  initialDescription,
  initialEnabled,
  initialTrigger,
  initialSteps,
  onBack,
  onSaved,
}: FlowEditorFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const isEdit = flowId !== null;
  const canSave = usePermissions(
    isEdit ? { flow: ["update"] } : { flow: ["create"] },
  );
  const canDelete = usePermissions({ flow: ["delete"] });

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [trigger, setTrigger] = useState<TriggerDraft>(() =>
    deriveTriggerDraft(initialTrigger),
  );
  const [steps, setSteps] = useState<EditableStep[]>(() =>
    initialSteps.map(withStepId),
  );
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(organizationId),
  );
  const workspaces = workspacesData?.workspaces ?? [];

  const updateStep = (index: number, next: FlowStep) => {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...next, _id: step._id } : step)),
    );
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    setSteps((prev) => {
      if (target < 0 || target >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const current = next[index];
      const swap = next[target];
      if (!current || !swap) {
        return prev;
      }
      next[index] = swap;
      next[target] = current;
      return next;
    });
  };

  const addStep = (kind: FlowStepKind) => {
    setSteps((prev) =>
      prev.length >= MAX_FLOW_STEPS
        ? prev
        : [...prev, withStepId(newStep(kind))],
    );
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      stellaToast.add({ type: "error", title: t("flows.nameRequired") });
      return;
    }
    if (steps.length === 0) {
      stellaToast.add({ type: "error", title: t("flows.steps.required") });
      return;
    }
    for (const step of steps) {
      if (step.name.trim() === "") {
        stellaToast.add({
          type: "error",
          title: t("flows.steps.nameRequired"),
        });
        return;
      }
      if (step.kind === "ai" && step.prompt.trim() === "") {
        stellaToast.add({
          type: "error",
          title: t("flows.steps.promptRequired"),
        });
        return;
      }
      if (step.kind === "create-document" && step.documentTitle.trim() === "") {
        stellaToast.add({
          type: "error",
          title: t("flows.steps.documentTitleRequired"),
        });
        return;
      }
    }
    if (trigger.type === "schedule" && trigger.schedule.workspaceId === "") {
      stellaToast.add({
        type: "error",
        title: t("flows.schedule.workspaceRequired"),
      });
      return;
    }

    const trimmedDescription = description.trim();
    const body: FlowDefinitionBody = {
      name: trimmedName,
      description: trimmedDescription === "" ? null : trimmedDescription,
      steps: steps.map(({ _id, ...step }) => step),
      trigger: buildTrigger(trigger),
      enabled,
    };

    setSaving(true);
    const response =
      flowId === null
        ? await api.flows.post(body)
        : await api
            .flows({ flowId: toSafeId<"flowDefinition">(flowId) })
            .put(body);
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("flows.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: isEdit ? t("flows.updated") : t("flows.created"),
    });
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.flows.all(organizationId),
      }),
      "handleSave",
    );
    onSaved();
  };

  const handleDelete = async () => {
    if (flowId === null) {
      return;
    }
    setSaving(true);
    const response = await api
      .flows({ flowId: toSafeId<"flowDefinition">(flowId) })
      .delete();
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("flows.deleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({ type: "success", title: t("flows.deleted") });
    setDeleteOpen(false);
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.flows.all(organizationId),
      }),
      "handleDelete",
    );
    onSaved();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="flex items-center justify-between gap-2">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeftIcon />
            {t("common.back")}
          </Button>
          <div className="flex items-center gap-2">
            {isEdit && canDelete && (
              <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
                <Button
                  aria-label={t("flows.deleteFlow")}
                  onClick={() => setDeleteOpen(true)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("flows.deleteFlow")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("common.deleteConfirmDescription", {
                        name: name.trim() || t("flows.createFlow"),
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogClose render={<Button variant="ghost" />}>
                      {t("common.cancel")}
                    </AlertDialogClose>
                    <Button
                      disabled={saving}
                      onClick={() => {
                        detached(handleDelete(), "FlowEditorForm");
                      }}
                      variant="destructive"
                    >
                      {t("common.delete")}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>
            )}
            <Button
              disabled={!canSave || saving}
              loading={saving}
              onClick={() => {
                detached(handleSave(), "FlowEditorForm");
              }}
              type="button"
            >
              {t("common.save")}
            </Button>
          </div>
        </div>

        {!isEdit && (
          <p className="text-muted-foreground text-sm">
            {t("flows.editor.newFlowIntro")}
          </p>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="flow-name">{t("common.name")}</Label>
          <Input
            id="flow-name"
            onChange={(e) => setName(e.target.value)}
            placeholder={t("flows.namePlaceholder")}
            value={name}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="flow-description">{t("common.description")}</Label>
          <Textarea
            className="min-h-[60px]"
            id="flow-description"
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("flows.descriptionPlaceholder")}
            value={description}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">{t("flows.enabledLabel")}</p>
            <p className="text-muted-foreground text-xs">
              {t("flows.enabledDescription")}
            </p>
          </div>
          <FlowSwitch
            aria-label={
              enabled ? t("flows.disableFlow") : t("flows.enableFlow")
            }
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        <TriggerSection
          onChange={setTrigger}
          trigger={trigger}
          workspaces={workspaces}
        />

        <StepsSection
          onAdd={addStep}
          onMove={moveStep}
          onRemove={removeStep}
          onUpdate={updateStep}
          steps={steps}
        />
      </div>
    </div>
  );
};

// ── Trigger section ───────────────────────────────────

type WorkspaceOption = { id: string; name: string };

const TriggerSection = ({
  trigger,
  workspaces,
  onChange,
}: {
  trigger: TriggerDraft;
  workspaces: WorkspaceOption[];
  onChange: (next: TriggerDraft) => void;
}) => {
  const t = useTranslations();

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{t("flows.trigger.title")}</h2>
      <div className="grid gap-1.5">
        <Label htmlFor="flow-trigger-type">
          {t("flows.trigger.typeLabel")}
        </Label>
        <Select
          onValueChange={(value) => {
            const next = FLOW_TRIGGER_TYPES.find((type) => type === value);
            if (next) {
              onChange({ ...trigger, type: next });
            }
          }}
          value={trigger.type}
        >
          <SelectTrigger id="flow-trigger-type">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {FLOW_TRIGGER_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(FLOW_TRIGGER_TYPE_LABEL_KEYS[type])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {trigger.type === "manual" && (
        <p className="text-muted-foreground text-xs">
          {t("flows.trigger.manualHint")}
        </p>
      )}

      {trigger.type === "schedule" && (
        <ScheduleConfig
          onChange={(schedule) => onChange({ ...trigger, schedule })}
          schedule={trigger.schedule}
          workspaces={workspaces}
        />
      )}

      {trigger.type === "file-upload" && (
        <FileUploadConfig
          fileUpload={trigger.fileUpload}
          onChange={(fileUpload) => onChange({ ...trigger, fileUpload })}
          workspaces={workspaces}
        />
      )}
    </div>
  );
};

const HOURS_OF_DAY = Array.from({ length: 24 }, (_, hour) => hour);
const DAYS_OF_WEEK = Array.from({ length: 7 }, (_, day) => day);
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, index) => index + 1);

// A fixed reference week (2024-01-01 is a Monday → index 1) used only to render
// localized weekday names; day index maps 0=Sun … 6=Sat.
const weekdayLabel = (dayIndex: number): string =>
  new Date(Date.UTC(2023, 0, 1 + dayIndex)).toLocaleDateString(
    getFormattingLocale(),
    { weekday: "long" },
  );

const ScheduleConfig = ({
  schedule,
  workspaces,
  onChange,
}: {
  schedule: TriggerDraft["schedule"];
  workspaces: WorkspaceOption[];
  onChange: (next: TriggerDraft["schedule"]) => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-1.5">
        <Label htmlFor="flow-schedule-workspace">{t("common.matter")}</Label>
        <Select
          onValueChange={(value) => {
            if (value) {
              onChange({ ...schedule, workspaceId: value });
            }
          }}
          value={schedule.workspaceId || null}
        >
          <SelectTrigger id="flow-schedule-workspace">
            <SelectValue placeholder={t("flows.schedule.selectWorkspace")} />
          </SelectTrigger>
          <SelectPopup>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="grid gap-3 @sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="flow-schedule-frequency">
            {t("flows.schedule.frequency")}
          </Label>
          <Select
            onValueChange={(value) => {
              const next = FLOW_SCHEDULE_FREQUENCIES.find(
                (frequency) => frequency === value,
              );
              if (next) {
                onChange({ ...schedule, frequency: next });
              }
            }}
            value={schedule.frequency}
          >
            <SelectTrigger id="flow-schedule-frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {FLOW_SCHEDULE_FREQUENCIES.map((frequency) => (
                <SelectItem key={frequency} value={frequency}>
                  {t(FLOW_SCHEDULE_FREQUENCY_LABEL_KEYS[frequency])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="flow-schedule-hour">{t("flows.schedule.hour")}</Label>
          <Select
            onValueChange={(value) => {
              if (value) {
                onChange({ ...schedule, hourUtc: Number(value) });
              }
            }}
            value={schedule.hourUtc.toString()}
          >
            <SelectTrigger id="flow-schedule-hour">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {HOURS_OF_DAY.map((hour) => (
                <SelectItem key={hour} value={hour.toString()}>
                  {`${hour.toString().padStart(2, "0")}:00`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {schedule.frequency === "weekly" && (
        <div className="grid gap-1.5">
          <Label htmlFor="flow-schedule-weekday">
            {t("flows.schedule.dayOfWeek")}
          </Label>
          <Select
            onValueChange={(value) => {
              if (value) {
                onChange({ ...schedule, dayOfWeek: Number(value) });
              }
            }}
            value={String(schedule.dayOfWeek)}
          >
            <SelectTrigger id="flow-schedule-weekday">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {DAYS_OF_WEEK.map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {weekdayLabel(day)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}

      {schedule.frequency === "monthly" && (
        <div className="grid gap-1.5">
          <Label htmlFor="flow-schedule-monthday">
            {t("flows.schedule.dayOfMonth")}
          </Label>
          <Select
            onValueChange={(value) => {
              if (value) {
                onChange({ ...schedule, dayOfMonth: Number(value) });
              }
            }}
            value={String(schedule.dayOfMonth)}
          >
            <SelectTrigger id="flow-schedule-monthday">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {DAYS_OF_MONTH.map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {format.number(day)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        {t("flows.schedule.utcHint")}
      </p>
    </div>
  );
};

const FileUploadConfig = ({
  fileUpload,
  workspaces,
  onChange,
}: {
  fileUpload: TriggerDraft["fileUpload"];
  workspaces: WorkspaceOption[];
  onChange: (next: TriggerDraft["fileUpload"]) => void;
}) => {
  const t = useTranslations();

  const toggleWorkspace = (id: string, checked: boolean) => {
    const next = checked
      ? [...fileUpload.workspaceIds, id]
      : fileUpload.workspaceIds.filter((existing) => existing !== id);
    onChange({ ...fileUpload, workspaceIds: next });
  };

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-1.5">
        <Label>{t("common.matters")}</Label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={fileUpload.allWorkspaces}
            onCheckedChange={(checked) =>
              onChange({ ...fileUpload, allWorkspaces: checked })
            }
          />
          {t("flows.fileUpload.allWorkspaces")}
        </label>
        {!fileUpload.allWorkspaces && (
          <div className="mt-1 grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2">
            {workspaces.map((workspace) => (
              <label
                className="flex items-center gap-2 text-sm"
                key={workspace.id}
              >
                <Checkbox
                  checked={fileUpload.workspaceIds.includes(workspace.id)}
                  onCheckedChange={(checked) =>
                    toggleWorkspace(workspace.id, checked)
                  }
                />
                <span className="truncate" dir="auto">
                  {workspace.name}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label>{t("flows.fileUpload.extensions")}</Label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={fileUpload.anyExtension}
            onCheckedChange={(checked) =>
              onChange({ ...fileUpload, anyExtension: checked })
            }
          />
          {t("flows.fileUpload.anyExtension")}
        </label>
        {!fileUpload.anyExtension && (
          <FlowExtensionInput
            extensions={fileUpload.extensions}
            onChange={(extensions) => onChange({ ...fileUpload, extensions })}
          />
        )}
      </div>
    </div>
  );
};

// ── Steps section ─────────────────────────────────────

const StepsSection = ({
  steps,
  onUpdate,
  onRemove,
  onMove,
  onAdd,
}: {
  steps: EditableStep[];
  onUpdate: (index: number, next: FlowStep) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onAdd: (kind: FlowStepKind) => void;
}) => {
  const t = useTranslations();
  const atLimit = steps.length >= MAX_FLOW_STEPS;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("flows.steps.title")}</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("flows.stepCount", { count: steps.length })}
        </span>
      </div>

      {steps.length === 0 ? (
        <p className="text-muted-foreground py-4 text-center text-sm">
          {t("flows.steps.empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {steps.map((step, index) => (
            <FlowStepEditor
              index={index}
              key={step._id}
              onMoveDown={() => onMove(index, "down")}
              onMoveUp={() => onMove(index, "up")}
              onRemove={() => onRemove(index)}
              onUpdate={(next) => onUpdate(index, next)}
              step={step}
              total={steps.length}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {t("flows.steps.add")}
        </span>
        {FLOW_STEP_KINDS.map((kind) => {
          const Icon = FLOW_STEP_KIND_ICONS[kind];
          return (
            <Button
              disabled={atLimit}
              key={kind}
              onClick={() => onAdd(kind)}
              size="sm"
              title={t(FLOW_STEP_KIND_HELP_KEYS[kind])}
              type="button"
              variant="outline"
            >
              <Icon />
              {t(FLOW_STEP_KIND_LABEL_KEYS[kind])}
            </Button>
          );
        })}
      </div>
    </div>
  );
};

const FlowStepEditor = ({
  step,
  index,
  total,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: FlowStep;
  index: number;
  total: number;
  onUpdate: (next: FlowStep) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const Icon = FLOW_STEP_KIND_ICONS[step.kind];

  return (
    <li className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {format.number(index + 1)}
          </span>
          <Icon className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">
            {t(FLOW_STEP_KIND_LABEL_KEYS[step.kind])}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            aria-label={t("common.moveUp")}
            disabled={index === 0}
            onClick={onMoveUp}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            aria-label={t("common.moveDown")}
            disabled={index === total - 1}
            onClick={onMoveDown}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
          <Button
            aria-label={t("common.remove")}
            onClick={onRemove}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {t(FLOW_STEP_KIND_HELP_KEYS[step.kind])}
      </p>

      <div className="grid gap-1.5">
        <Label htmlFor={`flow-step-name-${index}`}>{t("common.name")}</Label>
        <Input
          id={`flow-step-name-${index}`}
          onChange={(e) => onUpdate({ ...step, name: e.target.value })}
          placeholder={t("flows.steps.namePlaceholder")}
          value={step.name}
        />
      </div>

      {step.kind === "ai" && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={`flow-step-prompt-${index}`}>
              {t("flows.steps.prompt")}
            </Label>
            <Textarea
              className="min-h-[80px]"
              id={`flow-step-prompt-${index}`}
              onChange={(e) => onUpdate({ ...step, prompt: e.target.value })}
              placeholder={t("flows.steps.promptPlaceholder")}
              value={step.prompt}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={step.includeDocuments}
              onCheckedChange={(checked) =>
                onUpdate({ ...step, includeDocuments: checked })
              }
            />
            {t("flows.steps.includeDocuments")}
          </label>
        </>
      )}

      {step.kind === "review-gate" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`flow-step-instructions-${index}`}>
            {t("flows.steps.instructions")}
          </Label>
          <Textarea
            className="min-h-[60px]"
            id={`flow-step-instructions-${index}`}
            onChange={(e) =>
              onUpdate({ ...step, instructions: e.target.value })
            }
            placeholder={t("flows.steps.instructionsPlaceholder")}
            value={step.instructions}
          />
        </div>
      )}

      {step.kind === "create-document" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`flow-step-doctitle-${index}`}>
            {t("flows.steps.documentTitle")}
          </Label>
          <Input
            id={`flow-step-doctitle-${index}`}
            onChange={(e) =>
              onUpdate({ ...step, documentTitle: e.target.value })
            }
            placeholder={t("flows.steps.documentTitlePlaceholder")}
            value={step.documentTitle}
          />
        </div>
      )}
    </li>
  );
};
