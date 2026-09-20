import { useState } from "react";

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { Loader } from "@stll/ui/loader";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { filesKeys } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";
import {
  type EntityVersion,
  entityVersionsKeys,
} from "@/lib/workspaces/queries/entity-versions";

import {
  COMPARE_CHANGE_KIND_LABEL_KEYS,
  COMPARE_UNSUPPORTED_REASON_LABEL_KEYS,
  countCompareChanges,
  resolveCompareVersionSelection,
} from "./compare-facet.logic";
import type { CompareVersionSelection } from "./compare-facet.logic";

type DocumentsResource = ReturnType<typeof api.documents>;
type DocumentResource = ReturnType<DocumentsResource["document"]>;
type CompareResponse = Awaited<ReturnType<DocumentResource["compare"]["post"]>>;

type CompareData = Exclude<
  NonNullable<Extract<CompareResponse, { data: unknown }>["data"]>,
  Response
>;

type DocumentCompareResult = CompareData["results"][number];
type CompareCreatedResult = Extract<
  DocumentCompareResult,
  { status: "created" }
>;
type ComparePreviewedResult = Extract<
  DocumentCompareResult,
  { status: "previewed" }
>;
type CompareFailedResult = Extract<DocumentCompareResult, { status: "failed" }>;

type CompareOutcome =
  | {
      type: "created";
      result: CompareCreatedResult;
      redlineStatus: "opened" | "unavailable";
    }
  | { type: "previewed"; result: ComparePreviewedResult }
  | { type: "failed"; result: CompareFailedResult };

type CompareRequestState =
  | { status: "idle" }
  | { status: "previewing" }
  | { status: "saving" }
  | { status: "error"; message: string };

type TrackedChangeDisposition = "keep" | "accept" | "reject";

type RequestComparisonOptions = {
  baseVersionId: string;
  output: "preview" | "version";
  targetVersionId: string;
};

type CompareVersionsPanelProps = {
  currentFieldId: string;
  entityId: string;
  filePropertyId: string;
  versions: readonly EntityVersion[];
  workspaceId: string;
};

const compareOutcomeOptions = ({
  filePropertyId,
  entityId,
  workspaceId,
}: Pick<
  CompareVersionsPanelProps,
  "entityId" | "workspaceId" | "filePropertyId"
>) =>
  queryOptions({
    queryKey: [
      "document-compare-outcome",
      workspaceId,
      entityId,
      filePropertyId,
    ] as const,
    queryFn: async () => await Promise.resolve<CompareOutcome | null>(null),
  });

