import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
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

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { usePlaybookNavStore } from "@/routes/_protected.knowledge/-components/playbook-nav-store";
import {
  duplicatePosition,
  extractToGraded,
  gradedToExtract,
  hasErrors,
  newExtractPosition,
  newGradedPosition,
  normalizePosition,
  type PlaybookPositionsValue,
  type Position,
  type PositionErrors,
  type PositionSeverity,
  validatePosition,
} from "@/routes/_protected.knowledge/-components/playbook-types";
import { PositionEditor } from "@/routes/_protected.knowledge/-components/position-editor";
import {
  documentTypesOptions,
  knowledgeKeys,
  playbookDetailOptions,
} from "@/routes/_protected.knowledge/-queries";

// ── Root component ────────────────────────────────────

type PlaybookEditorProps = {
  organizationId: string;
  playbookId: string | null;
  onBack: () => void;
  onSaved: () => void;
};

export const PlaybookEditor = ({
  organizationId,
  playbookId,
  onBack,
  onSaved,
}: PlaybookEditorProps) => {
  if (playbookId === null) {
    return (
      <PlaybookEditorForm
        initialDescription=""
        initialDocumentTypeKey={null}
        initialName=""
        initialPerspective={null}
        initialPositions={[]}
        onBack={onBack}
        onSaved={onSaved}
        organizationId={organizationId}
        playbookId={null}
      />
    );
  }

  return (
    <PlaybookEditorLoader
      onBack={onBack}
      onSaved={onSaved}
      organizationId={organizationId}
      playbookId={playbookId}
    />
  );
};

const PlaybookEditorLoader = ({
  organizationId,
  playbookId,
  onBack,
  onSaved,
}: {
  organizationId: string;
  playbookId: string;
  onBack: () => void;
  onSaved: () => void;
}) => {
  const t = useTranslations();
  const detailQuery = useQuery(
    playbookDetailOptions(organizationId, playbookId),
  );

  if (detailQuery.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.loading")}
        </p>
      </div>
    );
  }

  const detail = detailQuery.data;
  if (detailQuery.isError || !detail || !("positions" in detail)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.loadFailed")}
        </p>
      </div>
    );
  }

  return (
    <PlaybookEditorForm
      initialDescription={detail.description ?? ""}
      initialDocumentTypeKey={detail.scope?.documentTypeKey ?? null}
      initialName={detail.name}
      initialPerspective={detail.scope?.perspective ?? null}
      initialPositions={detail.positions.items}
      onBack={onBack}
      onSaved={onSaved}
      organizationId={organizationId}
      playbookId={playbookId}
    />
  );
};

// ── Editor form ───────────────────────────────────────

// Sentinel for the "every document type" (unscoped) choice; a Select value
// can't be null, so it stands in and maps back to null.
const SCOPE_ALL_VALUE = "__all__";

type PlaybookPerspective = "buyer" | "seller" | "neutral";

type PlaybookEditorFormProps = {
  organizationId: string;
  playbookId: string | null;
  initialName: string;
  initialDescription: string;
  initialDocumentTypeKey: string | null;
  initialPerspective: PlaybookPerspective | null;
  initialPositions: Position[];
  onBack: () => void;
  onSaved: () => void;
};

