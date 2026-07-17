import {
  lazy,
  Suspense,
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

import type { DocxEditorRef } from "@stll/folio-react";
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
import "@stll/folio-react/editor.css";
import { cn } from "@stll/ui/lib/utils";

import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import Tooltip from "@/components/tooltip";
import { TranslateDocumentDialog } from "@/components/translate-document-dialog";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { APIError, toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import {
  PDFProvider,
  usePDFStore,
  usePDFStoreApi,
} from "@/lib/pdf/pdf-context";
import { getPDFPageIdByNumber } from "@/lib/pdf/utils";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { composeRefs } from "@/lib/utils";
import { shouldUseDocxBrowserEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor.logic";
import { DocxLoadingShell } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-loading-shell";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import PdfViewer, {
  PDFSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-viewer";
import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { docxSuggestionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/docx-suggestions";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  entityVersionsKeys,
  entityVersionsOptions,
  fieldFileOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";
import "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-docx.css";

const ReadOnlyDocxViewer = lazy(async () => {
  const m = await import("@/components/docx/app-docx-editor");
  return { default: m.DocxEditor };
});

// Lazy-load DocxBrowserEditor so the @stll/folio-react editor graph
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
  // The entity query is keyed on the `entity` search param, so the loader must
  // re-run when it changes; `field` gates whether the detail view mounts at all.
  loaderDeps: ({ search }) => ({ entity: search.entity, field: search.field }),
  loader: async ({ context, params, deps }) => {
    // Mirror the component guard: the entity query only runs when both `entity`
    // and `field` are present (otherwise the route redirects without mounting
    // the detail view). Prime it so the fetch starts during navigation instead
    // of after the component mounts and suspends.
    if (!deps.entity || !deps.field) {
      return;
    }

    const entity = await ensureRouteQueryData(
      context.queryClient,
      entityOptions(params.workspaceId, deps.entity),
    );

    // useSyncJustifications mounts with entityIds=[deps.entity] as soon as the
    // component renders; warm the same query so it's a cache hit. The hook
    // normalizes entityIds (dedupe + sort) before building the key, but for a
    // single-element array that's a no-op, so the key matches exactly.
    void prefetchRouteQuery(
      context.queryClient,
      justificationsOptions({
        workspaceId: params.workspaceId,
        entityIds: [deps.entity],
      }),
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    );

    // `field` is the fieldId FullscreenPdfViewer eventually reads via
    // usePDFStore, but on a cold navigation that store is only just created
    // (PDFProvider seeds it from this same search param, see `key={fieldId}`
    // below), so the value is already known here. Only PDF-family fields
    // render through PdfViewer/fileOptions; docx fields take an entirely
    // different display path (DocxBrowserEditor/fieldFileOptions) that never
    // reads fileOptions, so gate the prefetch on the resolved mimeType to
    // avoid downloading a file buffer the component will never use.
    const field = entity.fields.find((f) => f.id === deps.field);

    // The DOCX editor hydrates its review store from persisted AI suggestions
    // on open (useSyncDocxSuggestions runs a useQuery on this same key). Warm
    // it here so the request starts during navigation — loader-consistent with
    // the entity/justifications prefetch above and no extra waterfall level —
    // instead of firing on the editor's mount. DOCX fields only; other field
    // types never mount the review surface.
    const isDocxField =
      field?.content.type === "file" && field.content.mimeType === DOCX_MIME;
    if (isDocxField) {
      void prefetchRouteQuery(
        context.queryClient,
        docxSuggestionsOptions({
          workspaceId: params.workspaceId,
          entityId: deps.entity,
        }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      );
    }

    const rendersInPdfViewer =
      field?.content.type === "file" && field.content.mimeType !== DOCX_MIME;
    if (rendersInPdfViewer) {
      // Warm the file query without blocking route commit: a large PDF
      // download shouldn't hold the user on the pendingComponent. The
      // component's useSuspenseQuery scopes the wait to the PDF area.
      void prefetchRouteQuery(
        context.queryClient,
        fileOptions({ workspaceId: params.workspaceId, fieldId: deps.field }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      );
    }
  },
  pendingComponent: () => <DocxLoadingShell />,
});

const AnonymizeScrollSync = () => {
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const pdfStore = usePDFStoreApi();
  useExternalSyncEffect(() => {
    const applyPendingScroll = () => {
      const pdfState = pdfStore.getState();
      const workspaceState = useWorkspaceStore.getState();
      const pageId = getPDFPageIdByNumber({
        fieldId: pdfState.fieldId,
        pages: pdfState.pages,
        pageNumber,
      });
      const pendingAnonymizeEntityId =
        workspaceState.pdfViewer.pendingAnonymizeEntityId;
      if (pendingAnonymizeEntityId === null || pageId === undefined) {
        return;
      }

      // Claim the one-shot request before writing the PDF store. Zustand
      // subscriptions run synchronously; writing `scrollTo` first would
      // re-enter this callback while the request was still pending.
      workspaceState.setPendingAnonymizeEntityId(null);
      pdfState.setScrollTo({
        pageId,
        target: {
          kind: "anonymizeEntity",
          entityId: pendingAnonymizeEntityId,
        },
      });
    };

    applyPendingScroll();
    const unsubscribePdf = pdfStore.subscribe(applyPendingScroll);
    const unsubscribeWorkspace =
      useWorkspaceStore.subscribe(applyPendingScroll);
    return () => {
      unsubscribePdf();
      unsubscribeWorkspace();
    };
  }, [pageNumber, pdfStore]);

  return null;
};

const InspectorFieldLifecycle = ({ fieldId }: { fieldId: string }) => {
  useMountEffect(() => () => {
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
  });

  return null;
};

type InspectorFileOpenLifecycleProps = {
  entityId: string;
  fieldId: string;
  fileLabel: string;
  mimeType: string;
  pdfFileId: string | null;
  propertyId: string;
  workspaceId: string;
};

const InspectorFileOpenLifecycle = ({
  entityId,
  fieldId,
  fileLabel,
  mimeType,
  pdfFileId,
  propertyId,
  workspaceId,
}: InspectorFileOpenLifecycleProps) => {
  const openFileForEntity = useInspectorStore((s) => s.openFileForEntity);
  useMountEffect(() => {
    openFileForEntity({
      id: fieldId,
      entityId,
      label: fileLabel,
      fileName: fileLabel,
      workspaceId,
      mimeType,
      pdfFileId,
      propertyId,
      metadataLane: "expanded",
    });
  });

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

  useExternalSyncEffect(() => {
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
  const currentFileFieldIdsByPropertyRef = useRef<Map<string, string> | null>(
    null,
  );
  currentFileFieldIdsByPropertyRef.current ??= new Map();
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

  useMountEffect(() => () => {
    setActiveJustification(null);
    resetPdfViewerState();
  });

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

  // Reset the docx-unlocked flag when fieldId changes, using React's
  // adjust-state-during-render pattern instead of a reset effect. setDocxUnlocked
  // is also called from editor handlers (onClose/onSaved/onUnlockedChange), so it
  // is not pure derived state; tracking the previous fieldId resets only on a
  // real change without remounting unrelated state.
  const [prevFieldId, setPrevFieldId] = useState(fieldId);
  if (fieldId !== prevFieldId) {
    setPrevFieldId(fieldId);
    setDocxUnlocked(false);
  }

  // Find the active file field to determine mimeType and propertyId
  const activeFileField = entity.fields.find((f) => {
    if (f.content.type !== "file") {
      return false;
    }
    return f.id === fieldId;
  });

  // Track the field currently shown for each property so the
  // version-switch effect below can tell whether the user is still on
  // the previously-current field (auto-advance) or has navigated to an
  // older version (leave alone). Ref-assign during render is the
  // sanctioned latest-value pattern; the write is idempotent.
  if (activeFileField !== undefined) {
    /* eslint-disable react/react-compiler -- sanctioned latest-value ref mirror: idempotent write consumed only by the version-switch effect below, never during render */
    currentFileFieldIdsByPropertyRef.current.set(
      activeFileField.propertyId,
      activeFileField.id,
    );
    /* eslint-enable react/react-compiler */
  }
  const activeVersionFile =
    versionData?.versions.find((version) => version.file?.fieldId === fieldId)
      ?.file ?? null;
  // The active field can belong to an older version outside the newest
  // version-history page (switch to an old version, then reload). When it is
  // neither the current version nor in the loaded page, resolve its file
  // metadata directly so the viewer renders it instead of showing "missing".
  const needsFieldFileLookup =
    activeFileField === undefined &&
    activeVersionFile === null &&
    versionDataQuery.isSuccess;
  const fieldFileQuery = useQuery({
    ...fieldFileOptions({ workspaceId, entityId, fieldId }),
    enabled: needsFieldFileLookup,
  });
  const resolvedVersionFile =
    activeVersionFile ?? fieldFileQuery.data?.file ?? null;
  const activeFileContent =
    activeFileField?.content.type === "file" ? activeFileField.content : null;
  const activeMimeType =
    activeFileContent?.mimeType ?? resolvedVersionFile?.mimeType;
  const activePdfFileId = activeFileContent?.pdfFileId ?? null;
  const activeFileLabel =
    activeFileContent?.fileName ?? resolvedVersionFile?.fileName ?? fieldId;
  const isDocxFile = activeMimeType === DOCX_MIME;
  const usesNativeDocxDisplay = isDocxFile;
  const filePropertyId =
    activeFileField?.propertyId ?? resolvedVersionFile?.propertyId;
  const useDocxBrowserEditor = shouldUseDocxBrowserEditor({
    isDocxFile,
    hasFilePropertyId: filePropertyId !== undefined,
    isComparing,
  });
  // A 404 from the field-file lookup means a stale/deleted/foreign field id;
  // fall through to "missing" (recover by navigating back to the matter)
  // rather than the error boundary. Only real failures (network/5xx) are fatal.
  const fieldFileFatalError =
    fieldFileQuery.isError &&
    !(APIError.is(fieldFileQuery.error) && fieldFileQuery.error.status === 404);
  const filePreviewState = (() => {
    if (activeMimeType !== undefined) {
      return "ready";
    }
    if (versionDataQuery.isError || fieldFileFatalError) {
      return "error";
    }
    if (
      versionDataQuery.isPending ||
      (needsFieldFileLookup && fieldFileQuery.isPending)
    ) {
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

  useExternalSyncEffect(() => {
    if (
      latestFileFieldForProperty === undefined ||
      latestFileFieldForProperty.id === fieldId
    ) {
      return;
    }

    // Narrowing from the render-scope `??=` does not survive into this
    // closure, so re-establish non-null locally.
    const currentFieldIds = currentFileFieldIdsByPropertyRef.current;
    if (currentFieldIds === null) {
      return;
    }
    const previousCurrentFieldId = currentFieldIds.get(
      latestFileFieldForProperty.propertyId,
    );

    if (previousCurrentFieldId !== fieldId) {
      return;
    }

    currentFieldIds.set(
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

  return (
    <div className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-hidden border-t">
      <InspectorFieldLifecycle fieldId={fieldId} key={fieldId} />
      {filePropertyId && activeMimeType !== undefined && (
        <InspectorFileOpenLifecycle
          entityId={entityId}
          fieldId={fieldId}
          fileLabel={activeFileLabel}
          key={`${fieldId}:${filePropertyId}:${activeMimeType}:${activePdfFileId}:${activeFileLabel}`}
          mimeType={activeMimeType}
          pdfFileId={activePdfFileId}
          propertyId={filePropertyId}
          workspaceId={workspaceId}
        />
      )}
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
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom({
    scaleOffset,
    maxAutoZoom: 0.85,
  });
  // Stable ref callback so React doesn't detach/re-attach the fit-zoom
  // ResizeObserver every render.
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
        <Tooltip
          content={`${String(compareState.wordsAdded)} ${t("fileDetail.wordsAdded")}`}
          render={
            <span className="text-success shrink-0 text-xs font-medium tabular-nums" />
          }
        >
          +{compareState.wordsAdded}
        </Tooltip>
        <Tooltip
          content={`${String(compareState.wordsRemoved)} ${t("fileDetail.wordsRemoved")}`}
          render={
            <span className="text-destructive shrink-0 text-xs font-medium tabular-nums" />
          }
        >
          −{compareState.wordsRemoved}
        </Tooltip>
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

const ACCEPTED_MIME_TYPES = {
  "application/pdf": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/msword": true,
} as const;

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

  const canStartUpload = useLatestCallback(() => !isUploading);

  useExternalSyncEffect(() => {
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
        if (!canStartUpload()) {
          return;
        }
        const files = getFiles({ source });
        const file = files.find((f) =>
          Object.hasOwn(ACCEPTED_MIME_TYPES, f.type),
        );
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
  }, [disabled, entityId, queryClient, workspaceId, canStartUpload]);

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
