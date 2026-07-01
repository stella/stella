import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { usePlaybookNavStore } from "@/routes/_protected.knowledge/-components/playbook-nav-store";
import {
  type PlaybookPositionsValue,
  type Position,
  withFallbackRank,
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
        initialName=""
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

const newPosition = (): Position => ({
  sourceId: crypto.randomUUID(),
  issue: "",
  ask: { question: "", content: { version: 1, type: "text" } },
  standard: { source: "none" },
  rule: { kind: "extractOnly" },
  severity: "medium",
});

// Trim the issue and (for inline standards) drop blank fallback rows + re-rank
// the survivors, returning a fresh position so editor state is never mutated.
// `text` carries minLength 1 server-side, hence the blank-row drop.
const normalizePosition = (position: Position): Position => {
  const issue = position.issue.trim();
  if (position.standard.source !== "inline" || !position.standard.fallbacks) {
    return { ...position, issue };
  }
  const fallbacks = position.standard.fallbacks
    .filter((fallback) => fallback.text.trim() !== "")
    .map(withFallbackRank);
  return {
    ...position,
    issue,
    standard: { ...position.standard, fallbacks },
  };
};

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

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [positions, setPositions] = useState<Position[]>(() =>
    initialPositions.length > 0 ? initialPositions : [newPosition()],
  );
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  const updatePosition = (index: number, next: Position) => {
    setPositions((prev) => prev.map((p, i) => (i === index ? next : p)));
  };

  const removePosition = (index: number) => {
    setPositions((prev) => prev.filter((_, i) => i !== index));
  };

  const movePosition = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    setPositions((prev) => {
      if (target < 0 || target >= prev.length) {
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

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.nameRequired"),
      });
      return;
    }

    for (const position of positions) {
      if (position.issue.trim() === "") {
        stellaToast.add({
          type: "error",
          title: t("knowledge.playbooks.positionIssueRequired"),
        });
        return;
      }
      if (
        position.standard.source === "clause" &&
        position.standard.clauseId === ""
      ) {
        stellaToast.add({
          type: "error",
          title: t("knowledge.playbooks.clauseRequired"),
        });
        return;
      }
    }

    const items = positions.map(normalizePosition);
    const positionsPayload: PlaybookPositionsValue = { version: 1, items };
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
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
            <Button
              onClick={() => setPositions((prev) => [...prev, newPosition()])}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlusIcon />
              {t("knowledge.playbooks.addPosition")}
            </Button>
          </div>

          {positions.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("knowledge.playbooks.noPositions")}
            </p>
          ) : (
            <ul className="space-y-4">
              {positions.map((position, index) => (
                <PositionEditor
                  index={index}
                  key={position.sourceId}
                  onChange={(next) => updatePosition(index, next)}
                  onMoveDown={() => movePosition(index, "down")}
                  onMoveUp={() => movePosition(index, "up")}
                  onRemove={() => removePosition(index)}
                  organizationId={organizationId}
                  position={position}
                  total={positions.length}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
