import { AnonymizationDenyListCard } from "@/routes/_protected.settings/organization/-components/organization/anonymization-deny-list-card";

import { AnonymizationPageShell } from "./-organization.anonymization.pending";

export const OrganizationAnonymizationPage = () => (
  <AnonymizationPageShell>
    <AnonymizationDenyListCard />
  </AnonymizationPageShell>
);
