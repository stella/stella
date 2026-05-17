import { useEffect, useRef, useState } from "react";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

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
  const customFields = metadata.customFields ?? [];

  const addCustomField = () => {
    const label = labelDraft.trim();
    if (!label) {
      return;
    }

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
        setValueDraft(valueDraft);
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
        {customFields.map((field) => (
          <CustomFieldRow
            disabled={isPending}
            field={field}
            key={field.id}
            onRemove={() => removeCustomField(field.id)}
            onSave={async (patch) => await updateCustomField(field.id, patch)}
          />
        ))}
        {customFields.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("contacts.customFields.empty")}
          </p>
        )}
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            addCustomField();
          }}
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
          <Button
            disabled={isPending || labelDraft.trim().length === 0}
            type="submit"
          >
            <PlusIcon className="size-4" />
            {t("contacts.customFields.addField")}
          </Button>
        </form>
      </div>
    </section>
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
  const [label, setLabel] = useState(field.label);
  const [value, setValue] = useState(field.value);
  const latestFieldRef = useRef({ label: field.label, value: field.value });

  useEffect(() => {
    const nextField = { label: field.label, value: field.value };
    setLabel((currentLabel) =>
      currentLabel === latestFieldRef.current.label
        ? nextField.label
        : currentLabel,
    );
    setValue((currentValue) =>
      currentValue === latestFieldRef.current.value
        ? nextField.value
        : currentValue,
    );
    latestFieldRef.current = nextField;
  }, [field.label, field.value]);

  const save = async () => {
    if (label === field.label && value === field.value) {
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

    setLabel(nextField.label);
    setValue(nextField.value);
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
      <Input
        aria-label={t("contacts.customFields.label")}
        disabled={disabled}
        maxLength={128}
        onBlur={() => {
          // eslint-disable-next-line typescript/no-floating-promises
          save();
        }}
        onChange={(event) => setLabel(event.currentTarget.value)}
        value={label}
      />
      <Input
        aria-label={t("contacts.customFields.value")}
        disabled={disabled}
        maxLength={2000}
        onBlur={() => {
          // eslint-disable-next-line typescript/no-floating-promises
          save();
        }}
        onChange={(event) => setValue(event.currentTarget.value)}
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
