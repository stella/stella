import { useMemo, useRef, useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import JSZip from "jszip";
import {
  DownloadIcon,
  FilePlusIcon,
  FileUpIcon,
  GlobeIcon,
  LibraryIcon,
  LoaderIcon,
  PencilIcon,
  PowerIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import {
  toAPIError,
  userErrorFromThrown,
  userErrorMessage,
} from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { EditSkillSheet } from "@/routes/_protected.knowledge/-components/edit-skill-sheet";
import {
  knowledgeKeys,
  skillsOptions,
} from "@/routes/_protected.knowledge/-queries";

export const Route = createFileRoute("/_protected/knowledge/skills")({
  component: SkillsPage,
});

const protectedRouteApi = getRouteApi("/_protected");

type SkillScope = "team" | "private";

type InstalledSkill = {
  compatibility: string | null;
  contentHash: string;
  description: string;
  enabled: boolean;
  id: string;
  license: string | null;
  name: string;
  origin: "upload" | "url";
  scope: SkillScope;
  slug: string;
  sourceUrl: string | null;
  userId: string;
  version: string | null;
};

type BuiltInSkill = {
  compatibility: string | null;
  description: string;
  enabled: boolean;
  id: string;
  license: string | null;
  name: string;
  origin: "built-in";
  resourceCount: number;
  scope: "built-in";
  slug: string;
  version: string | null;
};

function SkillsPage() {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery(skillsOptions(activeOrganizationId));

  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InstalledSkill | null>(null);
  const [editTarget, setEditTarget] = useState<InstalledSkill | null>(null);
  const firstPage = data?.pages.at(0);
  const canManageTeam = firstPage?.canManageTeam ?? false;
  const installed = useMemo(
    () => data?.pages.flatMap((page) => page.installed) ?? [],
    [data],
  );
  const builtIn = firstPage?.builtIn ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.skills.all(activeOrganizationId),
    });
  };

  const teamSkills = installed.filter((skill) => skill.scope === "team");
  const privateSkills = installed.filter((skill) => skill.scope === "private");

  const toggleSkill = async (skill: InstalledSkill) => {
    const response = await api
      .skills({ skillId: toSafeId<"agentSkill">(skill.id) })
      .patch({
        enabled: !skill.enabled,
        queryKey: ["skills"],
      });
    if (response.error) {
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
        type: "error",
      });
      return;
    }
    invalidate();
  };

  const deleteSkill = async () => {
    if (!deleteTarget) {
      return;
    }

    const response = await api
      .skills({ skillId: toSafeId<"agentSkill">(deleteTarget.id) })
      .delete({ queryKey: ["skills"] });
    if (response.error) {
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
        type: "error",
      });
      return;
    }

    setDeleteTarget(null);
    invalidate();
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-semibold">
            {t("knowledge.sections.skills.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {tSkills("description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setGenerateOpen(true)}
            size="sm"
            variant="secondary"
          >
            <SparklesIcon className="me-1.5 size-4" />
            {tSkills("generateSkill")}
          </Button>
          <Button
            onClick={() => setImportOpen(true)}
            size="sm"
            variant="secondary"
          >
            <GlobeIcon className="me-1.5 size-4" />
            {tSkills("importSkill")}
          </Button>
          <Button onClick={() => setUploadOpen(true)} size="sm">
            <FileUpIcon className="me-1.5 size-4" />
            {tSkills("uploadSkill")}
          </Button>
        </div>
      </div>

      {installed.length === 0 && !isLoading && (
        <div className="border-border bg-muted/20 mb-8 flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
          <LibraryIcon className="text-muted-foreground size-8" />
          <h2 className="mt-3 text-sm font-semibold">
            {tSkills("emptyTitle")}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm">
            {tSkills("emptyDescription")}
          </p>
        </div>
      )}

      {teamSkills.length > 0 && (
        <SkillSection title={tSkills("teamSection")}>
          {teamSkills.map((skill) => (
            <InstalledSkillCard
              canDelete={canManageTeam}
              canEdit={canManageTeam}
              canToggle={canManageTeam}
              key={skill.id}
              onDelete={setDeleteTarget}
              onEdit={setEditTarget}
              onToggle={(target) => {
                void toggleSkill(target);
              }}
              skill={skill}
            />
          ))}
        </SkillSection>
      )}

      {privateSkills.length > 0 && (
        <SkillSection title={tSkills("privateSection")}>
          {privateSkills.map((skill) => (
            <InstalledSkillCard
              canDelete
              canEdit
              canToggle
              key={skill.id}
              onDelete={setDeleteTarget}
              onEdit={setEditTarget}
              onToggle={(target) => {
                void toggleSkill(target);
              }}
              skill={skill}
            />
          ))}
        </SkillSection>
      )}

      {hasNextPage && (
        <div className="mb-8 flex justify-center">
          <Button
            disabled={isFetchingNextPage}
            onClick={() => {
              void fetchNextPage();
            }}
            variant="outline"
          >
            {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
          </Button>
        </div>
      )}

      {builtIn.length > 0 && (
        <SkillSection title={tSkills("builtInSection")}>
          {builtIn.map((skill) => (
            <BuiltInSkillCard key={skill.id} skill={skill} />
          ))}
        </SkillSection>
      )}

      <UploadSkillDialog
        canManageTeam={canManageTeam}
        onChanged={invalidate}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
      />
      <ImportSkillDialog
        canManageTeam={canManageTeam}
        onChanged={invalidate}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
      <GenerateSkillDialog
        canManageTeam={canManageTeam}
        onChanged={invalidate}
        open={generateOpen}
        onOpenChange={setGenerateOpen}
      />
      <DeleteSkillDialog
        onConfirm={() => {
          void deleteSkill();
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
        skill={deleteTarget}
      />
      <EditSkillSheet
        onChanged={invalidate}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null);
          }
        }}
        open={editTarget !== null}
        skill={editTarget}
      />
    </div>
  );
}

