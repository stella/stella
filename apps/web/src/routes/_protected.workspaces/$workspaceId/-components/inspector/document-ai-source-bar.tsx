import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { Citation } from "@/lib/citations";
import { iterateJustificationCitations } from "@/lib/citations";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import {
  getPDFPageIdByNumber,
  useOptionalPDFStore,
} from "@/lib/pdf/pdf-context";
import { renderJustificationContent } from "@/lib/render-justification-content";
import { toSafeId } from "@/lib/safe-id";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type { FileTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

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
  const openFile = useInspectorStore((s) => s.openFile);

  const propertiesQuery = useQuery(propertiesOptions(workspaceId));
  const properties = propertiesQuery.data;
  const entityQuery = useQuery(entityOptions(workspaceId, activeTab.entityId));
  const entity = entityQuery.data;
  useSyncJustifications({
    workspaceId,
    entityIds: [activeTab.entityId],
  });

  const justification = useWorkspaceStore((s) =>
    s.justifications.find((j) => j.fieldId === fieldId),
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
  const requestBlockScroll = useInspectorStore((s) => s.requestBlockScroll);
  const [isAnswerExpanded, setIsAnswerExpanded] = useState(false);

  // Eagerly generate bboxes when the justification bar mounts.
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const setScrollTo = useOptionalPDFStore((s) => s.setScrollTo);
  const pages = useOptionalPDFStore((s) => s.pages);
  const [
    stoppedBoundingBoxJustificationId,
    setStoppedBoundingBoxJustificationId,
  ] = useState<string | null>(null);

  const justificationId = justification?.id;
  const boundingBoxes = justification?.boundingBoxes;
  const activeDocumentJustificationContent = useMemo(
    () =>
      justification
        ? {
            ...justification.content,
            blocks: justification.content.blocks.filter(
              (block) => block.fileFieldId === activeTab.id,
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

  const generateBoundingBoxes = useMutation({
    mutationFn: async ({
      justificationId: id,
    }: {
      justificationId: string;
    }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["bounding-boxes"].post({
          justificationId: toSafeId<"justification">(id),
          queryKey: workspaceKeys.justifications(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async (data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: workspaceKeys.justifications(workspaceId),
      });

      if (data.boxes.length === 0) {
        setStoppedBoundingBoxJustificationId(variables.justificationId);
      }
    },
    onError: (error, variables) => {
      analytics.captureError(error);
      setStoppedBoundingBoxJustificationId(variables.justificationId);
    },
  });

  const needsBoxes = Boolean(
    justificationId &&
    isActiveTab &&
    hasBoundingBoxCitations &&
    !boundingBoxes &&
    stoppedBoundingBoxJustificationId !== justificationId,
  );
  const isGeneratingBoxes = generateBoundingBoxes.isPending;
  const mutateBoundingBoxes = generateBoundingBoxes.mutate;
  // Kick off the generation request when the justification bar
  // mounts with missing bboxes. The mutation hook itself is the
  // source of truth for `isPending`.
  useEffect(() => {
    if (!needsBoxes || !justificationId) {
      return;
    }
    mutateBoundingBoxes({ justificationId });
  }, [needsBoxes, justificationId, mutateBoundingBoxes]);

  useEffect(() => {
    setIsAnswerExpanded(false);
  }, [fieldId]);

  // Nudge the justifications cache every second while we still need
  // bboxes. POST success doesn't guarantee the payload is in cache
  // yet, so we keep polling until `needsBoxes` flips false.
  useEffect(() => {
    if (!needsBoxes) {
      return undefined;
    }
    const id = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.justifications(workspaceId),
      });
    }, BBOX_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [needsBoxes, queryClient, workspaceId]);

  const scrolledForJustificationRef = useRef<string | null>(null);
  useEffect(() => {
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
  useEffect(() => {
    if (!isActiveTab || !justificationId) {
      return;
    }
    if (scrolledForDocxJustificationRef.current === justificationId) {
      return;
    }
    const firstDocxCitation = citations.find(
      (citation) => citation.kind === "docx-folio",
    );
    if (!firstDocxCitation || firstDocxCitation.kind !== "docx-folio") {
      return;
    }
    scrolledForDocxJustificationRef.current = justificationId;
    requestBlockScroll(activeTab.id, firstDocxCitation.blockId);
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
      requestBlockScroll(activeTab.id, citation.blockId);
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
            key={key}
            onClick={() => handleCitationClick(citation)}
          />
        ),
      }).nodes
    : [];

  return (
    <div className="bg-muted/30 flex shrink-0 flex-col border-b px-3">
      <div
        className={cn(
          "flex w-full min-w-0 items-center gap-2 text-xs",
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
          title={shortAnswer ?? undefined}
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
          disabled={!prevSlot}
          onClick={() => {
            if (!prevSlot) {
              return;
            }
            openFile({
              id: activeTab.id,
              entityId: activeTab.entityId,
              label: activeTab.label,
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
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <span className="text-muted-foreground min-w-8 text-center text-[10px] tabular-nums">
          {currentIdx + 1} / {slots.length}
        </span>
        <Button
          disabled={!nextSlot}
          onClick={() => {
            if (!nextSlot) {
              return;
            }
            openFile({
              id: activeTab.id,
              entityId: activeTab.entityId,
              label: activeTab.label,
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
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
      {isAnswerExpanded && shortAnswer !== null && (
        <div className="text-foreground-strong-muted max-h-32 min-w-0 overflow-y-auto pb-2 text-xs leading-relaxed break-words">
          {justificationNodes}
        </div>
      )}
    </div>
  );
};

const SourceCitationChip = ({
  citation,
  onClick,
}: {
  citation: Citation;
  onClick: () => void;
}) => {
  if (citation.kind === "pdf-bates") {
    return (
      <button
        className="text-foreground-strong-muted hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center rounded px-1 py-0.5 align-middle text-[10px] font-medium transition-colors"
        onClick={onClick}
        type="button"
      >
        p.&nbsp;{citation.pageNumber}
      </button>
    );
  }

  // DOCX has no page numbers; keep the marker minimal — a subtle
  // jump-to-block affordance with the source quote behind a tooltip,
  // not inline noise. The full quote is still scannable on hover.
  return (
    <button
      aria-label={citation.text.trim() || undefined}
      className="text-foreground-strong-muted hover:bg-muted hover:text-foreground inline-flex shrink-0 items-center justify-center rounded px-1 py-0.5 align-middle text-[10px] transition-colors"
      onClick={onClick}
      title={citation.text.trim() || undefined}
      type="button"
    >
      <CornerDownLeftIcon className="size-2.5 rotate-90" />
    </button>
  );
};
