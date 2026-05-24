import { useEffect, useMemo, useRef, useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  Rows3Icon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import {
  buildFileNameSuggestions,
  normalizeFolderPath,
  normalizeSuggestedFileName,
} from "@/routes/_protected.workspaces/$workspaceId/-components/import-organizer.logic";
import type { FileNameSuggestion } from "@/routes/_protected.workspaces/$workspaceId/-components/import-organizer.logic";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

export type ExistingImportFolder = {
  entityId: string;
  name: string;
  path: string;
  parentId: string | null;
};

export type ExistingOrganizerFile = {
  entityId: string;
  originalName: string;
  parentId: string | null;
  mimeType: string | null;
};

type ExistingFileOrganizerDialogProps = {
  workspaceId: string;
  files: ExistingOrganizerFile[];
  existingFolders: ExistingImportFolder[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ExistingOrganizerRow = FileNameSuggestion & {
  entityId: string;
  parentId: string | null;
  mimeType: string | null;
};

type SuggestionStatus = "idle" | "generating" | "ready" | "failed";

type OrganizerCache = {
  key: string;
  rows: ExistingOrganizerRow[];
  deleteFolders: FolderDeletionSuggestion[];
};

type FolderPreviewNode = {
  name: string;
  path: string;
  children: Map<string, FolderPreviewNode>;
  rows: ExistingOrganizerRow[];
};

type FolderDeletionSuggestion = {
  entityId: string;
  folderPath: string;
  reason: string;
  selected: boolean;
};

type RowChangeSummary = {
  movedCount: number;
  renamedCount: number;
  unchangedCount: number;
};

export const ExistingFileOrganizerDialog = ({
  workspaceId,
  files,
  existingFolders,
  open,
  onOpenChange,
}: ExistingFileOrganizerDialogProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const userInstructionsKey = `stella.organize-suggestions.user-instructions.${workspaceId}`;
  const [userInstructions, setUserInstructions] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(userInstructionsKey) ?? "";
  });
  const [showInstructions, setShowInstructions] = useState(false);
  const userInstructionsRef = useRef(userInstructions);
  const localeRef = useRef(locale);
  useEffect(() => {
    userInstructionsRef.current = userInstructions;
  }, [userInstructions]);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  const [rows, setRows] = useState<ExistingOrganizerRow[]>([]);
  const [suggestionStatus, setSuggestionStatus] =
    useState<SuggestionStatus>("idle");
  const [retryNonce, setRetryNonce] = useState(0);
  const [deleteFolders, setDeleteFolders] = useState<
    FolderDeletionSuggestion[]
  >([]);
  const [cachedSuggestions, setCachedSuggestions] =
    useState<OrganizerCache | null>(null);
  const [showDeleteSection, setShowDeleteSection] = useState(true);

  const isGeneratingSuggestions = suggestionStatus === "generating";
  const selectedDeleteFolders = deleteFolders.filter(
    (folder) => folder.selected,
  );
  const canApply =
    suggestionStatus === "ready" &&
    (rows.length > 0 || selectedDeleteFolders.length > 0);

  const folderByEntityId = useMemo(
    () => new Map(existingFolders.map((folder) => [folder.entityId, folder])),
    [existingFolders],
  );
  const fileByEntityId = useMemo(
    () => new Map(files.map((file) => [file.entityId, file])),
    [files],
  );
  const initialRows = useMemo(
    () =>
      buildFileNameSuggestions(
        files.map((file) => ({
          id: file.entityId,
          originalName: file.originalName,
        })),
      ).map((suggestion) => {
        const file = fileByEntityId.get(suggestion.id);
        const parentFolder = file?.parentId
          ? folderByEntityId.get(file.parentId)
          : undefined;
        return {
          detectedDate: suggestion.detectedDate,
          documentType: suggestion.documentType,
          entityId: suggestion.id,
          folderPath: parentFolder ? parentFolder.path : "",
          id: suggestion.id,
          mimeType: file?.mimeType ?? null,
          parentId: file?.parentId ?? null,
          originalName: suggestion.originalName,
          suggestedName: suggestion.originalName,
        };
      }),
    [files, fileByEntityId, folderByEntityId],
  );
  const requestKey = useMemo(
    () =>
      JSON.stringify({
        existingFolders: existingFolders.map((folder) => ({
          id: folder.entityId,
          name: folder.name,
          path: folder.path,
          parentId: folder.parentId,
        })),
        files: files.map((file) => ({
          id: file.entityId,
          name: file.originalName,
          parentId: file.parentId,
        })),
      }),
    [existingFolders, files],
  );

  useEffect(() => {
    if (!open || files.length === 0) {
      return undefined;
    }

    if (cachedSuggestions?.key === requestKey && retryNonce === 0) {
      setRows(cachedSuggestions.rows);
      setDeleteFolders(cachedSuggestions.deleteFolders);
      setSuggestionStatus("ready");
      return undefined;
    }

    setRows(initialRows);
    setDeleteFolders([]);
    let cancelled = false;
    const fetchSuggestions = async () => {
      setSuggestionStatus("generating");
      const trimmedInstructions = userInstructionsRef.current.trim();
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["organize-suggestions"].post({
          existingFolders: existingFolders.map((folder) => ({
            entityId: toSafeId<"entity">(folder.entityId),
            name: folder.name,
            path: folder.path,
          })),
          files: files.map((file) => ({
            entityId: toSafeId<"entity">(file.entityId),
            originalName: file.originalName,
          })),
          locale: localeRef.current,
          ...(trimmedInstructions.length > 0
            ? { userInstructions: trimmedInstructions }
            : {}),
        });

      if (response.error) {
        analytics.captureError(toAPIError(response.error));
        if (!cancelled) {
          setSuggestionStatus("failed");
        }
        return;
      }

      if (cancelled) {
        return;
      }

      const aiSuggestions = new Map(
        response.data.suggestions.map((suggestion) => [
          suggestion.entityId,
          suggestion,
        ]),
      );

      const nextRows = initialRows.map((row) => {
        const suggestion = aiSuggestions.get(row.entityId);
        if (!suggestion) {
          return row;
        }
        return {
          ...row,
          detectedDate: suggestion.detectedDate,
          documentType: suggestion.documentType,
          folderPath: suggestion.folderPath,
          suggestedName: suggestion.suggestedName,
        };
      });

      setRows(nextRows);
      const nextDeleteFolders = response.data.deleteFolders.map((folder) => ({
        entityId: folder.entityId,
        folderPath: folder.folderPath,
        reason: folder.reason,
        selected: true,
      }));
      setDeleteFolders(nextDeleteFolders);
      setCachedSuggestions({
        key: requestKey,
        rows: nextRows,
        deleteFolders: nextDeleteFolders,
      });
      setRetryNonce(0);
      setSuggestionStatus("ready");
    };

    fetchSuggestions().catch((error: unknown) => {
      analytics.captureError(error);
      if (!cancelled) {
        setSuggestionStatus("failed");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    analytics,
    cachedSuggestions,
    existingFolders,
    files,
    initialRows,
    open,
    requestKey,
    retryNonce,
    workspaceId,
  ]);

  const updateRow = (
    id: string,
    updates:
      | Pick<ExistingOrganizerRow, "folderPath">
      | Pick<ExistingOrganizerRow, "suggestedName">,
  ) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...updates } : row)),
    );
  };
  const updateFolderDeletion = (entityId: string, selected: boolean) => {
    setDeleteFolders((current) =>
      current.map((folder) =>
        folder.entityId === entityId ? { ...folder, selected } : folder,
      ),
    );
  };

  const moveFileToFolder = (rowId: string, targetFolderPath: string) => {
    const target = normalizeFolderPath(targetFolderPath);
    setRows((current) =>
      current.map((row) =>
        row.id === rowId ? { ...row, folderPath: target } : row,
      ),
    );
  };

  const moveFolder = (sourceFolderPath: string, targetFolderPath: string) => {
    const source = normalizeFolderPath(sourceFolderPath);
    const target = normalizeFolderPath(targetFolderPath);
    if (source.length === 0 || source === target) {
      return;
    }
    if (target === source || target.startsWith(`${source}/`)) {
      return;
    }
    const segments = source.split("/");
    const folderName = segments.at(-1);
    if (!folderName) {
      return;
    }
    const newPath =
      target.length === 0 ? folderName : `${target}/${folderName}`;
    if (newPath === source) {
      return;
    }
    setRows((current) =>
      current.map((row) => {
        const rowFolder = normalizeFolderPath(row.folderPath);
        if (rowFolder === source) {
          return { ...row, folderPath: newPath };
        }
        if (rowFolder.startsWith(`${source}/`)) {
          return {
            ...row,
            folderPath: `${newPath}${rowFolder.slice(source.length)}`,
          };
        }
        return row;
      }),
    );
  };

  const renameFolder = (folderPath: string, newName: string) => {
    const source = normalizeFolderPath(folderPath);
    if (source.length === 0) {
      return;
    }
    const sanitizedName = newName.replace(/\//gu, " ").trim();
    if (sanitizedName.length === 0) {
      return;
    }
    const segments = source.split("/");
    segments[segments.length - 1] = sanitizedName;
    const newPath = segments.join("/");
    if (newPath === source) {
      return;
    }
    setRows((current) =>
      current.map((row) => {
        const rowFolder = normalizeFolderPath(row.folderPath);
        if (rowFolder === source) {
          return { ...row, folderPath: newPath };
        }
        if (rowFolder.startsWith(`${source}/`)) {
          return {
            ...row,
            folderPath: `${newPath}${rowFolder.slice(source.length)}`,
          };
        }
        return row;
      }),
    );
  };

  const summary = useMemo<RowChangeSummary>(() => {
    // Buckets are mutually exclusive so the three counts always sum
    // to rows.length. A file that is both moved and renamed is
    // attributed to "moved" because the move is the more impactful
    // change for the user — the renamed-side label still reads "to
    // rename" in the UI, but it counts only files that change name
    // without moving.
    let moved = 0;
    let renamed = 0;
    let unchanged = 0;
    for (const row of rows) {
      const file = fileByEntityId.get(row.entityId);
      const currentParentPath = file?.parentId
        ? (folderByEntityId.get(file.parentId)?.path ?? "")
        : "";
      const targetPath = normalizeFolderPath(row.folderPath);
      const targetName = normalizeSuggestedFileName(
        row.suggestedName,
        row.originalName,
      );
      const willMove = currentParentPath !== targetPath;
      const willRename = targetName !== row.originalName;
      if (willMove) {
        moved++;
      } else if (willRename) {
        renamed++;
      } else {
        unchanged++;
      }
    }
    return {
      movedCount: moved,
      renamedCount: renamed,
      unchangedCount: unchanged,
    };
  }, [fileByEntityId, folderByEntityId, rows]);

  const handleApply = () => {
    const rowsSnapshot = rows;
    const deleteSnapshot = selectedDeleteFolders;
    const existingFoldersSnapshot = existingFolders;

    onOpenChange(false);

    const toastId = stellaToast.add({
      type: "loading",
      title: t("workspaces.importOrganizer.applying"),
      timeout: 0,
    });

    const run = async () => {
      const folderIds = await ensureFolders({
        workspaceId,
        rows: rowsSnapshot,
        existingFolders: existingFoldersSnapshot,
      });

      for (const row of rowsSnapshot) {
        const folderPath = normalizeFolderPath(row.folderPath);
        const targetParentId = folderIds.get(folderPath) ?? null;
        const targetName = normalizeSuggestedFileName(
          row.suggestedName,
          row.originalName,
        );

        if (row.parentId !== targetParentId) {
          const moveResponse = await api
            .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
            .move.patch({
              queryKey: entitiesKeys.all(workspaceId),
              entityId: toSafeId<"entity">(row.entityId),
              parentId:
                targetParentId === null
                  ? null
                  : toSafeId<"entity">(targetParentId),
            });

          if (moveResponse.error) {
            throw toAPIError(moveResponse.error);
          }
        }

        if (targetName !== row.originalName) {
          const renameResponse = await api
            .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
            .rename.patch({
              queryKey: entitiesKeys.all(workspaceId),
              entityId: toSafeId<"entity">(row.entityId),
              name: targetName,
            });

          if (renameResponse.error) {
            throw toAPIError(renameResponse.error);
          }
        }
      }

      const usedFolderPaths = [
        ...new Set(
          rowsSnapshot.flatMap((row) => {
            const folderPath = normalizeFolderPath(row.folderPath);
            return folderPath ? [folderPath] : [];
          }),
        ),
      ];
      const deletableFolderIds: string[] = [];
      for (const folder of deleteSnapshot) {
        const folderPath = normalizeFolderPath(folder.folderPath);
        const isStillUsed = usedFolderPaths.some(
          (path) => path === folderPath || path.startsWith(`${folderPath}/`),
        );
        if (!isStillUsed) {
          deletableFolderIds.push(folder.entityId);
        }
      }

      if (deletableFolderIds.length > 0) {
        const deleteResponse = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .delete({
            queryKey: entitiesKeys.all(workspaceId),
            entityIds: deletableFolderIds.map((entityId) =>
              toSafeId<"entity">(entityId),
            ),
          });

        if (deleteResponse.error) {
          throw toAPIError(deleteResponse.error);
        }
      }

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overview(workspaceId),
        }),
      ]);
    };

    run()
      .then(() => {
        stellaToast.update(toastId, {
          type: "success",
          title: t("workspaces.importOrganizer.organized"),
          timeout: undefined,
        });
        return;
      })
      .catch((error: unknown) => {
        analytics.captureError(error);
        stellaToast.update(toastId, {
          type: "error",
          title: t("workspaces.importOrganizer.failed"),
          timeout: undefined,
        });
      });
  };

  const interactionsDisabled = isGeneratingSuggestions;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("workspaces.importOrganizer.title")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.importOrganizer.description", {
              count: rows.length,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="pt-0">
          <SummaryBar
            isGenerating={isGeneratingSuggestions}
            summary={summary}
          />
          <UserInstructionsSection
            disabled={false}
            expanded={showInstructions}
            onChange={(value) => {
              setUserInstructions(value);
              if (typeof window !== "undefined") {
                window.localStorage.setItem(userInstructionsKey, value);
              }
            }}
            onRegenerate={() => {
              setCachedSuggestions(null);
              setRetryNonce((current) => current + 1);
            }}
            onToggle={() => setShowInstructions((current) => !current)}
            value={userInstructions}
          />
          {suggestionStatus === "failed" && (
            <FailureBanner
              disabled={false}
              onRetry={() => {
                setCachedSuggestions(null);
                setRetryNonce((current) => current + 1);
              }}
            />
          )}
          {isGeneratingSuggestions ? (
            <OrganizerSkeleton />
          ) : (
            <OrganizerTreePreview
              disabled={interactionsDisabled}
              onMoveFile={moveFileToFolder}
              onMoveFolder={moveFolder}
              onRenameFolder={renameFolder}
              onUpdateRow={updateRow}
              rows={rows}
            />
          )}
          {deleteFolders.length > 0 && (
            <DeleteFoldersSection
              disabled={interactionsDisabled}
              expanded={showDeleteSection}
              folders={deleteFolders}
              onToggle={() => setShowDeleteSection((current) => !current)}
              onUpdate={updateFolderDeletion}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={isGeneratingSuggestions || !canApply}
            onClick={handleApply}
            type="button"
          >
            <Rows3Icon />
            {t("workspaces.importOrganizer.apply")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type SummaryBarProps = {
  isGenerating: boolean;
  summary: RowChangeSummary;
};

const SummaryBar = ({ isGenerating, summary }: SummaryBarProps) => {
  const t = useTranslations();

  return (
    <div className="bg-muted/40 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2 text-sm">
      {isGenerating ? (
        <span className="text-muted-foreground flex items-center gap-2">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {t("workspaces.importOrganizer.generating")}
        </span>
      ) : (
        <>
          <SummaryStat
            count={summary.movedCount}
            label={t("workspaces.importOrganizer.summaryToMove")}
            tone="primary"
          />
          <span className="bg-border h-3 w-px" />
          <SummaryStat
            count={summary.renamedCount}
            label={t("workspaces.importOrganizer.summaryToRename")}
            tone="primary"
          />
          <span className="bg-border h-3 w-px" />
          <SummaryStat
            count={summary.unchangedCount}
            label={t("workspaces.importOrganizer.summaryUnchanged")}
            tone="muted"
          />
        </>
      )}
    </div>
  );
};

type SummaryStatProps = {
  count: number;
  label: string;
  tone: "primary" | "muted";
};

const SummaryStat = ({ count, label, tone }: SummaryStatProps) => (
  <span
    className={cn(
      "flex items-center gap-1.5",
      tone === "muted" && "text-muted-foreground",
    )}
  >
    <span className="font-medium tabular-nums">{count}</span>
    <span className="text-muted-foreground">{label}</span>
  </span>
);

type UserInstructionsSectionProps = {
  disabled: boolean;
  expanded: boolean;
  onChange: (value: string) => void;
  onRegenerate: () => void;
  onToggle: () => void;
  value: string;
};

const USER_INSTRUCTIONS_MAX = 1500;

const UserInstructionsSection = ({
  disabled,
  expanded,
  onChange,
  onRegenerate,
  onToggle,
  value,
}: UserInstructionsSectionProps) => {
  const t = useTranslations();
  const trimmed = value.trim();
  const summary =
    trimmed.length > 0
      ? trimmed.slice(0, 80) + (trimmed.length > 80 ? "…" : "")
      : t("workspaces.importOrganizer.instructionsEmpty");

  return (
    <div className="mb-3 rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-start"
          onClick={onToggle}
          type="button"
        >
          {expanded ? (
            <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="shrink-0 font-medium">
            {t("workspaces.importOrganizer.instructionsTitle")}
          </span>
          {!expanded && (
            <span className="text-muted-foreground truncate text-xs">
              {summary}
            </span>
          )}
        </button>
        {expanded && (
          <Button
            disabled={disabled}
            onClick={onRegenerate}
            size="xs"
            type="button"
            variant="outline"
          >
            <RotateCcwIcon className="size-3.5" />
            {t("workspaces.importOrganizer.regenerate")}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="border-t p-2">
          <Textarea
            className="min-h-16"
            disabled={disabled}
            maxLength={USER_INSTRUCTIONS_MAX}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder={t(
              "workspaces.importOrganizer.instructionsPlaceholder",
            )}
            rows={2}
            value={value}
          />
        </div>
      )}
    </div>
  );
};

type FailureBannerProps = {
  disabled: boolean;
  onRetry: () => void;
};

const FailureBanner = ({ disabled, onRetry }: FailureBannerProps) => {
  const t = useTranslations();

  return (
    <div className="border-destructive/24 bg-destructive/8 mb-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
      <div className="text-foreground flex min-w-0 items-center gap-2">
        <TriangleAlertIcon className="text-destructive size-4 shrink-0" />
        <span>{t("workspaces.importOrganizer.aiUnavailable")}</span>
      </div>
      <Button
        disabled={disabled}
        onClick={onRetry}
        size="xs"
        type="button"
        variant="outline"
      >
        {t("workspaces.importOrganizer.retry")}
      </Button>
    </div>
  );
};

const OrganizerSkeleton = () => (
  <div className="space-y-2 py-2" role="status" aria-busy="true">
    <div className="flex items-center gap-2">
      <Skeleton className="size-4" />
      <Skeleton className="h-4 w-40" />
    </div>
    <div className="ms-4 space-y-2">
      {[0, 1].map((index) => (
        <div className="space-y-1.5" key={index}>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="ms-6 h-3 w-40" />
        </div>
      ))}
    </div>
    <div className="flex items-center gap-2">
      <Skeleton className="size-4" />
      <Skeleton className="h-4 w-32" />
    </div>
    <div className="ms-4 space-y-2">
      {[0, 1].map((index) => (
        <div className="space-y-1.5" key={index}>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4" />
            <Skeleton className="h-3.5 w-72" />
          </div>
          <Skeleton className="ms-6 h-3 w-32" />
        </div>
      ))}
    </div>
  </div>
);

const ORGANIZER_DRAG_TYPE = "stella.organizer-drag";

type OrganizerDragData =
  | { type: typeof ORGANIZER_DRAG_TYPE; kind: "file"; rowId: string }
  | {
      type: typeof ORGANIZER_DRAG_TYPE;
      kind: "folder";
      folderPath: string;
    };

const isOrganizerDragData = (
  data: Record<string, unknown>,
): data is OrganizerDragData => data["type"] === ORGANIZER_DRAG_TYPE;

type OrganizerTreePreviewProps = {
  rows: ExistingOrganizerRow[];
  disabled: boolean;
  onUpdateRow: (
    id: string,
    updates:
      | Pick<ExistingOrganizerRow, "folderPath">
      | Pick<ExistingOrganizerRow, "suggestedName">,
  ) => void;
  onMoveFile: (rowId: string, targetFolderPath: string) => void;
  onMoveFolder: (sourceFolderPath: string, targetFolderPath: string) => void;
  onRenameFolder: (folderPath: string, newName: string) => void;
};

const OrganizerTreePreview = ({
  rows,
  disabled,
  onUpdateRow,
  onMoveFile,
  onMoveFolder,
  onRenameFolder,
}: OrganizerTreePreviewProps) => {
  const t = useTranslations();
  const root = useMemo(() => buildOrganizerTree(rows), [rows]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRootOver, setIsRootOver] = useState(false);

  const onMoveFileRef = useRef(onMoveFile);
  onMoveFileRef.current = onMoveFile;
  const onMoveFolderRef = useRef(onMoveFolder);
  onMoveFolderRef.current = onMoveFolder;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return undefined;
    }
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isOrganizerDragData(source.data),
      getData: () => ({ folderPath: "" }),
      onDragEnter: ({ location }) => {
        if (location.current.dropTargets[0]?.element === el) {
          setIsRootOver(true);
        }
      },
      onDrag: ({ location }) => {
        setIsRootOver(location.current.dropTargets[0]?.element === el);
      },
      onDragLeave: () => setIsRootOver(false),
      onDrop: ({ source, location }) => {
        setIsRootOver(false);
        if (location.current.dropTargets[0]?.element !== el) {
          return;
        }
        const data = source.data;
        if (!isOrganizerDragData(data)) {
          return;
        }
        if (data.kind === "file") {
          onMoveFileRef.current(data.rowId, "");
        } else {
          onMoveFolderRef.current(data.folderPath, "");
        }
      },
    });
  }, []);

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {t("workspaces.importOrganizer.empty")}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "border-border rounded-md border transition-colors",
        isRootOver && "border-primary/40 bg-primary/4",
      )}
      ref={containerRef}
    >
      <ul className="py-1">
        {root.rows.map((row) => (
          <OrganizerFileNode
            disabled={disabled}
            key={row.id}
            onUpdateRow={onUpdateRow}
            row={row}
          />
        ))}
        {[...root.children.values()].map((folder) => (
          <OrganizerFolderNode
            disabled={disabled}
            folder={folder}
            key={folder.path}
            onMoveFile={onMoveFile}
            onMoveFolder={onMoveFolder}
            onRenameFolder={onRenameFolder}
            onUpdateRow={onUpdateRow}
          />
        ))}
      </ul>
    </div>
  );
};

