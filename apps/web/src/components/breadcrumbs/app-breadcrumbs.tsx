import { Fragment } from "react";

import { useMatches } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";
import { cn } from "@stll/ui/utils";

import { declaredBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs.logic";
import { ChatBreadcrumb } from "@/components/breadcrumbs/chat-breadcrumb";
import { ClausesBreadcrumb } from "@/components/breadcrumbs/clauses-breadcrumb";
import { ContactBreadcrumb } from "@/components/breadcrumbs/contact-breadcrumb";
import { PdfBreadcrumb } from "@/components/breadcrumbs/pdf-breadcrumb";
import { PlaybooksBreadcrumb } from "@/components/breadcrumbs/playbooks-breadcrumb";
import { BreadcrumbLink } from "@/components/breadcrumbs/shared";
import { SkillBreadcrumb } from "@/components/breadcrumbs/skill-breadcrumb";
import { TemplatesBreadcrumb } from "@/components/breadcrumbs/templates-breadcrumb";
import { WorkspaceBreadcrumb } from "@/components/breadcrumbs/workspace-breadcrumb";
import { getTranslator } from "@/i18n/i18n-store";
import type { RouteBreadcrumb } from "@/routes/-route-presentation";

/*
 * The trail folds by the width of its bar (the `app-crumbs` container), not
 * the window's, as the law trail does: header actions leave the bar narrow on
 * a phone, and beside an open inspector on a wide screen. While the bar is
 * narrow, every item above the current one folds away whole and an ellipsis
 * stands in for them; the current item takes the rest of the bar and
 * truncates. A crumb component may draw several items, so the fold works on
 * the drawn items, and the ellipsis shows only when there is an item to fold
 * (its two fold items, then at least item, separator, item).
 */
const APP_CRUMB_LIST_CLASS = cn(
  "flex-nowrap overflow-hidden has-[input]:w-full",
  "@max-md/app-crumbs:[&>li:not(:last-child,[data-crumb-fold])]:hidden",
  "@max-md/app-crumbs:[&>li:last-child]:min-w-0",
  "@max-md/app-crumbs:[&>li:last-child]:flex-1",
  "@md/app-crumbs:[&>[data-crumb-fold]]:hidden",
  "[&:not(:has(>li:nth-child(5)))>[data-crumb-fold]]:hidden",
);

export const AppBreadcrumbs = () => {
  useTranslations();
  const t = getTranslator();
  const matches = useMatches();

  const breadcrumbs = declaredBreadcrumbs(matches).map(
    ({ decision, key }) =>
      [
        key,
        renderBreadcrumb(
          decision,
          matches.at(-1)?.params ?? {},
          decision.type === "label" ? t(decision.labelKey) : undefined,
        ),
      ] as const,
  );

  return (
    <Breadcrumb className="@container/app-crumbs flex min-w-0 flex-1">
      <BreadcrumbList className={APP_CRUMB_LIST_CLASS}>
        <BreadcrumbItem className="shrink-0" data-crumb-fold="">
          <BreadcrumbEllipsis />
        </BreadcrumbItem>
        <BreadcrumbSeparator className="shrink-0" data-crumb-fold="" />
        {breadcrumbs.map(([key, breadcrumb], index) => (
          <Fragment key={key}>
            {index !== 0 && <BreadcrumbSeparator className="shrink-0" />}
            {breadcrumb}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};

function renderBreadcrumb(
  decision: Exclude<RouteBreadcrumb, { type: "inherit" } | { type: "none" }>,
  params: Record<string, string | undefined>,
  translatedLabel: string | undefined,
) {
  if (decision.type === "label") {
    return <BreadcrumbLink to={decision.to}>{translatedLabel}</BreadcrumbLink>;
  }
  if (decision.type === "entity") {
    if (decision.entity === "pdf") {
      return <PdfBreadcrumb />;
    }
    if (decision.entity === "matter" && params["workspaceId"]) {
      return <WorkspaceBreadcrumb workspaceId={params["workspaceId"]} />;
    }
    if (decision.entity === "contact" && params["contactId"]) {
      return <ContactBreadcrumb contactId={params["contactId"]} />;
    }
    if (decision.entity === "chat" && params["threadId"]) {
      return (
        <ChatBreadcrumb
          threadId={params["threadId"]}
          workspaceId={params["workspaceId"]}
        />
      );
    }
    return null;
  }
  if (decision.detail === "clauses") {
    return <ClausesBreadcrumb />;
  }
  if (decision.detail === "playbooks") {
    return <PlaybooksBreadcrumb />;
  }
  if (decision.detail === "skill") {
    return <SkillBreadcrumb />;
  }
  return <TemplatesBreadcrumb />;
}
