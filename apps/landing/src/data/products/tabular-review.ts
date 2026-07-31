import { frameAccents, productCtaLabels, type Product } from "./types";

// The review hero reuses the same deterministic scene as the opening story.
export const tabularReview: Product = {
  slug: "tabular-review",
  eyebrow: "Tabular Review",
  title: "Turn a pile of documents into a table you can review.",
  summary:
    "Ask questions across a whole document set and get structured answers back as a table in the matter — sortable, filterable, and traceable to the source text. Built for due diligence, discovery, and research.",
  metaTitle: "Tabular document review for due diligence | stella",
  metaDescription:
    "Ask questions across a whole document set and get structured answers as a sortable, source-traceable table. Built for due diligence, discovery, and research.",
  hero: {
    type: "story",
    sceneId: "review",
    aspect: "16 / 10",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.ember,
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
      title: "Part of the matter",
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
    },
    {
      heading: "Every answer traces back to the text",
      bullets: [
        "Click a cell to open the source document at the cited passage",
        "Answers are grounded by citations, not free-floating summaries",
        "Spot disagreements across documents at a glance",
      ],
    },
    {
      heading: "It lives where the work lives",
      bullets: [
        "Reviews live in the matter, next to its files and chat",
        "Hand a review to the AI agent for follow-up questions",
        "Export the table or keep refining it in place",
      ],
    },
  ],
  faqs: [
    {
      question: "What kinds of questions can a column ask?",
      answer:
        "Factual extraction like dates, parties, and amounts, or judgement calls like whether a clause is present and how it is framed. Answers come back grounded by citations to the source text.",
    },
    {
      question: "Where do the answers come from?",
      answer:
        "From the documents in your matter. AI features use your own provider keys, so extraction runs through the AI provider you choose, and every answer links back to the passage it was drawn from.",
    },
    {
      question: "Can I export the review?",
      answer:
        "Yes. Tabular Review output is exportable in standard formats, so your work product stays portable with no lock-in.",
    },
  ],
  adjacent: [
    {
      to: "product",
      slug: "agent",
      body: "Chat across matters, files, and connected sources with approvals and source previews.",
    },
    {
      to: "product",
      slug: "public-data",
      body: "Official case law and company registries, pulled into a matter.",
    },
    {
      to: "product",
      slug: "anonymization",
      body: "Prepare sensitive material for AI without exposing identifying details.",
    },
    {
      to: "ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "views.list" },
    { type: "capability", id: "properties.list" },
    { type: "capability", id: "fields.upsert-by-id" },
    { type: "capability", id: "reports.export-view" },
  ],
  cta: {
    heading: "Review your next document set in stella.",
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
};
