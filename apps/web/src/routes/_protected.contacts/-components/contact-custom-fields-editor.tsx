import { useState } from "react";
import { useFormStatus } from "react-dom";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import { normalizeOptionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { useContactPatch } from "@/routes/_protected.contacts/-components/contact-caches";
import { getContactMetadata } from "@/routes/_protected.contacts/-components/contact-metadata";
import type {
  ContactCustomField,
  ContactData,
} from "@/routes/_protected.contacts/-components/types";

export const ContactCustomFieldsEditor = ({
  contact,
}: {
  contact: ContactData;
}) => {
  const t = useTranslations();
  const { isPending, saveContactPatch, saveContactPatchAsync } =
    useContactPatch(contact);
  const [labelDraft, setLabelDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const metadata = getContactMetadata(contact);
  const customFields = normalizeOptionalArray(metadata.customFields);

  const addCustomField = () => {
    const label = labelDraft.trim();
    if (!label) {
      return;
    }

    // Captured before the optimistic clear below so the rollback callback
    // can restore what the user had typed.
    const previousValueDraft = valueDraft;
    saveContactPatch(
      {
        metadata: {
          ...metadata,
          customFields: [
            ...customFields,
            {
              id: crypto.randomUUID(),
              label,
              value: valueDraft.trim(),
            },
          ],
        },
      },
      () => {
        setLabelDraft(label);
        setValueDraft(previousValueDraft);
      },
    );
    setLabelDraft("");
    setValueDraft("");
  };

  const updateCustomField = async (
    fieldId: string,
    patch: ContactCustomField,
  ) => {
    const label = patch.label.trim();
    const value = patch.value.trim();

    if (!label) {
      stellaToast.add({
        title: t("contacts.customFields.labelRequired"),
        type: "error",
      });
      return false;
    }

    return await saveContactPatchAsync({
      metadata: {
        ...metadata,
        customFields: customFields.map((field) =>
          field.id === fieldId
            ? {
                ...patch,
                label,
                value,
              }
            : field,
        ),
      },
    });
  };

  const removeCustomField = (fieldId: string) => {
    saveContactPatch({
      metadata: {
        ...metadata,
        customFields: customFields.filter((field) => field.id !== fieldId),
      },
    });
  };

  return (
    <section className="rounded-lg border p-4 md:col-span-2">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.customFields.title")}
      </h2>
      <div className="space-y-3">
        {customFields.map((field) => {
          const handleSave = async (patch: ContactCustomField) =>
            await updateCustomField(field.id, patch);
          return (
            <CustomFieldRow
              disabled={isPending}
              field={field}
              key={field.id}
              onRemove={() => removeCustomField(field.id)}
              onSave={handleSave}
            />
          );
        })}
        {customFields.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("contacts.customFields.empty")}
          </p>
        )}
        <form
          action={() => {
            addCustomField();
          }}
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
        >
          <Input
            disabled={isPending}
            maxLength={128}
            onChange={(event) => setLabelDraft(event.currentTarget.value)}
            placeholder={t("contacts.customFields.labelPlaceholder")}
            value={labelDraft}
          />
          <Input
            disabled={isPending}
            maxLength={2000}
            onChange={(event) => setValueDraft(event.currentTarget.value)}
            placeholder={t("contacts.customFields.valuePlaceholder")}
            value={valueDraft}
          />
          <AddCustomFieldSubmitButton
            disabled={isPending || labelDraft.trim().length === 0}
            label={t("contacts.customFields.addField")}
          />
        </form>
      </div>
    </section>
  );
};

const AddCustomFieldSubmitButton = ({
  disabled,
  label,
}: {
  disabled: boolean;
  label: string;
}) => {
  const { pending } = useFormStatus();
  return (
    <Button disabled={disabled || pending} type="submit">
      <PlusIcon className="size-4" />
      {label}
    </Button>
  );
};

const CustomFieldRow = ({
  disabled,
  field,
  onRemove,
  onSave,
}: {
  disabled: boolean;
  field: ContactCustomField;
  onRemove: () => void;
  onSave: (field: ContactCustomField) => Promise<boolean>;
}) => {
  const t = useTranslations();
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [valueDraft, setValueDraft] = useState<string | null>(null);
  const label = labelDraft ?? field.label;
  const value = valueDraft ?? field.value;

  const save = async () => {
    if (label === field.label && value === field.value) {
      setLabelDraft(null);
      setValueDraft(null);
      return;
    }

    const nextField = {
      ...field,
      label: label.trim(),
      value: value.trim(),
    };

    if (!(await onSave(nextField))) {
      return;
    }

    setLabelDraft(null);
    setValueDraft(null);
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
      <Input
        aria-label={t("contacts.customFields.label")}
        disabled={disabled}
        maxLength={128}
        onBlur={() => {
          detached(save(), "CustomFieldRow");
        }}
        onChange={(event) => setLabelDraft(event.currentTarget.value)}
        value={label}
      />
      <Input
        aria-label={t("contacts.customFields.value")}
        disabled={disabled}
        maxLength={2000}
        onBlur={() => {
          detached(save(), "CustomFieldRow");
        }}
        onChange={(event) => setValueDraft(event.currentTarget.value)}
        value={value}
      />
      <Button
        aria-label={t("contacts.customFields.removeField")}
        disabled={disabled}
        onClick={onRemove}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
};
