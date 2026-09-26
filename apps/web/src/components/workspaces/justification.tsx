import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { produce } from "immer";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import Tooltip from "@/components/tooltip";
import { useCreateBBoxes } from "@/components/workspaces/hooks/use-create-b-boxes";
import type { Citation } from "@/lib/citations";
import { detached } from "@/lib/detached";
import {
  FOLIO_SCROLL_EVENT,
  type FolioScrollEventDetail,
} from "@/lib/folio-scroll-event";
import { useOptionalPDFStore } from "@/lib/pdf/pdf-context";
import { getPDFPageIdByNumber } from "@/lib/pdf/utils";
import { renderJustificationContent } from "@/lib/render-justification-content";
import type { JustificationContent, WorkspaceJustification } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspaces/store";

const CITATION_CHIP_CLASSES =
  "bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center align-baseline rounded-md px-1.5 py-0.5 text-2xs font-medium not-italic";

const DOCX_CHIP_PREVIEW_CHARS = 32;

/**
 * What a justification explains, and therefore where its citations lead.
 *
 * A field's justification belongs to a matter, so its chips write the
 * workspace stores the file viewers read. A decision's belongs to nothing a
 * matter owns: the corpus is public, so the host says what opening a passage
 * means and the card stays free of case-law knowledge.
 */
export type JustificationSource =
  | {
      kind: "field";
      workspaceId: string;
      justification: WorkspaceJustification;
    }
  | {
      kind: "decision";
      content: JustificationContent;
      /** Opens the decision at the passage, with the reader's highlight. */
      onOpenPassage: (anchorId: string) => void;
    };

export const Justification = ({ source }: { source: JustificationSource }) => (
  <div>
    {
      renderJustificationContent({
        content:
          source.kind === "field"
            ? source.justification.content
            : source.content,
        renderCitation: ({ citation, key }) => {
          switch (citation.kind) {
            case "pdf-bates":
              return source.kind === "field" ? (
                <PdfChip
                  citation={citation}
                  justification={source.justification}
                  key={key}
                  workspaceId={source.workspaceId}
                />
              ) : null;
            case "docx-folio":
              return <DocxQuote citation={citation} key={key} />;
            case "decision-passage":
              return source.kind === "decision" ? (
                <DecisionPassageChip
                  citation={citation}
                  key={key}
                  onOpen={source.onOpenPassage}
                />
              ) : null;
            default:
              citation satisfies never;
              return panic(`Unhandled citation: ${String(citation)}`);
          }
        },
      }).nodes
    }
  </div>
);

type PdfChipProps = {
  workspaceId: string;
  justification: WorkspaceJustification;
  citation: Extract<Citation, { kind: "pdf-bates" }>;
};

const PdfChip = ({ workspaceId, justification, citation }: PdfChipProps) => {
  const currentJustification = useWorkspaceStore((s) => s.activeJustification);
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );

  const isActive =
    justification.id === currentJustification?.id &&
    citation.pageNumber === currentJustification.pageNumber;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/document",
  });
  const createBoundingBoxes = useCreateBBoxes({
    workspaceId,
    justification,
  });
  // The metadata panel can render in a full-view lane that sits
  // outside the route's PDFProvider; fall back to URL-driven scroll
  // (handled by JustificationScrollSync inside the route's provider).
  const pageId = useOptionalPDFStore((s) =>
    getPDFPageIdByNumber({
      fieldId: s.fieldId,
      pages: s.pages,
      pageNumber: citation.pageNumber,
    }),
  );
  const pdfFieldId = useOptionalPDFStore((s) => s.fieldId);
  const setScrollTo = useOptionalPDFStore((s) => s.setScrollTo);

  return (
    <button
      className={cn(
        CITATION_CHIP_CLASSES,
        isActive && "bg-primary/25 hover:bg-primary/25",
      )}
      onClick={() => {
        detached(
          (async () => {
            createBoundingBoxes();
            setActiveJustification({
              id: justification.id,
              pageNumber: citation.pageNumber,
            });

            const boundingBoxes = useWorkspaceStore
              .getState()
              .justifications.find(
                (j) => j.id === justification.id,
              )?.boundingBoxes;
            if (pdfFieldId === citation.fileFieldId && pageId && setScrollTo) {
              setScrollTo({
                pageId,
                target: boundingBoxes
                  ? { kind: "justification", id: justification.id }
                  : undefined,
              });
            }
            await navigate({
              replace: true,
              search: (prev) =>
                produce(prev, (s) => {
                  s.field = citation.fileFieldId;
                  s.justification = justification.id;
                  s.justificationPage = citation.pageNumber;
                  s.pdfPage = citation.pageNumber;
                }),
            });
          })(),
          "justification.create-bounding-boxes",
        );
      }}
      onMouseEnter={() => {
        createBoundingBoxes();
      }}
      type="button"
    >
      p.&nbsp;{citation.pageNumber}
    </button>
  );
};

