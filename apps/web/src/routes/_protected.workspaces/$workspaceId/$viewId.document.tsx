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
import { stellaToast } from "@stll/ui/toast";
import "@stll/folio-react/editor.css";
import { cn, composeRefs } from "@stll/ui/utils";

import {
  documentReviewPartiesOptions,
  documentReviewRunsOptions,
} from "@/components/ai-suggestions/document-review-queries";
import { openEntityInInspector } from "@/components/chat/entity-open";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { shouldUseDocxBrowserEditor } from "@/components/docx/docx-browser-editor.logic";
import { DocxLoadingShell } from "@/components/docx/docx-loading-shell";
import {
  DOCUMENT_PANE,
  DOCUMENT_PANE_SEARCH_VALUES,
} from "@/components/inspector/document-pane";
import type { DocumentPane } from "@/components/inspector/document-pane";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import type { FileFacet } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { PlaybookFacet } from "@/components/inspector/playbook-facet";
import PdfViewer, { PDFSuspenseFallback } from "@/components/pdf/pdf-viewer";
import Tooltip from "@/components/tooltip";
import { TranslateDocumentDialog } from "@/components/translate-document-dialog";
import { useSyncJustifications } from "@/components/workspaces/hooks/use-sync-justifications";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  DOCX_MIME,
  getNativeOfficeViewerFormat,
  PPTX_MIME,
  TOOLBAR_ROW_HEIGHT,
  XLSX_MIME,
} from "@/lib/consts";
import { detached } from "@/lib/detached";
import { APIError, toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { documentPropertiesOptions, fileOptions } from "@/lib/files/queries";
import {
  PDFProvider,
  usePDFStore,
  usePDFStoreApi,
} from "@/lib/pdf/pdf-context";
import { getPDFPageIdByNumber } from "@/lib/pdf/utils";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { docxSuggestionsOptions } from "@/lib/workspaces/queries/docx-suggestions";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import {
  entityVersionsKeys,
  entityVersionsOptions,
  fieldFileOptions,
} from "@/lib/workspaces/queries/entity-versions";
import { justificationsOptions } from "@/lib/workspaces/queries/workspace";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import "@/components/pdf/peek/peek-docx.css";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";

import { loadDocumentEntityWithChatPrefetch } from "./-document-loader";

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
  const m = await import("@/components/docx/docx-browser-editor");
  return { default: m.DocxBrowserEditor };
});

