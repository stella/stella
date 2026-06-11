import { Fragment, useId, useMemo } from "react";

import { Link, useMatches } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stll/ui/components/breadcrumb";

import { ContactBreadcrumb } from "@/components/breadcrumbs/contact-breadcrumb";
import { PdfBreadcrumb } from "@/components/breadcrumbs/pdf-breadcrumb";
import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { SkillBreadcrumb } from "@/components/breadcrumbs/skill-breadcrumb";
import { WorkspaceBreadcrumb } from "@/components/breadcrumbs/workspace-breadcrumb";
import type { RouterFullPath } from "@/lib/types";

const PATH_SEPARATOR = "|";

const serializeKey = (paths: readonly RouterFullPath[]) =>
  paths.join(PATH_SEPARATOR);

type BreadcrumbEntry =
  | React.JSX.Element
  | ((params: Record<string, string | undefined>) => React.ReactNode);

type BreadcrumbDefinition = {
  key: string;
  paths: readonly RouterFullPath[];
  entry: BreadcrumbEntry;
};

const renderPdfBreadcrumb = () => <PdfBreadcrumb />;

const renderWorkspaceBreadcrumb = ({
  workspaceId,
}: Record<string, string | undefined>) => {
  if (!workspaceId) {
    return null;
  }
  return <WorkspaceBreadcrumb workspaceId={workspaceId} />;
};

const renderContactBreadcrumb = ({
  contactId,
}: Record<string, string | undefined>) => {
  if (!contactId) {
    return null;
  }
  return <ContactBreadcrumb contactId={contactId} />;
};

const renderBreadcrumbEntry = (
  entry: BreadcrumbEntry,
  params: Record<string, string | undefined>,
): React.ReactNode => (typeof entry === "function" ? entry(params) : entry);

const defineBreadcrumb = (
  paths: readonly RouterFullPath[],
  entry: BreadcrumbEntry,
): BreadcrumbDefinition => ({
  key: serializeKey(paths),
  paths,
  entry,
});

export const AppBreadcrumbs = () => {
  const t = useTranslations();
  const matches = useMatches();
  const id = useId();

  const breadcrumbDefinitions: BreadcrumbDefinition[] = useMemo(
    () => [
      defineBreadcrumb(
        ["/workspaces/"],
        <BreadcrumbItem className="min-w-8 shrink">
          <Link
            activeOptions={{ exact: true, includeSearch: false }}
            activeProps={{ className: "text-foreground font-semibold" }}
            className="hover:text-foreground min-w-0 truncate transition-colors"
            title={t("common.matters")}
            to="/workspaces"
          >
            {t("common.matters")}
          </Link>
        </BreadcrumbItem>,
      ),
      defineBreadcrumb(["/workspaces/$workspaceId"], renderWorkspaceBreadcrumb),
      defineBreadcrumb(
        ["/workspaces/$workspaceId/$viewId/document"],
        renderPdfBreadcrumb,
      ),
      defineBreadcrumb(
        ["/todos/"],
        <BreadcrumbLink to="/todos">{t("navigation.myTodos")}</BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/knowledge"],
        <BreadcrumbLink to="/knowledge">
          {t("navigation.knowledge")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/knowledge/templates"],
        <BreadcrumbLink to="/knowledge/templates">
          {t("navigation.templates")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/contacts/"],
        <BreadcrumbLink to="/contacts">
          {t("navigation.contacts")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/knowledge/clauses"],
        <BreadcrumbLink to="/knowledge/clauses">
          {t("common.clauses")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(["/contacts/$contactId"], renderContactBreadcrumb),
      defineBreadcrumb(
        ["/knowledge/prompts"],
        <BreadcrumbItem>
          {t("knowledge.sections.prompts.title")}
        </BreadcrumbItem>,
      ),
      defineBreadcrumb(
        ["/knowledge/tools"],
        <BreadcrumbLink to="/knowledge/tools">
          {t("knowledge.sections.tools.title")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(["/knowledge/tools/$skillId"], <SkillBreadcrumb />),
      defineBreadcrumb(
        ["/settings"],
        <BreadcrumbLink to="/settings">{t("common.settings")}</BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/settings/account/profile"],
        <BreadcrumbLink to="/settings/account/profile">
          {t("settings.account.profile")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/settings/account/desktop"],
        <BreadcrumbLink to="/settings/account/desktop">
          {t("settings.account.desktop")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/settings/organization"],
        <BreadcrumbItem>{t("common.organization")}</BreadcrumbItem>,
      ),
      defineBreadcrumb(
        ["/settings/organization/members"],
        <BreadcrumbLink to="/settings/organization/members">
          {t("navigation.members")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/settings/organization/matter-numbering"],
        <BreadcrumbLink to="/settings/organization/matter-numbering">
          {t("settings.organization.matterNumbering")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/settings/organization/ai"],
        <BreadcrumbLink to="/settings/organization/ai">
          {t("settings.organization.ai")}
        </BreadcrumbLink>,
      ),
      defineBreadcrumb(
        ["/chat"],
        <BreadcrumbLink to="/chat">{t("navigation.chat")}</BreadcrumbLink>,
      ),
    ],
    [t],
  );

  const breadcrumbs = useMemo(() => {
    const results = new Map<string, React.ReactNode>();

    for (const match of matches) {
      for (const definition of breadcrumbDefinitions) {
        if (definition.paths.some((path) => match.fullPath.startsWith(path))) {
          const result = renderBreadcrumbEntry(definition.entry, match.params);

          if (result !== null && result !== undefined && result !== false) {
            results.set(definition.key, result);
          }
        }
      }
    }

    return [...results.values()];
  }, [matches, breadcrumbDefinitions]);

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap overflow-hidden">
        {breadcrumbs.map((breadcrumb, index) => (
          <Fragment key={`${id}-${index}`}>
            {index !== 0 && <BreadcrumbSeparator className="shrink-0" />}
            {breadcrumb}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
