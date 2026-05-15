import { useEffect, useState } from "react";

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
import { userErrorMessage } from "@/lib/errors";

// ── Types ────────────────────────────────────────────

type ShortcutScope = "team" | "private";

type ShortcutFormData = {
  name: string;
  description: string;
  command: string;
  prompt: string;
  scope: ShortcutScope;
};

export type ShortcutInitial = {
  id: string;
  name: string;
  description: string | null;
  command: string;
  prompt: string;
  scope: ShortcutScope;
};

type ShortcutFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  canManageTeam: boolean;
  initial?: ShortcutInitial;
};

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,48}$/;
const RESERVED_COMMANDS = ["model", "new"] as const;

// ── Component ────────────────────────────────────────

export const ShortcutFormDialog = ({
  open,
  onOpenChange,
  onSaved,
  canManageTeam,
  initial,
}: ShortcutFormDialogProps) => {
  const t = useTranslations();
  const isEdit = !!initial?.id;

  const [form, setForm] = useState<ShortcutFormData>(() => ({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    command: initial?.command ?? "",
    prompt: initial?.prompt ?? "",
    scope: initial?.scope ?? "private",
  }));
  const [commandError, setCommandError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        name: initial?.name ?? "",
        description: initial?.description ?? "",
        command: initial?.command ?? "",
        prompt: initial?.prompt ?? "",
        scope: initial?.scope ?? "private",
      });
      setCommandError(null);
    }
  }, [open, initial]);

  const validateCommand = (cmd: string): string | null => {
    if (!cmd) {
      return null;
    }
    if (!COMMAND_PATTERN.test(cmd)) {
      return t("knowledge.skills.errors.commandInvalid");
    }
    if ((RESERVED_COMMANDS as readonly string[]).includes(cmd)) {
      return t("knowledge.skills.errors.commandReserved", { command: cmd });
    }
    return null;
  };

  const handleCommandChange = (value: string) => {
    const lower = value.toLowerCase().replace(/\s/g, "");
    setForm((f) => ({ ...f, command: lower }));
    setCommandError(validateCommand(lower));
  };

  const handleSubmit = async () => {
    const err = validateCommand(form.command);
    if (err) {
      setCommandError(err);
      return;
    }
    if (!form.name.trim() || !form.command || !form.prompt.trim()) {
      return;
    }

    setSaving(true);

    if (isEdit && initial.id) {
      const response = await api.shortcuts({ shortcutId: initial.id }).post({
        name: form.name.trim(),
        description: form.description.trim() || null,
        command: form.command,
        prompt: form.prompt.trim(),
        queryKey: ["shortcuts"],
      });

      setSaving(false);

      if (response.error) {
        if (response.error.status === 409) {
          setCommandError(t("knowledge.skills.errors.commandConflict"));
          return;
        }
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
    } else {
      const trimmedDescription = form.description.trim();
      const response = await api.shortcuts.put({
        name: form.name.trim(),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
        command: form.command,
        prompt: form.prompt.trim(),
        scope: form.scope,
        queryKey: ["shortcuts"],
      });

      setSaving(false);

      if (response.error) {
        if (response.error.status === 409) {
          setCommandError(t("knowledge.skills.errors.commandConflict"));
          return;
        }
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
    }

    onSaved();
    onOpenChange(false);
  };

  const canSubmit =
    form.name.trim().length > 0 &&
    form.command.length > 0 &&
    form.prompt.trim().length > 0 &&
    !commandError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("knowledge.skills.editShortcut")
              : t("knowledge.skills.addShortcut")}
          </DialogTitle>
        </DialogHeader>

        <DialogPanel className="flex flex-col gap-4">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="shortcut-name">
              {t("knowledge.skills.form.name")}
            </label>
            <Input
              id="shortcut-name"
              placeholder={t("knowledge.skills.form.namePlaceholder")}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="shortcut-description"
            >
              {t("knowledge.skills.form.description")}
            </label>
            <Input
              id="shortcut-description"
              placeholder={t("knowledge.skills.form.descriptionPlaceholder")}
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </div>

          {/* Command */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="shortcut-command">
              {t("knowledge.skills.form.command")}
            </label>
            <div className="flex items-stretch">
              <span className="bg-muted border-border flex items-center rounded-s-md border border-e-0 px-3 text-sm">
                {t("knowledge.skills.form.commandPrefix")}
              </span>
              <Input
                id="shortcut-command"
                className={cn(
                  "rounded-s-none",
                  commandError && "border-destructive",
                )}
                placeholder={t("knowledge.skills.form.commandPlaceholder")}
                value={form.command}
                onChange={(e) => handleCommandChange(e.target.value)}
              />
            </div>
            {commandError ? (
              <p className="text-destructive text-xs">{commandError}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t("knowledge.skills.form.commandHint")}
              </p>
            )}
          </div>

          {/* Prompt */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="shortcut-prompt">
              {t("knowledge.skills.form.prompt")}
            </label>
            <Textarea
              id="shortcut-prompt"
              className="min-h-30 resize-y"
              placeholder={t("knowledge.skills.form.promptPlaceholder")}
              value={form.prompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, prompt: e.target.value }))
              }
            />
          </div>

          {/* Scope — only shown on create and only for admins/owners */}
          {!isEdit && canManageTeam && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="shortcut-scope">
                {t("knowledge.skills.form.scope")}
              </label>
              <Select
                value={form.scope}
                onValueChange={(v) =>
                  // eslint-disable-next-line typescript/no-unsafe-type-assertion
                  setForm((f) => ({ ...f, scope: v as ShortcutScope }))
                }
              >
                <SelectTrigger id="shortcut-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="private">
                    {t("knowledge.skills.form.scopePrivate")}
                  </SelectItem>
                  <SelectItem value="team">
                    {t("knowledge.skills.form.scopeTeam")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!canSubmit || saving}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {isEdit ? t("common.save") : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
