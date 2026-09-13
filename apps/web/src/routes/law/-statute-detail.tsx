import { useCallback, useId, useRef, useState } from "react";

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  parseDocumentAst,
  resolveDocumentAnchor,
} from "@stll/legal-ast/document-ast";
import { OutlineRail } from "@stll/ui/outline-rail";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import { OutlineJumpField } from "@/components/legal-reader/outline-jump-field";
import {
  filterOutlineItems,
  findProvisionAnchorId,
  jumpToAnchor,
  parseOutlineJump,
  resolveAnchorPct,
  STATUTE_OUTLINE_COLLAPSE_LEVEL,
  statuteOutlineFromHeadings,
} from "@/components/legal-reader/reader-outline";
import { AnnotatedStatuteText } from "@/features/statutes/components/annotated-statute-text";
import { StatuteVersionMenu } from "@/features/statutes/components/statute-version-menu";
import { statuteCitationCountsOptions } from "@/features/statutes/queries/citing-decisions";
import { statuteVersionsOptions } from "@/features/statutes/queries/statutes";
import {
  prepareStatuteReader,
  provisionCitationCountByBlockAnchor,
} from "@/features/statutes/statute-reader-blocks";
import { useMountEffect } from "@/hooks/use-effect";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import {
  createStatuteRouteParams,
  normalizeStatuteStoredSlug,
  type StatuteRouteParams,
} from "@/lib/statute-route";
import type { PublicStatuteRouteData } from "@/routes/law/-statute-detail.logic";

type PublicStatuteViewerProps = PublicStatuteRouteData & {
  /** The day the reader asked about, while it is still being resolved. */
  asOf: string | undefined;
  /** A provision designation the URL asked the reader to open at. */
  requestedJump: string | undefined;
};

/**
 * The public statute reader. It renders whichever consolidation the route
 * resolved; picking another version or another day is a navigation, because
 * every consolidation has its own address.
 */
