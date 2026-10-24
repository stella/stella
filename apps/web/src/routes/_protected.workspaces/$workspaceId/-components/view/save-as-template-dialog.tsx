import { useState } from "react";

import { useTranslations } from "use-intl";

import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { useSingleFlight } from "@/hooks/use-single-flight";
import { detached } from "@/lib/detached";
import { apiFieldIssueMessage } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { ViewLayout } from "@/lib/types";
import { useCreateViewTemplate } from "@/routes/_protected.workspaces/$workspaceId/-mutations/view-templates";

type SaveAsTemplateDialogProps = {
  workspaceId: string;
  layout: ViewLayout;
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type SaveTemplateHandlers = {
  onSettled: () => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
};

type SaveAsTemplateDialogViewProps = {
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether a save is in flight. */
  pending: boolean;
  save: (name: string, handlers: SaveTemplateHandlers) => void;
};

export const SaveAsTemplateDialog = ({
  workspaceId,
  layout,
  ...props
}: SaveAsTemplateDialogProps) => {
  const createTemplate = useCreateViewTemplate();
  return (
    <SaveAsTemplateDialogView
      {...props}
      pending={createTemplate.isPending}
      save={(name, handlers) => {
        createTemplate.mutate({ workspaceId, name, layout }, handlers);
      }}
    />
  );
};

export const SaveAsTemplateDialogView = ({
  defaultName,
  open,
  onOpenChange,
  pending,
  save,
}: SaveAsTemplateDialogViewProps) => {
  const t = useTranslations();
  const [name, setName] = useState(defaultName);
  // The server's verdict on the name, shown under the field until it changes.
  const [nameIssue, setNameIssue] = useState<string | undefined>();
  const submitOnce = useSingleFlight();

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName(defaultName);
      setNameIssue(undefined);
    }
    onOpenChange(next);
  };

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  const saveTemplate = (settled: () => void) => {
    if (!canSubmit) {
      settled();
      return;
    }
    save(trimmed, {
      onSettled: settled,
      onSuccess: () => {
        stellaToast.add({
          title: t("workspaces.views.templates.created"),
          type: "success",
        });
        onOpenChange(false);
      },
      onError: (error) => {
        setNameIssue(apiFieldIssueMessage(error, "name"));
        notifyUserError(error, t("errors.failedToSaveTemplate"));
      },
    });
  };
  const handleSubmit = () => {
    detached(submitOnce.runSettled(saveTemplate), "save-as-template.submit");
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup className="sm:max-w-sm">
        <DialogFormState
          dirty={name !== defaultName}
          onDiscard={() => {
            setName(defaultName);
            setNameIssue(undefined);
          }}
        />
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("workspaces.views.saveAsTemplate")}</DialogTitle>
            <DialogDescription>
              {t("workspaces.views.templates.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Field invalid={nameIssue !== undefined}>
              <FieldLabel>
                {t("workspaces.views.templates.nameLabel")}
              </FieldLabel>
              <Input
                autoFocus
                maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameIssue(undefined);
                }}
                placeholder={t("workspaces.views.templates.namePlaceholder")}
                value={name}
              />
              {nameIssue !== undefined && (
                <FieldError match>{nameIssue}</FieldError>
              )}
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button disabled={!canSubmit} loading={pending} type="submit">
              {t("workspaces.views.templates.save")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
