import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/separator";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";

export function PublicToolsShell() {
  return <PublicWorkspaceShell topBar={<PublicToolsTopBar />} />;
}

/**
 * The name the matched route chose to show, if it carries one.
 *
 * Typed `unknown` on purpose: the deepest match is any route in the tree, and
 * narrowing the tree-wide union here made the guard change meaning whenever a
 * route elsewhere changed what its loader returns.
 */
const routeDisplayName = (loaderData: unknown): string | null =>
  typeof loaderData === "object" &&
  loaderData !== null &&
  "displayName" in loaderData &&
  typeof loaderData.displayName === "string"
    ? loaderData.displayName
    : null;

function PublicToolsTopBar() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const entryName = useRouterState({
    select: (state) => routeDisplayName(state.matches.at(-1)?.loaderData),
  });

  return (
    <header className="bg-sidebar flex h-12 shrink-0 items-center gap-2 overflow-hidden px-4 shadow-[0_1px_0_rgb(0_0_0/0.045)]">
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
          className="text-muted-foreground hover:text-foreground shrink-0"
          from="/tools"
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
