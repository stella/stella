import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  DownloadIcon,
  FileUpIcon,
  GlobeIcon,
  LibraryIcon,
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
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import {
  knowledgeKeys,
  skillsOptions,
} from "@/routes/_protected.knowledge/-queries";

export const Route = createFileRoute("/_protected/knowledge/skills")({
  component: SkillsPage,
});

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
  const { data, isLoading } = useQuery(skillsOptions());

  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InstalledSkill | null>(null);
  const canManageTeam = data?.canManageTeam ?? false;
  const installed = data?.installed ?? [];
  const builtIn = data?.builtIn ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.skills.all });
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
              canToggle={canManageTeam}
              key={skill.id}
              onDelete={setDeleteTarget}
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
              canToggle
              key={skill.id}
              onDelete={setDeleteTarget}
              onToggle={(target) => {
                void toggleSkill(target);
              }}
              skill={skill}
            />
          ))}
        </SkillSection>
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
  canToggle: boolean;
  onDelete: (skill: InstalledSkill) => void;
  onToggle: (skill: InstalledSkill) => void;
  skill: InstalledSkill;
};

function InstalledSkillCard({
  canDelete,
  canToggle,
  onDelete,
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
  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState<SkillScope>("private");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file) {
      return;
    }

    setSaving(true);
    const response = await api.skills.upload.post({
      file,
      scope,
      queryKey: ["skills"],
    });
    setSaving(false);

    if (response.error) {
      const fallback = t("common.unexpectedError");
      stellaToast.add({
        title: fallback,
        description:
          typeof response.error.status === "number"
            ? userErrorMessage(response.error, fallback)
            : fallback,
        type: "error",
      });
      return;
    }

    onChanged();
    onOpenChange(false);
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
          <Input
            accept=".md,.zip"
            onChange={(event) => setFile(event.target.files?.item(0) ?? null)}
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
            disabled={!file || saving}
            onClick={() => {
              void submit();
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
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!url.trim()) {
      return;
    }

    setSaving(true);
    const response = await api.skills["import-url"].post({
      scope,
      url: url.trim(),
      queryKey: ["skills"],
    });
    setSaving(false);

    if (response.error) {
      const fallback = t("common.unexpectedError");
      stellaToast.add({
        title: fallback,
        description:
          typeof response.error.status === "number"
            ? userErrorMessage(response.error, fallback)
            : fallback,
        type: "error",
      });
      return;
    }

    onChanged();
    onOpenChange(false);
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
            disabled={!url.trim() || saving}
            onClick={() => {
              void submit();
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
