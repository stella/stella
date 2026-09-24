import { useRef } from "react";
import type { MouseEvent } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import { useReaderTextScale } from "@/components/legal-reader/use-reader-text-scale";
import Tooltip from "@/components/tooltip";
import { StatuteReaderBody } from "@/features/statutes/components/statute-reader-body";
import {
  statuteOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import type { StatuteViewPayload } from "@/features/statutes/statute-inspector.logic";
import {
  prepareStatuteReader,
  statuteLandingAnchorId,
} from "@/features/statutes/statute-reader-blocks";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { createStatuteLinkTarget } from "@/lib/statute-route";

/**
 * The act a decision cites, beside the decision: the consolidation that
 * applied, read whole, with its provisions carrying the same details action
 * and the same marks they carry on the act's own page.
 */
export const StatuteInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<StatuteViewPayload>) => {
  const t = useTranslations();
  const { payload } = tab;
  const textScale = useReaderTextScale();
  const {
    data: statute,
    isError,
    isPending,
    refetch,
  } = useQuery(statuteOptions(payload.documentId));
  // A provision opened from a heading offers its drafting history only where
  // the work has more than one consolidation, and the count is what says so.
  const { data: versions } = useQuery(
    statuteVersionsOptions(payload.documentId),
  );
  const versionCount = Math.max(optionalArray(versions).length, 1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Cmd/Ctrl+F belongs to the act in front of the reader rather than to the
  // decision behind it, for as long as there is wording to search.
  const find = useInspectorFind({
    contentRef,
    enabled: statute !== undefined,
    highlightKey: tab.id,
    panelRef,
  });
  const ast = parseDocumentAst(statute?.documentAst);
  const preparedReader = prepareStatuteReader({
    blocks: ast === null ? [] : ast.blocks,
    statuteTitle: statute?.title ?? payload.statuteTitle,
  });
  const landingAnchorId = statuteLandingAnchorId(
    preparedReader.blocks,
    payload.anchorId,
  );
  // The chat is bound to the consolidation the tab holds, which is the
  // document the full reader binds: a question asked here and one asked there
  // are one conversation.
  const activeLegal = {
    type: "statute",
    documentId: payload.documentId,
    title: payload.statuteTitle,
  } as const satisfies ActiveLegalDocument;

  return (
    <div
      // The pane is resizable down to 320px and nothing inside it may widen
      // it: `min-w-0` lets this column shrink past its content's intrinsic
      // width, and the clip is the backstop for a child that still refuses.
      className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip overflow-y-hidden"
      ref={panelRef}
    >
      <InspectorTabHeader
        actions={
          <>
            {statute !== undefined && (
              <OpenOriginalButton
                href={statute.documentUrl ?? statute.sourceUrl}
                size="icon-xs"
              />
            )}
            {/* The wording moves to the page, so the tab that held it goes. */}
            <StatuteMainViewAction onMoveToMain={onClose} payload={payload} />
          </>
        }
        label={tab.label}
        onClose={onClose}
      />
      <InspectorFindBar find={find} />
      <LegalReaderAIChat activeLegal={activeLegal} className="min-h-0 flex-1">
        <ScrollArea axis="vertical" className="h-full">
          {/* The gutter and the room the composer needs belong to the column;
              the text root inside it carries the reader's own scale. */}
          <div data-slot="reader-document-column">
            {/* The floating bar owns the top corner, so the act's masthead
                starts below it rather than under the zoom controls. */}
            <div
              className="flex flex-col gap-4 pt-12 pb-4"
              ref={contentRef}
              {...textScale.rootProps}
            >
              {isPending && <StatuteInspectorLoader />}
              {isError && (
                <div className="reader-chrome flex flex-col items-start gap-2">
                  <p className="text-muted-foreground text-xs">
                    {t("errors.actionFailed")}
                  </p>
                  <Button
                    onClick={() => {
                      detached(refetch(), "statutes.inspector-retry");
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              {statute !== undefined && (
                <StatuteReaderBody
                  blocks={preparedReader.blocks}
                  landingAnchorId={landingAnchorId}
                  masthead={preparedReader.masthead}
                  scrollContainerRef={contentRef}
                  statute={statute}
                  versionCount={versionCount}
                />
              )}
            </div>
          </div>
        </ScrollArea>
        <ViewerOverlayBar>
          <ZoomControls
            atMax={textScale.atMax}
            atMin={textScale.atMin}
            level={textScale.level}
            onReset={textScale.reset}
            onZoom={textScale.zoom}
          />
        </ViewerOverlayBar>
      </LegalReaderAIChat>
    </div>
  );
};

/**
 * Read the whole act: the maximize a decision tab carries, on a statute. A
 * tab opened at a passage keeps it: the page lands on the same block. A
 * modified click stays native and opens the act in a browser tab, leaving the
 * pane as it is.
 */
const StatuteMainViewAction = ({
  onMoveToMain,
  payload,
}: {
  onMoveToMain: () => void;
  payload: StatuteViewPayload;
}) => {
  const t = useTranslations();
  const label = t("inspector.moveToMain");
  const onNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    onMoveToMain();
  };

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          render={
            <Link
              onClick={onNavigate}
              {...(payload.anchorId === undefined
                ? {}
                : { hash: payload.anchorId })}
              {...createStatuteLinkTarget({
                country: payload.country,
                documentId: payload.documentId,
                eli: payload.eli,
                slug: payload.slug,
                versionValidFrom: payload.versionValidFrom,
              })}
            />
          }
          size="icon-xs"
          variant="ghost"
        />
      }
    >
      <Maximize2Icon className="size-3.5" />
    </Tooltip>
  );
};

const StatuteInspectorLoader = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="mx-auto h-5 w-40" />
    <Skeleton className="mx-auto h-3 w-28" />
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-11/12" />
    <Skeleton className="h-3 w-full" />
  </div>
);
