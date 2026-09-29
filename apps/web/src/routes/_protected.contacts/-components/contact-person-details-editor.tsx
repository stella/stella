import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";

import { useUpdateContact } from "@/lib/contacts/mutations";
import { detached } from "@/lib/detached";
import { invalidateContactCaches } from "@/routes/_protected.contacts/-components/contact-caches";
import { PersonDetailsFields } from "@/routes/_protected.contacts/-components/person-details-fields";
import {
  birthDateDraft,
  parseBirthDateDraft,
} from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import type { BirthDateDraft } from "@/routes/_protected.contacts/-components/person-details-fields.logic";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

const protectedRouteApi = getRouteApi("/_protected");

export const ContactPersonDetailsEditor = ({
  contact,
}: {
  contact: ContactData;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
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
      { contactId: contact.id, dateOfBirth, nationalityCodes },
      {
        onSuccess: () => {
          setBirthDate(birthDateDraft(dateOfBirth));
          detached(
            invalidateContactCaches(queryClient, {
              activeOrganizationId,
              contactId: contact.id,
            }),
            "contact-person-details.invalidate-contact-caches",
          );
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