type OrganizerFolderNodeProps = {
  folder: FolderPreviewNode;
  disabled: boolean;
  onUpdateRow: OrganizerTreePreviewProps["onUpdateRow"];
  onMoveFile: OrganizerTreePreviewProps["onMoveFile"];
  onMoveFolder: OrganizerTreePreviewProps["onMoveFolder"];
  onRenameFolder: OrganizerTreePreviewProps["onRenameFolder"];
};

const OrganizerFolderNode = ({
  folder,
  disabled,
  onUpdateRow,
  onMoveFile,
  onMoveFolder,
  onRenameFolder,
}: OrganizerFolderNodeProps) => {
  const headerRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditing, setIsEditing] = useState(false);

  const t = useTranslations();

  const onMoveFileRef = useRef(onMoveFile);
  onMoveFileRef.current = onMoveFile;
  const onMoveFolderRef = useRef(onMoveFolder);
  onMoveFolderRef.current = onMoveFolder;

  useEffect(() => {
    const el = headerRef.current;
    const handle = dragHandleRef.current;
    if (!el || !handle) {
      return undefined;
    }
    return combine(
      draggable({
        element: el,
        dragHandle: handle,
        getInitialData: () => ({
          type: ORGANIZER_DRAG_TYPE,
          kind: "folder",
          folderPath: folder.path,
        }),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => {
          const data = source.data;
          if (!isOrganizerDragData(data)) {
            return false;
          }
          if (data.kind === "folder") {
            if (data.folderPath === folder.path) {
              return false;
            }
            if (folder.path.startsWith(`${data.folderPath}/`)) {
              return false;
            }
          }
          return true;
        },
        getData: () => ({ folderPath: folder.path }),
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const data = source.data;
          if (!isOrganizerDragData(data)) {
            return;
          }
          if (data.kind === "file") {
            onMoveFileRef.current(data.rowId, folder.path);
          } else if (data.folderPath !== folder.path) {
            onMoveFolderRef.current(data.folderPath, folder.path);
          }
        },
      }),
    );
  }, [folder.path]);

  const hasChildren = folder.children.size + folder.rows.length > 0;

  return (
    <li>
      <div
        className={cn(
          "text-foreground flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm font-medium transition-colors",
          isDropTarget && "bg-primary/8 ring-primary/40 ring-1",
        )}
        ref={headerRef}
      >
        <button
          aria-label={
            isExpanded
              ? t("workspaces.importOrganizer.collapseFolder")
              : t("workspaces.importOrganizer.expandFolder")
          }
          className="text-muted-foreground hover:text-foreground flex size-4 shrink-0 items-center justify-center"
          disabled={!hasChildren}
          onClick={() => setIsExpanded((prev) => !prev)}
          type="button"
        >
          {isExpanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <div
          className={cn(
            "flex shrink-0 items-center",
            !disabled && "cursor-grab active:cursor-grabbing",
          )}
          ref={dragHandleRef}
        >
          <FolderIcon className="text-muted-foreground size-4" />
        </div>
        {isEditing ? (
          <InlineNameInput
            disabled={disabled}
            onCommit={(value) => {
              onRenameFolder(folder.path, value);
              setIsEditing(false);
            }}
            placeholder={folder.name}
            value={folder.name}
          />
        ) : (
          <button
            className="hover:bg-muted/40 truncate rounded-sm px-1 text-start"
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {folder.name}
          </button>
        )}
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {countFilesInFolder(folder)}
        </span>
      </div>
      {isExpanded && hasChildren && (
        <ul className="border-border/72 ms-4 border-s">
          {[...folder.children.values()].map((child) => (
            <OrganizerFolderNode
              disabled={disabled}
              folder={child}
              key={child.path}
              onMoveFile={onMoveFile}
              onMoveFolder={onMoveFolder}
              onRenameFolder={onRenameFolder}
              onUpdateRow={onUpdateRow}
            />
          ))}
          {folder.rows.map((row) => (
            <OrganizerFileNode
              disabled={disabled}
              key={row.id}
              onUpdateRow={onUpdateRow}
              row={row}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

type OrganizerFileNodeProps = {
  row: ExistingOrganizerRow;
  disabled: boolean;
  onUpdateRow: OrganizerTreePreviewProps["onUpdateRow"];
};

const OrganizerFileNode = ({
  row,
  disabled,
  onUpdateRow,
}: OrganizerFileNodeProps) => {
  const t = useTranslations();
  const liRef = useRef<HTMLLIElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = liRef.current;
    if (!el) {
      return undefined;
    }
    return draggable({
      element: el,
      getInitialData: () => ({
        type: ORGANIZER_DRAG_TYPE,
        kind: "file",
        rowId: row.id,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [row.id]);

  const targetName = normalizeSuggestedFileName(
    row.suggestedName,
    row.originalName,
  );
  const isRenamed = targetName !== row.originalName;
  const secondaryParts: string[] = [];
  if (isRenamed) {
    secondaryParts.push(
      t("workspaces.importOrganizer.wasNamed", {
        name: row.originalName,
      }),
    );
  }
  if (row.documentType) {
    secondaryParts.push(row.documentType);
  }

  return (
    <li
      className={cn(
        "group hover:bg-muted/40 flex items-start gap-2 rounded-sm px-2 py-1.5 transition-opacity",
        isDragging && "opacity-50",
      )}
      ref={liRef}
    >
      <EntityKindIcon
        className="text-muted-foreground mt-1.5 size-4 shrink-0"
        kind="document"
        mimeType={row.mimeType}
      />
      <div className="min-w-0 flex-1 text-sm">
        <InlineNameInput
          disabled={disabled}
          onCommit={(value) => onUpdateRow(row.id, { suggestedName: value })}
          placeholder={row.originalName}
          value={row.suggestedName}
        />
        {secondaryParts.length > 0 && (
          <p className="text-muted-foreground truncate ps-3 text-xs">
            {secondaryParts.join(" · ")}
          </p>
        )}
      </div>
    </li>
  );
};

type InlineNameInputProps = {
  disabled: boolean;
  onCommit: (value: string) => void;
  placeholder: string;
  value: string;
};

const InlineNameInput = ({
  disabled,
  onCommit,
  placeholder,
  value,
}: InlineNameInputProps) => {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Input
      className="hover:border-input/40 focus-within:bg-background focus-within:border-input border-transparent bg-transparent shadow-none"
      disabled={disabled}
      onBlur={() => {
        if (draft !== value) {
          onCommit(draft);
        }
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      size="sm"
      value={draft}
    />
  );
};

type DeleteFoldersSectionProps = {
  disabled: boolean;
  expanded: boolean;
  folders: FolderDeletionSuggestion[];
  onToggle: () => void;
  onUpdate: (entityId: string, selected: boolean) => void;
};

const DeleteFoldersSection = ({
  disabled,
  expanded,
  folders,
  onToggle,
  onUpdate,
}: DeleteFoldersSectionProps) => {
  const t = useTranslations();
  const selectedCount = folders.filter((folder) => folder.selected).length;

  return (
    <div className="mt-3 rounded-md border">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm"
        onClick={onToggle}
        type="button"
      >
        {expanded ? (
          <ChevronDownIcon className="text-muted-foreground size-3.5" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-3.5" />
        )}
        <Trash2Icon className="text-muted-foreground size-4" />
        <span className="font-medium">
          {t("workspaces.importOrganizer.emptyFoldersToDelete", {
            count: folders.length,
          })}
        </span>
        <span className="text-muted-foreground ms-auto text-xs tabular-nums">
          {t("workspaces.importOrganizer.selectedOfTotal", {
            selected: selectedCount,
            total: folders.length,
          })}
        </span>
      </button>
      {expanded && (
        <ul className="border-t">
          {folders.map((folder) => (
            <li
              className="flex items-start gap-2 px-3 py-2 text-sm"
              key={folder.entityId}
            >
              <Checkbox
                checked={folder.selected}
                className="mt-0.5"
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onUpdate(folder.entityId, checked)
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{folder.folderPath}</p>
                <p className="text-muted-foreground text-xs">{folder.reason}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const countFilesInFolder = (folder: FolderPreviewNode): number => {
  let total = folder.rows.length;
  for (const child of folder.children.values()) {
    total += countFilesInFolder(child);
  }
  return total;
};

const buildOrganizerTree = (
  rows: readonly ExistingOrganizerRow[],
): FolderPreviewNode => {
  const root = createFolderNode("", "");

  for (const row of rows) {
    const folderPath = normalizeFolderPath(row.folderPath);
    if (folderPath.length === 0) {
      root.rows.push(row);
      continue;
    }

    let current = root;
    const segments = folderPath.split("/");
    const currentPath: string[] = [];
    for (const segment of segments) {
      currentPath.push(segment);
      const path = currentPath.join("/");
      const existing = current.children.get(segment);
      if (existing) {
        current = existing;
        continue;
      }

      const node = createFolderNode(segment, path);
      current.children.set(segment, node);
      current = node;
    }
    current.rows.push(row);
  }

  sortFolderNode(root);
  return root;
};

const createFolderNode = (name: string, path: string): FolderPreviewNode => ({
  name,
  path,
  children: new Map(),
  rows: [],
});

const sortFolderNode = (node: FolderPreviewNode): void => {
  node.children = new Map(
    [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  node.rows.sort((a, b) => a.suggestedName.localeCompare(b.suggestedName));
  for (const child of node.children.values()) {
    sortFolderNode(child);
  }
};

type EnsureFoldersOptions = {
  workspaceId: string;
  rows: readonly FileNameSuggestion[];
  existingFolders: readonly ExistingImportFolder[];
};

// Folder paths returned from the AI and seen on the dialog rows are
// always absolute (relative to the workspace root). We therefore
// resolve them from `null` regardless of which folder the user opened
// the dialog from — matching them against `existingFolders` is what
// keeps the user's existing structure intact, and an empty path means
// "place at workspace root".
const ensureFolders = async ({
  workspaceId,
  rows,
  existingFolders,
}: EnsureFoldersOptions): Promise<Map<string, string | null>> => {
  const folderIds = new Map<string, string | null>([["", null]]);
  const knownFolders = new Map<string, string>();

  for (const folder of existingFolders) {
    knownFolders.set(folderKey(folder.parentId, folder.name), folder.entityId);
  }

  const folderPaths = [
    ...new Set(rows.map((row) => normalizeFolderPath(row.folderPath))),
  ].sort((a, b) => a.localeCompare(b));

  for (const folderPath of folderPaths) {
    let currentParentId: string | null = null;
    const segments = folderPath.split("/").filter((segment) => segment !== "");
    const currentPath: string[] = [];

    for (const segment of segments) {
      currentPath.push(segment);
      const pathKey = currentPath.join("/");
      const key = folderKey(currentParentId, segment);
      const existingId = knownFolders.get(key);

      if (existingId) {
        currentParentId = existingId;
        folderIds.set(pathKey, existingId);
        continue;
      }

      const parentSafeId =
        currentParentId === null ? null : toSafeId<"entity">(currentParentId);
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
          queryKey: entitiesKeys.all(workspaceId),
          kind: "folder",
          name: segment,
          parentId: parentSafeId,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      const newEntityId: string = response.data.entityId;
      currentParentId = newEntityId;
      knownFolders.set(key, newEntityId);
      folderIds.set(pathKey, newEntityId);
    }
  }

  return folderIds;
};

// Folder names are matched case-sensitively. Case-folding here would
// collapse case-distinct siblings (e.g. existing `Clients` and
// `clients` under the same parent) to one ID, and the AI's suggestion
// could then move files into the wrong real folder. If the AI returns
// a different casing than what exists, that just means a separate
// folder gets created — surprising but not destructive.
const folderKey = (parentId: string | null, name: string): string =>
  `${parentId ?? "root"}:${name}`;
