import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  ArchiveIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EraserIcon,
  EyeIcon,
  FileOutputIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderSyncIcon,
  LaptopIcon,
  LanguagesIcon,
  LockOpenIcon,
  Maximize2Icon,
  MessageSquareIcon,
  PencilIcon,
  RefreshCwIcon,
  ScanTextIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { isDocumentTranslationSourceEligible } from "@stll/api-contract/document-translation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { buildEntityMentionOption } from "@/components/chat-mention-helpers";
import { useRequestChatAbout } from "@/components/chat/use-request-chat-about";
import { openInspectorSelection } from "@/components/inspector/inspector-actions";
import Tooltip from "@/components/tooltip";
import { TranslateDocumentDialog } from "@/components/translate-document-dialog";
import { CopyToMatterDialog } from "@/components/workspaces/copy-to-matter-dialog";
import {
  buildSelectionParentLookup,
  resolveAncestorIds,
  type CopyToMatterEntity,
} from "@/components/workspaces/copy-to-matter-dialog.logic";
import {
  getEntityName,
  getFirstFile,
} from "@/components/workspaces/entity-utils";
import { useEntitiesCountLimit } from "@/components/workspaces/hooks/use-limits";
import type { TableTreeNode } from "@/components/workspaces/table/types";
import { PDF_MIME_TYPE } from "@/consts";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { externalApiOrigin } from "@/lib/api-origins";
import { apiUrl } from "@/lib/api-url";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { DOCX_MIME } from "@/lib/consts";
import {
  DesktopBridgeIncompatibleError,
  openFileInDesktop,
  type OpenFileInDesktopResult,
} from "@/lib/desktop-bridge";
import {
  DESKTOP_EDIT_FILE_TYPES,
  canOpenDesktopEdit,
  getDesktopEditFileType,
} from "@/lib/desktop-edit-formats";
import { showDesktopEditOpenResultToast } from "@/lib/desktop-edit-status-toast";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { isUnauthorizedError } from "@/lib/errors/auth";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";
import type {
  OcrExportStatus,
  PropertyId,
  WorkspaceCellMetadata,
  WorkspaceEntity,
} from "@/lib/types";
import { downloadFile } from "@/lib/utils";
import {
  useCreateEntities,
  useDeleteEntities,
} from "@/lib/workspaces/mutations/entities";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import {
  CellLockMenuItem,
  CellMetadataMenuSection,
} from "@/routes/_protected.workspaces/$workspaceId/-components/cell-metadata-flags";
import { getExtension } from "@/routes/_protected.workspaces/$workspaceId/-components/file-extension";
import { requestManualOcr } from "@/routes/_protected.workspaces/$workspaceId/-components/request-manual-ocr";
import {
  canDownloadScrubbed,
  canRunManualOcr,
  getDesktopEditLockState,
  getOcrExportFileName,
  getOcrExportFormats,
  getOcrSources,
  getPdfDownloadFileName,
  hasOcrExport,
  type OcrExportFormat,
  type OcrSource,
  type RowActionContext,
} from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions.logic";
import { useRetryCell } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-retry-cell";
import { useUploadVersion } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-upload-version";

export type VirtualAnchor = {
  getBoundingClientRect: () => DOMRect;
};

type RowActionsProps = {
  entity: WorkspaceEntity;
  ocrSource?: OcrSource | undefined;
  workspaceId: string;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onOpen?: (() => void) | undefined;
  onRename?: (() => void) | undefined;
  onSubfolderCreated?:
    | ((entityId: string, parentId: string) => void)
    | undefined;
  triggerClassName?: string | undefined;
  triggerTabIndex?: number | undefined;
  anchor?: VirtualAnchor | null | undefined;
  /** Extra entities included in bulk actions. */
  selectedEntities?: WorkspaceEntity[] | undefined;
  /** Resolves an entity's full ancestor chain, spanning the ancestor folders a
   *  filter/search hid. Supplied by the filesystem tree so cross-matter copy/
   *  move dedupe stays correct across hidden intermediate folders. */
  getAncestorIds?: ((entityId: string) => string[]) | undefined;
  cellMetadataTarget?:
    | { propertyId: PropertyId; metadata: WorkspaceCellMetadata | undefined }
    | null
    | undefined;
};

type TranslationTarget = {
  encrypted: boolean;
  fieldId: string;
  mimeType: string;
};

type TranslationDialogState =
  | { type: "closed" }
  | { target: TranslationTarget; type: "open" };

const getTranslationTarget = ({
  cellMetadataTarget,
  entity,
  file,
  isBulk,
}: {
  cellMetadataTarget: RowActionsProps["cellMetadataTarget"];
  entity: WorkspaceEntity;
  file: ReturnType<typeof getFirstFile>;
  isBulk: boolean;
}): TranslationTarget | null => {
  if (isBulk) {
    return null;
  }
  const contextField = cellMetadataTarget
    ? entity.fields[cellMetadataTarget.propertyId]
    : undefined;
  const target = (() => {
    if (!cellMetadataTarget) {
      return file;
    }
    if (contextField?.content.type !== "file") {
      return null;
    }
    return {
      encrypted: contextField.content.encrypted,
      fieldId: contextField.id,
      mimeType: contextField.content.mimeType,
    };
  })();
  return target !== null && isDocumentTranslationSourceEligible(target)
    ? target
    : null;
};

const OcrExportMenuItems = ({
  exportStatus,
  onDownload,
  searchablePdfLabel,
  textLabel,
}: {
  exportStatus: OcrExportStatus;
  onDownload: (format: OcrExportFormat) => void;
  searchablePdfLabel: string;
  textLabel: string;
}) => {
  const formats = getOcrExportFormats(exportStatus);

  return (
    <>
      {formats.includes("searchable-pdf") && (
        <MenuItem onClick={() => onDownload("searchable-pdf")}>
          <FileOutputIcon />
          {searchablePdfLabel}
        </MenuItem>
      )}
      {formats.includes("text") && (
        <MenuItem onClick={() => onDownload("text")}>
          <FileTextIcon />
          {textLabel}
        </MenuItem>
      )}
    </>
  );
};

