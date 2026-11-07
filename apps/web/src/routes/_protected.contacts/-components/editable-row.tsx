import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { InlineRenameInput } from "@stll/ui/inline-rename";

import { useInlineRename } from "@/hooks/use-inline-rename";
import { useFormattingLocale } from "@/i18n/formatting-context";
import { useUpdateContact } from "@/lib/contacts/mutations";
import type { ContactUpdate } from "@/lib/contacts/mutations";
import { contactOptions } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { notifyUserProblem } from "@/lib/errors/user-toast";
import {
  buildContactRatePayload,
  buildNumericContactPayload,
  buildTextContactPayload,
  contactRateInput,
  EDITABLE_FIELD_POLICY,
  getEditableFieldInputAttributes,
  isNumericEditableField,
} from "@/routes/_protected.contacts/-components/editable-row.logic";
import type {
  ContactData,
  EditableField,
} from "@/routes/_protected.contacts/-components/types";

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
  const locale = useFormattingLocale();
  const updateContact = useUpdateContact();
  const queryClient = useQueryClient();
  const [scope] = useState(() => ({
    organizationId: contact.organizationId,
    contactId: contact.id,
  }));

  const policy = EDITABLE_FIELD_POLICY[field];
  const inputAttributes = getEditableFieldInputAttributes(field);

  const rateNeedsCurrency = field === "defaultHourlyRate" && !contact.currency;
  const displayValue =
    field === "defaultHourlyRate"
      ? contactRateInput(contact.defaultHourlyRate, contact.currency)
      : value;
  const rename = useInlineRename({
    initial: displayValue ?? "",
    commitOnUnmount: true,
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
        notifyUserProblem(t("errors.actionFailed"));
        return;
      }

      let payload: ContactUpdate;
      if (field === "defaultHourlyRate") {
        // Cleanup retains this row's currency even after its keyed replacement.
        // Read the cache at commit time so the old draft cannot cross currencies.
        const currentContact = queryClient.getQueryData(
          contactOptions(scope.organizationId, scope.contactId).queryKey,
        );
        if (!currentContact || currentContact.currency !== contact.currency) {
          return;
        }
        const result = buildContactRatePayload({
          trimmedInput: trimmed,
          currency: contact.currency,
          locale,
        });
        if (result.status === "invalid") {
          const message = t("errors.actionFailed");
          notifyUserProblem(message);
          setError(message);
          return;
        }
        payload = result.payload;
      } else if (isNumericEditableField(field)) {
        const result = buildNumericContactPayload(field, trimmed);
        if (result.status === "invalid") {
          const message = t("errors.actionFailed");
          notifyUserProblem(message);
          setError(message);
          return;
        }
        payload = result.payload;
      } else {
        if (field === "displayName" && !trimmed) {
          notifyUserProblem(t("errors.actionFailed"));
          return;
        }
        payload = buildTextContactPayload(field, trimmed);
      }

      updateContact.mutate({
        ...scope,
        ...payload,
      });
    },
  });

  if (rename.state.mode === "edit") {
    return (
      <div className="flex items-baseline gap-2">
        {label && (
          <span className="text-muted-foreground w-32 shrink-0">{label}</span>
        )}
        <InlineRenameInput
          {...inputAttributes}
          className="text-sm"
          dir={policy.valueKind === "text" ? "auto" : undefined}
          maxLength={
            policy.valueKind === "text"
              ? (policy.maxLength ?? undefined)
              : undefined
          }
          onCommit={() => {
            detached(rename.commit(), "editable-row.commit");
          }}
          onValueChange={rename.setDraft}
          onCancel={rename.cancel}
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
      {/* Without a currency there is nothing to edit yet: the hint stands as
          plain text (a disabled Button would dim the already subtle hint). */}
      {rateNeedsCurrency ? (
        <span className="text-foreground-subtle min-w-0 truncate text-sm">
          {t("contacts.billing.selectCurrencyForRate")}
        </span>
      ) : (
        <Button
          className="min-w-0 overflow-hidden"
          onClick={() => rename.startEditing()}
          variant="plain"
        >
          <span className="hover:text-foreground block cursor-text overflow-hidden text-sm text-ellipsis whitespace-pre">
            {displayValue || <span className="text-foreground-subtle">—</span>}
          </span>
        </Button>
      )}
    </div>
  );
};
