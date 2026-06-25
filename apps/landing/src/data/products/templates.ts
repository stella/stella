import type { Product } from "./types";

// Templates shipped in 0.5.0. Part of the Legal-intelligence pillar: build
// reusable templates with fields and conditional clauses, and let AI fill them
// from a matter's data. Keep claims modest and factual; adjust copy to match
// the public 0.5.0 framing.
export const templates: Product = {
  slug: "templates",
  eyebrow: "Templates",
  title: "Build reusable templates, and let AI fill them in.",
  summary:
    "Define a template once with fields and conditional clauses, then fill it in by hand or let stella draft it from a matter's data. Produce a document into the matter and keep editing it. Repeat work starts from a known-good base instead of a blank page.",
  hero: {
    type: "placeholder",
    note: "Template editor: a template with fields and conditional clauses assembling a draft",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "How do templates work in stella?",
    answer:
      "A template is a document with fields and clauses you can include conditionally. You fill the fields in by hand or let stella draft them from a matter's data; the conditional clauses resolve, and you get a document to keep working on in the matter. Templates and clauses are reusable, so repeat documents start from a known-good base.",
  },
  capabilities: [
    {
      title: "Reusable templates",
      body: "Start repeat documents from a template instead of a blank page or a copied file.",
    },
    {
      title: "Fields and placeholders",
      body: "Define the values a document needs and fill them in when you assemble it.",
    },
    {
      title: "Conditional clauses",
      body: "Include or omit clauses based on the values you provide, so a template covers variants.",
    },
    {
      title: "Fill with AI",
      body: "Let stella draft a filled document from a matter's data, then refine it.",
    },
    {
      title: "Edit in place",
      body: "Author and adjust templates in the editor, then assemble from them.",
    },
    {
      title: "Into a matter",
      body: "Produce a draft into a matter and keep editing it alongside the rest of the work.",
    },
  ],
  sections: [
    {
      heading: "Build from templates and clauses",
      bullets: [
        "Assemble a document from a template instead of starting blank",
        "Reuse clauses across templates",
        "Keep repeat documents consistent",
      ],
      media: {
        type: "placeholder",
        note: "Picking a template and filling its fields to assemble a draft",
      },
    },
    {
      heading: "Fields and conditional logic",
      bullets: [
        "Define the fields a document needs",
        "Include or omit clauses based on the values provided",
        "One template covers several variants",
      ],
      media: {
        type: "placeholder",
        note: "A template with fields and a conditional clause resolving as values change",
      },
    },
    {
      heading: "Edit and produce in place",
      bullets: [
        "Author and adjust templates in the editor",
        "Produce the draft into a matter",
        "Keep editing the result alongside the matter's files",
      ],
      media: {
        type: "placeholder",
        note: "Template editor open next to the assembled draft in a matter",
      },
    },
  ],
  faqs: [
    {
      question: "Can I edit a template?",
      answer:
        "Yes. Templates are authored and adjusted in the editor, then you assemble documents from them.",
    },
    {
      question: "What is a clause?",
      answer:
        "A reusable piece of a document. Clauses can be included across templates and added conditionally based on the values you provide when assembling.",
    },
    {
      question: "Where does the assembled document go?",
      answer:
        "Into a matter, as a draft you can keep editing alongside the rest of the matter's documents.",
    },
  ],
  adjacent: [
    {
      title: "Workspace",
      href: "/product/workspace",
      body: "Matters, documents, and Word editing in one place.",
    },
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
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  cta: {
    heading: "Assemble your next document in stella.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
