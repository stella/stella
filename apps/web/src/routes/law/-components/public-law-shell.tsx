import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/components/separator";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";

export function PublicLawShell() {
  return <PublicWorkspaceShell topBar={<PublicLawTopBar />} />;
}

function PublicLawTopBar() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const caseNumber = useRouterState({
    select: (state) => {
      const loaderData = state.matches.at(-1)?.loaderData;
      if (
        typeof loaderData === "object" &&
        "caseNumber" in loaderData &&
        typeof loaderData.caseNumber === "string"
      ) {
        return loaderData.caseNumber;
      }
      return null;
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
        aria-label={t("common.caseLaw")}
        className="flex min-w-0 items-center gap-1.5 text-sm"
      >
        <Link
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          to="/law/cases"
        >
          {t("common.caseLaw")}
        </Link>
        {caseNumber !== null && (
          <>
            <span className="text-foreground-placeholder">/</span>
            <span className="text-foreground truncate font-medium">
              {caseNumber}
            </span>
          </>
        )}
      </nav>
    </header>
  );
}
