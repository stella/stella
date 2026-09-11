import { useCallback, useId, useRef, useState } from "react";

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  parseDocumentAst,
  resolveDocumentAnchor,
} from "@stll/legal-ast/document-ast";
import { parsePlainDate } from "@stll/time";
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
import { StatuteText } from "@/features/statutes/components/statute-text";
import { StatuteVersionMenu } from "@/features/statutes/components/statute-version-menu";
import { statuteCitationCountsOptions } from "@/features/statutes/queries/citing-decisions";
import {
  statuteAsOfOptions,
  statuteOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import type {
  PublicStatute,
  PublicStatuteVersion,
} from "@/features/statutes/queries/statutes";
import {
  prepareStatuteReader,
  provisionCitationCountByBlockAnchor,
} from "@/features/statutes/statute-reader-blocks";
import { useMountEffect } from "@/hooks/use-effect";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicLawCanonicalUrl,
  createPublicLawHead,
  createStatuteJsonLd,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  createStatutePath,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

/**
 * A calendar day, not merely a date-shaped string: `2026-02-30` matches the
 * pattern and is not a day, and the reader must not ask the corpus for it.
 */
const isCalendarDate = (value: string): boolean =>
  parsePlainDate(value) !== null;

/**
 * `asOf` names the day whose law the reader wants. Anything else is dropped
 * rather than rejected: a mistyped link should still open the act.
 */
const searchSchema = v.object({
  asOf: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => (isCalendarDate(value) ? value : undefined)),
    ),
  ),
  /**
   * A provision designation to open at (`§ 2079`), as the statutes box sends
   * it. Read by the outline's jump field; anything it cannot parse just
   * narrows nothing.
   */
  jump: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(32),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  ),
});

export const Route = createFileRoute("/law/$country/statutes/$documentId")({
  validateSearch: searchSchema,
  loaderDeps: ({ search: { asOf } }) => ({ asOf }),
  loader: async ({ context: { queryClient }, deps: { asOf }, params }) => {
    // The version list is needed either way, and it carries the work key the
    // point-in-time read is addressed by.
    const versions = ensureRouteQueryData(
      queryClient,
      statuteVersionsOptions(params.documentId),
    );

    if (asOf === undefined) {
      const [statute] = await Promise.all([
        ensureRouteQueryData(queryClient, statuteOptions(params.documentId)),
        versions,
      ]);

      return statute;
    }

    const work = (await versions).at(0);

    // One document read either way: with a date it is the point-in-time read
    // that runs, not an extra one.
    return work === undefined
      ? await ensureRouteQueryData(
          queryClient,
          statuteOptions(params.documentId),
        )
      : await ensureRouteQueryData(
          queryClient,
          statuteAsOfOptions({ asOf, eli: work.eli, language: work.language }),
        );
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return { meta: [] };
    }

    // The canonical URL names the consolidation on screen, which a dated
    // request need not be the one the path was entered with.
    const path = createStatutePath({
      country: loaderData.country,
      documentId: loaderData.id,
    });
    const canonicalUrl = createPublicLawCanonicalUrl(path);

    return createPublicLawHead({
      description: loaderData.title,
      jsonLd: createStatuteJsonLd({
        canonicalUrl,
        country: loaderData.country,
        documentType: loaderData.documentType,
        eli: loaderData.eli,
        language: loaderData.language,
        sourceUrl: loaderData.sourceUrl,
        title: loaderData.title,
        versionValidFrom: loaderData.versionValidFrom,
      }),
      path,
      title: pageTitleLiteral(loaderData.title),
      type: "article",
    });
  },
  component: PublicStatuteRoute,
});

function PublicStatuteRoute() {
  const documentId = Route.useParams({ select: (params) => params.documentId });
  const asOf = Route.useSearch({ select: (search) => search.asOf });
  const { data: versions } = useSuspenseQuery(
    statuteVersionsOptions(documentId),
  );
  const work = versions.at(0);

  if (asOf === undefined || work === undefined) {
    return <StatuteAtVersion documentId={documentId} versions={versions} />;
  }

  return (
    <StatuteAtDate
      asOf={asOf}
      documentId={documentId}
      eli={work.eli}
      language={work.language}
      work={work}
      versions={versions}
    />
  );
}

