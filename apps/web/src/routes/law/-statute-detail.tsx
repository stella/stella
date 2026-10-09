import { lazy, Suspense, useCallback, useId, useRef, useState } from "react";
import type { ReactElement } from "react";

import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  createStatuteRouteParams,
  normalizeStatuteStoredSlug,
  splitStatuteTitleCitation,
  type StatuteRouteParams,
} from "@stll/api-contract/statute-route";
import {
  jumpToAnchor,
  resolveAnchorPct,
  STATUTE_OUTLINE_COLLAPSE_LEVEL,
  statuteOutlineFromHeadings,
} from "@stll/decision-reader/reader-outline";
import {
  parseDocumentAst,
  resolveDocumentAnchor,
} from "@stll/legal-ast/document-ast";
import { OutlineRail, outlineEntryText } from "@stll/ui/outline-rail";
import { Separator } from "@stll/ui/separator";
import { Skeleton } from "@stll/ui/skeleton";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { DatePickerPopover } from "@/components/date-picker-popover";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import { OutlineJumpField } from "@/components/legal-reader/outline-jump-field";
import {
  clampSelectedIndex,
  outlineMatchItems,
  rankOutlineMatches,
} from "@/components/legal-reader/outline-jump-field.logic";
import { useLawHistory } from "@/features/law-search-history/law-search-history-query";
import {
  StatuteIneligibleVersionNotice,
  StatuteWindowGapNotice,
} from "@/features/statutes/components/statute-expression-notice";
import { StatuteReaderBody } from "@/features/statutes/components/statute-reader-body";
import { StatuteVersionMenu } from "@/features/statutes/components/statute-version-menu";
import {
  NO_STATUTE_COMPARE,
  STATUTE_COMPARE_SHOW,
} from "@/features/statutes/statute-compare-search";
import type { StatuteCompareSearch } from "@/features/statutes/statute-compare-search";
import { prepareStatuteReader } from "@/features/statutes/statute-reader-blocks";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { statuteVersionRouteParams } from "@/routes/law/-statute-detail.logic";
import type { PublicStatuteRouteData } from "@/routes/law/-statute-detail.logic";

// The comparison runs Folio's content diff over two whole consolidations;
// the reader loads neither the engine nor the view until one is asked for.
const LazyStatuteCompareView = lazy(async () => {
  const module =
    await import("@/features/statutes/components/statute-compare-view");
  return { default: module.StatuteCompareView };
});

const LazyAuthenticatedStatuteChat = lazy(async () => {
  const module = await import("./-authenticated-statute-chat");
  return { default: module.AuthenticatedStatuteChat };
});

type OutlineJumpState = {
  /** What the reader typed; empty is the outline as the act states it. */
  query: string;
  /** Which of the ranked matches the field's selection is on. */
  selectedIndex: number;
};

/**
 * The reader's answer for a day no version was in force on: why, when the
 * publisher's own inconsistent dates are the reason.
 */
const NoVersionOnDay = ({
  windowGap,
}: Pick<PublicStatuteRouteData, "windowGap">) => {
  const t = useTranslations();

  return windowGap === null ? (
    <p className="text-muted-foreground py-16 text-center text-sm">
      {t("statutes.noVersionInForce")}
    </p>
  ) : (
    <div className="py-16">
      <StatuteWindowGapNotice versions={windowGap} />
    </div>
  );
};

type PublicStatuteViewerProps = PublicStatuteRouteData & {
  /** The day the reader asked about, while it is still being resolved. */
  asOf: string | undefined;
  /** Another consolidation to set beside this one, from the URL. */
  comparison: StatuteCompareSearch;
  /** A provision designation the URL asked the reader to open at. */
  requestedJump: string | undefined;
  searchQuery: string | undefined;
};

/**
 * The chat over the wording. Without a version in force there is nothing to
 * bind it to; a signed-in reader loads the full chat lazily behind the gated
 * composer, everyone else gets the public one.
 */
