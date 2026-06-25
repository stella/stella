import type { Product } from "./types";

export const caseLaw: Product = {
  slug: "case-law",
  eyebrow: "Case law",
  title: "Read and search official case law, in one place.",
  summary:
    "A case-law reader for official public legal sources, collected and structure-parsed by stella's Legal Atlas stack. Browse by jurisdiction, follow citations, and pull decisions straight into a matter.",
  hero: {
    type: "placeholder",
    note: "Case-law reader: decision with citations panel and jurisdiction switcher",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "How does case law work in stella?",
    answer:
      "stella ingests official public case law and parses it while preserving structure, so you can read a decision, jump between its citations, and search across jurisdictions. Decisions can be referenced from a matter and handed to the AI agent with their source intact.",
  },
  capabilities: [
    {
      title: "Official sources",
      body: "Decisions are collected from official public legal sources, not scraped summaries.",
    },
    {
      title: "Structure preserved",
      body: "Legal Atlas parses each decision while keeping its original structure intact.",
    },
    {
      title: "Follow citations",
      body: "Move between a decision and the cases it cites without leaving the reader.",
    },
    {
      title: "By jurisdiction",
      body: "Browse and filter case law scoped to the jurisdiction you are working in.",
    },
    {
      title: "Into the matter",
      body: "Reference a decision from a matter so research stays next to the work.",
    },
    {
      title: "Grounded for AI",
      body: "Hand a decision to the agent with its source text intact for grounded answers.",
    },
  ],
  sections: [
    {
      heading: "Official sources, parsed with structure intact",
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
      heading: "Follow the citation graph",
      bullets: [
        "Jump from a decision to the cases it cites",
        "See how a decision is positioned against the ones it references",
        "Search across decisions, not just within one",
      ],
      media: {
        type: "placeholder",
        note: "Citations panel open, navigating between related decisions",
      },
    },
  ],
  faqs: [
    {
      question: "Where does the case law come from?",
      answer:
        "From official public legal sources, ingested and parsed by stella's Legal Atlas stack rather than copied from third-party summaries.",
    },
    {
      question: "Which jurisdictions are covered?",
      answer:
        "Coverage is expanding; the reader is built to browse and filter by jurisdiction so it scales as more official sources are added.",
    },
  ],
  adjacent: [
    {
      title: "Tabular Review",
      href: "/product/tabular-review",
      body: "Turn a document set into a matter-scoped review table.",
    },
    {
      title: "AI agent",
      href: "/product/agent",
      body: "Chat across matters, files, and sources with citations.",
    },
    {
      title: "Company registries",
      href: "/product/registries",
      body: "Pull company and commercial-registry data into a matter.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  cta: {
    heading: "Research case law in stella.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
