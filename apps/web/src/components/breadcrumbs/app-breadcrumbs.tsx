import { Fragment } from "react";

import { useMatches } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@stll/ui/breadcrumb";

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
import type { RouteBreadcrumb } from "@/lib/route-presentation";

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
    <Breadcrumb className="min-w-0 has-[input]:flex-1">
      <BreadcrumbList className="flex-nowrap overflow-hidden has-[input]:w-full">
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
