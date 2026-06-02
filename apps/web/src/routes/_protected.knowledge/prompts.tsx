import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
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
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  EMPTY_SCREEN_TABLE_PREVIEW,
  EmptyScreen,
} from "@/components/empty-screen";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { ensureCriticalQueryData } from "@/lib/react-query";
import { roleOptions } from "@/routes/-queries";
import {
  knowledgeKeys,
  shortcutsOptions,
} from "@/routes/_protected.knowledge/-queries";

import { ShortcutFormDialog } from "./-components/shortcut-form-dialog";
import type { ShortcutInitial } from "./-components/shortcut-form-dialog";

export const Route = createFileRoute("/_protected/knowledge/prompts")({
  // Seed the default shortcuts before the page renders, so the
  // component never has to write to the DB during a render-phase
  // effect. The backend handler is idempotent at the user level
  // (existing private shortcuts short-circuit the seed).
  loader: async ({ context }) => {
    const activeOrganizationId = context.user.activeOrganizationId;
    const existing = await ensureCriticalQueryData(
      context.queryClient,
      shortcutsOptions(activeOrganizationId),
    );
    if (existing.length === 0) {
      await api.shortcuts.seed.post({ queryKey: ["shortcuts"] });
      await context.queryClient.invalidateQueries({
        queryKey: knowledgeKeys.shortcuts.all(activeOrganizationId),
      });
    }
  },
  component: PromptsPage,
});

const protectedRouteApi = getRouteApi("/_protected");

// ── Types ────────────────────────────────────────────

type ShortcutRow = {
  id: string;
  scope: "team" | "private";
  name: string;
  description: string | null;
  command: string;
  prompt: string;
  isDefault: boolean;
  userId: string;
};

// ── Component ────────────────────────────────────────

function PromptsPage() {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.skills");
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data: shortcuts = [], isLoading } = useQuery(
    shortcutsOptions(activeOrganizationId),
  );
  const { data: role } = useQuery(roleOptions);

  const canManageTeam = role === "owner" || role === "admin";

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ShortcutInitial | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<ShortcutRow | undefined>();
  const [deleting, setDeleting] = useState(false);

  const teamShortcuts = shortcuts.filter((s) => s.scope === "team");
  const privateShortcuts = shortcuts.filter((s) => s.scope === "private");
  const teamCommands = new Set(teamShortcuts.map((s) => s.command));

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.shortcuts.all(activeOrganizationId),
    });
  };

  const openEdit = (s: ShortcutRow) => {
    setEditTarget({
      id: s.id,
      name: s.name,
      description: s.description,
      command: s.command,
      prompt: s.prompt,
      scope: s.scope,
    });
    setFormOpen(true);
  };

  const openCreate = () => {
    setEditTarget(undefined);
    setFormOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);

    const response = await api
      .shortcuts({ shortcutId: deleteTarget.id })
      .delete({ queryKey: ["shortcuts"] });
    setDeleting(false);

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
    setDeleteTarget(undefined);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-foreground text-xl font-semibold">
          {t("knowledge.sections.prompts.title")}
        </h1>
        <Button onClick={openCreate} size="sm">
          <PlusIcon className="me-1.5 size-4" />
          {t("knowledge.skills.addShortcut")}
        </Button>
      </div>

      {shortcuts.length === 0 && !isLoading && (
        <EmptyScreen
          className="min-h-[520px] p-0"
          description={tSkills("emptyDescription")}
          primaryAction={{
            label: tSkills("addShortcut"),
            icon: PlusIcon,
            onClick: openCreate,
          }}
          title={tSkills("emptyTitle")}
          video={{
            ...EMPTY_SCREEN_TABLE_PREVIEW,
            title: tSkills("emptyTitle"),
          }}
        />
      )}

      {/* Section eyebrows only surface when both buckets have
          content; the heading exists to disambiguate team vs
          private. Alone, it duplicates the page title. */}
      {teamShortcuts.length > 0 && (
        <Section
          title={
            privateShortcuts.length > 0
              ? t("knowledge.skills.teamSection")
              : undefined
          }
        >
          {teamShortcuts.map((s) => (
            <ShortcutCard
              key={s.id}
              shortcut={s}
              canEdit={canManageTeam}
              shadowed={false}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          ))}
        </Section>
      )}

      {privateShortcuts.length > 0 && (
        <Section
          title={
            teamShortcuts.length > 0
              ? t("knowledge.skills.privateSection")
              : undefined
          }
        >
          {privateShortcuts.map((s) => (
            <ShortcutCard
              key={s.id}
              shortcut={s}
              canEdit
              shadowed={teamCommands.has(s.command)}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          ))}
        </Section>
      )}

      <ShortcutFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={invalidate}
        canManageTeam={canManageTeam}
        {...(editTarget ? { initial: editTarget } : {})}
      />

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(undefined);
          }
        }}
      >
        <DialogPopup className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("knowledge.skills.deleteConfirmTitle")}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p className="text-muted-foreground text-sm">
              {t("knowledge.skills.deleteConfirmDescription")}
            </p>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                void confirmDelete();
              }}
            >
              {t("knowledge.skills.deleteShortcut")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────

type SectionProps = {
  title?: string | undefined;
  children: React.ReactNode;
};

function Section({ title, children }: SectionProps) {
  return (
    <div className="mb-8">
      {title !== undefined && (
        <h2 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">
          {title}
        </h2>
      )}
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

type ShortcutCardProps = {
  shortcut: ShortcutRow;
  canEdit: boolean;
  shadowed: boolean;
  onEdit: (s: ShortcutRow) => void;
  onDelete: (s: ShortcutRow) => void;
};

function ShortcutCard({
  shortcut,
  canEdit,
  shadowed,
  onEdit,
  onDelete,
}: ShortcutCardProps) {
  const t = useTranslations();

  return (
    <div
      className={cn(
        "bg-card group flex items-start justify-between gap-4 rounded-xl border p-4",
        "hover:border-foreground/15 transition-colors hover:shadow-sm",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-medium">
            {shortcut.name}
          </span>
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
            /{shortcut.command}
          </span>
          {shortcut.isDefault && (
            <span className="text-muted-foreground rounded border px-1.5 py-0.5 text-xs">
              {t("knowledge.skills.defaultBadge")}
            </span>
          )}
          {shadowed && (
            <span className="border-warning/30 text-warning-foreground dark:border-warning/40 dark:text-warning rounded border px-1.5 py-0.5 text-xs">
              {t("knowledge.skills.shadowed")}
            </span>
          )}
        </div>
        {shortcut.description && (
          <p className="text-muted-foreground mt-0.5 text-sm">
            {shortcut.description}
          </p>
        )}
        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
          {shortcut.prompt}
        </p>
      </div>

      {canEdit && (
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onEdit(shortcut)}
            aria-label={t("knowledge.skills.editShortcut")}
          >
            <PencilIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onDelete(shortcut)}
            aria-label={t("knowledge.skills.deleteShortcut")}
          >
            <TrashIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
