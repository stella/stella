export type SecurityControl = {
  title: string;
  body: string;
  evidenceId: string;
  policyPath: `docs/policies/${string}.md`;
};

export const securityControls: readonly SecurityControl[] = [
  {
    title: "Authorization boundaries",
    body: "Workspace access is validated before scoped handlers run, and validated workspace identifiers use a distinct safe type inside the API.",
    evidenceId: "access-auth-boundary",
    policyPath: "docs/policies/access-control.md",
  },
  {
    title: "Private file storage",
    body: "Stored objects are private, keys are scoped by organization and workspace, and file access uses short-lived signed URLs.",
    evidenceId: "classification-object-storage",
    policyPath: "docs/policies/data-classification.md",
  },
  {
    title: "Explicit deletion paths",
    body: "Document deletion removes database records and stored objects; workspace deletion follows an explicit deletion state rather than silently hiding data.",
    evidenceId: "retention-hard-delete",
    policyPath: "docs/policies/data-retention.md",
  },
  {
    title: "Configurable AI providers",
    body: "AI provider selection is kept behind a provider abstraction instead of being embedded in product business logic.",
    evidenceId: "vendor-provider-abstraction",
    policyPath: "docs/policies/vendor-management.md",
  },
  {
    title: "Dependency safeguards",
    body: "New dependency releases are quarantined before installation, while automated dependency review blocks known high-severity risk.",
    evidenceId: "vendor-supply-chain",
    policyPath: "docs/policies/vendor-management.md",
  },
  {
    title: "Continuous static analysis",
    body: "CodeQL and repository security guards run as committed checks, so security regressions surface in review rather than remaining informal process.",
    evidenceId: "vulnerability-static-analysis",
    policyPath: "docs/policies/vulnerability-mgmt.md",
  },
];
