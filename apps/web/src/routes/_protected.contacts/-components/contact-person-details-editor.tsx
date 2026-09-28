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
  const dirty =
    JSON.stringify(birthDate) !== JSON.stringify(currentBirthDate) ||
    nationalityCodes.join(",") !== contact.nationalityCodes.join(",");

  const save = async () => {
    const dateOfBirth = parseBirthDateDraft(birthDate);
    if ((birthDate.year || birthDate.month || birthDate.day) && !dateOfBirth) {
      stellaToast.add({
        title: t("contacts.invalidDateOfBirth"),
        type: "error",
      });
      return;
    }
    await updateContact.mutateAsync({
      contactId: contact.id,
      dateOfBirth,
      nationalityCodes,
    });
    await invalidateContactCaches(queryClient, {
      activeOrganizationId,
      contactId: contact.id,
    });
    stellaToast.add({ title: t("contacts.saved"), type: "success" });
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
            onClick={() => detached(save(), "contact-person-details.save")}
            type="button"
          >
            {t("common.save")}
          </Button>
        </div>
      )}
    </section>
  );
};
