import { Fragment, useId, useMemo } from "react";
import { useMatches, type ResolveParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stella/ui/components/breadcrumb";

import { ContactBreadcrumb } from "@/components/breadcrumbs/contact-breadcrumb";
import { PdfBreadcrumb } from "@/components/breadcrumbs/pdf-breadcrumb";
import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { WorkspaceBreadcrumb } from "@/components/breadcrumbs/workspace-breadcrumb";
import type { RouterFullPath } from "@/lib/types";

const PATH_SEPARATOR = "|";

const serializeKey = (paths: RouterFullPath[]) => paths.join(PATH_SEPARATOR);
const deserializeKey = (key: string) =>
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
      [serializeKey(["/workspaces/"])]: () => {
        return (
          <BreadcrumbLink to="/workspaces">
            {t("common.matters")}
          </BreadcrumbLink>
        );
      },
      [serializeKey(["/workspaces/$workspaceId"])]: (params) => {
        return <WorkspaceBreadcrumb {...params} />;
      },
      [serializeKey(["/workspaces/$workspaceId/pdf"])]: () => {
        return <PdfBreadcrumb />;
      },
      [serializeKey(["/knowledge"])]: () => {
        return (
          <BreadcrumbLink to="/knowledge">
            {t("navigation.knowledge")}
          </BreadcrumbLink>
        );
      },
      [serializeKey(["/knowledge/templates"])]: () => {
        return (
          <BreadcrumbLink to="/knowledge/templates">
            {t("navigation.templates")}
          </BreadcrumbLink>
        );
      },
      [serializeKey(["/contacts/"])]: () => {
        return (
          <BreadcrumbLink to="/contacts">
            {t("navigation.contacts")}
          </BreadcrumbLink>
        );
      },
      [serializeKey(["/knowledge/clauses"])]: () => {
        return (
          <BreadcrumbLink to="/knowledge/clauses">
            {t("navigation.clauses")}
          </BreadcrumbLink>
        );
      },
      [serializeKey(["/contacts/$contactId"])]: (params) => {
        return <ContactBreadcrumb {...params} />;
      },
      [serializeKey(["/organization"])]: () => {
        return <BreadcrumbItem>{t("navigation.organization")}</BreadcrumbItem>;
      },
      [serializeKey(["/organization/members"])]: () => {
        return (
          <BreadcrumbLink to="/organization/members">
            {t("navigation.members")}
          </BreadcrumbLink>
        );
      },
      [serializeKey(["/organization/invitations"])]: () => {
        return (
          <BreadcrumbLink to="/organization/invitations">
            {t("navigation.invitations")}
          </BreadcrumbLink>
        );
      },
    }),
    [t],
  );

  const breadcrumbs = useMemo(() => {
    const results = new Map<string, React.JSX.Element>();

    for (const match of matches) {
      for (const key of Object.keys(breadcrumbMap)) {
        const parsedKey = deserializeKey(key);

        if (parsedKey.some((path) => match.fullPath.startsWith(path))) {
          const result = breadcrumbMap[key]?.(
            match.params as ResolveParams<RouterFullPath>,
          );

          if (result) {
            results.set(key, result);
          }
        }
      }
    }

    return Array.from(results.values());
  }, [matches, breadcrumbMap]);

  return (
    <Breadcrumb className="min-w-0 max-lg:hidden">
      <BreadcrumbList className="flex-nowrap overflow-hidden">
        {breadcrumbs.map((breadcrumb, index) => (
          <Fragment
            key={`${id}-${
              // biome-ignore lint/suspicious/noArrayIndexKey: we use id
              index
            }`}
          >
            {index !== 0 && <BreadcrumbSeparator />}
            {breadcrumb}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
