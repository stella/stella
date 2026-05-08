import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BotIcon,
  LightbulbIcon,
  PlugZapIcon,
  SparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

export const Route = createFileRoute("/_protected/knowledge/")({
  component: KnowledgeLanding,
});

type KnowledgeSection = {
  key: "agents" | "mcp" | "prompts" | "skills";
  icon: LucideIcon;
  to?: "/knowledge/mcp" | "/knowledge/skills";
};

export const knowledgeSections: readonly KnowledgeSection[] = [
  { key: "prompts", icon: LightbulbIcon, to: "/knowledge/skills" },
  { key: "skills", icon: SparklesIcon },
  { key: "mcp", icon: PlugZapIcon, to: "/knowledge/mcp" },
  { key: "agents", icon: BotIcon },
];

function KnowledgeLanding() {
  const t = useTranslations();

  return (
    <div className="flex flex-1 flex-col p-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {knowledgeSections.map((section) => {
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
