import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import type { ViewLayout } from "@/lib/types";
import { useCreateViewTemplate } from "@/routes/_protected.workspaces/$workspaceId/-mutations/view-templates";

type SaveAsTemplateDialogProps = {
  workspaceId: string;
  layout: ViewLayout;
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const SaveAsTemplateDialog = ({
  workspaceId,
  layout,
  defaultName,
  open,
  onOpenChange,
}: SaveAsTemplateDialogProps) => {
  const t = useTranslations();
  const [name, setName] = useState(defaultName);
  const createTemplate = useCreateViewTemplate();

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName(defaultName);
    }
    onOpenChange(next);
  };

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !createTemplate.isPending;

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    createTemplate.mutate(
      { workspaceId, name: trimmed, layout },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("workspaces.views.templates.created"),
            type: "success",
          });
          onOpenChange(false);
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToSaveTemplate"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup className="sm:max-w-sm">
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
            <Field>
              <FieldLabel>
                {t("workspaces.views.templates.nameLabel")}
              </FieldLabel>
              <Input
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder={t("workspaces.views.templates.namePlaceholder")}
                value={name}
              />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              disabled={!canSubmit}
              loading={createTemplate.isPending}
              type="submit"
            >
              {t("workspaces.views.templates.save")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};
