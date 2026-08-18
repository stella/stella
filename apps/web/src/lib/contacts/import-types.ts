import type { SafeId } from "@/lib/safe-id";

type ContactEmailVars = {
  type: "work" | "personal" | "other";
  address: string;
  isPrimary: boolean;
};

type ContactAddressVars = {
  type: "office" | "mailing" | "billing" | "service" | "home" | "other";
  line1: string;
  isPrimary: boolean;
};

type ContactCustomFieldVars = {
  id: string;
  label: string;
  value: string;
};

export type ImportContactRowVars = {
  id: SafeId<"contact">;
  displayName: string;
  taxId: string;
  emails?: ContactEmailVars[];
  addresses?: ContactAddressVars[];
  metadata?: { customFields: ContactCustomFieldVars[] };
};
