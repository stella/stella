export const primaryCapabilities = [
  {
    title: "Tabular review",
    description:
      "Extract key fields from large document sets into a table you can sort, filter, and review.",
  },
  {
    title: "First-class .docx support",
    description:
      "Open and edit Word documents in the browser or via the stella desktop app, with AI support along the way.",
  },
  {
    title: "Grounded research",
    description:
      "Search your workspace and trusted sources, with answers tied back to the underlying text.",
  },
] as const;

export const dataStackCapabilities = [
  {
    title: "Case law & public legal sources",
    body: "Read and search official case law and public legal material, collected and structure-parsed by stella's Legal Atlas ingestion stack.",
  },
  {
    title: "Company registries",
    body: "Pull company and commercial-registry data straight into a matter: ARES, Companies House, SEC EDGAR, KRS, PRH, VIES, and more.",
  },
] as const;

export const controlCapabilities = [
  {
    title: "Agent-ready workflows",
    body: "Use MCP and anonymization to connect stella to agent workflows without giving up control over sensitive material.",
  },
  {
    title: "Anonymize sensitive text",
    body: "Prepare material for AI workflows without exposing names, organisations, or identifying details.",
  },
  {
    title: "Use your AI provider key",
    body: "Connect your own AI provider key when using AI features.",
  },
  {
    title: "Self-host or managed cloud",
    body: "Run stella on your infrastructure or let us operate it for you.",
  },
  {
    title: "SSO and audit trails",
    body: "Control access centrally and keep a record of sensitive actions.",
  },
  {
    title: "Export everything",
    body: "Documents, metadata, and structured outputs stay portable.",
  },
] as const;
