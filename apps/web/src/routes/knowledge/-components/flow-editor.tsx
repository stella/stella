import { useRef, useState } from "react";
import type { SetStateAction } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";
import { Temporal } from "@stll/time";
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
import { Checkbox } from "@stll/ui/checkbox";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Trash2Icon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { Switch } from "@stll/ui/switch";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { TruncatedText } from "@stll/ui/truncated-text";

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
import { MatterOptionLabel } from "@/components/matter-option-label";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useMountEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { getFormattingLocale } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import {
  captureSessionQueryOwner,
  isCurrentSessionQueryOwner,
  isObservedSessionQueryOwner,
} from "@/lib/account/auth-query-owner";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { flowDetailOptions, knowledgeKeys } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { WEEKDAY_NAME_FORMAT } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";
import { createUuid } from "@/lib/uuid";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import {
  buildFlowExample,
  type FlowExampleKey,
} from "@/routes/knowledge/-components/flow-examples";
import { FlowExtensionInput } from "@/routes/knowledge/-components/flow-extension-input";
import type {
  FlowDefinitionBody,
  FlowDefinitionDetail,
  FlowDefinitionUpdateBody,
  FlowStep,
  FlowTrigger,
} from "@/routes/knowledge/-components/flow-types";

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
  const { id: userId } = useAuthenticatedUser();
  const ownerKey = JSON.stringify([organizationId, userId, flowId]);

  if (flowId === null) {
    const preset = example ? buildFlowExample(example, tExamples) : null;
    return (
      <FlowEditorForm
        key={ownerKey}
        flowId={null}
        initialSnapshot={{
          name: preset?.name ?? "",
          description: preset?.description ?? "",
          enabled: true,
          steps: preset?.steps ?? [
            { kind: "ai", name: "", prompt: "", includeDocuments: true },
          ],
          trigger: { type: "manual" },
          updatedAt: null,
        }}
        onBack={onBack}
        onSaved={onSaved}
        organizationId={organizationId}
      />
    );
  }

  return (
    <FlowEditorLoader
      key={ownerKey}
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
  const detailView = queryView(detailQuery);
  useQueryViewError(detailView, "FlowEditorLoader:detail");

  switch (detailView.type) {
    case "pending":
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">{t("flows.loading")}</p>
        </div>
      );
    case "empty":
    case "error":
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground text-sm">
            {t("flows.loadFailed")}
          </p>
        </div>
      );
    case "items":
      return (
        <FlowEditorForm
          flowId={flowId}
          initialSnapshot={detailView.items}
          onBack={onBack}
          onSaved={onSaved}
          organizationId={organizationId}
        />
      );
    default:
      detailView satisfies never;
      return panic("Unhandled workflow detail state");
  }
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
    workspaceScope:
      | { type: "all"; previousWorkspaceIds: string[] }
      | { type: "selected"; workspaceIds: string[] };
    extensionScope:
      | { type: "any"; previousExtensions: string[] }
      | { type: "selected"; extensions: string[] };
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
    workspaceScope: { type: "all", previousWorkspaceIds: [] },
    extensionScope: { type: "any", previousExtensions: [] },
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
    draft.fileUpload.workspaceScope =
      trigger.workspaceIds === null
        ? { type: "all", previousWorkspaceIds: [] }
        : { type: "selected", workspaceIds: trigger.workspaceIds };
    draft.fileUpload.extensionScope =
      trigger.fileExtensions === null
        ? { type: "any", previousExtensions: [] }
        : { type: "selected", extensions: trigger.fileExtensions };
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
    const { workspaceScope, extensionScope } = draft.fileUpload;
    return {
      type: "file-upload",
      workspaceIds:
        workspaceScope.type === "all"
          ? null
          : workspaceScope.workspaceIds.map((id) => toSafeId<"workspace">(id)),
      fileExtensions:
        extensionScope.type === "any" ? null : extensionScope.extensions,
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
  _id: createUuid(),
});

// ── Editor form ───────────────────────────────────────

type FlowEditorSnapshot = Pick<
  FlowDefinitionDetail,
  "name" | "description" | "enabled" | "steps" | "trigger"
> & { updatedAt: FlowDefinitionDetail["updatedAt"] | null };

