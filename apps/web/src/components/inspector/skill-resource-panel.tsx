import { useEffect, useState } from "react";

import { PencilIcon, SaveIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { MarkdownPreview } from "@/components/markdown-preview";
import { api } from "@/lib/api";
import { PDF_MIME, isMarkdownFile } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

import type { SkillResourceTab } from "./inspector-store";
import { useInspectorStore } from "./inspector-store";
import { InspectorTabHeader } from "./inspector-tab-header";

type RenderMode = "markdown" | "text" | "pdf";

const detectRenderMode = (
  mimeType: string,
  resourcePath: string,
): RenderMode => {
  const mime = mimeType.toLowerCase();
  if (mime === PDF_MIME || resourcePath.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  if (isMarkdownFile({ fileName: resourcePath, mimeType })) {
    return "markdown";
  }
  return "text";
};

const basenameOf = (path: string): string => {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
};

type SkillResourcePanelProps = {
  tab: SkillResourceTab;
  onClose: () => void;
};

export const SkillResourcePanel = ({
  tab,
  onClose,
}: SkillResourcePanelProps) => {
  const t = useTranslations();
  const updateSkillResourceTabContent = useInspectorStore(
    (s) => s.updateSkillResourceTabContent,
  );

  const renderMode = detectRenderMode(tab.mimeType, tab.resourcePath);
  const isEditable =
    renderMode !== "pdf" && tab.origin !== "built-in" && tab.skillId !== null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.content);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDraft(tab.content);
  }, [tab.id, tab.content]);

  const save = async () => {
    if (saving || tab.skillId === null) {
      return;
    }
    setSaving(true);
    const nextContent = draft;
    const skill = api.skills({ skillId: toSafeId<"agentSkill">(tab.skillId) });
    // The SKILL.md body lives on the skill row; companion files are separate
    // resource rows. Same panel, two save endpoints.
    const response =
      tab.target === "body"
        ? await skill.patch({ body: nextContent, queryKey: ["skills"] })
        : await skill.resources.patch({
            path: tab.resourcePath,
            content: nextContent,
            queryKey: ["skills"],
          });
    setSaving(false);
    if (response.error) {
      const apiError = toAPIError(response.error);
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: apiError.message,
        type: "error",
      });
      return;
    }
    updateSkillResourceTabContent(tab.id, nextContent);
    setEditing(false);
    stellaToast.add({
      title: t("common.save"),
      type: "success",
    });
  };

  const cancelEdit = () => {
    setDraft(tab.content);
    setEditing(false);
  };

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <InspectorTabHeader
        actions={
          isEditable ? (
            <div className="flex items-center gap-1">
              {editing ? (
                <>
                  <Button
                    aria-label={t("common.cancel")}
                    disabled={saving}
                    onClick={cancelEdit}
                    size="xs"
                    variant="ghost"
                  >
                    <XIcon className="size-3.5" />
                    {t("common.cancel")}
                  </Button>
                  <Button
                    aria-label={t("common.save")}
                    disabled={saving || draft === tab.content}
                    onClick={() => {
                      void save();
                    }}
                    size="xs"
                  >
                    <SaveIcon className="size-3.5" />
                    {t("common.save")}
                  </Button>
                </>
              ) : (
                <Button
                  aria-label={t("common.edit")}
                  onClick={() => {
                    setDraft(tab.content);
                    setEditing(true);
                  }}
                  size="xs"
                  variant="ghost"
                >
                  <PencilIcon className="size-3.5" />
                  {t("common.edit")}
                </Button>
              )}
            </div>
          ) : null
        }
        label={basenameOf(tab.resourcePath)}
        matter={
          <span
            className="text-muted-foreground truncate font-mono text-[10px]"
            title={`${tab.skillName} · ${tab.resourcePath}`}
          >
            {tab.skillName}
          </span>
        }
        onClose={onClose}
      />
      <SkillResourceBody
        content={tab.content}
        draft={draft}
        editing={editing}
        editLabel={t("common.edit")}
        onDraftChange={setDraft}
        pdfPlaceholder={t("knowledge.agentSkills.pdfPreviewSoon")}
        renderMode={renderMode}
      />
    </div>
  );
};

type SkillResourceBodyProps = {
  content: string;
  draft: string;
  editing: boolean;
  editLabel: string;
  onDraftChange: (next: string) => void;
  pdfPlaceholder: string;
  renderMode: RenderMode;
};

const SkillResourceBody = ({
  content,
  draft,
  editing,
  editLabel,
  onDraftChange,
  pdfPlaceholder,
  renderMode,
}: SkillResourceBodyProps) => {
  if (renderMode === "pdf") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground max-w-sm text-center text-sm">
          {pdfPlaceholder}
        </p>
      </div>
    );
  }
  if (editing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <Textarea
          aria-label={editLabel}
          className="min-h-full flex-1 font-mono text-xs"
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          value={draft}
        />
      </div>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <article className="px-4 py-3 text-sm">
        {renderMode === "markdown" ? (
          <MarkdownPreview>{content}</MarkdownPreview>
        ) : (
          <pre className="text-foreground font-mono text-xs whitespace-pre-wrap">
            {content}
          </pre>
        )}
      </article>
    </ScrollArea>
  );
};
