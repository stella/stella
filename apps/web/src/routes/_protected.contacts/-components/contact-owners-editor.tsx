import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { UserIdentity } from "@/components/user-avatar";
import { invalidateContactCaches } from "@/routes/_protected.contacts/-components/contact-caches";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";
import { useUpdateContact } from "@/routes/_protected.contacts/-mutations";
import { organizationOptions } from "@/routes/_protected.organization/-queries";

const NO_OWNER_VALUE = "__none";

const protectedRouteApi = getRouteApi("/_protected");

export const ContactOwnersEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const { data: organization } = useQuery(organizationOptions);
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const memberItems = (organization?.members ?? []).map((member) => ({
    email: member.user.email,
    image: member.user.image,
    name: member.user.name,
    value: member.userId,
  }));

  const updateOwner = (
    field: "originatingAttorneyId" | "responsibleAttorneyId",
    value: string | null,
  ) => {
    const nextValue = value === NO_OWNER_VALUE ? null : value;
    if (contact[field] === nextValue) {
      return;
    }

    updateContact.mutate(
      {
        contactId: contact.id,
        [field]: nextValue,
      },
      {
        onSuccess: () => {
          void invalidateContactCaches(queryClient, {
            activeOrganizationId,
            contactId: contact.id,
            invalidateWorkspaces: field === "responsibleAttorneyId",
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
  };

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.attorneys.title")}
      </h2>
      <div className="space-y-3 text-sm">
        <OwnerSelect
          disabled={updateContact.isPending}
          label={t("contacts.attorneys.originating")}
          members={memberItems}
          noneLabel={t("contacts.attorneys.none")}
          onValueChange={(value) => updateOwner("originatingAttorneyId", value)}
          selectedOwner={contact.originatingAttorney}
          value={contact.originatingAttorneyId ?? NO_OWNER_VALUE}
        />
        <OwnerSelect
          disabled={updateContact.isPending}
          label={t("contacts.attorneys.responsible")}
          members={memberItems}
          noneLabel={t("contacts.attorneys.none")}
          onValueChange={(value) => updateOwner("responsibleAttorneyId", value)}
          selectedOwner={contact.responsibleAttorney}
          value={contact.responsibleAttorneyId ?? NO_OWNER_VALUE}
        />
      </div>
    </section>
  );
};

type OwnerSelectProps = {
  disabled: boolean;
  label: string;
  members: {
    email: string;
    image?: string | null | undefined;
    name: string;
    value: string;
  }[];
  noneLabel: string;
  onValueChange: (value: string | null) => void;
  selectedOwner?: {
    id: string;
    image: string | null;
    name: string;
  } | null;
  value: string;
};

const OwnerSelect = ({
  disabled,
  label,
  members,
  noneLabel,
  onValueChange,
  selectedOwner,
  value,
}: OwnerSelectProps) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <Select disabled={disabled} onValueChange={onValueChange} value={value}>
      <SelectTrigger className="min-w-0 flex-1">
        <SelectValue>
          {(current) => {
            const member = members.find((item) => item.value === current);
            if (!member) {
              if (current === NO_OWNER_VALUE) {
                return (
                  <span className="text-muted-foreground">{noneLabel}</span>
                );
              }

              if (selectedOwner) {
                return (
                  <UserIdentity
                    avatarClassName="size-7 shrink-0 text-[0.625rem]"
                    className="min-w-0"
                    image={selectedOwner.image}
                    name={selectedOwner.name}
                  />
                );
              }

              return <span className="text-muted-foreground">{noneLabel}</span>;
            }

            return (
              <UserIdentity
                avatarClassName="size-7 shrink-0 text-[0.625rem]"
                className="min-w-0"
                image={member.image}
                name={member.name}
                secondaryText={member.email}
              />
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={NO_OWNER_VALUE}>
          <span className="text-muted-foreground">{noneLabel}</span>
        </SelectItem>
        {members.map((member) => (
          <SelectItem key={member.value} value={member.value}>
            <UserIdentity
              avatarClassName="size-7 shrink-0 text-[0.625rem]"
              className="min-w-0"
              image={member.image}
              name={member.name}
              secondaryText={member.email}
            />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  </div>
);
