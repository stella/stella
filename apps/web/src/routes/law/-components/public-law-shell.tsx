import type { ReactElement } from "react";

import { Link, useMatches, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { toStatuteCountrySegment } from "@stll/api-contract/statute-route";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";
import { Separator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";
import { DecisionLanguageSelect } from "@/features/case-law/components/decision-language-select";
import { TopBarCitations } from "@/features/case-law/components/top-bar-citations";
import { TopBarCountry } from "@/features/case-law/components/top-bar-country";
import { ChromeHeaderActionsSlot } from "@/lib/chrome-header-actions";
import { PublicLawInspector } from "@/routes/law/-components/public-law-inspector";
import { useLawCrumbTrail } from "@/routes/law/-law-crumb-trail";
import { LawDocumentCrumbs } from "@/routes/law/-law-document-crumbs";

type PublicLawShellProps = {
  /** The routed page, unless the shell is standing in for one that loads. */
  content?: ReactElement | undefined;
};

export function PublicLawShell({ content }: PublicLawShellProps) {
  return (
    <PublicWorkspaceShell
      content={content}
      inspector={<PublicLawInspector />}
      topBar={<PublicLawTopBar />}
    />
  );
}

/** Which corpus a route belongs to, read from its id; the home belongs to neither. */
type LawSection = "coverage" | "decisions" | "statutes";

const sectionOfRoute = (routeId: string | undefined): LawSection | null => {
  if (routeId === undefined) {
    return null;
  }
  if (routeId.includes("/statutes")) {
    return "statutes";
  }
  if (routeId.includes("/cases")) {
    return "decisions";
  }
  if (routeId.includes("/coverage")) {
    return "coverage";
  }
  return null;
};

const CRUMB_LINK_CLASS = "hover:text-foreground shrink-0";
const CRUMB_ACTIVE_PROPS = { className: "text-foreground font-medium" };
const CRUMB_ACTIVE_OPTIONS = { exact: true, includeSearch: false };

function PublicLawTopBar() {
  const { isMobile } = useSidebar();

  return (
    <header className="bg-sidebar flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
      {isMobile && (
        <>
          <SidebarTrigger className="-ms-1" />
          <Separator className="me-2 h-4" orientation="vertical" />
        </>
      )}
      <PublicLawBreadcrumbs />
      <TopBarCitations />
      <TopBarCountry />
      <DecisionLanguageSelect />
      <ChromeHeaderActionsSlot />
    </header>
  );
}

/** The law shell owns the complete trail; the reader owns its sticky path. */
export function PublicLawBreadcrumbs() {
  const t = useTranslations();
  const section = useRouterState({
    select: (state) => sectionOfRoute(state.matches.at(-1)?.routeId),
  });
  const trail = useLawCrumbTrail();
  const country = useMatches({
    select: (matches) => {
      const params = matches.at(-1)?.params;
      return toStatuteCountrySegment(
        params !== undefined && "country" in params ? params.country : null,
      );
    },
  });

  return (
    <Breadcrumb className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <BreadcrumbList className="min-w-0 flex-1 flex-nowrap gap-1.5 overflow-hidden sm:gap-1.5">
        <BreadcrumbItem className={cn(trail !== null && "max-sm:hidden")}>
          <Link
            activeOptions={CRUMB_ACTIVE_OPTIONS}
            activeProps={CRUMB_ACTIVE_PROPS}
            className={CRUMB_LINK_CLASS}
            to="/law"
          >
            {t("common.legalDatabase")}
          </Link>
        </BreadcrumbItem>
        {section === "decisions" && (
          <>
            <BreadcrumbSeparator
              className={cn(trail !== null && "max-sm:hidden")}
            />
            <BreadcrumbItem className={cn(trail !== null && "max-sm:hidden")}>
              <Link
                activeOptions={CRUMB_ACTIVE_OPTIONS}
                activeProps={CRUMB_ACTIVE_PROPS}
                className={CRUMB_LINK_CLASS}
                to="/law/cases"
              >
                {t("common.caseLaw")}
              </Link>
            </BreadcrumbItem>
          </>
        )}
        {section === "statutes" && (
          <>
            <BreadcrumbSeparator
              className={cn(trail !== null && "max-sm:hidden")}
            />
            <BreadcrumbItem className={cn(trail !== null && "max-sm:hidden")}>
              <Link
                activeOptions={CRUMB_ACTIVE_OPTIONS}
                activeProps={CRUMB_ACTIVE_PROPS}
                className={CRUMB_LINK_CLASS}
                params={{ country }}
                to="/law/$country/statutes"
              >
                {t("statutes.title")}
              </Link>
            </BreadcrumbItem>
          </>
        )}
        {section === "coverage" && (
          <>
            <BreadcrumbSeparator
              className={cn(trail !== null && "max-sm:hidden")}
            />
            <BreadcrumbItem className={cn(trail !== null && "max-sm:hidden")}>
              <BreadcrumbPage>{t("caseLaw.coverage.title")}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
        {trail !== null && <LawDocumentCrumbs trail={trail} />}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
