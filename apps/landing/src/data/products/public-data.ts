import { frameAccents, productCtaLabels, type Product } from "./types";

// "Public data" merges the case-law reader and the company-registry clients
// into one data-infrastructure story, matching the README's "Data
// infrastructure" pillar.
export const publicData: Product = {
  slug: "public-data",
  eyebrow: "Public data",
  title: "Legal data, ready to pull into a matter.",
  summary:
    "Case law and company registries from official public sources, collected by stella's Legal Atlas with their structure preserved. Read a decision, look up a company, follow citations, and reference any of it from a matter or hand it to the AI agent.",
  metaTitle: "Case law and company registry data | stella",
  metaDescription:
    "Case law and company registries from official public sources. Read decisions, look up companies, follow citations, and pull it into a matter or the AI agent.",
  hero: {
    type: "image",
    src: "/media/products/public-data.png",
    darkSrc: "/media/products/public-data-dark.png",
    alt: "A court decision open in the stella case-law reader",
    aspect: "16 / 10",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.tide,
  quickAnswer: {
    question: "What public data does stella bring in?",
    answer:
      "Two kinds. Official public case law, collected with its structure preserved so you can read and search decisions and follow their citations. And direct access to national company and commercial registries, so you can pull official company data straight into a matter. Both are grounded sources the AI agent can cite.",
  },
  capabilities: [
    {
      title: "Official case law",
      body: "Decisions straight from the official sources, not second-hand summaries.",
    },
    {
      title: "Structure preserved",
      body: "Every decision keeps the headings, paragraphs, and references of the original.",
    },
    {
      title: "Company registries",
      body: "Look up national company and commercial registries without leaving the matter.",
    },
    {
      title: "Follow citations",
      body: "Move between a decision and the cases it cites without leaving the reader.",
    },
    {
      title: "By jurisdiction",
      body: "Browse and filter case law and registries by the jurisdiction you work in.",
    },
    {
      title: "Grounded for AI",
      body: "Reference any source from a matter so the AI agent's answers stay traceable to it.",
    },
  ],
  sections: [
    {
      heading: "Case law from official sources, with its structure preserved",
      bullets: [
        "Collected from official public legal sources",
        "Headings, paragraphs, and references stay as they are in the original",
        "Built on stella's open Legal Atlas",
      ],
    },
    {
      heading: "Company and commercial registries, searched from a matter",
      bullets: [
        "Connected national registries: ARES, Companies House, SEC EDGAR, KRS, PRH, VIES, and more",
        "Pull official company data into a matter instead of copying it by hand",
        "Coverage expands as more official sources are added",
      ],
    },
    {
      heading: "One grounded source for the AI agent",
      bullets: [
        "Reference a decision or company record from a matter",
        "The AI agent cites the underlying source, not a paraphrase",
        "Search across sources, not just within one",
      ],
    },
  ],
  faqs: [
    {
      question: "Where does the data come from?",
      answer:
        "Case law comes from official public legal sources, collected by stella's Legal Atlas with its structure preserved. Company data comes straight from the national company and commercial registries, not from third-party copies.",
    },
    {
      question: "Which jurisdictions and registries are covered?",
      answer:
        "Two lists, both expanding. Connected registries already include ARES (Czechia), Companies House (UK), SEC EDGAR (US), KRS (Poland), PRH (Finland), and VIES (EU VAT). Beyond registries, official sources are connected jurisdiction by jurisdiction; Czechia, Spain, and Taiwan already have them, and the case-law reader lets you browse and filter by jurisdiction as more official sources are added.",
    },
    {
      question: "Can the AI use this data?",
      answer:
        "Yes. Public data referenced from a matter becomes a grounded source: the AI agent cites the underlying decision or record so its answers stay traceable.",
    },
  ],
  adjacent: [
    {
      to: "product",
      slug: "anonymization",
      body: "Prepare sensitive material for AI without exposing identifying details.",
    },
    {
      to: "product",
      slug: "agent",
      body: "Chat across matters, files, and sources with approvals and citations.",
    },
    {
      to: "product",
      slug: "tabular-review",
      body: "Turn a document set into a review table in the matter.",
    },
    {
      to: "ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "case-law.analysis.generate" },
    { type: "capability", id: "legislation.search" },
    { type: "capability", id: "contacts.business-registries-lookup" },
    {
      type: "source",
      path: "packages/legal-atlas/src/runners/registry.ts",
      contains: [
        "export const RUNNER_NAMES",
        "export const getRunnerDefinitions",
      ],
    },
    {
      type: "source",
      path: "packages/business-registries/src/index.ts",
      contains: [
        "./ares/index.js",
        "./companies-house/index.js",
        "./edgar/index.js",
        "./krs/index.js",
        "./prh/index.js",
        "./vies/index.js",
      ],
    },
  ],
  cta: {
    heading: "Bring official legal data into your matters.",
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
};
