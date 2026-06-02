import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
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
import { APIError, toAPIError, userErrorFromThrown } from "@/lib/errors";

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,48}$/u;
const RESERVED_COMMANDS = ["model", "new"] as const;

type SkillScope = "team" | "private";

type CreateSkillSheetProps = {
  canManageTeam: boolean;
  onCreated: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

type CreateSkillForm = {
  name: string;
  description: string;
  body: string;
  command: string;
  scope: SkillScope;
  autoInvokeEnabled: boolean;
  autoInvokeHint: string;
};

// Lightweight create-mode entry into the unified skill model. The
// full `EditSkillSheet` (file tree, resource upload, AI rewrite)
// only makes sense once a skill exists; new skills land here, then
// the row can be re-opened from the catalogue for the heavier
// editor.
export const CreateSkillSheet = (props: CreateSkillSheetProps) => (
  <Dialog onOpenChange={props.onOpenChange} open={props.open}>
    {props.open ? <CreateSkillSheetBody {...props} /> : null}
  </Dialog>
);

const CreateSkillSheetBody = ({
  canManageTeam,
  onCreated,
  onOpenChange,
}: CreateSkillSheetProps) => {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.skills");

  const [form, setForm] = useState<CreateSkillForm>({
    name: "",
    description: "",
    body: "",
    command: "",
    scope: "private",
    autoInvokeEnabled: false,
    autoInvokeHint: "",
  });
  const [commandError, setCommandError] = useState<string | null>(null);

  const validateCommand = (cmd: string): string | null => {
    if (!cmd) {
      return null;
    }
    if (!COMMAND_PATTERN.test(cmd)) {
      return tSkills("errors.commandInvalid");
    }
    if ((RESERVED_COMMANDS as readonly string[]).includes(cmd)) {
      return tSkills("errors.commandReserved", { command: cmd });
    }
    return null;
  };

  const onCommandChange = (value: string) => {
    const normalized = value.toLowerCase().replaceAll(/\s/gu, "");
    setForm((current) => ({ ...current, command: normalized }));
    setCommandError(validateCommand(normalized));
  };

  const createSkill = useMutation({
    mutationFn: async () => {
      const command = form.command.trim();
      const description = form.description.trim();
      const trimmedHint = form.autoInvokeHint.trim();
      const autoInvokeHint =
        form.autoInvokeEnabled && trimmedHint.length > 0
          ? trimmedHint
          : undefined;
      const response = await api.skills.post({
        name: form.name.trim(),
        description,
        body: form.body.trim(),
        scope: form.scope,
        queryKey: ["skills"],
        ...(command.length > 0 && { command }),
        ...(autoInvokeHint !== undefined && { autoInvokeHint }),
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
    },
    onError: (error: unknown) => {
      if (APIError.is(error) && error.status === 409) {
        setCommandError(tSkills("commandConflict"));
        return;
      }
      stellaToast.add({
        title: t("common.unexpectedError"),
        description: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
      });
    },
  });

  const canSubmit =
    form.name.trim().length > 0 &&
    form.description.trim().length > 0 &&
    form.body.trim().length > 0 &&
    (!form.autoInvokeEnabled || form.autoInvokeHint.trim().length > 0) &&
    !commandError;

  const onSubmit = () => {
    const err = validateCommand(form.command);
    if (err) {
      setCommandError(err);
      return;
    }
    createSkill.mutate();
  };

  return (
    <DialogPopup className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{tSkills("createTitle")}</DialogTitle>
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-4">
        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="create-skill-name">
            {tSkills("form.name")}
          </label>
          <Input
            id="create-skill-name"
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
            placeholder={tSkills("form.namePlaceholder")}
            value={form.name}
          />
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1.5">
          <label
            className="text-sm font-medium"
            htmlFor="create-skill-description"
          >
            {tSkills("form.description")}
          </label>
          <Input
            id="create-skill-description"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
            placeholder={tSkills("form.descriptionPlaceholder")}
            value={form.description}
          />
        </div>

        {/* Body / instructions */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="create-skill-body">
            {tSkills("form.prompt")}
          </label>
          <Textarea
            className="min-h-30 resize-y"
            id="create-skill-body"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                body: event.target.value,
              }))
            }
            placeholder={tSkills("form.promptPlaceholder")}
            value={form.body}
          />
        </div>

        {/* Optional slash command */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="create-skill-command">
            {tSkills("commandLabel")}
          </label>
          <div className="flex items-stretch">
            <span className="bg-muted border-border flex items-center rounded-s-md border border-e-0 px-3 text-sm">
              {tSkills("form.commandPrefix")}
            </span>
            <Input
              className={cn(
                "rounded-s-none",
                commandError && "border-destructive",
              )}
              id="create-skill-command"
              onChange={(event) => onCommandChange(event.target.value)}
              placeholder={tSkills("commandPlaceholder")}
              value={form.command}
            />
          </div>
          {commandError ? (
            <p className="text-destructive text-xs">{commandError}</p>
          ) : (
            <p className="text-muted-foreground text-xs">
              {tSkills("form.commandHint")}
            </p>
          )}
        </div>

        {/* Auto-invoke gate */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={form.autoInvokeEnabled}
              onCheckedChange={(checked) =>
                setForm((current) => ({
                  ...current,
                  autoInvokeEnabled: checked,
                }))
              }
            />
            {tSkills("autoInvokeLabel")}
          </label>
          {form.autoInvokeEnabled && (
            <div className="flex flex-col gap-1.5">
              <label
                className="text-muted-foreground text-xs"
                htmlFor="create-skill-auto-hint"
              >
                {tSkills("autoInvokeHintLabel")}
              </label>
              <Textarea
                className="min-h-20 resize-y"
                id="create-skill-auto-hint"
                maxLength={2000}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    autoInvokeHint: event.target.value,
                  }))
                }
                placeholder={tSkills("autoInvokeHintPlaceholder")}
                value={form.autoInvokeHint}
              />
            </div>
          )}
        </div>

        {/* Scope */}
        {canManageTeam && (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="create-skill-scope">
              {tSkills("form.scope")}
            </label>
            <Select
              onValueChange={(value) => {
                if (value !== "team" && value !== "private") {
                  return;
                }
                setForm((current) => ({ ...current, scope: value }));
              }}
              value={form.scope}
            >
              <SelectTrigger id="create-skill-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="private">
                  {tSkills("form.scopePrivate")}
                </SelectItem>
                <SelectItem value="team">
                  {tSkills("form.scopeTeam")}
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
          disabled={!canSubmit || createSkill.isPending}
          onClick={onSubmit}
        >
          {t("common.add")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
