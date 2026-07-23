import type { ComponentType, ReactNode, SVGProps } from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ClipboardCheckIcon,
  LayoutTemplateIcon,
  PackageIcon,
  PaletteIcon,
  TextQuoteIcon,
  WorkflowIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { usePlaybooksPreviewEnabled } from "@/hooks/use-playbooks-preview";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import type { TranslationKey } from "@/i18n/types";

export const Route = createFileRoute("/_protected/knowledge/")({
  component: KnowledgeLanding,
});

// "prompts" used to be its own surface; after the prompts→skills
// consolidation, slash-command prompts live alongside richer skills
// on the Tools page. The sidebar entry was removed so the landing
// doesn't advertise a deleted destination.
type KnowledgeSection = {
  key: "templates" | "styles" | "clauses" | "playbooks" | "workflows" | "tools";
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  to:
    | "/knowledge/templates"
    | "/knowledge/styles"
    | "/knowledge/clauses"
    | "/knowledge/playbooks"
    | "/knowledge/workflows"
    | "/knowledge/tools";
  // "clauses", "playbooks", and "workflows" reuse the shared common.* labels
  // instead of feature-scoped duplicates; other sections use their own title.
  titleKey: Extract<
    TranslationKey,
    | "knowledge.sections.templates.title"
    | "styleSets.title"
    | "knowledge.sections.tools.title"
    | "common.clauses"
    | "common.playbooks"
    | "common.workflows"
  >;
};

export const knowledgeSections: readonly KnowledgeSection[] = [
  {
    key: "tools",
    icon: PackageIcon,
    to: "/knowledge/tools",
    titleKey: "knowledge.sections.tools.title",
  },
  {
    key: "templates",
    icon: LayoutTemplateIcon,
    to: "/knowledge/templates",
    titleKey: "knowledge.sections.templates.title",
  },
  {
    key: "styles",
    icon: PaletteIcon,
    to: "/knowledge/styles",
    titleKey: "styleSets.title",
  },
  {
    key: "clauses",
    icon: TextQuoteIcon,
    to: "/knowledge/clauses",
    titleKey: "common.clauses",
  },
  {
    key: "playbooks",
    icon: ClipboardCheckIcon,
    to: "/knowledge/playbooks",
    titleKey: "common.playbooks",
  },
  {
    key: "workflows",
    icon: WorkflowIcon,
    to: "/knowledge/workflows",
    titleKey: "common.workflows",
  },
];

function KnowledgeLanding() {
  const t = useTranslations();
  const playbooksEnabled = usePlaybooksPreviewEnabled();
  const workflowsEnabled = useWorkflowsPreviewEnabled();
  const canUseStyleSets = usePermissions({ styleSet: ["use"] });

  const sectionCards: ReactNode[] = [];
  for (const section of knowledgeSections) {
    if (section.key === "playbooks" && !playbooksEnabled) {
      continue;
    }
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