const StatuteReaderChat = ({
  activeLegal,
  children,
  signedIn,
}: {
  activeLegal: ActiveLegalDocument | null;
  children: ReactElement;
  signedIn: boolean;
}) => {
  if (activeLegal === null) {
    return children;
  }
  if (!signedIn) {
    return (
      <LegalReaderAIChat
        activeLegal={activeLegal}
        aiMode="gated"
        className="h-full"
      >
        {children}
      </LegalReaderAIChat>
    );
  }
  return (
    <Suspense
      fallback={
        <FileViewerWithAI
          activeLegal={activeLegal}
          className="h-full"
          overlayActivation={FILE_CHAT_OVERLAY_ACTIVATION.gated}
        >
          {children}
        </FileViewerWithAI>
      }
    >
      <LazyAuthenticatedStatuteChat activeLegal={activeLegal}>
        {children}
      </LazyAuthenticatedStatuteChat>
    </Suspense>
  );
};

/**
 * Records the act in the reader's recent law, titled `number/year · title`
 * when the stored title carries no citation of its own.
 */
const useRecordStatuteOpen = ({
  eli,
  title,
}: {
  eli: string;
  title: string;
}) => {
  const openedPath = useRouterState({
    select: ({ location }) => location.pathname,
  });
  const {
    record: { mutate: recordHistory },
    enabled: historyEnabled,
  } = useLawHistory();
  useExternalSyncEffect(() => {
    if (!historyEnabled) {
      return;
    }
    const citation = splitStatuteTitleCitation(title).citation;
    const eliCitation = /\/(\d{4})\/(\d+)$/u.exec(eli);
    const year = eliCitation?.at(1);
    const number = eliCitation?.at(2);
    recordHistory({
      kind: "statute",
      documentId: eli,
      documentIdentity:
        number === undefined || year === undefined
          ? { kind: "unknown" }
          : { kind: "statute", number, year },
      title:
        citation !== null || year === undefined || number === undefined
          ? title
          : `${number}/${year} · ${title}`,
      path: openedPath,
    });
  }, [historyEnabled, recordHistory, title, eli, openedPath]);
};

/**
 * The public statute reader. It renders whichever consolidation the route
 * resolved; picking another version or another day is a navigation, because
 * every consolidation has its own address.
 */