type SkillSectionProps = {
  children: React.ReactNode;
  title: string;
};

function SkillSection({ children, title }: SkillSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">
        {title}
      </h2>
      <div className="grid gap-3 xl:grid-cols-2">{children}</div>
    </section>
  );
}

type InstalledSkillCardProps = {
  canDelete: boolean;
  canEdit: boolean;
  canToggle: boolean;
  onDelete: (skill: InstalledSkill) => void;
  onEdit: (skill: InstalledSkill) => void;
  onToggle: (skill: InstalledSkill) => void;
  skill: InstalledSkill;
};

function InstalledSkillCard({
  canDelete,
  canEdit,
  canToggle,
  onDelete,
  onEdit,
  onToggle,
  skill,
}: InstalledSkillCardProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");

  return (
    <article className="bg-card flex min-w-0 items-start justify-between gap-4 rounded-lg border p-4">
      <SkillCardBody
        badge={skill.enabled ? tSkills("enabled") : tSkills("disabled")}
        description={skill.description}
        meta={[
          skill.version ? tSkills("version", { version: skill.version }) : null,
          skill.license ? tSkills("license", { license: skill.license }) : null,
          skill.origin === "upload"
            ? tSkills("sourceUpload")
            : tSkills("sourceUrl"),
        ]}
        name={skill.name}
        slug={skill.slug}
      />
      <div className="flex shrink-0 items-center gap-1">
        {canEdit && (
          <Button
            aria-label={tSkills("editSkill")}
            onClick={() => onEdit(skill)}
            size="icon-sm"
            variant="ghost"
          >
            <PencilIcon className="size-4" />
          </Button>
        )}
        {canToggle && (
          <Button
            aria-label={
              skill.enabled ? tSkills("disableSkill") : tSkills("enableSkill")
            }
            onClick={() => onToggle(skill)}
            size="icon-sm"
            variant="ghost"
          >
            <PowerIcon className="size-4" />
          </Button>
        )}
        {canDelete && (
          <Button
            aria-label={t("common.delete")}
            onClick={() => onDelete(skill)}
            size="icon-sm"
            variant="ghost"
          >
            <TrashIcon className="size-4" />
          </Button>
        )}
      </div>
    </article>
  );
}