type FlowEditorFormProps = {
  organizationId: string;
  flowId: string | null;
  initialSnapshot: FlowEditorSnapshot;
  onBack: () => void;
  onSaved: () => void;
};

type FlowEditorDraft = {
  name: string;
  description: string;
  enabled: boolean;
  trigger: TriggerDraft;
  steps: EditableStep[];
  expectedUpdatedAt: FlowDefinitionDetail["updatedAt"] | null;
};

const FlowEditorForm = (props: FlowEditorFormProps) => {
  const t = useTranslations();
  const { id: userId } = useAuthenticatedUser();
  const organizationId = props.organizationId;
  const workspacesQuery = useQuery(
    workspacesNavigationOptions({ organizationId, userId }),
  );
  const workspaces = toWorkspaceOptions(workspacesQuery);
  const {
    isEdit,
    canDelete,
    deleteOpen,
    setDeleteOpen,
    saving,
    handleDelete,
    canSave,
    reloadState,
    setReloadState,
    conflict,
    draft,
    baseline,
    reload,
    name,
    setName,
    description,
    setDescription,
    enabled,
    setEnabled,
    trigger,
    setTrigger,
    steps,
    updateStep,
    removeStep,
    moveStep,
    addStep,
    handleSave,
  } = useFlowEditorDraft(props);
  const resolveWorkflowSaveDisabledReason = () => {
    if (saving) {
      return t("common.saving");
    }
    if (reloadState === "loading") {
      return t("common.loading");
    }
    if (!canSave) {
      return t("errors.api.forbidden");
    }
    return t("flows.reloadToSave");
  };

  return (
    <fieldset
      disabled={saving}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="flex items-center justify-between gap-2">
          <Button
            onClick={props.onBack}
            size="sm"
            type="button"
            variant="ghost"
            {...guideAnchor(GUIDE_ANCHORS.workflowsBack)}
          >
            <DirectionalIcon icon={ArrowLeftIcon} />
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
                      disabledReason={t("common.saving")}
                      onClick={() => {
                        detached(handleDelete(), "flow-editor.delete");
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
              disabled={
                !canSave ||
                saving ||
                reloadState === "loading" ||
                conflict === "version"
              }
              disabledReason={resolveWorkflowSaveDisabledReason()}
              loading={saving}
              onClick={() => {
                detached(handleSave(), "flow-editor.save");
              }}
              type="button"
            >
              {t("common.save")}
            </Button>
          </div>
        </div>

        {conflict === "version" && (
          <div role="alert" className="space-y-2 text-sm">
            <p>{t("errors.apiCodes.versionConflict")}</p>
            <Button
              disabled={reloadState === "loading"}
              disabledReason={t("common.loading")}
              loading={reloadState === "loading"}
              variant="outline"
              onClick={() => {
                if (draft !== baseline) {
                  setReloadState("confirm");
                } else {
                  detached(reload(), "flow-editor.reload");
                }
              }}
            >
              {t("common.reload")}
            </Button>
          </div>
        )}
        <AlertDialog
          open={reloadState === "confirm"}
          onOpenChange={(open) => {
            if (!open) {
              setReloadState("idle");
            }
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("common.unsavedChanges")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("common.reloadDiscardChanges")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>
                {t("common.cancel")}
              </AlertDialogClose>
              <Button
                onClick={() => {
                  detached(reload(), "flow-editor.reload");
                }}
              >
                {t("common.reload")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>

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
          <Switch
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
    </fieldset>
  );
};

const useFlowEditorDraft = ({
  organizationId,
  flowId,
  initialSnapshot,
  onSaved,
}: FlowEditorFormProps) => {
  const idempotentSubmit = useIdempotentSubmit();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const isEdit = flowId !== null;
  const canSave = usePermissions(
    isEdit ? { flow: ["update"] } : { flow: ["create"] },
  );
  const canDelete = usePermissions({ flow: ["delete"] });

  const [editor, setEditor] = useState<{
    draft: FlowEditorDraft;
    baseline: FlowEditorDraft;
    conflict: "none" | "version";
  }>(() => {
    const draft = createFlowEditorDraft(initialSnapshot);
    return { draft, baseline: draft, conflict: "none" };
  });
  const { draft, baseline, conflict } = editor;
  const setDraft = (value: SetStateAction<FlowEditorDraft>) =>
    setEditor((current) => ({
      ...current,
      draft: typeof value === "function" ? value(current.draft) : value,
    }));
  const setConflict = (value: "none" | "version") =>
    setEditor((current) => ({ ...current, conflict: value }));
  const { name, description, enabled, trigger, steps } = draft;
  const setName = (value: string) =>
    setDraft((current) => ({ ...current, name: value }));
  const setDescription = (value: string) =>
    setDraft((current) => ({ ...current, description: value }));
  const setEnabled = (value: boolean) =>
    setDraft((current) => ({ ...current, enabled: value }));
  const setTrigger = (value: TriggerDraft) =>
    setDraft((current) => ({ ...current, trigger: value }));
  const setSteps = (value: SetStateAction<EditableStep[]>) =>
    setDraft((current) => ({
      ...current,
      steps: typeof value === "function" ? value(current.steps) : value,
    }));
  const [reloadState, setReloadState] = useState<
    "idle" | "confirm" | "loading"
  >("idle");
  const lifetime = useRef<AbortController | null>(null);
  useMountEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (lifetime.current === controller) {
        lifetime.current = null;
      }
    };
  });
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { id: userId } = useAuthenticatedUser();

  const updateStep = (index: number, next: FlowStep) => {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...next, _id: step._id } : step)),
    );
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: "up" | "down") => {
    setSteps((previous) =>
      reorderFlowStep({
        steps: previous,
        index,
        target: direction === "up" ? index - 1 : index + 1,
      }),
    );
  };

  const addStep = (kind: FlowStepKind) => {
    setSteps((prev) =>
      prev.length >= MAX_FLOW_STEPS
        ? prev
        : [...prev, withStepId(newStep(kind))],
    );
  };

  const reload = async () => {
    if (flowId === null || saving || reloadState === "loading") {
      return;
    }
    const request = lifetime.current;
    const owner = captureSessionQueryOwner(queryClient);
    if (
      !owner ||
      owner.userId !== userId ||
      owner.organizationId !== organizationId ||
      !request
    ) {
      return;
    }
    const requestedDraft = draft;
    setReloadState("loading");
    const result = await Result.tryPromise(async () =>
      unwrapApiResponse(
        await api
          .flows({ flowId: toSafeId<"flowDefinition">(flowId) })
          .get({ fetch: { signal: request.signal, cache: "no-store" } }),
      ),
    );
    if (
      lifetime.current !== request ||
      !isObservedSessionQueryOwner(queryClient, owner)
    ) {
      return;
    }
    setReloadState("idle");
    if (!isCurrentSessionQueryOwner(queryClient, owner)) {
      return;
    }
    if (result.isErr()) {
      notifyUserError(result.error.cause, t("flows.loadFailed"));
      return;
    }
    const next = createFlowEditorDraft(result.value);
    setEditor((current) =>
      current.draft === requestedDraft
        ? { draft: next, baseline: next, conflict: "none" }
        : current,
    );
  };

  const handleSave = async () => {
    if (conflict === "version" || saving || reloadState === "loading") {
      return;
    }
    const request = lifetime.current;
    const owner = captureSessionQueryOwner(queryClient);
    if (
      !owner ||
      owner.userId !== userId ||
      owner.organizationId !== organizationId ||
      !request
    ) {
      return;
    }
    const problem = flowDraftProblem(draft);
    if (problem !== null) {
      notifyUserProblem(t(problem));
      return;
    }

    const body = flowDraftBody(draft);

    setSaving(true);
    const outcome = await Result.tryPromise(async () =>
      unwrapApiResponse(
        flowId === null
          ? await idempotentSubmit.run({
              operation: "api.flows",
              body,
              send: async (input) => api.flows.post(input),
            })
          : await api
              .flows({ flowId: toSafeId<"flowDefinition">(flowId) })
              .put({
                ...body,
                expectedUpdatedAt:
                  draft.expectedUpdatedAt ??
                  panic("An existing workflow requires its loaded version"),
              } satisfies FlowDefinitionUpdateBody),
      ),
    );
    if (outcome.isOk()) {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.flows.all(organizationId),
        }),
        "flow-editor.invalidate",
      );
    }
    if (
      lifetime.current !== request ||
      !isObservedSessionQueryOwner(queryClient, owner)
    ) {
      return;
    }
    setSaving(false);
    if (!isCurrentSessionQueryOwner(queryClient, owner)) {
      return;
    }
    if (outcome.isErr()) {
      const error = outcome.error.cause;
      if (
        APIError.is(error) &&
        error.code === API_VERSION_CONFLICT_ERROR_CODE
      ) {
        setConflict("version");
      }
      notifyUserError(error, t("flows.saveFailed"), {
        description: userErrorFromThrown(
          outcome.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: isEdit ? t("flows.updated") : t("flows.created"),
    });
    onSaved();
  };

  const handleDelete = async () => {
    if (flowId === null) {
      return;
    }
    const request = lifetime.current;
    const owner = captureSessionQueryOwner(queryClient);
    if (
      !request ||
      !owner ||
      owner.userId !== userId ||
      owner.organizationId !== organizationId
    ) {
      return;
    }
    setSaving(true);
    const outcome = await Result.tryPromise(async () =>
      unwrapApiResponse(
        await api
          .flows({ flowId: toSafeId<"flowDefinition">(flowId) })
          .delete(),
      ),
    );
    if (outcome.isOk()) {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.flows.all(organizationId),
        }),
        "flow-editor.invalidate",
      );
    }
    if (
      lifetime.current !== request ||
      !isObservedSessionQueryOwner(queryClient, owner)
    ) {
      return;
    }
    setSaving(false);
    if (!isCurrentSessionQueryOwner(queryClient, owner)) {
      return;
    }
    if (outcome.isErr()) {
      notifyUserError(outcome.error.cause, t("flows.deleteFailed"), {
        description: userErrorFromThrown(
          outcome.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({ type: "success", title: t("flows.deleted") });
    setDeleteOpen(false);
    onSaved();
  };

  return {
    isEdit,
    canDelete,
    deleteOpen,
    setDeleteOpen,
    saving,
    handleDelete,
    canSave,
    reloadState,
    setReloadState,
    conflict,
    draft,
    baseline,
    reload,
    name,
    setName,
    description,
    setDescription,
    enabled,
    setEnabled,
    trigger,
    setTrigger,
    steps,
    updateStep,
    removeStep,
    moveStep,
    addStep,
    handleSave,
  };
};

const createFlowEditorDraft = (snapshot: FlowEditorSnapshot) =>
  ({
    name: snapshot.name,
    description: snapshot.description ?? "",
    enabled: snapshot.enabled,
    trigger: deriveTriggerDraft(snapshot.trigger),
    steps: snapshot.steps.map(withStepId),
    expectedUpdatedAt: snapshot.updatedAt,
  }) satisfies FlowEditorDraft;

const reorderFlowStep = ({
  steps,
  index,
  target,
}: {
  steps: EditableStep[];
  index: number;
  target: number;
}) => {
  if (target < 0 || target >= steps.length) {
    return steps;
  }
  const next = [...steps];
  const current = next[index];
  const swap = next[target];
  if (!current || !swap) {
    return steps;
  }
  next[index] = swap;
  next[target] = current;
  return next;
};

const flowDraftBody = (draft: FlowEditorDraft) => {
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    description: description === "" ? null : description,
    steps: draft.steps.map(({ _id, ...step }) => step),
    trigger: buildTrigger(draft.trigger),
    enabled: draft.enabled,
  } satisfies FlowDefinitionBody;
};

const flowDraftProblem = (draft: FlowEditorDraft) => {
  if (draft.name.trim() === "") {
    return "flows.nameRequired" satisfies TranslationKey;
  }
  if (draft.steps.length === 0) {
    return "flows.steps.required" satisfies TranslationKey;
  }
  for (const step of draft.steps) {
    if (step.name.trim() === "") {
      return "flows.steps.nameRequired" satisfies TranslationKey;
    }
    switch (step.kind) {
      case "ai":
        if (step.prompt.trim() === "") {
          return "flows.steps.promptRequired" satisfies TranslationKey;
        }
        break;
      case "review-gate":
        break;
      case "create-document":
        if (step.documentTitle.trim() === "") {
          return "flows.steps.documentTitleRequired" satisfies TranslationKey;
        }
        break;
      default:
        step satisfies never;
        return panic("Unhandled workflow step kind");
    }
  }
  if (
    draft.trigger.type === "schedule" &&
    draft.trigger.schedule.workspaceId === ""
  ) {
    return "flows.schedule.workspaceRequired" satisfies TranslationKey;
  }
  return null;
};

// ── Trigger section ───────────────────────────────────

type WorkspaceOption = { color: string | null; id: string; name: string };

type WorkspaceOptions =
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; items: WorkspaceOption[] };

