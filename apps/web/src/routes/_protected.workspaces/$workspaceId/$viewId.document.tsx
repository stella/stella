import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Navigate,
  createFileRoute,
  stripSearchParams,
} from "@tanstack/react-router";
import { UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import type { DocxEditorRef } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import "@stll/folio/editor.css";
import { cn } from "@stll/ui/lib/utils";

import { TranslateDocumentDialog } from "@/components/translate-document-dialog";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { ClientOperationError, toAPIError } from "@/lib/errors";
import {
  PDFProvider,
  getPDFPageIdByNumber,
  usePDFStore,
} from "@/lib/pdf/pdf-context";
import { toSafeId } from "@/lib/safe-id";
import { composeRefs } from "@/lib/slot";
import { shouldUseDocxBrowserEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor.logic";
import { DocxLoadingShell } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-loading-shell";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-preview-zoom";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import PdfViewer, {
  PDFSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-viewer";
import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  entityVersionsKeys,
  entityVersionsOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";
import "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-docx.css";

const ReadOnlyDocxViewer = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

// Lazy-load DocxBrowserEditor so the @stll/folio editor graph
// (DocxEditor, FormattingBar, prosemirror-tables, yjs, utif2, …)
// stays out of the eager preload list. Without this the static
// import below pulled the whole vendor-folio chunk (~490 KB gz)
// into every page load via the route tree.
const DocxBrowserEditor = lazy(async () => {
  const m =
    await import("@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor");
  return { default: m.DocxBrowserEditor };
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/document",
)({
  component: RouteComponent,
  // v.object: validateSearch receives the full URL search params
  // including params from parent routes; strictObject would reject them.
  validateSearch: v.object({
    entity: v.optional(v.string()),
    field: v.optional(v.string()),
    justification: v.optional(v.string()),
    justificationPage: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1)),
    ),
    pdfPage: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    panel: v.optional(v.picklist(["versions"])),
    editing: v.optional(v.boolean()),
  }),
  search: {
    middlewares: [stripSearchParams({ pdfPage: 1 })],
  },
  pendingComponent: () => <DocxLoadingShell />,
});

const AnonymizeScrollSync = () => {
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const pageId = usePDFStore((s) =>
    getPDFPageIdByNumber({
      fieldId: s.fieldId,
      pages: s.pages,
      pageNumber,
    }),
  );
  const pendingAnonymizeEntityId = useWorkspaceStore(
    (s) => s.pdfViewer.pendingAnonymizeEntityId,
  );
  const setPendingAnonymizeEntityId = useWorkspaceStore(
    (s) => s.setPendingAnonymizeEntityId,
  );

  useEffect(() => {
    if (pendingAnonymizeEntityId === null || pageId === undefined) {
      return;
    }

    setScrollTo({
      pageId,
      target: {
        kind: "anonymizeEntity",
        entityId: pendingAnonymizeEntityId,
      },
    });
    setPendingAnonymizeEntityId(null);
  }, [
    pageId,
    pendingAnonymizeEntityId,
    setPendingAnonymizeEntityId,
    setScrollTo,
  ]);

  return null;
};

/** Scrolls the PDF viewer to the cited page when the route's
 *  `justification`/`justificationPage` search params change. The peek
 *  flow used to drive scroll directly via PeekJustification, but the
 *  full-view route only sets `activeJustification` (which controls
 *  bbox highlighting); without this sync, clicking a metadata row
 *  highlights the bbox but doesn't move the viewer. */
const JustificationScrollSync = () => {
  const justificationId = Route.useSearch({
    select: (s) => s.justification,
  });
  const justificationPage = Route.useSearch({
    select: (s) => s.justificationPage,
  });
  const pageId = usePDFStore((s) =>
    justificationPage === undefined
      ? undefined
      : getPDFPageIdByNumber({
          fieldId: s.fieldId,
          pages: s.pages,
          pageNumber: justificationPage,
        }),
  );
  const setScrollTo = usePDFStore((s) => s.setScrollTo);

  useEffect(() => {
    if (!justificationId || pageId === undefined) {
      return;
    }
    setScrollTo({
      pageId,
      target: { kind: "justification", id: justificationId },
    });
  }, [justificationId, pageId, setScrollTo]);

  return null;
};

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const initialFieldId = Route.useSearch({ select: (s) => s.field });
  const entityId = Route.useSearch({ select: (s) => s.entity });

  // Guard: redirect if required search params are missing (stale URL)
  if (!entityId || !initialFieldId) {
    return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId }} />;
  }

  return (
    <RouteComponentInner
      entityId={entityId}
      initialFieldId={initialFieldId}
      key={initialFieldId}
      workspaceId={workspaceId}
    />
  );
}

