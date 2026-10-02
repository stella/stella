import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { useInlineRename } from "@/hooks/use-inline-rename";
import { useUpdateContact } from "@/lib/contacts/mutations";
import type { ContactUpdate } from "@/lib/contacts/mutations";
import { detached } from "@/lib/detached";
import { invalidateContactCaches } from "@/routes/_protected.contacts/-components/contact-caches";
import {
  buildContactRatePayload,
  buildNumericContactPayload,
  contactRateInput,
  buildTextContactPayload,
  EDITABLE_FIELD_POLICY,
  getEditableFieldInputAttributes,
  isNumericEditableField,
} from "@/routes/_protected.contacts/-components/editable-row.logic";
import type {
  ContactData,
  EditableField,
} from "@/routes/_protected.contacts/-components/types";

const protectedRouteApi = getRouteApi("/_protected");

type EditableRowProps = {
  label: string;
  contact: ContactData;
} & (
  | { field: "defaultHourlyRate"; value?: never }
  | {
      field: Exclude<EditableField, "defaultHourlyRate">;
      value: string | null | undefined;
    }
);

export const EditableRow = ({
  label,
  value,
  field,
  contact,
}: EditableRowProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const policy = EDITABLE_FIELD_POLICY[field];
  const inputAttributes = getEditableFieldInputAttributes(field);

  const rateNeedsCurrency = field === "defaultHourlyRate" && !contact.currency;
  const displayValue =
    field === "defaultHourlyRate"
      ? contactRateInput(contact.defaultHourlyRate, contact.currency)
      : value;
  const rename = useInlineRename({
    initial: displayValue ?? "",
    // Every contact field handles the empty case explicitly in
    // `onCommit`: `displayName` toasts (it's required), the
    // numeric fields parse to `null`, and the remaining optional
    // strings send `null` to clear a previously saved value.
    // Declaring a pass-through validator opts out of the hook's
    // default "empty draft silently cancels" so users can wipe
    // optional rows such as prefix, tax ID, currency, default
    // hourly rate, or payment terms back to empty.
    validate: () => null,
    onCommit: (trimmed, { setError }) => {
      if (
        policy.valueKind === "text" &&
        policy.maxLength !== null &&
        trimmed.length > policy.maxLength
      ) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      let payload: ContactUpdate;
      if (field === "defaultHourlyRate") {
        const result = buildContactRatePayload({
          trimmedInput: trimmed,
          currency: contact.currency,
        });
        if (result.status === "invalid") {
          const message = t("errors.actionFailed");
          stellaToast.add({ title: message, type: "error" });
          setError(message);
          return;
        }
        payload = result.payload;
      } else if (isNumericEditableField(field)) {
        const result = buildNumericContactPayload(field, trimmed);
        if (result.status === "invalid") {
          const message = t("errors.actionFailed");
          stellaToast.add({ title: message, type: "error" });
          setError(message);
          return;
        }
        payload = result.payload;
      } else {
        if (field === "displayName" && !trimmed) {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          return;
        }
        payload = buildTextContactPayload(field, trimmed);
      }

      updateContact.mutate(
        { contactId: contact.id, ...payload },
        {
          onSuccess: () => {
            detached(
              invalidateContactCaches(queryClient, {
                activeOrganizationId,
                contactId: contact.id,
                invalidateWorkspaces: field === "displayName",
              }),
              "editable-row.invalidate-contact-caches",
            );
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
          {...inputAttributes}
          autoFocus
          className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
          dir={policy.valueKind === "text" ? "auto" : undefined}
          maxLength={
            policy.valueKind === "text"
              ? (policy.maxLength ?? undefined)
              : undefined
          }
          onBlur={() => {
            detached(rename.commit(), "editable-row.commit");
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
        disabled={rateNeedsCurrency}
        onClick={() => rename.startEditing()}
        type="button"
      >
        {rateNeedsCurrency ? (
          <span className="text-foreground-subtle">
            {t("contacts.billing.selectCurrencyForRate")}
          </span>
        ) : (
          displayValue || <span className="text-foreground-subtle">—</span>
        )}
      </button>
    </div>
  );
};