export const RowActions = ({
  entity,
  workspaceId,
  open,
  onOpenChange,
  onOpen,
  onRename,
  onSubfolderCreated,
  triggerClassName,
  triggerTabIndex,
  anchor,
  selectedEntities,
  getAncestorIds,
  cellMetadataTarget,
  ocrSource,
}: RowActionsProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteEntities = useDeleteEntities();
  const uploadVersion = useUploadVersion();
  const requestChatAbout = useRequestChatAbout(workspaceId);
  const retryCell = useRetryCell(toSafeId<"workspace">(workspaceId));
  const canCreateEntity = usePermissions({ entity: ["create"] });
  const [copyToMatterOpen, setCopyToMatterOpen] = useState(false);
  const [copyToMatterEntities, setCopyToMatterEntities] = useState<
    CopyToMatterEntity[]
  >([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isOcrPending, setIsOcrPending] = useState(false);
  const [translationDialogState, setTranslationDialogState] =
    useState<TranslationDialogState>({ type: "closed" });
  const { data: properties } = useQuery(propertiesOptions(workspaceId));
  const uploadVersionInputRef = useRef<HTMLInputElement>(null);
  const file = getFirstFile(entity);
  const name = getEntityName(entity);
  const isFolder = entity.kind === "folder";
  const isBulk = selectedEntities !== undefined && selectedEntities.length > 1;
  const bulkTargets = isBulk ? selectedEntities : [entity];
  const isCellContext =
    !isBulk && cellMetadataTarget !== null && cellMetadataTarget !== undefined;
  const translationTarget = getTranslationTarget({
    cellMetadataTarget,
    entity,
    file,
    isBulk,
  });
  const openTranslationDialog = () => {
    if (translationTarget === null) {
      return;
    }
    setTranslationDialogState({ target: translationTarget, type: "open" });
  };
  const handleTranslationDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setTranslationDialogState({ type: "closed" });
    }
  };
  const ocrSources = getOcrSources(entity.fields);
  let rowActionContext: RowActionContext = "row";
  if (isBulk) {
    rowActionContext = "bulk";
  } else if (isCellContext) {
    rowActionContext = "cell";
  }
  const canRunOcr = canRunManualOcr({
    context: rowActionContext,
    entity,
    ocrSource,
  });
  const rowOcrSources = isCellContext
    ? []
    : ocrSources.filter((source) =>
        canRunManualOcr({
          context: rowActionContext,
          entity,
          ocrSource: source,
        }),
      );
  const desktopEditFileType =
    !isBulk && file
      ? getDesktopEditFileType({
          fileName: file.fileName,
          mimeType: file.mimeType,
        })
      : null;
  const hasDesktopEditFileType = desktopEditFileType !== null;
  const desktopEditLockState = getDesktopEditLockState(entity.activeEditBy);
  const isLockedByMe =
    hasDesktopEditFileType && desktopEditLockState === "locked-by-me";
  const canOpenInDesktop = canOpenDesktopEdit({
    context: rowActionContext,
    fileType: desktopEditFileType,
    lockState: desktopEditLockState,
    readOnly: entity.readOnly,
  });
  const openCopyToMatterDialog = () => {
    setCopyToMatterEntities(
      toCopyToMatterEntities(bulkTargets, getAncestorIds),
    );
    setCopyToMatterOpen(true);
  };
  const handleCopyToMatterOpenChange = (nextOpen: boolean) => {
    setCopyToMatterOpen(nextOpen);
    if (!nextOpen) {
      setCopyToMatterEntities([]);
    }
  };

  const openVersionHistory = file
    ? () => {
        useWorkspaceStore.getState().setPdfViewerState({
          sidebar: "versions",
        });
        detached(
          navigate({
            to: "/workspaces/$workspaceId/$viewId/document",
            params: { workspaceId, viewId: "all" },
            search: {
              entity: entity.entityId,
              field: file.fieldId,
              panel: "versions" as const,
            },
          }),
          "row-actions.navigate",
        );
      }
    : undefined;

  const resolvedOnOpen = resolvePreviewHandler({
    anchor: entity,
    entities: bulkTargets,
    isBulk,
    onOpen,
    workspaceId,
  });

  const hasPdfConversion =
    file !== null && file.pdfFileId !== null && file.mimeType !== PDF_MIME_TYPE;
  let exportableOcrSources: readonly OcrSource[] = [];
  if (!isBulk && isCellContext && ocrSource && hasOcrExport(ocrSource)) {
    exportableOcrSources = [ocrSource];
  } else if (!isBulk && !isCellContext) {
    exportableOcrSources = ocrSources.filter(hasOcrExport);
  }
  // Only formats whose embedded metadata the API can actually strip; offering
  // the action on a file it would refuse is worse than not offering it.
  const canScrub = !isBulk && file !== null && canDownloadScrubbed(file);
  const hasDownloadVariants =
    !isBulk &&
    (hasPdfConversion || canScrub || exportableOcrSources.length > 0);

  const msg: Msg = {
    downloading: t("workspaces.files.downloadAsZip"),
    failed: t("errors.actionFailed"),
    scrubFailed: t("workspaces.files.scrubFailed"),
  };

  const showDesktopOpenResult = async (result: OpenFileInDesktopResult) => {
    if (desktopEditFileType === null) {
      return;
    }

    const application =
      DESKTOP_EDIT_FILE_TYPES[desktopEditFileType].application;
    await showDesktopEditOpenResultToast({
      messages: {
        notOpenedDescription: t.rich(
          "workspaces.files.desktopEdit.notOpenedDescription",
          {
            application,
            bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
          },
        ),
        openedDescription: t.rich(
          "workspaces.files.desktopEdit.openedDescription",
          {
            application,
            bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
          },
        ),
        openedTitle: t("workspaces.files.desktopEdit.openedTitle"),
        sentDescription: t.rich(
          "workspaces.files.desktopEdit.sentDescription",
          {
            application,
            bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
          },
        ),
        sentTitle: t("workspaces.files.desktopEdit.sentTitle"),
        unavailableTitle: t("workspaces.files.desktopEdit.unavailableTitle"),
        updateRequiredDescription: t(
          "workspaces.files.desktopEdit.updateRequiredDescription",
        ),
        updateRequiredTitle: t(
          "workspaces.files.desktopEdit.updateRequiredTitle",
        ),
      },
      result,
    });
  };

  const handleZipDownload = async () => {
    if (isBulk) {
      for (const e of selectedEntities) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: each iteration triggers a browser download; parallelizing would fire many concurrent downloads and lose ordering
        await downloadEntityAsZip(workspaceId, e, msg);
      }
      return;
    }

    await downloadEntityAsZip(workspaceId, entity, msg);
  };

  const handleDownload = async (variant: DownloadVariant = "original") => {
    if (isBulk) {
      for (const e of selectedEntities) {
        const f = getFirstFile(e);
        if (f) {
          // oxlint-disable-next-line no-await-in-loop -- sequential by design: each iteration triggers a browser download; parallelizing would fire many concurrent downloads and lose ordering
          await downloadSingleFile(workspaceId, f, variant, msg);
        }
      }
      return;
    }

    if (file) {
      await downloadSingleFile(workspaceId, file, variant, msg);
    }
  };

  const handleOcrExport = async (
    source: OcrSource,
    format: OcrExportFormat,
  ) => {
    await downloadOcrExport({ workspaceId, source, format, msg });
  };

  const handleOpenInDesktop = async () => {
    if (!file || desktopEditFileType === null) {
      return;
    }

    try {
      const linkedAccount = await getFreshLinkedAccount();

      const desktopInput = {
        apiBaseUrl: externalApiOrigin(),
        entityId: file.entityId,
        linkedAccount,
        propertyId: file.propertyId,
        workspaceId,
        ...(isLockedByMe ? { force: true as const } : {}),
      };

      const openResult = await openFileInDesktop(desktopInput);
      await showDesktopOpenResult(openResult);
    } catch (error) {
      analytics.captureError(error);
      if (error instanceof Error && isUnauthorizedError(error)) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.authRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.authRequiredTitle"),
          type: "error",
        });
        return;
      }

      if (error instanceof DesktopBridgeIncompatibleError) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.updateRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.updateRequiredTitle"),
          type: "error",
        });
        return;
      }

      stellaToast.add({
        description: t("workspaces.files.desktopEdit.unavailableDescription"),
        title: t("workspaces.files.desktopEdit.unavailableTitle"),
        type: "error",
      });
    }
  };

  const doForceTakeover = async () => {
    if (!file || desktopEditFileType === null) {
      return;
    }

    const linkedAccount = await getFreshLinkedAccount();

    const openResult = await openFileInDesktop({
      apiBaseUrl: externalApiOrigin(),
      entityId: file.entityId,
      force: true,
      linkedAccount,
      propertyId: file.propertyId,
      workspaceId,
    });
    await showDesktopOpenResult(openResult);
  };

  // Force-release the lock and surface the same auth-aware feedback
  // whether the caller is the synchronous fallback or the delayed
  // takeover timer, so neither path can fail silently.
  const forceTakeoverWithFeedback = async () => {
    try {
      await doForceTakeover();
    } catch (forceError) {
      analytics.captureError(forceError);
      if (forceError instanceof Error && isUnauthorizedError(forceError)) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.authRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.authRequiredTitle"),
          type: "error",
        });
        return;
      }

      if (forceError instanceof DesktopBridgeIncompatibleError) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.updateRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.updateRequiredTitle"),
          type: "error",
        });
        return;
      }

      stellaToast.add({
        description: t("workspaces.files.desktopEdit.unavailableDescription"),
        title: t("workspaces.files.desktopEdit.unavailableTitle"),
        type: "error",
      });
    }
  };

  const handleReleaseLock = async () => {
    if (!file || desktopEditFileType === null) {
      return;
    }

    if (desktopEditLockState === "locked-by-me") {
      try {
        const response = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["desktop-edit-sessions"].release.post({
            entityId: toSafeId<"entity">(file.entityId),
            propertyId: toSafeId<"property">(file.propertyId),
          });

        if (response.error) {
          throw toAPIError(response.error);
        }

        await queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        });
        return;
      } catch (error) {
        analytics.captureError(error);
        stellaToast.add({
          description: userErrorFromThrown(error, t("common.unexpectedError")),
          title: t("errors.actionFailed"),
          type: "error",
        });
        return;
      }
    }

    const lockedByName = entity.activeEditBy?.name ?? "";

    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["desktop-edit-sessions"]["request-takeover"].post({
          entityId: toSafeId<"entity">(file.entityId),
          propertyId: toSafeId<"property">(file.propertyId),
        });

      if (response.error) {
        // No active session or other error — force release
        await doForceTakeover();
        return;
      }

      // Consent request sent — show waiting toast with 30s timeout
      const toastId = stellaToast.add({
        title: t("workspaces.files.desktopEdit.takeoverWaiting"),
        description: t(
          "workspaces.files.desktopEdit.takeoverWaitingDescription",
          { name: lockedByName },
        ),
        type: "loading",
      });

      // After 30 seconds, close the waiting toast and force-release.
      // If the lock holder responds before the timeout, the SSE
      // resource update refetches the entity list and
      // the "Release lock" option disappears; the loading toast
      // becomes stale but harmless (force-release on an already-
      // released lock is a no-op on the API side).
      setTimeout(() => {
        stellaToast.close(toastId);
        detached(
          forceTakeoverWithFeedback(),
          "row-actions.force-takeover-with-feedback",
        );
      }, 30_000);
    } catch {
      await forceTakeoverWithFeedback();
    }
  };

  const cellProperty =
    cellMetadataTarget && properties
      ? properties.find((p) => p.id === cellMetadataTarget.propertyId)
      : undefined;
  const cellField = cellMetadataTarget
    ? entity.fields[cellMetadataTarget.propertyId]
    : undefined;
  const canRetryCell =
    cellProperty?.tool.type === "ai-model" &&
    cellProperty.content.type !== "file";
  const retryDisabled =
    isRetrying ||
    entity.readOnly ||
    cellMetadataTarget?.metadata?.locked === true ||
    cellField?.content.type === "pending";

  const handleRetryCell = async () => {
    if (!cellMetadataTarget || isRetrying) {
      return;
    }
    setIsRetrying(true);
    try {
      await retryCell({
        entityId: entity.entityId,
        propertyId: cellMetadataTarget.propertyId,
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const handleChatAbout = () => {
    const mentions = bulkTargets.map((target) =>
      buildEntityMentionOption({ entity: target }),
    );
    requestChatAbout(mentions);
  };

  const handleDuplicate = async () => {
    // Folders cannot be duplicated server-side; silently skip them so a
    // mixed selection (folders + files) does not surface as a generic
    // failure to the user.
    const targets = bulkTargets.filter((e) => e.kind !== "folder");

    if (targets.length === 0) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }

    let failedCount = 0;
    for (const e of targets) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: duplicate mutations share the same query-key cache invalidation and risk rate limits if fired concurrently
      const result = await Result.tryPromise(async () => {
        const response = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .duplicate.post({
            entityId: toSafeId<"entity">(e.entityId),
          });
        return unwrapEden(response);
      });
      if (Result.isError(result)) {
        failedCount++;
      }
    }

    if (failedCount === 0) {
      stellaToast.add({
        title: t("common.duplicated"),
        type: "success",
      });
    } else if (failedCount === targets.length) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    } else {
      stellaToast.add({
        title: t("common.duplicated"),
        description: t("errors.actionFailed"),
        type: "warning",
      });
    }
  };

  const handleDelete = () => {
    const ids = isBulk
      ? selectedEntities.map((e) => e.entityId)
      : [entity.entityId];
    deleteEntities.mutate(
      { workspaceId, entityIds: ids },
      {
        onSuccess: () => {
          stellaToast.add({
            title: isBulk
              ? t("common.deletedCount", { count: ids.length })
              : t("workspaces.deletedItem", { name }),
            type: "success",
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToDeleteEntities"),
            type: "error",
          });
        },
      },
    );
  };

  const handleUploadVersionSelect = () => {
    uploadVersionInputRef.current?.click();
  };

  const handleUploadVersionChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const uploadedFile = event.target.files?.[0];
    if (!uploadedFile || !file) {
      return;
    }

    uploadVersion.mutate({
      workspaceId,
      entityId: entity.entityId,
      entityFileName: file.fileName,
      file: uploadedFile,
    });

    // Reset input to allow uploading the same file again
    event.target.value = "";
  };

  const handleRunOcr = async (source: OcrSource | undefined) => {
    if (!source || isOcrPending) {
      return;
    }

    setIsOcrPending(true);
    try {
      const { outcome } = await requestManualOcr({
        entityId: entity.entityId,
        fieldId: source.fieldId,
        workspaceId,
      });
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      stellaToast.add({
        title: t(
          outcome === "already_processed"
            ? "workspaces.files.ocrAlreadyProcessed"
            : "workspaces.files.ocrQueued",
        ),
        type: "success",
      });
    } catch (error) {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.files.ocrQueueFailed"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    } finally {
      setIsOcrPending(false);
    }
  };

  // Whether any selected entity has a downloadable file.
  const hasAnyFile = isBulk
    ? selectedEntities.some((e) => getFirstFile(e) !== null)
    : file !== null;
  const hasAnyFolder = isBulk
    ? selectedEntities.some((e) => e.kind === "folder")
    : isFolder;

  // Show "Upload new version" for non-folder, non-bulk entities with a file
  const canUploadVersion =
    !isBulk && !isFolder && !entity.readOnly && file !== null;
  // Extension-based filter for the OS file picker. Browser-reported MIME
  // strings vary across platforms for the same extension; matching by
  // extension is consistent across Chrome, Safari, Firefox, and Edge.
  // Falls back to `*/*` for extensionless files (e.g. `Dockerfile`).
  const versionAcceptExtension = file ? getExtension(file.fileName) : null;
  const versionAccept = versionAcceptExtension
    ? `.${versionAcceptExtension}`
    : "*/*";

  return (
    <Menu onOpenChange={onOpenChange} open={open}>
      <Tooltip
        content={t("common.actions")}
        render={
          <MenuTrigger
            className={cn(
              triggerClassName ??
                "opacity-0! transition-opacity group-hover/row:opacity-100!",
            )}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            render={<Button size="icon-xs" variant="ghost" />}
            tabIndex={triggerTabIndex}
          />
        }
      >
        <EllipsisVerticalIcon />
      </Tooltip>
      <MenuPopup anchor={anchor ?? undefined}>
        {/* --- View / Edit --- */}
        <RowOpenMenuActions
          canUploadVersion={canUploadVersion}
          isBulk={isBulk}
          isCellContext={isCellContext}
          onOpen={resolvedOnOpen}
          onRename={onRename}
          onUploadVersion={handleUploadVersionSelect}
          uploadVersionPending={uploadVersion.isPending}
        />
        <RowOcrMenuActions
          canRunOcr={canRunOcr}
          isPending={isOcrPending}
          onRun={handleRunOcr}
          rowSources={rowOcrSources}
          selectedSource={ocrSource}
        />
        <RowCellMenuActions
          canRetry={canRetryCell}
          entityId={entity.entityId}
          isBulk={isBulk}
          metadataTarget={cellMetadataTarget}
          onRetry={handleRetryCell}
          retryDisabled={retryDisabled}
          workspaceId={workspaceId}
        />
        <RowFolderDesktopMenuActions
          canOpenInDesktop={canOpenInDesktop}
          canReleaseDesktopLock={
            !entity.readOnly &&
            hasDesktopEditFileType &&
            desktopEditLockState !== "unlocked"
          }
          entity={entity}
          isBulk={isBulk}
          isCellContext={isCellContext}
          isFolder={isFolder}
          onOpenInDesktop={handleOpenInDesktop}
          onReleaseDesktopLock={handleReleaseLock}
          onSubfolderCreated={onSubfolderCreated}
          workspaceId={workspaceId}
        />

        <MenuSeparator />

        {/* --- Features --- */}
        <RowFeatureMenuActions
          canCreateEntity={canCreateEntity}
          entity={entity}
          file={file}
          isBulk={isBulk}
          isFolder={isFolder}
          onChatAbout={handleChatAbout}
          onOpenVersionHistory={openVersionHistory}
          onTranslate={openTranslationDialog}
          translationTarget={translationTarget}
        />
        <RowCellOcrExportMenuActions
          isCellContext={isCellContext}
          onExport={handleOcrExport}
          sources={exportableOcrSources}
        />
        <RowFileOperationsMenu
          canScrub={canScrub}
          exportableOcrSources={exportableOcrSources}
          hasAnyFile={hasAnyFile}
          hasAnyFolder={hasAnyFolder}
          hasDownloadVariants={hasDownloadVariants}
          hasPdfConversion={hasPdfConversion}
          isBulk={isBulk}
          isCellContext={isCellContext}
          name={name}
          onCopyToMatter={openCopyToMatterDialog}
          onDelete={handleDelete}
          onDownload={handleDownload}
          onDuplicate={handleDuplicate}
          onOcrExport={handleOcrExport}
          onZipDownload={handleZipDownload}
          selectedCount={bulkTargets.length}
        />
      </MenuPopup>
      <CopyToMatterDialog
        entities={copyToMatterEntities}
        onOpenChange={handleCopyToMatterOpenChange}
        open={copyToMatterOpen}
        sourceWorkspaceId={workspaceId}
      />
      <RowTranslationDialog
        canCreateEntity={canCreateEntity}
        entity={entity}
        onOpenChange={handleTranslationDialogOpenChange}
        open={translationDialogState.type === "open"}
        target={
          translationDialogState.type === "open"
            ? translationDialogState.target
            : null
        }
        workspaceId={workspaceId}
      />
      {/* Hidden file input for upload new version */}
      {canUploadVersion && (
        <input
          accept={versionAccept}
          className="hidden"
          onChange={handleUploadVersionChange}
          ref={uploadVersionInputRef}
          type="file"
        />
      )}
    </Menu>
  );
};

