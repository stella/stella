import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import type { MemberOption } from "@/components/member-combobox";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useUpdateContact } from "@/lib/contacts/mutations";
import { organizationOptions } from "@/lib/organization/queries";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

const protectedRouteApi = getRouteApi("/_protected");

type ContactOwnerField = "originatingAttorneyId" | "responsibleAttorneyId";

const contactOwnerPatch = (field: ContactOwnerField, value: string | null) => {
  const ownerUserId = value === null ? null : toSafeId<"user">(value);
  switch (field) {
    case "originatingAttorneyId":
      return { originatingAttorneyId: ownerUserId };
    case "responsibleAttorneyId":
      return { responsibleAttorneyId: ownerUserId };
    default:
      field satisfies never;
      return panic(`Unhandled field: ${String(field)}`);
  }
};

export const ContactOwnersEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const updateContact = useUpdateContact();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const organizationQuery = useQuery(organizationOptions(activeOrganizationId));
  const organizationView = useQueryView(organizationQuery);
  const organization =
    organizationView.type === "items" ? organizationView.items : undefined;

  const organizationMembers = organization ? organization.members : [];
  const memberOptions = organizationMembers.map((member) => ({
    email: member.user.email,
    image: member.user.image ?? null,
    name: member.user.name,
    userId: member.userId,
  }));

  const updateOwner = (field: ContactOwnerField, nextValue: string | null) => {
    if (contact[field] === nextValue) {
      return;
    }

    updateContact.mutate({
      organizationId: contact.organizationId,
      contactId: contact.id,
      ...contactOwnerPatch(field, nextValue),
    });
  };

  return (
    <section className="rounded-lg border p-4">
      <QueryViewFeedback view={organizationView} />
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.attorneys.title")}
      </h2>
      <div className="space-y-3 text-sm">
        <OwnerField
          disabled={
            updateContact.isPending || organizationView.type !== "items"
          }
          label={t("contacts.attorneys.originating")}
          members={memberOptions}
          noneLabel={t("contacts.attorneys.none")}
          onValueChange={(value) => updateOwner("originatingAttorneyId", value)}
          selectedOwner={contact.originatingAttorney}
          value={contact.originatingAttorneyId}
        />
        <OwnerField
          disabled={
            updateContact.isPending || organizationView.type !== "items"
          }
          label={t("contacts.attorneys.responsible")}
          members={memberOptions}
          noneLabel={t("contacts.attorneys.none")}
          onValueChange={(value) => updateOwner("responsibleAttorneyId", value)}
          selectedOwner={contact.responsibleAttorney}
          value={contact.responsibleAttorneyId}
        />
      </div>
    </section>
  );
};

type OwnerFieldProps = {
  disabled: boolean;
  label: string;
  members: readonly MemberOption[];
  noneLabel: string;
  onValueChange: (userId: string | null) => void;
  selectedOwner: ContactData["originatingAttorney"];
  value: string | null;
};

const OwnerField = ({
  disabled,
  label,
  members,
  noneLabel,
  onValueChange,
  selectedOwner,
  value,
}: OwnerFieldProps) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <div className="min-w-0 flex-1">
      <MemberCombobox
        choice={{ type: MEMBER_CHOICE.memberOrNone, noneLabel }}
        disabled={disabled}
        label={label}
        members={members}
        onValueChange={onValueChange}
        placeholder={noneLabel}
        selectedFallback={
          selectedOwner
            ? {
                userId: selectedOwner.id,
                name: selectedOwner.name,
                email: null,
                image: selectedOwner.image,
              }
            : null
        }
        value={value}
      />
    </div>
  </div>
);
