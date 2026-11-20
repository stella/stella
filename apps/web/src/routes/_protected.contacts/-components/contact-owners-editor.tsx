import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  DetailRow,
  DetailRows,
  DetailSection,
} from "@/components/detail-section.pending";
import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import type { MemberOption } from "@/components/member-combobox";
import { SettledQueryViewFeedback } from "@/components/query-view-feedback";
import { useUpdateContact } from "@/lib/contacts/mutations";
import { organizationOptions } from "@/lib/organization/queries";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
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
  const organizationView = queryView(organizationQuery);
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
    <DetailSection
      // The pickers stay disabled while the members load; only a failure
      // says anything.
      notice={<SettledQueryViewFeedback view={organizationView} />}
      title={t("contacts.attorneys.title")}
    >
      <DetailRows className="space-y-3">
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
      </DetailRows>
    </DetailSection>
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
  <DetailRow align="center" label={label}>
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
  </DetailRow>
);