type ResolvePreviewHandlerArgs = {
  anchor: WorkspaceEntity;
  entities: readonly WorkspaceEntity[];
  isBulk: boolean;
  onOpen: (() => void) | undefined;
  workspaceId: string;
};

/** Preview opens every selected entity the inspector can render and focuses
 *  the row the menu was opened on. `onOpen` overrides a single-entity menu
 *  only; a bulk selection always opens as a whole. */
const resolvePreviewHandler = ({
  anchor,
  entities,
  isBulk,
  onOpen,
  workspaceId,
}: ResolvePreviewHandlerArgs): (() => void) | undefined => {
  if (!isBulk && onOpen) {
    return onOpen;
  }
  return openInspectorSelection({ entities, anchor, workspaceId });
};

const RowOpenMenuActions = ({
  canUploadVersion,
  isBulk,
  isCellContext,
  onOpen,
  onRename,
  onUploadVersion,
  uploadVersionPending,
}: {
  canUploadVersion: boolean;
  isBulk: boolean;
  isCellContext: boolean;
  onOpen: (() => void) | undefined;
  onRename: (() => void) | undefined;
  onUploadVersion: () => void;
  uploadVersionPending: boolean;
}) => {
  const t = useTranslations();
  return (
    <>
      {onOpen !== undefined && (
        <MenuItem onClick={onOpen}>
          <EyeIcon />
          {t("common.preview")}
        </MenuItem>
      )}
      {!isBulk && onRename !== undefined && (
        <MenuItem onClick={onRename}>
          <PencilIcon />
          {t("common.rename")}
        </MenuItem>
      )}
      {!isCellContext && canUploadVersion && (
        <MenuItem disabled={uploadVersionPending} onClick={onUploadVersion}>
          <UploadIcon />
          {t("fileDetail.uploadNewVersion")}
        </MenuItem>
      )}
    </>
  );
};

