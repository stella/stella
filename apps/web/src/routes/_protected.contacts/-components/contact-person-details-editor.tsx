import { useRef, useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
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
  const [scope] = useState(() => ({
    organizationId: contact.organizationId,
    contactId: contact.id,
  }));
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

  const submittedDraft = useRef<string | undefined>(undefined);
  const save = () => {
    const draftKey = JSON.stringify({ birthDate, nationalityCodes });
    if (!dirty || submittedDraft.current === draftKey) {
      return;
    }
    const dateOfBirth = parseBirthDateDraft(birthDate);
    if (hasBirthDateInput && !dateOfBirth) {
      stellaToast.add({
        title: t("contacts.invalidDateOfBirth"),
        type: "error",
      });
      return;
    }
    submittedDraft.current = draftKey;
    updateContact.mutate(
      {
        ...scope,
        dateOfBirth,
        nationalityCodes,
      },
      {
        onSuccess: () => {
          setBirthDate(birthDateDraft(dateOfBirth));
          stellaToast.add({ title: t("contacts.saved"), type: "success" });
        },
        onError: () => {
          submittedDraft.current = undefined;
        },
      },
    );
  };

  const flush = useLatestCallback(save);
  useMountEffect(() => () => flush());

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.personalDetails")}
      </h2>
      <PersonDetailsFields
        birthDate={birthDate}
        nationalityCodes={nationalityCodes}
        onBirthDateChange={(value) => {
          submittedDraft.current = undefined;
          setBirthDate(value);
        }}
        onNationalityCodesChange={(value) => {
          submittedDraft.current = undefined;
          setNationalityCodes(value);
        }}
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
