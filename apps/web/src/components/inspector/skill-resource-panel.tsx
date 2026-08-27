import { useState } from "react";

import { PencilIcon, SaveIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { MarkdownPreview } from "@/components/markdown-preview";
import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import {
  splitFrontmatter,
  toEditorMarkdown,
  toStoredMarkdown,
} from "@/components/skill-body-markdown";
import Tooltip from "@/components/tooltip";
import { api } from "@/lib/api";
import { PDF_MIME, isMarkdownFile } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import { InspectorTabHeader } from "./inspector-tab-header";
import type { SkillResourceTab } from "./inspector-tabs-store";
import { useInspectorTabsStore } from "./inspector-tabs-store";
import { SkillBodyWorkspace } from "./skill-history/skill-body-workspace";

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
  const updateSkillResourceTabContent = useInspectorTabsStore(
    (s) => s.updateSkillResourceTabContent,
  );

  const renderMode = detectRenderMode(tab.mimeType, tab.resourcePath);
  const isEditable =
    renderMode !== "pdf" &&
    tab.origin !== "built-in" &&
    tab.origin !== "bundled" &&
    tab.skillId !== null;
  // Markdown edits in the shared hybrid editor (auto-saving), so the ICP
  // never leaves the formatted view; syntax only shows on the block being edited.
  // Other text files keep the raw editor below.
  const useHybridEditor =
    renderMode === "markdown" && isEditable && tab.skillId !== null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.content);
  const [saving, setSaving] = useState(false);

  // Reset the editor when the underlying tab identity or server content
  // changes (a key-reset belongs on the parent panel, outside this batch).
  // Adjusting state during render avoids the extra commit + cascading render.
  const [lastTabId, setLastTabId] = useState(tab.id);
  const [lastTabContent, setLastTabContent] = useState(tab.content);
  if (tab.id !== lastTabId || tab.content !== lastTabContent) {
    setLastTabId(tab.id);
    setLastTabContent(tab.content);
    setEditing(false);
    setDraft(tab.content);
  }

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
        ? await skill.patch({ body: nextContent })
        : await skill.resources.patch({
            path: tab.resourcePath,
            content: nextContent,
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

  // Autosave path for the hybrid editor. The editor emits debounced markdown
  // with the skill frontmatter stripped; re-prepend it before persisting. Saves are serialized: one PATCH in flight at a time, the
  // newest markdown coalesced behind it. Concurrent PATCHes could be applied by
  // the server out of order, silently persisting stale content even when the
  // client discards the stale response. Queues are keyed per tab — the panel
  // is not remounted on tab switch, so a single queue would let an in-flight
  // save for one file consume markdown queued for another.
  const [saveQueues] = useState(
    () => new Map<string, { inFlight: boolean; pending: string | null }>(),
  );
  const saveQueueFor = (tabId: string) => {
    const existing = saveQueues.get(tabId);
    if (existing) {
      return existing;
    }
    const fresh = { inFlight: false, pending: null };
    saveQueues.set(tabId, fresh);
    return fresh;
  };
  const runSaveLoop = async (editorMarkdown: string) => {
    if (tab.skillId === null) {
      return;
    }
    // Snapshot the tab now: the loop may outlive a tab switch, and `tab` would
    // then point at a different file.
    const { content, id: tabId, resourcePath, target } = tab;
    const skill = api.skills({ skillId: toSafeId<"agentSkill">(tab.skillId) });
    const queue = saveQueueFor(tabId);
    queue.inFlight = true;
    let next: string | null = editorMarkdown;
    while (next !== null) {
      const stored = toStoredMarkdown(next, content);
      const response =
        target === "body"
          ? // oxlint-disable-next-line no-await-in-loop -- sequential save queue: each write must land before retrying with newer markdown
            await skill.patch({ body: stored })
          : // oxlint-disable-next-line no-await-in-loop -- sequential save queue: each write must land before retrying with newer markdown
            await skill.resources.patch({
              path: resourcePath,
              content: stored,
            });
      next = queue.pending;
      queue.pending = null;
      if (response.error) {
        // Superseded by newer markdown: retry with that instead of toasting.
        if (next !== null) {
          continue;
        }
        stellaToast.add({
          title: t("common.unexpectedError"),
          description: toAPIError(response.error).message,
          type: "error",
        });
        break;
      }
      updateSkillResourceTabContent(tabId, stored);
    }
    queue.inFlight = false;
  };
  const persistMarkdown = (editorMarkdown: string) => {
    const queue = saveQueueFor(tab.id);
    if (queue.inFlight) {
      queue.pending = editorMarkdown;
      return;
    }
    detached(runSaveLoop(editorMarkdown), "skill-resource-panel.run-save-loop");
  };

  // The body was replaced wholesale by something other than the editor (an
  // accepted proposal). The server already holds it; only the open tab needs
  // to catch up, and the frontmatter stays the metadata the form owns.
  const adoptBody = (editorMarkdown: string) => {
    updateSkillResourceTabContent(
      tab.id,
      toStoredMarkdown(editorMarkdown, tab.content),
    );
  };

  const restoreBody = (editorMarkdown: string) => {
    persistMarkdown(editorMarkdown);
    adoptBody(editorMarkdown);
  };

  const renderContentPane = () => {
    const hybridSkillId = useHybridEditor ? tab.skillId : null;
    if (hybridSkillId === null) {
      return (
        <SkillResourceBody
          content={tab.content}
          draft={draft}
          editing={editing}
          editLabel={t("common.edit")}
          onDraftChange={setDraft}
          pdfPlaceholder={t("knowledge.agentSkills.pdfPreviewSoon")}
          renderMode={renderMode}
        />
      );
    }
    if (tab.target === "body") {
      return (
        <SkillBodyWorkspace
          frontmatterLength={splitFrontmatter(tab.content).frontmatter.length}
          key={tab.id}
          liveMarkdown={toEditorMarkdown(tab.content)}
          onAdoptBody={adoptBody}
          onPersistBody={persistMarkdown}
          onRestoreBody={restoreBody}
          skillId={hybridSkillId}
        />
      );
    }
    return (
      <MarkdownHybridEditor
        key={tab.id}
        markdown={toEditorMarkdown(tab.content)}
        onMarkdownChange={persistMarkdown}
      />
    );
  };

  return (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <InspectorTabHeader
        actions={
          isEditable && !useHybridEditor ? (
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
                      detached(save(), "skill-resource-panel.save");
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
          <Tooltip
            content={`${tab.skillName} · ${tab.resourcePath}`}
            render={
              <span className="text-muted-foreground truncate font-mono text-[10px]">
                {tab.skillName}
              </span>
            }
          />
        }
        onClose={onClose}
      />
      {renderContentPane()}
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
