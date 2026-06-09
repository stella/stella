import { useEffect, useMemo, useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  FileCodeIcon,
  FileIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { FileTree } from "@/components/file-tree/file-tree";
import type { FileTreeNode } from "@/components/file-tree/file-tree";
import { useInspectorStore } from "@/components/inspector/inspector-store";
import { api } from "@/lib/api";
import { MARKDOWN_MIME, isMarkdownFile } from "@/lib/consts";
import { APIError, toAPIError, userErrorFromThrown } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import {
  knowledgeKeys,
  skillDetailOptions,
} from "@/routes/_protected.knowledge/-queries";
import { catalogueKeys } from "@/routes/_protected.knowledge/-queries/catalogue";

const SKILL_BODY_FILE_NAME = "SKILL.md";

// Mirrors apps/api/src/handlers/skills/resources/resource-path.ts.
// Keep the two in sync.
const RESOURCE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u;
const FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

const UPLOAD_ACCEPT =
  ".md,.txt,.docx,.pdf,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const UPLOAD_MAX_BYTES_TEXT = 100_000;
const UPLOAD_MAX_BYTES_BINARY = 5 * 1024 * 1024;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";
const isBinaryUpload = (file: File) =>
  file.type === DOCX_MIME ||
  file.type === PDF_MIME ||
  file.name.toLowerCase().endsWith(".docx") ||
  file.name.toLowerCase().endsWith(".pdf");

type SkillResource = {
  id: string;
  path: string;
  kind: string;
  sizeBytes: number;
  content: string;
};

type SelectedFile =
  | { type: "body" }
  | { type: "resource"; resourceId: string; path: string };

const protectedRouteApi = getRouteApi("/_protected");

type SkillEditorProps = {
  skillId: string;
};

export function SkillEditor({ skillId }: SkillEditorProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const openSkillResourceTab = useInspectorStore((s) => s.openSkillResourceTab);

  const detail = useQuery(skillDetailOptions(activeOrganizationId, skillId));

  // Editing happens in the right-side inspector; the editor just invalidates so
  // the catalogue + coaching reflect saves the inspector makes.
  const onChanged = () => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.skills.all(activeOrganizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: catalogueKeys.list(activeOrganizationId),
    });
  };

  // Highlights the row whose file is open in the inspector.
  const [selected, setSelected] = useState<SelectedFile>({ type: "body" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [command, setCommand] = useState("");
  const [autoInvokeHint, setAutoInvokeHint] = useState("");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [renamingResourceId, setRenamingResourceId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleCollapsed = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!detail.data) {
      return;
    }
    setName(detail.data.name);
    setDescription(detail.data.description);
    setEnabled(detail.data.enabled);
    setCommand(detail.data.command ?? "");
    setAutoInvokeHint(detail.data.autoInvokeHint ?? "");
  }, [detail.data]);

  const resources: SkillResource[] = useMemo(() => {
    if (!detail.data) {
      return [];
    }
    return detail.data.resources;
  }, [detail.data]);

  const existingPaths = useMemo(
    () => new Set(resources.map((entry) => entry.path)),
    [resources],
  );

  const safeSkillId = toSafeId<"agentSkill">(skillId);
  const skillName = detail.data?.name ?? "";
  const bodyContent = detail.data?.body ?? "";

  // Clicking a file opens it in the right-side Inspector (the matters Files-view
  // pattern). Markdown files render in the Folio WYSIWYG editor there; other text
  // files use the raw editor — both handled inside the inspector panel.
  const selectFile = (next: SelectedFile) => {
    setSelected(next);
    if (next.type === "body") {
      openSkillResourceTab({
        skillName,
        skillId,
        origin: "upload",
        target: "body",
        resourcePath: SKILL_BODY_FILE_NAME,
        label: SKILL_BODY_FILE_NAME,
        mimeType: MARKDOWN_MIME,
        content: bodyContent,
      });
      return;
    }
    const resource = resources.find((entry) => entry.id === next.resourceId);
    if (!resource) {
      return;
    }
    openSkillResourceTab({
      skillName,
      skillId,
      origin: "upload",
      target: "resource",
      resourcePath: resource.path,
      label: resource.path.split("/").at(-1) ?? resource.path,
      mimeType: isMarkdownFile({ fileName: resource.path })
        ? MARKDOWN_MIME
        : "text/plain",
      content: resource.content,
    });
  };

  // Mutations
  const patchMetadata = useMutation({
    mutationFn: async (payload: {
      name?: string;
      description?: string;
      version?: string | null;
      enabled?: boolean;
      command?: string | null;
      autoInvokeHint?: string | null;
    }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .patch({ ...payload, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      onChanged();
      void detail.refetch();
    },
    onError: (error) => {
      if (APIError.is(error) && error.status === 409) {
        setCommandError(t("knowledge.skills.commandConflict"));
        return;
      }
      toastError(error, t("common.unexpectedError"));
    },
  });

  const createResource = useMutation({
    mutationFn: async (payload: { path: string; content: string }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .resources.post({ ...payload, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      onChanged();
      void detail.refetch();
      // New files are always .md, so select straight into the main-pane editor.
      selectFile({ type: "resource", resourceId: data.id, path: data.path });
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const uploadResource = useMutation({
    mutationFn: async (payload: { path: string; file: File }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .resources.upload.post({
          ...payload,
          queryKey: ["skills"],
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      onChanged();
      void detail.refetch();
      setSelected({
        type: "resource",
        resourceId: data.id,
        path: data.path,
      });
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const deleteResource = useMutation({
    mutationFn: async (payload: { path: string; resourceId: string }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .resources.delete({ path: payload.path, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return { ...response.data, resourceId: payload.resourceId };
    },
    onSuccess: (result) => {
      // If the deleted file was selected, jump back to SKILL.md.
      if (
        selected.type === "resource" &&
        selected.resourceId === result.resourceId
      ) {
        setSelected({ type: "body" });
      }
      onChanged();
      void detail.refetch();
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const renameResource = useMutation({
    mutationFn: async (payload: { oldPath: string; newPath: string }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .resources.rename.post({ ...payload, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      onChanged();
      void detail.refetch();
      setRenamingResourceId(null);
      setRenameValue("");
      // Follow the rename: if the renamed row was selected, refresh selection.
      if (selected.type === "resource" && selected.resourceId === data.id) {
        setSelected({
          type: "resource",
          resourceId: data.id,
          path: data.path,
        });
      }
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const fileNodes = useMemo(() => buildSkillNodes(resources), [resources]);

  const onPublish = () => {
    if (enabled) {
      return;
    }
    setEnabled(true);
    patchMetadata.mutate({ enabled: true });
  };

  // Metadata commit-on-blur helpers
  const commitName = () => {
    const trimmed = name.trim();
    if (!detail.data || trimmed === detail.data.name || trimmed.length === 0) {
      return;
    }
    patchMetadata.mutate({ name: trimmed });
  };
  const commitDescription = () => {
    const trimmed = description.trim();
    if (
      !detail.data ||
      trimmed === detail.data.description ||
      trimmed.length === 0
    ) {
      return;
    }
    patchMetadata.mutate({ description: trimmed });
  };
  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    patchMetadata.mutate({ enabled: next });
  };

  const COMMAND_PATTERN_LOCAL = /^[a-z0-9][a-z0-9_-]{0,48}$/u;

  const commitCommand = () => {
    if (!detail.data) {
      return;
    }
    const trimmed = command.trim().toLowerCase().replaceAll(/\s/gu, "");
    const next = trimmed.length === 0 ? null : trimmed;
    const previous = detail.data.command ?? null;
    if (next === previous) {
      setCommandError(null);
      return;
    }
    if (next !== null && !COMMAND_PATTERN_LOCAL.test(next)) {
      setCommandError(t("knowledge.skills.errors.commandInvalid"));
      return;
    }
    setCommandError(null);
    patchMetadata.mutate({ command: next });
  };

  const commitAutoInvokeHint = () => {
    if (!detail.data) {
      return;
    }
    const trimmed = autoInvokeHint.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    const previous = detail.data.autoInvokeHint ?? null;
    if (next === previous) {
      return;
    }
    patchMetadata.mutate({ autoInvokeHint: next });
  };

  const handleUpload = async (file: File) => {
    const binary = isBinaryUpload(file);
    const maxBytes = binary ? UPLOAD_MAX_BYTES_BINARY : UPLOAD_MAX_BYTES_TEXT;
    if (file.size > maxBytes) {
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: tSkills("uploadHelp"),
        type: "error",
      });
      return;
    }
    // For binary uploads we replace the extension with `.md` because the
    // stored resource holds the extracted text, not the original bytes.
    const baseName = binary
      ? `${file.name.replace(/\.(docx|pdf)$/iu, "")}.md`
      : file.name;
    const sanitizedName = baseName
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]/gu, "-");
    if (!FILENAME_PATTERN.test(sanitizedName)) {
      stellaToast.add({
        title: tSkills("invalidPath"),
        type: "error",
      });
      return;
    }
    // Drop new uploads into knowledge/ by default. The user can rename
    // afterward if they want a different folder.
    let path = `knowledge/${sanitizedName}`;
    let suffix = 1;
    while (existingPaths.has(path)) {
      suffix += 1;
      path = `knowledge/${sanitizedName.replace(/(\.[^.]+)?$/u, `-${suffix}$1`)}`;
    }
    if (binary) {
      uploadResource.mutate({ path, file });
      return;
    }
    const content = await file.text();
    createResource.mutate({ path, content });
  };

  const onFilePickerChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      void handleUpload(file);
    }
    // Reset so picking the same file again still triggers onChange.
    event.target.value = "";
  };

  const onTriggerUpload = () => {
    fileInputRef.current?.click();
  };

  const onCreateFile = (path: string, content: string) => {
    if (!RESOURCE_PATH_PATTERN.test(path)) {
      stellaToast.add({ title: tSkills("invalidPath"), type: "error" });
      return false;
    }
    if (existingPaths.has(path)) {
      stellaToast.add({ title: tSkills("fileExists"), type: "error" });
      return false;
    }
    createResource.mutate({ path, content });
    return true;
  };

  const onConfirmRename = (oldPath: string, newPath: string) => {
    const trimmed = newPath.trim();
    if (trimmed === oldPath) {
      setRenamingResourceId(null);
      setRenameValue("");
      return;
    }
    if (!RESOURCE_PATH_PATTERN.test(trimmed)) {
      stellaToast.add({ title: tSkills("invalidPath"), type: "error" });
      return;
    }
    if (existingPaths.has(trimmed)) {
      stellaToast.add({ title: tSkills("fileExists"), type: "error" });
      return;
    }
    renameResource.mutate({ oldPath, newPath: trimmed });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Brief settings: what the skill is and where/how it runs. The files
          below are the main surface; editing happens in the inspector. */}
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-center gap-2">
          <Input
            aria-label={tSkills("formName")}
            className="max-w-sm"
            onBlur={commitName}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          {detail.data && (
            <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
              {detail.data.scope === "team"
                ? tSkills("scopeTeam")
                : tSkills("scopePrivate")}
            </span>
          )}
          <Button
            aria-label={
              enabled ? tSkills("disableSkill") : tSkills("enableSkill")
            }
            onClick={toggleEnabled}
            size="icon-sm"
            variant={enabled ? "secondary" : "ghost"}
          >
            <PowerIcon className="size-4" />
          </Button>
          {detail.data && !enabled && (
            <Button
              className="ms-auto"
              disabled={patchMetadata.isPending}
              onClick={onPublish}
              size="sm"
            >
              {tSkills("coaching.publish")}
            </Button>
          )}
        </div>
        <Textarea
          aria-label={tSkills("formDescription")}
          className="min-h-12 resize-y"
          onBlur={commitDescription}
          onChange={(event) => setDescription(event.target.value)}
          value={description}
        />
        {/* Where/how the skill runs: an optional slash command and/or an
            auto-invoke hint. Either, both, or neither can be set. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex flex-1 flex-col gap-1">
            <label
              className="text-muted-foreground text-xs"
              htmlFor="edit-skill-command"
            >
              {t("knowledge.skills.commandLabel")}
            </label>
            <div className="flex items-stretch">
              <span className="bg-muted border-border flex items-center rounded-s-md border border-e-0 px-2 text-xs">
                /
              </span>
              <Input
                className={cn(
                  "rounded-s-none",
                  commandError && "border-destructive",
                )}
                id="edit-skill-command"
                onBlur={commitCommand}
                onChange={(event) => setCommand(event.target.value)}
                placeholder={t("knowledge.skills.commandPlaceholder")}
                value={command}
              />
            </div>
            {commandError && (
              <p className="text-destructive text-xs">{commandError}</p>
            )}
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <label
              className="text-muted-foreground text-xs"
              htmlFor="edit-skill-auto-hint"
            >
              {t("knowledge.skills.autoInvokeHintLabel")}
            </label>
            <Textarea
              className="min-h-12 resize-y"
              id="edit-skill-auto-hint"
              maxLength={2000}
              onBlur={commitAutoInvokeHint}
              onChange={(event) => setAutoInvokeHint(event.target.value)}
              placeholder={t("knowledge.skills.autoInvokeHintPlaceholder")}
              value={autoInvokeHint}
            />
          </div>
        </div>
      </div>
      {/* Files — the skill's bundle, the main surface. Click a file to edit it
          in the inspector. */}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div className="mb-2 flex items-center gap-1 px-1">
          <p className="text-muted-foreground me-auto text-xs font-semibold tracking-wider uppercase">
            {tSkills("filesHeading")}
          </p>
          <RootCreateButton
            createPending={createResource.isPending}
            onCreateFile={onCreateFile}
          />
          <Button
            aria-label={tSkills("uploadFile")}
            disabled={createResource.isPending || uploadResource.isPending}
            onClick={onTriggerUpload}
            size="icon-sm"
            variant="ghost"
          >
            <UploadIcon className="size-4" />
          </Button>
          <input
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={onFilePickerChange}
            ref={fileInputRef}
            type="file"
          />
        </div>
        {detail.isLoading && (
          <p className="text-muted-foreground px-1 text-xs">
            {t("common.loading")}
          </p>
        )}
        {detail.error && (
          <p className="text-destructive px-1 text-sm">
            {userErrorFromThrown(detail.error, t("common.unexpectedError"))}
          </p>
        )}
        {detail.data && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SkillFileTree
              collapsedFolders={collapsedFolders}
              createPending={createResource.isPending}
              deletePending={deleteResource.isPending}
              nodes={fileNodes}
              onCancelRename={() => {
                setRenamingResourceId(null);
                setRenameValue("");
              }}
              onCreateFile={onCreateFile}
              onDeleteFile={(entry) =>
                deleteResource.mutate({
                  path: entry.path,
                  resourceId: entry.id,
                })
              }
              onSelect={selectFile}
              onStartRename={(entry) => {
                setRenamingResourceId(entry.id);
                setRenameValue(entry.path);
              }}
              onSubmitRename={onConfirmRename}
              onToggleCollapsed={toggleCollapsed}
              renamePending={renameResource.isPending}
              renameValue={renameValue}
              renamingResourceId={renamingResourceId}
              resources={resources}
              selected={selected}
              setRenameValue={setRenameValue}
            />
          </div>
        )}
      </div>
    </div>
  );
}

type SkillFileTreeProps = {
  collapsedFolders: Set<string>;
  createPending: boolean;
  deletePending: boolean;
  nodes: FileTreeNode[];
  onCancelRename: () => void;
  onCreateFile: (path: string, content: string) => boolean;
  onDeleteFile: (entry: TreeEntry) => void;
  onSelect: (next: SelectedFile) => void;
  onStartRename: (entry: TreeEntry) => void;
  onSubmitRename: (oldPath: string, newPath: string) => void;
  onToggleCollapsed: (path: string) => void;
  renamePending: boolean;
  renameValue: string;
  renamingResourceId: string | null;
  resources: SkillResource[];
  selected: SelectedFile;
  setRenameValue: (value: string) => void;
};

// The SKILL.md body isn't a stored resource, so it gets a synthetic node id and
// is pinned at the top of the tree.
const BODY_NODE_ID = "__body__";

function SkillFileTree({
  collapsedFolders,
  createPending,
  deletePending,
  nodes,
  onCancelRename,
  onCreateFile,
  onDeleteFile,
  onSelect,
  onStartRename,
  onSubmitRename,
  onToggleCollapsed,
  renamePending,
  renameValue,
  renamingResourceId,
  resources,
  selected,
  setRenameValue,
}: SkillFileTreeProps) {
  const resourceById = useMemo(
    () => new Map(resources.map((resource) => [resource.id, resource])),
    [resources],
  );
  // Folders default to expanded; `collapsedFolders` tracks the ones the user
  // closed. Translate that to the expanded-set the shared FileTree expects.
  const expandedIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (siblings: FileTreeNode[]) => {
      for (const node of siblings) {
        if (node.kind !== "folder") {
          continue;
        }
        if (!collapsedFolders.has(node.id)) {
          ids.add(node.id);
        }
        walk(node.children ?? []);
      }
    };
    walk(nodes);
    return ids;
  }, [nodes, collapsedFolders]);
  const selectedId =
    selected.type === "body" ? BODY_NODE_ID : selected.resourceId;

  return (
    <FileTree
      expandedIds={expandedIds}
      nodes={nodes}
      onSelect={(node) => {
        if (node.id === BODY_NODE_ID) {
          onSelect({ type: "body" });
          return;
        }
        const resource = resourceById.get(node.id);
        if (resource) {
          onSelect({
            type: "resource",
            resourceId: resource.id,
            path: resource.path,
          });
        }
      }}
      onToggle={onToggleCollapsed}
      renderActions={(node) => {
        if (node.kind === "folder") {
          return (
            <FolderCreateActions
              createPending={createPending}
              folderPath={node.id}
              onCreateFile={onCreateFile}
            />
          );
        }
        if (node.id === BODY_NODE_ID) {
          return null;
        }
        const resource = resourceById.get(node.id);
        if (!resource) {
          return null;
        }
        return (
          <FileRowActions
            deletePending={deletePending}
            entry={{
              id: resource.id,
              path: resource.path,
              fileName: node.name,
              kind: resource.kind,
            }}
            onDeleteFile={onDeleteFile}
            onStartRename={onStartRename}
            renamePending={renamePending}
          />
        );
      }}
      renderIcon={(node) => {
        if (node.id === BODY_NODE_ID) {
          return <FileTextIcon className="size-4 shrink-0" />;
        }
        if (node.kind === "file") {
          return fileIcon(node.name);
        }
        return undefined;
      }}
      renderName={(node) => {
        const resource = resourceById.get(node.id);
        if (
          node.kind === "file" &&
          node.id !== BODY_NODE_ID &&
          renamingResourceId === node.id &&
          resource
        ) {
          return (
            <Input
              autoFocus
              className="h-7 flex-1 text-sm"
              onBlur={() => {
                if (renameValue.trim() === resource.path) {
                  onCancelRename();
                }
              }}
              onChange={(event) => setRenameValue(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  onSubmitRename(resource.path, renameValue);
                }
                if (event.key === "Escape") {
                  onCancelRename();
                }
              }}
              value={renameValue}
            />
          );
        }
        return (
          <span className="truncate" title={node.name}>
            {node.name}
          </span>
        );
      }}
      selectedId={selectedId}
    />
  );
}

type TreeEntry = {
  id: string;
  path: string;
  fileName: string;
  kind: string;
};

type FolderCreateActionsProps = {
  createPending: boolean;
  folderPath: string;
  onCreateFile: (path: string, content: string) => boolean;
};

// The "+ file" / "+ folder" affordances for a folder row, surfaced as the
// FileTree's hover actions.
function FolderCreateActions({
  createPending,
  folderPath,
  onCreateFile,
}: FolderCreateActionsProps) {
  const tSkills = useTranslations("knowledge.agentSkills");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [filename, setFilename] = useState("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [subfolder, setSubfolder] = useState("");
  const [subfolderFilename, setSubfolderFilename] = useState("");

  const submitNewFile = () => {
    const trimmed = filename.trim();
    if (!trimmed) {
      return;
    }
    const normalized = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
    if (onCreateFile(`${folderPath}/${normalized}`, "")) {
      setFilename("");
      setNewFileOpen(false);
    }
  };

  const submitNewFolder = () => {
    const folder = subfolder.trim();
    const file = subfolderFilename.trim() || "README.md";
    if (!folder) {
      return;
    }
    const normalizedFile = file.endsWith(".md") ? file : `${file}.md`;
    if (onCreateFile(`${folderPath}/${folder}/${normalizedFile}`, "")) {
      setSubfolder("");
      setSubfolderFilename("");
      setNewFolderOpen(false);
    }
  };

  return (
    <>
      <Popover onOpenChange={setNewFolderOpen} open={newFolderOpen}>
        <PopoverTrigger
          render={
            <Button
              aria-label={tSkills("newFolder")}
              size="icon-sm"
              variant="ghost"
            >
              <FolderPlusIcon className="size-3.5" />
            </Button>
          }
        />
        <PopoverContent className="flex w-72 flex-col gap-2 p-2">
          <Input
            autoFocus
            onChange={(event) => setSubfolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setNewFolderOpen(false);
              }
            }}
            placeholder={tSkills("newFolderNamePlaceholder")}
            value={subfolder}
          />
          <Input
            onChange={(event) => setSubfolderFilename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitNewFolder();
              }
              if (event.key === "Escape") {
                setNewFolderOpen(false);
              }
            }}
            placeholder={tSkills("newFolderFilenamePlaceholder")}
            value={subfolderFilename}
          />
          <Button
            disabled={createPending || subfolder.trim().length === 0}
            onClick={submitNewFolder}
            size="sm"
          >
            {tSkills("newFolder")}
          </Button>
        </PopoverContent>
      </Popover>
      <Popover onOpenChange={setNewFileOpen} open={newFileOpen}>
        <PopoverTrigger
          render={
            <Button
              aria-label={tSkills("newFile")}
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          }
        />
        <PopoverContent className="w-64">
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              onChange={(event) => setFilename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitNewFile();
                }
                if (event.key === "Escape") {
                  setNewFileOpen(false);
                }
              }}
              placeholder={tSkills("newFileFilenamePlaceholder")}
              value={filename}
            />
            <Button
              disabled={createPending || filename.trim().length === 0}
              onClick={submitNewFile}
              size="sm"
            >
              {tSkills("newFile")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

type FileRowActionsProps = {
  deletePending: boolean;
  entry: TreeEntry;
  onDeleteFile: (entry: TreeEntry) => void;
  onStartRename: (entry: TreeEntry) => void;
  renamePending: boolean;
};

// Rename + delete affordances for a file row.
function FileRowActions({
  deletePending,
  entry,
  onDeleteFile,
  onStartRename,
  renamePending,
}: FileRowActionsProps) {
  const tSkills = useTranslations("knowledge.agentSkills");
  const t = useTranslations();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <>
      <Button
        aria-label={tSkills("renameFile")}
        disabled={renamePending}
        onClick={() => onStartRename(entry)}
        size="icon-sm"
        variant="ghost"
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Popover onOpenChange={setConfirmingDelete} open={confirmingDelete}>
        <PopoverTrigger
          render={
            <Button
              aria-label={tSkills("deleteFile")}
              disabled={deletePending}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          }
        />
        <PopoverContent className="flex w-56 flex-col gap-2 p-2 text-sm">
          <span>{tSkills("deleteFileConfirm")}</span>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setConfirmingDelete(false)}
              size="sm"
              variant="ghost"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={deletePending}
              onClick={() => {
                setConfirmingDelete(false);
                onDeleteFile(entry);
              }}
              size="sm"
              variant="destructive"
            >
              {tSkills("deleteFile")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

type RootCreateButtonProps = {
  createPending: boolean;
  onCreateFile: (path: string, content: string) => boolean;
};

// Header affordance for creating a file at an arbitrary path (root or nested).
function RootCreateButton({
  createPending,
  onCreateFile,
}: RootCreateButtonProps) {
  const tSkills = useTranslations("knowledge.agentSkills");
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");

  const submit = () => {
    const trimmed = path.trim();
    if (!trimmed) {
      return;
    }
    if (onCreateFile(trimmed, "")) {
      setPath("");
      setOpen(false);
    }
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={tSkills("newFile")}
            size="icon-sm"
            variant="ghost"
          >
            <FilePlusIcon className="size-4" />
          </Button>
        }
      />
      <PopoverContent className="w-72">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={tSkills("newFilePathPlaceholder")}
            value={path}
          />
          <Button
            disabled={createPending || path.trim().length === 0}
            onClick={submit}
            size="sm"
          >
            {tSkills("newFile")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const CODE_EXTENSIONS = new Set([
  "json",
  "yml",
  "yaml",
  "toml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rb",
  "sh",
]);
const TEXT_EXTENSIONS = new Set(["mdx", "txt", "csv", "tsv"]);

const fileIcon = (fileName: string) => {
  // Recognise markdown via the shared MIME/extension helper so the file view,
  // the inspector rail, and the panel all agree on what counts as markdown.
  if (isMarkdownFile({ fileName })) {
    return <FileTextIcon className="size-4 shrink-0" />;
  }
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return <FileTextIcon className="size-4 shrink-0" />;
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return <FileCodeIcon className="size-4 shrink-0" />;
  }
  return <FileIcon className="size-4 shrink-0" />;
};

// SKILL.md is pinned first; resources become a nested folder/file tree keyed by
// path (folder node id = its path, file node id = the resource id).
const buildSkillNodes = (resources: SkillResource[]): FileTreeNode[] => {
  const root: FileTreeNode[] = [];
  const folderByPath = new Map<string, FileTreeNode[]>();
  const ensureFolder = (folderPath: string): FileTreeNode[] => {
    if (folderPath === "") {
      return root;
    }
    const existing = folderByPath.get(folderPath);
    if (existing) {
      return existing;
    }
    const segments = folderPath.split("/");
    const name = segments.at(-1) ?? folderPath;
    const parentPath = segments.slice(0, -1).join("/");
    const children: FileTreeNode[] = [];
    folderByPath.set(folderPath, children);
    ensureFolder(parentPath).push({
      id: folderPath,
      name,
      kind: "folder",
      children,
    });
    return children;
  };
  for (const resource of resources) {
    const segments = resource.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      continue;
    }
    const fileName = segments.at(-1) ?? resource.path;
    const folderPath = segments.slice(0, -1).join("/");
    ensureFolder(folderPath).push({
      id: resource.id,
      name: fileName,
      kind: "file",
    });
  }
  const sortNodes = (siblings: FileTreeNode[]) => {
    siblings.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of siblings) {
      if (node.children) {
        sortNodes(node.children);
      }
    }
  };
  sortNodes(root);
  return [
    { id: BODY_NODE_ID, name: SKILL_BODY_FILE_NAME, kind: "file" },
    ...root,
  ];
};

const toastError = (error: unknown, fallback: string) => {
  stellaToast.add({
    title: fallback,
    description: userErrorFromThrown(error, fallback),
    type: "error",
  });
};
