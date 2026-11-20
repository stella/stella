import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external";
import { containsFiles } from "@atlaskit/pragmatic-drag-and-drop/utils/contains-files";
import { getFiles } from "@atlaskit/pragmatic-drag-and-drop/utils/get-files";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi, Navigate, useRouter } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { UploadIcon } from "@stll/ui/icons";
import { composeRefs } from "@stll/ui/utils";
import "@stll/folio-react/editor.css";

import { openEntityInInspector } from "@/components/chat/entity-open";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { shouldUseDocxBrowserEditor } from "@/components/docx/docx-browser-editor.logic";
import { DocxEditorActionBar } from "@/components/docx/docx-editor-action-bar";
import { DocxEditorSlot } from "@/components/docx/docx-editor-host";
import { DOCX_EDITOR_SLOT } from "@/components/docx/docx-editor-host.logic";
import type { DocxEditorSlotBindings } from "@/components/docx/docx-editor-host.logic";
import { DocxLoadingShell } from "@/components/docx/docx-loading-shell";
import type { DocxBrowserEditorActions } from "@/components/docx/use-docx-browser-editor-actions";
import { DOCUMENT_PANE } from "@/components/inspector/document-pane";
import type { DocumentPane } from "@/components/inspector/document-pane";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import {
  getEntityFileDownloadRenditions,
  getPrimaryDownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import type { FileFacet } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  PdfSignRequiredDialog,
  usePdfSignFlow,
} from "@/components/inspector/pdf-sign-action";
import { resolvePdfSignTarget } from "@/components/inspector/pdf-signing.logic";
import { PlaybookFacet } from "@/components/inspector/playbook-facet";
import PdfViewer, { PDFSuspenseFallback } from "@/components/pdf/pdf-viewer";
import { PdfLoadingShell } from "@/components/pdf/pdf-viewer.pending";
import { DefaultErrorComponent } from "@/components/route-components";
import { RouteDocumentTitle } from "@/components/route-document-title";
import { TranslateDocumentDialog } from "@/components/translate-document-dialog";
import { RecoverableViewerBoundary } from "@/components/viewer/recoverable-viewer-boundary";
import { useSyncJustifications } from "@/components/workspaces/hooks/use-sync-justifications";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { getAnalytics } from "@/lib/analytics/provider";
import {
  DOCX_MIME,
  getNativeOfficeViewerFormat,
  PDF_MIME,
  PPTX_MIME,
  XLSX_MIME,
} from "@/lib/consts";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { notifyUserError } from "@/lib/errors/user-toast";
import { fileOptions } from "@/lib/files/queries";
import {
  ENTITY_VERSION_UPLOAD_RESULT,
  uploadEntityVersion,
} from "@/lib/files/upload-entity-version";
import {
  PDFProvider,
  usePDFStore,
  usePDFStoreApi,
} from "@/lib/pdf/pdf-context";
import { getPDFPageIdByNumber } from "@/lib/pdf/utils";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import {
  entityVersionsKeys,
  entityVersionsOptions,
  fieldFileOptions,
} from "@/lib/workspaces/queries/entity-versions";
import "@/components/pdf/peek/peek-docx.css";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";

import {
  DOCUMENT_DROP_ZONE_CLASS,
  DOCUMENT_SHEET_SLOT_CLASS,
  DocumentPageFrame,
  DocumentToolbarRow,
} from "./-$viewId.document.pending";

const routeApi = getRouteApi(
  "/_protected/workspaces/$workspaceId/$viewId/document",
);

const ReadOnlyDocxViewer = lazy(async () => {
  const m = await import("@/components/docx/app-docx-editor");
  return { default: m.DocxEditor };
});

const OfficeFileViewer = lazy(async () => {
  const m = await import("@/components/office/office-file-viewer");
  return { default: m.OfficeFileViewer };
});

const PDFPageOrganizer = lazy(async () => {
  const m = await import("@/components/pdf/page-organizer");
  return { default: m.PDFPageOrganizer };
});

