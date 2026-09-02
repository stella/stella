import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { CaseLawBrowseFacets } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";

/** The slice of the results route's search a browse link writes. */
type BrowseSearch = {
  country?: string;
  court?: string;
  year?: string;
};

/**
 * The crawlable way into the corpus: every country, court and year the facets
 * report, as links into the results route. Rendered below the fold on the
 * home and on the results screen, so a crawler reaches the same slices from
 * either entry point.
 */
export const CaseLawBrowseLinks = ({
  facets,
}: {
  facets: CaseLawBrowseFacets;
}) => {
  const t = useTranslations();

  if (
    facets.country.length === 0 &&
    facets.court.length === 0 &&
    facets.year.length === 0
  ) {
    return null;
  }

  return (
    <nav
      aria-label={t("caseLaw.seo.browse")}
      className="border-border/45 bg-background/60 grid gap-4 border-y py-4 text-sm md:grid-cols-3"
    >
      <BrowseGroup
        buckets={facets.country}
        createSearch={(value) => ({ country: value.toLowerCase() })}
        title={t("caseLaw.seo.countries")}
      />
      <BrowseGroup
        buckets={facets.court}
        createSearch={(value) => ({ court: value })}
        title={t("caseLaw.seo.courts")}
      />
      <BrowseGroup
        buckets={facets.year}
        createSearch={(value) => ({ year: value })}
        title={t("caseLaw.seo.years")}
      />
    </nav>
  );
};

const BrowseGroup = ({
  buckets,
  createSearch,
  title,
}: {
  buckets: readonly { count: number; value: string }[];
  createSearch: (value: string) => BrowseSearch;
  title: string;
}) => {
  const format = useFormatter();
  if (buckets.length === 0) {
    return null;
  }

  return (
    <section className="min-w-0">
      <h2 className="text-foreground mb-2 text-sm font-medium">{title}</h2>
      <ul className="space-y-1">
        {buckets.map((bucket) => (
          <li className="flex min-w-0 items-baseline gap-2" key={bucket.value}>
            <Link
              className="text-primary min-w-0 truncate hover:underline"
              search={createSearch(bucket.value)}
              to="/law/cases"
            >
              {bucket.value}
            </Link>
            <span className="text-muted-foreground shrink-0 text-xs">
              {format.number(bucket.count)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};