type DecisionPassageChipProps = {
  citation: Extract<Citation, { kind: "decision-passage" }>;
  onOpen: (anchorId: string) => void;
};

/**
 * The passage of a decision an answer leaned on. Pressing it opens the
 * decision at that paragraph with the reader's highlight on it, the way a
 * page chip opens a file at its page.
 */
const DecisionPassageChip = ({
  citation,
  onOpen,
}: DecisionPassageChipProps) => {
  const trimmed = citation.excerpt.trim();
  const preview =
    trimmed.length > DOCX_CHIP_PREVIEW_CHARS
      ? `${trimmed.slice(0, DOCX_CHIP_PREVIEW_CHARS).trimEnd()}…`
      : trimmed || "¶";

  return (
    <Tooltip
      content={trimmed || undefined}
      render={
        <button
          className={cn(CITATION_CHIP_CLASSES, "max-w-[16rem] truncate")}
          dir="auto"
          onClick={() => onOpen(citation.anchorId)}
          type="button"
        >
          {"“"}
          {preview}
          {"”"}
        </button>
      }
    />
  );
};

type DocxQuoteProps = {
  citation: Extract<Citation, { kind: "docx-folio" }>;
};

const DocxQuote = ({ citation }: DocxQuoteProps) => {
  const t = useTranslations();
  const requestBlockScroll = useInspectorCommandStore(
    (s) => s.requestBlockScroll,
  );
  const trimmed = citation.text.trim();
  const preview =
    trimmed.length > DOCX_CHIP_PREVIEW_CHARS
      ? `${trimmed.slice(0, DOCX_CHIP_PREVIEW_CHARS).trimEnd()}…`
      : trimmed || "¶";
  if (citation.citationStatus === "unverified") {
    // No navigable block: render the model's quote as plain, non-clickable
    // text with an "unverified" affordance so it is never mistaken for a
    // grounded source.
    return (
      <Tooltip
        content={t("common.unverifiedCitationHint")}
        render={
          <span className="text-muted-foreground text-2xs inline-flex max-w-[16rem] items-center gap-1 truncate align-baseline font-medium italic underline decoration-dotted underline-offset-2">
            “{preview}” · {t("common.unverified")}
          </span>
        }
      />
    );
  }
  return (
    <Tooltip
      content={trimmed || undefined}
      render={
        <button
          className={cn(CITATION_CHIP_CLASSES, "max-w-[16rem] truncate")}
          data-block-id={citation.blockId}
          onClick={() => {
            // Inspector peek path reads `pendingBlockScroll` from the
            // store; the full-view DocxBrowserEditor listens for the
            // window event (see docx-browser-editor.tsx). Fire both so
            // both surfaces respond.
            requestBlockScroll({
              tabId: citation.fileFieldId,
              blockId: citation.blockId,
              text: citation.text,
            });
            window.dispatchEvent(
              new CustomEvent<FolioScrollEventDetail>(FOLIO_SCROLL_EVENT, {
                detail: {
                  blockId: citation.blockId,
                  fieldId: citation.fileFieldId,
                  text: citation.text,
                },
              }),
            );
          }}
          type="button"
        >
          “{preview}”
        </button>
      }
    />
  );
};