type WorkspacesQueryState = {
  data: { workspaces: WorkspaceOption[] } | undefined;
  isError: boolean;
  refetch: () => Promise<unknown>;
};

const toWorkspaceOptions = ({
  data,
  isError,
  refetch,
}: WorkspacesQueryState): WorkspaceOptions => {
  if (data !== undefined) {
    return { status: "ready", items: data.workspaces };
  }
  if (isError) {
    return {
      status: "failed",
      retry: () => detached(refetch(), "flow-editor.retry-workspaces"),
    };
  }
  return { status: "loading" };
};

/** What a matter picker shows while it has no matter list to offer. */
const WorkspaceOptionsNotice = ({
  workspaces,
}: {
  workspaces: WorkspaceOptions;
}) => {
  const t = useTranslations();
  switch (workspaces.status) {
    case "ready":
      return null;
    case "loading":
      return <Skeleton className="m-2 h-4 w-2/3" />;
    case "failed":
      return (
        <div className="flex items-center gap-2 p-2 text-xs">
          <span className="text-muted-foreground">
            {t("common.loadFailed")}
          </span>
          <Button onClick={workspaces.retry} size="sm" variant="ghost">
            {t("common.retry")}
          </Button>
        </div>
      );
    default:
      workspaces satisfies never;
      return panic(
        `Unhandled workspace options: ${JSON.stringify(workspaces)}`,
      );
  }
};

