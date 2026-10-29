import type { UseQueryResult } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import { createStatuteRouteParams } from "@stll/api-contract/statute-route";
import { Button } from "@stll/ui/button";
import { CommandItem } from "@stll/ui/command";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { LandingItemText } from "@stll/ui/landing";
import { MenuSection } from "@stll/ui/menu-section";
import { Skeleton } from "@stll/ui/skeleton";

import { preferredDecisionTarget } from "@/features/case-law/decision-cell-target.logic";
import { PUBLIC_DECISION_MATCH } from "@/features/case-law/public-decision-match";
import { detached } from "@/lib/detached";
import type { readLegalCitationSearch } from "@/lib/legal-citation-search";

type CitationSearchResult = Awaited<ReturnType<typeof readLegalCitationSearch>>;

export const citationCommandHits = (
  result: CitationSearchResult | undefined,
) => {
  switch (result?.type) {
    case "decisions":
      return result.items.map((decision) => ({
        type: "legal-citation" as const,
        id: `citation-decision:${decision.id}`,
        title: decision.caseNumber,
        match: {
          type: "decision" as const,
          decision,
          resolution: result.resolution,
        },
      }));
    case "statutes":
      return result.items.map((statute) => ({
        type: "legal-citation" as const,
        id: `citation-statute:${statute.id}`,
        title: statute.title,
        match: { type: "statute" as const, statute, intent: result.intent },
      }));
    case "none":
    case undefined:
      return [];
    default:
      result satisfies never;
      return panic("Unknown citation search result");
  }
};

type CitationCommandHit = ReturnType<typeof citationCommandHits>[number];

export const citationCommandRoute = (
  hit: CitationCommandHit,
  uiLocale: string,
) => {
  const { match } = hit;
  switch (match.type) {
    case "decision": {
      const params = createCaseLawDecisionRouteParams(
        preferredDecisionTarget(match.decision, { uiLocale }),
      );
      const search =
        match.resolution.status === "incomplete_identifier"
          ? { match: PUBLIC_DECISION_MATCH.FILE_INCOMPLETE }
          : {};
      return params.language === undefined
        ? ({
            to: "/law/$country/cases/$court/$slug",
            params: {
              country: params.country,
              court: params.court,
              slug: params.slug,
            },
            search,
          } as const)
        : ({
            to: "/law/$country/cases/$court/$language/$slug",
            params: {
              country: params.country,
              court: params.court,
              slug: params.slug,
              language: params.language,
            },
            search,
          } as const);
    }
    case "statute":
      return {
        to: "/law/$country/statutes/$slug",
        params: createStatuteRouteParams({
          country: match.statute.country,
          documentId: match.statute.id,
          eli: match.statute.eli,
          slug: match.statute.slug,
          version: null,
        }),
        search:
          match.intent.provision === null
            ? {}
            : { jump: match.intent.provision },
      } as const;
    default:
      match satisfies never;
      return panic("Unknown citation command target");
  }
};

export const SearchCitationResults = ({
  hits,
  onOpen,
  query,
  enabled,
}: {
  hits: readonly CitationCommandHit[];
  query: UseQueryResult<CitationSearchResult>;
  enabled: boolean;
  onOpen: (hit: CitationCommandHit) => void;
}) => {
  const t = useTranslations();
  if (!enabled) {
    return null;
  }
  return (
    <>
      {query.isPending && (
        <div
          aria-label={t("common.loading")}
          className="space-y-1 px-4 py-2"
          role="status"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
      )}
      {query.isError && (
        <div className="px-4 py-2" role="alert">
          <p className="text-muted-foreground text-sm">
            {t("common.somethingWentWrong")}
          </p>
          <Button
            onClick={() => detached(query.refetch(), "search-citation.retry")}
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {hits.length > 0 && (
        <MenuSection title={t("common.legalDatabase")}>
          {hits.map((hit, index) => (
            <CommandItem
              index={index}
              key={hit.id}
              onClick={() => onOpen(hit)}
              size="row"
              value={hit}
            >
              <LandingItemText
                icon={
                  hit.match.type === "decision" ? (
                    <DocumentIdentityBadge
                      identity={{
                        kind: "decision",
                        courtAbbreviation: hit.match.decision.courtAbbreviation,
                        courtTier: hit.match.decision.courtTier,
                      }}
                    />
                  ) : (
                    <DocumentIdentityBadge
                      identity={{
                        kind: "statute",
                        number: hit.match.intent.number,
                        year: hit.match.intent.year,
                      }}
                    />
                  )
                }
                title={hit.title}
                meta={
                  hit.match.type === "decision"
                    ? hit.match.decision.court
                    : null
                }
              />
            </CommandItem>
          ))}
        </MenuSection>
      )}
    </>
  );
};