function BuiltInSkillCard({ skill }: { skill: BuiltInSkill }) {
  const tSkills = useTranslations("knowledge.agentSkills");

  return (
    <article className="bg-card rounded-lg border p-4">
      <SkillCardBody
        badge={tSkills("builtInBadge")}
        description={skill.description}
        meta={[
          skill.version ? tSkills("version", { version: skill.version }) : null,
          tSkills("resources", { count: skill.resourceCount }),
        ]}
        name={skill.name}
        slug={skill.slug}
      />
    </article>
  );
}

type SkillCardBodyProps = {
  badge: string;
  description: string;
  meta: (string | null)[];
  name: string;
  slug: string;
};

function SkillCardBody({
  badge,
  description,
  meta,
  name,
  slug,
}: SkillCardBodyProps) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground truncate text-sm font-medium">
          {name}
        </span>
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
          {slug}
        </span>
        <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
          {badge}
        </span>
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
        {description}
      </p>
      <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {meta.filter(isNonNull).map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </div>
  );
}

type SkillFormDialogProps = {
  canManageTeam: boolean;
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

function UploadSkillDialog({
  canManageTeam,
  onChanged,
  onOpenChange,
  open,
}: SkillFormDialogProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [scope, setScope] = useState<SkillScope>("private");

  const setFirstFile = (files: FileList | null) => {
    const selectedFile = files?.item(0);
    if (!selectedFile) {
      return;
    }

    setFile(selectedFile);
  };

  const markFileDragActive = (event: React.DragEvent<HTMLButtonElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingFile(true);
  };

  const uploadSkill = useMutation({
    mutationFn: async (payload: { file: File; scope: SkillScope }) => {
      const response = await api.skills.upload.post({
        file: payload.file,
        scope: payload.scope,
        queryKey: ["skills"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      onChanged();
      setFile(null);
      onOpenChange(false);
    },
    onError: (error) => {
      const fallback = t("common.unexpectedError");
      stellaToast.add({
        title: fallback,
        description: userErrorFromThrown(error, fallback),
        type: "error",
      });
    },
  });

  const submit = () => {
    if (!file) {
      return;
    }
    uploadSkill.mutate({ file, scope });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tSkills("uploadTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {tSkills("uploadHelp")}
          </p>
          <button
            className={cn(
              "border-border bg-muted/20 flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center transition-colors",
              "focus-visible:ring-ring/24 outline-none focus-visible:ring-3",
              isDraggingFile && "border-ring bg-muted/40 ring-ring/24 ring-3",
            )}
            onDragEnter={markFileDragActive}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsDraggingFile(false);
            }}
            onDragOver={markFileDragActive}
            onClick={() => fileInputRef.current?.click()}
            onDrop={(event) => {
              event.preventDefault();
              setIsDraggingFile(false);
              setFirstFile(event.dataTransfer.files);
            }}
            type="button"
          >
            <FileUpIcon className="text-muted-foreground size-7" />
            <span className="text-foreground mt-3 text-sm font-medium">
              {tSkills("dropFile")}
            </span>
            <span className="text-muted-foreground mt-1 max-w-full truncate text-sm">
              {file
                ? tSkills("selectedFile", { name: file.name })
                : tSkills("chooseFile")}
            </span>
          </button>
          <input
            ref={fileInputRef}
            aria-hidden="true"
            accept=".md,.zip"
            className="sr-only"
            onChange={(event) => setFirstFile(event.target.files)}
            tabIndex={-1}
            type="file"
          />
          <ScopeField
            canManageTeam={canManageTeam}
            scope={scope}
            onScopeChange={setScope}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!file || uploadSkill.isPending}
            onClick={() => {
              submit();
            }}
          >
            <DownloadIcon className="me-1.5 size-4" />
            {t("common.add")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ImportSkillDialog({
  canManageTeam,
  onChanged,
  onOpenChange,
  open,
}: SkillFormDialogProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<SkillScope>("private");

  const importSkill = useMutation({
    mutationFn: async (payload: { url: string; scope: SkillScope }) => {
      const response = await api.skills["import-url"].post({
        scope: payload.scope,
        url: payload.url,
        queryKey: ["skills"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      onChanged();
      onOpenChange(false);
    },
    onError: (error) => {
      const fallback = t("common.unexpectedError");
      stellaToast.add({
        title: fallback,
        description: userErrorFromThrown(error, fallback),
        type: "error",
      });
    },
  });

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    importSkill.mutate({ url: trimmed, scope });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tSkills("importTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {tSkills("importHelp")}
          </p>
          <Input
            onChange={(event) => setUrl(event.target.value)}
            placeholder={tSkills("urlPlaceholder")}
            value={url}
          />
          <ScopeField
            canManageTeam={canManageTeam}
            scope={scope}
            onScopeChange={setScope}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!url.trim() || importSkill.isPending}
            onClick={() => {
              submit();
            }}
          >
            <GlobeIcon className="me-1.5 size-4" />
            {t("common.add")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type DraftResource = {
  content: string;
  id: string;
  path: string;
};

const RESOURCE_PATH_PATTERN =
  /^(references|prompts|knowledge)\/[a-z0-9][a-z0-9._-]*\.md$/u;

const SKILL_MD_FILENAME = "SKILL.md";

const newResourceId = () => globalThis.crypto.randomUUID();

const toDraftResource = (resource: {
  content: string;
  path: string;
}): DraftResource => ({
  content: resource.content,
  id: newResourceId(),
  path: resource.path,
});

const buildSkillZip = async (
  markdown: string,
  resources: readonly DraftResource[],
): Promise<File> => {
  const zip = new JSZip();
  zip.file(SKILL_MD_FILENAME, markdown);
  for (const resource of resources) {
    zip.file(resource.path.trim(), resource.content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "skill.zip", { type: "application/zip" });
};

function GenerateSkillDialog({
  canManageTeam,
  onChanged,
  onOpenChange,
  open,
}: SkillFormDialogProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const [intent, setIntent] = useState("");
  const [examples, setExamples] = useState("");
  const [scope, setScope] = useState<SkillScope>("private");
  const [draft, setDraft] = useState("");
  const [resources, setResources] = useState<DraftResource[]>([]);
  const [feedback, setFeedback] = useState("");

  const resetForm = () => {
    setIntent("");
    setExamples("");
    setDraft("");
    setResources([]);
    setFeedback("");
    setScope("private");
  };

  const generate = useMutation({
    mutationFn: async (payload: {
      intent: string;
      examples?: string;
      previousDraft?: string;
      previousResources?: { content: string; path: string }[];
      feedback?: string;
    }) => {
      const response = await api.skills["generate-draft"].post({
        intent: payload.intent,
        ...(payload.examples ? { examples: payload.examples } : {}),
        ...(payload.previousDraft
          ? { previousDraft: payload.previousDraft }
          : {}),
        ...(payload.previousResources !== undefined &&
        payload.previousResources.length > 0
          ? { previousResources: payload.previousResources }
          : {}),
        ...(payload.feedback ? { feedback: payload.feedback } : {}),
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      setDraft(data.markdown);
      setResources(data.resources.map(toDraftResource));
      setFeedback("");
    },
    onError: (error) => {
      const fallback = t("common.unexpectedError");
      stellaToast.add({
        title: fallback,
        description: userErrorFromThrown(error, fallback),
        type: "error",
      });
    },
  });

  const install = useMutation({
    mutationFn: async (payload: {
      markdown: string;
      resources: DraftResource[];
      scope: SkillScope;
    }) => {
      const file =
        payload.resources.length > 0
          ? await buildSkillZip(payload.markdown, payload.resources)
          : new File([payload.markdown], SKILL_MD_FILENAME, {
              type: "text/markdown",
            });
      const response = await api.skills.upload.post({
        file,
        scope: payload.scope,
        queryKey: ["skills"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      onChanged();
      resetForm();
      onOpenChange(false);
    },
    onError: (error) => {
      const fallback = t("common.unexpectedError");
      stellaToast.add({
        title: fallback,
        description: userErrorFromThrown(error, fallback),
        type: "error",
      });
    },
  });

  const handleGenerate = () => {
    const trimmedIntent = intent.trim();
    if (!trimmedIntent) {
      return;
    }
    const trimmedExamples = examples.trim();
    generate.mutate({
      intent: trimmedIntent,
      ...(trimmedExamples ? { examples: trimmedExamples } : {}),
    });
  };

  const handleRegenerate = () => {
    const trimmedIntent = intent.trim();
    if (!trimmedIntent || !draft) {
      return;
    }
    const trimmedExamples = examples.trim();
    const trimmedFeedback = feedback.trim();
    const previousResources = resources
      .filter(
        (resource) =>
          resource.path.trim().length > 0 && resource.content.length > 0,
      )
      .map((resource) => ({
        content: resource.content,
        path: resource.path.trim(),
      }));
    generate.mutate({
      intent: trimmedIntent,
      previousDraft: draft,
      ...(trimmedExamples ? { examples: trimmedExamples } : {}),
      ...(previousResources.length > 0 ? { previousResources } : {}),
      ...(trimmedFeedback ? { feedback: trimmedFeedback } : {}),
    });
  };

  const handleInstall = () => {
    if (!draft.trim() || resources.some((r) => !isValidResource(r))) {
      return;
    }
    install.mutate({ markdown: draft, resources, scope });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      resetForm();
    }
    onOpenChange(next);
  };

  const updateResource = (id: string, patch: Partial<DraftResource>) => {
    setResources((current) =>
      current.map((resource) =>
        resource.id === id ? { ...resource, ...patch } : resource,
      ),
    );
  };

  const removeResource = (id: string) => {
    setResources((current) => current.filter((resource) => resource.id !== id));
  };

  const addResource = () => {
    setResources((current) => [
      ...current,
      { content: "", id: newResourceId(), path: "" },
    ]);
  };

  const hasResourceErrors = resources.some(
    (resource) => !isValidResource(resource),
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-pretty">
            {tSkills("generateTitle")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          <p className="text-muted-foreground text-sm text-pretty">
            {tSkills("generateHelp")}
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="skill-intent">
              {tSkills("generateIntentLabel")}
            </label>
            <Textarea
              autoFocus
              id="skill-intent"
              onChange={(event) => setIntent(event.target.value)}
              placeholder={tSkills("generateIntentPlaceholder")}
              rows={3}
              value={intent}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="skill-examples">
              {tSkills("generateExamplesLabel")}
            </label>
            <Textarea
              id="skill-examples"
              onChange={(event) => setExamples(event.target.value)}
              placeholder={tSkills("generateExamplesPlaceholder")}
              rows={2}
              value={examples}
            />
          </div>

          {!draft && (
            <Button
              className="self-start"
              disabled={!intent.trim() || generate.isPending}
              onClick={handleGenerate}
              size="sm"
            >
              {generate.isPending ? (
                <LoaderIcon className="me-1.5 size-4 animate-spin" />
              ) : (
                <SparklesIcon className="me-1.5 size-4" />
              )}
              {generate.isPending
                ? tSkills("generating")
                : tSkills("generateDraft")}
            </Button>
          )}

          {draft && (
            <div className="animate-in fade-in-0 slide-in-from-top-1 flex flex-col gap-4 duration-200">
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground font-mono text-xs"
                  htmlFor="skill-draft"
                >
                  {SKILL_MD_FILENAME}
                </label>
                <Textarea
                  className="font-mono text-xs leading-relaxed"
                  id="skill-draft"
                  onChange={(event) => setDraft(event.target.value)}
                  rows={18}
                  value={draft}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {tSkills("generateResourcesLabel")}
                  </h3>
                  <span className="text-muted-foreground text-xs">
                    {tSkills("generateResourcesHelp")}
                  </span>
                </div>

                {resources.map((resource) => (
                  <ResourceCard
                    key={resource.id}
                    onChange={(patch) => updateResource(resource.id, patch)}
                    onRemove={() => removeResource(resource.id)}
                    resource={resource}
                    showPathError={
                      resource.path.length > 0 &&
                      !RESOURCE_PATH_PATTERN.test(resource.path.trim())
                    }
                  />
                ))}

                <Button
                  className="self-start"
                  onClick={addResource}
                  size="sm"
                  variant="ghost"
                >
                  <FilePlusIcon className="me-1.5 size-4" />
                  {tSkills("generateAddResource")}
                </Button>
              </div>

              <div className="border-border bg-muted/10 flex flex-col gap-2 rounded-lg border p-3">
                <label className="text-sm font-medium" htmlFor="skill-feedback">
                  {tSkills("generateFeedbackLabel")}
                </label>
                <Textarea
                  id="skill-feedback"
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder={tSkills("generateFeedbackPlaceholder")}
                  rows={2}
                  value={feedback}
                />
                <Button
                  className="self-start"
                  disabled={generate.isPending || !intent.trim()}
                  onClick={handleRegenerate}
                  size="sm"
                  variant="secondary"
                >
                  {generate.isPending ? (
                    <LoaderIcon className="me-1.5 size-4 animate-spin" />
                  ) : (
                    <SparklesIcon className="me-1.5 size-4" />
                  )}
                  {generate.isPending
                    ? tSkills("generating")
                    : tSkills("regenerate")}
                </Button>
              </div>
            </div>
          )}

          <ScopeField
            canManageTeam={canManageTeam}
            scope={scope}
            onScopeChange={setScope}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={
              !draft.trim() ||
              install.isPending ||
              generate.isPending ||
              hasResourceErrors
            }
            onClick={handleInstall}
          >
            {install.isPending ? (
              <LoaderIcon className="me-1.5 size-4 animate-spin" />
            ) : (
              <DownloadIcon className="me-1.5 size-4" />
            )}
            {t("common.add")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const isValidResource = (resource: DraftResource): boolean => {
  const path = resource.path.trim();
  if (!RESOURCE_PATH_PATTERN.test(path)) {
    return false;
  }
  return resource.content.length > 0;
};

type ResourceCardProps = {
  onChange: (patch: Partial<DraftResource>) => void;
  onRemove: () => void;
  resource: DraftResource;
  showPathError: boolean;
};

function ResourceCard({
  onChange,
  onRemove,
  resource,
  showPathError,
}: ResourceCardProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");

  return (
    <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-2 rounded-lg border p-3 duration-150">
      <div className="flex items-center gap-2">
        <Input
          aria-invalid={showPathError || undefined}
          className="font-mono text-xs"
          onChange={(event) => onChange({ path: event.target.value })}
          placeholder="knowledge/01-foundations.md"
          value={resource.path}
        />
        <Button
          aria-label={t("common.delete")}
          onClick={onRemove}
          size="icon-sm"
          variant="ghost"
        >
          <TrashIcon className="size-4" />
        </Button>
      </div>
      {showPathError && (
        <p className="text-destructive text-xs">
          {tSkills("generateResourcePathError")}
        </p>
      )}
      <Textarea
        className="font-mono text-xs leading-relaxed"
        onChange={(event) => onChange({ content: event.target.value })}
        placeholder={tSkills("generateResourceContentPlaceholder")}
        rows={6}
        value={resource.content}
      />
    </div>
  );
}

type ScopeFieldProps = {
  canManageTeam: boolean;
  onScopeChange: (scope: SkillScope) => void;
  scope: SkillScope;
};

function ScopeField({ canManageTeam, onScopeChange, scope }: ScopeFieldProps) {
  const tSkills = useTranslations("knowledge.agentSkills");

  if (!canManageTeam) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium" htmlFor="skill-scope">
        {tSkills("scope")}
      </label>
      <Select
        value={scope}
        onValueChange={(value) =>
          onScopeChange(toSkillScope(value ?? "private"))
        }
      >
        <SelectTrigger id="skill-scope">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="private">{tSkills("scopePrivate")}</SelectItem>
          <SelectItem value="team">{tSkills("scopeTeam")}</SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
}

const isNonNull = <T,>(value: T | null): value is T => value !== null;

const toSkillScope = (value: string): SkillScope =>
  value === "team" ? "team" : "private";

type DeleteSkillDialogProps = {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  skill: InstalledSkill | null;
};

function DeleteSkillDialog({
  onConfirm,
  onOpenChange,
  open,
  skill,
}: DeleteSkillDialogProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{tSkills("deleteConfirmTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p className="text-muted-foreground text-sm">
            {skill
              ? tSkills("deleteConfirmDescription", { name: skill.name })
              : ""}
          </p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button onClick={onConfirm} variant="destructive">
            {t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
