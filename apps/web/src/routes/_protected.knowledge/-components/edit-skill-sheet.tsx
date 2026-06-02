import { useEffect, useMemo, useRef, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { skillDetailOptions } from "@/routes/_protected.knowledge/-queries";

const SKILL_BODY_FILE_NAME = "SKILL.md";
const TEXT_RESOURCE_KINDS = new Set([
  "asset",
  "knowledge",
  "prompt",
  "reference",
  "script",
  "template",
]);

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

type EditableSkill = {
  id: string;
  name: string;
  scope: "team" | "private";
  enabled: boolean;
};

type EditSkillSheetProps = {
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  skill: EditableSkill | null;
};

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

export function EditSkillSheet({
  onChanged,
  onOpenChange,
  open,
  skill,
}: EditSkillSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="flex h-[min(900px,90vh)] w-[min(1100px,92vw)] max-w-none flex-col p-0">
        {skill ? (
          <EditSkillSheetBody
            key={skill.id}
            onChanged={onChanged}
            skill={skill}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

type EditSkillSheetBodyProps = {
  onChanged: () => void;
  skill: EditableSkill;
};

function EditSkillSheetBody({ onChanged, skill }: EditSkillSheetBodyProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const detail = useQuery(skillDetailOptions(activeOrganizationId, skill.id));

  const [selected, setSelected] = useState<SelectedFile>({ type: "body" });
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const [draftResources, setDraftResources] = useState<Record<string, string>>(
    {},
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("");
  const [enabled, setEnabled] = useState(skill.enabled);
  const [confirmDiscardFor, setConfirmDiscardFor] =
    useState<SelectedFile | null>(null);
  const [rewritePrompt, setRewritePrompt] = useState("");
  const [rewriteOpen, setRewriteOpen] = useState(false);
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
    setVersion(detail.data.version ?? "");
    setEnabled(detail.data.enabled);
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

  const bodyServerValue = detail.data?.body ?? "";
  const bodyValue = draftBody ?? bodyServerValue;
  const bodyDirty = draftBody !== null && draftBody !== bodyServerValue;

  const selectedResource =
    selected.type === "resource"
      ? (resources.find((entry) => entry.id === selected.resourceId) ?? null)
      : null;
  const resourceServerValue = selectedResource?.content ?? "";
  const resourceDraft =
    selected.type === "resource"
      ? draftResources[selected.resourceId]
      : undefined;
  const resourceValue = resourceDraft ?? resourceServerValue;
  const resourceDirty =
    selected.type === "resource" &&
    resourceDraft !== undefined &&
    resourceDraft !== resourceServerValue;

  const currentDirty = selected.type === "body" ? bodyDirty : resourceDirty;

  const safeSkillId = toSafeId<"agentSkill">(skill.id);

  // Mutations
  const patchBody = useMutation({
    mutationFn: async (nextBody: string) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .patch({ body: nextBody, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      setDraftBody(null);
      onChanged();
      void detail.refetch();
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const patchMetadata = useMutation({
    mutationFn: async (payload: {
      name?: string;
      description?: string;
      version?: string | null;
      enabled?: boolean;
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
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const patchResource = useMutation({
    mutationFn: async (payload: { path: string; content: string }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .resources.patch({ ...payload, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (_data, variables) => {
      setDraftResources((current) => {
        const matching = resources.find(
          (entry) => entry.path === variables.path,
        );
        if (!matching) {
          return current;
        }
        const { [matching.id]: _unused, ...rest } = current;
        return rest;
      });
      onChanged();
      void detail.refetch();
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
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
      // Select the newly created file so the user can keep editing it.
      setSelected({
        type: "resource",
        resourceId: data.id,
        path: data.path,
      });
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
      setDraftResources((current) => {
        const { [result.resourceId]: _unused, ...rest } = current;
        return rest;
      });
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

  const rewriteResource = useMutation({
    mutationFn: async (payload: { path: string; prompt: string }) => {
      const response = await api
        .skills({ skillId: safeSkillId })
        .resources.rewrite.post(payload);
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      // Load as a dirty draft on the resource that requested the rewrite so the
      // user can review it before saving, even if selection changed mid-flight.
      const target = resources.find((resource) => resource.path === data.path);
      if (!target) {
        return;
      }
      setDraftResources((current) => ({
        ...current,
        [target.id]: data.content,
      }));
      setRewriteOpen(false);
      setRewritePrompt("");
    },
    onError: (error) => toastError(error, t("common.unexpectedError")),
  });

  const tree = useMemo(() => buildTree(resources), [resources]);

  const trySelect = (next: SelectedFile) => {
    if (sameSelection(next, selected)) {
      return;
    }
    if (currentDirty) {
      setConfirmDiscardFor(next);
      return;
    }
    setSelected(next);
  };

  const discardCurrentDraft = () => {
    if (selected.type === "body") {
      setDraftBody(null);
      return;
    }
    setDraftResources((current) => {
      const { [selected.resourceId]: _unused, ...rest } = current;
      return rest;
    });
  };

  const onSave = () => {
    if (selected.type === "body") {
      if (draftBody === null || draftBody === bodyServerValue) {
        return;
      }
      patchBody.mutate(draftBody);
      return;
    }
    if (
      !selectedResource ||
      resourceDraft === undefined ||
      resourceDraft === resourceServerValue
    ) {
      return;
    }
    patchResource.mutate({
      path: selectedResource.path,
      content: resourceDraft,
    });
  };

  const isSaving =
    patchBody.isPending || patchResource.isPending || patchMetadata.isPending;
  const saveDisabled = !currentDirty || isSaving;

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
  const commitVersion = () => {
    if (!detail.data) {
      return;
    }
    const trimmed = version.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === (detail.data.version ?? null)) {
      return;
    }
    patchMetadata.mutate({ version: next });
  };
  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    patchMetadata.mutate({ enabled: next });
  };

  const selectedKindIsText =
    selected.type === "body" ||
    (selectedResource ? TEXT_RESOURCE_KINDS.has(selectedResource.kind) : false);

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
    <>
      <DialogHeader className="border-b">
        <DialogTitle>{tSkills("editTitle")}</DialogTitle>
        <div className="mt-2 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label={tSkills("formName")}
              className="max-w-sm"
              onBlur={commitName}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
              {skill.scope === "team"
                ? tSkills("scopeTeam")
                : tSkills("scopePrivate")}
            </span>
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
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Textarea
              aria-label={tSkills("formDescription")}
              className="min-h-12 flex-1 resize-y"
              onBlur={commitDescription}
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
            <Input
              aria-label={tSkills("formVersion")}
              className="sm:max-w-32"
              onBlur={commitVersion}
              onChange={(event) => setVersion(event.target.value)}
              placeholder={tSkills("formVersionPlaceholder")}
              value={version}
            />
          </div>
        </div>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="bg-muted/20 max-h-72 shrink-0 overflow-y-auto border-b sm:max-h-none sm:w-72 sm:border-e sm:border-b-0">
          <div className="p-3">
            <div className="mb-2 flex items-center justify-between gap-1 px-1">
              <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                {tSkills("filesHeading")}
              </p>
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
            {detail.data && (
              <SkillFileTree
                bodyDirty={bodyDirty}
                createPending={createResource.isPending}
                deletePending={deleteResource.isPending}
                dirtyResourceIds={Object.keys(draftResources)}
                onCreateFile={onCreateFile}
                onDeleteFile={(entry) =>
                  deleteResource.mutate({
                    path: entry.path,
                    resourceId: entry.id,
                  })
                }
                onSelect={trySelect}
                onStartRename={(entry) => {
                  setRenamingResourceId(entry.id);
                  setRenameValue(entry.path);
                }}
                onSubmitRename={onConfirmRename}
                onCancelRename={() => {
                  setRenamingResourceId(null);
                  setRenameValue("");
                }}
                renameValue={renameValue}
                renamePending={renameResource.isPending}
                renamingResourceId={renamingResourceId}
                selected={selected}
                setRenameValue={setRenameValue}
                collapsedFolders={collapsedFolders}
                onToggleCollapsed={toggleCollapsed}
                tree={tree}
              />
            )}
          </div>
        </aside>
        <DialogPanel className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {detail.isLoading && (
            <p className="text-muted-foreground text-sm">
              {t("common.loading")}
            </p>
          )}
          {detail.error && (
            <p className="text-destructive text-sm">
              {userErrorFromThrown(detail.error, t("common.unexpectedError"))}
            </p>
          )}
          {detail.data && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground font-mono text-sm">
                  {selected.type === "body"
                    ? SKILL_BODY_FILE_NAME
                    : selected.path}
                </span>
                <div className="flex items-center gap-2">
                  {selected.type === "resource" && (
                    <Button
                      aria-label={tSkills("aiRewrite")}
                      disabled={rewriteResource.isPending}
                      onClick={() => setRewriteOpen((open) => !open)}
                      size="sm"
                      variant="ghost"
                    >
                      <SparklesIcon className="size-4" />
                      <span className="ms-1">{tSkills("aiRewrite")}</span>
                    </Button>
                  )}
                  <Button disabled={saveDisabled} onClick={onSave} size="sm">
                    {isSaving ? t("common.loading") : t("common.save")}
                  </Button>
                </div>
              </div>
              {confirmDiscardFor && (
                <div className="bg-muted/40 border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>{tSkills("unsavedChanges")}</span>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => setConfirmDiscardFor(null)}
                      size="sm"
                      variant="ghost"
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      onClick={() => {
                        discardCurrentDraft();
                        setSelected(confirmDiscardFor);
                        setConfirmDiscardFor(null);
                      }}
                      size="sm"
                      variant="destructive"
                    >
                      {tSkills("discardChanges")}
                    </Button>
                  </div>
                </div>
              )}
              {rewriteOpen && selected.type === "resource" && (
                <div className="border-border bg-muted/30 flex flex-col gap-2 rounded-md border p-2">
                  <label
                    className="text-muted-foreground px-1 text-xs"
                    htmlFor="ai-rewrite-prompt"
                  >
                    {tSkills("aiRewritePrompt")}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="ai-rewrite-prompt"
                      className="flex-1"
                      onChange={(event) => setRewritePrompt(event.target.value)}
                      placeholder={tSkills("aiRewritePlaceholder")}
                      value={rewritePrompt}
                    />
                    <Button
                      disabled={
                        rewriteResource.isPending ||
                        rewritePrompt.trim().length === 0
                      }
                      onClick={() => {
                        rewriteResource.mutate({
                          path: selected.path,
                          prompt: rewritePrompt.trim(),
                        });
                      }}
                      size="sm"
                    >
                      {rewriteResource.isPending
                        ? tSkills("aiRewriteRunning")
                        : tSkills("aiRewrite")}
                    </Button>
                  </div>
                </div>
              )}
              {selectedKindIsText ? (
                <Textarea
                  className="min-h-96 flex-1 resize-none font-mono"
                  onChange={(event) => {
                    if (selected.type === "body") {
                      setDraftBody(event.target.value);
                      return;
                    }
                    setDraftResources((current) => ({
                      ...current,
                      [selected.resourceId]: event.target.value,
                    }));
                  }}
                  value={selected.type === "body" ? bodyValue : resourceValue}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {tSkills("binaryPreviewUnsupported")}
                </p>
              )}
            </>
          )}
        </DialogPanel>
      </div>
    </>
  );
}

const sameSelection = (a: SelectedFile, b: SelectedFile) => {
  if (a.type === "body" && b.type === "body") {
    return true;
  }
  if (a.type === "resource" && b.type === "resource") {
    return a.resourceId === b.resourceId;
  }
  return false;
};

type SkillFileTreeProps = {
  bodyDirty: boolean;
  collapsedFolders: Set<string>;
  createPending: boolean;
  deletePending: boolean;
  dirtyResourceIds: string[];
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
  selected: SelectedFile;
  setRenameValue: (value: string) => void;
  tree: TreeGroup[];
};

function SkillFileTree({
  bodyDirty,
  collapsedFolders,
  createPending,
  deletePending,
  dirtyResourceIds,
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
  selected,
  setRenameValue,
  tree,
}: SkillFileTreeProps) {
  const dirtySet = useMemo(() => new Set(dirtyResourceIds), [dirtyResourceIds]);
  const groupByPrefix = useMemo(
    () => new Map(tree.map((group) => [group.prefix, group])),
    [tree],
  );

  // Only render folders that actually exist in the skill. Empty
  // "+ New file" affordances for knowledge/prompts/references would
  // create phantom folders the user can't see in the source bundle.
  const knownFolders = tree
    .map((group) => group.prefix)
    .filter((prefix) => prefix !== "/")
    .sort((a, b) => a.localeCompare(b));
  const rootGroup = groupByPrefix.get("/");

  return (
    <ul className="flex flex-col gap-3">
      <li>
        <FileRow
          dirty={bodyDirty}
          icon={<FileTextIcon className="size-4" />}
          label={SKILL_BODY_FILE_NAME}
          onClick={() => onSelect({ type: "body" })}
          selected={selected.type === "body"}
        />
      </li>
      {knownFolders.map((prefix) => {
        const group = groupByPrefix.get(prefix);
        const children = group?.children ?? [];
        const collapsed = collapsedFolders.has(prefix);
        return (
          <li className="flex flex-col gap-1" key={prefix}>
            <FolderHeader
              collapsed={collapsed}
              createPending={createPending}
              onCreateFile={onCreateFile}
              onToggleCollapsed={() => onToggleCollapsed(prefix)}
              prefix={prefix}
            />
            {!collapsed && (
              <TreeNodeList
                collapsedFolders={collapsedFolders}
                deletePending={deletePending}
                depth={1}
                dirtySet={dirtySet}
                nodes={children}
                onCancelRename={onCancelRename}
                onCreateFile={onCreateFile}
                onDeleteFile={onDeleteFile}
                onSelect={onSelect}
                onStartRename={onStartRename}
                onSubmitRename={onSubmitRename}
                onToggleCollapsed={onToggleCollapsed}
                parentPath={prefix}
                createPending={createPending}
                renamePending={renamePending}
                renameValue={renameValue}
                renamingResourceId={renamingResourceId}
                selected={selected}
                setRenameValue={setRenameValue}
              />
            )}
          </li>
        );
      })}
      <li className="flex flex-col gap-1">
        <RootFolderHeader
          createPending={createPending}
          onCreateFile={onCreateFile}
        />
        <TreeNodeList
          collapsedFolders={collapsedFolders}
          createPending={createPending}
          deletePending={deletePending}
          depth={1}
          dirtySet={dirtySet}
          nodes={rootGroup?.children ?? []}
          onCancelRename={onCancelRename}
          onCreateFile={onCreateFile}
          onDeleteFile={onDeleteFile}
          onSelect={onSelect}
          onStartRename={onStartRename}
          onSubmitRename={onSubmitRename}
          onToggleCollapsed={onToggleCollapsed}
          parentPath=""
          renamePending={renamePending}
          renameValue={renameValue}
          renamingResourceId={renamingResourceId}
          selected={selected}
          setRenameValue={setRenameValue}
        />
      </li>
    </ul>
  );
}

const TREE_INDENT_PX = 14;

type TreeNodeListProps = {
  collapsedFolders: Set<string>;
  createPending: boolean;
  deletePending: boolean;
  depth: number;
  dirtySet: Set<string>;
  nodes: TreeNode[];
  onCancelRename: () => void;
  onCreateFile: (path: string, content: string) => boolean;
  onDeleteFile: (entry: TreeEntry) => void;
  onSelect: (next: SelectedFile) => void;
  onStartRename: (entry: TreeEntry) => void;
  onSubmitRename: (oldPath: string, newPath: string) => void;
  onToggleCollapsed: (path: string) => void;
  parentPath: string;
  renamePending: boolean;
  renameValue: string;
  renamingResourceId: string | null;
  selected: SelectedFile;
  setRenameValue: (value: string) => void;
};

function TreeNodeList({
  collapsedFolders,
  createPending,
  deletePending,
  depth,
  dirtySet,
  nodes,
  onCancelRename,
  onCreateFile,
  onDeleteFile,
  onSelect,
  onStartRename,
  onSubmitRename,
  onToggleCollapsed,
  parentPath,
  renamePending,
  renameValue,
  renamingResourceId,
  selected,
  setRenameValue,
}: TreeNodeListProps) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => {
        if (node.type === "file") {
          const entry = node.entry;
          return (
            <li key={`f:${entry.id}`}>
              <ResourceRow
                deletePending={deletePending}
                depth={depth}
                dirty={dirtySet.has(entry.id)}
                entry={entry}
                onCancelRename={onCancelRename}
                onDeleteFile={onDeleteFile}
                onSelect={onSelect}
                onStartRename={onStartRename}
                onSubmitRename={onSubmitRename}
                renamePending={renamePending}
                renameValue={renameValue}
                renaming={renamingResourceId === entry.id}
                selected={
                  selected.type === "resource" &&
                  selected.resourceId === entry.id
                }
                setRenameValue={setRenameValue}
              />
            </li>
          );
        }
        const folderPath =
          parentPath.length > 0 ? `${parentPath}/${node.name}` : node.name;
        const collapsed = collapsedFolders.has(folderPath);
        return (
          <li className="flex flex-col" key={`d:${folderPath}`}>
            <NestedFolderHeader
              collapsed={collapsed}
              createPending={createPending}
              depth={depth}
              folderPath={folderPath}
              name={node.name}
              onCreateFile={onCreateFile}
              onToggleCollapsed={() => onToggleCollapsed(folderPath)}
            />
            {!collapsed && (
              <TreeNodeList
                collapsedFolders={collapsedFolders}
                createPending={createPending}
                deletePending={deletePending}
                depth={depth + 1}
                dirtySet={dirtySet}
                nodes={node.children}
                onCancelRename={onCancelRename}
                onCreateFile={onCreateFile}
                onDeleteFile={onDeleteFile}
                onSelect={onSelect}
                onStartRename={onStartRename}
                onSubmitRename={onSubmitRename}
                onToggleCollapsed={onToggleCollapsed}
                parentPath={folderPath}
                renamePending={renamePending}
                renameValue={renameValue}
                renamingResourceId={renamingResourceId}
                selected={selected}
                setRenameValue={setRenameValue}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

type NestedFolderHeaderProps = {
  collapsed: boolean;
  createPending: boolean;
  depth: number;
  folderPath: string;
  name: string;
  onCreateFile: (path: string, content: string) => boolean;
  onToggleCollapsed: () => void;
};

function NestedFolderHeader({
  collapsed,
  createPending,
  depth,
  folderPath,
  name,
  onCreateFile,
  onToggleCollapsed,
}: NestedFolderHeaderProps) {
  return (
    <FolderHeaderShell
      collapsed={collapsed}
      createPending={createPending}
      folderPath={folderPath}
      label={`${name}/`}
      onCreateFile={onCreateFile}
      onToggleCollapsed={onToggleCollapsed}
      paddingInlineStart={`${8 + depth * TREE_INDENT_PX}px`}
    />
  );
}

type FolderHeaderProps = {
  collapsed: boolean;
  createPending: boolean;
  onCreateFile: (path: string, content: string) => boolean;
  onToggleCollapsed: () => void;
  prefix: string;
};

function FolderHeader({
  collapsed,
  createPending,
  onCreateFile,
  onToggleCollapsed,
  prefix,
}: FolderHeaderProps) {
  return (
    <FolderHeaderShell
      collapsed={collapsed}
      createPending={createPending}
      folderPath={prefix}
      label={`${prefix}/`}
      onCreateFile={onCreateFile}
      onToggleCollapsed={onToggleCollapsed}
      paddingInlineStart="8px"
    />
  );
}

type FolderHeaderShellProps = {
  collapsed: boolean;
  createPending: boolean;
  folderPath: string;
  label: string;
  onCreateFile: (path: string, content: string) => boolean;
  onToggleCollapsed: () => void;
  paddingInlineStart: string;
};

function FolderHeaderShell({
  collapsed,
  createPending,
  folderPath,
  label,
  onCreateFile,
  onToggleCollapsed,
  paddingInlineStart,
}: FolderHeaderShellProps) {
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
    const ok = onCreateFile(`${folderPath}/${normalized}`, "");
    if (ok) {
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
    const ok = onCreateFile(`${folderPath}/${folder}/${normalizedFile}`, "");
    if (ok) {
      setSubfolder("");
      setSubfolderFilename("");
      setNewFolderOpen(false);
    }
  };

  return (
    <div
      className="text-muted-foreground flex items-center gap-1.5 py-1 text-xs"
      style={{ paddingInlineStart }}
    >
      <button
        aria-expanded={!collapsed}
        className="hover:text-foreground flex flex-1 items-center gap-1.5 text-start"
        onClick={onToggleCollapsed}
        type="button"
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
        <FolderIcon className="size-3.5" />
        <span className="font-mono">{label}</span>
      </button>
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
        <PopoverContent className="flex w-64 flex-col gap-2 p-2">
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
        </PopoverContent>
      </Popover>
    </div>
  );
}

type RootFolderHeaderProps = {
  createPending: boolean;
  onCreateFile: (path: string, content: string) => boolean;
};

function RootFolderHeader({
  createPending,
  onCreateFile,
}: RootFolderHeaderProps) {
  const tSkills = useTranslations("knowledge.agentSkills");
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");

  const submit = () => {
    const trimmed = path.trim();
    if (!trimmed) {
      return;
    }
    const ok = onCreateFile(trimmed, "");
    if (ok) {
      setPath("");
      setOpen(false);
    }
  };

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 px-2 text-xs">
      <FilePlusIcon className="size-3.5" />
      <span className="font-mono">/</span>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={tSkills("newFile")}
              className="ms-auto"
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          }
        />
        <PopoverContent className="flex w-72 flex-col gap-2 p-2">
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
        </PopoverContent>
      </Popover>
    </div>
  );
}

type ResourceRowProps = {
  deletePending: boolean;
  depth: number;
  dirty: boolean;
  entry: TreeEntry;
  onCancelRename: () => void;
  onDeleteFile: (entry: TreeEntry) => void;
  onSelect: (next: SelectedFile) => void;
  onStartRename: (entry: TreeEntry) => void;
  onSubmitRename: (oldPath: string, newPath: string) => void;
  renamePending: boolean;
  renameValue: string;
  renaming: boolean;
  selected: boolean;
  setRenameValue: (value: string) => void;
};

function ResourceRow({
  deletePending,
  depth,
  dirty,
  entry,
  onCancelRename,
  onDeleteFile,
  onSelect,
  onStartRename,
  onSubmitRename,
  renamePending,
  renameValue,
  renaming,
  selected,
  setRenameValue,
}: ResourceRowProps) {
  const paddingInlineStart = `${8 + depth * TREE_INDENT_PX}px`;
  const tSkills = useTranslations("knowledge.agentSkills");
  const t = useTranslations();
  const tCommonCancel = t("common.cancel");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (renaming) {
    return (
      <div
        className="group/row flex items-center gap-1 rounded py-1 pe-1"
        style={{ paddingInlineStart }}
      >
        <span className="text-muted-foreground">
          {fileIcon(entry.fileName)}
        </span>
        <Input
          autoFocus
          className="h-7 flex-1 font-mono text-xs"
          onBlur={() => {
            if (renameValue.trim() === entry.path) {
              onCancelRename();
            }
          }}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmitRename(entry.path, renameValue);
            }
            if (event.key === "Escape") {
              onCancelRename();
            }
          }}
          value={renameValue}
        />
      </div>
    );
  }

  return (
    <div className="group/row relative flex items-center">
      <button
        className={cn(
          "hover:bg-muted/60 flex w-full items-center gap-2 rounded py-1 pe-2 text-start text-sm",
          selected && "bg-muted text-foreground",
        )}
        onClick={() =>
          onSelect({
            type: "resource",
            resourceId: entry.id,
            path: entry.path,
          })
        }
        style={{ paddingInlineStart }}
        type="button"
      >
        <span className="text-muted-foreground">
          {fileIcon(entry.fileName)}
        </span>
        <span className="truncate font-mono text-xs">{entry.fileName}</span>
        {dirty && (
          <span
            aria-hidden="true"
            className="bg-warning ms-auto size-1.5 shrink-0 rounded-full"
          />
        )}
      </button>
      <div className="invisible absolute end-1 flex gap-0.5 group-hover/row:visible">
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
                {tCommonCancel}
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
      </div>
    </div>
  );
}

type FileRowProps = {
  dirty: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  selected: boolean;
};

function FileRow({ dirty, icon, label, onClick, selected }: FileRowProps) {
  return (
    <button
      className={cn(
        "hover:bg-muted/60 flex w-full items-center gap-2 rounded px-2 py-1 text-start text-sm",
        selected && "bg-muted text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="truncate font-mono text-xs">{label}</span>
      {dirty && (
        <span
          aria-hidden="true"
          className="bg-warning ms-auto size-1.5 shrink-0 rounded-full"
        />
      )}
    </button>
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
const TEXT_EXTENSIONS = new Set(["md", "mdx", "txt", "csv", "tsv"]);

const fileIcon = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return <FileTextIcon className="size-4" />;
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return <FileCodeIcon className="size-4" />;
  }
  return <FileIcon className="size-4" />;
};

type TreeEntry = {
  id: string;
  path: string;
  fileName: string;
  kind: string;
};

type TreeNode =
  | { type: "file"; entry: TreeEntry }
  | { type: "folder"; name: string; children: TreeNode[] };

type TreeGroup = {
  prefix: string;
  children: TreeNode[];
};

const findFolderNode = (nodes: TreeNode[], name: string) => {
  for (const node of nodes) {
    if (node.type === "folder" && node.name === name) {
      return node;
    }
  }
  return undefined;
};

const sortTreeNodes = (nodes: TreeNode[]) => {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    const an = a.type === "folder" ? a.name : a.entry.fileName;
    const bn = b.type === "folder" ? b.name : b.entry.fileName;
    return an.localeCompare(bn);
  });
  for (const node of nodes) {
    if (node.type === "folder") {
      sortTreeNodes(node.children);
    }
  }
};

const buildTree = (resources: SkillResource[]): TreeGroup[] => {
  const groups = new Map<string, TreeNode[]>();
  for (const resource of resources) {
    const segments = resource.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      continue;
    }
    const fileName = segments.at(-1) ?? resource.path;
    const entry: TreeEntry = {
      id: resource.id,
      path: resource.path,
      fileName,
      kind: resource.kind,
    };
    const topLevelPrefix = segments.length === 1 ? "" : (segments.at(0) ?? "");
    const key = topLevelPrefix === "" ? "" : topLevelPrefix;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    let cursor = bucket;
    // segments[0] is the top-level prefix; segments[1..length-2] are
    // intermediate folder names; segments[length-1] is the file name.
    for (let i = 1; i < segments.length - 1; i++) {
      const name = segments.at(i);
      if (name === undefined) {
        continue;
      }
      let folder = findFolderNode(cursor, name);
      if (!folder) {
        folder = { type: "folder", name, children: [] };
        cursor.push(folder);
      }
      cursor = folder.children;
    }
    cursor.push({ type: "file", entry });
  }
  const out: TreeGroup[] = [];
  for (const [prefix, children] of groups) {
    sortTreeNodes(children);
    out.push({ prefix: prefix === "" ? "/" : prefix, children });
  }
  return out.sort((a, b) => a.prefix.localeCompare(b.prefix));
};

const toastError = (error: unknown, fallback: string) => {
  stellaToast.add({
    title: fallback,
    description: userErrorFromThrown(error, fallback),
    type: "error",
  });
};
