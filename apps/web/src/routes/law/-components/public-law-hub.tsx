import type { PropsWithChildren, ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";

import type { CaseLawBrowseTarget } from "@/lib/case-law-browse-path";
import { createCaseLawBrowsePath } from "@/lib/case-law-browse-path";

/**
 * The crawlable hubs of the public law database: a heading, one sentence,
 * and plain server-rendered links to the next level down. No client state:
 * the page is complete in the server's HTML.
 */

const LINK_CLASS =
  "hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm underline-offset-2 hover:underline focus-visible:ring-2";

export const PublicLawHubLayout = ({
  children,
  crumbs,
  description,
  title,
}: PropsWithChildren<{
  crumbs?: ReactNode;
  description: string;
  title: string;
}>) => (
  <main className="flex min-h-0 flex-1 flex-col">
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-3 sm:p-6">
        {crumbs}
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold wrap-break-word">{title}</h1>
          <p className="text-muted-foreground text-sm">{description}</p>
        </header>
        {children}
      </div>
    </ScrollArea>
  </main>
);

export const PublicLawHubSection = ({
  children,
  heading,
}: PropsWithChildren<{ heading: string }>) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {heading}
    </h2>
    <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </ul>
  </section>
);

type BrowseLinkProps = PropsWithChildren<{
  countryParam: string;
  target: CaseLawBrowseTarget;
}>;

/** A link into the browse tree, rendered as a plain `<a href>`. */
export const CaseLawBrowseLink = ({
  children,
  countryParam,
  target,
}: BrowseLinkProps) => {
  const prefix = `/law/${countryParam}/courts/`;
  const splat = createCaseLawBrowsePath(countryParam, target).slice(
    prefix.length,
  );
  return (
    <Link
      className={LINK_CLASS}
      params={{ country: countryParam, _splat: splat }}
      to="/law/$country/courts/$"
    >
      {children}
    </Link>
  );
};

export const PublicLawHubItem = ({
  children,
  meta,
}: PropsWithChildren<{ meta?: string | null }>) => (
  <li className="flex min-w-0 items-baseline gap-2">
    {children}
    {meta ? (
      <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>
    ) : null}
  </li>
);

type PagerProps = {
  countryParam: string;
  /** The listing's first page; the pager links its siblings. */
  target: Extract<CaseLawBrowseTarget, { page: number }>;
  hasNext: boolean;
};

/**
 * Numbered links to every page before this one and to the next, so each
 * page of a period is one link from its predecessor and the first page is
 * one link from all of them.
 */
export const CaseLawBrowsePager = ({
  countryParam,
  hasNext,
  target,
}: PagerProps) => {
  const t = useTranslations();
  const pages = Array.from(
    { length: target.page + (hasNext ? 1 : 0) },
    (_, index) => index + 1,
  );
  if (pages.length <= 1) {
    return null;
  }
  return (
    <nav
      aria-label={t("caseLaw.pagination.label")}
      className="flex flex-wrap gap-1"
    >
      {pages.map((page) =>
        page === target.page ? (
          <span
            aria-current="page"
            className="bg-muted inline-flex min-h-11 items-center rounded-md px-3 text-sm"
            key={page}
          >
            {t("common.page", { page })}
          </span>
        ) : (
          <CaseLawBrowseLink
            countryParam={countryParam}
            key={page}
            target={{ ...target, page }}
          >
            {t("common.page", { page })}
          </CaseLawBrowseLink>
        ),
      )}
    </nav>
  );
};

/** The trail of hubs above a page: jurisdiction, court, year, month. */
export const PublicLawHubCrumbs = ({
  items,
}: {
  items: readonly { key: string; link: ReactNode }[];
}) => (
  <nav className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
    {items.map(({ key, link }, index) => (
      <span className="inline-flex items-center gap-1" key={key}>
        {index > 0 ? <span aria-hidden="true">/</span> : null}
        {link}
      </span>
    ))}
  </nav>
);
