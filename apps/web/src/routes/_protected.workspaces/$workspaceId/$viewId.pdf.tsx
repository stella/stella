import {
  Activity,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { dropTargetForExternal } from "@atlaskit/pragmatic-drag-and-drop/external/adapter";
import {
  containsFiles,
  getFiles,
} from "@atlaskit/pragmatic-drag-and-drop/external/file";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Navigate,
  createFileRoute,
  stripSearchParams,
} from "@tanstack/react-router";
import { PencilIcon, UploadIcon } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import "@stella/folio/editor.css";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { PDFProvider, usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { toSafeId } from "@/lib/safe-id";
import type { EntityField, EntityKind } from "@/lib/types";
import { DocxBrowserEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor";
import { EditableField } from "@/routes/_protected.workspaces/$workspaceId/-components/editable-field";
import { skipFieldFilter } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-info";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import PdfViewer, {
  PDFSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-viewer";
import { VersionsSidebar } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/versions-sidebar";
import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  entityVersionsKeys,
  entityVersionsOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const ReadOnlyDocxViewer = lazy(async () => {
  const m = await import("@stella/folio");
  return { default: m.DocxEditor };
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/pdf",
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
  pendingComponent: () => <PDFSuspenseFallback />,
});

const AnonymizeScrollSync = () => {
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const pages = usePDFStore((s) => s.pages);
  const pendingAnonymizeEntityId = useWorkspaceStore(
    (s) => s.pdfViewer.pendingAnonymizeEntityId,
  );
  const setPendingAnonymizeEntityId = useWorkspaceStore(
    (s) => s.setPendingAnonymizeEntityId,
  );

  useEffect(() => {
    if (pendingAnonymizeEntityId === null || pages.size === 0) {
      return;
    }

    const pageIds = [...pages.keys()];
    const pageId = pageIds[pageNumber - 1];
    if (pageId === undefined) {
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
    pageNumber,
    pages,
    pendingAnonymizeEntityId,
    setPendingAnonymizeEntityId,
    setScrollTo,
  ]);

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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [activeFieldId, setActiveFieldId] = useState(initialFieldId);
  const fieldId = activeFieldId;
  const panel = Route.useSearch({ select: (s) => s.panel });
  useSyncJustifications([entityId]);
  const sidebar = useWorkspaceStore((s) => s.pdfViewer.sidebar);
  const setPdfSidebar = useWorkspaceStore((s) => s.setPdfSidebar);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const justificationId = Route.useSearch({
    select: (s) => s.justification,
  });
  const justificationPage = Route.useSearch({
    select: (s) => s.justificationPage,
  });
  const pageNumber = Route.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, entityId),
  );
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const resetPdfViewerState = useWorkspaceStore((s) => s.resetPdfViewerState);
  const closeAllInspectorTabs = useInspectorStore((s) => s.closeAll);

  // Close the sidepeek inspector when the full PDF view mounts
  useEffect(() => {
    closeAllInspectorTabs();
  }, [closeAllInspectorTabs]);

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

  // Sync the `panel` search param to sidebar state on mount
  useLayoutEffect(() => {
    if (panel === "versions") {
      setPdfSidebar("versions");
    }
  }, [panel, setPdfSidebar]);

  // Compare mode state
  const [compareState, setCompareState] = useState<{
    pdfBuffer: ArrayBuffer;
    docxBase64: string;
    editsApplied: number;
    wordsAdded: number;
    wordsRemoved: number;
    seq: number;
  } | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const compareSeqRef = useRef(0);

  const handleCompare = async (
    baseVersionId: string,
    targetVersionId: string,
  ) => {
    setIsComparing(true);
    try {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .entity({ entityId: toSafeId<"entity">(entityId) })
        .compare.post(
          {
            baseVersionId: toSafeId<"entityVersion">(baseVersionId),
            targetVersionId: toSafeId<"entityVersion">(targetVersionId),
            entityId: toSafeId<"entity">(entityId),
          },
          { fetch: { signal: AbortSignal.timeout(30_000) } },
        );
      if (response.error) {
        throw toAPIError(response.error);
      }
      const { pdfBase64, docxBase64, editsApplied, wordsAdded, wordsRemoved } =
        response.data;
      const binary = atob(pdfBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.codePointAt(i) ?? 0;
      }
      compareSeqRef.current += 1;
      setCompareState({
        pdfBuffer: bytes.buffer,
        docxBase64,
        editsApplied,
        wordsAdded,
        wordsRemoved,
        seq: compareSeqRef.current,
      });
    } finally {
      setIsComparing(false);
    }
  };

  const editing = Route.useSearch({ select: (s) => s.editing === true });
  const navigate = Route.useNavigate();

  // Find the active file field to determine mimeType and propertyId
  const activeFileField = entity.fields.find((f) => {
    if (f.content.type !== "file") {
      return false;
    }
    return f.id === fieldId;
  });
  const activeFileContent =
    activeFileField?.content.type === "file" ? activeFileField.content : null;
  const isDocxFile = activeFileContent?.mimeType === DOCX_MIME;
  const usesNativeDocxDisplay = isDocxFile;
  const filePropertyId = activeFileField?.propertyId;

  const showVersions = sidebar === "versions" || panel === "versions";
  const sidebarOpen = sidebar !== "none" || panel === "versions";

  return (
    <div
      className="bg-secondary relative flex h-full max-h-[calc(100vh-3rem)] flex-1 overflow-x-hidden overflow-y-auto border-t"
      ref={scrollContainerRef}
    >
      <Group orientation="horizontal">
        {/* Left panel: version history list (versions mode only) */}
        {showVersions && (
          <>
            <Panel defaultSize="14rem" maxSize="20rem" minSize="10rem">
              <div className="bg-background h-full overflow-y-auto">
                <VersionListConnected
                  currentFieldId={fieldId}
                  entityId={entityId}
                  isComparing={isComparing}
                  onClearCompare={() => setCompareState(null)}
                  onCompare={(base, target) => {
                    void handleCompare(base, target);
                  }}
                  onSwitchField={(fid) => {
                    setActiveFieldId(fid);
                    setCompareState(null);
                  }}
                  workspaceId={workspaceId}
                />
              </div>
            </Panel>
            <PanelSeparator />
          </>
        )}

        {/* Center: DOCX editor, PDF viewer, or redline comparison */}
        <Panel>
          {editing && isDocxFile && filePropertyId ? (
            <DocxBrowserEditor
              entityId={entityId}
              onClose={() => {
                void navigate({
                  search: (prev) => ({ ...prev, editing: undefined }),
                });
              }}
              propertyId={filePropertyId}
              workspaceId={workspaceId}
            />
          ) : (
            <VersionDropZone
              disabled={!!compareState}
              entityId={entityId}
              workspaceId={workspaceId}
            >
              {/* "Edit in browser" button for DOCX files */}
              {isDocxFile && !compareState && (
                <div className="absolute end-2 top-2 z-10">
                  <Button
                    onClick={() => {
                      void navigate({
                        search: (prev) => ({ ...prev, editing: true }),
                      });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <PencilIcon />
                    Edit in browser
                  </Button>
                </div>
              )}
              {compareState ? (
                <RedlineOverlay
                  compareState={compareState}
                  onClose={() => setCompareState(null)}
                />
              ) : usesNativeDocxDisplay ? (
                <Suspense fallback={<PDFSuspenseFallback />}>
                  <FullscreenDocxViewer
                    fieldId={fieldId}
                    workspaceId={workspaceId}
                  />
                </Suspense>
              ) : (
                <PDFProvider
                  key={fieldId}
                  fieldId={fieldId}
                  initialScaleOffset={scaleOffset}
                  startPage={pageNumber}
                  fallback={{ suspense: <PDFSuspenseFallback /> }}
                >
                  <AnonymizeScrollSync />
                  <PdfViewer />
                </PDFProvider>
              )}
            </VersionDropZone>
          )}
        </Panel>

        {/* Right panel: entity metadata / anonymize */}
        <Activity mode={sidebarOpen ? "visible" : "hidden"}>
          <PanelSeparator />
          <Panel defaultSize="28rem" maxSize="40rem" minSize="16rem">
            <div className="bg-background h-full overflow-y-auto">
              <FieldInfoList entity={entity} workspaceId={workspaceId} />
            </div>
          </Panel>
        </Activity>
      </Group>
    </div>
  );
}

type FieldInfoListProps = {
  workspaceId: string;
  entity: {
    kind: EntityKind;
    entityId: string;
    fields: EntityField[];
  };
};

const FieldInfoList = ({ workspaceId, entity }: FieldInfoListProps) => {
  const t = useTranslations();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));

  // Sort by property order so fields don't jump around after edits
  // (the API returns fields in non-deterministic order).
  const propertyIndex = new Map(properties.map((p, i) => [p.id, i]));
  const visibleFields = entity.fields
    .filter((field) => !skipFieldFilter(field.content))
    .toSorted(
      (a, b) =>
        (propertyIndex.get(a.propertyId) ?? Infinity) -
        (propertyIndex.get(b.propertyId) ?? Infinity),
    );

  if (visibleFields.length === 0) {
    return (
      <div className="text-muted-foreground mt-3 px-3 text-center text-sm font-medium">
        {t("workspaces.noFieldsToView")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-px p-2">
      {visibleFields.map((field) => {
        const property = properties.find((p) => p.id === field.propertyId);
        if (!property) {
          return null;
        }
        return (
          <div
            className="flex flex-col gap-1 rounded-md px-2 py-2"
            key={field.id + field.propertyId}
          >
            <span className="text-muted-foreground text-xs font-medium">
              {property.name}
            </span>
            <EditableField
              content={field.content}
              entityKind={entity.kind}
              entityId={entity.entityId}
              property={property}
              propertyId={field.propertyId}
              readonly={property.tool.type === "ai-model"}
              workspaceId={workspaceId}
            />
          </div>
        );
      })}
    </div>
  );
};

// -- Shared panel separator --

const PanelSeparator = () => (
  <Separator className="group data-[separator=active]:bg-border data-[separator=hover]:bg-border flex w-1 shrink-0 cursor-col-resize items-center justify-center">
    <div className="bg-border h-8 w-0.5 rounded-full group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
  </Separator>
);

// -- Version list (left panel, connected to route) --

type VersionListConnectedProps = {
  workspaceId: string;
  entityId: string;
  currentFieldId: string;
  onCompare: (baseVersionId: string, targetVersionId: string) => void;
  onClearCompare: () => void;
  onSwitchField: (fieldId: string) => void;
  isComparing: boolean;
};

const VersionListConnected = ({
  workspaceId,
  entityId,
  currentFieldId,
  onCompare,
  onClearCompare,
  onSwitchField,
  isComparing,
}: VersionListConnectedProps) => {
  const { data } = useQuery(entityVersionsOptions({ workspaceId, entityId }));

  if (!data) {
    return null;
  }

  return (
    <VersionsSidebar
      currentFieldId={currentFieldId}
      currentVersionId={data.currentVersionId}
      entityId={entityId}
      isComparing={isComparing}
      versions={data.versions}
      workspaceId={workspaceId}
      onClearCompare={onClearCompare}
      onCompare={onCompare}
      onSwitchVersion={(fid) => onSwitchField(fid)}
    />
  );
};

// -- Fullscreen DOCX viewer (read-only Folio) --

const FullscreenDocxViewer = ({
  workspaceId,
  fieldId,
}: {
  workspaceId: string;
  fieldId: string;
}) => {
  const { data: file } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
  );

  return (
    <ReadOnlyDocxViewer
      className="h-full"
      documentBuffer={file.buffer}
      readOnly
      showToolbar={false}
    />
  );
};

// -- Redline comparison overlay --

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type RedlineOverlayProps = {
  compareState: {
    pdfBuffer: ArrayBuffer;
    docxBase64: string;
    editsApplied: number;
    wordsAdded: number;
    wordsRemoved: number;
    seq: number;
  };
  onClose: () => void;
};

const RedlineOverlay = ({ compareState, onClose }: RedlineOverlayProps) => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col">
      <div className="bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5">
        <span className="text-muted-foreground text-xs">
          {t("fileDetail.redlinePreview")}
        </span>
        <span className="text-xs text-green-600">
          +{compareState.wordsAdded} {t("fileDetail.wordsAdded")}
        </span>
        <span className="text-destructive text-xs">
          −{compareState.wordsRemoved} {t("fileDetail.wordsRemoved")}
        </span>
        <span className="text-muted-foreground text-xs">
          {compareState.editsApplied} {t("fileDetail.changesDetected")}
        </span>
        <div className="ms-auto flex items-center gap-1.5">
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
        <PDFProvider
          key={`redline-${String(compareState.seq)}`}
          fieldId={`redline-${String(compareState.seq)}`}
          startPage={1}
        >
          <PDFViewport
            buffer={compareState.pdfBuffer}
            className="space-y-2 px-2 pt-2 pb-4"
            fileId={`redline-${String(compareState.seq)}`}
            renderPage={(props) => <PDFPage {...props} />}
          />
        </PDFProvider>
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
      // eslint-disable-next-line typescript/no-misused-promises
      onDrop: async ({ source }) => {
        setIsDropTarget(false);
        if (isUploadingRef.current) {
          return;
        }
        const files = getFiles({ source });
        const file = files.find((f) => ACCEPTED_MIME_TYPES.has(f.type));
        if (!file) {
          return;
        }
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
      },
    });
  }, [disabled, entityId, queryClient, workspaceId]);

  return (
    <div className="relative flex h-full flex-col" ref={dropRef}>
      {children}
      {isDropTarget && (
        <div className="border-foreground/20 bg-foreground/5 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed">
          <div className="text-foreground/50 flex flex-col items-center gap-2">
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
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};