const TriggerSection = ({
  trigger,
  workspaces,
  onChange,
}: {
  trigger: TriggerDraft;
  workspaces: WorkspaceOptions;
  onChange: (next: TriggerDraft) => void;
}) => {
  const t = useTranslations();

  return (
    <div className="space-y-3" {...guideAnchor(GUIDE_ANCHORS.workflowsTrigger)}>
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

// A fixed reference week (2023-01-01 is a Sunday → index 0) used only to
// render localized weekday names; day index maps 0=Sun … 6=Sat.
const weekdayLabel = (dayIndex: number): string =>
  new Intl.DateTimeFormat(getFormattingLocale(), WEEKDAY_NAME_FORMAT).format(
    Temporal.PlainDate.from("2023-01-01")
      .add({ days: dayIndex })
      .toZonedDateTime({
        plainTime: Temporal.PlainTime.from("00:00"),
        timeZone: "UTC",
      })
      .toInstant().epochMilliseconds,
  );

const ScheduleConfig = ({
  schedule,
  workspaces,
  onChange,
}: {
  schedule: TriggerDraft["schedule"];
  workspaces: WorkspaceOptions;
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
            <SelectValue placeholder={t("common.selectAMatter")} />
          </SelectTrigger>
          <SelectPopup>
            <WorkspaceOptionsNotice workspaces={workspaces} />
            {workspaces.status === "ready" &&
              workspaces.items.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  <MatterOptionLabel matter={workspace} />
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
  workspaces: WorkspaceOptions;
  onChange: (next: TriggerDraft["fileUpload"]) => void;
}) => {
  const t = useTranslations();

  const toggleWorkspace = (id: string, checked: boolean) => {
    if (fileUpload.workspaceScope.type !== "selected") {
      return;
    }
    const next = checked
      ? [...fileUpload.workspaceScope.workspaceIds, id]
      : fileUpload.workspaceScope.workspaceIds.filter(
          (existing) => existing !== id,
        );
    onChange({
      workspaceScope: { type: "selected", workspaceIds: next },
      extensionScope: fileUpload.extensionScope,
    });
  };

  const toggleAllWorkspaces = (checked: boolean) => {
    const workspaceScope = checked
      ? {
          type: "all" as const,
          previousWorkspaceIds:
            fileUpload.workspaceScope.type === "selected"
              ? fileUpload.workspaceScope.workspaceIds
              : fileUpload.workspaceScope.previousWorkspaceIds,
        }
      : {
          type: "selected" as const,
          workspaceIds:
            fileUpload.workspaceScope.type === "all"
              ? fileUpload.workspaceScope.previousWorkspaceIds
              : fileUpload.workspaceScope.workspaceIds,
        };
    onChange({ workspaceScope, extensionScope: fileUpload.extensionScope });
  };

  const isWorkspaceSelected = (workspaceId: string) =>
    fileUpload.workspaceScope.type === "selected" &&
    fileUpload.workspaceScope.workspaceIds.includes(workspaceId);

  const toggleAnyExtension = (checked: boolean) => {
    const extensionScope = checked
      ? {
          type: "any" as const,
          previousExtensions:
            fileUpload.extensionScope.type === "selected"
              ? fileUpload.extensionScope.extensions
              : fileUpload.extensionScope.previousExtensions,
        }
      : {
          type: "selected" as const,
          extensions:
            fileUpload.extensionScope.type === "any"
              ? fileUpload.extensionScope.previousExtensions
              : fileUpload.extensionScope.extensions,
        };
    onChange({ workspaceScope: fileUpload.workspaceScope, extensionScope });
  };

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-1.5">
        <Label>{t("common.matters")}</Label>
        <Label className="flex">
          <Checkbox
            checked={fileUpload.workspaceScope.type === "all"}
            onCheckedChange={toggleAllWorkspaces}
          />
          <span className="font-normal">
            {t("flows.fileUpload.allWorkspaces")}
          </span>
        </Label>
        {fileUpload.workspaceScope.type === "selected" && (
          <div className="mt-1 grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2">
            <WorkspaceOptionsNotice workspaces={workspaces} />
            {workspaces.status === "ready" &&
              workspaces.items.map((workspace) => (
                // Dense rows: the picker scrolls inside a short box.
                <Label className="flex" key={workspace.id}>
                  <Checkbox
                    checked={isWorkspaceSelected(workspace.id)}
                    onCheckedChange={(checked) =>
                      toggleWorkspace(workspace.id, checked)
                    }
                  />
                  <TruncatedText className="font-normal" dir="auto">
                    {workspace.name}
                  </TruncatedText>
                </Label>
              ))}
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label>{t("flows.fileUpload.extensions")}</Label>
        <Label className="flex">
          <Checkbox
            checked={fileUpload.extensionScope.type === "any"}
            onCheckedChange={toggleAnyExtension}
          />
          <span className="font-normal">
            {t("flows.fileUpload.anyExtension")}
          </span>
        </Label>
        {fileUpload.extensionScope.type === "selected" && (
          <FlowExtensionInput
            extensions={fileUpload.extensionScope.extensions}
            onChange={(extensions) =>
              onChange({
                workspaceScope: fileUpload.workspaceScope,
                extensionScope: { type: "selected", extensions },
              })
            }
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
    <div className="space-y-3" {...guideAnchor(GUIDE_ANCHORS.workflowsSteps)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("flows.steps.title")}</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("common.stepCount", { count: steps.length })}
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
              disabledReason={t("flows.validation.tooManySteps", {
                max: MAX_FLOW_STEPS,
              })}
              key={kind}
              onClick={() => onAdd(kind)}
              size="sm"
              title={t(FLOW_STEP_KIND_HELP_KEYS[kind])}
              type="button"
              variant="outline"
              {...guideAnchor(
                GUIDE_ANCHORS.workflowsReviewGate,
                kind === "review-gate",
              )}
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
            disabledReason={t("common.alreadyFirst")}
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
            disabledReason={t("common.alreadyLast")}
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
          <Label className="flex">
            <Checkbox
              checked={step.includeDocuments}
              onCheckedChange={(checked) =>
                onUpdate({ ...step, includeDocuments: checked })
              }
            />
            <span className="font-normal">
              {t("flows.steps.includeDocuments")}
            </span>
          </Label>
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
            {t("common.documentTitle")}
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
