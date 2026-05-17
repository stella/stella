import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import { useInlineRename } from "@/hooks/use-inline-rename";
import { invalidateContactCaches } from "@/routes/_protected.contacts/-components/contact-caches";
import type {
  ContactData,
  EditableField,
} from "@/routes/_protected.contacts/-components/types";
import { useUpdateContact } from "@/routes/_protected.contacts/-mutations";

const protectedRouteApi = getRouteApi("/_protected");

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
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const maxLength = FIELD_MAX_LENGTH[field];

  const rename = useInlineRename({
    initial: value ?? "",
    // `displayName` is the only required text field on a contact;
    // surface the empty case to `onCommit` (and therefore the
    // toast) by declaring a validator that always passes. Other
    // fields keep the hook's default "empty draft silently
    // cancels" behaviour.
    ...(field === "displayName" ? { validate: () => null } : {}),
    onCommit: (trimmed) => {
      if (maxLength !== undefined && trimmed.length > maxLength) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      let payload: Record<string, unknown>;
      if (field === "defaultHourlyRate" || field === "paymentTermDays") {
        const parsed = trimmed ? Number.parseInt(trimmed, 10) : null;
        if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) {
          return;
        }
        if (field === "paymentTermDays" && parsed !== null && parsed > 365) {
          return;
        }
        payload = { [field]: parsed };
      } else if (field === "displayName") {
        if (!trimmed) {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
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
            void invalidateContactCaches(queryClient, {
              activeOrganizationId,
              contactId: contact.id,
              invalidateWorkspaces: field === "displayName",
            });
          },
          onError: () => {
            stellaToast.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
  });

  if (rename.state.mode === "edit") {
    return (
      <div className="flex items-baseline gap-2">
        {label && (
          <span className="text-muted-foreground w-32 shrink-0">{label}</span>
        )}
        <Input
          autoFocus
          className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
          maxLength={maxLength}
          onBlur={() => {
            void rename.commit();
          }}
          onChange={(e) => rename.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              rename.cancel();
              e.currentTarget.blur();
            }
          }}
          type={type}
          value={rename.state.draft}
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
        onClick={() => rename.startEditing()}
        type="button"
      >
        {value || <span className="text-foreground-subtle">—</span>}
      </button>
    </div>
  );
};
