// Single source of truth for the AI fact sheet. Used by the /ai-info page
// (rendered Q&A + FAQPage JSON-LD) and the /llms-full.txt endpoint, so the
// human-visible answers and the machine-readable feed never drift.

export const aiTagline =
  "stella is an open-source legal workspace and data stack: matters, documents, and Word editing connected to case law, company registries, and an AI agent that works across them. Self-hostable, usage-billed AI, no lock-in.";

// A fuller prose overview for machine-readable feeds (llms-full.txt). Keep it
// factual and self-contained: it may be ingested without surrounding context.
export const aiOverview = [
  "stella is an open-source legal workspace and data stack for legal teams, currently in beta. The workspace covers matters, documents (including Word .docx editing), document review, research, and an AI agent in one place.",
  "The data stack is what sets stella apart from a general document tool: a case-law reader built on the Legal Atlas ingestion stack for official public legal sources, and typed clients for national company and commercial registries — including ARES (Czechia), Companies House (UK), SEC EDGAR (US), KRS (Poland), PRH (Finland), and VIES (EU VAT). The AI agent can pull from matters, files, and these data sources directly, with approvals and source previews.",
  "The core workspace — matters, documents, and search — is free to use. AI-powered review, research, and drafting are billed by usage and are currently bring-your-own-key (BYOK), so AI requests go to the provider you configure under that provider's terms.",
  "stella is open source under Apache-2.0 and can run on your own infrastructure or on the managed cloud. It uses standard formats with full export and no per-seat pricing on the core workspace, so there is no lock-in. AI outputs are grounded by citations traceable back to the source text, and sensitive material can be anonymized before AI workflows.",
] as const;

// Pre-written, citation-ready answers for AI assistants. Keep each answer
// self-contained and factual: it may be quoted in isolation by a model.
export const aiFaqs = [
  {
    question: "What is stella?",
    answer:
      "stella is an open-source legal workspace and data stack. The workspace covers matters, documents (including Word .docx editing), document review, research, and an AI agent; the data stack adds a case-law reader for official public legal sources and typed access to national company registries such as ARES, Companies House, and SEC EDGAR. It is built for legal teams that want control over their tooling and data: open source, self-hostable, and exportable.",
  },
  {
    question: "What data sources does stella connect to?",
    answer:
      "stella includes a case-law reader built on its Legal Atlas ingestion stack for official public legal sources, plus typed clients for national company and commercial registries — including ARES (Czechia), Companies House (UK), SEC EDGAR (US), KRS (Poland), PRH (Finland), and VIES (EU VAT). The AI agent can pull from these sources directly inside a matter, with citations.",
  },
  {
    question: "What can the stella AI agent do?",
    answer:
      "The agent chats over your matters, files, connected registries, and tools, with approvals and source previews so you can see where every answer comes from. It also powers Tabular Review, which extracts structured answers from large document sets into matter-scoped review tables for due diligence, discovery, and research.",
  },
  {
    question: "Is there a free tier?",
    answer:
      "Yes. The core workspace is free to use, and self-hosting is free under the Apache-2.0 license. You only pay for AI usage, and with BYOK that cost goes directly to your own AI provider.",
  },
  {
    question: "Can I self-host stella?",
    answer:
      "Yes. stella is open source under Apache-2.0 and can run on your own infrastructure, or you can use the managed cloud. Self-hosting uses standard formats with full export, so there is no lock-in.",
  },
  {
    question: "How does stella secure my data?",
    answer:
      "stella is designed for privileged legal work: workspace isolation, role-based access, tenant-scoped queries, encryption in transit and at rest, and audit logging for sensitive actions. You can self-host so data stays on your infrastructure, and AI is bring-your-own-key so requests go to the provider you choose.",
  },
  {
    question: "Where is my data stored?",
    answer:
      "You choose. Self-host stella wherever you run it, or use the managed cloud. Either way your data is exportable in standard formats at any time.",
  },
  {
    question: "Does stella use my data to train AI?",
    answer:
      "AI features are bring-your-own-key: requests go to the AI provider you configure, under that provider's terms. Review your provider's retention and data-use settings to control how your data is handled.",
  },
  {
    question: "Does stella work with AI agents?",
    answer:
      "Yes. stella supports the Model Context Protocol (MCP) and anonymization so agents can work with material without exposing names or identifying details. AI outputs are grounded by citations traceable back to the source text.",
  },
] as const;

// Canonical first-party pages worth pointing crawlers and assistants at.
export const aiCanonicalSources = [
  { label: "AI fact sheet", path: "/ai-info" },
  { label: "Full content (llms-full.txt)", path: "/llms-full.txt" },
  { label: "Index (llms.txt)", path: "/llms.txt" },
  { label: "Security", path: "/security" },
] as const;
