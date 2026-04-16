export const primaryCapabilities = [
  {
    title: "Tabular review",
    description:
      "Extract key fields from large document sets into a table you can sort, filter, and review.",
  },
  {
    title: "Template drafting",
    description:
      "Turn structured inputs into a clean first draft without rebuilding the document each time.",
  },
  {
    title: "Grounded research",
    description:
      "Search your workspace and trusted sources, with answers tied back to the underlying text.",
  },
] as const;

export const controlCapabilities = [
  {
    title: "Agent-ready workflows",
    body: "Use MCP and anonymization to connect stella to agent workflows without giving up control over sensitive material.",
  },
  {
    title: "Anonymize sensitive text",
    body: "Prepare material for AI workflows without exposing names, entities, or identifying details.",
  },
  {
    title: "Keep keys under your control",
    body: "Use BYOK or external key management when your security model requires tighter control over encryption.",
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
