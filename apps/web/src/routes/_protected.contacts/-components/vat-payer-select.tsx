import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useUpdateContact } from "@/lib/contacts/mutations";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

const UNKNOWN = "unknown";
const YES = "yes";
const NO = "no";

export const VatPayerSelect = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const updateContact = useUpdateContact();
  let value = UNKNOWN;
  if (contact.vatPayer === true) {
    value = YES;
  } else if (contact.vatPayer === false) {
    value = NO;
  }
  const labels = {
    [UNKNOWN]: t("contacts.fields.vatPayerUnknown"),
    [YES]: t("common.vatPayer"),
    [NO]: t("contacts.fields.vatPayerNo"),
  };
  const labelOf = (current: unknown) => {
    if (current === YES) {
      return labels[YES];
    }
    if (current === NO) {
      return labels[NO];
    }
    return labels[UNKNOWN];
  };

  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-muted-foreground w-32 shrink-0">
        {t("contacts.fields.vatPayer")}
      </span>
      <Select
        disabled={updateContact.isPending}
        onValueChange={(next) => {
          updateContact.mutate({
            organizationId: contact.organizationId,
            contactId: contact.id,
            vatPayer: next === UNKNOWN ? null : next === YES,
          });
        }}
        value={value}
      >
        <SelectTrigger
          aria-label={t("contacts.fields.vatPayer")}
          className="min-w-0 flex-1"
        >
          <SelectValue>{labelOf}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={YES}>{labels[YES]}</SelectItem>
          <SelectItem value={NO}>{labels[NO]}</SelectItem>
          <SelectItem value={UNKNOWN}>{labels[UNKNOWN]}</SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
};
