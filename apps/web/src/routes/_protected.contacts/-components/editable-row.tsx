import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import { invalidateContactCaches } from "@/routes/_protected.contacts/-components/contact-caches";
import type {
  ContactData,
  EditableField,
} from "@/routes/_protected.contacts/-components/types";
import { useUpdateContact } from "@/routes/_protected.contacts/-mutations";

const FIELD_MAX_LENGTH: Partial<Record<EditableField, number>> = {
  prefix: 32,
  firstName: 256,
  middleName: 256,
  lastName: 256,
  suffix: 32,
  organizationName: 512,
  displayName: 512,
  registrationNumber: 64,
  taxId: 64,
  currency: 3,
};

type EditableRowProps = {
  label: string;
  value: string | null | undefined;
  field: EditableField;
  contact: ContactData;
  type?: "text" | "number";
};

export const EditableRow = ({
  label,
  value,
  field,
  contact,
  type = "text",
}: EditableRowProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(value ?? "");

  const maxLength = FIELD_MAX_LENGTH[field];

  const handleSave = () => {
    setIsEditing(false);
    const trimmed = inputValue.trim();
    const current = value ?? "";

    if (trimmed === current) {
      return;
    }

    if (maxLength !== undefined && trimmed.length > maxLength) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      setInputValue(value ?? "");
      return;
    }

    let payload: Record<string, unknown>;
    if (field === "defaultHourlyRate" || field === "paymentTermDays") {
      const parsed = trimmed ? Number.parseInt(trimmed, 10) : null;
      if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) {
        setInputValue(value ?? "");
        return;
      }
      if (field === "paymentTermDays" && parsed !== null && parsed > 365) {
        setInputValue(value ?? "");
        return;
      }
      payload = { [field]: parsed };
    } else if (field === "displayName") {
      if (!trimmed) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        setInputValue(value ?? "");
        return;
      }
      payload = { displayName: trimmed };
    } else {
      payload = { [field]: trimmed || null };
    }

    updateContact.mutate(
      { contactId: contact.id, ...payload },
      {
        onSuccess: () => {
          void invalidateContactCaches(queryClient, contact.id, {
            invalidateWorkspaces: field === "displayName",
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          setInputValue(value ?? "");
        },
      },
    );
  };

  if (isEditing) {
    return (
      <div className="flex items-baseline gap-2">
        {label && (
          <span className="text-muted-foreground w-32 shrink-0">{label}</span>
        )}
        <Input
          autoFocus
          className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
          maxLength={maxLength}
          onBlur={handleSave}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setInputValue(value ?? "");
              setIsEditing(false);
            }
          }}
          type={type}
          value={inputValue}
        />
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-2">
      {label && (
        <span className="text-muted-foreground w-32 shrink-0">{label}</span>
      )}
      <button
        className="hover:text-foreground cursor-text text-start text-sm"
        onClick={() => {
          setInputValue(value ?? "");
          setIsEditing(true);
        }}
        type="button"
      >
        {value || <span className="text-foreground-subtle">—</span>}
      </button>
    </div>
  );
};
