import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/components/separator";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";

export function PublicToolsShell() {
  return <PublicWorkspaceShell topBar={<PublicToolsTopBar />} />;
}

function PublicToolsTopBar() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const entryName = useRouterState({
    select: (state) => {
      const loaderData = state.matches.at(-1)?.loaderData;
      if (
        typeof loaderData === "object" &&
        "displayName" in loaderData &&
        typeof loaderData.displayName === "string"
      ) {
        return loaderData.displayName;
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
        aria-label={t("knowledge.sections.tools.title")}
        className="flex min-w-0 items-center gap-1.5 text-sm"
      >
        <Link
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          to="/tools"
        >
          {t("knowledge.sections.tools.title")}
        </Link>
        {entryName !== null && (
          <>
            <span className="text-foreground-placeholder">/</span>
            <span className="text-foreground truncate font-medium">
              {entryName}
            </span>
          </>
        )}
      </nav>
    </header>
  );
}