const AnonymizeScrollSync = () => {
  const pageNumber = routeApi.useSearch({ select: (s) => s.pdfPage ?? 1 });
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
    useInspectorTabsStore.getState().setFileMetadataLane(fieldId, "closed");
  });

  return null;
};

/**
 * Which facet the document's inspector tab opens on, per arrangement. Total
 * over the pane vocabulary so a new arrangement cannot leave the inspector on
 * whatever the previous one happened to open; `undefined` is the tab's own
 * default, which the unswapped arrangement keeps.
 */
const INSPECTOR_FACET_BY_PANE = {
  document: undefined,
  review: "preview",
  margin: "playbook",
} as const satisfies Record<DocumentPane, FileFacet | undefined>;

type InspectorFileOpenLifecycleProps = {
  entityId: string;
  fieldId: string;
  fileLabel: string;
  mimeType: string;
  pdfFileId: string | null;
  propertyId: string;
  workspaceId: string;
  /** Which facet the tab should open on; the tab's own default otherwise. */
  facet?: FileFacet | undefined;
};

const InspectorFileOpenLifecycle = ({
  entityId,
  facet,
  fieldId,
  fileLabel,
  mimeType,
  pdfFileId,
  propertyId,
  workspaceId,
}: InspectorFileOpenLifecycleProps) => {
  const openFileForEntity = useInspectorTabsStore((s) => s.openFileForEntity);
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
      ...(facet === undefined ? {} : { facet }),
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
  const justificationId = routeApi.useSearch({
    select: (s) => s.justification,
  });
  const justificationPage = routeApi.useSearch({
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

export function DocumentPage() {
  const { viewId, workspaceId } = routeApi.useParams({
    select: (p) => ({ viewId: p.viewId, workspaceId: p.workspaceId }),
  });
  const initialFieldId = routeApi.useSearch({ select: (s) => s.field });
  const entityId = routeApi.useSearch({ select: (s) => s.entity });

  // Guard: redirect if required search params are missing (stale URL)
  if (!entityId || !initialFieldId) {
    return <Navigate to="/workspaces/$workspaceId" params={{ workspaceId }} />;
  }

  return (
    <DocumentRoute
      entityId={entityId}
      initialFieldId={initialFieldId}
      viewId={viewId}
      workspaceId={workspaceId}
    />
  );
}

function DocumentRoute({
  entityId,
  initialFieldId,
  viewId,
  workspaceId,
}: {
  entityId: string;
  initialFieldId: string;
  viewId: string;
  workspaceId: string;
}) {
  const editorPdfSignFlow = usePdfSignFlow({
    entityId,
    fieldId: initialFieldId,
    workspaceId,
  });

  return (
    <RouteComponentInner
      editorPdfSignFlow={editorPdfSignFlow}
      entityId={entityId}
      initialFieldId={initialFieldId}
      key={initialFieldId}
      viewId={viewId}
      workspaceId={workspaceId}
    />
  );
}

function RouteComponentInner({
  editorPdfSignFlow,
  workspaceId,
  viewId,
  entityId,
  initialFieldId,
}: {
  editorPdfSignFlow: ReturnType<typeof usePdfSignFlow>;
  workspaceId: string;
  viewId: string;
  entityId: string;
  initialFieldId: string;
}) {
  const [activeFieldId, setActiveFieldId] = useState(initialFieldId);
  const fieldId = activeFieldId;
  const t = useTranslations();
  const canUpdateEntity = usePermissions({ entity: ["update"] });
  const canCreateEntity = usePermissions({ entity: ["create"] });
  useSyncJustifications({ workspaceId, entityIds: [entityId] });
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const docxLoadingFallback = useMemo(
    () => <DocxLoadingShell scaleOffset={scaleOffset} />,
    [scaleOffset],
  );
  const justificationId = routeApi.useSearch({
    select: (s) => s.justification,
  });
  const justificationPage = routeApi.useSearch({
    select: (s) => s.justificationPage,
  });
  // `editing=true` in the URL means the user landed here from a
  // sidepeek that was already unlocked for editing. Honoring it
  // drops them straight back into the edit session instead of
  // making them click into the doc again.
  const initialEditing = routeApi.useSearch({
    select: (s) => s.editing ?? false,
  });
  const pageNumber = routeApi.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const pdfMode = routeApi.useSearch({ select: (s) => s.pdfMode });
  const initialBlockId = routeApi.useSearch({ select: (s) => s.block });
  const pane = routeApi.useSearch({
    select: (s) => s.pane ?? DOCUMENT_PANE.document,
  });
  const requestBlockScroll = useInspectorCommandStore(
    (s) => s.requestBlockScroll,
  );
  // A `block` deep link scrolls the DOCX editor once it mounts; the editor's
  // block-scroll hook retries until the block resolves and then clears it.
  useMountEffect(() => {
    if (initialBlockId) {
      requestBlockScroll({ tabId: initialFieldId, blockId: initialBlockId });
    }
  });
  const { data: entity, error: entityError } = useSuspenseQuery(
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
  const navigate = routeApi.useNavigate();

  const documentTitle = entity.name || t("tasks.untitled");

  useExternalSyncEffect(() => {
    if (!(APIError.is(entityError) && entityError.status === 404)) {
      return;
    }

    detached(
      navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId },
        replace: true,
      }),
      "document.navigate",
    );
  }, [entityError, navigate, workspaceId]);

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

  const [docxUnlocked, setDocxUnlocked] = useState(false);
  const docxActionsRef = useRef<DocxBrowserEditorActions | null>(null);
  const isLeavingDocxRef = useRef(false);
  const leaveDocxBeforeNavigation = useLatestCallback(async () => {
    if (!docxUnlocked) {
      return false;
    }

    const actions = docxActionsRef.current;
    if (!actions) {
      return true;
    }

    isLeavingDocxRef.current = true;
    const leaveResult = await Result.tryPromise(actions.leave);
    isLeavingDocxRef.current = false;
    if (Result.isError(leaveResult)) {
      getAnalytics().captureError(leaveResult.error, {
        fingerprintKey: "RouteComponentInner:failure",
        scope: { type: "handler", handlerId: "RouteComponentInner:failure" },
      });
      return true;
    }
    return !leaveResult.value;
  });
  useUnsavedWork({
    surface: "document-docx-editor",
    guard: "decide-navigation",
    isDirty: docxUnlocked,
    shouldBlockNavigation: leaveDocxBeforeNavigation,
  });
  const [docxLatestVersionDialogOpen, setDocxLatestVersionDialogOpen] =
    useState(false);

  // What the hosted editor tells this pane. Stable for the route's lifetime:
  // the registry rewrites a claim only when something in it actually changed,
  // and a claim rewritten every render would churn the host on every keystroke.
  const handleDocxBlockedUnlock = useLatestCallback(() => {
    setDocxLatestVersionDialogOpen(true);
  });
  const handleDocxClose = useLatestCallback(() => {
    setDocxUnlocked(false);
    if (isLeavingDocxRef.current) {
      return;
    }
    detached(
      navigate({ search: (prev) => ({ ...prev, editing: undefined }) }),
      "document.navigate",
    );
  });
  const handleDocxSaved = useLatestCallback((savedFieldId: string) => {
    setDocxUnlocked(false);
    setActiveFieldId(savedFieldId);
    if (isLeavingDocxRef.current) {
      return;
    }
    detached(
      navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          editing: undefined,
          field: savedFieldId,
          pdfPage: undefined,
        }),
      }),
      "document.navigate",
    );
  });
  const docxEditorBindings = useMemo(
    () =>
      ({
        actionsRef: docxActionsRef,
        onBlockedUnlock: handleDocxBlockedUnlock,
        onClose: handleDocxClose,
        onSaved: handleDocxSaved,
        onUnlockedChange: setDocxUnlocked,
      }) satisfies DocxEditorSlotBindings,
    [handleDocxBlockedUnlock, handleDocxClose, handleDocxSaved],
  );
  const setIsPDFPageOrganizerOpen = (open: boolean) => {
    detached(
      navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          pdfMode: open ? "organize" : undefined,
        }),
      }),
      "document.navigate",
    );
  };

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
    /* oxlint-disable react/refs -- sanctioned latest-value ref mirror: idempotent write consumed only by the version-switch effect below, never during render */
    currentFileFieldIdsByPropertyRef.current.set(
      activeFileField.propertyId,
      activeFileField.id,
    );
    /* oxlint-enable react/refs */
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
  const fieldFileQuery = useQuery(
    fieldFileOptions({
      workspaceId,
      entityId,
      fieldId,
      enabled: needsFieldFileLookup,
    }),
  );
  const resolvedVersionFile =
    activeVersionFile ?? fieldFileQuery.data?.file ?? null;
  const activeFileContent =
    activeFileField?.content.type === "file" ? activeFileField.content : null;
  const activeFile = activeFileContent ?? resolvedVersionFile;
  const activeMimeType = activeFile?.mimeType;
  const isPDFPageOrganizerOpen =
    pdfMode === "organize" && activeMimeType === PDF_MIME;
  const activePdfFileId = activeFileContent?.pdfFileId ?? null;
  const activeFileLabel = activeFile?.fileName ?? fieldId;
  const isDocxFile = activeMimeType === DOCX_MIME;
  // Signing from the page editor outlives it: saving first replaces the
  // version, which remounts the editor, and the signing must go on.
  const pdfSignTarget = resolvePdfSignTarget({
    canUpdateEntity,
    entityId,
    file:
      activeFileContent === null
        ? null
        : {
            fieldId,
            mimeType: activeFileContent.mimeType,
            propertyId: activeFileField?.propertyId,
          },
    // `entity.fields` holds the current version only; an older version
    // arrives through the field-file lookup instead.
    isCurrentVersion: activeFileField !== undefined,
    workspaceId,
  });
  const downloadRenditions = getEntityFileDownloadRenditions({
    entityData: entity,
    fieldId,
  });
  const downloadActiveFile = () => {
    detached(
      downloadTabFile({
        fieldId,
        fileName: activeFileLabel,
        variant: getPrimaryDownloadVariant(downloadRenditions),
        workspaceId,
        onError: (message, error) => {
          notifyUserError(error, message);
        },
      }),
      "document.viewer-download",
    );
  };
  // The panes have traded places: the findings get this column's full width
  // and the document moves to the inspector's preview. Only a DOCX has a
  // review to show, so anything else reads as the default arrangement.
  const showsReviewPane = pane === DOCUMENT_PANE.review && isDocxFile;
  // Which facet the document's inspector tab opens on in each arrangement:
  // the document itself exactly when this column is not showing it, and the
  // review otherwise. `undefined` leaves the tab's own default alone, which is
  // what a file with no review to show wants.
  const inspectorFacet = isDocxFile ? INSPECTOR_FACET_BY_PANE[pane] : undefined;
  const usesNativeDocxDisplay = isDocxFile;
  const officeViewerFormat = getNativeOfficeViewerFormat(activeMimeType);
  const filePropertyId =
    activeFileField?.propertyId ?? resolvedVersionFile?.propertyId;
  const useDocxBrowserEditor = shouldUseDocxBrowserEditor({
    isDocxFile,
    hasFilePropertyId: filePropertyId !== undefined,
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
    isDocxFile && filePropertyId !== undefined;
  const usesEmbeddedDocumentToolbar =
    shouldRenderDocxBrowserShell || officeViewerFormat !== null;
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
      isPDFPageOrganizerOpen ||
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
    useInspectorTabsStore
      .getState()
      .replaceFileFieldId(fieldId, latestFileFieldForProperty.id);
    detached(
      navigate({
        replace: true,
        search: (prev) => ({
          ...prev,
          field: latestFileFieldForProperty.id,
          pdfPage: undefined,
        }),
      }),
      "document.navigate",
    );
  }, [fieldId, isPDFPageOrganizerOpen, latestFileFieldForProperty, navigate]);

  return (
    <DocumentPageFrame
      aside={
        <>
          <RouteDocumentTitle routeId={routeApi.id} title={documentTitle} />
          <InspectorFieldLifecycle fieldId={fieldId} key={fieldId} />
          {pdfSignTarget !== null && (
            <PdfSignRequiredDialog flow={editorPdfSignFlow} />
          )}
          {filePropertyId && activeMimeType !== undefined && (
            <InspectorFileOpenLifecycle
              entityId={entityId}
              // In the swapped arrangement the inspector is where the document is
              // read, so the tab opens on its preview rather than its metadata; in
              // the margin arrangement it is where the findings are.
              facet={inspectorFacet}
              fieldId={fieldId}
              fileLabel={activeFileLabel}
              // No `pane` here: the arrangement decides which slot reads the
              // document, never which document is open, and keying on it
              // reopened the inspector tab (a fresh `renderId`) on every swap.
              key={`${fieldId}:${filePropertyId}:${activeMimeType}:${activePdfFileId ?? "no-pdf"}:${activeFileLabel}`}
              mimeType={activeMimeType}
              pdfFileId={activePdfFileId}
              propertyId={filePropertyId}
              workspaceId={workspaceId}
            />
          )}
          <Dialog
            onOpenChange={setDocxLatestVersionDialogOpen}
            open={docxLatestVersionDialogOpen}
          >
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>
                  {t("fileDetail.editLatestVersionTitle")}
                </DialogTitle>
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
        </>
      }
    >
      {/*
       * The version history, metadata, and AI-suggestions surfaces
       * have moved into the right inspector tab as facets — the
       * inspector tab IS the workbench for the open document. The
       * main view here is just the document.
       */}

      {/* Center: DOCX editor, PDF viewer, or redline comparison */}
      {!usesEmbeddedDocumentToolbar &&
        !showsReviewPane &&
        !isPDFPageOrganizerOpen && (
          <DocumentToolbarRow>
            <PdfViewerControls
              currentPage={pageNumber}
              downloadRenditions={downloadRenditions}
              extraControls={
                <TranslateDocumentDialog
                  disabled={!canCreateEntity}
                  entityId={entityId}
                  entityVersionKey={entity.currentVersionId}
                  fieldId={fieldId}
                  isDocx={isDocxFile}
                  viewId={viewId}
                  workspaceId={workspaceId}
                />
              }
              fieldId={fieldId}
              file={activeFile}
              onEditPages={
                activeMimeType === PDF_MIME
                  ? () => setIsPDFPageOrganizerOpen(true)
                  : undefined
              }
              pdfSignTarget={pdfSignTarget}
              workspaceId={workspaceId}
            />
          </DocumentToolbarRow>
        )}
      <div className={DOCUMENT_SHEET_SLOT_CLASS}>
        {(() => {
          if (showsReviewPane) {
            return (
              <PlaybookFacet
                entityId={entityId}
                fileFieldId={fieldId}
                workspaceId={workspaceId}
              />
            );
          }

          if (filePreviewState === "error") {
            // The read that failed: the version list, or the direct lookup of
            // a field outside it.
            const failedQuery = versionDataQuery.isError
              ? versionDataQuery
              : fieldFileQuery;
            const error = failedQuery.error;
            return (
              <DefaultErrorComponent
                error={
                  error instanceof Error
                    ? error
                    : new ClientOperationError({
                        action: "load_document_version_metadata",
                        message: "Failed to load document version metadata",
                        cause: error,
                      })
                }
                reset={() => {
                  detached(
                    failedQuery.refetch(),
                    "document.version-metadata-retry",
                  );
                }}
              />
            );
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
            const docxDocument = {
              entityId,
              fileFieldId: fieldId,
              propertyId: filePropertyId,
              workspaceId,
            };
            return (
              <VersionDropZone
                disabled={false}
                entityId={entityId}
                workspaceId={workspaceId}
              >
                <DocxEditorSlot
                  bindings={docxEditorBindings}
                  canUnlock={canUpdateEntity && useDocxBrowserEditor}
                  document={docxDocument}
                  fallback={docxLoadingFallback}
                  isEditing={initialEditing}
                  scaleOffset={scaleOffset}
                  slot={DOCX_EDITOR_SLOT.main}
                />
                {/* The toolbar's controls read route state, so they stay
                        in this subtree and are published into the hosted
                        editor's action bar. */}
                <DocxEditorActionBar document={docxDocument}>
                  <PdfViewerControls
                    currentPage={pageNumber}
                    downloadRenditions={downloadRenditions}
                    extraControls={
                      <TranslateDocumentDialog
                        disabled={!canCreateEntity}
                        entityId={entityId}
                        entityVersionKey={entity.currentVersionId}
                        fieldId={fieldId}
                        isDocx
                        viewId={viewId}
                        workspaceId={workspaceId}
                      />
                    }
                    fieldId={fieldId}
                    file={activeFile}
                    variant="inline"
                    workspaceId={workspaceId}
                  />
                </DocxEditorActionBar>
              </VersionDropZone>
            );
          }

          if (officeViewerFormat !== null) {
            return (
              <VersionDropZone
                disabled={false}
                entityId={entityId}
                workspaceId={workspaceId}
              >
                <RecoverableViewerBoundary
                  key={fieldId}
                  onDownload={downloadActiveFile}
                  pending={<DocxLoadingShell />}
                  surface="document-office"
                >
                  <Suspense fallback={<DocxLoadingShell />}>
                    <OfficeFileViewer
                      desktopEditTarget={
                        canUpdateEntity &&
                        filePropertyId !== undefined &&
                        activeFileField !== undefined
                          ? {
                              fileType: officeViewerFormat,
                              propertyId: filePropertyId,
                            }
                          : null
                      }
                      entityId={entityId}
                      fieldId={fieldId}
                      fileName={activeFileLabel}
                      format={officeViewerFormat}
                      key={fieldId}
                      workspaceId={workspaceId}
                    />
                  </Suspense>
                </RecoverableViewerBoundary>
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
                <RecoverableViewerBoundary
                  key={fieldId}
                  onDownload={downloadActiveFile}
                  pending={<DocxLoadingShell scaleOffset={scaleOffset} />}
                  surface="document-docx"
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
                </RecoverableViewerBoundary>
              </VersionDropZone>
            );
          }

          return (
            <VersionDropZone
              disabled={isPDFPageOrganizerOpen}
              entityId={entityId}
              workspaceId={workspaceId}
            >
              <PDFProvider
                key={fieldId}
                fieldId={fieldId}
                initialScaleOffset={scaleOffset}
                startPage={pageNumber}
                surface="document-pdf"
                onDownload={downloadActiveFile}
                fallback={{
                  // The viewer's own page placeholder, which the page's
                  // loading view drew first; the page organizer lays out
                  // a grid of its own instead.
                  suspense: isPDFPageOrganizerOpen ? (
                    <PDFSuspenseFallback />
                  ) : (
                    <PdfLoadingShell />
                  ),
                  // A 400 is the server's authoritative "no full-screen
                  // rendition"; every other failure takes the boundary's
                  // own recovery.
                  error: (error) =>
                    APIError.is(error) && error.status === 400 ? (
                      <DocumentDisplayUnavailable entityId={entityId} />
                    ) : undefined,
                }}
              >
                {isPDFPageOrganizerOpen ? (
                  <Suspense fallback={<PDFSuspenseFallback />}>
                    <PDFPageOrganizer
                      canSaveVersion={canUpdateEntity}
                      entityId={entityId}
                      fieldId={fieldId}
                      fileName={activeFileLabel}
                      onClose={() => setIsPDFPageOrganizerOpen(false)}
                      pdfSign={
                        pdfSignTarget === null
                          ? null
                          : {
                              flow: editorPdfSignFlow,
                              target: pdfSignTarget,
                            }
                      }
                      workspaceId={workspaceId}
                    />
                  </Suspense>
                ) : (
                  <>
                    <AnonymizeScrollSync />
                    <JustificationScrollSync />
                    <PdfViewer />
                  </>
                )}
              </PDFProvider>
            </VersionDropZone>
          );
        })()}
      </div>
    </DocumentPageFrame>
  );
}

