import { useCallback, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { OutlineRail } from "@stll/ui/components/outline-rail";

import { OutlineJumpField } from "@/components/legal-reader/outline-jump-field";
import {
  filterOutlineItems,
  findProvisionAnchorId,
  jumpToAnchor,
  outlineFromHeadings,
  parseOutlineJump,
  resolveAnchorPct,
  STATUTE_OUTLINE_COLLAPSE_LEVEL,
  withProvisionRanges,
} from "@/components/legal-reader/reader-outline";
import { StatuteStatusPill } from "@/features/statutes/components/statute-status-pill";
import { StatuteText } from "@/features/statutes/components/statute-text";
import { StatuteVersionSwitcher } from "@/features/statutes/components/statute-version-switcher";
import {
  statuteOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import {
  EM_DASH,
  formatValidityDate,
} from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicLawCanonicalUrl,
  createPublicLawHead,
  createStatuteJsonLd,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { sanitizeHref } from "@/lib/sanitize-href";
import {
  createStatutePath,
  toStatuteCountrySegment,
} from "@/lib/statute-route";

export const Route = createFileRoute("/law/$country/statutes/$documentId")({
  loader: async ({ context: { queryClient }, params }) => {
    // Both reads start here so the version list never waits on the document.
    const [statute] = await Promise.all([
      ensureRouteQueryData(queryClient, statuteOptions(params.documentId)),
      ensureRouteQueryData(
        queryClient,
        statuteVersionsOptions(params.documentId),
      ),
    ]);

    return statute;
  },
  head: ({ loaderData, params }) => {
    if (!loaderData) {
      return { meta: [] };
    }

    const path = createStatutePath({
      country: loaderData.country,
      documentId: params.documentId,
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
  const t = useTranslations();
  const format = useFormatter();
  const documentId = Route.useParams({ select: (params) => params.documentId });
  const navigate = Route.useNavigate();

  const { data: statute } = useSuspenseQuery(statuteOptions(documentId));
  const { data: versions } = useSuspenseQuery(
    statuteVersionsOptions(documentId),
  );

  const handleVersionChange = useCallback(
    (nextDocumentId: string) => {
      detached(
        navigate({
          params: {
            country: toStatuteCountrySegment(statute.country),
            documentId: nextDocumentId,
          },
          to: "/law/$country/statutes/$documentId",
        }),
        "statutes.version-change",
      );
    },
    [navigate, statute.country],
  );

  const readerRef = useRef<HTMLDivElement>(null);
  const [jumpValue, setJumpValue] = useState("");
  // An unparseable or absent AST is a real state: the reader then renders
  // the plain fulltext instead of blocks.
  const ast = parseDocumentAst(statute.documentAst);
  const blocks = ast ? ast.blocks : [];
  const outline = withProvisionRanges(outlineFromHeadings(blocks));
  const jump = parseOutlineJump(jumpValue);
  const visibleOutline = filterOutlineItems(outline, jump);
  const jumpAnchorId = findProvisionAnchorId(outline, jump);

  // The keys a provision's incoming citations are filed under. Both come off
  // the document itself: nothing about the work is inferred here.
  const eli = statute.eli.trim();
  const jurisdiction = statute.country.trim().toUpperCase();
  const citationWork =
    eli === "" || jurisdiction === "" ? null : { eli, jurisdiction };

  const validFrom = formatValidityDate(statute.versionValidFrom, format);
  const validTo = formatValidityDate(statute.versionValidTo, format);
  const sourceHref = statute.documentUrl ?? statute.sourceUrl;

  return (
    <main className="relative min-h-0 flex-1">
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
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          <header className="flex flex-col gap-3 border-b pb-4">
            <h1 className="text-xl font-semibold">{statute.title}</h1>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
              <span>{statute.eli}</span>
              <StatuteStatusPill status={statute.status} />
              <span>
                {t("statutes.validity", {
                  from: validFrom ?? EM_DASH,
                  to: validTo ?? t("statutes.openEnded"),
                })}
              </span>
              {sanitizeHref(sourceHref) !== undefined && (
                <a
                  className="underline underline-offset-2"
                  href={sanitizeHref(sourceHref)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t("common.viewSource")}
                </a>
              )}
            </div>
            <StatuteVersionSwitcher
              currentVersionId={statute.id}
              onVersionChange={handleVersionChange}
              versions={versions}
            />
            <Link
              className="text-muted-foreground hover:text-foreground w-fit text-xs underline underline-offset-2"
              params={{ country: toStatuteCountrySegment(statute.country) }}
              to="/law/$country/statutes"
            >
              {t("statutes.backToList")}
            </Link>
          </header>

          <StatuteText
            blocks={blocks}
            citationWork={citationWork}
            fulltext={statute.fulltext}
            language={statute.language}
          />
        </div>
      </div>
    </main>
  );
}
