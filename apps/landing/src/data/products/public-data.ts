import type { Product } from "./types";

// "Public data" merges the case-law reader and the company-registry clients
// into one data-infrastructure story, matching the README's "Data
// infrastructure" pillar.
export const publicData: Product = {
  slug: "public-data",
  eyebrow: "Public data",
  title: "Official legal data, ready to pull into a matter.",
  summary:
    "Case law and company registries from official public sources, collected and structure-parsed by stella's Legal Atlas stack. Read a decision, look up a company, follow citations, and reference any of it from a matter or hand it to the AI agent.",
  hero: {
    type: "placeholder",
    note: "Public data: case-law reader and a company-registry lookup side by side",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "What public data does stella bring in?",
    answer:
      "Two kinds. Official public case law, ingested and structure-parsed so you can read and search decisions and follow their citations. And typed access to national company and commercial registries, so you can pull official company data straight into a matter. Both are grounded sources the AI agent can cite.",
  },
  capabilities: [
    {
      title: "Official case law",
      body: "Decisions from official public legal sources, not scraped third-party summaries.",
    },
    {
      title: "Structure preserved",
      body: "Legal Atlas parses each decision while keeping its original structure intact.",
    },
    {
      title: "Company registries",
      body: "Typed clients for national company and commercial registries, queried from a matter.",
    },
    {
      title: "Follow citations",
      body: "Move between a decision and the cases it cites without leaving the reader.",
    },
    {
      title: "By jurisdiction",
      body: "Browse and filter case law and registries scoped to the jurisdiction you work in.",
    },
    {
      title: "Grounded for AI",
      body: "Reference any source from a matter so the agent's answers stay traceable to it.",
    },
  ],
  sections: [
    {
      heading: "Case law from official sources, parsed with structure intact",
      bullets: [
        "Collected from official public legal sources",
        "Structure-preserving parsers keep headings, paragraphs, and references",
        "Built on the open Legal Atlas ingestion stack",
      ],
      media: {
        type: "placeholder",
        note: "Reader: a decision with preserved structure and a jurisdiction switcher",
      },
    },
    {
      heading: "Company and commercial registries, queried from a matter",
      bullets: [
        "Typed clients for national registries: ARES, Companies House, SEC EDGAR, KRS, PRH, VIES, and more",
        "Pull official company data into a matter instead of copying it by hand",
        "Coverage expands as more official sources are added",
      ],
      media: {
        type: "placeholder",
        note: "Registry lookup: a company record pulled into a matter",
      },
    },
    {
      heading: "One grounded source for the agent",
      bullets: [
        "Reference a decision or company record from a matter",
        "The agent cites the underlying source, not a paraphrase",
        "Search across sources, not just within one",
      ],
      media: {
        type: "placeholder",
        note: "Agent answer citing a case-law decision and a registry record",
      },
    },
  ],
  faqs: [
    {
      question: "Where does the data come from?",
      answer:
        "Case law comes from official public legal sources, ingested and parsed by stella's Legal Atlas stack. Company data comes from national company and commercial registries through typed clients, not third-party copies.",
    },
    {
      question: "Which jurisdictions and registries are covered?",
      answer:
        "Coverage is expanding. Registry clients already include ARES, Companies House, SEC EDGAR, KRS, PRH, and VIES, and the case-law reader is built to browse and filter by jurisdiction as more official sources are added.",
    },
    {
      question: "Can the AI use this data?",
      answer:
        "Yes. Public data referenced from a matter becomes a grounded source: the AI agent cites the underlying decision or record so its answers stay traceable.",
    },
  ],
  adjacent: [
    {
      title: "Anonymization",
      href: "/product/anonymization",
      body: "Prepare sensitive material for AI without exposing identifying details.",
    },
    {
      title: "AI agent",
      href: "/product/agent",
      body: "Chat across matters, files, and sources with approvals and citations.",
    },
    {
      title: "Tabular Review",
      href: "/product/tabular-review",
      body: "Turn a document set into a matter-scoped review table.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  cta: {
    heading: "Bring official legal data into your matters.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
