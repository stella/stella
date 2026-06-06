import { Fragment, useId, useMemo } from "react";

import { Link, useMatches } from "@tanstack/react-router";
import type { ResolveParams } from "@tanstack/react-router";
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
import { WorkspaceBreadcrumb } from "@/components/breadcrumbs/workspace-breadcrumb";
import type { RouterFullPath } from "@/lib/types";

const PATH_SEPARATOR = "|";

const serializeKey = (paths: readonly RouterFullPath[]) =>
  paths.join(PATH_SEPARATOR);
// SAFETY: key comes from breadcrumbMap keys built from RouterFullPath[]
const deserializeKey = (key: string) =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  key.split(PATH_SEPARATOR) as RouterFullPath[];

type BreadcrumbEntry =
  | React.JSX.Element
  | ((params: ResolveParams<RouterFullPath>) => React.ReactNode);

const renderPdfBreadcrumb = () => <PdfBreadcrumb />;

const renderWorkspaceBreadcrumb = (params: ResolveParams<RouterFullPath>) => (
  <WorkspaceBreadcrumb
    // SAFETY: this renderer is only registered for /workspaces/$workspaceId.
    {...(params as ResolveParams<"/workspaces/$workspaceId">)}
  />
);

const renderContactBreadcrumb = (params: ResolveParams<RouterFullPath>) => (
  <ContactBreadcrumb
    // SAFETY: this renderer is only registered for /contacts/$contactId.
    {...(params as ResolveParams<"/contacts/$contactId">)}
  />
);

const renderBreadcrumbEntry = (
  entry: BreadcrumbEntry,
  params: ResolveParams<RouterFullPath>,
): React.ReactNode => (typeof entry === "function" ? entry(params) : entry);

export const AppBreadcrumbs = () => {
  const t = useTranslations();
  const matches = useMatches();
  const id = useId();

  const breadcrumbMap: Partial<Record<string, BreadcrumbEntry>> = useMemo(
    () => ({
      [serializeKey(["/workspaces/"])]: (
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
        </BreadcrumbItem>
      ),
      [serializeKey(["/workspaces/$workspaceId"])]: renderWorkspaceBreadcrumb,
      [serializeKey(["/workspaces/$workspaceId/$viewId/document"])]:
        renderPdfBreadcrumb,
      [serializeKey(["/todos/"])]: (
        <BreadcrumbLink to="/todos">{t("navigation.myTodos")}</BreadcrumbLink>
      ),
      [serializeKey(["/knowledge"])]: (
        <BreadcrumbLink to="/knowledge">
          {t("navigation.knowledge")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/knowledge/templates"])]: (
        <BreadcrumbLink to="/knowledge/templates">
          {t("navigation.templates")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/contacts/"])]: (
        <BreadcrumbLink to="/contacts">
          {t("navigation.contacts")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/knowledge/clauses"])]: (
        <BreadcrumbLink to="/knowledge/clauses">
          {t("common.clauses")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/contacts/$contactId"])]: renderContactBreadcrumb,
      [serializeKey(["/knowledge/prompts"])]: (
        <BreadcrumbItem>{t("knowledge.sections.prompts.title")}</BreadcrumbItem>
      ),
      [serializeKey(["/knowledge/tools"])]: (
        <BreadcrumbItem>{t("knowledge.sections.tools.title")}</BreadcrumbItem>
      ),
      [serializeKey(["/settings"])]: (
        <BreadcrumbLink to="/settings">{t("common.settings")}</BreadcrumbLink>
      ),
      [serializeKey(["/settings/account/profile"])]: (
        <BreadcrumbLink to="/settings/account/profile">
          {t("settings.account.profile")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/settings/account/desktop"])]: (
        <BreadcrumbLink to="/settings/account/desktop">
          {t("settings.account.desktop")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/settings/organization"])]: (
        <BreadcrumbItem>{t("common.organization")}</BreadcrumbItem>
      ),
      [serializeKey(["/settings/organization/members"])]: (
        <BreadcrumbLink to="/settings/organization/members">
          {t("navigation.members")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/settings/organization/matter-numbering"])]: (
        <BreadcrumbLink to="/settings/organization/matter-numbering">
          {t("settings.organization.matterNumbering")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/settings/organization/ai"])]: (
        <BreadcrumbLink to="/settings/organization/ai">
          {t("settings.organization.ai")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/chat"])]: (
        <BreadcrumbLink to="/chat">{t("navigation.chat")}</BreadcrumbLink>
      ),
    }),
    [t],
  );

  const breadcrumbs = useMemo(() => {
    const results = new Map<string, React.ReactNode>();

    for (const match of matches) {
      for (const key of Object.keys(breadcrumbMap)) {
        const parsedKey = deserializeKey(key);

        if (parsedKey.some((path) => match.fullPath.startsWith(path))) {
          const entry = breadcrumbMap[key];

          if (entry === undefined) {
            continue;
          }

          // SAFETY: match.params from TanStack Router for known route
          const result = renderBreadcrumbEntry(
            entry,
            // eslint-disable-next-line typescript/no-unsafe-type-assertion
            match.params as ResolveParams<RouterFullPath>,
          );

          if (result !== null && result !== undefined && result !== false) {
            results.set(key, result);
          }
        }
      }
    }

    return [...results.values()];
  }, [matches, breadcrumbMap]);

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
