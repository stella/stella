import type { Product } from "./types";

// The review hero reuses the same deterministic scene as the opening story.
export const tabularReview: Product = {
  slug: "tabular-review",
  eyebrow: "Tabular Review",
  title: "Turn a pile of documents into a table you can review.",
  summary:
    "Ask questions across a whole document set and get structured answers back as a matter-scoped table — sortable, filterable, and traceable to the source text. Built for due diligence, discovery, and research.",
  metaTitle: "Tabular document review for due diligence | stella",
  metaDescription:
    "Ask questions across a whole document set and get structured answers as a sortable, source-traceable table. Built for due diligence, discovery, and research.",
  hero: {
    type: "story",
    sceneId: "review",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "How does Tabular Review work?",
    answer:
      "You point Tabular Review at a set of documents in a matter and define columns as questions — for example 'governing law', 'termination notice period', or 'change-of-control clause'. stella extracts an answer for each document into a table you can sort, filter, and export, with every cell linked back to the passage it came from.",
  },
  capabilities: [
    {
      title: "Columns are questions",
      body: "Define a column in plain language; stella answers it for every document in the set.",
    },
    {
      title: "Cited to the source",
      body: "Each cell links to the exact passage it was extracted from, so you can verify in one click.",
    },
    {
      title: "Matter-scoped",
      body: "Reviews live inside a matter alongside the documents, contacts, and chat they relate to.",
    },
    {
      title: "Sort and filter",
      body: "Treat answers like data: sort by any column, filter to the rows that need attention.",
    },
    {
      title: "Built for scale",
      body: "Run the same questions across large document sets instead of opening files one by one.",
    },
    {
      title: "Export anywhere",
      body: "Take the table with you in standard formats — no lock-in on your own work product.",
    },
  ],
  sections: [
    {
      heading: "Define the questions once, answer them everywhere",
      bullets: [
        "Add a column by writing the question you would ask a junior",
        "Reuse column sets across matters for repeatable review playbooks",
        "Mix extraction (dates, parties, amounts) with judgement questions",
      ],
      media: {
        type: "preview",
        key: "review-grid",
      },
    },
    {
      heading: "Every answer traces back to the text",
      bullets: [
        "Click a cell to open the source document at the cited passage",
        "Answers are grounded by citations, not free-floating summaries",
        "Spot disagreements across documents at a glance",
      ],
      media: {
        type: "story",
        sceneId: "review",
        aspect: "16 / 10",
      },
    },
    {
      heading: "It lives where the work lives",
      bullets: [
        "Reviews are scoped to a matter, next to its files and chat",
        "Hand a review to the AI agent for follow-up questions",
        "Export the table or keep refining it in place",
      ],
      media: {
        type: "story",
        sceneId: "workspace",
        aspect: "16 / 10",
      },
    },
  ],
  faqs: [
    {
      question: "What kinds of questions can a column ask?",
      answer:
        "Anything you would ask a person reviewing the document: factual extraction like dates, parties, and amounts, or judgement calls like whether a clause is present and how it is framed. Answers come back grounded by citations to the source text.",
    },
    {
      question: "Where do the answers come from?",
      answer:
        "From the documents in your matter. AI features are bring-your-own-key, so extraction runs through the AI provider you configure, and every answer links back to the passage it was drawn from.",
    },
    {
      question: "Can I export the review?",
      answer:
        "Yes. Tabular Review output is exportable in standard formats, so your work product stays portable with no lock-in.",
    },
  ],
  adjacent: [
    {
      title: "AI agent",
      href: "/product/agent",
      body: "Chat across matters, files, and connected sources with approvals and source previews.",
    },
    {
      title: "Public data",
      href: "/product/public-data",
      body: "Official case law and company registries, pulled into a matter.",
    },
    {
      title: "Anonymization",
      href: "/product/anonymization",
      body: "Prepare sensitive material for AI without exposing identifying details.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "views.read" },
    { type: "capability", id: "properties.read" },
    { type: "capability", id: "fields.upsert-by-id" },
    { type: "capability", id: "reports.export-view" },
  ],
  cta: {
    heading: "Review your next document set in stella.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
