import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { ContactType } from "@stll/api-contract";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { contactsKeys } from "@/lib/contacts/queries";
import type { contactOptions } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { NonEmptyPatch } from "@/lib/mutation-command";
import type { SafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";

type ContactDetail = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof contactOptions>["queryFn"]>>>
>;

export type PersonDateOfBirth = NonNullable<ContactDetail["dateOfBirth"]>;

type BankAccount = {
  iban?: string;
  bic?: string;
  accountNumber?: string;
  bankName?: string;
  currency?: string;
};

type BillingAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

type ContactEmail = {
  type: "work" | "personal" | "other";
  address: string;
  isPrimary: boolean;
  label?: string;
};

type ContactPhone = {
  type: "mobile" | "office" | "home" | "fax" | "other";
  number: string;
  isPrimary: boolean;
  label?: string;
};

type ContactDataBox = {
  id: string;
  isPrimary: boolean;
  label?: string;
};

type ContactCustomField = {
  id: string;
  label: string;
  value: string;
};

type ContactMetadata = {
  dataBoxes?: ContactDataBox[];
  customFields?: ContactCustomField[];
};

type ContactMetadataSection =
  | { dataBoxes: ContactDataBox[]; customFields?: never }
  | { customFields: ContactCustomField[]; dataBoxes?: never };

type CreateContactVars = {
  id: SafeId<"contact">;
  type: ContactType;
  displayName: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  prefix?: string;
  middleName?: string;
  suffix?: string;
  notes?: string;
  emails?: ContactEmail[];
  phones?: ContactPhone[];
  metadata?: ContactMetadata;
  color?: string;
  registrationNumber?: string;
  taxId?: string;
  bankAccounts?: BankAccount[];
  billingAddress?: BillingAddress;
  defaultHourlyRate?: number;
  currency?: string;
  paymentTermDays?: number;
  originatingAttorneyId?: SafeId<"user">;
  responsibleAttorneyId?: SafeId<"user">;
  dateOfBirth?: PersonDateOfBirth;
  nationalityCodes?: string[];
};

export const useCreateContact = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async (vars: CreateContactVars) => {
      const response = await api.contacts.put(vars);

      return unwrapEden(response);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

export type ContactUpdateFields = {
  displayName: string;
  type: ContactType;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  prefix: string | null;
  middleName: string | null;
  suffix: string | null;
  notes: string | null;
  emails: ContactEmail[] | null;
  phones: ContactPhone[] | null;
  metadata: ContactMetadataSection;
  color: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  bankAccounts: BankAccount[] | null;
  billingAddress: BillingAddress | null;
  defaultHourlyRate: number | null;
  currency: string | null;
  paymentTermDays: number | null;
  originatingAttorneyId: SafeId<"user"> | null;
  responsibleAttorneyId: SafeId<"user"> | null;
  dateOfBirth: PersonDateOfBirth | null;
  nationalityCodes: string[] | null;
};

export type ContactUpdate = NonEmptyPatch<ContactUpdateFields>;

type UpdateContactVars = {
  organizationId: SafeId<"organization">;
  contactId: SafeId<"contact">;
} & ContactUpdate;

export const useUpdateContact = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      contactId,
      organizationId: _organizationId,
      ...body
    }: UpdateContactVars) => {
      const response = await api.contacts({ contactId }).post(body);

      return unwrapEden(response);
    },
    onSuccess: async (_data, vars) => {
      // Mutation callbacks outlive page observers. Use the submitted scope even
      // when the route has moved to another contact or organization meanwhile.
      detached(
        queryClient.invalidateQueries({
          queryKey: contactsKeys.lists(vars.organizationId),
        }),
        "contacts.update-lists",
      );
      if (
        vars.displayName !== undefined ||
        vars.responsibleAttorneyId !== undefined
      ) {
        detached(
          queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
          "contacts.update-workspaces",
        );
      }
      // Detail must settle before another array edit can read its source data.
      await queryClient.invalidateQueries({
        queryKey: contactsKeys.byId(vars.organizationId, vars.contactId),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
};

type DeleteContactVars = {
  contactId: string;
};

export const useDeleteContact = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ contactId }: DeleteContactVars) => {
      const response = await api.contacts({ contactId }).delete();

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
