import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BarChart3Icon,
  BotIcon,
  LayoutTemplateIcon,
  LightbulbIcon,
  PlugIcon,
  TextQuoteIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

export const Route = createFileRoute("/_protected/knowledge/")({
  component: KnowledgeLanding,
});

type Section = {
  key:
    | "templates"
    | "clauses"
    | "analytics"
    | "skills"
    | "agents"
    | "connectors";
  icon: LucideIcon;
  to?: "/knowledge/templates" | "/knowledge/clauses" | "/knowledge/analytics";
};

const sections: Section[] = [
  { key: "templates", icon: LayoutTemplateIcon, to: "/knowledge/templates" },
  { key: "clauses", icon: TextQuoteIcon, to: "/knowledge/clauses" },
  { key: "analytics", icon: BarChart3Icon, to: "/knowledge/analytics" },
  { key: "skills", icon: LightbulbIcon },
  { key: "agents", icon: BotIcon },
  { key: "connectors", icon: PlugIcon },
];

function KnowledgeLanding() {
  const t = useTranslations();

  return (
    <div className="flex flex-1 flex-col p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => {
          const Icon = section.icon;
          const title = t(`knowledge.sections.${section.key}.title`);
          const description = t(
            `knowledge.sections.${section.key}.description`,
          );
          const cardBody = (
            <>
              <div
                className={cn(
                  "flex size-10 items-center justify-center",
                  "rounded-lg bg-muted",
                )}
              >
                <Icon className="size-5" />
              </div>
              <div className="mt-3">
                <h2 className="text-sm font-semibold">{title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {description}
                </p>
              </div>
            </>
          );

          if (section.to) {
            return (
              <Link
                className={cn(
                  "rounded-xl border bg-card p-5",
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
            <div
              className={cn(
                "rounded-xl border bg-card p-5",
                "cursor-default opacity-50",
              )}
              key={section.key}
            >
              {cardBody}
              <p className="mt-3 text-xs text-muted-foreground">
                {t("common.comingSoon")}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
