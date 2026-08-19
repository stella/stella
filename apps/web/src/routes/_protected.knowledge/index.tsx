import type { ReactNode } from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { knowledgeSections } from "@/lib/knowledge/navigation";

export const Route = createFileRoute("/_protected/knowledge/")({
  component: KnowledgeLanding,
});

function KnowledgeLanding() {
  const t = useTranslations();
  const workflowsEnabled = useWorkflowsPreviewEnabled();
  const canUseStyleSets = usePermissions({ styleSet: ["use"] });

  const sectionCards: ReactNode[] = [];
  for (const section of knowledgeSections) {
    if (section.key === "workflows" && !workflowsEnabled) {
      continue;
    }
    if (section.key === "styles" && !canUseStyleSets) {
      continue;
    }
    const Icon = section.icon;
    const title = t(section.titleKey);
    const description =
      section.key === "styles"
        ? t("styleSets.description")
        : t(`knowledge.sections.${section.key}.description`);
    const cardBody = (
      <>
        <div
          className={cn(
            "flex size-10 items-center justify-center",
            "bg-muted rounded-lg",
          )}
        >
          <Icon className="size-5" />
        </div>
        <div className="mt-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        </div>
      </>
    );

    sectionCards.push(
      <Link
        className={cn(
          "bg-card flex h-full flex-col rounded-xl border p-5",
          "transition-colors",
          "hover:border-foreground/15 hover:shadow-sm",
        )}
        key={section.key}
        to={section.to}
      >
        {cardBody}
      </Link>,
    );
  }

  return (
    <div className="flex flex-1 flex-col p-6">
      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sectionCards}
      </div>
    </div>
  );
}