function RouteComponentInner({
  workspaceId,
  entityId,
  initialFieldId,
}: {
  workspaceId: string;
  entityId: string;
  initialFieldId: string;
}) {
  const [activeFieldId, setActiveFieldId] = useState(initialFieldId);
  const fieldId = activeFieldId;
  const t = useTranslations();
  useSyncJustifications({ workspaceId, entityIds: [entityId] });
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const justificationId = Route.useSearch({
    select: (s) => s.justification,
  });
  const justificationPage = Route.useSearch({
    select: (s) => s.justificationPage,
  });
  // `editing=true` in the URL means the user landed here from a
  // sidepeek that was already unlocked for editing. Honoring it
  // drops them straight back into the edit session instead of
  // making them click into the doc again.
  const initialEditing = Route.useSearch({
    select: (s) => s.editing ?? false,
  });
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entityId),
  );
  const versionDataQuery = useQuery(
    entityVersionsOptions({ workspaceId, entityId }),
  );
  const versionData = versionDataQuery.data;
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const resetPdfViewerState = useWorkspaceStore((s) => s.resetPdfViewerState);
  const openFileForEntity = useInspectorStore((s) => s.openFileForEntity);
  const currentFileFieldIdsByPropertyRef = useRef(new Map<string, string>());
  const navigate = Route.useNavigate();

  useLayoutEffect(() => {
    if (!justificationId || justificationPage === undefined) {
      setActiveJustification(null);
      return;
    }

    setActiveJustification({
      id: justificationId,
      pageNumber: justificationPage,
    });
  }, [justificationId, justificationPage, setActiveJustification]);

  useEffect(
    () => () => {
      setActiveJustification(null);
      resetPdfViewerState();
    },
    [resetPdfViewerState, setActiveJustification],
  );

  useEffect(
    () => () => {
      const inspectorState = useInspectorStore.getState();
      for (const tab of inspectorState.tabs) {
        if (tab.type !== "pdf" || tab.id !== fieldId) {
          continue;
        }

        if (tab.metadataLane === "expanded" && tab.facet === "suggestions") {
          inspectorState.setFileFacet(fieldId, "metadata");
        }
        break;
      }

      inspectorState.setFileMetadataLane(fieldId, "closed");
    },
    [fieldId],
  );

  // Compare mode state
  const [compareState, setCompareState] = useState<{
    baseVersionLabel: string;
    docxBuffer: ArrayBuffer;
    docxBase64: string;
    editsApplied: number;
    targetVersionLabel: string;
    wordsAdded: number;
    wordsRemoved: number;
    seq: number;
  } | null>(null);
  const [isComparing] = useState(false);
  const [, setDocxUnlocked] = useState(false);
  const [docxLatestVersionDialogOpen, setDocxLatestVersionDialogOpen] =
    useState(false);

  useEffect(() => {
    setDocxUnlocked(false);
  }, [fieldId]);

  // Find the active file field to determine mimeType and propertyId
  const activeFileField = entity.fields.find((f) => {
    if (f.content.type !== "file") {
      return false;
    }
    return f.id === fieldId;
  });
  const activeVersionFile =
    versionData?.versions.find((version) => version.file?.fieldId === fieldId)
      ?.file ?? null;
  const activeFileContent =
    activeFileField?.content.type === "file" ? activeFileField.content : null;
  const activeMimeType =
    activeFileContent?.mimeType ?? activeVersionFile?.mimeType;
  const activePdfFileId = activeFileContent?.pdfFileId ?? null;
  const activeFileLabel =
    activeFileContent?.fileName ?? activeVersionFile?.fileName ?? fieldId;
  const isDocxFile = activeMimeType === DOCX_MIME;
  const usesNativeDocxDisplay = isDocxFile;
  const filePropertyId =
    activeFileField?.propertyId ?? activeVersionFile?.propertyId;
  const useDocxBrowserEditor = shouldUseDocxBrowserEditor({
    isDocxFile,
    hasFilePropertyId: filePropertyId !== undefined,
    isComparing,
  });
  const filePreviewState = (() => {
    if (activeMimeType !== undefined) {
      return "ready";
    }
    if (versionDataQuery.isError) {
      return "error";
    }
    if (versionDataQuery.isPending) {
      return "loading";
    }
    return "missing";
  })();
  const shouldRenderDocxBrowserShell =
    isDocxFile &&
    filePropertyId !== undefined &&
    !isComparing &&
    compareState === null;
  const usesEmbeddedDocxToolbar = shouldRenderDocxBrowserShell;
  const latestFileFieldForProperty =
    filePropertyId !== undefined
      ? entity.fields.findLast(
          (field) =>
            field.propertyId === filePropertyId &&
            field.content.type === "file",
        )
      : undefined;

  useEffect(() => {
    if (activeFileField === undefined) {
      return;
    }

    currentFileFieldIdsByPropertyRef.current.set(
      activeFileField.propertyId,
      activeFileField.id,
    );
  }, [activeFileField]);

  useEffect(() => {
    if (
      latestFileFieldForProperty === undefined ||
      latestFileFieldForProperty.id === fieldId
    ) {
      return;
    }

    const previousCurrentFieldId = currentFileFieldIdsByPropertyRef.current.get(
      latestFileFieldForProperty.propertyId,
    );

    if (previousCurrentFieldId !== fieldId) {
      return;
    }

    currentFileFieldIdsByPropertyRef.current.set(
      latestFileFieldForProperty.propertyId,
      latestFileFieldForProperty.id,
    );
    setActiveFieldId(latestFileFieldForProperty.id);
    useInspectorStore
      .getState()
      .replaceFileFieldId(fieldId, latestFileFieldForProperty.id);
    void navigate({
      replace: true,
      search: (prev) => ({
        ...prev,
        field: latestFileFieldForProperty.id,
        pdfPage: undefined,
      }),
    });
  }, [fieldId, latestFileFieldForProperty, navigate]);

  useEffect(() => {
    if (!filePropertyId || activeMimeType === undefined) {
      return;
    }

    openFileForEntity({
      id: fieldId,
      entityId,
      label: activeFileLabel,
      workspaceId,
      mimeType: activeMimeType,
      pdfFileId: activePdfFileId,
      propertyId: filePropertyId,
      metadataLane: "expanded",
    });
  }, [
    activeFileLabel,
    activeMimeType,
    activePdfFileId,
    entityId,
    fieldId,
    filePropertyId,
    openFileForEntity,
    workspaceId,
  ]);

  return (
    <div className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-hidden border-t">
      <div className="flex h-full w-full min-w-0">
        {/*
         * The version history, metadata, and AI-suggestions surfaces
         * have moved into the right inspector tab as facets — the
         * inspector tab IS the workbench for the open document. The
         * main view here is just the document.
         */}

        {/* Center: DOCX editor, PDF viewer, or redline comparison */}
        <section className="flex h-full min-w-0 flex-1 flex-col">
          {!usesEmbeddedDocxToolbar && (
            <div
              className={cn(
                "bg-background/80 supports-[backdrop-filter]:bg-background/65 flex shrink-0 items-center justify-center gap-2 border-b px-4 backdrop-blur",
                TOOLBAR_ROW_HEIGHT,
              )}
            >
              <PdfViewerControls
                currentPage={pageNumber}
                extraControls={
                  <TranslateDocumentDialog
                    fieldId={fieldId}
                    workspaceId={workspaceId}
                  />
                }
                fieldId={fieldId}
                workspaceId={workspaceId}
              />
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {(() => {
              if (filePreviewState === "error") {
                const error = versionDataQuery.error;
                if (error instanceof Error) {
                  throw error;
                }
                throw new ClientOperationError({
                  action: "load_document_version_metadata",
                  message: "Failed to load document version metadata",
                  cause: error,
                });
              }

              if (filePreviewState === "loading") {
                return <DocxLoadingShell scaleOffset={scaleOffset} />;
              }

              if (filePreviewState === "missing") {
                return (
                  <Navigate
                    params={{ workspaceId }}
                    to="/workspaces/$workspaceId"
                  />
                );
              }

              if (shouldRenderDocxBrowserShell && filePropertyId) {
                return (
                  <VersionDropZone
                    disabled={false}
                    entityId={entityId}
                    workspaceId={workspaceId}
                  >
                    <Suspense
                      fallback={<DocxLoadingShell scaleOffset={scaleOffset} />}
                    >
                      <DocxBrowserEditor
                        actionBarControls={
                          <PdfViewerControls
                            currentPage={pageNumber}
                            extraControls={
                              <TranslateDocumentDialog
                                fieldId={fieldId}
                                workspaceId={workspaceId}
                              />
                            }
                            fieldId={fieldId}
                            variant="inline"
                            workspaceId={workspaceId}
                          />
                        }
                        canUnlock={useDocxBrowserEditor}
                        entityId={entityId}
                        fieldId={fieldId}
                        isEditing={initialEditing}
                        onBlockedUnlock={() => {
                          setDocxLatestVersionDialogOpen(true);
                        }}
                        onClose={() => {
                          setDocxUnlocked(false);
                          void navigate({
                            search: (prev) => ({
                              ...prev,
                              editing: undefined,
                            }),
                          });
                        }}
                        onSaved={(savedFieldId) => {
                          setDocxUnlocked(false);
                          setActiveFieldId(savedFieldId);
                          void navigate({
                            replace: true,
                            search: (prev) => ({
                              ...prev,
                              editing: undefined,
                              field: savedFieldId,
                              pdfPage: undefined,
                            }),
                          });
                        }}
                        onUnlockedChange={setDocxUnlocked}
                        propertyId={filePropertyId}
                        scaleOffset={scaleOffset}
                        workspaceId={workspaceId}
                      />
                    </Suspense>
                  </VersionDropZone>
                );
              }

              if (compareState) {
                return (
                  <VersionDropZone
                    disabled
                    entityId={entityId}
                    workspaceId={workspaceId}
                  >
                    <RedlineOverlay
                      compareState={compareState}
                      scaleOffset={scaleOffset}
                      onClose={() => setCompareState(null)}
                    />
                  </VersionDropZone>
                );
              }

              if (usesNativeDocxDisplay) {
                return (
                  <VersionDropZone
                    disabled={false}
                    entityId={entityId}
                    workspaceId={workspaceId}
                  >
                    <Suspense
                      fallback={<DocxLoadingShell scaleOffset={scaleOffset} />}
                    >
                      <FullscreenDocxViewer
                        fieldId={fieldId}
                        scaleOffset={scaleOffset}
                        workspaceId={workspaceId}
                      />
                    </Suspense>
                  </VersionDropZone>
                );
              }

              return (
                <VersionDropZone
                  disabled={false}
                  entityId={entityId}
                  workspaceId={workspaceId}
                >
                  <PDFProvider
                    key={fieldId}
                    fieldId={fieldId}
                    initialScaleOffset={scaleOffset}
                    startPage={pageNumber}
                    fallback={{ suspense: <PDFSuspenseFallback /> }}
                  >
                    <AnonymizeScrollSync />
                    <JustificationScrollSync />
                    <PdfViewer />
                  </PDFProvider>
                </VersionDropZone>
              );
            })()}
          </div>
        </section>
      </div>
      <Dialog
        onOpenChange={setDocxLatestVersionDialogOpen}
        open={docxLatestVersionDialogOpen}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("fileDetail.editLatestVersionTitle")}</DialogTitle>
            <DialogDescription>
              {t("fileDetail.editLatestVersionDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.close")}
            </DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

// -- Fullscreen DOCX viewer (read-only Folio) --

const FullscreenDocxViewer = ({
  workspaceId,
  fieldId,
  scaleOffset,
}: {
  workspaceId: string;
  fieldId: string;
  scaleOffset: number;
}) => {
  const fileQuery = useQuery({
    ...fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
    placeholderData: keepPreviousData,
  });

  if (fileQuery.error) {
    throw fileQuery.error;
  }

  if (!fileQuery.data) {
    return <DocxLoadingShell scaleOffset={scaleOffset} />;
  }

  return (
    <ReadOnlyDocxDocumentViewer
      documentBuffer={fileQuery.data.buffer}
      mode="viewing"
      scaleOffset={scaleOffset}
    />
  );
};

const ReadOnlyDocxDocumentViewer = ({
  documentBuffer,
  mode,
  scaleOffset,
}: {
  documentBuffer: ArrayBuffer;
  mode: "suggesting" | "viewing";
  scaleOffset: number;
}) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom(
    scaleOffset,
    0.85,
  );
  const composedContainerRef = useMemo(
    () => composeRefs(containerRef, fitZoomRef),
    [fitZoomRef],
  );

  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);

  return (
    <div ref={composedContainerRef} className="h-full overflow-auto">
      <ReadOnlyDocxViewer
        ref={editorRef}
        className="folio-docx-preview h-full"
        autoOpenReviewSidebar={false}
        documentBuffer={documentBuffer}
        initialZoom={targetZoom}
        mode={mode}
        preserveDocumentWhileLoading
        readOnly
        showToolbar={false}
        showZoomControl={false}
      />
    </div>
  );
};