export const PublicStatuteViewer = ({
  asOf,
  comparison,
  requestedJump,
  searchQuery,
  statute,
  versions,
  windowGap,
  work,
}: PublicStatuteViewerProps) => {
  const user = useMaybeAuthenticatedUser();
  const t = useTranslations();
  const navigate = useNavigate();
  const asOfLabelId = useId();
  const routeHash = useRouterState({ select: (state) => state.location.hash });
  const readerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const header = statute ?? work;
  useRecordStatuteOpen({ eli: work.eli, title: header.title });
  const find = useInspectorFind({
    contentRef,
    enabled: statute !== null && comparison.compare === undefined,
    highlightKey: `statute-page-${header.id}`,
    initialQuery: searchQuery,
    panelRef,
  });

  // Picking a day means going to that day's consolidation, and only the
  // readable segment can address one. A document the corpus holds no segment
  // for keeps the version menu, which switches by id.
  const canPickDate = normalizeStatuteStoredSlug(work.slug) !== null;

  const goTo = useCallback(
    (params: StatuteRouteParams, nextAsOf: string | undefined) => {
      const search = { asOf: nextAsOf, q: find.findQuery || undefined };

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
    [find.findQuery, navigate],
  );

  const handleVersionChange = useCallback(
    (nextDocumentId: string) => {
      const next = versions.find((version) => version.id === nextDocumentId);

      if (next === undefined) {
        return;
      }

      // A version that cannot apply opens at its id: no day names it.
      goTo(
        statuteVersionRouteParams({ isDefault: next.isDefault, version: next }),
        undefined,
      );
    },
    [goTo, versions],
  );

  // A comparison is a view of the text on screen, not another address: it
  // lives in the search params, beside the path that names the text.
  const navigateComparison = useCallback(
    (next: StatuteCompareSearch) => {
      detached(
        navigate({
          search: (previous) => ({
            ...previous,
            compare: next.compare,
            provision: next.provision,
            show: next.show,
          }),
          to: ".",
        }),
        "statutes.reader-compare",
      );
    },
    [navigate],
  );

  const handleCompare = useCallback(
    (versionValidFrom: string) => {
      navigateComparison({ ...NO_STATUTE_COMPARE, compare: versionValidFrom });
    },
    [navigateComparison],
  );

  const handleAsOfChange = useCallback(
    (value: string | null) => {
      // A day is a lookup, not an address: it is asked on the act's own page
      // and the loader forwards to the consolidation that applied.
      goTo(
        createStatuteRouteParams({
          country: header.country,
          documentId: work.id,
          eli: work.eli,
          slug: work.slug,
          version: null,
        }),
        value === null || value === "" ? undefined : value,
      );
    },
    [goTo, header.country, work.eli, work.id, work.slug],
  );

  // The query and its selection move together: typing puts the selection
  // back on the best match, which is what Enter is expected to go to.
  const [jump, setJump] = useState<OutlineJumpState>({
    query: requestedJump ?? "",
    selectedIndex: 0,
  });
  // An unparseable or absent AST is a real state: the reader then renders
  // the plain fulltext instead of blocks.
  const ast = statute ? parseDocumentAst(statute.documentAst) : null;
  const preparedReader = prepareStatuteReader({
    blocks: ast === null ? [] : ast.blocks,
    statuteTitle: header.title,
  });
  const blocks = preparedReader.blocks;
  const outline = statuteOutlineFromHeadings(blocks);
  const outlineMatches = rankOutlineMatches(outline, jump.query);
  // Clamped where it is read, not where it is set: the list changes under the
  // selection whenever the reader edits the query or moves to another
  // consolidation with the field still filled.
  const selectedIndex = clampSelectedIndex({
    count: outlineMatches.matches.length,
    index: jump.selectedIndex,
  });
  const selectedMatch = outlineMatches.matches.at(selectedIndex) ?? null;
  // A query turns the panel into a ranked result list; an empty field leaves
  // the act's own structure, folded to its top tier.
  const isSearching = jump.query.trim().length > 0;
  const visibleOutline = isSearching
    ? outlineMatchItems(outlineMatches)
    : outline;

  // A jump named in the URL is honoured once, when the reader mounts with
  // the text already loaded; after that the field is the reader's own. Only a
  // designation the act actually holds moves the reader: a URL naming
  // something else leaves the page where it opened.
  useMountEffect(() => {
    const container = readerRef.current;

    if (
      requestedJump === undefined ||
      outlineMatches.exactId === null ||
      container === null
    ) {
      return;
    }

    jumpToAnchor(outlineMatches.exactId, container);
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

  const sourceHref = statute
    ? (statute.documentUrl ?? statute.sourceUrl)
    : null;

  // The consolidation the chat is bound to, so a question typed over the
  // wording carries the act the send endpoint selects provisions from. Null
  // while no version was in force on the day asked for: there is no document
  // to bind, and nothing to ask about.
  const activeLegal: ActiveLegalDocument | null =
    statute === null
      ? null
      : { type: "statute", documentId: statute.id, title: statute.title };

  const readerBody = (
    <div className="reader-scroll h-full overflow-y-auto" ref={readerRef}>
      <div
        className="flex flex-col gap-4 py-6"
        data-slot="reader-document-column"
        ref={contentRef}
      >
        {statute === null ? (
          <NoVersionOnDay windowGap={windowGap} />
        ) : (
          <>
            <StatuteIneligibleVersionNotice version={statute} />
            <StatuteReaderBody
              blocks={blocks}
              masthead={preparedReader.masthead}
              scrollContainerRef={readerRef}
              statute={statute}
              versionCount={versions.length}
            />
          </>
        )}
      </div>
    </div>
  );

  const readerWithChat = (
    <StatuteReaderChat activeLegal={activeLegal} signedIn={user !== null}>
      {readerBody}
    </StatuteReaderChat>
  );

  return (
    <main className="relative flex min-h-0 flex-1 flex-col" ref={panelRef}>
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
            {/* Two dates side by side read as one range without a rule
                between them: the date the reader asked for, then the
                version that answers it. */}
            <Separator className="mx-1 h-4" orientation="vertical" />
          </div>
        )}
        <StatuteVersionMenu
          currentVersionId={statute?.id ?? work.id}
          onCompare={handleCompare}
          onVersionChange={handleVersionChange}
          versions={versions}
        />
        <OpenOriginalButton href={sourceHref} />
      </ChromeHeaderActions>
      {comparison.compare !== undefined && statute !== null ? (
        <Suspense fallback={<Skeleton className="m-6 h-24" />}>
          <LazyStatuteCompareView
            compare={comparison.compare}
            onNavigate={navigateComparison}
            onScreen={statute}
            onScreenBlocks={ast === null ? null : ast.blocks}
            provision={comparison.provision}
            show={comparison.show ?? STATUTE_COMPARE_SHOW.changed}
            versions={versions}
          />
        </Suspense>
      ) : (
        <>
          <InspectorFindBar find={find} />
          <div className="relative min-h-0 flex-1">
            {/* The rail hides itself when a document has no outline to show. */}
            <OutlineRail
              ariaLabel={t("statutes.outline")}
              // While the field has a query, the panel points at the selected match
              // rather than at the scroll position, and the ranked list it shows is
              // flat, so there is nothing left to fold.
              {...(isSearching
                ? { activeId: selectedMatch?.item.id ?? null }
                : { collapsedFromLevel: STATUTE_OUTLINE_COLLAPSE_LEVEL })}
              header={
                outline.length < 2 ? undefined : (
                  <OutlineJumpField
                    matchCount={outlineMatches.matches.length}
                    onJump={() => {
                      const container = readerRef.current;

                      if (selectedMatch === null || container === null) {
                        return;
                      }

                      jumpToAnchor(selectedMatch.item.id, container);
                    }}
                    onSelectedIndexChange={(nextIndex) =>
                      setJump((previous) => ({
                        ...previous,
                        selectedIndex: nextIndex,
                      }))
                    }
                    onValueChange={(query) =>
                      setJump({ query, selectedIndex: 0 })
                    }
                    selectedIndex={selectedIndex}
                    selectedText={
                      selectedMatch === null
                        ? undefined
                        : outlineEntryText(selectedMatch.item)
                    }
                    value={jump.query}
                  />
                )
              }
              items={visibleOutline}
              onJump={(anchorId, container) => {
                // A result clicked in the panel becomes the selection: while the
                // field has a query the highlight is controlled from here, so
                // without this the clicked row scrolls the reader while the old one
                // stays marked and Enter goes back to it.
                const clicked = outlineMatches.matches.findIndex(
                  (match) => match.item.id === anchorId,
                );

                if (clicked !== -1) {
                  setJump((previous) => ({
                    ...previous,
                    selectedIndex: clicked,
                  }));
                }

                jumpToAnchor(anchorId, container);
              }}
              resolvePct={resolveAnchorPct}
              scrollContainerRef={readerRef}
            />
            {/* The composer floats over the wording here as it does over a
          decision, bound to this consolidation and so to its one
          conversation. A page with no version in force has no document to
          bind, so it keeps its text alone. */}
            {readerWithChat}
          </div>
        </>
      )}
    </main>
  );
};
