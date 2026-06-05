import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { SkillEditor } from "@/routes/_protected.knowledge/-components/skill-editor";

export const Route = createFileRoute("/_protected/knowledge/tools_/$skillId")({
  component: SkillEditorPage,
});

function SkillEditorPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const skillId = Route.useParams({ select: (params) => params.skillId });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button
          onClick={() => navigate({ to: "/knowledge/tools" })}
          size="sm"
          variant="ghost"
        >
          <ChevronLeftIcon className="size-4" />
          {t("knowledge.sections.tools.title")}
        </Button>
      </div>
      <SkillEditor skillId={skillId} />
    </div>
  );
}