const OfficeFileViewer = lazy(async () => {
  const m = await import("@/components/office/office-file-viewer");
  return { default: m.OfficeFileViewer };
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
    // Folio block to land on in a DOCX (report citation links). Consumed once
    // on mount through the inspector's pending block scroll.
    block: v.optional(v.string()),
    panel: v.optional(v.picklist(["versions"])),
    editing: v.optional(v.boolean()),
    // Which pane reads the document review. Absent is the default
    // arrangement: the document here, the review in the inspector.
    pane: v.optional(v.picklist(DOCUMENT_PANE_SEARCH_VALUES)),
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
    const entityId = deps.entity;

    const entityPromise = loadDocumentEntityWithChatPrefetch({
      activeOrganizationId: context.user.activeOrganizationId,
      captureError: (error: unknown) => {
        getAnalytics().captureError(error);
      },
      loadEntity: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          entityOptions(params.workspaceId, entityId),
        ),
      queryClient: context.queryClient,
    });

    // Versions power the inspector and field switching. Start the request at
    // navigation time alongside the entity read so direct document links do
    // not add a component-mount waterfall. A fresh entity-version read is
    // reused through the shared query key and route stale time.
    detached(
      prefetchRouteQuery(
        context.queryClient,
        entityVersionsOptions({
          workspaceId: params.workspaceId,
          entityId: deps.entity,
        }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      ),
      "document.prefetch",
    );

    const entity = await entityPromise;

    // useSyncJustifications mounts with entityIds=[deps.entity] as soon as the
    // component renders; warm the same query so it's a cache hit. The hook
    // normalizes entityIds (dedupe + sort) before building the key, but for a
    // single-element array that's a no-op, so the key matches exactly.
    detached(
      prefetchRouteQuery(
        context.queryClient,
        justificationsOptions({
          workspaceId: params.workspaceId,
          entityIds: [deps.entity],
        }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      ),
      "document.prefetch",
    );

    // `field` is the fieldId FullscreenPdfViewer eventually reads via
    // usePDFStore, but on a cold navigation that store is only just created
    // (PDFProvider seeds it from this same search param, see `key={fieldId}`
    // below), so the value is already known here. Only PDF-family fields
    // render through PdfViewer/fileOptions; docx fields take an entirely
    // different display path (DocxBrowserEditor/fieldFileOptions) that never
    // reads fileOptions, while XLSX/PPTX need their originals. Gate each
    // prefetch on the resolved mimeType so no unused derivative is downloaded.
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
      detached(
        prefetchRouteQuery(
          context.queryClient,
          docxSuggestionsOptions({
            workspaceId: params.workspaceId,
            entityId: deps.entity,
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "document.prefetch",
      );

      // The review facet opens on this document's run history, and that answer
      // carries the latest run in full — so one loader-started read leaves both
      // the facet's decision and the run panel warm. Without it the first click
      // on the review tab waits through two dependent rounds behind a skeleton.
      // DOCX only: the facet does not mount for any other field type.
      detached(
        prefetchRouteQuery(
          context.queryClient,
          documentReviewRunsOptions({
            workspaceId: params.workspaceId,
            entityId: deps.entity,
            fileFieldId: deps.field,
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "document.prefetch",
      );

      // "We act for" is the first thing the review launcher asks, and the
      // answer is a detection over the document itself — cached per version
      // server-side, so on every open but the first it costs a round trip and
      // nothing else. Started here so the chips are on screen with the
      // launcher rather than after it. DOCX only, like the facet.
      detached(
        prefetchRouteQuery(
          context.queryClient,
          documentReviewPartiesOptions({
            workspaceId: params.workspaceId,
            entityId: deps.entity,
            fileFieldId: deps.field,
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "document.prefetch",
      );
    }

    // The inspector's metadata facet is the document route's default, so its
    // document-properties read always fires on open. Loader-started, the
    // request runs exactly once; observer-started it lands inside StrictMode's
    // dev-only subscribe churn and fires an aborted duplicate.
    if (field?.content.type === "file") {
      detached(
        prefetchRouteQuery(
          context.queryClient,
          documentPropertiesOptions({
            workspaceId: params.workspaceId,
            fieldId: deps.field,
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "document.prefetch",
      );
    }

    const officeViewerFormat =
      field?.content.type === "file"
        ? getNativeOfficeViewerFormat(field.content.mimeType)
        : null;
    if (officeViewerFormat !== null) {
      detached(
        prefetchRouteQuery(
          context.queryClient,
          fileOptions({
            workspaceId: params.workspaceId,
            fieldId: deps.field,
            purpose: "native-display",
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "document.prefetch",
      );
    }

    const rendersInPdfViewer =
      field?.content.type === "file" &&
      field.content.mimeType !== DOCX_MIME &&
      officeViewerFormat === null;
    if (rendersInPdfViewer) {
      // Warm the file query without blocking route commit: a large PDF
      // download shouldn't hold the user on the pendingComponent. The
      // component's useSuspenseQuery scopes the wait to the PDF area.
      detached(
        prefetchRouteQuery(
          context.queryClient,
          fileOptions({ workspaceId: params.workspaceId, fieldId: deps.field }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "document.prefetch",
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
  const { viewId, workspaceId } = Route.useParams({
    select: (p) => ({ viewId: p.viewId, workspaceId: p.workspaceId }),
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
      viewId={viewId}
      workspaceId={workspaceId}
    />
  );
}

function RouteComponentInner({
  workspaceId,
  viewId,
  entityId,
  initialFieldId,
}: {
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
  const initialBlockId = Route.useSearch({ select: (s) => s.block });
  const pane = Route.useSearch({
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
  const navigate = Route.useNavigate();

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
  const activeMimeType =
    activeFileContent?.mimeType ?? resolvedVersionFile?.mimeType;
  const activePdfFileId = activeFileContent?.pdfFileId ?? null;
  const activeFileLabel =
    activeFileContent?.fileName ?? resolvedVersionFile?.fileName ?? fieldId;
  const isDocxFile = activeMimeType === DOCX_MIME;
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
  }, [fieldId, latestFileFieldForProperty, navigate]);

  return (
    <div className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-hidden border-t">
      <InspectorFieldLifecycle fieldId={fieldId} key={fieldId} />
      {filePropertyId && activeMimeType !== undefined && (
        <InspectorFileOpenLifecycle
          entityId={entityId}
          // In the swapped arrangement the inspector is where the document is
          // read, so the tab opens on its preview rather than its metadata; in
          // the margin arrangement it is where the findings are.
          facet={inspectorFacet}
          fieldId={fieldId}
          fileLabel={activeFileLabel}
          key={`${fieldId}:${filePropertyId}:${activeMimeType}:${activePdfFileId}:${activeFileLabel}:${pane}`}
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
          {!usesEmbeddedDocumentToolbar && !showsReviewPane && (
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
                workspaceId={workspaceId}
              />
            </div>
          )}
          <div className="relative min-h-0 flex-1">
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
                          detached(
                            navigate({
                              search: (prev) => ({
                                ...prev,
                                editing: undefined,
                              }),
                            }),
                            "document.navigate",
                          );
                        }}
                        onSaved={(savedFieldId) => {
                          setDocxUnlocked(false);
                          setActiveFieldId(savedFieldId);
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
                        }}
                        onUnlockedChange={setDocxUnlocked}
                        propertyId={filePropertyId}
                        scaleOffset={scaleOffset}
                        surface="fullView"
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

              if (officeViewerFormat !== null) {
                return (
                  <VersionDropZone
                    disabled={false}
                    entityId={entityId}
                    workspaceId={workspaceId}
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
                    fallback={{
                      suspense: <PDFSuspenseFallback />,
                      error: (error) => (
                        <DocumentDisplayUnavailable
                          entityId={entityId}
                          error={error}
                        />
                      ),
                    }}
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

type DocumentDisplayUnavailableProps = {
  entityId: string;
  error: Error;
};

/**
 * Error fallback for the full-screen viewer's file area. A 400 from the
 * display-URL endpoint is the server's authoritative "this format has no
 * full-screen rendition" — recover by opening the file where every format
 * renders, the side panel — while any other failure keeps the generic
 * message.
 */
const DocumentDisplayUnavailable = ({
  entityId,
  error,
}: DocumentDisplayUnavailableProps) => {
  const t = useTranslations();
  const navigate = Route.useNavigate();
  const { viewId, workspaceId } = Route.useParams({
    select: (p) => ({ viewId: p.viewId, workspaceId: p.workspaceId }),
  });

  if (!(APIError.is(error) && error.status === 400)) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
        {t("common.somethingWentWrong")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("fileDetail.noFullScreenPreview")}
      </p>
      <Button
        onClick={() => {
          detached(
            (async () => {
              try {
                await navigate({
                  to: "/workspaces/$workspaceId/$viewId",
                  params: { viewId, workspaceId },
                });
                await openEntityInInspector(entityId, "", workspaceId);
              } catch (openError) {
                getAnalytics().captureError(openError);
                stellaToast.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              }
            })(),
            "document.open-in-side-panel",
          );
        }}
        size="sm"
        variant="outline"
      >
        {t("fileDetail.openInSidePanel")}
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
              const response = await api
                .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
                ["upload-version"].post({
                  entityId: toSafeId<"entity">(entityId),
                  file,
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
          })(),
          "document.set-is-uploading",
        );
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