export const PublicStatuteViewer = ({
  asOf,
  requestedJump,
  statute,
  work,
}: PublicStatuteViewerProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const asOfLabelId = useId();
  const routeHash = useRouterState({ select: (state) => state.location.hash });
  const readerRef = useRef<HTMLDivElement>(null);
  const { data: versions } = useSuspenseQuery(statuteVersionsOptions(work.id));

  const header = statute ?? work;
  // Picking a day means going to that day's consolidation, and only the
  // readable segment can address one. A document the corpus holds no segment
  // for keeps the version menu, which switches by id.
  const canPickDate = normalizeStatuteStoredSlug(work.slug) !== null;

  const goTo = useCallback(
    (params: StatuteRouteParams, nextAsOf: string | undefined) => {
      const search = nextAsOf === undefined ? {} : { asOf: nextAsOf };

      detached(
        params.version === undefined
          ? navigate({
              params: { country: params.country, slug: params.slug },
              search,
              to: "/law/$country/statutes/$slug",
            })
          : navigate({
              params: {
                country: params.country,
                slug: params.slug,
                version: params.version,
              },
              search,
              to: "/law/$country/statutes/$slug/v/$version",
            }),
        "statutes.reader-navigate",
      );
    },
    [navigate],
  );

  const handleVersionChange = useCallback(
    (nextDocumentId: string) => {
      const next = versions.find((version) => version.id === nextDocumentId);

      if (next === undefined) {
        return;
      }

      goTo(
        createStatuteRouteParams({
          country: next.country,
          documentId: next.id,
          slug: next.slug,
          version: next.versionValidTo === null ? null : next.versionValidFrom,
        }),
        undefined,
      );
    },
    [goTo, versions],
  );

  const handleAsOfChange = useCallback(
    (value: string | null) => {
      // A day is a lookup, not an address: it is asked on the act's own page
      // and the loader forwards to the consolidation that applied.
      goTo(
        createStatuteRouteParams({
          country: header.country,
          documentId: work.id,
          slug: work.slug,
        }),
        value === null || value === "" ? undefined : value,
      );
    },
    [goTo, header.country, work.id, work.slug],
  );

  const [jumpValue, setJumpValue] = useState(requestedJump ?? "");
  // An unparseable or absent AST is a real state: the reader then renders
  // the plain fulltext instead of blocks.
  const ast = statute ? parseDocumentAst(statute.documentAst) : null;
  const preparedReader = prepareStatuteReader({
    blocks: ast === null ? [] : ast.blocks,
    statuteTitle: header.title,
  });
  const blocks = preparedReader.blocks;
  const outline = statuteOutlineFromHeadings(blocks);
  const jump = parseOutlineJump(jumpValue);
  const visibleOutline = filterOutlineItems(outline, jump);
  const jumpAnchorId = findProvisionAnchorId(outline, jump);

  // A jump named in the URL is honoured once, when the reader mounts with
  // the text already loaded; after that the field is the reader's own.
  useMountEffect(() => {
    const container = readerRef.current;

    if (
      requestedJump === undefined ||
      jumpAnchorId === null ||
      container === null
    ) {
      return;
    }

    jumpToAnchor(jumpAnchorId, container);
  });

  // Citation extractors state the local provision id (`cl_7`), while a
  // publisher may namespace it under a structural container
  // (`prilohy-cl_7`). Resolve that unambiguous suffix once the AST is present.
  useMountEffect(() => {
    const container = readerRef.current;
    const requestedAnchorId = routeHash.startsWith("#")
      ? routeHash.slice(1)
      : routeHash;
    if (container === null || requestedAnchorId === "") {
      return;
    }
    const resolved = resolveDocumentAnchor(blocks, requestedAnchorId);
    if (resolved === null || resolved.anchorId === requestedAnchorId) {
      return;
    }
    jumpToAnchor(resolved.anchorId, container);
  });

  // The keys a provision's incoming citations are filed under. Both come off
  // the document itself: nothing about the work is inferred here.
  const eli = statute?.eli.trim() ?? "";
  const jurisdiction = statute?.country.trim().toUpperCase() ?? "";
  const citationWork =
    eli === "" || jurisdiction === "" ? null : { eli, jurisdiction };
  const citationCounts = useQuery({
    ...statuteCitationCountsOptions(
      citationWork ?? { eli: "", jurisdiction: "" },
    ),
    enabled:
      citationWork !== null && typeof statute?.citationCaseCount === "number",
  });
  const provisionCitationCounts = provisionCitationCountByBlockAnchor(
    blocks,
    citationCounts.data?.status === "ready"
      ? citationCounts.data.provisions
      : [],
  );

  const sourceHref = statute
    ? (statute.documentUrl ?? statute.sourceUrl)
    : null;

  return (
    <main className="relative min-h-0 flex-1">
      <ChromeHeaderActions>
        {canPickDate && (versions.length > 1 || asOf !== undefined) && (
          <div className="flex min-w-0 items-center gap-1">
            <span
              className="text-muted-foreground sr-only text-xs xl:not-sr-only xl:shrink-0"
              id={asOfLabelId}
            >
              {t("statutes.asOf")}
            </span>
            <DatePickerPopover
              labelledBy={asOfLabelId}
              onChange={handleAsOfChange}
              placeholderLabel={t("common.today")}
              value={asOf ?? statute?.versionValidFrom ?? null}
            />
          </div>
        )}
        <StatuteVersionMenu
          currentVersionId={statute?.id ?? work.id}
          onVersionChange={handleVersionChange}
          versions={versions}
        />
        <OpenOriginalButton href={sourceHref} />
      </ChromeHeaderActions>
      {/* The rail hides itself when a document has no outline to show. */}
      <OutlineRail
        ariaLabel={t("statutes.outline")}
        // A narrowed outline opens whole: the entries a reader searched for
        // are the point, and folding them away again hides the answer.
        {...(jump.type === "empty"
          ? { collapsedFromLevel: STATUTE_OUTLINE_COLLAPSE_LEVEL }
          : {})}
        header={
          outline.length < 2 ? undefined : (
            <OutlineJumpField
              onJump={() => {
                const container = readerRef.current;

                if (jumpAnchorId === null || container === null) {
                  return;
                }

                jumpToAnchor(jumpAnchorId, container);
              }}
              onValueChange={setJumpValue}
              value={jumpValue}
            />
          )
        }
        items={visibleOutline}
        onJump={jumpToAnchor}
        resolvePct={resolveAnchorPct}
        scrollContainerRef={readerRef}
      />
      <div className="reader-scroll h-full overflow-y-auto" ref={readerRef}>
        <div
          className="flex flex-col gap-4 py-6"
          data-slot="reader-document-column"
        >
          {statute === null ? (
            <p className="text-muted-foreground py-16 text-center text-sm">
              {t("statutes.noVersionInForce")}
            </p>
          ) : (
            <AnnotatedStatuteText
              blocks={blocks}
              citationWork={citationWork}
              country={statute.country}
              documentId={statute.id}
              eli={statute.eli}
              fulltext={statute.fulltext}
              language={statute.language}
              masthead={preparedReader.masthead}
              provisionCitationCounts={provisionCitationCounts}
              scrollContainerRef={readerRef}
              statuteTitle={statute.title}
              versionCount={versions.length}
              versionValidFrom={statute.versionValidFrom}
            />
          )}
        </div>
      </div>
    </main>
  );
};
