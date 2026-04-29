import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";

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

type CreateContactVars = {
  id: SafeId<"contact">;
  type: "person" | "organization";
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
};

export const useCreateContact = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async (vars: CreateContactVars) => {
      const response = await api.contacts.put(vars);

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpdateContactVars = {
  contactId: SafeId<"contact">;
  displayName?: string;
  type?: "person" | "organization";
  firstName?: string | null;
  lastName?: string | null;
  organizationName?: string | null;
  prefix?: string | null;
  middleName?: string | null;
  suffix?: string | null;
  notes?: string | null;
  emails?: ContactEmail[] | null;
  phones?: ContactPhone[] | null;
  metadata?: ContactMetadata | null;
  color?: string | null;
  registrationNumber?: string | null;
  taxId?: string | null;
  bankAccounts?: BankAccount[] | null;
  billingAddress?: BillingAddress | null;
  defaultHourlyRate?: number | null;
  currency?: string | null;
  paymentTermDays?: number | null;
  originatingAttorneyId?: SafeId<"user"> | null;
  responsibleAttorneyId?: SafeId<"user"> | null;
};

export const useUpdateContact = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ contactId, ...body }: UpdateContactVars) => {
      const response = await api.contacts({ contactId }).post(body);

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
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