export const CompareVersionsPanel = ({
  currentFieldId,
  entityId,
  filePropertyId,
  versions,
  workspaceId,
}: CompareVersionsPanelProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const queryClient = useQueryClient();
  const openFileForEntity = useInspectorTabsStore((s) => s.openFileForEntity);
  const outcomeOptions = compareOutcomeOptions({
    entityId,
    workspaceId,
    filePropertyId,
  });
  const outcomeQuery = useQuery({
    ...outcomeOptions,
    enabled: false,
  });
  const [requestedSelection, setRequestedSelection] =
    useState<CompareVersionSelection | null>(null);
  const [baseTrackedChanges, setBaseTrackedChanges] =
    useState<TrackedChangeDisposition>("accept");
  const [targetTrackedChanges, setTargetTrackedChanges] =
    useState<TrackedChangeDisposition>("accept");
  const [requestState, setRequestState] = useState<CompareRequestState>({
    status: "idle",
  });
  const setOutcome = (outcome: CompareOutcome) => {
    queryClient.setQueryData(outcomeOptions.queryKey, outcome);
  };

  const comparableVersions = versions.filter(
    ({ file }) => file?.mimeType === DOCX_MIME,
  );
  const selection = resolveCompareVersionSelection({
    currentFieldId,
    requested: requestedSelection,
    versions: comparableVersions,
  });
  const outcome = outcomeQuery.data;
  const isRequestPending =
    requestState.status === "previewing" || requestState.status === "saving";

  const clearOutcome = () => {
    queryClient.removeQueries({
      queryKey: outcomeOptions.queryKey,
      exact: true,
    });
    setRequestState({ status: "idle" });
  };

  const updateSelection = (next: CompareVersionSelection) => {
    setRequestedSelection(next);
    clearOutcome();
  };

  const openRedline = async (result: CompareCreatedResult) => {
    await queryClient.invalidateQueries({
      queryKey: filesKeys.all(),
    });
    await queryClient.invalidateQueries({
      queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
      refetchType: "none",
    });
    const { file } = result;

    setOutcome({
      type: "created",
      result,
      redlineStatus: "opened",
    });
    openFileForEntity({
      id: file.fieldId,
      entityId,
      label: file.fileName,
      fileName: file.fileName,
      mimeType: file.mimeType,
      pdfFileId: null,
      propertyId: file.propertyId,
      workspaceId,
      facet: "preview",
    });

    const onDocumentRoute = new RegExp(
      `^/workspaces/${workspaceId}/[^/]+/document(?:/|$|\\?)`,
      "u",
    ).test(pathname);
    if (!onDocumentRoute) {
      return;
    }
    const currentViewId = pathname.split("/")[3] ?? "all";
    await navigate({
      to: "/workspaces/$workspaceId/$viewId/document",
      params: { workspaceId, viewId: currentViewId },
      replace: true,
      search: (previous) => ({
        ...previous,
        editing: undefined,
        entity: entityId,
        field: file.fieldId,
        pdfPage: undefined,
      }),
    });
  };

  const requestComparison = async ({
    baseVersionId,
    output,
    targetVersionId,
  }: RequestComparisonOptions) =>
    await Result.tryPromise(async () =>
      unwrapEden(
        await api
          .documents({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .document({ documentId: toSafeId<"entity">(entityId) })
          .compare.post({
            filePropertyId: toSafeId<"property">(filePropertyId),
            selection: {
              type: "versions",
              baseVersionId: toSafeId<"entityVersion">(baseVersionId),
              targetVersionIds: [toSafeId<"entityVersion">(targetVersionId)],
            },
            mode: "strict",
            granularity: "word",
            baseTrackedChanges,
            targetTrackedChanges,
            output: { type: output },
          }),
      ),
    );

  const surfaceRequestError = (error: unknown) => {
    getAnalytics().captureError(error);
    setRequestState({
      status: "error",
      message: userErrorFromThrown(error, t("fileDetail.compareRequestFailed")),
    });
  };

  const previewComparison = async () => {
    if (
      selection === null ||
      requestState.status === "previewing" ||
      requestState.status === "saving"
    ) {
      return;
    }
    clearOutcome();
    setRequestState({ status: "previewing" });
    const requested = await requestComparison({
      baseVersionId: selection.baseVersionId,
      output: "preview",
      targetVersionId: selection.targetVersionId,
    });
    if (Result.isError(requested)) {
      surfaceRequestError(requested.error);
      return;
    }

    const result = requested.value.results.at(0);
    if (result === undefined) {
      setRequestState({
        status: "error",
        message: t("fileDetail.compareRequestFailed"),
      });
      return;
    }
    switch (result.status) {
      case "failed":
        setRequestState({ status: "idle" });
        setOutcome({ type: "failed", result });
        return;
      case "previewed":
        setRequestState({ status: "idle" });
        setOutcome({ type: "previewed", result });
        return;
      // The inspector asks for a preview here; a saved version or a temporary
      // link back means the request was not the one this panel made.
      case "created":
      case "downloadable":
        setRequestState({
          status: "error",
          message: t("fileDetail.compareRequestFailed"),
        });
        return;
      default:
        result satisfies never;
        panic("Unhandled document comparison result");
    }
  };

  const saveComparison = async (preview: ComparePreviewedResult) => {
    if (
      requestState.status === "previewing" ||
      requestState.status === "saving"
    ) {
      return;
    }
    setRequestState({ status: "saving" });
    const requested = await requestComparison({
      baseVersionId: preview.baseVersionId,
      output: "version",
      targetVersionId: preview.targetVersionId,
    });
    if (Result.isError(requested)) {
      surfaceRequestError(requested.error);
      return;
    }

    const result = requested.value.results.at(0);
    if (result === undefined) {
      setRequestState({
        status: "error",
        message: t("fileDetail.compareRequestFailed"),
      });
      return;
    }
    if (result.status === "failed") {
      setRequestState({ status: "idle" });
      setOutcome({ type: "failed", result });
      return;
    }
    // Saving asks for output version, so anything but a created version means
    // the response does not answer the request this panel made.
    if (result.status !== "created") {
      setRequestState({
        status: "error",
        message: t("fileDetail.compareRequestFailed"),
      });
      return;
    }

    const opened = await Result.tryPromise(
      async () => await openRedline(result),
    );
    if (Result.isError(opened)) {
      getAnalytics().captureError(opened.error);
      setOutcome({
        type: "created",
        result,
        redlineStatus: "unavailable",
      });
    }
    setRequestState({ status: "idle" });
  };

  if (outcome?.type === "created" || outcome?.type === "previewed") {
    return (
      <CompareResultView
        errorMessage={
          requestState.status === "error" ? requestState.message : null
        }
        isSaving={requestState.status === "saving"}
        outcome={outcome}
        onCompareAnother={clearOutcome}
        onSave={
          outcome.type === "previewed"
            ? () => {
                detached(
                  saveComparison(outcome.result),
                  "compare-versions-panel.save",
                );
              }
            : undefined
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="space-y-1 pb-4">
        <h2 className="text-sm font-semibold text-balance">
          {t("fileDetail.compareVersionsTitle")}
        </h2>
        <p className="text-muted-foreground text-xs text-pretty">
          {t("fileDetail.compareVersionsDescription")}
        </p>
      </div>

      {selection === null ? (
        <p className="text-muted-foreground text-sm">
          {t("fileDetail.compareNeedsTwoVersions")}
        </p>
      ) : (
        <div className="space-y-3">
          <VersionSelect
            disabledId={selection.targetVersionId}
            disabled={isRequestPending}
            id="compare-base-version"
            label={t("fileDetail.base")}
            selectedId={selection.baseVersionId}
            versions={comparableVersions}
            onChange={(baseVersionId) =>
              updateSelection({ ...selection, baseVersionId })
            }
          />
          <VersionSelect
            disabledId={selection.baseVersionId}
            disabled={isRequestPending}
            id="compare-target-version"
            label={t("fileDetail.compareTo")}
            selectedId={selection.targetVersionId}
            versions={comparableVersions}
            onChange={(targetVersionId) =>
              updateSelection({ ...selection, targetVersionId })
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <DispositionSelect
              disabled={isRequestPending}
              id="compare-base-tracked-changes"
              label={`${t("fileDetail.base")} · ${t("docxReview.applyTracked")}`}
              value={baseTrackedChanges}
              onChange={(value) => {
                setBaseTrackedChanges(value);
                clearOutcome();
              }}
            />
            <DispositionSelect
              disabled={isRequestPending}
              id="compare-target-tracked-changes"
              label={`${t("fileDetail.compareTo")} · ${t("docxReview.applyTracked")}`}
              value={targetTrackedChanges}
              onChange={(value) => {
                setTargetTrackedChanges(value);
                clearOutcome();
              }}
            />
          </div>
          <Button
            className="w-full"
            disabled={isRequestPending}
            onClick={() => {
              detached(previewComparison(), "compare-versions-panel.preview");
            }}
          >
            {requestState.status === "previewing" && (
              <Loader label={t("fileDetail.generatingRedline")} size="sm" />
            )}
            {requestState.status === "previewing"
              ? t("fileDetail.generatingRedline")
              : t("fileDetail.compare")}
          </Button>
        </div>
      )}

      {requestState.status === "error" && (
        <div className="bg-destructive/8 mt-3 rounded-md p-3">
          <ReviewStatusBadge tone="destructive" variant="solid">
            {t("fileDetail.compareFailed")}
          </ReviewStatusBadge>
          <p className="text-destructive mt-2 text-xs text-pretty">
            {requestState.message}
          </p>
        </div>
      )}
      {outcome?.type === "failed" && (
        <div className="bg-destructive/8 mt-3 rounded-md p-3">
          <ReviewStatusBadge tone="destructive" variant="solid">
            {t("fileDetail.compareFailed")}
          </ReviewStatusBadge>
          <p className="text-destructive mt-2 text-xs text-pretty">
            {outcome.result.error.message}
          </p>
          <p className="text-muted-foreground mt-1 text-xs text-pretty">
            {outcome.result.error.hint}
          </p>
          <bdi className="text-muted-foreground text-3xs mt-2 block font-mono">
            {outcome.result.error.code}
          </bdi>
        </div>
      )}
    </div>
  );
};

type VersionSelectProps = {
  disabled: boolean;
  disabledId: string;
  id: string;
  label: string;
  onChange: (versionId: string) => void;
  selectedId: string;
  versions: readonly {
    id: string;
    label: string | null;
    versionNumber: number;
  }[];
};

const VersionSelect = ({
  disabled,
  disabledId,
  id,
  label,
  onChange,
  selectedId,
  versions,
}: VersionSelectProps) => (
  <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Select
      disabled={disabled}
      onValueChange={(value) => {
        if (typeof value === "string") {
          onChange(value);
        }
      }}
      value={selectedId}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {versions.map((version) => {
          const versionOptionLabel = versionLabel(version);
          return (
            <SelectItem
              disabled={version.id === disabledId}
              key={version.id}
              label={versionOptionLabel}
              value={version.id}
            >
              {versionOptionLabel}
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  </Field>
);

type DispositionSelectProps = {
  disabled: boolean;
  id: string;
  label: string;
  onChange: (value: TrackedChangeDisposition) => void;
  value: TrackedChangeDisposition;
};

const TRACKED_CHANGE_DISPOSITIONS = ["keep", "accept", "reject"] as const;

const DispositionSelect = ({
  disabled,
  id,
  label,
  onChange,
  value,
}: DispositionSelectProps) => {
  const t = useTranslations();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        disabled={disabled}
        onValueChange={(next) => {
          if (
            next !== null &&
            TRACKED_CHANGE_DISPOSITIONS.some((candidate) => candidate === next)
          ) {
            onChange(next);
          }
        }}
        value={value}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {TRACKED_CHANGE_DISPOSITIONS.map((disposition) => {
            let optionLabel = t("docxReview.rejectAll");
            if (disposition === "keep") {
              optionLabel = t("bilingualTranslate.dispositions.keep");
            } else if (disposition === "accept") {
              optionLabel = t("docxReview.acceptAll");
            }
            return (
              <SelectItem key={disposition} value={disposition}>
                {optionLabel}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </Field>
  );
};

const versionLabel = (version: {
  label: string | null;
  versionNumber: number;
}) => {
  const number = `v${String(version.versionNumber)}`;
  return version.label === null ? number : `${number} · ${version.label}`;
};

const CompareResultView = ({
  errorMessage,
  isSaving,
  outcome,
  onCompareAnother,
  onSave,
}: {
  errorMessage: string | null;
  isSaving: boolean;
  outcome:
    | Extract<CompareOutcome, { type: "created" }>
    | Extract<CompareOutcome, { type: "previewed" }>;
  onCompareAnother: () => void;
  onSave?: (() => void) | undefined;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { result } = outcome;
  const changeCounts = countCompareChanges(result.changes);
  let outcomeDescription = t("fileDetail.compareRedlineOpened");
  if (outcome.type === "previewed") {
    outcomeDescription = t("fileDetail.comparePreviewDescription");
  } else if (outcome.redlineStatus === "unavailable") {
    outcomeDescription = t("fileDetail.compareRedlineUnavailable");
  }
  const unsupportedCounts = new Map<
    CompareCreatedResult["unsupported"][number]["reason"],
    number
  >();
  for (const { reason } of result.unsupported) {
    unsupportedCounts.set(reason, (unsupportedCounts.get(reason) ?? 0) + 1);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReviewStatusBadge
          tone={
            result.verification.status === "verified" ? "success" : "warning"
          }
          variant="solid"
        >
          {result.verification.status === "verified"
            ? t("fileDetail.compareVerified")
            : t("fileDetail.compareUnverified")}
        </ReviewStatusBadge>
        {result.unsupported.length > 0 && (
          <ReviewStatusBadge tone="warning" variant="solid">
            {t("fileDetail.compareUnsupported", {
              count: result.unsupported.length,
            })}
          </ReviewStatusBadge>
        )}
      </div>

      <h2 className="mt-4 text-sm font-semibold text-balance">
        {outcome.type === "previewed"
          ? t("fileDetail.comparePreviewReady")
          : t("fileDetail.compareCreated")}
      </h2>
      <p className="text-muted-foreground mt-1 text-xs text-pretty">
        {outcomeDescription}
      </p>

      {result.verification.status === "unverified" && (
        <p className="bg-warning/10 text-warning-foreground mt-3 rounded-md p-3 text-xs text-pretty">
          {t("fileDetail.compareVerificationFailures", {
            count: result.verification.failures.length,
          })}
        </p>
      )}

      {result.unsupported.length > 0 && (
        <div className="bg-warning/10 mt-3 rounded-md p-3">
          <p className="text-warning-foreground text-xs font-medium">
            {t("fileDetail.compareUnsupportedDescription")}
          </p>
          <ul className="text-muted-foreground mt-2 space-y-1 text-xs">
            {[...unsupportedCounts].map(([reason, count]) => (
              <li
                className="flex items-center justify-between gap-2"
                key={reason}
              >
                <span>{t(COMPARE_UNSUPPORTED_REASON_LABEL_KEYS[reason])}</span>
                <span className="tabular-nums">{format.number(count)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium">
            {t("fileDetail.compareChangeSummary")}
          </h3>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("fileDetail.changesDetected", { count: result.changes.length })}
          </span>
        </div>
        {changeCounts.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {t("fileDetail.compareNoChanges")}
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {changeCounts.map(({ count, kind }) => (
              <ReviewStatusBadge key={kind} tone="neutral">
                {t(COMPARE_CHANGE_KIND_LABEL_KEYS[kind])}
                <span className="tabular-nums">{format.number(count)}</span>
              </ReviewStatusBadge>
            ))}
          </div>
        )}
      </div>

      {errorMessage !== null && (
        <p className="bg-destructive/8 text-destructive mt-3 rounded-md p-3 text-xs text-pretty">
          {errorMessage}
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2">
        {onSave !== undefined && (
          <Button disabled={isSaving} onClick={onSave}>
            {isSaving && (
              <Loader label={t("fileDetail.savingComparison")} size="sm" />
            )}
            {isSaving
              ? t("fileDetail.savingComparison")
              : t("fileDetail.saveComparison")}
          </Button>
        )}
        <Button
          disabled={isSaving}
          onClick={onCompareAnother}
          variant="outline"
        >
          {t("fileDetail.compareAnother")}
        </Button>
      </div>
    </div>
  );
};