// -- Redline comparison overlay --

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type RedlineOverlayProps = {
  compareState: {
    baseVersionLabel: string;
    docxBuffer: ArrayBuffer;
    docxBase64: string;
    editsApplied: number;
    targetVersionLabel: string;
    wordsAdded: number;
    wordsRemoved: number;
    seq: number;
  };
  onClose: () => void;
  scaleOffset: number;
};

const RedlineOverlay = ({
  compareState,
  onClose,
  scaleOffset,
}: RedlineOverlayProps) => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col">
      <div className="bg-muted/30 flex min-w-0 items-center gap-2 border-b px-4 py-1.5">
        <span className="text-foreground shrink-0 text-sm font-semibold tabular-nums">
          {t("fileDetail.compareVersions", {
            baseVersion: compareState.baseVersionLabel,
            targetVersion: compareState.targetVersionLabel,
          })}
        </span>
        <span className="text-muted-foreground min-w-0 truncate text-xs">
          {t("fileDetail.redlinePreview")}
        </span>
        <span
          className="shrink-0 text-xs font-medium text-green-600 tabular-nums"
          title={`${String(compareState.wordsAdded)} ${t("fileDetail.wordsAdded")}`}
        >
          +{compareState.wordsAdded}
        </span>
        <span
          className="text-destructive shrink-0 text-xs font-medium tabular-nums"
          title={`${String(compareState.wordsRemoved)} ${t("fileDetail.wordsRemoved")}`}
        >
          −{compareState.wordsRemoved}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {t("fileDetail.changesDetected", {
            count: compareState.editsApplied,
          })}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <Button
            onClick={() => {
              downloadBase64AsFile(
                compareState.docxBase64,
                "redline.docx",
                DOCX_MIME,
              );
            }}
            size="xs"
            variant="outline"
          >
            {t("fileDetail.downloadRedline")}
          </Button>
          <Button onClick={onClose} size="xs" variant="ghost">
            {t("common.close")}
          </Button>
        </div>
      </div>
      <div className="bg-muted min-h-0 flex-1 overflow-auto">
        <Suspense fallback={<DocxLoadingShell scaleOffset={scaleOffset} />}>
          <ReadOnlyDocxDocumentViewer
            key={`redline-${String(compareState.seq)}`}
            documentBuffer={compareState.docxBuffer}
            mode="suggesting"
            scaleOffset={scaleOffset}
          />
        </Suspense>
      </div>
    </div>
  );
};

