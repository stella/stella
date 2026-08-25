import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/separator";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";
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

function PublicLawTopBar() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
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
    <header className="bg-sidebar flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
      {isMobile && (
        <>
          <SidebarTrigger className="-ms-1" />
          <Separator className="me-2 h-4" orientation="vertical" />
        </>
      )}
      <nav
        aria-label={t("common.legalDatabase")}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
      >
        <Link
          activeProps={{ className: "text-foreground font-medium" }}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          to="/law/cases"
        >
          {t("common.caseLaw")}
        </Link>
        <span className="text-foreground-placeholder">·</span>
        <Link
          activeProps={{ className: "text-foreground font-medium" }}
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          params={{ country }}
          to="/law/$country/statutes"
        >
          {t("statutes.title")}
        </Link>
        {documentLabel !== null && (
          <>
            <span className="text-foreground-placeholder">/</span>
            <span className="text-foreground truncate font-medium">
              {documentLabel}
            </span>
            {legalArea !== null && (
              <span className="text-muted-foreground min-w-0 truncate">
                · {legalArea}
              </span>
            )}
          </>
        )}
        <TopBarCitations />
      </nav>
      <ChromeHeaderActionsSlot />
    </header>
  );
}