// -- Fullscreen DOCX viewer (read-only Folio) --

/** Recovers by opening the file where every format renders, the side panel. */
const DocumentDisplayUnavailable = ({ entityId }: { entityId: string }) => {
  const t = useTranslations();
  const router = useRouter();
  const navigate = routeApi.useNavigate();
  const { viewId, workspaceId } = routeApi.useParams({
    select: (p) => ({ viewId: p.viewId, workspaceId: p.workspaceId }),
  });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("fileDetail.noFullScreenPreview")}
      </p>
      <Button
        onClick={() => {
          detached(
            (async () => {
              const opened = await Result.tryPromise(async () => {
                await navigate({
                  to: "/workspaces/$workspaceId/$viewId",
                  params: { viewId, workspaceId },
                });
                await openEntityInInspector({
                  documentOnScreen: getCurrentWorkspaceDocument(
                    router.state.matches,
                  ),
                  entityId,
                  label: "",
                  workspaceId,
                });
              });
              if (Result.isError(opened)) {
                const openError = opened.error;
                getAnalytics().captureError(openError, {
                  fingerprintKey: "DocumentDisplayUnavailable:openError",
                  scope: {
                    type: "handler",
                    handlerId: "DocumentDisplayUnavailable:openError",
                  },
                });
                notifyUserError(openError, t("errors.actionFailed"));
              }
            })(),
            "document.open-in-side-panel",
          );
        }}
        size="sm"
        variant="outline"
      >
        {t("common.openInSidePanel")}
      </Button>
    </div>
  );
};

