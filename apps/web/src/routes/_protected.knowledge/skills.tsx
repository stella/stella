import { useEffect, useMemo, useRef, useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import {
  DownloadIcon,
  FileUpIcon,
  GlobeIcon,
  LibraryIcon,
  PencilIcon,
  PowerIcon,
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
import {
  knowledgeKeys,
  skillDetailOptions,
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
      <EditSkillDialog
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

type EditSkillDialogProps = {
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  skill: InstalledSkill | null;
};

type EditSkillForm = {
  name: string;
  description: string;
  body: string;
  version: string;
};

function EditSkillDialog({
  onChanged,
  onOpenChange,
  open,
  skill,
}: EditSkillDialogProps) {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const skillId = skill?.id ?? null;
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const detail = useQuery({
    ...skillDetailOptions(activeOrganizationId, skillId ?? ""),
    enabled: open && skillId !== null,
  });

  const [form, setForm] = useState<EditSkillForm>({
    name: "",
    description: "",
    body: "",
    version: "",
  });

  useEffect(() => {
    if (!detail.data) {
      return;
    }
    setForm({
      name: detail.data.name,
      description: detail.data.description,
      body: detail.data.body,
      version: detail.data.version ?? "",
    });
  }, [detail.data]);

  const updateSkill = useMutation({
    mutationFn: async (payload: {
      skillId: string;
      body: {
        name: string;
        description: string;
        body: string;
        version: string;
      };
    }) => {
      const trimmedVersion = payload.body.version.trim();
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(payload.skillId) })
        .patch({
          name: payload.body.name.trim(),
          description: payload.body.description.trim(),
          body: payload.body.body,
          version: trimmedVersion.length > 0 ? trimmedVersion : null,
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

  const canSubmit =
    skillId !== null &&
    !updateSkill.isPending &&
    form.name.trim().length > 0 &&
    form.description.trim().length > 0 &&
    form.body.length > 0;

  const submit = () => {
    if (!skillId || !canSubmit) {
      return;
    }
    updateSkill.mutate({ skillId, body: form });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{tSkills("editTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
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
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="skill-name">
                  {tSkills("formName")}
                </label>
                <Input
                  id="skill-name"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  value={form.name}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="skill-version">
                  {tSkills("formVersion")}
                </label>
                <Input
                  id="skill-version"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      version: event.target.value,
                    }))
                  }
                  placeholder={tSkills("formVersionPlaceholder")}
                  value={form.version}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-sm font-medium"
                  htmlFor="skill-description"
                >
                  {tSkills("formDescription")}
                </label>
                <Textarea
                  className="min-h-20 resize-y"
                  id="skill-description"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  value={form.description}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="skill-body">
                  {tSkills("formBody")}
                </label>
                <Textarea
                  className="min-h-96 resize-y font-mono"
                  id="skill-body"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      body: event.target.value,
                    }))
                  }
                  value={form.body}
                />
                <p className="text-muted-foreground text-xs">
                  {tSkills("formBodyHelp")}
                </p>
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              submit();
            }}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