type StatuteAtVersionProps = {
  documentId: string;
  versions: readonly PublicStatuteVersion[];
};

/** The consolidation the path names. */
const StatuteAtVersion = ({ documentId, versions }: StatuteAtVersionProps) => {
  const { data: statute } = useSuspenseQuery(statuteOptions(documentId));

  return (
    <StatuteReader
      documentId={documentId}
      statute={statute}
      versions={versions}
      work={statute}
    />
  );
};

type StatuteAtDateProps = StatuteAtVersionProps & {
  asOf: string;
  eli: string;
  language: string;
  work: PublicStatuteVersion;
};

/** The consolidation that applied on the requested day. */
const StatuteAtDate = ({
  asOf,
  documentId,
  eli,
  language,
  versions,
  work,
}: StatuteAtDateProps) => {
  const { data: statute } = useSuspenseQuery(
    statuteAsOfOptions({ asOf, eli, language }),
  );

  return (
    <StatuteReader
      documentId={documentId}
      statute={statute}
      versions={versions}
      work={work}
    />
  );
};

type StatuteReaderProps = {
  documentId: string;
  /** Null when no consolidation of the Work covers the requested day. */
  statute: PublicStatute | null;
  versions: readonly PublicStatuteVersion[];
  /**
   * What the Work is known by. It carries the chrome (title, identifier,
   * jurisdiction) while no text is resolved, and is the consolidation itself
   * whenever one is.
   */
  work: PublicStatute | PublicStatuteVersion;
};

const StatuteReader = ({
  documentId,
  statute,
  versions,
  work,
}: StatuteReaderProps) => {
  const t = useTranslations();
  const navigate = Route.useNavigate();
  const asOfLabelId = useId();
  const asOf = Route.useSearch({ select: (search) => search.asOf });
  const requestedJump = Route.useSearch({ select: (search) => search.jump });
  const routeHash = useRouterState({
    select: (state) => state.location.hash,
  });
  const readerRef = useRef<HTMLDivElement>(null);

  const header = statute ?? work;

  const goTo = useCallback(
    (nextDocumentId: string, nextAsOf: string | undefined) => {
      detached(
        navigate({
          params: {
            country: toStatuteCountrySegment(header.country),
            documentId: nextDocumentId,
          },
          search: nextAsOf === undefined ? {} : { asOf: nextAsOf },
          to: "/law/$country/statutes/$documentId",
        }),
        "statutes.reader-navigate",
      );
    },
    [header.country, navigate],
  );

  const handleVersionChange = useCallback(
    (nextDocumentId: string) => {
      const next = versions.find((version) => version.id === nextDocumentId);

      // Picking a version is also picking a day: its window opening.
      goTo(nextDocumentId, next?.versionValidFrom ?? undefined);
    },
    [goTo, versions],
  );

  const handleAsOfChange = useCallback(
    (value: string | null) => {
      goTo(documentId, value === null || value === "" ? undefined : value);
    },
    [documentId, goTo],
  );

  const [jumpValue, setJumpValue] = useState(requestedJump ?? "");
  // An unparseable or absent AST is a real state: the reader then renders
  // the plain fulltext instead of blocks.
  const ast = statute ? parseDocumentAst(statute.documentAst) : null;
  const preparedReader = prepareStatuteReader({
    blocks: ast?.blocks ?? [],
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
        {(versions.length > 1 || asOf !== undefined) && (
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
              value={asOf ?? null}
            />
          </div>
        )}
        <StatuteVersionMenu
          currentVersionId={statute?.id ?? documentId}
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
            <StatuteText
              blocks={blocks}
              citationWork={citationWork}
              documentId={statute.id}
              fulltext={statute.fulltext}
              language={statute.language}
              masthead={preparedReader.masthead}
              provisionCitationCounts={provisionCitationCounts}
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