const FullscreenDocxViewer = ({
  workspaceId,
  fieldId,
  scaleOffset,
}: {
  workspaceId: string;
  fieldId: string;
  scaleOffset: number;
}) => {
  // The viewer mounts under its own Suspense and error boundary, keyed by the
  // field: the Suspense fallback is the sheet while the file loads, and a
  // failed read reaches the boundary's recovery.
  const { data: file } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
  );

  return (
    <ReadOnlyDocxDocumentViewer
      documentBuffer={file.buffer}
      fileName={file.fileName}
      scaleOffset={scaleOffset}
    />
  );
};

const ReadOnlyDocxDocumentViewer = ({
  documentBuffer,
  fileName,
  scaleOffset,
}: {
  documentBuffer: ArrayBuffer;
  fileName: string;
  scaleOffset: number;
}) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom({
    fit: { type: "editor" },
    scaleOffset,
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
        accessibleName={fileName}
        className="folio-docx-preview h-full"
        autoOpenReviewSidebar={false}
        documentBuffer={documentBuffer}
        initialZoom={targetZoom}
        mode="viewing"
        preserveDocumentWhileLoading
        readOnly
        showToolbar={false}
        showZoomControl={false}
      />
    </div>
  );
};

// -- Version drop zone for uploading by drag-and-drop --

const ACCEPTED_MIME_TYPES = {
  "application/pdf": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/msword": true,
  [PPTX_MIME]: true,
  [XLSX_MIME]: true,
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
        detached(
          (async () => {
            setIsUploading(true);
            try {
              const result = await uploadEntityVersion({
                workspaceId,
                entityId,
                file,
              });
              switch (result.type) {
                case ENTITY_VERSION_UPLOAD_RESULT.cancelled:
                  return;
                case ENTITY_VERSION_UPLOAD_RESULT.uploaded:
                  await queryClient.invalidateQueries({
                    queryKey: entityVersionsKeys.all({
                      workspaceId,
                      entityId,
                    }),
                  });
                  return;
                default:
                  result satisfies never;
                  panic(`Unhandled entity version upload: ${String(result)}`);
              }
            } finally {
              setIsUploading(false);
            }
          })(),
          "document.set-is-uploading",
        );
      },
    });
  }, [disabled, entityId, queryClient, workspaceId, canStartUpload]);

  return (
    <div className={DOCUMENT_DROP_ZONE_CLASS} ref={dropRef}>
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