const PlaybookEditorForm = ({
  organizationId,
  playbookId,
  initialName,
  initialDescription,
  initialDocumentTypeKey,
  initialPerspective,
  initialPositions,
  onBack,
  onSaved,
}: PlaybookEditorFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const isEdit = playbookId !== null;
  const canSave = usePermissions(
    isEdit ? { playbook: ["update"] } : { playbook: ["create"] },
  );
  const canDelete = usePermissions({ playbook: ["delete"] });
  const scrollRef = useRef<HTMLDivElement>(null);

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [positions, setPositions] = useState<Position[]>(() =>
    playbookId === null && initialPositions.length === 0
      ? [newGradedPosition()]
      : initialPositions,
  );
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
    () => new Set(positions.slice(0, 1).map((p) => p.sourceId)),
  );
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Non-null while confirming a graded → extract conversion that would drop
  // authored tiers.
  const [convertConfirmId, setConvertConfirmId] = useState<string | null>(null);
  // Which document type this playbook runs for (null = every document). A
  // files-table run gates the materialized columns on the Document Type
  // classifier, so this is what makes "a different playbook per type" work.
  const [documentTypeKey, setDocumentTypeKey] = useState<string | null>(
    initialDocumentTypeKey,
  );
  const { data: documentTypesData } = useQuery(
    documentTypesOptions(organizationId),
  );
  const documentTypes = documentTypesData?.items ?? [];

  const setNavOpen = usePlaybookNavStore((s) => s.setOpen);
  const clearNav = usePlaybookNavStore((s) => s.clear);

  const displayName = name.trim() || t("knowledge.playbooks.createPlaybook");

  // Publish the open playbook to the breadcrumb (Knowledge › Playbooks › Name)
  // and wire its list crumb back through the in-page back affordance.
  useExternalSyncEffect(() => {
    setNavOpen({ id: playbookId ?? "new", name: displayName, exit: onBack });
    return () => clearNav();
  }, [playbookId, displayName, onBack, setNavOpen, clearNav]);

  const errorsById = new Map(
    positions.map((position): [string, PositionErrors] => [
      position.sourceId,
      validatePosition(position),
    ]),
  );

  const setOpen = (sourceId: string, open: boolean) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(sourceId);
      } else {
        next.delete(sourceId);
      }
      return next;
    });
  };

  const updatePosition = (sourceId: string, next: Position) => {
    setPositions((prev) =>
      prev.map((p) => (p.sourceId === sourceId ? next : p)),
    );
  };

  const removePosition = (sourceId: string) => {
    setPositions((prev) => prev.filter((p) => p.sourceId !== sourceId));
  };

  const addPosition = (mode: "graded" | "extract") => {
    const position =
      mode === "graded" ? newGradedPosition() : newExtractPosition();
    setPositions((prev) => [...prev, position]);
    setOpen(position.sourceId, true);
  };

  const duplicateAt = (sourceId: string) => {
    const index = positions.findIndex((p) => p.sourceId === sourceId);
    const original = positions[index];
    if (!original) {
      return;
    }
    const copy = duplicatePosition(original);
    setPositions((prev) => {
      const at = prev.findIndex((p) => p.sourceId === sourceId);
      return at === -1 ? [...prev, copy] : prev.toSpliced(at + 1, 0, copy);
    });
    setOpen(copy.sourceId, true);
  };

  const convertMode = (sourceId: string) => {
    const position = positions.find((p) => p.sourceId === sourceId);
    if (!position) {
      return;
    }
    if (position.mode === "extract") {
      updatePosition(sourceId, extractToGraded(position));
      return;
    }
    const { tiers } = position;
    const hasTierContent =
      tiers.acceptable.rules.length > 0 ||
      tiers.fallback.entries.length > 0 ||
      tiers.notAcceptable.rules.length > 0 ||
      tiers.acceptable.ideal !== undefined;
    if (hasTierContent) {
      setConvertConfirmId(sourceId);
      return;
    }
    updatePosition(sourceId, gradedToExtract(position));
  };

  const confirmConvertToExtract = () => {
    if (convertConfirmId === null) {
      return;
    }
    const position = positions.find((p) => p.sourceId === convertConfirmId);
    if (position && position.mode === "graded") {
      updatePosition(convertConfirmId, gradedToExtract(position));
    }
    setConvertConfirmId(null);
  };

  const reorderPosition = (draggedSourceId: string, targetSourceId: string) => {
    setPositions((prev) => {
      const from = prev.findIndex((p) => p.sourceId === draggedSourceId);
      const to = prev.findIndex((p) => p.sourceId === targetSourceId);
      if (from === -1 || to === -1 || from === to) {
        return prev;
      }
      const dragged = prev[from];
      if (!dragged) {
        return prev;
      }
      return prev.toSpliced(from, 1).toSpliced(to, 0, dragged);
    });
  };

  const movePosition = (sourceId: string, direction: "up" | "down") => {
    setPositions((prev) => {
      const index = prev.findIndex((p) => p.sourceId === sourceId);
      const target = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || target < 0 || target >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const current = next[index];
      const swap = next[target];
      if (!current || !swap) {
        return prev;
      }
      next[index] = swap;
      next[target] = current;
      return next;
    });
  };

  const jumpToPosition = (sourceId: string) => {
    setOpen(sourceId, true);
    scrollRef.current
      ?.querySelector(`#position-${sourceId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setAttemptedSave(true);
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.nameRequired"),
      });
      return;
    }

    const invalid = positions.some((position) =>
      hasErrors(validatePosition(position)),
    );
    if (invalid) {
      setAttemptedSave(true);
      // Expand every position that still has an error so the inline messages
      // are visible, not hidden inside a collapsed card.
      setOpenIds((prev) => {
        const next = new Set(prev);
        for (const position of positions) {
          if (hasErrors(validatePosition(position))) {
            next.add(position.sourceId);
          }
        }
        return next;
      });
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.fixErrorsBeforeSaving"),
      });
      return;
    }

    const items = positions.map(normalizePosition);
    const positionsPayload: PlaybookPositionsValue = { version: 2, items };
    const trimmedDescription = description.trim();
    // Rebuild the scope from the document-type picker, preserving any existing
    // perspective. Omitted entirely when unscoped so the handler clears it.
    const scope =
      documentTypeKey === null && initialPerspective === null
        ? undefined
        : {
            ...(documentTypeKey !== null ? { documentTypeKey } : {}),
            ...(initialPerspective !== null
              ? { perspective: initialPerspective }
              : {}),
          };

    setSaving(true);
    const response =
      playbookId === null
        ? await api.playbooks.post({
            name: trimmedName,
            ...(trimmedDescription ? { description: trimmedDescription } : {}),
            ...(scope ? { scope } : {}),
            positions: positionsPayload,
          })
        : await api
            .playbooks({
              playbookId: toSafeId<"playbookDefinition">(playbookId),
            })
            .put({
              name: trimmedName,
              ...(trimmedDescription
                ? { description: trimmedDescription }
                : {}),
              ...(scope ? { scope } : {}),
              positions: positionsPayload,
            });
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: isEdit
        ? t("knowledge.playbooks.updated")
        : t("knowledge.playbooks.created"),
    });
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.playbooks.all(organizationId),
    });
    onSaved();
  };

  const handleDelete = async () => {
    if (playbookId === null) {
      return;
    }
    setSaving(true);
    const response = await api
      .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
      .delete();
    setSaving(false);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.deleteFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    stellaToast.add({
      type: "success",
      title: t("knowledge.playbooks.deleted"),
    });
    setDeleteOpen(false);
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.playbooks.all(organizationId),
    });
    onSaved();
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      ref={scrollRef}
    >
      <div className="mx-auto flex w-full max-w-5xl gap-8 p-6">
        <div className="min-w-0 flex-1 space-y-6">
          <div className="flex items-center justify-between gap-2">
            <Button onClick={onBack} size="sm" type="button" variant="ghost">
              <ArrowLeftIcon />
              {t("common.back")}
            </Button>
            <div className="flex items-center gap-2">
              {isEdit && canDelete && (
                <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
                  <Button
                    aria-label={t("knowledge.playbooks.deletePlaybook")}
                    onClick={() => setDeleteOpen(true)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("knowledge.playbooks.deletePlaybook")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("knowledge.playbooks.confirmDelete")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>
                        {t("common.cancel")}
                      </AlertDialogClose>
                      <Button
                        disabled={saving}
                        onClick={() => {
                          void handleDelete();
                        }}
                        variant="destructive"
                      >
                        {t("common.delete")}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              )}
              <Button
                disabled={!canSave || saving}
                loading={saving}
                onClick={() => {
                  void handleSave();
                }}
                type="button"
              >
                {t("common.save")}
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="playbook-name">{t("common.name")}</Label>
            <Input
              aria-invalid={attemptedSave && name.trim() === ""}
              id="playbook-name"
              onChange={(e) => setName(e.target.value)}
              placeholder={t("knowledge.playbooks.namePlaceholder")}
              value={name}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="playbook-description">
              {t("common.description")}
            </Label>
            <Textarea
              className="min-h-[60px]"
              id="playbook-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("knowledge.playbooks.descriptionPlaceholder")}
              value={description}
            />
          </div>

          {documentTypes.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="playbook-document-type">{t("common.type")}</Label>
              <Select
                onValueChange={(next) =>
                  setDocumentTypeKey(
                    next === null || next === SCOPE_ALL_VALUE ? null : next,
                  )
                }
                value={documentTypeKey ?? SCOPE_ALL_VALUE}
              >
                <SelectTrigger id="playbook-document-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={SCOPE_ALL_VALUE}>
                    {t("common.all")}
                  </SelectItem>
                  {documentTypes.map((documentType) => (
                    <SelectItem key={documentType.key} value={documentType.key}>
                      {documentType.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {t("knowledge.playbooks.positions")}
              </h2>
              <AddPositionMenu onAdd={addPosition} />
            </div>

            {positions.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t("knowledge.playbooks.noPositions")}
              </p>
            ) : (
              <ul className="space-y-3">
                {positions.map((position, index) => (
                  <PositionEditor
                    errors={errorsById.get(position.sourceId) ?? {}}
                    index={index}
                    key={position.sourceId}
                    onChange={(next) => updatePosition(position.sourceId, next)}
                    onConvertMode={() => convertMode(position.sourceId)}
                    onDuplicate={() => duplicateAt(position.sourceId)}
                    onMoveDown={() => movePosition(position.sourceId, "down")}
                    onMoveUp={() => movePosition(position.sourceId, "up")}
                    onOpenChange={(open) => setOpen(position.sourceId, open)}
                    onRemove={() => removePosition(position.sourceId)}
                    onReorder={reorderPosition}
                    open={openIds.has(position.sourceId)}
                    organizationId={organizationId}
                    position={position}
                    showErrors={attemptedSave}
                    total={positions.length}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {positions.length > 0 && (
          <OutlineRail onJump={jumpToPosition} positions={positions} />
        )}
      </div>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setConvertConfirmId(null);
          }
        }}
        open={convertConfirmId !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("knowledge.playbooks.convertToExtractTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("knowledge.playbooks.convertToExtractDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  onClick={confirmConvertToExtract}
                  variant="destructive"
                />
              }
            >
              {t("knowledge.playbooks.convertToExtract")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
};

// ── Add-position menu (graded vs extract) ─────────────

const AddPositionMenu = ({
  onAdd,
}: {
  onAdd: (mode: "graded" | "extract") => void;
}) => {
  const t = useTranslations();
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" type="button" variant="outline" />}
      >
        <PlusIcon />
        {t("knowledge.playbooks.addPosition")}
        <ChevronDownIcon className="opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => onAdd("graded")}>
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {t("knowledge.playbooks.addGradedPosition")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("knowledge.playbooks.addGradedPositionHint")}
            </span>
          </div>
        </MenuItem>
        <MenuItem onClick={() => onAdd("extract")}>
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {t("knowledge.playbooks.addExtractPosition")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("knowledge.playbooks.addExtractPositionHint")}
            </span>
          </div>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};

// ── Sticky outline rail ───────────────────────────────

const SEVERITY_DOT_VAR = {
  blocker: "--color-destructive",
  high: "--color-warning",
  medium: "--color-primary",
  low: "--color-muted-foreground",
} as const satisfies Record<PositionSeverity, string>;

const OutlineRail = ({
  positions,
  onJump,
}: {
  positions: Position[];
  onJump: (sourceId: string) => void;
}) => {
  const t = useTranslations();
  return (
    <nav
      aria-label={t("knowledge.playbooks.outline")}
      className="sticky top-6 hidden h-fit w-48 shrink-0 lg:block"
    >
      <p className="text-muted-foreground mb-2 text-[11px] font-medium tracking-[0.08em] uppercase">
        {t("knowledge.playbooks.outline")}
      </p>
      <ol className="space-y-0.5">
        {positions.map((position, index) => (
          <li key={position.sourceId}>
            <button
              className={cn(
                "hover:bg-muted flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-start",
                !position.enabled && "opacity-50",
              )}
              onClick={() => onJump(position.sourceId)}
              type="button"
            >
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]"
                dir="auto"
              >
                {position.issue.trim() ||
                  t("knowledge.playbooks.untitledPosition")}
              </span>
              {position.mode === "graded" && (
                <span
                  className="size-1.5 shrink-0 self-center rounded-full"
                  style={{
                    backgroundColor: `var(${SEVERITY_DOT_VAR[position.severity]})`,
                  }}
                />
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
};
