import { useEffect, useMemo, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  BookOpenIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  MessageSquareTextIcon,
  PowerIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { skillDetailOptions } from "@/routes/_protected.knowledge/-queries";

const SKILL_BODY_FILE_NAME = "SKILL.md";
const TEXT_RESOURCE_KINDS = new Set([
  "knowledge",
  "prompt",
  "reference",
  "script",
  "template",
]);

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

  // Mutations
  const patchBody = useMutation({
    mutationFn: async (nextBody: string) => {
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(skill.id) })
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
        .skills({ skillId: toSafeId<"agentSkill">(skill.id) })
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
        .skills({ skillId: toSafeId<"agentSkill">(skill.id) })
        .resources.patch({ ...payload, queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (_data, variables) => {
      // Drop the dirty draft for the saved resource.
      setDraftResources((current) => {
        if (selected.type !== "resource") {
          return current;
        }
        // Match by the resource's path, not the current selection: the user
        // might have navigated away while the request was in flight.
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
        <aside className="bg-muted/20 max-h-64 shrink-0 overflow-y-auto border-b sm:max-h-none sm:w-64 sm:border-e sm:border-b-0">
          <div className="p-3">
            <p className="text-muted-foreground mb-2 px-1 text-xs font-semibold tracking-wider uppercase">
              {tSkills("filesHeading")}
            </p>
            {detail.isLoading && (
              <p className="text-muted-foreground px-1 text-xs">
                {t("common.loading")}
              </p>
            )}
            {detail.data && (
              <SkillFileTree
                bodyDirty={bodyDirty}
                dirtyResourceIds={Object.keys(draftResources)}
                onSelect={trySelect}
                selected={selected}
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
                <Button disabled={saveDisabled} onClick={onSave} size="sm">
                  {isSaving ? t("common.loading") : t("common.save")}
                </Button>
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
  dirtyResourceIds: string[];
  onSelect: (next: SelectedFile) => void;
  selected: SelectedFile;
  tree: TreeGroup[];
};

function SkillFileTree({
  bodyDirty,
  dirtyResourceIds,
  onSelect,
  selected,
  tree,
}: SkillFileTreeProps) {
  const dirtySet = useMemo(() => new Set(dirtyResourceIds), [dirtyResourceIds]);
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
      {tree.map((group) => (
        <li className="flex flex-col gap-1" key={group.prefix}>
          <div className="text-muted-foreground flex items-center gap-1.5 px-2 text-xs">
            <FolderIcon className="size-3.5" />
            <span className="font-mono">{group.prefix}/</span>
          </div>
          <ul className="flex flex-col">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                <FileRow
                  dirty={dirtySet.has(entry.id)}
                  icon={kindIcon(entry.kind)}
                  label={entry.fileName}
                  onClick={() =>
                    onSelect({
                      type: "resource",
                      resourceId: entry.id,
                      path: entry.path,
                    })
                  }
                  selected={
                    selected.type === "resource" &&
                    selected.resourceId === entry.id
                  }
                />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
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
          className="ms-auto size-1.5 shrink-0 rounded-full bg-amber-500"
        />
      )}
    </button>
  );
}

const kindIcon = (kind: string) => {
  if (kind === "knowledge") {
    return <BookOpenIcon className="size-4" />;
  }
  if (kind === "prompt") {
    return <MessageSquareTextIcon className="size-4" />;
  }
  if (kind === "reference") {
    return <FileTextIcon className="size-4" />;
  }
  return <FileIcon className="size-4" />;
};

type TreeEntry = {
  id: string;
  path: string;
  fileName: string;
  kind: string;
};

type TreeGroup = {
  prefix: string;
  entries: TreeEntry[];
};

const buildTree = (resources: SkillResource[]): TreeGroup[] => {
  const groups = new Map<string, TreeEntry[]>();
  for (const resource of resources) {
    const slashIndex = resource.path.indexOf("/");
    const prefix = slashIndex === -1 ? "" : resource.path.slice(0, slashIndex);
    const fileName =
      slashIndex === -1 ? resource.path : resource.path.slice(slashIndex + 1);
    const bucket = groups.get(prefix);
    const entry: TreeEntry = {
      id: resource.id,
      path: resource.path,
      fileName,
      kind: resource.kind,
    };
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(prefix, [entry]);
    }
  }
  const out: TreeGroup[] = [];
  for (const [prefix, entries] of groups) {
    out.push({
      prefix: prefix === "" ? "/" : prefix,
      entries: entries.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    });
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
