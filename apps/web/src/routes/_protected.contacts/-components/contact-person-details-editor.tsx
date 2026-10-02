import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { useUpdateContact } from "@/lib/contacts/mutations";
import { PersonDetailsFields } from "@/routes/_protected.contacts/-components/person-details-fields";
import {
  birthDateDraft,
  parseBirthDateDraft,
} from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import type { BirthDateDraft } from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

export const ContactPersonDetailsEditor = ({
  contact,
}: {
  contact: ContactData;
}) => {
  const t = useTranslations();
  const updateContact = useUpdateContact();
  const [birthDate, setBirthDate] = useState<BirthDateDraft>(() =>
    birthDateDraft(contact.dateOfBirth),
  );
  const [nationalityCodes, setNationalityCodes] = useState<string[]>(
    contact.nationalityCodes,
  );
  const currentBirthDate = birthDateDraft(contact.dateOfBirth);
  const hasBirthDateInput = Boolean(
    birthDate.year || birthDate.month || birthDate.day,
  );
  const comparableBirthDate = hasBirthDateInput
    ? birthDate
    : birthDateDraft(null);
  const dirty =
    JSON.stringify(comparableBirthDate) !== JSON.stringify(currentBirthDate) ||
    nationalityCodes.join(",") !== contact.nationalityCodes.join(",");

  const save = () => {
    const dateOfBirth = parseBirthDateDraft(birthDate);
    if (hasBirthDateInput && !dateOfBirth) {
      stellaToast.add({
        title: t("contacts.invalidDateOfBirth"),
        type: "error",
      });
      return;
    }
    updateContact.mutate(
      {
        organizationId: contact.organizationId,
        contactId: contact.id,
        dateOfBirth,
        nationalityCodes,
      },
      {
        onSuccess: () => {
          setBirthDate(birthDateDraft(dateOfBirth));
          stellaToast.add({ title: t("contacts.saved"), type: "success" });
        },
        onError: () => {
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
        },
      },
    );
  };

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.personalDetails")}
      </h2>
      <PersonDetailsFields
        birthDate={birthDate}
        nationalityCodes={nationalityCodes}
        onBirthDateChange={setBirthDate}
        onNationalityCodesChange={setNationalityCodes}
      />
      {dirty && (
        <div className="mt-4 flex justify-end">
          <Button
            loading={updateContact.isPending}
            onClick={save}
            type="button"
          >
            {t("common.save")}
          </Button>
        </div>
      )}
    </section>
  );
};
