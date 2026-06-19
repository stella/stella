import { Link } from "@tanstack/react-router";
import { useFormatter, useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";

import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

// Stable keys so loading rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const SKELETON_CELL_KEYS = [
  "caseNumber",
  "court",
  "country",
  "date",
  "type",
] as const;

export const DecisionTable = ({ decisions, isLoading }: DecisionTableProps) => {
  const t = useTranslations();
  const format = useFormatter();

  if (!isLoading && decisions.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        {t("caseLaw.emptyState")}
      </p>
    );
  }

  return (
    <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border/45 bg-muted/35 border-b">
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("caseLaw.columns.caseNumber")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("caseLaw.columns.court")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.country")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.date")}
              </th>
              <th
                className="text-muted-foreground px-4 py-2 text-start font-medium"
                scope="col"
              >
                {t("common.type")}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? SKELETON_ROW_KEYS.map((rowKey) => (
                  <tr
                    className="border-border/35 border-b last:border-b-0"
                    key={rowKey}
                  >
                    {SKELETON_CELL_KEYS.map((cellKey) => (
                      <td className="px-4 py-2" key={cellKey}>
                        <Skeleton className="h-4 w-3/5" />
                      </td>
                    ))}
                  </tr>
                ))
              : decisions.map((decision) => (
                  <tr
                    className="border-border/35 hover:bg-muted/30 border-b last:border-b-0"
                    key={decision.id}
                  >
                    <td className="px-4 py-2">
                      {renderCaseNumberCell(decision)}
                    </td>
                    <td className="px-4 py-2">{decision.court}</td>
                    <td className="px-4 py-2">
                      {renderCountryCell(decision.country)}
                    </td>
                    <td className="px-4 py-2">
                      {formatDecisionDate(decision.decisionDate, format)}
                    </td>
                    <td className="px-4 py-2">
                      {decision.decisionType ?? "\u2014"}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export type Decision = {
  id: string;
  caseNumber: string;
  slug?: string | null;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  languageAlternateCount?: number | null;
  languageGroupKey?: string | null;
  decisionDate: Date | string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  headline?: string | null;
  createdAt: Date | string;
};

type DecisionTableProps = {
  decisions: Decision[];
  isLoading: boolean;
};

type IntlFormatter = ReturnType<typeof useFormatter>;

const renderCaseNumberCell = (decision: Decision) => {
  const {
    caseNumber,
    country,
    court,
    headline,
    language,
    languageAlternateCount,
    slug,
  } = decision;
  const routeParams = createCaseLawDecisionRouteParams({
    caseNumber,
    country,
    court,
    language,
    languageAlternateCount,
    slug,
  });

  return (
    <div>
      {routeParams.language ? (
        <Link
          className="text-foreground font-medium hover:underline"
          params={{
            country: routeParams.country,
            court: routeParams.court,
            language: routeParams.language,
            slug: routeParams.slug,
          }}
          to="/law/$country/cases/$court/$language/$slug"
        >
          {caseNumber}
        </Link>
      ) : (
        <Link
          className="text-foreground font-medium hover:underline"
          params={{
            country: routeParams.country,
            court: routeParams.court,
            slug: routeParams.slug,
          }}
          to="/law/$country/cases/$court/$slug"
        >
          {caseNumber}
        </Link>
      )}
      {headline && (
        <p
          className="text-muted-foreground [&_mark]:text-foreground [&_mark]:bg-warning/30 dark:[&_mark]:bg-warning/20 mt-0.5 line-clamp-2 text-xs [&_mark]:font-medium"
          dangerouslySetInnerHTML={{
            // safe-html: server-escaped + <mark>-highlighted by escapeAndHighlight() in the case-law decisions search handler
            __html: headline,
          }}
        />
      )}
    </div>
  );
};

const renderCountryCell = (country: string) => (
  <span className="bg-muted rounded px-1.5 py-0.5 text-xs">{country}</span>
);

const formatDecisionDate = (
  value: Decision["decisionDate"],
  format: IntlFormatter,
): string => {
  if (value === null) {
    return "\u2014";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "\u2014";
  }
  return format.dateTime(date, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
};
