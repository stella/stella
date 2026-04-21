import { Fragment, useId, useMemo } from "react";

import { Link, useMatches } from "@tanstack/react-router";
import type { ResolveParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stella/ui/components/breadcrumb";

import { CaseLawBreadcrumb } from "@/components/breadcrumbs/case-law-breadcrumb";
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
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  key.split(PATH_SEPARATOR) as RouterFullPath[];

type BreadcrumbComponent<TPath extends RouterFullPath> = (
  params: ResolveParams<TPath>,
) => React.JSX.Element;

export const AppBreadcrumbs = () => {
  const t = useTranslations();
  const matches = useMatches();
  const id = useId();

  const breadcrumbMap: Partial<
    Record<string, BreadcrumbComponent<RouterFullPath>>
  > = useMemo(
    () => ({
      [serializeKey(["/workspaces/"])]: () => (
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
      [serializeKey(["/workspaces/$workspaceId"])]: (params) => (
        <WorkspaceBreadcrumb {...params} />
      ),
      [serializeKey(["/workspaces/$workspaceId/$viewId/pdf"])]: () => (
        <PdfBreadcrumb />
      ),
      [serializeKey(["/todos/"])]: () => (
        <BreadcrumbLink to="/todos">{t("navigation.myTodos")}</BreadcrumbLink>
      ),
      [serializeKey(["/knowledge"])]: () => (
        <BreadcrumbLink to="/knowledge">
          {t("navigation.knowledge")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/knowledge/templates"])]: () => (
        <BreadcrumbLink to="/knowledge/templates">
          {t("navigation.templates")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/contacts/"])]: () => (
        <BreadcrumbLink to="/contacts">
          {t("navigation.contacts")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/knowledge/clauses"])]: () => (
        <BreadcrumbLink to="/knowledge/clauses">
          {t("common.clauses")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/contacts/$contactId"])]: (params) => (
        <ContactBreadcrumb {...params} />
      ),
      [serializeKey(["/knowledge/case/"])]: () => (
        <BreadcrumbLink to="/knowledge/case">
          {t("common.caseLaw")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/knowledge/case/$decisionId"])]: (params) => (
        <CaseLawBreadcrumb {...params} />
      ),
      [serializeKey(["/organization"])]: () => (
        <BreadcrumbItem>{t("common.organization")}</BreadcrumbItem>
      ),
      [serializeKey(["/organization/members"])]: () => (
        <BreadcrumbLink to="/organization/members">
          {t("navigation.members")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/organization/invitations"])]: () => (
        <BreadcrumbLink to="/organization/invitations">
          {t("navigation.invitations")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/account"])]: () => (
        <BreadcrumbItem>{t("navigation.account")}</BreadcrumbItem>
      ),
      [serializeKey(["/account/sessions"])]: () => (
        <BreadcrumbLink to="/account/sessions">
          {t("common.sessions")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/account/settings"])]: () => (
        <BreadcrumbLink to="/account/settings">
          {t("common.settings")}
        </BreadcrumbLink>
      ),
      [serializeKey(["/chat"])]: () => (
        <BreadcrumbLink to="/chat">{t("navigation.chat")}</BreadcrumbLink>
      ),
    }),
    [t],
  );

  const breadcrumbs = useMemo(() => {
    const results = new Map<string, React.JSX.Element>();

    for (const match of matches) {
      for (const key of Object.keys(breadcrumbMap)) {
        const parsedKey = deserializeKey(key);

        if (parsedKey.some((path) => match.fullPath.startsWith(path))) {
          // SAFETY: match.params from TanStack Router for known route
          const result = breadcrumbMap[key]?.(
            // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
            match.params as ResolveParams<RouterFullPath>,
          );

          if (result) {
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
          <Fragment
            key={`${id}-${
              // eslint-disable-next-line react/no-array-index-key
              index
            }`}
          >
            {index !== 0 && <BreadcrumbSeparator className="shrink-0" />}
            {breadcrumb}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
