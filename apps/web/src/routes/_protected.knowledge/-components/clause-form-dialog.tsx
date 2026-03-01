import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stella/ui/components/dialog";
import { Input } from "@stella/ui/components/input";
import { Textarea } from "@stella/ui/components/textarea";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

// ── Types ────────────────────────────────────────────

type CategoryOption = {
  id: string;
  name: string;
};

type ClauseFormData = {
  id?: string;
  title: string;
  description: string;
  language: string;
  categoryId: string;
  bodyText: string;
};

type ClauseFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  categories: CategoryOption[];
  initial?: {
    id: string;
    title: string;
    description: string | null;
    language: string | null;
    categoryId: string | null;
    bodyText: string;
  };
};

// ── Helpers ──────────────────────────────────────────

const textToBody = (text: string) =>
  text.split("\n").map((line) => ({ text: line }));

// ── Component ────────────────────────────────────────

export const ClauseFormDialog = ({
  open,
  onOpenChange,
  onSaved,
  categories,
  initial,
}: ClauseFormDialogProps) => {
  const t = useTranslations();
  const isEdit = !!initial?.id;

  const [form, setForm] = useState<ClauseFormData>(() => ({
    id: initial?.id,
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    language: initial?.language ?? "",
    categoryId: initial?.categoryId ?? "",
    bodyText: initial?.bodyText ?? "",
  }));
  const [saving, setSaving] = useState(false);

  // Reset form when dialog opens to reflect latest data
  useEffect(() => {
    if (open) {
      setForm({
        id: initial?.id,
        title: initial?.title ?? "",
        description: initial?.description ?? "",
        language: initial?.language ?? "",
        categoryId: initial?.categoryId ?? "",
        bodyText: initial?.bodyText ?? "",
      });
    }
  }, [open, initial]);

  const handleSave = useCallback(async () => {
    if (!form.title.trim()) {
      return;
    }

    setSaving(true);

    const body = textToBody(form.bodyText);

    if (isEdit && form.id) {
      const response = await api.clauses({ clauseId: form.id }).post({
        title: form.title.trim(),
        description: form.description.trim() || null,
        language: form.language.trim() || null,
        categoryId: form.categoryId || null,
        body,
      });

      setSaving(false);

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("clauses.updateFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      toastManager.add({
        type: "success",
        title: t("clauses.clauseUpdated"),
      });
    } else {
      const response = await api.clauses.put({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        language: form.language.trim() || undefined,
        categoryId: form.categoryId || undefined,
        body,
      });

      setSaving(false);

      if (response.error) {
        toastManager.add({
          type: "error",
          title: t("clauses.createFailed"),
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        });
        return;
      }

      toastManager.add({
        type: "success",
        title: t("clauses.clauseCreated"),
      });
    }

    onOpenChange(false);
    onSaved();
  }, [form, isEdit, t, onOpenChange, onSaved]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("clauses.editClause") : t("clauses.createClause")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="clause-title">
              {t("clauses.titleLabel")}
            </label>
            <Input
              id="clause-title"
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  title: e.target.value,
                }))
              }
              placeholder={t("clauses.titlePlaceholder")}
              value={form.title}
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="clause-description">
              {t("clauses.description")}
            </label>
            <Input
              id="clause-description"
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  description: e.target.value,
                }))
              }
              placeholder={t("clauses.descriptionPlaceholder")}
              value={form.description}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="clause-language">
                {t("clauses.language")}
              </label>
              <Input
                id="clause-language"
                maxLength={10}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    language: e.target.value,
                  }))
                }
                placeholder={t("clauses.languagePlaceholder")}
                value={form.language}
              />
            </div>

            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="clause-category">
                {t("clauses.selectCategory")}
              </label>
              <select
                className="flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm"
                id="clause-category"
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    categoryId: e.target.value,
                  }))
                }
                value={form.categoryId}
              >
                <option value="">{t("clauses.uncategorized")}</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="clause-body">
              {t("clauses.body")}
            </label>
            <Textarea
              className="min-h-[120px]"
              id="clause-body"
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  bodyText: e.target.value,
                }))
              }
              value={form.bodyText}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button disabled={saving || !form.title.trim()} onClick={handleSave}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