const RowOcrMenuActions = ({
  canRunOcr,
  isPending,
  onRun,
  rowSources,
  selectedSource,
}: {
  canRunOcr: boolean;
  isPending: boolean;
  onRun: (source: OcrSource | undefined) => Promise<void>;
  rowSources: readonly OcrSource[];
  selectedSource: OcrSource | undefined;
}) => {
  const t = useTranslations();
  return (
    <>
      {canRunOcr && (
        <MenuItem
          className="min-h-11 sm:min-h-11"
          disabled={isPending}
          onClick={() => detached(onRun(selectedSource), "row-actions.run-ocr")}
        >
          <ScanTextIcon />
          {t("workspaces.files.runOcr")}
        </MenuItem>
      )}
      {rowSources.length > 0 && (
        <MenuSub>
          <MenuSubTrigger className="min-h-11 sm:min-h-11">
            <ScanTextIcon />
            {t("workspaces.files.runOcr")}
          </MenuSubTrigger>
          <MenuSubPopup>
            {rowSources.map((source) => (
              <MenuItem
                className="min-h-11 sm:min-h-11"
                disabled={isPending}
                key={source.fieldId}
                onClick={() => detached(onRun(source), "row-actions.run-ocr")}
              >
                <ScanTextIcon />
                <BidiText as="span" className="max-w-64 truncate">
                  {source.fileName}
                </BidiText>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      )}
    </>
  );
};

const RowCellMenuActions = ({
  canRetry,
  entityId,
  isBulk,
  metadataTarget,
  onRetry,
  retryDisabled,
  workspaceId,
}: {
  canRetry: boolean;
  entityId: string;
  isBulk: boolean;
  metadataTarget: RowActionsProps["cellMetadataTarget"];
  onRetry: () => Promise<void>;
  retryDisabled: boolean;
  workspaceId: string;
}) => {
  const t = useTranslations();
  if (isBulk || metadataTarget === null || metadataTarget === undefined) {
    return null;
  }
  return (
    <>
      {canRetry && (
        <MenuItem
          disabled={retryDisabled}
          onClick={() => detached(onRetry(), "row-actions.retry-cell")}
        >
          <RefreshCwIcon />
          {t("common.retry")}
        </MenuItem>
      )}
      <CellLockMenuItem
        entityId={entityId}
        metadata={metadataTarget.metadata}
        propertyId={metadataTarget.propertyId}
        workspaceId={workspaceId}
      />
      <MenuSeparator />
      <CellMetadataMenuSection
        entityId={entityId}
        metadata={metadataTarget.metadata}
        propertyId={metadataTarget.propertyId}
        workspaceId={workspaceId}
      />
    </>
  );
};

const RowFolderDesktopMenuActions = ({
  canOpenInDesktop,
  canReleaseDesktopLock,
  entity,
  isBulk,
  isCellContext,
  isFolder,
  onOpenInDesktop,
  onReleaseDesktopLock,
  onSubfolderCreated,
  workspaceId,
}: {
  canOpenInDesktop: boolean;
  canReleaseDesktopLock: boolean;
  entity: WorkspaceEntity;
  isBulk: boolean;
  isCellContext: boolean;
  isFolder: boolean;
  onOpenInDesktop: () => Promise<void>;
  onReleaseDesktopLock: () => Promise<void>;
  onSubfolderCreated: RowActionsProps["onSubfolderCreated"];
  workspaceId: string;
}) => {
  const t = useTranslations();
  if (isCellContext) {
    return null;
  }
  return (
    <>
      {!isBulk && isFolder && onSubfolderCreated !== undefined && (
        <CreateSubfolderMenuItem
          entity={entity}
          onSubfolderCreated={onSubfolderCreated}
          workspaceId={workspaceId}
        />
      )}
      {canOpenInDesktop && (
        <MenuItem
          onClick={() =>
            detached(onOpenInDesktop(), "row-actions.open-in-desktop")
          }
        >
          <LaptopIcon />
          {t("workspaces.files.desktopEdit.action")}
        </MenuItem>
      )}
      {canReleaseDesktopLock && (
        <MenuItem
          onClick={() =>
            detached(onReleaseDesktopLock(), "row-actions.release-lock")
          }
        >
          <LockOpenIcon />
          {t("workspaces.files.desktopEdit.releaseLock")}
        </MenuItem>
      )}
    </>
  );
};

const RowFeatureMenuActions = ({
  canCreateEntity,
  entity,
  file,
  isBulk,
  isFolder,
  onChatAbout,
  onOpenVersionHistory,
  onTranslate,
  translationTarget,
}: {
  canCreateEntity: boolean;
  entity: WorkspaceEntity;
  file: ReturnType<typeof getFirstFile>;
  isBulk: boolean;
  isFolder: boolean;
  onChatAbout: () => void;
  onOpenVersionHistory: (() => void) | undefined;
  onTranslate: () => void;
  translationTarget: TranslationTarget | null;
}) => {
  const t = useTranslations();
  return (
    <>
      {!isBulk &&
        !isFolder &&
        entity.kind !== "task" &&
        file !== null &&
        onOpenVersionHistory !== undefined && (
          <MenuItem onClick={onOpenVersionHistory}>
            <Maximize2Icon />
            {t("workspaces.pdf.fullView")}
          </MenuItem>
        )}
      <MenuItem onClick={onChatAbout}>
        <MessageSquareIcon />
        {t("chat.chatAbout")}
      </MenuItem>
      {translationTarget !== null && (
        <MenuItem disabled={!canCreateEntity} onClick={onTranslate}>
          <LanguagesIcon />
          {t("common.translate")}
        </MenuItem>
      )}
    </>
  );
};

const RowTranslationDialog = ({
  canCreateEntity,
  entity,
  onOpenChange,
  open,
  target,
  workspaceId,
}: {
  canCreateEntity: boolean;
  entity: WorkspaceEntity;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target: TranslationTarget | null;
  workspaceId: string;
}) => {
  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  if (target === null) {
    return null;
  }
  return (
    <TranslateDocumentDialog
      disabled={!canCreateEntity}
      entityId={entity.entityId}
      entityVersionKey={entity.version}
      fieldId={target.fieldId}
      isDocx={target.mimeType === DOCX_MIME}
      mode="controlled"
      onOpenChange={onOpenChange}
      open={open}
      viewId={viewMatch?.params.viewId ?? "all"}
      workspaceId={workspaceId}
    />
  );
};

const RowCellOcrExportMenuActions = ({
  isCellContext,
  onExport,
  sources,
}: {
  isCellContext: boolean;
  onExport: (source: OcrSource, format: OcrExportFormat) => Promise<void>;
  sources: readonly OcrSource[];
}) => {
  const t = useTranslations();
  if (!isCellContext || sources.length !== 1) {
    return null;
  }
  return (
    <>
      <MenuSeparator />
      {sources.map((source) => (
        <OcrExportMenuItems
          key={source.fieldId}
          exportStatus={source.exportStatus}
          onDownload={(format) =>
            detached(onExport(source, format), "row-actions.ocr-export")
          }
          searchablePdfLabel={t("workspaces.files.downloadSearchablePdf")}
          textLabel={t("workspaces.files.downloadExtractedText")}
        />
      ))}
    </>
  );
};

type RowFileOperationsMenuProps = {
  canScrub: boolean;
  exportableOcrSources: readonly OcrSource[];
  hasAnyFile: boolean;
  hasAnyFolder: boolean;
  hasDownloadVariants: boolean;
  hasPdfConversion: boolean;
  isBulk: boolean;
  isCellContext: boolean;
  name: string;
  onCopyToMatter: () => void;
  onDelete: () => void;
  onDownload: (variant?: DownloadVariant) => Promise<void>;
  onDuplicate: () => Promise<void>;
  onOcrExport: (source: OcrSource, format: OcrExportFormat) => Promise<void>;
  onZipDownload: () => Promise<void>;
  selectedCount: number;
};

const RowFileOperationsMenu = ({
  canScrub,
  exportableOcrSources,
  hasAnyFile,
  hasAnyFolder,
  hasDownloadVariants,
  hasPdfConversion,
  isBulk,
  isCellContext,
  name,
  onCopyToMatter,
  onDelete,
  onDownload,
  onDuplicate,
  onOcrExport,
  onZipDownload,
  selectedCount,
}: RowFileOperationsMenuProps) => {
  const t = useTranslations();
  if (isCellContext) {
    return null;
  }
  const renderOcrExport = (source: OcrSource) => (
    <OcrExportMenuItems
      exportStatus={source.exportStatus}
      onDownload={(format) =>
        detached(onOcrExport(source, format), "row-actions.ocr-export")
      }
      searchablePdfLabel={t("workspaces.files.downloadSearchablePdf")}
      textLabel={t("workspaces.files.downloadExtractedText")}
    />
  );
  return (
    <>
      <MenuSeparator />
      {hasAnyFile && (isBulk || !hasDownloadVariants) && (
        <MenuItem
          onClick={() => detached(onDownload(), "row-actions.download")}
        >
          <DownloadIcon />
          {t("common.download")}
        </MenuItem>
      )}
      {hasDownloadVariants && (
        <MenuSub>
          <MenuSubTrigger>
            <DownloadIcon />
            {t("common.download")}
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem
              onClick={() => detached(onDownload(), "row-actions.download")}
            >
              <DownloadIcon />
              {t("workspaces.files.downloadOriginal")}
            </MenuItem>
            {hasPdfConversion && (
              <MenuItem
                onClick={() =>
                  detached(onDownload("pdf"), "row-actions.download")
                }
              >
                <FileOutputIcon />
                {t("workspaces.files.downloadPdf")}
              </MenuItem>
            )}
            {canScrub && (
              <Tooltip
                content={t("workspaces.files.downloadScrubbedHint")}
                render={
                  <MenuItem
                    onClick={() =>
                      detached(onDownload("scrubbed"), "row-actions.download")
                    }
                  >
                    <EraserIcon />
                    {t("workspaces.files.downloadScrubbed")}
                  </MenuItem>
                }
              />
            )}
            {exportableOcrSources.length === 1 &&
              exportableOcrSources.map((source) => (
                <OcrExportMenuItems
                  key={source.fieldId}
                  exportStatus={source.exportStatus}
                  onDownload={(format) =>
                    detached(
                      onOcrExport(source, format),
                      "row-actions.ocr-export",
                    )
                  }
                  searchablePdfLabel={t(
                    "workspaces.files.downloadSearchablePdf",
                  )}
                  textLabel={t("workspaces.files.downloadExtractedText")}
                />
              ))}
            {exportableOcrSources.length > 1 &&
              exportableOcrSources.map((source) => (
                <MenuSub key={source.fieldId}>
                  <MenuSubTrigger>
                    <ScanTextIcon />
                    <BidiText as="span" className="max-w-64 truncate">
                      {source.fileName}
                    </BidiText>
                  </MenuSubTrigger>
                  <MenuSubPopup>{renderOcrExport(source)}</MenuSubPopup>
                </MenuSub>
              ))}
          </MenuSubPopup>
        </MenuSub>
      )}
      {hasAnyFolder && (
        <MenuItem
          onClick={() => detached(onZipDownload(), "row-actions.zip-download")}
        >
          <ArchiveIcon />
          {t("workspaces.files.downloadAsZip")}
        </MenuItem>
      )}
      <MenuItem
        onClick={() => detached(onDuplicate(), "row-actions.duplicate")}
      >
        <CopyIcon />
        {t("common.duplicate")}
      </MenuItem>
      <MenuItem onClick={onCopyToMatter}>
        <FolderSyncIcon />
        {t("workspaces.copyToMatter.menuItem")}
      </MenuItem>
      <MenuSeparator />
      <AlertDialog>
        <AlertDialogTrigger
          render={<MenuItem closeOnClick={false} variant="destructive" />}
        >
          <Trash2Icon />
          {t("common.delete")}
        </AlertDialogTrigger>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isBulk
                ? t("workspaces.deleteItems", { count: selectedCount })
                : t("workspaces.deleteItem")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isBulk
                ? t("workspaces.deleteItemsDescription", {
                    count: selectedCount,
                  })
                : t("common.deleteConfirmDescription", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={<Button onClick={onDelete} variant="destructive" />}
            >
              {t("common.delete")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};

type CreateSubfolderMenuItemProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
  onSubfolderCreated: (entityId: string, parentId: string) => void;
};

const CreateSubfolderMenuItem = ({
  entity,
  workspaceId,
  onSubfolderCreated,
}: CreateSubfolderMenuItemProps) => {
  const t = useTranslations();
  const createEntities = useCreateEntities();
  const isWorkflowRunning = useIsWorkflowRunning(workspaceId);
  const isEntitiesLimitReached = useEntitiesCountLimit(workspaceId);

  if (isEntitiesLimitReached) {
    return null;
  }

  const handleCreateSubfolder = () => {
    createEntities.mutate(
      {
        workspaceId,
        type: "manual-input",
        kind: "folder",
        parentId: entity.entityId,
        name: t("workspaces.newFolder"),
      },
      {
        onSuccess: (data) => {
          stellaToast.add({
            title: t("success.folderCreated"),
            type: "success",
          });
          onSubfolderCreated(data.entityId, entity.entityId);
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <MenuItem
      disabled={isWorkflowRunning || createEntities.isPending}
      onClick={handleCreateSubfolder}
    >
      <FolderPlusIcon />
      {t("workspaces.filesystem.newSubfolder")}
    </MenuItem>
  );
};

// -- Helpers (avoid duplicating logic between single/bulk) --

const toCopyToMatterEntities = (
  targets: readonly (WorkspaceEntity | TableTreeNode)[],
  getAncestorIds?: (entityId: string) => string[],
): CopyToMatterEntity[] => {
  // Filesystem callers pass `getAncestorIds`, a resolver spanning the full
  // entity set (including the ancestor folders a filter/search hid), so the
  // chain stays unbroken across hidden intermediate folders. Other callers fall
  // back to a lookup built from the selection's own parent/child links.
  let resolve = getAncestorIds;
  if (!resolve) {
    const parentById = buildSelectionParentLookup(targets);
    resolve = (entityId: string) => resolveAncestorIds(entityId, parentById);
  }

  return targets.map((entity) => ({
    entityId: entity.entityId,
    entityName: getEntityName(entity),
    kind: entity.kind,
    ancestorIds: resolve(entity.entityId),
  }));
};

type FileRef = { fieldId: string; fileName: string; mimeType: string | null };
type Msg = { downloading: string; failed: string; scrubFailed: string };

const downloadEntityAsZip = async (
  workspaceId: string,
  entity: WorkspaceEntity,
  msg: Msg,
) => {
  const name = getEntityName(entity);
  const toastId = stellaToast.add({
    type: "loading",
    title: msg.downloading,
  });

  const responseResult = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        apiUrl(`/entities/${workspaceId}/zip/${entity.entityId}`),
        {
          credentials: "include",
          timeoutMs: 60_000,
        },
      ),
  );

  if (Result.isError(responseResult)) {
    stellaToast.update(toastId, { title: msg.failed, type: "error" });
    return;
  }

  const response = responseResult.value;

  if (!response.ok) {
    stellaToast.update(toastId, { title: msg.failed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(async () => await response.blob());

  if (Result.isError(blobResult)) {
    stellaToast.update(toastId, { title: msg.failed, type: "error" });
    return;
  }

  stellaToast.close(toastId);
  downloadFile(blobResult.value, `${name}.zip`);
};

const downloadOcrExport = async ({
  workspaceId,
  source,
  format,
  msg,
}: {
  workspaceId: string;
  source: OcrSource;
  format: OcrExportFormat;
  msg: Msg;
}) => {
  const responseResult = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        apiUrl(
          `/files/${encodeURIComponent(workspaceId)}/ocr-export/${encodeURIComponent(source.fieldId)}?format=${format}`,
        ),
        {
          credentials: "include",
          timeoutMs: 60_000,
        },
      ),
  );
  if (Result.isError(responseResult) || !responseResult.value.ok) {
    stellaToast.add({ title: msg.failed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(
    async () => await responseResult.value.blob(),
  );
  if (Result.isError(blobResult)) {
    stellaToast.add({ title: msg.failed, type: "error" });
    return;
  }
  downloadFile(blobResult.value, getOcrExportFileName(source.fileName, format));
};

/**
 * Which copy of the file to hand the user. Not an `asPdf` boolean: the answer
 * is "which rendition", and `scrubbed` is served by the API rather than by a
 * presigned storage URL because the bytes are cleaned per request.
 */
type DownloadVariant = "original" | "pdf" | "scrubbed";

/**
 * Fetched directly rather than through the treaty client: Eden text-decodes
 * every non-JSON body except `application/octet-stream`, which would mangle the
 * DOCX or PDF bytes this endpoint returns.
 */
const downloadScrubbedFile = async (
  workspaceId: string,
  file: FileRef,
  msg: Msg,
) => {
  const responseResult = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        apiUrl(
          `/files/${encodeURIComponent(workspaceId)}/scrubbed/${encodeURIComponent(file.fieldId)}`,
        ),
        { credentials: "include", timeoutMs: 60_000 },
      ),
  );
  if (Result.isError(responseResult) || !responseResult.value.ok) {
    stellaToast.add({ title: msg.scrubFailed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(
    async () => await responseResult.value.blob(),
  );
  if (Result.isError(blobResult)) {
    stellaToast.add({ title: msg.scrubFailed, type: "error" });
    return;
  }

  downloadFile(blobResult.value, file.fileName);
};

const downloadSingleFile = async (
  workspaceId: string,
  file: FileRef,
  variant: DownloadVariant,
  msg: Msg,
) => {
  if (variant === "scrubbed") {
    await downloadScrubbedFile(workspaceId, file, msg);
    return;
  }

  const asPdf = variant === "pdf";
  const response = await api
    .files({ workspaceId })
    .url({ fieldId: file.fieldId })
    .get({ query: { purpose: asPdf ? "display" : "download" } });

  if (response.error) {
    stellaToast.add({ title: msg.failed, type: "error" });
    return;
  }

  const blobResult = await Result.tryPromise(async () => {
    const s3Response = await fetchWithTimeout(response.data.presignedUrl, {
      timeoutMs: 60_000,
    });
    if (!s3Response.ok) {
      throw new ClientOperationError({
        action: "downloadSingleFile",
        message: "Failed to fetch file from storage",
      });
    }
    return await s3Response.blob();
  });

  if (Result.isError(blobResult)) {
    stellaToast.add({ title: msg.failed, type: "error" });
    return;
  }

  const fileName = asPdf
    ? getPdfDownloadFileName(file.fileName)
    : file.fileName;
  downloadFile(blobResult.value, fileName);
};
