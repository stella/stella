import type { ReactElement } from "react";

import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/separator";

import { PublicWorkspaceShell } from "@/components/public-workspace-shell";
import { SidebarTrigger, useSidebar } from "@/components/sidebar";
import { publicKnowledgeSource } from "@/features/knowledge/public/public-knowledge";
import { knowledgeSections } from "@/lib/knowledge/navigation";

/** Knowledge for a visitor without an account: the public shell with a
 *  Knowledge breadcrumb in its top bar. */
export const KnowledgePublicFrame = ({
  children,
}: {
  children: ReactElement;
}) => (
  <PublicWorkspaceShell content={children} topBar={<KnowledgePublicTopBar />} />
);

/**
 * The name the matched route chose to show, if it carries one.
 *
 * Typed `unknown` on purpose: the deepest match is any route in the tree.
 */
const routeDisplayName = (loaderData: unknown): string | null =>
  typeof loaderData === "object" &&
  loaderData !== null &&
  "displayName" in loaderData &&
  typeof loaderData.displayName === "string"
    ? loaderData.displayName
    : null;

const KnowledgePublicTopBar = () => {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const entryName = useRouterState({
    select: (state) => routeDisplayName(state.matches.at(-1)?.loaderData),
  });
  const { available: templatesAvailable } =
    publicKnowledgeSource.useCatalogueTemplatesAvailable();
  const visibleSections = knowledgeSections.filter(
    ({ key }) => key !== "templates" || templatesAvailable,
  );
  const section = visibleSections.find(
    ({ to }) => pathname === to || pathname.startsWith(`${to}/`),
  );

  return (
    <header className="bg-sidebar border-sidebar-border flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
      {isMobile && (
        <>
          <SidebarTrigger className="-ms-1" />
          <Separator className="me-2 h-4" orientation="vertical" />
        </>
      )}
      <nav
        aria-label={t("navigation.knowledge")}
        className="flex min-w-0 items-center gap-1.5 text-sm"
      >
        <Link
          className="text-muted-foreground hover:text-foreground shrink-0"
          to="/knowledge"
        >
          {t("navigation.knowledge")}
        </Link>
        {section !== undefined && (
          <>
            <span className="text-foreground-placeholder">/</span>
            <Link
              className="text-muted-foreground hover:text-foreground shrink-0"
              to={section.to}
            >
              {t(section.titleKey)}
            </Link>
          </>
        )}
        {entryName !== null && (
          <>
            <span className="text-foreground-placeholder">/</span>
            <span className="text-foreground truncate font-medium" dir="auto">
              {entryName}
            </span>
          </>
        )}
      </nav>
    </header>
  );
};
