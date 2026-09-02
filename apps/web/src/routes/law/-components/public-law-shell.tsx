import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";
import { Separator } from "@stll/ui/separator";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";
import { DecisionLanguageSelect } from "@/features/case-law/components/decision-language-select";
import { TopBarCitations } from "@/features/case-law/components/top-bar-citations";
import { ChromeHeaderActionsSlot } from "@/lib/chrome-header-actions";
import { toStatuteCountrySegment } from "@/lib/statute-route";
import { PublicLawInspector } from "@/routes/law/-components/public-law-inspector";

export function PublicLawShell() {
  return (
    <PublicWorkspaceShell
      inspector={<PublicLawInspector />}
      topBar={<PublicLawTopBar />}
    />
  );
}

const readStringField = (value: unknown, field: string): string | null => {
  if (typeof value === "object" && value !== null && field in value) {
    const fieldValue: unknown = Reflect.get(value, field);
    if (typeof fieldValue === "string") {
      return fieldValue;
    }
  }

  return null;
};

/** Which corpus a route belongs to, read from its id; the home belongs to neither. */
type LawSection = "decisions" | "statutes";

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
  return null;
};

const CRUMB_LINK_CLASS = "hover:text-foreground shrink-0 transition-colors";
const CRUMB_ACTIVE_PROPS = { className: "text-foreground font-medium" };
const CRUMB_ACTIVE_OPTIONS = { exact: true, includeSearch: false };

function PublicLawTopBar() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const section = useRouterState({
    select: (state) => sectionOfRoute(state.matches.at(-1)?.routeId),
  });
  const documentLabel = useRouterState({
    select: (state) => {
      const loaderData = state.matches.at(-1)?.loaderData;

      return (
        readStringField(loaderData, "caseNumber") ??
        readStringField(loaderData, "title")
      );
    },
  });
  // The area of law is the one fact that belongs next to the name; the rest
  // of a decision's facts live in the inspector.
  const legalArea = useRouterState({
    select: (state) => {
      const loaderData: unknown = state.matches.at(-1)?.loaderData;
      const metadata: unknown =
        typeof loaderData === "object" &&
        loaderData !== null &&
        "metadata" in loaderData
          ? loaderData.metadata
          : null;

      return readStringField(metadata, "legalArea");
    },
  });
  const country = useRouterState({
    select: (state) => {
      const params: unknown = state.matches.at(-1)?.params;

      return toStatuteCountrySegment(readStringField(params, "country"));
    },
  });

  return (
    <header
      // The case reader's docked inspector overlays the bar's inline-end for
      // its width (it owns the top row there); keep the bar's actions beside
      // it rather than beneath it. The dock renders from `md` up only, so
      // the padding is scoped the same way — below `md` the plain px-4
      // applies and the published width is ignored.
      className="bg-sidebar flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4 md:pe-[calc(1rem+var(--law-end-dock-width,0px))]"
    >
      {isMobile && (
        <>
          <SidebarTrigger className="-ms-1" />
          <Separator className="me-2 h-4" orientation="vertical" />
        </>
      )}
      {/* One section name, then the corpus and the document as the reader
          descends; the home carries the name alone, its scope tabs pick the
          corpus. */}
      <Breadcrumb className="flex min-w-0 flex-1 items-center gap-2">
        <BreadcrumbList className="flex-nowrap gap-1.5 sm:gap-1.5">
          <BreadcrumbItem>
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
              <BreadcrumbSeparator />
              <BreadcrumbItem>
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
              <BreadcrumbSeparator />
              <BreadcrumbItem>
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
          {documentLabel !== null && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate font-medium">
                  {documentLabel}
                </BreadcrumbPage>
                {legalArea !== null && (
                  <span className="text-muted-foreground min-w-0 truncate">
                    · {legalArea}
                  </span>
                )}
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
        <TopBarCitations />
      </Breadcrumb>
      <DecisionLanguageSelect />
      <ChromeHeaderActionsSlot />
    </header>
  );
}
