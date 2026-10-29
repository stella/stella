export const agentSkillsQueryRoot = () => ["skills"] as const;

export const catalogueQueryRoot = () => ["catalogue"] as const;

export const contactsQueryRoot = () => ["contacts"] as const;

export const mcpQueryRoot = () => ["mcp"] as const;

export const organizationQueryRoot = () => ["organization"] as const;

export const organizationSettingsQueryRoot = () =>
  ["organization-settings"] as const;

export const billingCodesQueryRoot = (workspaceId: string) =>
  ["billingCodes", workspaceId] as const;

/** Every matter's correspondence, for changes that reach across matters. */
export const allCorrespondenceQueryRoot = () => ["correspondence"] as const;

export const correspondenceQueryRoot = (workspaceId: string) =>
  [...allCorrespondenceQueryRoot(), workspaceId] as const;

export const allExpensesQueryRoot = () => ["expenses"] as const;

export const expensesQueryRoot = (workspaceId: string) =>
  [...allExpensesQueryRoot(), workspaceId] as const;

export const flowRunsQueryRoot = (workspaceId: string) =>
  ["flow-runs", workspaceId] as const;

export const allInvoicesQueryRoot = () => ["invoices"] as const;

export const invoicesQueryRoot = (workspaceId: string) =>
  [...allInvoicesQueryRoot(), workspaceId] as const;

export const legalListsQueryRoot = (workspaceId: string) =>
  ["legal-lists", workspaceId] as const;

export const propertiesQueryRoot = (workspaceId: string) =>
  ["properties", workspaceId] as const;

export const ratesQueryRoot = (workspaceId: string) =>
  ["rates", workspaceId] as const;

export const tasksQueryRoot = (workspaceId: string) =>
  ["tasks", workspaceId] as const;

export const allTimeEntriesQueryRoot = () => ["timeEntries"] as const;

export const timeEntriesQueryRoot = (workspaceId: string) =>
  [...allTimeEntriesQueryRoot(), workspaceId] as const;

export const anonymizationAllowlistQueryRoot = () =>
  ["anonymization-allowlist"] as const;

export const workspaceAnonymizationAllowlistQueryRoot = (workspaceId: string) =>
  [...anonymizationAllowlistQueryRoot(), workspaceId] as const;

export const workspaceAnonymizationTermsQueryRoot = (workspaceId: string) =>
  ["anonymization-terms", workspaceId] as const;

export const workspaceContactsQueryRoot = (workspaceId: string) =>
  ["workspace-contacts", workspaceId] as const;

export const workspaceMembersQueryRoot = (workspaceId: string) =>
  ["workspace-members", workspaceId] as const;