// -- Version drop zone for uploading by drag-and-drop --

const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

type VersionDropZoneProps = React.PropsWithChildren<{
  workspaceId: string;
  entityId: string;
  disabled?: boolean;
}>;

const VersionDropZone = ({
  workspaceId,
  entityId,
  disabled,
  children,
}: VersionDropZoneProps) => {
  const t = useTranslations();
  const dropRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const isUploadingRef = useRef(isUploading);
  isUploadingRef.current = isUploading;

  useEffect(() => {
    const el = dropRef.current;
    if (!el || disabled) {
      return undefined;
    }
    return dropTargetForExternal({
      element: el,
      canDrop: containsFiles,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source }) => {
        setIsDropTarget(false);
        if (isUploadingRef.current) {
          return;
        }
        const files = getFiles({ source });
        const file = files.find((f) => ACCEPTED_MIME_TYPES.has(f.type));
        if (!file) {
          return;
        }
        void (async () => {
          setIsUploading(true);
          try {
            const response = await api
              .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
              ["upload-version"].post({
                entityId: toSafeId<"entity">(entityId),
                file,
                queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
              });
            if (response.error) {
              throw toAPIError(response.error);
            }
            await queryClient.invalidateQueries({
              queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
            });
          } finally {
            setIsUploading(false);
          }
        })();
      },
    });
  }, [disabled, entityId, queryClient, workspaceId]);

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col" ref={dropRef}>
      {children}
      {isDropTarget && (
        <div className="border-foreground/20 bg-foreground/5 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed">
          <div className="text-foreground-subtle flex flex-col items-center gap-2">
            <UploadIcon className="size-8" />
            <span className="text-sm font-medium">
              {t("fileDetail.dropToUploadVersion")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

const downloadBase64AsFile = (
  base64: string,
  fileName: string,
  mimeType: string,
) => {
  const blob = new Blob([decodeBase64ToArrayBuffer(base64)], {
    type: mimeType,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};

const decodeBase64ToArrayBuffer = (base64: string) => {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return buffer;
};
