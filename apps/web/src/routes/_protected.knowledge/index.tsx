import type { ComponentType, SVGProps } from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BotIcon,
  LayoutTemplateIcon,
  PackageIcon,
  TextQuoteIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";

export const Route = createFileRoute("/_protected/knowledge/")({
  component: KnowledgeLanding,
});

// "prompts" used to be its own surface; after the prompts→skills
// consolidation, slash-command prompts live alongside richer skills
// on the Tools page. The sidebar entry was removed so the landing
// doesn't advertise a deleted destination.
type KnowledgeSection = {
  key: "templates" | "clauses" | "tools" | "agents";
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  to?: "/knowledge/templates" | "/knowledge/clauses" | "/knowledge/tools";
  // "clauses" reuses the shared common.clauses label instead of a
  // feature-scoped duplicate; other sections use their own section title.
  titleKey: Extract<
    TranslationKey,
    | "knowledge.sections.templates.title"
    | "knowledge.sections.tools.title"
    | "knowledge.sections.agents.title"
    | "common.clauses"
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
    key: "clauses",
    icon: TextQuoteIcon,
    to: "/knowledge/clauses",
    titleKey: "common.clauses",
  },
  { key: "agents", icon: BotIcon, titleKey: "knowledge.sections.agents.title" },
];

function KnowledgeLanding() {
  const t = useTranslations();

  return (
    <div className="flex flex-1 flex-col p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {knowledgeSections.map((section) => {
          const Icon = section.icon;
          const title = t(section.titleKey);
          const description = t(
            `knowledge.sections.${section.key}.description`,
          );
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
                <p className="text-muted-foreground mt-1 text-sm">
                  {description}
                </p>
              </div>
            </>
          );

          if (section.to) {
            return (
              <Link
                className={cn(
                  "bg-card rounded-xl border p-5",
                  "transition-colors",
                  "hover:border-foreground/15 hover:shadow-sm",
                )}
                key={section.key}
                to={section.to}
              >
                {cardBody}
              </Link>
            );
          }

          return (
            <button
              type="button"
              className={cn(
                "bg-card rounded-xl border p-5 text-start",
                "hover:border-foreground/15 opacity-50 transition-colors",
              )}
              key={section.key}
              onClick={() => {
                stellaToast.add({
                  title: t("common.comingSoon"),
                  type: "neutral",
                });
              }}
            >
              {cardBody}
              <p className="text-muted-foreground mt-3 text-xs">
                {t("common.comingSoon")}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
