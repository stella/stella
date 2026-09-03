import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { cn } from "@stll/ui/utils";

import {
  activeDocxKey,
  useActiveDocxStore,
} from "@/components/ai-suggestions/active-docx-store";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { useSyncJustifications } from "@/components/workspaces/hooks/use-sync-justifications";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { Citation } from "@/lib/citations";
import { iterateJustificationCitations } from "@/lib/citations";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toAPIError } from "@/lib/errors/api";
import { useOptionalPDFStore } from "@/lib/pdf/pdf-context";
import { getPDFPageIdByNumber } from "@/lib/pdf/utils";
import { renderJustificationContent } from "@/lib/render-justification-content";
import { toSafeId } from "@/lib/safe-id";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { workspaceKeys } from "@/lib/workspaces/queries/workspace";
import {
  selectJustificationByFieldId,
  useWorkspaceStore,
} from "@/lib/workspaces/store";

const BBOX_POLL_INTERVAL_MS = 1000;

export const DocumentAiSourceBar = ({
  activeTab,
  fieldId,
  isActiveTab,
  workspaceId,
}: {
  activeTab: FileTab;
  fieldId: string;
  isActiveTab: boolean;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const openFile = useInspectorTabsStore((s) => s.openFile);

  const propertiesQuery = useQuery(propertiesOptions(workspaceId));
  const properties = propertiesQuery.data;
  const entityQuery = useQuery(entityOptions(workspaceId, activeTab.entityId));
  const entity = entityQuery.data;
  useSyncJustifications({
    workspaceId,
    entityIds: [activeTab.entityId],
  });

  const justification = useWorkspaceStore((s) =>
    selectJustificationByFieldId(s.justifications, fieldId),
  );

  const slots = useMemo(() => {
    if (!justification || !entity || !properties) {
      return [];
    }
    return Object.values(entity.fields)
      .map((f) => {
        const prop = properties.find((p) => p.id === f.propertyId);
        if (!prop || prop.tool.type !== "ai-model") {
          return null;
        }
        return { fieldId: f.id, property: prop };
      })
      .filter((s) => s !== null);
  }, [entity, justification, properties]);

  const currentIdx = slots.findIndex((s) => s.fieldId === fieldId);
  const prevSlot = currentIdx > 0 ? slots[currentIdx - 1] : null;
  const nextSlot =
    currentIdx !== -1 && currentIdx < slots.length - 1
      ? slots[currentIdx + 1]
      : null;

  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const requestBlockScroll = useInspectorCommandStore(
    (s) => s.requestBlockScroll,
  );
  const [isAnswerExpanded, setIsAnswerExpanded] = useState(false);

  // Eagerly generate bboxes when the justification bar mounts.
  const setScrollTo = useOptionalPDFStore((s) => s.setScrollTo);
  const pages = useOptionalPDFStore((s) => s.pages);
  const justificationId = justification?.id;
  const boundingBoxes = justification?.boundingBoxes;
  const activeDocumentJustificationContent = useMemo(
    () =>
      justification
        ? {
            ...justification.content,
            blocks: justification.content.blocks.filter(
              (block) =>
                block.kind !== "playbook-verdict" &&
                block.fileFieldId === activeTab.id,
            ),
          }
        : null,
    [activeTab.id, justification],
  );
  const citations = useMemo(
    () =>
      activeDocumentJustificationContent
        ? [...iterateJustificationCitations(activeDocumentJustificationContent)]
        : [],
    [activeDocumentJustificationContent],
  );
  const hasBoundingBoxCitations = citations.some(
    (citation) => citation.kind === "pdf-bates",
  );

  const shouldGenerateBoxes = Boolean(
    justificationId && isActiveTab && hasBoundingBoxCitations && !boundingBoxes,
  );
  const generateBoundingBoxes = useQuery({
    queryKey: [
      ...workspaceKeys.justifications(workspaceId),
      "generate-bounding-boxes",
      justificationId,
    ],
    queryFn: async ({ client, signal }) => {
      // `enabled` gates this query on `justificationId !== undefined`, so an
      // undefined id here is an impossible invariant, not a runtime state.
      if (justificationId === undefined) {
        return panic("bounding-box generation ran without a justification id");
      }
      const result = await Result.tryPromise(async () => {
        const response = await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["bounding-boxes"].post(
            {
              justificationId: toSafeId<"justification">(justificationId),
            },
            { fetch: { signal } },
          );
        if (response.error) {
          throw toAPIError(response.error);
        }
        await client.invalidateQueries({
          queryKey: workspaceKeys.justifications(workspaceId),
        });
        return response.data;
      });
      if (Result.isError(result)) {
        getAnalytics().captureError(result.error);
        throw result.error;
      }
      return result.value;
    },
    enabled: shouldGenerateBoxes && justificationId !== undefined,
    retry: false,
    staleTime: Infinity,
  });
  const generationStopped =
    generateBoundingBoxes.isError ||
    generateBoundingBoxes.data?.boxes.length === 0;
  const needsBoxes = shouldGenerateBoxes && !generationStopped;
  const isGeneratingBoxes = generateBoundingBoxes.isFetching;

  // Reset expansion when the field changes. setIsAnswerExpanded also backs the
  // toggle button, so this is not pure derived state; a key-reset belongs in
  // the parent (file-tab-panel.tsx, outside this batch) and would also reset
  // this component's bbox refs. Adjusting state during render (instead of in an
  // effect) avoids the extra commit and the cascading-render warning.
  const [lastFieldId, setLastFieldId] = useState(fieldId);
  if (fieldId !== lastFieldId) {
    setLastFieldId(fieldId);
    setIsAnswerExpanded(false);
  }

  useQuery({
    queryKey: [
      ...workspaceKeys.justifications(workspaceId),
      "bounding-box-poll",
      justificationId,
    ],
    queryFn: async ({ client }) => {
      await client.invalidateQueries({
        queryKey: workspaceKeys.justifications(workspaceId),
      });
      return true;
    },
    enabled: needsBoxes,
    initialData: true,
    refetchInterval: BBOX_POLL_INTERVAL_MS,
    staleTime: Infinity,
  });

  const scrolledForJustificationRef = useRef<string | null>(null);
  useExternalSyncEffect(() => {
    if (!boundingBoxes || !isActiveTab || !pages || !setScrollTo) {
      return;
    }
    if (!justificationId) {
      return;
    }
    if (scrolledForJustificationRef.current === justificationId) {
      return;
    }

    const firstBox = boundingBoxes.boxes
      .toSorted((a, b) => a.pageNumber - b.pageNumber)
      .at(0);

    if (!firstBox) {
      return;
    }

    const pageId = getPDFPageIdByNumber({
      fieldId: activeTab.id,
      pages,
      pageNumber: firstBox.pageNumber,
    });
    if (pageId) {
      scrolledForJustificationRef.current = justificationId;
      setScrollTo({
        pageId,
        target: { kind: "justification", id: justificationId },
      });
    }
  }, [
    activeTab.id,
    boundingBoxes,
    justificationId,
    isActiveTab,
    pages,
    setScrollTo,
  ]);

  // Folio (DOCX) parallel: once the justification activates on this
  // tab, queue a scroll to the first citation's block so the user
  // doesn't have to click a chip to land on it. Mirrors the PDF
  // first-bbox auto-scroll above. Tracks "already scrolled for this
  // justification id" so swapping back to the same cell doesn't
  // re-fire the request mid-typing.
  const scrolledForDocxJustificationRef = useRef<string | null>(null);
  useExternalSyncEffect(() => {
    if (!isActiveTab || !justificationId) {
      return;
    }
    if (scrolledForDocxJustificationRef.current === justificationId) {
      return;
    }
    // The inferred type predicate narrows the result to a verified docx
    // citation, the only kind that carries a navigable block id.
    const firstDocxCitation = citations.find(
      (citation) =>
        citation.kind === "docx-folio" &&
        citation.citationStatus === "verified",
    );
    if (!firstDocxCitation) {
      return;
    }
    scrolledForDocxJustificationRef.current = justificationId;
    requestBlockScroll({
      tabId: activeTab.id,
      blockId: firstDocxCitation.blockId,
      text: firstDocxCitation.text,
    });
  }, [
    activeTab.id,
    citations,
    isActiveTab,
    justificationId,
    requestBlockScroll,
  ]);

  // Sync activeJustification before paint so PageCitation can
  // render bboxes without waiting for PeekJustification's effect.
  // Only set for the ACTIVE tab — inactive tabs stay mounted but
  // hidden, and their effects must not overwrite the active tab's
  // justification.
  useLayoutEffect(() => {
    if (justificationId && isActiveTab && hasBoundingBoxCitations) {
      setActiveJustification({ id: justificationId, pageNumber: 1 });
    }
    return () => {
      if (isActiveTab) {
        setActiveJustification(null);
      }
    };
  }, [
    justificationId,
    hasBoundingBoxCitations,
    isActiveTab,
    setActiveJustification,
  ]);

  if (!justification || !entity || !properties) {
    return null;
  }

  const currentSlot = currentIdx !== -1 ? slots[currentIdx] : undefined;
  const propertyName = currentSlot?.property.name;

  const shortAnswer = (() => {
    if (!currentSlot) {
      return null;
    }
    // entity.fields is Record<propertyId, WorkspaceField>
    const field = Object.values(entity.fields).find(
      (f) => f.id === currentSlot.fieldId,
    );
    if (!field) {
      return null;
    }
    const c = field.content;
    if ("value" in c) {
      const v = c.value;
      if (Array.isArray(v)) {
        return v.join(", ");
      }
      return v !== null ? String(v) : null;
    }
    return null;
  })();
  const handleCitationClick = (citation: Citation) => {
    if (citation.kind === "docx-folio") {
      // Unverified citations render non-clickable, but the handler stays
      // total: a missing block has nowhere to scroll.
      if (citation.citationStatus === "unverified") {
        return;
      }
      requestBlockScroll({
        tabId: activeTab.id,
        blockId: citation.blockId,
        text: citation.text,
      });
      return;
    }

    setActiveJustification({
      id: justification.id,
      pageNumber: citation.pageNumber,
    });
    if (!pages || !setScrollTo) {
      return;
    }
    const pageId = getPDFPageIdByNumber({
      fieldId: activeTab.id,
      pages,
      pageNumber: citation.pageNumber,
    });
    if (!pageId) {
      return;
    }
    setScrollTo({
      pageId,
      target: { kind: "justification", id: justification.id },
    });
  };
  const justificationNodes = activeDocumentJustificationContent
    ? renderJustificationContent({
        content: activeDocumentJustificationContent,
        renderCitation: ({ citation, key }) => (
          <SourceCitationChip
            citation={citation}
            entityId={activeTab.entityId}
            fieldId={activeTab.id}
            key={key}
            onClick={() => handleCitationClick(citation)}
          />
        ),
      }).nodes
    : [];

  return (
    <div className="bg-muted/30 relative flex shrink-0 flex-col border-b px-3">
      {/* One-shot tint pulse so a freshly activated justification
          reads as a connected event, not a quiet re-render. Keyed
          on the justification id so each new activation re-mounts
          the overlay and re-runs the keyframe. */}
      <div
        aria-hidden
        className="bg-primary/12 animate-attention-flash pointer-events-none absolute inset-0 opacity-0"
        key={justificationId}
      />
      <div
        className={cn(
          "relative flex w-full min-w-0 items-center gap-2 text-xs",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        {isGeneratingBoxes && (
          <LoaderCircleIcon className="text-muted-foreground size-3 shrink-0 animate-spin" />
        )}
        <button
          aria-expanded={isAnswerExpanded}
          className="min-w-0 flex-1 truncate text-start"
          onClick={() => setIsAnswerExpanded((expanded) => !expanded)}
          type="button"
        >
          {propertyName && (
            <span className="text-muted-foreground">{propertyName}: </span>
          )}
          <span className="font-medium">
            {shortAnswer ?? t("workspaces.pdf.evidence")}
          </span>
        </button>
        <Button
          aria-label={t("common.previous")}
          disabled={!prevSlot}
          onClick={() => {
            if (!prevSlot) {
              return;
            }
            openFile({
              id: activeTab.id,
              entityId: activeTab.entityId,
              label: activeTab.label,
              fileName: activeTab.fileName,
              workspaceId: activeTab.workspaceId,
              mimeType: activeTab.mimeType,
              pdfFileId: activeTab.pdfFileId,
              justificationFieldId: prevSlot.fieldId,
              propertyId: prevSlot.property.id,
            });
          }}
          size="icon-xs"
          variant="ghost"
        >
          <DirectionalIcon className="size-3.5" icon={ChevronLeftIcon} />
        </Button>
        <span className="text-muted-foreground min-w-8 text-center text-[10px] tabular-nums">
          {format.number(currentIdx + 1)} / {format.number(slots.length)}
        </span>
        <Button
          aria-label={t("common.next")}
          disabled={!nextSlot}
          onClick={() => {
            if (!nextSlot) {
              return;
            }
            openFile({
              id: activeTab.id,
              entityId: activeTab.entityId,
              label: activeTab.label,
              fileName: activeTab.fileName,
              workspaceId: activeTab.workspaceId,
              mimeType: activeTab.mimeType,
              pdfFileId: activeTab.pdfFileId,
              justificationFieldId: nextSlot.fieldId,
              propertyId: nextSlot.property.id,
            });
          }}
          size="icon-xs"
          variant="ghost"
        >
          <DirectionalIcon className="size-3.5" icon={ChevronRightIcon} />
        </Button>
      </div>
      {isAnswerExpanded && shortAnswer !== null && (
        <div className="text-foreground-strong-muted relative max-h-32 min-w-0 overflow-y-auto pb-2 text-xs leading-relaxed wrap-break-word">
          {justificationNodes}
        </div>
      )}
    </div>
  );
};

/**
 * Resolve the page for a folio block via the editor registered for
 * `(entityId, fieldId)` — the same registry the Suggestions facet uses
 * to reach a mounted-but-out-of-tree editor. Scoped per editor rather
 * than a document-wide DOM query: a workspace can have several DOCX
 * editors mounted, and a chip in one tab must not read another tab's
 * geometry.
 *
 * `getBlockRect` returns `null` while the editor is still mounting or
 * while the block's page hasn't been painted yet (folio lays out
 * lazily). `onLayoutChange` fires after painted pages change, so the
 * chip catches up whenever the block actually lands, including after
 * a `scrollToBlock` triggers a lazy layout pass.
 */
const useFolioBlockPage = (
  entityId: string,
  fieldId: string,
  blockId: string,
): number | null => {
  const editorRef = useActiveDocxStore(
    (s) => s.byKey[activeDocxKey(entityId, fieldId)]?.registration.editorRef,
  );
  const [page, setPage] = useState<number | null>(null);
  useExternalSyncEffect(() => {
    const editor = editorRef?.current ?? null;
    if (editor === null) {
      setPage(null);
      return undefined;
    }
    const read = () => {
      const next = editor.getBlockRect(blockId)?.page ?? null;
      // Only set when changed so we don't churn React state on every
      // unrelated layout pass the editor emits during typing.
      setPage((prev) => (prev === next ? prev : next));
    };
    read();
    return editor.onLayoutChange(read);
  }, [blockId, editorRef]);
  return page;
};

const SOURCE_CITATION_CHIP_CLASS =
  "border-border bg-muted/64 text-foreground-strong-muted hover:bg-muted hover:text-foreground hover:border-foreground/24 inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 align-middle text-[10.5px] font-medium tracking-tight transition-colors";

// Unverified: no border, no hover affordance, dashed underline so it
// reads as plain text the reader must not trust as a source anchor.
const UNVERIFIED_CITATION_CHIP_CLASS =
  "text-muted-foreground inline-flex shrink-0 items-center gap-1 align-middle text-[10.5px] font-medium tracking-tight italic underline decoration-dotted underline-offset-2";

const SourceCitationChip = ({
  citation,
  entityId,
  fieldId,
  onClick,
}: {
  citation: Citation;
  entityId: string;
  fieldId: string;
  onClick: () => void;
}) => {
  const t = useTranslations();
  if (citation.kind === "pdf-bates") {
    return (
      <button
        className={SOURCE_CITATION_CHIP_CLASS}
        onClick={onClick}
        type="button"
      >
        p.&nbsp;{citation.pageNumber}
      </button>
    );
  }

  if (citation.citationStatus === "unverified") {
    return (
      <span
        className={UNVERIFIED_CITATION_CHIP_CLASS}
        title={t("common.unverifiedCitationHint")}
      >
        {t("common.unverified")}
      </span>
    );
  }

  return (
    <DocxSourceCitationChip
      blockId={citation.blockId}
      entityId={entityId}
      fieldId={fieldId}
      onClick={onClick}
      tooltip={citation.text.trim() || undefined}
    />
  );
};

const DocxSourceCitationChip = ({
  blockId,
  entityId,
  fieldId,
  onClick,
  tooltip,
}: {
  blockId: string;
  entityId: string;
  fieldId: string;
  onClick: () => void;
  tooltip: string | undefined;
}) => {
  const page = useFolioBlockPage(entityId, fieldId, blockId);
  // Page resolution races the editor's paginator on first mount —
  // fall back to an em dash so the chip stays the same width and
  // the layout doesn't reshuffle when the number lands.
  const label = page !== null ? `p. ${page}` : "p. —";

  return (
    <button
      aria-label={tooltip}
      className={SOURCE_CITATION_CHIP_CLASS}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
};
